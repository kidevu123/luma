// WAREHOUSE-CAPABILITY-v1.4.0 — pure decision combiner.
//
// Takes a capability state and a warehouse-resolution outcome (from
// v1.3.0's resolveProductionOutputWarehouseId) and decides whether
// the preview should USE a warehouse, OMIT it, or BLOCK.
//
// Decision matrix:
//
//   Capability  Resolution    Decision
//   ──────────  ───────────   ─────────────────────────────
//   REQUIRED    resolved      use(warehouseId)
//   REQUIRED    blocked       block(v1.3.0 canonical message)
//   OPTIONAL    resolved      use(warehouseId)
//   OPTIONAL    blocked       omit
//   UNKNOWN     any           block(unknown-capability message)
//
// UNKNOWN always blocks regardless of what resolution found. An
// operator-typed warehouse never overrides a UNKNOWN capability.
//
// Pure (no I/O). Single source of truth for the combinator rule —
// tests pin the matrix at this layer so wire-up code in the preview
// action stays minimal.

import {
  WAREHOUSE_RESOLUTION_BLOCKED_MESSAGE,
  type WarehouseResolutionResult,
  type WarehouseResolutionSource,
} from "./warehouse-resolution";
import type { WarehouseCapability } from "./brand-capabilities-client";

export const WAREHOUSE_CAPABILITY_UNKNOWN_MESSAGE =
  "Cannot confirm whether this Zoho org uses warehouses. Resolve gateway warehouse capability before previewing.";

export const WAREHOUSE_OMITTED_MESSAGE =
  "This Zoho org does not use warehouses; warehouse will be omitted.";

export type WarehouseDecision =
  | {
      kind: "use";
      warehouseId: string;
      source: WarehouseResolutionSource;
    }
  | { kind: "omit" }
  | {
      kind: "block";
      reason: string;
      blockCode: "WAREHOUSE_REQUIRED" | "WAREHOUSE_CAPABILITY_UNKNOWN";
    };

/**
 * Decide what to do with the preview's warehouse_id given the
 * gateway capability and the v1.3.0 resolution outcome. Pure.
 *
 * Caller's responsibility:
 *   - Pass the actual capability fetched from the gateway (or UNKNOWN
 *     on any failure path).
 *   - Pass the resolution result built from operator/product/app/env.
 *   - On `use` → put warehouseId in the payload.
 *   - On `omit` → omit the `warehouse_id` key entirely (NOT empty
 *     string, NOT null).
 *   - On `block` → return PAYLOAD_BLOCKED to the operator with
 *     `reason` as the visible message. The `blockCode` distinguishes
 *     REQUIRED-vs-UNKNOWN for telemetry / banner rendering.
 */
export function decideWarehouseInclusion(
  capability: WarehouseCapability,
  resolution: WarehouseResolutionResult,
): WarehouseDecision {
  // UNKNOWN dominates. No operator pick can override an unknown
  // capability — fail closed.
  if (capability.state === "UNKNOWN") {
    return {
      kind: "block",
      reason: WAREHOUSE_CAPABILITY_UNKNOWN_MESSAGE,
      blockCode: "WAREHOUSE_CAPABILITY_UNKNOWN",
    };
  }

  if (resolution.ok) {
    return {
      kind: "use",
      warehouseId: resolution.warehouseId,
      source: resolution.source,
    };
  }

  // Resolution failed — operator/product/app/env were all empty.
  if (capability.state === "OPTIONAL") {
    return { kind: "omit" };
  }

  // REQUIRED + unresolved → preserve the v1.3.0 message verbatim.
  return {
    kind: "block",
    reason: resolution.reason || WAREHOUSE_RESOLUTION_BLOCKED_MESSAGE,
    blockCode: "WAREHOUSE_REQUIRED",
  };
}

/**
 * Human-readable capability source for audit-row plumbing. Used as
 * the `capabilitySource` field on the persisted op metadata.
 */
export function capabilitySourceLabel(capability: WarehouseCapability): string {
  if (capability.state === "UNKNOWN") {
    return "gateway:/zoho/brand-capabilities/warehouse:unknown";
  }
  return "gateway:/zoho/brand-capabilities/warehouse";
}
