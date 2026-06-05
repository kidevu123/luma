import { eq, desc, asc, and, isNull, sql, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLots,
  finishedLotInputs,
  products,
  productPackagingSpecs,
  packagingMaterials,
  batches,
  tabletTypes,
  workflowBags,
  workflowEvents,
  inventoryBags,
  readBagMetrics,
  rawBagAllocationSessions,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { projectEvent } from "@/lib/projector";
import { projectFinishedLotPassportForLot } from "@/lib/projector/finished-lot-passport";
import { runZohoAssemblyEnqueueAfterLotCreate } from "@/lib/zoho/enqueue-after-lot-create";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type FinishedLotAuditActor = {
  id: string | null;
  role: CurrentUser["role"] | null;
};

export type PackagingFinishedLotCounts = {
  masterCases: number;
  displaysMade: number;
  looseCards: number;
};

export type AutoFinishedLotDraftInput = {
  productId: string | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  defaultShelfLifeDays: number | null;
  inventoryReceiptNumber: string | null;
  workflowReceiptNumber: string | null;
  packagedAt: Date;
  counts: PackagingFinishedLotCounts;
};

export type AutoFinishedLotDraftResult =
  | {
      ok: true;
      finishedLotNumber: string;
      producedOn: string;
      expiryDate: string;
      expiresAt: Date;
      unitsProduced: number;
      displaysProduced: number;
      casesProduced: number;
    }
  | {
      ok: false;
      reason:
        | "MISSING_PRODUCT"
        | "MISSING_RECEIPT_NUMBER"
        | "MISSING_SHELF_LIFE"
        | "MISSING_PACKAGING_STRUCTURE";
      message: string;
    };

type AutoFinishedLotDraftBlocker = Extract<
  AutoFinishedLotDraftResult,
  { ok: false }
>["reason"];

export type AutoFinishedLotReleaseResult =
  | {
      ok: true;
      finishedLotId: string;
      finishedLotNumber: string;
      effects: FinishedLotPostCommitEffect[];
      reusedExistingLot: boolean;
    }
  | {
      ok: false;
      reason:
        | AutoFinishedLotDraftBlocker
        | "WORKFLOW_BAG_NOT_FOUND"
        | "LOT_NUMBER_CONFLICT"
        | "OPEN_ALLOCATION_SESSION";
      message: string;
    };

export type FinishedLotPostCommitEffect =
  | { kind: "created"; finishedLotId: string; actor: FinishedLotAuditActor }
  | {
      kind: "released";
      finishedLotId: string;
      next: FinishedLotStatus;
      beforeStatus: FinishedLotStatus;
    };

function formatDateOnlyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function computePackagingUnitsProduced(
  counts: PackagingFinishedLotCounts,
  product: { unitsPerDisplay: number | null; displaysPerCase: number | null },
): number | null {
  if (!product.unitsPerDisplay || !product.displaysPerCase) return null;
  return (
    counts.masterCases * product.displaysPerCase * product.unitsPerDisplay +
    counts.displaysMade * product.unitsPerDisplay +
    counts.looseCards
  );
}

export function buildAutoFinishedLotDraft(
  input: AutoFinishedLotDraftInput,
): AutoFinishedLotDraftResult {
  if (!input.productId) {
    return {
      ok: false,
      reason: "MISSING_PRODUCT",
      message: "Packaging completed, but no finished product is mapped to this bag.",
    };
  }
  const finishedLotNumber = (
    input.inventoryReceiptNumber ??
    input.workflowReceiptNumber ??
    ""
  ).trim();
  if (!finishedLotNumber) {
    return {
      ok: false,
      reason: "MISSING_RECEIPT_NUMBER",
      message:
        "Packaging completed, but no source receipt number is linked to this bag.",
    };
  }
  if (!input.defaultShelfLifeDays || input.defaultShelfLifeDays <= 0) {
    return {
      ok: false,
      reason: "MISSING_SHELF_LIFE",
      message:
        "Packaging completed, but the product does not have default shelf life configured.",
    };
  }
  const unitsProduced = computePackagingUnitsProduced(input.counts, input);
  if (unitsProduced === null) {
    return {
      ok: false,
      reason: "MISSING_PACKAGING_STRUCTURE",
      message:
        "Packaging completed, but the product packaging structure is incomplete.",
    };
  }
  const expiresAt = addUtcDays(input.packagedAt, input.defaultShelfLifeDays);
  return {
    ok: true,
    finishedLotNumber,
    producedOn: formatDateOnlyUtc(input.packagedAt),
    expiryDate: formatDateOnlyUtc(expiresAt),
    expiresAt,
    unitsProduced,
    displaysProduced: input.counts.displaysMade,
    casesProduced: input.counts.masterCases,
  };
}

export async function listFinishedLots() {
  return db
    .select({
      lot: finishedLots,
      productName: products.name,
      productSku: products.sku,
      inputCount: sql<number>`(
        SELECT COUNT(*)::int FROM finished_lot_inputs
        WHERE finished_lot_id = ${finishedLots.id}
      )`,
    })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .orderBy(desc(finishedLots.producedOn), desc(finishedLots.createdAt));
}

export async function getFinishedLot(id: string) {
  const [row] = await db
    .select({
      lot: finishedLots,
      product: products,
    })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .where(eq(finishedLots.id, id));
  if (!row) return null;
  const inputs = await db
    .select({
      input: finishedLotInputs,
      batch: batches,
      tabletName: tabletTypes.name,
    })
    .from(finishedLotInputs)
    .innerJoin(batches, eq(finishedLotInputs.batchId, batches.id))
    .leftJoin(tabletTypes, eq(batches.tabletTypeId, tabletTypes.id))
    .where(eq(finishedLotInputs.finishedLotId, id))
    .orderBy(asc(batches.kind), asc(batches.batchNumber));
  return { ...row, inputs };
}

/** Bags that are FINALIZED but not yet attached to a finished lot.
 *  These are what an operator picks from when issuing a new lot. */
export async function listFinalizedBagsWithoutLot() {
  return db
    .select({
      bag: workflowBags,
      product: products,
      metrics: {
        masterCases: readBagMetrics.masterCases,
        displaysMade: readBagMetrics.displaysMade,
        looseCards: readBagMetrics.looseCards,
        unitsYielded: readBagMetrics.unitsYielded,
      },
      receiptNumber: sql<string | null>`COALESCE(${inventoryBags.internalReceiptNumber}, ${workflowBags.receiptNumber})`,
    })
    .from(workflowBags)
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
    .leftJoin(finishedLots, eq(finishedLots.workflowBagId, workflowBags.id))
    .where(and(sql`${workflowBags.finalizedAt} IS NOT NULL`, isNull(finishedLots.id)))
    .orderBy(desc(workflowBags.finalizedAt));
}

export type CreateFinishedLotInput = {
  productId: string;
  workflowBagId?: string | null;
  finishedLotNumber: string;
  producedOn: string;
  expiryDate: string;
  unitsProduced: number;
  displaysProduced?: number | null;
  casesProduced?: number | null;
  notes?: string | null;
  /** Explicit batch inputs (id + qty). When omitted, the create flow
   *  derives them from inventory_bags consumed by the workflow_bag. */
  inputs?: { batchId: string; qtyConsumed: number }[];
};

/**
 * Pure helper — exported for testing.
 * Determines the quantity to record in finished_lot_inputs.qtyConsumed
 * for a raw bag used in a finished lot.
 *
 * Precedence:
 *  1. If an OPEN session exists → throw (lot must not be created while bag is still being counted).
 *  2. If a CLOSED/DEPLETED session exists → use its consumedQty.
 *  3. Legacy fallback → use pillCount (may be wrong for partial bags; acceptable for old data).
 */
export function resolveFinishedLotTabletQty(
  openSession: { id: string } | null | undefined,
  closedSession: { consumedQty: number | null } | null | undefined,
  pillCount: number | null | undefined,
): number {
  if (openSession) {
    throw new Error(
      "Cannot create finished lot: the source raw bag has an open allocation session. " +
      "Close or deplete the allocation session before creating the lot so the consumed quantity is known.",
    );
  }
  if (closedSession?.consumedQty != null) {
    return closedSession.consumedQty;
  }
  return pillCount ?? 0;
}

/** Create a finished lot transactionally: insert the lot row, copy
 *  inputs (explicit OR derived from inventory_bags linked to the
 *  workflow_bag's consumption events), and write audit. */
async function createFinishedLotInTx(
  tx: DbTx,
  input: CreateFinishedLotInput,
  actor: FinishedLotAuditActor,
  options?: {
    status?: FinishedLotStatus;
    traceCode?: string | null;
    packedAt?: Date | null;
    expiresAt?: Date | null;
  },
) {
  const [lot] = await tx
    .insert(finishedLots)
    .values({
      productId: input.productId,
      workflowBagId: input.workflowBagId ?? null,
      finishedLotNumber: input.finishedLotNumber,
      producedOn: input.producedOn,
      expiryDate: input.expiryDate,
      unitsProduced: input.unitsProduced,
      displaysProduced: input.displaysProduced ?? null,
      casesProduced: input.casesProduced ?? null,
      notes: input.notes ?? null,
      status: options?.status ?? "PENDING_QC",
      traceCode: options?.traceCode ?? input.finishedLotNumber,
      packedAt: options?.packedAt ?? null,
      expiresAt: options?.expiresAt ?? null,
    })
    .returning();
  if (!lot) throw new Error("createFinishedLot: insert empty");

  // Resolve inputs. If explicit, use them. Otherwise infer from
  // inventory_bags pointed at by the workflow_bag's events.
  let inputRows: { batchId: string; qtyConsumed: number; eventId?: string | null }[] = [];
  if (input.inputs && input.inputs.length > 0) {
    inputRows = input.inputs.map((i) => ({ ...i, eventId: null }));
  } else if (input.workflowBagId) {
    // Derive from the workflow_bag's inventory_bag pointer. (Bottle
    // workflows that pull from multiple sources will need explicit
    // inputs — that path is in the create form.) We capture the
    // first BAG_FINALIZED event id so the genealogy points back at
    // the consumption record.
    const [bagRow] = await tx
      .select({
        inventoryBagId: workflowBags.inventoryBagId,
      })
      .from(workflowBags)
      .where(eq(workflowBags.id, input.workflowBagId));
    if (bagRow?.inventoryBagId) {
      const [invBag] = await tx
        .select({
          batchId: inventoryBags.batchId,
          pillCount: inventoryBags.pillCount,
        })
        .from(inventoryBags)
        .where(eq(inventoryBags.id, bagRow.inventoryBagId));
      const [finalizedEv] = await tx
        .select({ id: workflowEvents.id })
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.workflowBagId, input.workflowBagId),
            eq(workflowEvents.eventType, "BAG_FINALIZED"),
          ),
        );
      if (invBag?.batchId) {
        // Check for OPEN allocation session — block lot creation if bag is mid-count.
        const [openSession] = await tx
          .select({ id: rawBagAllocationSessions.id })
          .from(rawBagAllocationSessions)
          .where(
            and(
              eq(rawBagAllocationSessions.inventoryBagId, bagRow.inventoryBagId),
              eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
            ),
          )
          .limit(1);

        // Find the most recent CLOSED or DEPLETED session for this bag.
        const [closedSession] = await tx
          .select({ consumedQty: rawBagAllocationSessions.consumedQty })
          .from(rawBagAllocationSessions)
          .where(
            and(
              eq(rawBagAllocationSessions.inventoryBagId, bagRow.inventoryBagId),
              inArray(rawBagAllocationSessions.allocationStatus, ["CLOSED", "DEPLETED"]),
            ),
          )
          .orderBy(desc(rawBagAllocationSessions.closedAt))
          .limit(1);

        inputRows.push({
          batchId: invBag.batchId,
          qtyConsumed: resolveFinishedLotTabletQty(openSession, closedSession, invBag.pillCount),
          eventId: finalizedEv?.id ?? null,
        });
      }
    }
  }

  if (inputRows.length > 0) {
    await tx.insert(finishedLotInputs).values(
      inputRows.map((r) => ({
        finishedLotId: lot.id,
        batchId: r.batchId,
        qtyConsumed: r.qtyConsumed,
        derivedFromEventId: r.eventId ?? null,
      })),
    );
  }

  await writeAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: "finished_lot.create",
      targetType: "FinishedLot",
      targetId: lot.id,
      after: { ...lot, inputs: inputRows },
    },
    tx,
  );

    // Material burn rollup. Derive packaging consumption from the
    // product BOM × units produced. Per-scope multipliers:
    //   UNIT     × unitsProduced
    //   DISPLAY  × displaysProduced (or unitsProduced / unitsPerDisplay)
    //   CASE     × casesProduced (or displaysProduced / displaysPerCase)
    // We skip rows where the per-scope quantity isn't known — better
    // to undercount than to fabricate.
  const specs = await tx
    .select({
      packagingMaterialId: productPackagingSpecs.packagingMaterialId,
      qtyPerUnit: productPackagingSpecs.qtyPerUnit,
      perScope: productPackagingSpecs.perScope,
    })
    .from(productPackagingSpecs)
    .where(eq(productPackagingSpecs.productId, input.productId));
  const day = input.producedOn;
  const [productRow] = await tx
    .select({
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
    })
    .from(products)
    .where(eq(products.id, input.productId));
  const units = input.unitsProduced;
  const displays =
    input.displaysProduced ??
    (productRow?.unitsPerDisplay
      ? Math.floor(units / productRow.unitsPerDisplay)
      : null);
  const cases =
    input.casesProduced ??
    (productRow?.displaysPerCase && displays !== null
      ? Math.floor(displays / productRow.displaysPerCase)
      : null);
  for (const s of specs) {
    let qtyConsumed = 0;
    if (s.perScope === "UNIT") qtyConsumed = s.qtyPerUnit * units;
    else if (s.perScope === "DISPLAY" && displays !== null)
      qtyConsumed = s.qtyPerUnit * displays;
    else if (s.perScope === "CASE" && cases !== null)
      qtyConsumed = s.qtyPerUnit * cases;
    if (qtyConsumed <= 0) continue;
    // Manual upsert via raw SQL — read_material_burn has a unique
    // index on (day, packaging_material_id) so ON CONFLICT works.
    await tx.execute(sql`
      INSERT INTO read_material_burn (day, packaging_material_id, qty_consumed, updated_at)
      VALUES (${day}, ${s.packagingMaterialId}, ${qtyConsumed}, NOW())
      ON CONFLICT (day, packaging_material_id)
      DO UPDATE SET qty_consumed = read_material_burn.qty_consumed + ${qtyConsumed},
                    updated_at = NOW()
    `);
  }

    // LOT-1C — project the recall passport (trace_code, raw-bag M:N,
    // outputs, packaging-lot rollup, QC-event index) for this lot.
    // Idempotent; safe to re-run via the rebuilder later.
  await projectFinishedLotPassportForLot(tx, lot.id);

    // ZOHO-FINISHED-GOODS-OUTBOX-1 — link closed allocation sessions to
    // this lot so the assembly planner can resolve PO receive details.
  if (input.workflowBagId) {
    await tx
      .update(rawBagAllocationSessions)
      .set({ finishedLotId: lot.id })
      .where(
        and(
          eq(rawBagAllocationSessions.workflowBagId, input.workflowBagId),
          inArray(rawBagAllocationSessions.allocationStatus, ["CLOSED", "DEPLETED"]),
          isNull(rawBagAllocationSessions.finishedLotId),
        ),
      );
  }

  return { lot, inputs: inputRows };
}

/** Create a finished lot transactionally: insert the lot row, copy
 *  inputs (explicit OR derived from inventory_bags linked to the
 *  workflow_bag's consumption events), and write audit. */
export async function createFinishedLot(
  input: CreateFinishedLotInput,
  actor: CurrentUser,
) {
  const result = await db.transaction(async (tx) =>
    createFinishedLotInTx(tx, input, actor),
  );

  // ZOHO-FINISHED-GOODS-OUTBOX-1 — persist planned ops (DB only; no Zoho HTTP).
  // Lot creation already committed; enqueue failure must not roll back the lot.
  await runFinishedLotPostCommitEffects([
    { kind: "created", finishedLotId: result.lot.id, actor },
  ]);

  return result;
}

export async function autoCreateAndReleaseFinishedLotForWorkflowBag(
  tx: DbTx,
  args: {
    workflowBagId: string;
    packagedAt: Date;
    counts: PackagingFinishedLotCounts;
    actor: FinishedLotAuditActor;
  },
): Promise<AutoFinishedLotReleaseResult> {
  const [bag] = await tx
    .select({
      id: workflowBags.id,
      productId: workflowBags.productId,
      workflowReceiptNumber: workflowBags.receiptNumber,
      inventoryBagId: workflowBags.inventoryBagId,
      inventoryReceiptNumber: inventoryBags.internalReceiptNumber,
      productDefaultShelfLifeDays: products.defaultShelfLifeDays,
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
    })
    .from(workflowBags)
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .where(eq(workflowBags.id, args.workflowBagId));

  if (!bag) {
    return {
      ok: false,
      reason: "WORKFLOW_BAG_NOT_FOUND",
      message: "Packaging finalized, but the workflow bag could not be found.",
    };
  }

  if (bag.inventoryBagId) {
    const [openSession] = await tx
      .select({ id: rawBagAllocationSessions.id })
      .from(rawBagAllocationSessions)
      .where(
        and(
          eq(rawBagAllocationSessions.inventoryBagId, bag.inventoryBagId),
          eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
        ),
      )
      .limit(1);
    if (openSession) {
      return {
        ok: false,
        reason: "OPEN_ALLOCATION_SESSION",
        message:
          "Packaging finalized, but the source raw bag still has an open allocation session.",
      };
    }
  }

  const draft = buildAutoFinishedLotDraft({
    productId: bag.productId,
    unitsPerDisplay: bag.unitsPerDisplay,
    displaysPerCase: bag.displaysPerCase,
    defaultShelfLifeDays: bag.productDefaultShelfLifeDays,
    inventoryReceiptNumber: bag.inventoryReceiptNumber,
    workflowReceiptNumber: bag.workflowReceiptNumber,
    packagedAt: args.packagedAt,
    counts: args.counts,
  });

  if (!draft.ok) return draft;
  if (!bag.productId) {
    return {
      ok: false,
      reason: "MISSING_PRODUCT",
      message: "Packaging finalized, but no finished product is mapped to this bag.",
    };
  }

  const effects: FinishedLotPostCommitEffect[] = [];
  const [existingForBag] = await tx
    .select()
    .from(finishedLots)
    .where(eq(finishedLots.workflowBagId, args.workflowBagId))
    .limit(1);

  const [lotNumberConflict] = await tx
    .select({
      id: finishedLots.id,
      workflowBagId: finishedLots.workflowBagId,
    })
    .from(finishedLots)
    .where(eq(finishedLots.finishedLotNumber, draft.finishedLotNumber))
    .limit(1);

  if (
    lotNumberConflict &&
    lotNumberConflict.workflowBagId !== args.workflowBagId
  ) {
    return {
      ok: false,
      reason: "LOT_NUMBER_CONFLICT",
      message: `Finished lot ${draft.finishedLotNumber} already exists for another workflow bag.`,
    };
  }

  const lot =
    existingForBag ??
    (
      await createFinishedLotInTx(
        tx,
        {
          productId: bag.productId,
          workflowBagId: args.workflowBagId,
          finishedLotNumber: draft.finishedLotNumber,
          producedOn: draft.producedOn,
          expiryDate: draft.expiryDate,
          unitsProduced: draft.unitsProduced,
          displaysProduced: draft.displaysProduced,
          casesProduced: draft.casesProduced,
          notes: "Auto-created from packaging close-out.",
        },
        args.actor,
        {
          traceCode: draft.finishedLotNumber,
          packedAt: args.packagedAt,
          expiresAt: draft.expiresAt,
        },
      )
    ).lot;

  if (!existingForBag) {
    effects.push({
      kind: "created",
      finishedLotId: lot.id,
      actor: args.actor,
    });
  }

  if (lot.status !== "RELEASED") {
    const { beforeStatus } = await setFinishedLotStatusInTx(
      tx,
      lot.id,
      "RELEASED",
      args.actor,
      "Auto-released after packaging close-out.",
    );
    effects.push({
      kind: "released",
      finishedLotId: lot.id,
      next: "RELEASED",
      beforeStatus,
    });
  }

  return {
    ok: true,
    finishedLotId: lot.id,
    finishedLotNumber: lot.finishedLotNumber,
    effects,
    reusedExistingLot: Boolean(existingForBag),
  };
}

export type FinishedLotStatus =
  | "PENDING_QC"
  | "RELEASED"
  | "ON_HOLD"
  | "SHIPPED"
  | "RECALLED";

// ---------------------------------------------------------------------------
// Phase B — Zoho manufacturing BOM helper
// ---------------------------------------------------------------------------

/**
 * Build the Zoho BOM for a finished lot.
 * Queries finishedLotInputs -> batches -> packagingMaterials and maps
 * zohoItemId + qtyConsumed into the BOM array.
 * Skips materials without a zohoItemId (logged as warning).
 */
async function buildZohoBom(
  finishedLotId: string,
): Promise<Array<{ item_id: string; quantity: number }>> {
  const rows = await db
    .select({
      zohoItemId: packagingMaterials.zohoItemId,
      qtyConsumed: finishedLotInputs.qtyConsumed,
      materialName: packagingMaterials.name,
    })
    .from(finishedLotInputs)
    .innerJoin(batches, eq(batches.id, finishedLotInputs.batchId))
    .innerJoin(packagingMaterials, eq(packagingMaterials.id, batches.packagingMaterialId))
    .where(eq(finishedLotInputs.finishedLotId, finishedLotId));

  const bom: Array<{ item_id: string; quantity: number }> = [];
  for (const r of rows) {
    if (!r.zohoItemId) {
      console.warn(`[zoho.manufacturing] skipping ${r.materialName} — no zohoItemId`);
      continue;
    }
    bom.push({ item_id: r.zohoItemId, quantity: r.qtyConsumed ?? 0 });
  }
  return bom;
}

async function setFinishedLotStatusInTx(
  tx: DbTx,
  id: string,
  next: FinishedLotStatus,
  actor: FinishedLotAuditActor,
  reason?: string,
) {
  const [before] = await tx.select().from(finishedLots).where(eq(finishedLots.id, id));
  if (!before) throw new Error("setFinishedLotStatus: not found");
  const [row] = await tx
    .update(finishedLots)
    .set({ status: next })
    .where(eq(finishedLots.id, id))
    .returning();
  if (!row) throw new Error("setFinishedLotStatus: update empty");
  await writeAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: "finished_lot.status",
      targetType: "FinishedLot",
      targetId: id,
      before,
      after: { ...row, transitionReason: reason ?? null },
    },
    tx,
  );
  // Fire FINISHED_GOODS_RELEASED on the transition into RELEASED.
  // Decoupled from BAG_FINALIZED — a lot can pass QC days after
  // production completes. Only fires when the lot is linked to a
  // workflow_bag (the projector key); free-form lots created
  // without a bag are not tracked through workflow_events.
  if (
    next === "RELEASED" &&
    before.status !== "RELEASED" &&
    row.workflowBagId
  ) {
    await projectEvent(tx, {
      workflowBagId: row.workflowBagId,
      eventType: "FINISHED_GOODS_RELEASED",
      payload: {
        finished_lot_id: id,
        finished_lot_number: row.finishedLotNumber,
        ...(reason ? { reason } : {}),
        previous_status: before.status,
      },
    });
  }
  return { row, beforeStatus: before.status as FinishedLotStatus };
}

export async function setFinishedLotStatus(
  id: string,
  next: FinishedLotStatus,
  actor: CurrentUser,
  reason?: string,
) {
  const { row, beforeStatus } = await db.transaction(async (tx) =>
    setFinishedLotStatusInTx(tx, id, next, actor, reason),
  );

  runFinishedLotReleaseSideEffects(id, next, beforeStatus);

  return row;
}

function runFinishedLotReleaseSideEffects(
  id: string,
  next: FinishedLotStatus,
  beforeStatus: FinishedLotStatus,
) {
  // Phase A — PackTrack consumption push (fire-and-forget, never blocks lot release).
  if (next === "RELEASED" && beforeStatus !== "RELEASED") {
    void (async () => {
      try {
        const { isConsumptionConfigured, sendConsumptionToPackTrack } = await import(
          "@/lib/integrations/packtrack/consumption"
        );
        if (!isConsumptionConfigured()) return;

        // Load lot metadata
        const [lotMeta] = await db
          .select({
            finishedLotNumber: finishedLots.finishedLotNumber,
            unitsProduced: finishedLots.unitsProduced,
            productSku: products.sku,
          })
          .from(finishedLots)
          .innerJoin(products, eq(products.id, finishedLots.productId))
          .where(eq(finishedLots.id, id));

        if (!lotMeta) return;

        // Build consumed materials: finishedLotInputs -> batches -> packagingMaterials
        const inputRows = await db
          .select({
            material_code: packagingMaterials.sku,
            qty_consumed: finishedLotInputs.qtyConsumed,
          })
          .from(finishedLotInputs)
          .innerJoin(batches, eq(batches.id, finishedLotInputs.batchId))
          .innerJoin(packagingMaterials, eq(packagingMaterials.id, batches.packagingMaterialId))
          .where(eq(finishedLotInputs.finishedLotId, id));

        const consumedMaterials = inputRows.map((r) => ({
          material_code: r.material_code,
          qty_consumed: r.qty_consumed ?? 0,
        }));

        if (consumedMaterials.length === 0) {
          await db
            .update(finishedLots)
            .set({ packtrackConsumptionError: "No packaging inputs found for lot" })
            .where(eq(finishedLots.id, id));
          return;
        }

        const result = await sendConsumptionToPackTrack({
          source: "LUMA",
          finished_lot_id: id,
          finished_lot_number: lotMeta.finishedLotNumber ?? id,
          product_sku: lotMeta.productSku,
          units_produced: lotMeta.unitsProduced ?? 0,
          released_at: new Date().toISOString(),
          consumed_materials: consumedMaterials,
        });

        await db
          .update(finishedLots)
          .set(
            result.ok
              ? { packtrackConsumptionSentAt: new Date(), packtrackConsumptionError: null }
              : { packtrackConsumptionError: result.reason },
          )
          .where(eq(finishedLots.id, id));
      } catch (err) {
        console.error("[packtrack.consumption] fire-and-forget error:", err);
      }
    })();
  }

  // Phase E — Nexus batch registration (fire-and-forget, never blocks lot release).
  if (next === "RELEASED" && beforeStatus !== "RELEASED") {
    void (async () => {
      try {
        const { isBatchRegistrationConfigured, registerBatchInNexus } = await import(
          "@/lib/integrations/nexus/batch-registration"
        );
        if (!isBatchRegistrationConfigured()) return;

        // Load lot metadata including product SKU and name
        const [lotMeta] = await db
          .select({
            finishedLotNumber: finishedLots.finishedLotNumber,
            producedOn: finishedLots.producedOn,
            unitsProduced: finishedLots.unitsProduced,
            productSku: products.sku,
            productName: products.name,
          })
          .from(finishedLots)
          .innerJoin(products, eq(products.id, finishedLots.productId))
          .where(eq(finishedLots.id, id));

        if (!lotMeta) return;

        // Build packaging_inputs from finishedLotInputs -> batches -> packagingMaterials
        const inputs = await db
          .select({
            materialCode: packagingMaterials.sku,
            materialName: packagingMaterials.name,
            vendorLotNumber: batches.vendorLotNumber,
          })
          .from(finishedLotInputs)
          .innerJoin(batches, eq(batches.id, finishedLotInputs.batchId))
          .innerJoin(packagingMaterials, eq(packagingMaterials.id, batches.packagingMaterialId))
          .where(
            and(
              eq(finishedLotInputs.finishedLotId, id),
              eq(batches.kind, "PACKAGING"),
            )
          );

        const result = await registerBatchInNexus({
          lot_number: lotMeta.finishedLotNumber,
          product_sku: lotMeta.productSku,
          product_description: lotMeta.productName,
          produced_on: lotMeta.producedOn,
          units_produced: lotMeta.unitsProduced ?? 0,
          luma_finished_lot_id: id,
          packaging_inputs: inputs.map((i) => ({
            material_code: i.materialCode,
            material_name: i.materialName,
            supplier_lot_number: i.vendorLotNumber ?? "",
          })),
        });

        await db
          .update(finishedLots)
          .set(
            result.ok
              ? { nexusBatchRegisteredAt: new Date(), nexusBatchRegisterError: null }
              : { nexusBatchRegisterError: result.reason },
          )
          .where(eq(finishedLots.id, id));
      } catch (err) {
        console.error("[nexus.batch-registration] fire-and-forget error:", err);
      }
    })();
  }

  // Phase B — Zoho manufacture order (fire-and-forget, never blocks lot release).
  if (next === "RELEASED" && beforeStatus !== "RELEASED") {
    void (async () => {
      try {
        const { isManufacturingConfigured, createManufactureOrder } = await import(
          "@/lib/integrations/zoho/manufacturing"
        );
        if (!isManufacturingConfigured()) return;

        const [lotMeta] = await db
          .select({
            unitsProduced: finishedLots.unitsProduced,
            zohoItemId: products.zohoItemId,
            producedOn: finishedLots.producedOn,
          })
          .from(finishedLots)
          .innerJoin(products, eq(products.id, finishedLots.productId))
          .where(eq(finishedLots.id, id));

        if (!lotMeta?.zohoItemId) {
          await db
            .update(finishedLots)
            .set({ zohoManufactureError: "Product has no zohoItemId" })
            .where(eq(finishedLots.id, id));
          return;
        }

        const bom = await buildZohoBom(id);
        // producedOn is a Drizzle date() column — returned as string "YYYY-MM-DD"
        const manufactureDate = String(lotMeta.producedOn ?? new Date().toISOString()).slice(0, 10);

        const result = await createManufactureOrder({
          composite_item_id: lotMeta.zohoItemId,
          quantity_to_manufacture: lotMeta.unitsProduced ?? 0,
          manufacture_date: manufactureDate,
          bill_of_materials: bom,
          luma_finished_lot_id: id,
        });

        await db
          .update(finishedLots)
          .set(
            result.ok
              ? { zohoManufactureOrderId: result.manufacture_order_id, zohoManufactureError: null }
              : { zohoManufactureError: result.reason },
          )
          .where(eq(finishedLots.id, id));
      } catch (err) {
        console.error("[zoho.manufacturing] fire-and-forget error:", err);
      }
    })();
  }
}

export async function runFinishedLotPostCommitEffects(
  effects: FinishedLotPostCommitEffect[],
) {
  for (const effect of effects) {
    if (effect.kind === "created") {
      try {
        await runZohoAssemblyEnqueueAfterLotCreate({
          finishedLotId: effect.finishedLotId,
          actor: effect.actor,
        });
      } catch (err) {
        console.error("[zoho.assembly.enqueue] post-create error:", err);
      }
    } else if (effect.kind === "released") {
      runFinishedLotReleaseSideEffects(
        effect.finishedLotId,
        effect.next,
        effect.beforeStatus,
      );
    }
  }
}
