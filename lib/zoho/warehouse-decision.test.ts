// WAREHOUSE-CAPABILITY-v1.4.0 — pure combiner tests.

import { describe, expect, it } from "vitest";
import {
  capabilitySourceLabel,
  decideWarehouseInclusion,
  WAREHOUSE_CAPABILITY_UNKNOWN_MESSAGE,
  WAREHOUSE_OMITTED_MESSAGE,
} from "./warehouse-decision";
import { WAREHOUSE_RESOLUTION_BLOCKED_MESSAGE } from "./warehouse-resolution";

const RESOLVED = {
  ok: true as const,
  warehouseId: "WH-1",
  source: "operator" as const,
};
const BLOCKED = {
  ok: false as const,
  reason: WAREHOUSE_RESOLUTION_BLOCKED_MESSAGE,
};

const REQUIRED = {
  state: "REQUIRED" as const,
  gatewayRequestId: "req-R",
};
const OPTIONAL = {
  state: "OPTIONAL" as const,
  gatewayRequestId: "req-O",
};
const UNKNOWN = {
  state: "UNKNOWN" as const,
  reason: "gateway returned HTTP 500",
};

describe("decideWarehouseInclusion — six-row matrix", () => {
  it("REQUIRED + resolved -> use(warehouseId)", () => {
    expect(decideWarehouseInclusion(REQUIRED, RESOLVED)).toEqual({
      kind: "use",
      warehouseId: "WH-1",
      source: "operator",
    });
  });

  it("REQUIRED + blocked -> block with the v1.3 canonical message", () => {
    expect(decideWarehouseInclusion(REQUIRED, BLOCKED)).toEqual({
      kind: "block",
      reason: WAREHOUSE_RESOLUTION_BLOCKED_MESSAGE,
      blockCode: "WAREHOUSE_REQUIRED",
    });
  });

  it("OPTIONAL + resolved -> use(warehouseId)", () => {
    expect(decideWarehouseInclusion(OPTIONAL, RESOLVED)).toEqual({
      kind: "use",
      warehouseId: "WH-1",
      source: "operator",
    });
  });

  it("OPTIONAL + blocked -> omit", () => {
    expect(decideWarehouseInclusion(OPTIONAL, BLOCKED)).toEqual({
      kind: "omit",
    });
  });

  it("UNKNOWN + resolved -> STILL block (UNKNOWN dominates)", () => {
    expect(decideWarehouseInclusion(UNKNOWN, RESOLVED)).toEqual({
      kind: "block",
      reason: WAREHOUSE_CAPABILITY_UNKNOWN_MESSAGE,
      blockCode: "WAREHOUSE_CAPABILITY_UNKNOWN",
    });
  });

  it("UNKNOWN + blocked -> block (UNKNOWN message, not v1.3)", () => {
    expect(decideWarehouseInclusion(UNKNOWN, BLOCKED)).toEqual({
      kind: "block",
      reason: WAREHOUSE_CAPABILITY_UNKNOWN_MESSAGE,
      blockCode: "WAREHOUSE_CAPABILITY_UNKNOWN",
    });
  });
});

describe("decideWarehouseInclusion — security invariants", () => {
  it("UNKNOWN never falls through to OPTIONAL", () => {
    // Even with a perfectly resolved warehouseId, UNKNOWN blocks.
    // This is the core fail-closed property.
    for (const operatorTyped of [
      "WH-some-real-id",
      "460000000000123",
      "ANYTHING",
    ]) {
      const r = decideWarehouseInclusion(UNKNOWN, {
        ok: true,
        warehouseId: operatorTyped,
        source: "operator",
      });
      expect(r.kind).toBe("block");
      if (r.kind !== "block") return;
      expect(r.blockCode).toBe("WAREHOUSE_CAPABILITY_UNKNOWN");
    }
  });

  it("the operator-actionable messages are stable strings", () => {
    expect(WAREHOUSE_CAPABILITY_UNKNOWN_MESSAGE).toBe(
      "Cannot confirm whether this Zoho org uses warehouses. Resolve gateway warehouse capability before previewing.",
    );
    expect(WAREHOUSE_OMITTED_MESSAGE).toBe(
      "This Zoho org does not use warehouses; warehouse will be omitted.",
    );
  });
});

describe("capabilitySourceLabel — audit provenance string", () => {
  it("REQUIRED -> gateway:/zoho/brand-capabilities/warehouse", () => {
    expect(capabilitySourceLabel(REQUIRED)).toBe(
      "gateway:/zoho/brand-capabilities/warehouse",
    );
  });

  it("OPTIONAL -> gateway:/zoho/brand-capabilities/warehouse", () => {
    expect(capabilitySourceLabel(OPTIONAL)).toBe(
      "gateway:/zoho/brand-capabilities/warehouse",
    );
  });

  it("UNKNOWN -> gateway:...:unknown so audits can disambiguate", () => {
    expect(capabilitySourceLabel(UNKNOWN)).toBe(
      "gateway:/zoho/brand-capabilities/warehouse:unknown",
    );
  });
});
