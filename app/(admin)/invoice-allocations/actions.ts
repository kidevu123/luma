"use server";

// COMMERCIAL-TRACE-5 — server actions for the allocation review UI.
//
// Five operator-driven actions wrap the pure engine + DB write layer
// from COMMERCIAL-TRACE-4. All require admin. Each writes an audit row.
//
// Safety invariants enforced here (in addition to the DB layer's own
// guards):
//   - generate never deletes confirmed=true rows
//   - regenerate clears only confirmed=false rows, then re-runs
//   - confirm flips a single allocation to CONFIRMED / HIGH and bumps
//     the linked shipment_finished_lots.invoice_allocation_status to
//     'ALLOCATED' (only when current status is UNALLOCATED or SUGGESTED;
//     never demotes CONFIRMED)
//   - reject only works on confirmed=false rows; keeps the row for the
//     audit trail and marks it REJECTED
//   - clearUnconfirmed deletes only confirmed=false rows
//
// No live Zoho calls. No Nexus exposure. Unconfirmed allocations stay
// internal-only — Nexus customer-scope routes (later phases) must
// filter on confirmed=true via commercialTraceVisibilityPolicy.

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLotInvoiceAllocations,
  shipmentFinishedLots,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { writeAudit } from "@/lib/db/audit";
import {
  buildAllocationInsertRows,
  confirmAllocationPure,
  suggestAllocationsForInvoiceLine,
  type AllocationSuggestion,
} from "@/lib/production/commercial-trace-allocations";
import {
  clearUnconfirmedSuggestionsForInvoiceLine,
  loadFinishedLotCandidatesForInvoiceLine,
  loadInvoiceLineAllocationContext,
  writeSuggestedAllocationsForInvoiceLine,
} from "@/lib/db/queries/commercial-trace-allocations";

export type GenerateResult =
  | {
      ok: true;
      invoiceLineId: string;
      counts: {
        inserted: number;
        cleared: number;
        shipmentRowsUpdated: number;
        suggestions: number;
      };
      unallocatedQuantity: number;
      warnings: string[];
    }
  | { ok: false; error: string };

export async function generateInvoiceLineAllocationSuggestionsAction(
  invoiceLineId: string,
): Promise<GenerateResult> {
  const actor = await requireAdmin();
  if (!invoiceLineId || typeof invoiceLineId !== "string") {
    return { ok: false, error: "Missing invoice line id." };
  }

  const ctx = await loadInvoiceLineAllocationContext(invoiceLineId);
  if (!ctx) return { ok: false, error: "Invoice line not found." };

  const candidates = await loadFinishedLotCandidatesForInvoiceLine({
    invoiceLine: ctx.input,
  });

  const result = suggestAllocationsForInvoiceLine(ctx.input, candidates, {
    zohoCustomerIdToLumaId: ctx.zohoCustomerIdToLumaId,
  });

  const rows = buildAllocationInsertRows(result.suggestions);
  const persisted = await writeSuggestedAllocationsForInvoiceLine(
    invoiceLineId,
    rows,
  );

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "invoice_allocation.generate",
    targetType: "ZohoInvoiceLine",
    targetId: invoiceLineId,
    after: {
      inserted: persisted.inserted,
      cleared: persisted.cleared,
      shipmentRowsUpdated: persisted.shipmentRowsUpdated,
      unallocatedQuantity: result.unallocatedQuantity,
      warningCount: result.warnings.length,
    },
  });

  revalidatePath("/invoice-allocations");

  return {
    ok: true,
    invoiceLineId,
    counts: {
      inserted: persisted.inserted,
      cleared: persisted.cleared,
      shipmentRowsUpdated: persisted.shipmentRowsUpdated,
      suggestions: rows.length,
    },
    unallocatedQuantity: result.unallocatedQuantity,
    warnings: [...result.warnings],
  };
}

export async function regenerateInvoiceLineAllocationSuggestionsAction(
  invoiceLineId: string,
): Promise<GenerateResult> {
  // Same semantics as generate — writeSuggestedAllocationsForInvoiceLine
  // already deletes the existing confirmed=false rows for this line
  // before inserting. So this is intentionally a thin alias today,
  // distinct only in audit-action name so the review-page button click
  // tells a different story in audit_log.
  const actor = await requireAdmin();
  if (!invoiceLineId || typeof invoiceLineId !== "string") {
    return { ok: false, error: "Missing invoice line id." };
  }

  const ctx = await loadInvoiceLineAllocationContext(invoiceLineId);
  if (!ctx) return { ok: false, error: "Invoice line not found." };

  const candidates = await loadFinishedLotCandidatesForInvoiceLine({
    invoiceLine: ctx.input,
  });
  const result = suggestAllocationsForInvoiceLine(ctx.input, candidates, {
    zohoCustomerIdToLumaId: ctx.zohoCustomerIdToLumaId,
  });
  const rows = buildAllocationInsertRows(result.suggestions);
  const persisted = await writeSuggestedAllocationsForInvoiceLine(
    invoiceLineId,
    rows,
  );

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "invoice_allocation.regenerate",
    targetType: "ZohoInvoiceLine",
    targetId: invoiceLineId,
    after: {
      inserted: persisted.inserted,
      cleared: persisted.cleared,
      shipmentRowsUpdated: persisted.shipmentRowsUpdated,
      unallocatedQuantity: result.unallocatedQuantity,
    },
  });

  revalidatePath("/invoice-allocations");

  return {
    ok: true,
    invoiceLineId,
    counts: {
      inserted: persisted.inserted,
      cleared: persisted.cleared,
      shipmentRowsUpdated: persisted.shipmentRowsUpdated,
      suggestions: rows.length,
    },
    unallocatedQuantity: result.unallocatedQuantity,
    warnings: [...result.warnings],
  };
}

export type ConfirmResult =
  | {
      ok: true;
      allocationId: string;
      shipmentFinishedLotId: string | null;
      shipmentRowsUpdated: number;
    }
  | { ok: false; error: string };

export async function confirmInvoiceAllocationAction(
  allocationId: string,
): Promise<ConfirmResult> {
  const actor = await requireAdmin();
  if (!allocationId || typeof allocationId !== "string") {
    return { ok: false, error: "Missing allocation id." };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: finishedLotInvoiceAllocations.id,
        invoiceLineId: finishedLotInvoiceAllocations.invoiceLineId,
        finishedLotId: finishedLotInvoiceAllocations.finishedLotId,
        shipmentFinishedLotId:
          finishedLotInvoiceAllocations.shipmentFinishedLotId,
        quantityAllocated: finishedLotInvoiceAllocations.quantityAllocated,
        unit: finishedLotInvoiceAllocations.unit,
        confidence: finishedLotInvoiceAllocations.confidence,
        source: finishedLotInvoiceAllocations.source,
        status: finishedLotInvoiceAllocations.status,
        confirmed: finishedLotInvoiceAllocations.confirmed,
      })
      .from(finishedLotInvoiceAllocations)
      .where(eq(finishedLotInvoiceAllocations.id, allocationId))
      .limit(1);

    if (!existing) return { ok: false, error: "Allocation not found." };
    if (existing.confirmed) {
      // Idempotent: already confirmed. Treat as a success no-op.
      return {
        ok: true,
        allocationId,
        shipmentFinishedLotId: existing.shipmentFinishedLotId,
        shipmentRowsUpdated: 0,
      };
    }

    // Lift via the pure helper to enforce the user-id non-empty rule.
    confirmAllocationPure(
      {
        invoiceLineId: existing.invoiceLineId,
        finishedLotId: existing.finishedLotId,
        shipmentFinishedLotId: existing.shipmentFinishedLotId,
        quantitySuggested: Number(existing.quantityAllocated ?? 0),
        unit: existing.unit ?? null,
        confidence: "MEDIUM",
        source: "AUTO_SUGGESTED_EXACT",
        status: "SUGGESTED",
        reasons: [],
        warnings: [],
      } as AllocationSuggestion,
      actor.id,
      new Date(),
    );

    const confirmedAt = new Date();
    await tx
      .update(finishedLotInvoiceAllocations)
      .set({
        confirmed: true,
        status: "CONFIRMED",
        confidence: "HIGH",
        confirmedByUserId: actor.id,
        confirmedAt,
        updatedAt: new Date(),
      })
      .where(eq(finishedLotInvoiceAllocations.id, allocationId));

    let shipmentRowsUpdated = 0;
    if (existing.shipmentFinishedLotId) {
      // Bump linked shipment_finished_lot to ALLOCATED. Never demotes
      // a CONFIRMED row (re-confirming the same pair is a no-op once
      // it's CONFIRMED). Also never overrides ALLOCATED.
      const updated = await tx
        .update(shipmentFinishedLots)
        .set({
          invoiceAllocationStatus: "ALLOCATED",
          lastInvoiceAllocationAt: new Date(),
        })
        .where(
          and(
            eq(shipmentFinishedLots.id, existing.shipmentFinishedLotId),
            inArray(shipmentFinishedLots.invoiceAllocationStatus, [
              "UNALLOCATED",
              "SUGGESTED",
            ]),
          ),
        )
        .returning({ id: shipmentFinishedLots.id });
      shipmentRowsUpdated = updated.length;
    }

    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "invoice_allocation.confirm",
        targetType: "FinishedLotInvoiceAllocation",
        targetId: allocationId,
        after: {
          status: "CONFIRMED",
          confidence: "HIGH",
          confirmedAt: confirmedAt.toISOString(),
          shipmentRowsUpdated,
        },
      },
      tx,
    );

    revalidatePath("/invoice-allocations");
    return {
      ok: true,
      allocationId,
      shipmentFinishedLotId: existing.shipmentFinishedLotId,
      shipmentRowsUpdated,
    };
  });
}

export type RejectResult =
  | { ok: true; allocationId: string }
  | { ok: false; error: string };

export async function rejectInvoiceAllocationAction(
  allocationId: string,
): Promise<RejectResult> {
  const actor = await requireAdmin();
  if (!allocationId || typeof allocationId !== "string") {
    return { ok: false, error: "Missing allocation id." };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: finishedLotInvoiceAllocations.id,
        confirmed: finishedLotInvoiceAllocations.confirmed,
        status: finishedLotInvoiceAllocations.status,
      })
      .from(finishedLotInvoiceAllocations)
      .where(eq(finishedLotInvoiceAllocations.id, allocationId))
      .limit(1);
    if (!existing) return { ok: false, error: "Allocation not found." };
    if (existing.confirmed) {
      return {
        ok: false,
        error: "Confirmed allocations cannot be rejected. Use the audit trail instead.",
      };
    }

    await tx
      .update(finishedLotInvoiceAllocations)
      .set({ status: "REJECTED", updatedAt: new Date() })
      .where(eq(finishedLotInvoiceAllocations.id, allocationId));

    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "invoice_allocation.reject",
        targetType: "FinishedLotInvoiceAllocation",
        targetId: allocationId,
        after: { status: "REJECTED" },
      },
      tx,
    );

    revalidatePath("/invoice-allocations");
    return { ok: true, allocationId };
  });
}

export type ClearResult =
  | { ok: true; invoiceLineId: string; cleared: number }
  | { ok: false; error: string };

export async function clearUnconfirmedInvoiceAllocationsAction(
  invoiceLineId: string,
): Promise<ClearResult> {
  const actor = await requireAdmin();
  if (!invoiceLineId || typeof invoiceLineId !== "string") {
    return { ok: false, error: "Missing invoice line id." };
  }

  const cleared = await clearUnconfirmedSuggestionsForInvoiceLine(invoiceLineId);

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "invoice_allocation.clear_unconfirmed",
    targetType: "ZohoInvoiceLine",
    targetId: invoiceLineId,
    after: { cleared },
  });

  revalidatePath("/invoice-allocations");
  return { ok: true, invoiceLineId, cleared };
}
