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
  rawBagAllocationSessions,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { projectEvent } from "@/lib/projector";
import { projectFinishedLotPassportForLot } from "@/lib/projector/finished-lot-passport";

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
    })
    .from(workflowBags)
    .leftJoin(products, eq(workflowBags.productId, products.id))
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
export async function createFinishedLot(
  input: CreateFinishedLotInput,
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
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
        status: "PENDING_QC",
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

    return { lot, inputs: inputRows };
  });
}

export type FinishedLotStatus =
  | "PENDING_QC"
  | "RELEASED"
  | "ON_HOLD"
  | "SHIPPED"
  | "RECALLED";

export async function setFinishedLotStatus(
  id: string,
  next: FinishedLotStatus,
  actor: CurrentUser,
  reason?: string,
) {
  const { row, beforeStatus } = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(finishedLots).where(eq(finishedLots.id, id));
    if (!before) throw new Error("setFinishedLotStatus: not found");
    const [row] = await tx
      .update(finishedLots)
      .set({ status: next })
      .where(eq(finishedLots.id, id))
      .returning();
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
      row?.workflowBagId
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
    return { row, beforeStatus: before.status };
  });

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

  return row;
}
