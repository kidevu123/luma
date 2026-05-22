"use server";

// START-3 — Start Production server action.
//
// Wraps the same projectEvent CARD_ASSIGNED flow the floor PWA uses,
// but driven from the admin desk: operator scans a raw bag, picks a
// station, confirms the product (auto-resolved by station type), and
// clicks Start. The action:
//   - validates the bag is AVAILABLE
//   - looks up the QR card from bag.bagQrCode (reserved at receiving)
//   - validates the QR card via validateRawBagQrForStart
//   - validates the station is active
//   - inserts a workflow_bag (productId + inventoryBagId)
//   - flips the qr_card to ASSIGNED
//   - fires CARD_ASSIGNED via projectEvent with accountabilitySource
//     'MANUAL_TEXT' (admin-driven, no station scan token)
//   - writes one audit_log row
//
// Does NOT fire downstream stage events (BLISTER_COMPLETE etc) — those
// still come from the floor PWA. This action is the on-ramp only.

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  products,
  qrCards,
  stations,
  workflowBags,
} from "@/lib/db/schema";
import { requireLead } from "@/lib/auth-guards";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import {
  findRawBagByReceiptOrQr,
  type RawBagLookupResult,
} from "@/lib/db/queries/raw-bag-intake";
import { validateRawBagQrForStart } from "@/lib/production/start-production";

export type StartProductionResult =
  | {
      ok: true;
      workflowBagId: string;
      qrCardId: string;
      stationId: string;
      stationLabel: string;
      productId: string;
      productName: string;
      inventoryBagId: string;
      receiptNumber: string | null;
      bagQrCode: string | null;
    }
  | { ok: false; error: string; reason?: string };

export type StartProductionInput = {
  inventoryBagId: string;
  productId: string;
  stationId: string;
};

export async function lookupRawBagForStartAction(value: string): Promise<RawBagLookupResult> {
  await requireLead();
  return findRawBagByReceiptOrQr(value);
}

export async function startProductionForRawBagAction(
  input: StartProductionInput,
): Promise<StartProductionResult> {
  const actor = await requireLead();

  // Pre-flight validation — all four ids must point to live rows.
  const [bag] = await db
    .select({
      id: inventoryBags.id,
      status: inventoryBags.status,
      tabletTypeId: inventoryBags.tabletTypeId,
      bagQrCode: inventoryBags.bagQrCode,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, input.inventoryBagId))
    .limit(1);
  if (!bag) return { ok: false, error: "Raw bag not found." };
  if (bag.status !== "AVAILABLE") {
    return {
      ok: false,
      error: `Raw bag status is ${bag.status}; only AVAILABLE bags can start production.`,
    };
  }

  if (!bag.bagQrCode) {
    return { ok: false, error: "This raw bag has no QR card assigned. Assign a QR card at receiving before starting production." };
  }
  const [cardRow] = await db
    .select({ id: qrCards.id, status: qrCards.status, assignedWorkflowBagId: qrCards.assignedWorkflowBagId, cardType: qrCards.cardType })
    .from(qrCards)
    .where(eq(qrCards.scanToken, bag.bagQrCode))
    .limit(1);
  const qrValidation = validateRawBagQrForStart(cardRow ?? null, bag.bagQrCode);
  if (!qrValidation.ok) {
    return { ok: false, error: qrValidation.error };
  }
  // cardRow is guaranteed non-null here: validateRawBagQrForStart returned ok only if card exists.
  const card = cardRow!;

  const [station] = await db
    .select({
      id: stations.id,
      label: stations.label,
      kind: stations.kind,
      isActive: stations.isActive,
    })
    .from(stations)
    .where(eq(stations.id, input.stationId))
    .limit(1);
  if (!station) return { ok: false, error: "Station not found." };
  if (!station.isActive) {
    return { ok: false, error: `Station ${station.label} is inactive.` };
  }

  const [product] = await db
    .select({ id: products.id, name: products.name, sku: products.sku, kind: products.kind })
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1);
  if (!product) return { ok: false, error: "Product not found." };

  // ── Atomic: insert workflow_bag, flip qr_card, fire CARD_ASSIGNED.
  return db.transaction(async (tx) => {
    const [wfBag] = await tx
      .insert(workflowBags)
      .values({
        productId: product.id,
        inventoryBagId: bag.id,
      })
      .returning();
    if (!wfBag) throw new Error("startProduction: workflow_bag insert empty");

    await tx
      .update(qrCards)
      .set({ status: "ASSIGNED", assignedWorkflowBagId: wfBag.id })
      .where(eq(qrCards.id, card.id));

    await projectEvent(tx, {
      workflowBagId: wfBag.id,
      stationId: station.id,
      eventType: "CARD_ASSIGNED",
      payload: {
        qr_card_id: card.id,
        station_kind: station.kind,
        inventory_bag_id: bag.id,
        started_from_admin: true,
        bag_qr_code: bag.bagQrCode,
        internal_receipt_number: bag.internalReceiptNumber,
      },
      enteredByUserId: actor.id,
      accountabilitySource: "MANUAL_TEXT",
      accountableEmployeeNameSnapshot: actor.email ?? actor.id,
    });

    // Also fire PRODUCT_MAPPED so the projector + read models register
    // the product on the first event (same pattern the floor uses for
    // first-op product selection).
    await projectEvent(tx, {
      workflowBagId: wfBag.id,
      stationId: station.id,
      eventType: "PRODUCT_MAPPED",
      payload: {
        product_id: product.id,
        product_sku: product.sku,
        product_name: product.name,
        product_kind: product.kind,
        station_kind: station.kind,
        source: "ADMIN_START_PRODUCTION",
      },
      enteredByUserId: actor.id,
      accountabilitySource: "MANUAL_TEXT",
      accountableEmployeeNameSnapshot: actor.email ?? actor.id,
    });

    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "production.start_from_admin",
        targetType: "WorkflowBag",
        targetId: wfBag.id,
        after: {
          workflowBagId: wfBag.id,
          inventoryBagId: bag.id,
          qrCardId: card.id,
          stationId: station.id,
          productId: product.id,
        },
      },
      tx,
    );

    revalidatePath("/production/start");
    revalidatePath("/floor-board");

    return {
      ok: true,
      workflowBagId: wfBag.id,
      qrCardId: card.id,
      stationId: station.id,
      stationLabel: station.label,
      productId: product.id,
      productName: product.name,
      inventoryBagId: bag.id,
      receiptNumber: bag.internalReceiptNumber,
      bagQrCode: bag.bagQrCode,
    };
  });
}
