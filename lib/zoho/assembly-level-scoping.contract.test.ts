// ASSEMBLY-LEVEL-SCOPING-v1.4.18 — pins the snapshot's source-
// allocation rows to carry assembly_level per the Zoho gateway
// v1.28.0 contract.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildLumaOperationSnapshotFromOpRow,
  deriveSourceAllocationAssemblyLevel,
  type LumaSnapshotAssemblyLevel,
} from "./luma-operation-snapshot";

const REPO = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const ACTION_PATH =
  "app/(admin)/finished-lots/[id]/zoho-production-output-preview-actions.ts";

describe("deriveSourceAllocationAssemblyLevel — unit", () => {
  it("returns unit_assembly for null componentRole (raw bag default)", () => {
    expect(deriveSourceAllocationAssemblyLevel(null)).toBe("unit_assembly");
  });

  it("returns unit_assembly for PRIMARY variety flavor", () => {
    expect(deriveSourceAllocationAssemblyLevel("PRIMARY")).toBe("unit_assembly");
  });

  it("returns unit_assembly for FLAVOR_A variety flavor", () => {
    expect(deriveSourceAllocationAssemblyLevel("FLAVOR_A")).toBe("unit_assembly");
  });

  it("returns unit_assembly for arbitrary unknown role strings (default-safe)", () => {
    // Forward-compat contract: unknown roles must not produce undefined
    // / invalid enum values, or the gateway will reject the payload.
    expect(deriveSourceAllocationAssemblyLevel("UNKNOWN_FUTURE_ROLE")).toBe(
      "unit_assembly",
    );
  });

  it("return type is the LumaSnapshotAssemblyLevel union (compile-time pin)", () => {
    const v: LumaSnapshotAssemblyLevel =
      deriveSourceAllocationAssemblyLevel(null);
    expect(["unit_assembly", "display_assembly", "case_assembly"]).toContain(v);
  });
});

describe("buildLumaOperationSnapshotFromOpRow — stamps assembly_level on every source allocation", () => {
  const op = {
    lumaOperationId: "luma-production-output-preview:LOT",
    finalizedAt: new Date("2026-06-03T12:00:00.000Z"),
    productId: "510ab906-32b9-4082-b678-5d35ced9c4b8",
    productFamily: "HYROXI_MIT_B",
    finishedSku: "LUMA-hyroxi-mit-b-sweet-t-XQ30Q",
    unitCompositeItemId: "5254962000006219038",
    workflowBagId: "4d8edddc-2ca6-4363-87c3-847b6e368f83",
    finishedLotId: "a4e11918-51cb-4ed5-9c7f-a76d9cd6d9a2",
  };

  it("stamps unit_assembly on a raw-tablet bag source allocation (Sweet Trip 352167 shape)", () => {
    const r = buildLumaOperationSnapshotFromOpRow(op, [
      {
        lumaInventoryBagId: "57c8582e-6e0f-4223-9eb3-0dc8ebebe239",
        zohoComponentItemId: "5254962000005946414",
        humanLotNumber: "352167",
        quantityAllocated: 6744,
        componentRole: null,
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.source_allocations).toEqual([
      {
        source_bag_id: "57c8582e-6e0f-4223-9eb3-0dc8ebebe239",
        item_id: "5254962000005946414",
        human_lot_number: "352167",
        quantity: 6744,
        assembly_level: "unit_assembly",
      },
    ]);
  });

  it("stamps assembly_level on every row when multiple allocations are present (e.g. a 3-level card/display/case product)", () => {
    const r = buildLumaOperationSnapshotFromOpRow(op, [
      {
        lumaInventoryBagId: "bag-A",
        zohoComponentItemId: "zoho-raw-tablet-A",
        humanLotNumber: "RAW-A",
        quantityAllocated: 100,
        componentRole: null,
      },
      {
        lumaInventoryBagId: "bag-B",
        zohoComponentItemId: "zoho-raw-tablet-B",
        humanLotNumber: "RAW-B",
        quantityAllocated: 200,
        componentRole: "FLAVOR_A",
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.source_allocations).toHaveLength(2);
    for (const a of r.snapshot.source_allocations) {
      // Today every raw-bag row resolves to unit_assembly.
      expect(a.assembly_level).toBe("unit_assembly");
    }
  });

  it("legacy callers that omit componentRole still get a valid assembly_level (backwards-compat)", () => {
    const r = buildLumaOperationSnapshotFromOpRow(op, [
      {
        lumaInventoryBagId: "bag-LEGACY",
        zohoComponentItemId: "zoho-A",
        humanLotNumber: "L-1",
        quantityAllocated: 50,
        // componentRole intentionally omitted
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.source_allocations[0]?.assembly_level).toBe(
      "unit_assembly",
    );
  });

  it("snapshot.luma_operation_id remains the envelope-matching value (no drift, v1.4.17 contract intact)", () => {
    const r = buildLumaOperationSnapshotFromOpRow(op, [
      {
        lumaInventoryBagId: "bag-A",
        zohoComponentItemId: "zoho-A",
        humanLotNumber: "L-1",
        quantityAllocated: 50,
        componentRole: null,
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.luma_operation_id).toBe(
      "luma-production-output-preview:LOT",
    );
  });
});

describe("Admin action wires componentRole into the snapshot input (source-level pin)", () => {
  const src = read(ACTION_PATH);

  it("passes componentRole through to buildLumaOperationSnapshotFromOpRow", () => {
    // After v1.4.18 the admin action must thread the row's
    // componentRole, not drop it. The helper then stamps the level.
    expect(src).toMatch(
      /buildLumaOperationSnapshotFromOpRow\([\s\S]{0,1500}componentRole:\s*row\.componentRole/,
    );
  });

  it("did NOT delete buildLumaProductionOutputOperationId helper (v1.4.17 hold)", () => {
    const payloadSrc = read("lib/zoho/luma-production-output-payload.ts");
    expect(payloadSrc).toMatch(/export function buildLumaProductionOutputOperationId/);
  });
});
