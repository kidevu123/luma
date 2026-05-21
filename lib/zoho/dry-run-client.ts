/**
 * lib/zoho/dry-run-client.ts
 *
 * ZOHO-DRY-RUN — Orchestrates the dry-run flow for a single zoho_assembly_ops row:
 *   1. Guard check (ZOHO_DRY_RUN_WRITES_ENABLED)
 *   2. Load + enrich the op from DB
 *   3. Build typed payload (blockers surfaced without status change)
 *   4. Call Zoho Integration Service with dry_run=true
 *   5. Store response_payload; never set SUCCEEDED, never increment retry_count
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tabletTypes, poLines, purchaseOrders, zohoAssemblyOps } from "@/lib/db/schema";
import type { ZohoAssemblyOp } from "@/lib/db/schema";
import { getZohoAssemblyOp } from "@/lib/db/queries/zoho-assembly";
import {
  callZohoAssemblyService,
  isZohoAssemblyDryRunEnabled,
} from "./assembly-service-client";
import type { AssemblyServiceCallResult } from "./assembly-service-client";
import {
  buildTabletReceivePayload,
  buildAssemblyPayload,
  buildDryRunIdempotencyKey,
} from "./operation-payloads";
import type { PayloadBlocker, PayloadWarning } from "./operation-payloads";

// ─── Result type ──────────────────────────────────────────────────────────────

export type DryRunOperationResult =
  | { kind: "GUARD_DISABLED"; message: string }
  | { kind: "OP_NOT_FOUND"; opId: string }
  | { kind: "PAYLOAD_BLOCKED"; blockers: PayloadBlocker[]; warnings: PayloadWarning[] }
  | { kind: "SERVICE_ERROR"; httpStatus: number | null; body: unknown; message: string }
  | { kind: "OK"; httpStatus: number; body: unknown; warnings: PayloadWarning[] };

// ─── Internal types ───────────────────────────────────────────────────────────

export type EnrichedOp = {
  op: ZohoAssemblyOp;
  /** from tabletTypes.zohoItemId, null for non-TABLET_RECEIVE */
  zohoTabletItemId: string | null;
  /** from purchaseOrders.zohoPoId, null for assembly ops */
  zohoPoId: string | null;
  /** from poLines.zohoLineItemId, null for assembly ops */
  zohoLineItemId: string | null;
};

// ─── Default DB loader ────────────────────────────────────────────────────────

async function defaultLoadOp(id: string): Promise<EnrichedOp | null> {
  const op = await getZohoAssemblyOp(id);
  if (!op) return null;

  if (op.opKind === "TABLET_RECEIVE") {
    let zohoTabletItemId: string | null = null;
    let zohoPoId: string | null = null;
    let zohoLineItemId: string | null = null;

    if (op.sourceTabletTypeId) {
      const [ttRow] = await db
        .select({ zohoItemId: tabletTypes.zohoItemId })
        .from(tabletTypes)
        .where(eq(tabletTypes.id, op.sourceTabletTypeId))
        .limit(1);
      zohoTabletItemId = ttRow?.zohoItemId ?? null;
    }

    if (op.sourcePoLineId) {
      const [plRow] = await db
        .select({
          zohoLineItemId: poLines.zohoLineItemId,
          poId: poLines.poId,
        })
        .from(poLines)
        .where(eq(poLines.id, op.sourcePoLineId))
        .limit(1);

      if (plRow) {
        zohoLineItemId = plRow.zohoLineItemId ?? null;

        const [poRow] = await db
          .select({ zohoPoId: purchaseOrders.zohoPoId })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, plRow.poId))
          .limit(1);
        zohoPoId = poRow?.zohoPoId ?? null;
      }
    }

    return { op, zohoTabletItemId, zohoPoId, zohoLineItemId };
  }

  // Assembly ops: no extra joins needed
  return { op, zohoTabletItemId: null, zohoPoId: null, zohoLineItemId: null };
}

// ─── Options ──────────────────────────────────────────────────────────────────

type DryRunOpts = {
  /** Injectable DB loader — returns enriched data for the op */
  loadOp?: (id: string) => Promise<EnrichedOp | null>;
  /** Injectable service caller — replaces real callZohoAssemblyService in tests */
  callService?: typeof callZohoAssemblyService;
  /** Injectable env for the guard check */
  env?: Record<string, string | undefined>;
};

// ─── Main function ────────────────────────────────────────────────────────────

export async function dryRunZohoAssemblyOperation(
  opId: string,
  opts?: DryRunOpts,
): Promise<DryRunOperationResult> {
  // Step 1: Guard check
  const env = opts?.env ?? process.env;
  const warehouseId = env["ZOHO_WAREHOUSE_ID"] ?? null;
  if (!isZohoAssemblyDryRunEnabled(env)) {
    return {
      kind: "GUARD_DISABLED",
      message: "Dry-run writes are disabled. Set ZOHO_DRY_RUN_WRITES_ENABLED=true to enable.",
    };
  }

  // Step 2: Load enriched op
  const loader = opts?.loadOp ?? defaultLoadOp;
  const enriched = await loader(opId);
  if (!enriched) {
    return { kind: "OP_NOT_FOUND", opId };
  }

  const { op } = enriched;

  // Step 3: Build payload
  let buildResult: ReturnType<typeof buildTabletReceivePayload> | ReturnType<typeof buildAssemblyPayload>;
  let path: "/zoho/purchase_receives/create" | "/zoho/assemblies/create";

  if (op.opKind === "TABLET_RECEIVE") {
    const input = {
      opId: op.id,
      finishedLotId: op.finishedLotId,
      sourceInventoryBagId: op.sourceInventoryBagId ?? null,
      zohoTabletItemId: enriched.zohoTabletItemId,
      zohoPoId: enriched.zohoPoId,
      zohoLineItemId: enriched.zohoLineItemId,
      quantity: op.quantity,
      date: new Date().toISOString().slice(0, 10),
      internalIdempotencyKey: op.idempotencyKey,
      warehouseId: warehouseId || null,
    };
    buildResult = buildTabletReceivePayload(input);
    path = "/zoho/purchase_receives/create";
  } else {
    // UNIT_ASSEMBLE | DISPLAY_ASSEMBLE | CASE_ASSEMBLE
    const opKind = op.opKind;
    if (
      opKind !== "UNIT_ASSEMBLE" &&
      opKind !== "DISPLAY_ASSEMBLE" &&
      opKind !== "CASE_ASSEMBLE"
    ) {
      // Exhaustiveness guard — should never happen given the enum
      return {
        kind: "SERVICE_ERROR",
        httpStatus: null,
        body: null,
        message: `Unsupported opKind: ${opKind as string}`,
      };
    }
    const input = {
      opId: op.id,
      finishedLotId: op.finishedLotId,
      opKind,
      zohoCompositeItemId: op.zohoItemId ?? null,
      quantity: op.quantity,
      date: new Date().toISOString().slice(0, 10),
      upstreamReceiveOpId: null,
      upstreamAssemblyOpId: null,
      warehouseId: warehouseId || null,
    };
    buildResult = buildAssemblyPayload(input);
    path = "/zoho/assemblies/create";
  }

  // Step 4: Payload blocked
  if (!buildResult.ok) {
    // Store blockers summary in DB (best-effort, do not change status)
    const blockersSummary = buildResult.blockers.map((b) => `${b.field}: ${b.message}`).join("; ");
    await db
      .update(zohoAssemblyOps)
      .set({
        lastError: blockersSummary,
        responsePayload: {
          dry_run: true,
          blocked: true,
          blockers: buildResult.blockers,
          warnings: buildResult.warnings,
        } as ZohoAssemblyOp["responsePayload"],
      })
      .where(eq(zohoAssemblyOps.id, op.id));

    return {
      kind: "PAYLOAD_BLOCKED",
      blockers: buildResult.blockers,
      warnings: buildResult.warnings,
    };
  }

  // Step 5: Build idempotency key
  const idempotencyKey = buildDryRunIdempotencyKey(op.id, op.opKind);

  // Step 6: Call service
  const serviceCall = opts?.callService ?? callZohoAssemblyService;
  const callOpts: Parameters<typeof callZohoAssemblyService>[0] = {
    path,
    payload: buildResult.payload as Record<string, unknown>,
    idempotencyKey,
    ...(opts?.env !== undefined ? { env: opts.env } : {}),
  };
  const serviceResult: AssemblyServiceCallResult = await serviceCall(callOpts);

  // Step 7: Guard blocked from service
  if (!serviceResult.ok && serviceResult.guardBlocked) {
    return { kind: "GUARD_DISABLED", message: serviceResult.message };
  }

  // Step 8: Build response to store
  const responseToStore = {
    dry_run: true,
    attempted_at: new Date().toISOString(),
    idempotency_key: idempotencyKey,
    http_status: serviceResult.httpStatus,
    ok: serviceResult.ok,
    body: serviceResult.body,
    warnings: buildResult.warnings,
  };

  // Step 9: UPDATE response_payload (and last_error on failure)
  // IMPORTANT: never set status to SUCCEEDED, never set zoho_reference_id,
  // never increment retry_count
  if (!serviceResult.ok) {
    await db
      .update(zohoAssemblyOps)
      .set({
        responsePayload: responseToStore as ZohoAssemblyOp["responsePayload"],
        lastError: serviceResult.message,
      })
      .where(eq(zohoAssemblyOps.id, op.id));
  } else {
    await db
      .update(zohoAssemblyOps)
      .set({
        responsePayload: responseToStore as ZohoAssemblyOp["responsePayload"],
      })
      .where(eq(zohoAssemblyOps.id, op.id));
  }

  // Step 10: Service error
  if (!serviceResult.ok) {
    return {
      kind: "SERVICE_ERROR",
      httpStatus: serviceResult.httpStatus,
      body: serviceResult.body,
      message: serviceResult.message,
    };
  }

  // Step 11: OK
  return {
    kind: "OK",
    httpStatus: serviceResult.httpStatus,
    body: serviceResult.body,
    warnings: buildResult.warnings,
  };
}
