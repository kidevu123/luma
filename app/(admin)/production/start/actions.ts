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
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  productAllowedTablets,
  products,
  qrCards,
  rawBagAllocationSessions,
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
import { FIRST_OP_STATION_KINDS } from "@/lib/production/first-op-product";
import { evaluateInventoryBagReadinessById } from "@/lib/production/floor-readiness-loaders";
import {
  canRestartAvailablePartialRawBag,
  type PartialBagSession,
} from "@/lib/production/partial-bag-restart";
import { loadRawBagStartClassificationForScan } from "@/lib/production/floor-partial-bag-start-resolution";
import { ensureOpenRawBagAllocationSessionForWorkflowBag } from "@/lib/production/raw-bag-allocation-lifecycle";

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

export async function lookupRawBagByIdForStartAction(
  inventoryBagId: string,
): Promise<RawBagLookupResult> {
  await requireLead();
  const [bag] = await db
    .select({
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      bagQrCode: inventoryBags.bagQrCode,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);
  if (!bag) return { found: false, warnings: ["Raw bag not found."] };
  const token = bag.internalReceiptNumber ?? bag.bagQrCode;
  if (!token) {
    return {
      found: false,
      warnings: ["Bag has no receipt number or QR token to look up."],
    };
  }
  return findRawBagByReceiptOrQr(token);
}

async function loadPartialBagSessionsForInventory(
  inventoryBagId: string,
): Promise<PartialBagSession[]> {
  const rows = await db
    .select({
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      closedAt: rawBagAllocationSessions.closedAt,
    })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId))
    .orderBy(asc(rawBagAllocationSessions.openedAt));
  return rows as PartialBagSession[];
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

  const readiness = await evaluateInventoryBagReadinessById(db, bag.id);
  if (readiness?.level === "BLOCKED") {
    return {
      ok: false,
      error:
        readiness.adminAction ??
        "This bag is not ready for the floor. Complete receiving before starting production.",
    };
  }

  if (bag.status !== "AVAILABLE") {
    return {
      ok: false,
      error: `Raw bag status is ${bag.status}; only AVAILABLE bags can start production.`,
    };
  }

  // Belt-and-suspenders: AVAILABLE bags should never have OPEN sessions, but guard explicitly
  // so the error message is clear if this edge case occurs.
  const [openSession] = await db
    .select({ id: rawBagAllocationSessions.id })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, bag.id),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);
  if (openSession) {
    return {
      ok: false,
      error:
        "This bag has an open allocation session in progress. Close the floor session before starting a new production run.",
    };
  }

  if (!bag.bagQrCode) {
    return { ok: false, error: "This raw bag has no QR card assigned. Assign a QR card at receiving before starting production." };
  }
  const partialSessions = await loadPartialBagSessionsForInventory(bag.id);
  // P1-PARTIAL — admin starts are lead-gated (requireLead above), so a
  // lead clicking Start IS the supervisor confirmation the confidence
  // model requires for LOW partials. The Partial Bag Workbench shows
  // the full reuse context (remaining, confidence, source, history)
  // before this action is reachable. MISSING remaining never gets here:
  // canRestartAvailablePartialRawBag refuses unknown ending balances.
  const partialBagRestart = canRestartAvailablePartialRawBag({
    inventoryStatus: bag.status,
    sessions: partialSessions,
  });

  const startClassification = await loadRawBagStartClassificationForScan(db, {
    scannedToken: bag.bagQrCode,
    cardScanToken: bag.bagQrCode,
  });
  if (!startClassification.canStart) {
    return { ok: false, error: startClassification.operatorMessage };
  }

  const [cardRow] = await db
    .select({ id: qrCards.id, status: qrCards.status, assignedWorkflowBagId: qrCards.assignedWorkflowBagId, cardType: qrCards.cardType })
    .from(qrCards)
    .where(eq(qrCards.scanToken, bag.bagQrCode))
    .limit(1);
  const qrValidation = validateRawBagQrForStart(cardRow ?? null, bag.bagQrCode, {
    allowPartialBagRestart: partialBagRestart,
  });
  if (!qrValidation.ok) {
    return { ok: false, error: qrValidation.error };
  }
  // cardRow is guaranteed non-null here: validateRawBagQrForStart returned ok only if card exists.
  const card = cardRow!;

  if (
    card.status === "ASSIGNED" &&
    card.assignedWorkflowBagId !== null &&
    !partialBagRestart
  ) {
    return {
      ok: false,
      error:
        "The QR card for this bag is already assigned to a production workflow. Close the prior run before starting again.",
    };
  }

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
  if (!FIRST_OP_STATION_KINDS.has(station.kind)) {
    return {
      ok: false,
      error: `Station "${station.label}" (${station.kind}) cannot start fresh bags. Select a first-operation station (blister, bottle handpack, or combined).`,
    };
  }

  const [product] = await db
    .select({ id: products.id, name: products.name, sku: products.sku, kind: products.kind })
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1);
  if (!product) return { ok: false, error: "Product not found." };

  const [productAllowed] = await db
    .select({ productId: productAllowedTablets.productId })
    .from(productAllowedTablets)
    .where(
      and(
        eq(productAllowedTablets.productId, product.id),
        eq(productAllowedTablets.tabletTypeId, bag.tabletTypeId),
      ),
    )
    .limit(1);
  if (!productAllowed) {
    return {
      ok: false,
      error:
        "Selected product is not allowed for this bag's tablet type. Pick a product mapped in Settings.",
    };
  }

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
        partial_bag_restart: partialBagRestart,
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
          partialBagRestart,
        },
      },
      tx,
    );

    const alloc = await ensureOpenRawBagAllocationSessionForWorkflowBag(tx, {
      inventoryBagId: bag.id,
      workflowBagId: wfBag.id,
      productId: product.id,
      actor,
    });
    if (!alloc.ok) throw new Error(alloc.error);

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
