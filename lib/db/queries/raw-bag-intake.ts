// INTAKE-WORKFLOW-1 — DB layer for the PO-driven raw-bag intake.
//
// Two entry points:
//   - createRawBagIntakeAtomic(input, actor) — atomic save: one
//     transaction creates (or upserts) the PO/PO-line, batch, receive,
//     small_box, and N inventory_bags rows. Stores operator-typed
//     receipt numbers and QR codes. Audit-logged. If ANY row hits a
//     conflict (duplicate QR / duplicate receipt against the DB), the
//     transaction rolls back and ZERO bags land.
//   - findRawBagByReceiptOrQr(value) — read-only lookup by receipt
//     number or bag QR code; returns the full resolved context (PO,
//     vendor, product, supplier lot, bag sequence, workflow_bag if
//     production started, finished_lots if packed). Used by both the
//     intake "result" panel and the standalone Lookup receipt / batch
//     surface.

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { DEFAULT_INTAKE_BATCH_STATUS } from "@/lib/production/batch-production-guard";
import { db } from "@/lib/db";
import {
  batches,
  finishedLotInputs,
  finishedLots,
  inventoryBags,
  poLines,
  products,
  purchaseOrders,
  qrCards,
  receives,
  smallBoxes,
  tabletTypes,
  workflowBags,
} from "@/lib/db/schema";
import { compact } from "@/lib/db/compact";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import {
  preflightRawBagIntake,
  type RawBagIntakeInput,
} from "@/lib/production/raw-bag-intake";
import {
  seedPendingRawBagReceiveRows,
  type PendingRawBagReceiveSeed,
} from "@/lib/zoho/raw-bag-intake-receive";

// ─── createRawBagIntakeAtomic ─────────────────────────────────────────

export type CreateRawBagIntakeResult =
  | {
      ok: true;
      receiveId: string;
      receiveName: string;
      poId: string | null;
      poNumber: string;
      poLineId: string | null;
      vendorName: string | null;
      tabletTypeId: string;
      tabletTypeName: string;
      supplierLotNumber: string;
      bagCount: number;
      receiptRange: { first: string; last: string } | null;
      qrCount: number;
      qrAssigned: number; // count of QR cards marked ASSIGNED
      orderedQuantity: number | null;
      receivedQuantity: number;
      variance: number | null;
      bagIds: readonly string[];
    }
  | { ok: false; error: string; reason?: string };

export async function createRawBagIntakeAtomic(
  raw: unknown,
  actor: CurrentUser,
): Promise<CreateRawBagIntakeResult> {
  const pre = preflightRawBagIntake(raw);
  if (!pre.ok) {
    return {
      ok: false,
      error: pre.error,
      reason: pre.issues[0]
        ? `${pre.issues[0].field}:${pre.issues[0].reason}@bag${pre.issues[0].bagSequence}`
        : "validation_failed",
    };
  }
  const input = pre.input;

  type IntakeTxSuccess = Extract<CreateRawBagIntakeResult, { ok: true }> & {
    pendingReceiveSeeds: readonly PendingRawBagReceiveSeed[];
  };

  let txResult: CreateRawBagIntakeResult | IntakeTxSuccess;
  try {
    txResult = await db.transaction(async (tx): Promise<
      CreateRawBagIntakeResult | IntakeTxSuccess
    > => {
    // ── Resolve PO + vendor + ordered qty ────────────────────────
    let resolvedPoId: string | null = null;
    let resolvedPoLineId: string | null = null;
    let resolvedZohoPoId: string | null = null;
    let resolvedZohoLineItemId: string | null = null;
    let resolvedPoNumber = "";
    let resolvedVendor: string | null = null;
    let orderedQuantity: number | null = input.orderedQuantity ?? null;

    if (input.poMode === "MANUAL_REFERENCE") {
      // Upsert a minimal PO row so the receive_idx still joins for
      // future variance / reporting. status=OPEN, vendor from manual
      // input. We never overwrite an existing PO with manual data; if
      // poNumberManual already exists in purchase_orders, we just link
      // to it.
      resolvedPoNumber = input.poNumberManual!.trim();
      resolvedVendor = input.vendorNameManual!.trim();
      const [existingPo] = await tx
        .select({ id: purchaseOrders.id, vendorName: purchaseOrders.vendorName })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.poNumber, resolvedPoNumber))
        .limit(1);
      if (existingPo) {
        resolvedPoId = existingPo.id;
        // Don't overwrite an existing vendor name with manual input.
        if (!existingPo.vendorName && resolvedVendor) {
          await tx
            .update(purchaseOrders)
            .set({ vendorName: resolvedVendor })
            .where(eq(purchaseOrders.id, existingPo.id));
        }
      } else {
        const [inserted] = await tx
          .insert(purchaseOrders)
          .values(
            compact({
              poNumber: resolvedPoNumber,
              vendorName: resolvedVendor,
              status: "OPEN" as const,
              notes: "manual reference (INTAKE-WORKFLOW-1)",
            }),
          )
          .returning({ id: purchaseOrders.id });
        if (!inserted) {
          throw new Error("intake: failed to insert manual-reference PO");
        }
        resolvedPoId = inserted.id;
      }
      // Manual mode does not require a po_line row. If operator
      // supplied orderedQuantity, we keep it for variance display but
      // don't synthesize a po_line.
    } else {
      // LOCAL_PO or ZOHO_CACHED_PO — poId is required at preflight.
      resolvedPoId = input.poId!;
      const [poRow] = await tx
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          vendorName: purchaseOrders.vendorName,
          zohoPoId: purchaseOrders.zohoPoId,
        })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, resolvedPoId))
        .limit(1);
      if (!poRow) {
        return { ok: false, error: "Selected PO not found." };
      }
      resolvedPoNumber = poRow.poNumber;
      resolvedVendor = poRow.vendorName;
      resolvedZohoPoId = poRow.zohoPoId ?? null;
      if (input.poLineId) {
        const [lineRow] = await tx
          .select({
            id: poLines.id,
            qtyOrdered: poLines.qtyOrdered,
            tabletTypeId: poLines.tabletTypeId,
            zohoLineItemId: poLines.zohoLineItemId,
          })
          .from(poLines)
          .where(eq(poLines.id, input.poLineId))
          .limit(1);
        if (!lineRow) {
          return { ok: false, error: "Selected PO line not found." };
        }
        if (lineRow.tabletTypeId && lineRow.tabletTypeId !== input.tabletTypeId) {
          return {
            ok: false,
            error: "Selected PO line is for a different tablet type than the bag tablet type.",
          };
        }
        resolvedPoLineId = lineRow.id;
        resolvedZohoLineItemId = lineRow.zohoLineItemId ?? null;
        if (orderedQuantity == null) orderedQuantity = lineRow.qtyOrdered;
      }
    }

    // ── Conflict pre-check: surface duplicate QR / receipt against
    // the DB before inserting anything. Cheaper than relying on the
    // unique-index failure (which would happen mid-INSERT).
    const operatorReceiptNumbers = input.rows
      .map((r) => r.receiptNumber.trim())
      .filter((s) => s.length > 0);
    const operatorQrCodes = input.rows
      .map((r) => (r.bagQrCode ?? "").trim())
      .filter((s) => s.length > 0);
    if (operatorReceiptNumbers.length > 0) {
      const dupReceipts = await tx
        .select({
          id: inventoryBags.id,
          internalReceiptNumber: inventoryBags.internalReceiptNumber,
        })
        .from(inventoryBags)
        .where(orInArray(operatorReceiptNumbers, "internalReceiptNumber"));
      if (dupReceipts.length > 0 && dupReceipts[0]?.internalReceiptNumber) {
        return {
          ok: false,
          error: `Receipt ${dupReceipts[0].internalReceiptNumber} already exists for an earlier intake.`,
        };
      }
    }
    if (operatorQrCodes.length > 0) {
      const dupQrs = await tx
        .select({
          id: inventoryBags.id,
          bagQrCode: inventoryBags.bagQrCode,
        })
        .from(inventoryBags)
        .where(orInArray(operatorQrCodes, "bagQrCode"));
      if (dupQrs.length > 0 && dupQrs[0]?.bagQrCode) {
        return {
          ok: false,
          error: `Bag QR ${dupQrs[0].bagQrCode} already exists for an earlier intake.`,
        };
      }
    }

    // ── QR card pre-validation: verify cards exist, are RAW_BAG type,
    // and are IDLE — before inserting anything. Returns { ok: false }
    // on any failure so the caller gets a user-visible error, not a 500.
    const qrCodesToReserve = input.rows
      .map((r) => r.bagQrCode?.trim())
      .filter((q): q is string => Boolean(q));

    if (qrCodesToReserve.length > 0) {
      const cards = await tx
        .select()
        .from(qrCards)
        .where(inArray(qrCards.scanToken, qrCodesToReserve));

      const cardByToken = new Map(cards.map((c) => [c.scanToken, c]));

      for (const token of qrCodesToReserve) {
        const card = cardByToken.get(token);
        if (!card) {
          return {
            ok: false,
            error: `QR code "${token}" is not in the QR card inventory. Use a RAW_BAG QR card.`,
          };
        }
        if (card.cardType !== "RAW_BAG") {
          return {
            ok: false,
            error:
              card.cardType === "VARIETY_PACK"
                ? `QR card "${token}" is a variety pack card and cannot be used for a raw bag.`
                : `QR card "${token}" is not a raw bag card (type: ${card.cardType}).`,
          };
        }
        if (card.status !== "IDLE") {
          return {
            ok: false,
            error:
              card.status === "ASSIGNED"
                ? `QR card "${token}" is already assigned to another bag.`
                : `QR card "${token}" is not available (status: ${card.status}).`,
          };
        }
      }
    }

    // ── Resolve tablet type for receive_name auto-naming + return ──
    const [tabletTypeRow] = await tx
      .select({ id: tabletTypes.id, name: tabletTypes.name })
      .from(tabletTypes)
      .where(eq(tabletTypes.id, input.tabletTypeId))
      .limit(1);
    if (!tabletTypeRow) {
      return { ok: false, error: "Selected tablet type not found." };
    }

    // ── One batch per unique supplier lot.  Rows within the same lot
    // share a batch; rows with different lots get separate batches.
    const uniqueLots = [...new Set(input.rows.map((r) => r.supplierLotNumber))];
    const batchIdByLot = new Map<string, string>();
    const totalDeclared = input.rows.reduce((sum, r) => sum + (r.declaredCount ?? 0), 0);

    for (const lot of uniqueLots) {
      const lotRows = input.rows.filter((r) => r.supplierLotNumber === lot);
      const lotDeclared = lotRows.reduce(
        (sum, r) => sum + (r.declaredCount ?? 0),
        0,
      );

      // Unique index is (kind, batch_number) — not tablet_type_id. Look
      // up by lot number alone, then guard against cross-product reuse.
      const [existingBatch] = await tx
        .select()
        .from(batches)
        .where(
          and(eq(batches.kind, "TABLET"), eq(batches.batchNumber, lot)),
        )
        .limit(1);

      if (existingBatch) {
        if (
          existingBatch.tabletTypeId != null &&
          existingBatch.tabletTypeId !== input.tabletTypeId
        ) {
          return {
            ok: false,
            error: `Supplier lot ${lot} is already registered to a different tablet type. Select the matching product or ask an admin to review batch ${lot}.`,
          };
        }
        // RECEIVING-HARDENING-v1.5.11 — atomic SQL-level increment.
        // Two concurrent intakes against the same supplier lot must
        // BOTH have their qty applied; the previous JS read-modify-write
        // form (existingBatch.qtyReceived + lotDeclared) could lose a
        // delta under READ COMMITTED. RETURNING gives us the post-update
        // totals for the audit row below.
        const [updatedBatch] = await tx
          .update(batches)
          .set({
            qtyReceived: sql`${batches.qtyReceived} + ${lotDeclared}`,
            qtyOnHand: sql`${batches.qtyOnHand} + ${lotDeclared}`,
            ...(existingBatch.tabletTypeId == null
              ? { tabletTypeId: input.tabletTypeId }
              : {}),
          })
          .where(eq(batches.id, existingBatch.id))
          .returning();
        if (!updatedBatch) {
          throw new Error(`intake: batch update empty for lot ${lot}`);
        }
        batchIdByLot.set(lot, existingBatch.id);
        await writeAudit(
          {
            actorId: actor.id,
            actorRole: actor.role,
            action: "batch.qty_increment",
            targetType: "Batch",
            targetId: existingBatch.id,
            before: {
              qtyReceived: existingBatch.qtyReceived,
              qtyOnHand: existingBatch.qtyOnHand,
              tabletTypeId: existingBatch.tabletTypeId,
            },
            after: {
              batchNumber: lot,
              tabletTypeId: updatedBatch.tabletTypeId,
              deltaQuantity: lotDeclared,
              qtyReceived: updatedBatch.qtyReceived,
              qtyOnHand: updatedBatch.qtyOnHand,
            },
          },
          tx,
        );
      } else {
        const [newBatch] = await tx
          .insert(batches)
          .values(
            compact({
              kind: "TABLET" as const,
              batchNumber: lot,
              tabletTypeId: input.tabletTypeId,
              vendorName: resolvedVendor ?? null,
              vendorLotNumber: lot,
              qtyReceived: lotDeclared,
              qtyOnHand: lotDeclared,
              status: DEFAULT_INTAKE_BATCH_STATUS,
              statusChangedById: actor.id,
            }),
          )
          .returning();
        if (!newBatch) throw new Error(`intake: batch insert empty for lot ${lot}`);
        batchIdByLot.set(lot, newBatch.id);
        await writeAudit(
          {
            actorId: actor.id,
            actorRole: actor.role,
            action: "batch.create",
            targetType: "Batch",
            targetId: newBatch.id,
            after: newBatch,
          },
          tx,
        );
      }
    }

    // defaultBatchId for the box = batch for the setup-level lot.
    // Falls back to first unique lot if no row uses the setup lot exactly.
    const firstBatchId = batchIdByLot.values().next().value as string | undefined;
    const defaultBatchId =
      batchIdByLot.get(input.supplierLotNumber) ?? firstBatchId;
    if (!defaultBatchId) throw new Error("intake: no batch resolved");

    // ── Insert receive with a deterministic name. {PO}-R{seq}; seq
    // computed from existing receives for this PO.
    let receiveSeq = 1;
    if (resolvedPoId) {
      const existingForPo = await tx
        .select({ id: receives.id })
        .from(receives)
        .where(eq(receives.poId, resolvedPoId));
      receiveSeq = existingForPo.length + 1;
    }
    const receiveName = `${resolvedPoNumber}-R${receiveSeq}`;
    const [receiveRow] = await tx
      .insert(receives)
      .values(
        compact({
          poId: resolvedPoId,
          poLineId: resolvedPoLineId,
          receiveName,
          receivedById: actor.id,
          notes: input.notes ?? null,
          ...(input.receivedAt ? { receivedAt: new Date(input.receivedAt) } : {}),
        }),
      )
      .returning();
    if (!receiveRow) throw new Error("intake: receive insert empty");

    // ── Insert a single small_box for this intake (one bag per line
    // in the operator's view — we collapse into one box for simpler
    // joins). bag_count = N, default_tablet_type_id set, default_batch
    // _id linked.
    const [box] = await tx
      .insert(smallBoxes)
      .values({
        receiveId: receiveRow.id,
        boxNumber: 1,
        defaultBatchId: defaultBatchId,
        defaultTabletTypeId: input.tabletTypeId,
        totalBags: input.rows.length,
      })
      .returning();
    if (!box) throw new Error("intake: small_box insert empty");

    // ── Insert N inventory_bags in a single batched INSERT with
    // operator-typed receipt + QR + declared count.
    const bagRows = input.rows.map((r) => ({
      smallBoxId: box.id,
      bagNumber: r.bagSequence,
      tabletTypeId: input.tabletTypeId,
      batchId: batchIdByLot.get(r.supplierLotNumber) ?? defaultBatchId,
      pillCount: r.declaredCount ?? null,
      declaredPillCount: r.declaredCount ?? null,
      weightGrams: r.weightGrams ?? null,
      bagQrCode: r.bagQrCode?.trim() && r.bagQrCode.trim().length > 0
        ? r.bagQrCode.trim()
        : null,
      internalReceiptNumber: r.receiptNumber.trim(),
      status: "AVAILABLE" as const,
      notes: r.notes ?? null,
    }));
    const inserted = await tx
      .insert(inventoryBags)
      .values(bagRows)
      .returning({ id: inventoryBags.id });

    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "raw_bag_intake.create",
        targetType: "Receive",
        targetId: receiveRow.id,
        after: {
          receiveName,
          poId: resolvedPoId,
          poNumber: resolvedPoNumber,
          poLineId: resolvedPoLineId,
          tabletTypeId: input.tabletTypeId,
          supplierLotNumber: input.supplierLotNumber,
          bagCount: bagRows.length,
          orderedQuantity,
          receivedQuantity: totalDeclared,
          mode: input.poMode,
        },
      },
      tx,
    );

    // ── Mark validated QR cards ASSIGNED (pre-validation already passed)
    // qrCodesToReserve was built from input.rows before the INSERT, so
    // all cards are confirmed RAW_BAG + IDLE. Just do the bulk UPDATE and
    // audit-log each transition.
    let qrAssigned = 0;
    if (qrCodesToReserve.length > 0) {
      // All valid — mark ASSIGNED (assignedWorkflowBagId stays null here;
      // the floor scanner sets it when production starts).
      await tx
        .update(qrCards)
        .set({ status: "ASSIGNED" as const })
        .where(inArray(qrCards.scanToken, qrCodesToReserve));

      // Audit-log each QR card status transition.
      for (const token of qrCodesToReserve) {
        await writeAudit(
          {
            actorId: actor.id,
            actorRole: actor.role,
            action: "qr_card.assigned",
            targetType: "qr_card",
            after: {
              scanToken: token,
              status: "ASSIGNED",
              receiveId: receiveRow.id,
            },
          },
          tx,
        );
      }

      qrAssigned = qrCodesToReserve.length;
    }

    const receiptValues = bagRows.map((r) => r.internalReceiptNumber);
    const pendingReceiveSeeds = inserted.map((row, index) => ({
      inventoryBagId: row.id,
      receiveId: receiveRow.id,
      declaredPillCount: bagRows[index]?.declaredPillCount ?? 0,
      zohoPoId: resolvedZohoPoId,
      zohoLineItemId: resolvedZohoLineItemId,
    }));

    return {
      ok: true as const,
      receiveId: receiveRow.id,
      receiveName,
      poId: resolvedPoId,
      poNumber: resolvedPoNumber,
      poLineId: resolvedPoLineId,
      vendorName: resolvedVendor,
      tabletTypeId: input.tabletTypeId,
      tabletTypeName: tabletTypeRow.name,
      supplierLotNumber: input.supplierLotNumber,
      bagCount: bagRows.length,
      receiptRange:
        receiptValues.length > 0
          ? {
              first: receiptValues[0]!,
              last: receiptValues[receiptValues.length - 1]!,
            }
          : null,
      qrCount: bagRows.filter((r) => r.bagQrCode != null).length,
      qrAssigned,
      orderedQuantity,
      receivedQuantity: totalDeclared,
      variance: orderedQuantity == null ? null : totalDeclared - orderedQuantity,
      bagIds: inserted.map((r) => r.id),
      pendingReceiveSeeds,
    };
    });
  } catch (err) {
    return { ok: false, error: mapIntakePersistenceError(err) };
  }

  if (!txResult.ok) {
    return txResult;
  }

  if (!("pendingReceiveSeeds" in txResult)) {
    return txResult;
  }

  try {
    await seedPendingRawBagReceiveRows(txResult.pendingReceiveSeeds, actor);
  } catch (err) {
    console.error("raw_bag_intake: zoho seed failed after bags saved", err);
  }
  const { pendingReceiveSeeds: _seeds, ...publicResult } = txResult;
  return publicResult;
}

function mapIntakePersistenceError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const pg = err as {
      code?: string;
      constraint_name?: string;
      detail?: string;
    };
    if (pg.code === "23505") {
      if (pg.constraint_name === "batches_kind_number_unique") {
        return "That supplier lot is already registered. Select the matching tablet type or ask an admin to review the existing batch.";
      }
      const detail = pg.detail ?? "";
      if (
        pg.constraint_name === "receives_name_unique" ||
        detail.includes("receive_name")
      ) {
        // RECEIVING-HARDENING-v1.5.11 — receive_seq is computed from
        // existing receive count; two concurrent saves against the same
        // PO can both compute the same {PO}-R{N} name. The second INSERT
        // hits this unique violation. Surface a clear retry prompt.
        return "Another receive was created for this PO at the same time. Refresh and try again so Luma can assign the next receive number.";
      }
      if (
        pg.constraint_name?.includes("internal_receipt") ||
        detail.includes("internal_receipt")
      ) {
        return "One of those receipt numbers is already in use.";
      }
      if (
        pg.constraint_name?.includes("bag_qr") ||
        detail.includes("bag_qr")
      ) {
        return "One of those bag QR codes is already in use.";
      }
      return "A duplicate record blocked this save. Refresh the page and check whether the receive already landed.";
    }
  }
  if (err instanceof Error) return err.message;
  return "Save failed unexpectedly. Try again or contact support.";
}

// Small helper — Drizzle's `inArray` shape varies between versions; we
// stay defensive with an OR chain for the conflict pre-check.
function orInArray(values: readonly string[], field: "internalReceiptNumber" | "bagQrCode") {
  const col = field === "internalReceiptNumber"
    ? inventoryBags.internalReceiptNumber
    : inventoryBags.bagQrCode;
  if (values.length === 1) return eq(col, values[0]!);
  return or(...values.map((v) => eq(col, v)));
}

// ─── findRawBagByReceiptOrQr ──────────────────────────────────────────

export type RawBagLookupResult = {
  found: true;
  bag: {
    id: string;
    bagSequence: number;
    bagQrCode: string | null;
    internalReceiptNumber: string | null;
    declaredCount: number | null;
    weightGrams: number | null;
    receivedAt: string;
    status: string;
  };
  receive: {
    id: string;
    receiveName: string;
    poId: string | null;
    poLineId: string | null;
  };
  po: {
    poNumber: string | null;
    vendorName: string | null;
  };
  poLine: {
    qtyOrdered: number | null;
  };
  product: {
    tabletTypeId: string;
    tabletTypeName: string;
    productSku: string | null;
    productName: string | null;
  };
  supplierLot: {
    batchId: string;
    batchNumber: string;
  };
  workflow: {
    workflowBagId: string | null;
  };
  finishedLots: ReadonlyArray<{
    id: string;
    finishedLotNumber: string;
    traceCode: string | null;
  }>;
  warnings: readonly string[];
} | { found: false; warnings: readonly string[] };

/** Lookup a raw bag by receipt number OR bag QR code OR vendor barcode.
 *  Returns the full resolved context for the operator's lookup screen.
 *  Search order:
 *    1. inventory_bags.internal_receipt_number (exact match)
 *    2. inventory_bags.bag_qr_code (exact match)
 *    3. inventory_bags.vendor_barcode (exact match — legacy fallback)
 *  Returns the FIRST match. Legacy bags missing a QR get a warning. */
export async function findRawBagByReceiptOrQr(
  value: string,
): Promise<RawBagLookupResult> {
  const v = value.trim();
  if (v.length === 0) return { found: false, warnings: ["Search value is empty."] };

  const [bag] = await db
    .select()
    .from(inventoryBags)
    .where(
      or(
        eq(inventoryBags.internalReceiptNumber, v),
        eq(inventoryBags.bagQrCode, v),
        eq(inventoryBags.vendorBarcode, v),
      ),
    )
    .limit(1);
  if (!bag) return { found: false, warnings: ["No bag matches that receipt or QR code."] };

  // Resolve box → receive → PO + PO line + product + batch.
  const [boxRow] = await db
    .select({ box: smallBoxes })
    .from(smallBoxes)
    .where(eq(smallBoxes.id, bag.smallBoxId));
  if (!boxRow) return { found: false, warnings: ["Bag found but its small_box is missing."] };

  const [receiveRow] = await db
    .select({ receive: receives, po: purchaseOrders })
    .from(receives)
    .leftJoin(purchaseOrders, eq(receives.poId, purchaseOrders.id))
    .where(eq(receives.id, boxRow.box.receiveId));
  if (!receiveRow) return { found: false, warnings: ["Bag found but its receive row is missing."] };

  const [poLineRow] = receiveRow.receive.poLineId
    ? await db
        .select({ line: poLines })
        .from(poLines)
        .where(eq(poLines.id, receiveRow.receive.poLineId))
    : [];

  const [tabletRow] = await db
    .select({ tablet: tabletTypes, product: products })
    .from(tabletTypes)
    .leftJoin(products, eq(products.id, tabletTypes.id)) // best-effort; products may not link 1:1
    .where(eq(tabletTypes.id, bag.tabletTypeId));

  const [batchRow] = bag.batchId
    ? await db
        .select({ b: batches })
        .from(batches)
        .where(eq(batches.id, bag.batchId))
    : [];

  // workflow_bag(s) consuming this inventory_bag (may be none if not
  // yet in production).
  const wfBags = await db
    .select({ id: workflowBags.id })
    .from(workflowBags)
    .where(eq(workflowBags.inventoryBagId, bag.id))
    .limit(1);
  const workflowBagId = wfBags[0]?.id ?? null;

  // finished_lots derived through finished_lot_inputs → batches.
  const fl = bag.batchId
    ? await db
        .select({
          id: finishedLots.id,
          finishedLotNumber: finishedLots.finishedLotNumber,
          traceCode: finishedLots.traceCode,
        })
        .from(finishedLotInputs)
        .innerJoin(finishedLots, eq(finishedLots.id, finishedLotInputs.finishedLotId))
        .where(eq(finishedLotInputs.batchId, bag.batchId))
    : [];

  const warnings: string[] = [];
  if (!bag.bagQrCode || bag.bagQrCode.length === 0) {
    warnings.push("Legacy bag QR missing.");
  }

  return {
    found: true,
    bag: {
      id: bag.id,
      bagSequence: bag.bagNumber,
      bagQrCode: bag.bagQrCode,
      internalReceiptNumber: bag.internalReceiptNumber,
      declaredCount: bag.declaredPillCount,
      weightGrams: bag.weightGrams,
      receivedAt: (receiveRow.receive.receivedAt as Date).toISOString(),
      status: bag.status,
    },
    receive: {
      id: receiveRow.receive.id,
      receiveName: receiveRow.receive.receiveName,
      poId: receiveRow.receive.poId,
      poLineId: receiveRow.receive.poLineId,
    },
    po: {
      poNumber: receiveRow.po?.poNumber ?? null,
      vendorName: receiveRow.po?.vendorName ?? null,
    },
    poLine: {
      qtyOrdered: poLineRow?.line.qtyOrdered ?? null,
    },
    product: {
      tabletTypeId: bag.tabletTypeId,
      tabletTypeName: tabletRow?.tablet.name ?? "(unknown tablet)",
      productSku: tabletRow?.product?.sku ?? null,
      productName: tabletRow?.product?.name ?? null,
    },
    supplierLot: {
      batchId: bag.batchId ?? "",
      batchNumber: batchRow?.b.batchNumber ?? "",
    },
    workflow: { workflowBagId },
    finishedLots: fl,
    warnings,
  };
}

/** Pure-style: discriminate the result for callers. */
export type RawBagIntakeInputType = RawBagIntakeInput;
