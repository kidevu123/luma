// Moved verbatim from app/(floor)/floor/[token]/actions.ts
// (saveSealingProductAction, guard sequence + transaction body, plus the
// module-scope OpenAllocationBlockError / raiseAllocationOpenFailure pair
// the body throws through).
//
// This is a pure relocation. Do not change behaviour, ordering, error
// strings, or payload shapes — this transaction is what locks product
// identity onto a workflow bag (workflow_bags.product_id + PRODUCT_MAPPED)
// AND opens the raw-bag allocation session the tablet ledger reconciles
// against, so a drift here is a genealogy/ledger bug, not a cosmetic one.
//
// actions.ts is a "use server" module, so every export there must be an
// async server action. The shared implementation therefore cannot live
// in it; the action now calls into this module and keeps only the
// FormData parse, authStation, and the trailing revalidatePath() calls
// (Next.js concerns, not domain logic). OpenAllocationBlockError and
// raiseAllocationOpenFailure are exported and imported back into
// actions.ts, which throws/catches the SAME class from its own scan and
// pickup paths — one class identity, or `instanceof` silently stops
// matching. That is the same arrangement projectBagReleasedEvent already
// has in record-stage-event.ts.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  productAllowedTablets,
  products,
  readStationLive,
  workflowBags,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import { ensureOpenRawBagAllocationSessionForWorkflowBag } from "@/lib/production/raw-bag-allocation-lifecycle";
import {
  SEALING_PRODUCT_ALREADY_SAVED_ERROR,
  SEALING_STATION_KINDS,
  validateSealingProductPick,
} from "@/lib/production/sealing-product";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";
import {
  buildFloorOpenAllocationBlock,
  computeSystemDerivedResolutionForBag,
  type FloorOpenAllocationBlock,
} from "@/lib/production/system-derived-allocation-resolution";
import { resolveWorkflowBagTabletTypeId } from "@/lib/production/workflow-bag-tablet-context";
import type { StationRow } from "./record-stage-event";

/** SPLIT-BAG-1 — thrown (inside the start transaction, so it rolls back with no
 *  writes) when the raw bag is blocked by an OPEN allocation from a prior run.
 *  The outer catch converts it to a STRUCTURED floor-blocker result so the
 *  station shows a "Use calculated remaining" panel instead of a dead-end
 *  error. Carries only the ids needed to compute eligibility after rollback. */
export class OpenAllocationBlockError extends Error {
  readonly inventoryBagId: string;
  readonly cardId: string | null;
  constructor(inventoryBagId: string, cardId: string | null) {
    super("This bag has an open allocation from a prior run.");
    this.name = "OpenAllocationBlockError";
    this.inventoryBagId = inventoryBagId;
    this.cardId = cardId;
  }
}

/** Raise the right error for a failed allocation open: the structured
 *  split-bag block for the "open session on this bag" case, else a plain error. */
export function raiseAllocationOpenFailure(
  alloc: { error: string; code?: string },
  ctx: { inventoryBagId: string; cardId: string | null },
): never {
  if (alloc.code === "OPEN_SESSION_ON_BAG") {
    throw new OpenAllocationBlockError(ctx.inventoryBagId, ctx.cardId);
  }
  throw new Error(alloc.error);
}

export type AssignBagProductInput = {
  station: StationRow;
  workflowBagId: string;
  productId: string;
  clientEventId?: string | undefined;
  overrideEmployeeCode?: string | null | undefined;
};

export type AssignBagProductResult =
  | { ok: true }
  | { error: string }
  | { openAllocationBlock: FloorOpenAllocationBlock };

/** Lock the finished product onto a bag at sealing: the guard sequence and
 *  transaction moved out of saveSealingProductAction.
 *
 *  PRECONDITION — callers MUST have authenticated the station first. This
 *  function performs NO station auth of its own: it trusts `input.station`
 *  and derives `stationId` from `station.id`. On the floor path that
 *  guarantee comes from `authStation(token, stationId)`, which validates the
 *  URL scan token, refuses a station/form mismatch, and rejects inactive
 *  stations. Any new caller (advanceBag included) must establish the same
 *  guarantee before calling — do not expose this over an unauthenticated
 *  route. */
export async function assignBagProduct(
  input: AssignBagProductInput,
): Promise<AssignBagProductResult> {
  const {
    station,
    workflowBagId,
    productId,
    clientEventId,
    overrideEmployeeCode,
  } = input;
  // authStation guarantees station.id === the stationId the form
  // targeted, so this is the same value the action used.
  const stationId = station.id;

  try {
    if (!SEALING_STATION_KINDS.has(station.kind)) {
      return {
        error: `Station kind ${station.kind} cannot save product at sealing.`,
      };
    }

    const [live] = await db
      .select({ currentWorkflowBagId: readStationLive.currentWorkflowBagId })
      .from(readStationLive)
      .where(eq(readStationLive.stationId, stationId));
    if (live?.currentWorkflowBagId !== workflowBagId) {
      return { error: "This bag is not active at this sealing station." };
    }

    const [bagProductRow] = await db
      .select({ productId: workflowBags.productId })
      .from(workflowBags)
      .where(eq(workflowBags.id, workflowBagId));

    if (bagProductRow?.productId) {
      if (bagProductRow.productId === productId) {
        return { ok: true };
      }
      return { error: SEALING_PRODUCT_ALREADY_SAVED_ERROR };
    }

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: stationId,
        overrideEmployeeCode: overrideEmployeeCode ?? null,
      });

      const [productLookup] = await tx
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          kind: products.kind,
          isActive: products.isActive,
        })
        .from(products)
        .where(eq(products.id, productId));

      const tabletTypeId = await resolveWorkflowBagTabletTypeId(
        tx,
        workflowBagId,
      );

      const tabletRows = await tx
        .select({ tabletTypeId: productAllowedTablets.tabletTypeId })
        .from(productAllowedTablets)
        .where(eq(productAllowedTablets.productId, productId));

      const sealingPick = validateSealingProductPick({
        stationKind: station.kind,
        pickedProductId: productId,
        product: productLookup ?? null,
        tabletTypeId,
        allowedTabletTypeIds: tabletRows.map((r) => r.tabletTypeId),
      });
      if (!sealingPick.ok) {
        throw new Error(sealingPick.reason);
      }

      await tx
        .update(workflowBags)
        .set({ productId: sealingPick.productId })
        .where(eq(workflowBags.id, workflowBagId));

      await projectEvent(tx, {
        workflowBagId: workflowBagId,
        stationId: stationId,
        eventType: "PRODUCT_MAPPED",
        payload: {
          product_id: sealingPick.productId,
          product_sku: productLookup?.sku ?? null,
          product_name: productLookup?.name ?? null,
          product_kind: productLookup?.kind ?? null,
          station_kind: station.kind,
          source: "SEALING_SELECTION",
        },
        clientEventId: clientEventId ?? null,
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
      });

      await writeAudit(
        {
          actorId: accountability.enteredByUserId ?? null,
          actorRole: null,
          action: "floor.sealing_product_saved",
          targetType: "WorkflowBag",
          targetId: workflowBagId,
          after: {
            product_id: sealingPick.productId,
            product_sku: productLookup?.sku ?? null,
            station_id: stationId,
            source: "SEALING_SELECTION",
          },
        },
        tx,
      );

      const [wfBagRow] = await tx
        .select({ inventoryBagId: workflowBags.inventoryBagId })
        .from(workflowBags)
        .where(eq(workflowBags.id, workflowBagId))
        .limit(1);
      if (wfBagRow?.inventoryBagId) {
        const sealingInventoryBagId = wfBagRow.inventoryBagId;
        const alloc = await ensureOpenRawBagAllocationSessionForWorkflowBag(tx, {
          inventoryBagId: wfBagRow.inventoryBagId,
          workflowBagId: workflowBagId,
          productId: sealingPick.productId,
        });
        if (!alloc.ok) {
          if (sealingInventoryBagId) {
            raiseAllocationOpenFailure(alloc, {
              inventoryBagId: sealingInventoryBagId,
              cardId: null,
            });
          }
          throw new Error(alloc.error);
        }
      }
    });
  } catch (err) {
    if (err instanceof OpenAllocationBlockError) {
      const resolution = await computeSystemDerivedResolutionForBag(
        err.inventoryBagId,
      );
      return {
        openAllocationBlock: buildFloorOpenAllocationBlock({
          inventoryBagId: err.inventoryBagId,
          cardId: err.cardId,
          resolution,
        }),
      };
    }
    return {
      error: err instanceof Error ? err.message : "Could not save product.",
    };
  }

  return { ok: true };
}
