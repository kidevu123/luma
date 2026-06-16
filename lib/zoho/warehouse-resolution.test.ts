// WAREHOUSE-RESOLUTION-v1.3.0 — pure-helper tests.

import { describe, expect, it } from "vitest";
import {
  WAREHOUSE_RESOLUTION_BLOCKED_MESSAGE,
  describeWarehouseSource,
  resolveProductionOutputWarehouseId,
} from "./warehouse-resolution";

describe("resolveProductionOutputWarehouseId — precedence", () => {
  it("operator pick overrides all other sources", () => {
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: "OP-WH-1",
      productWarehouseId: "PROD-WH-2",
      appSettingsWarehouseId: "APP-WH-3",
      envWarehouseId: "ENV-WH-4",
    });
    expect(result).toEqual({
      ok: true,
      warehouseId: "OP-WH-1",
      source: "operator",
    });
  });

  it("product default overrides app settings and env when no operator pick", () => {
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: null,
      productWarehouseId: "PROD-WH-2",
      appSettingsWarehouseId: "APP-WH-3",
      envWarehouseId: "ENV-WH-4",
    });
    expect(result).toEqual({
      ok: true,
      warehouseId: "PROD-WH-2",
      source: "product",
    });
  });

  it("app settings overrides env when no operator pick and no product default", () => {
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: null,
      productWarehouseId: null,
      appSettingsWarehouseId: "APP-WH-3",
      envWarehouseId: "ENV-WH-4",
    });
    expect(result).toEqual({
      ok: true,
      warehouseId: "APP-WH-3",
      source: "appSettings",
    });
  });

  it("env is used only when everything else is empty", () => {
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: null,
      productWarehouseId: null,
      appSettingsWarehouseId: null,
      envWarehouseId: "ENV-WH-4",
    });
    expect(result).toEqual({
      ok: true,
      warehouseId: "ENV-WH-4",
      source: "env",
    });
  });

  it("blocks with the canonical operator-actionable message when all four are missing", () => {
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: null,
      productWarehouseId: null,
      appSettingsWarehouseId: null,
      envWarehouseId: null,
    });
    expect(result).toEqual({
      ok: false,
      reason: WAREHOUSE_RESOLUTION_BLOCKED_MESSAGE,
    });
  });

  it("blocked message stays exactly this string — it's surfaced verbatim to the operator", () => {
    expect(WAREHOUSE_RESOLUTION_BLOCKED_MESSAGE).toBe(
      "No warehouse configured. Set one in Zoho settings or choose a warehouse on the preview form.",
    );
  });
});

describe("resolveProductionOutputWarehouseId — input normalization", () => {
  it("treats undefined sources as missing", () => {
    const result = resolveProductionOutputWarehouseId({});
    expect(result.ok).toBe(false);
  });

  it("treats empty string as missing (does NOT promote to the operator source)", () => {
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: "",
      productWarehouseId: "PROD-WH-2",
    });
    expect(result).toEqual({
      ok: true,
      warehouseId: "PROD-WH-2",
      source: "product",
    });
  });

  it("treats whitespace-only string as missing", () => {
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: "   ",
      productWarehouseId: "PROD-WH-2",
    });
    expect(result).toEqual({
      ok: true,
      warehouseId: "PROD-WH-2",
      source: "product",
    });
  });

  it("trims surrounding whitespace before returning the value", () => {
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: "   OP-WH-1   ",
    });
    expect(result).toEqual({
      ok: true,
      warehouseId: "OP-WH-1",
      source: "operator",
    });
  });

  it("does NOT use env when operator typed a value (env is the fallback, never the override)", () => {
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: "OP-WH-1",
      envWarehouseId: "ENV-WH-4",
    });
    expect(result).toMatchObject({ source: "operator" });
  });
});

describe("BlueRaz scenario — can build payload when only app/product warehouse exists", () => {
  it("BlueRaz product gets its own warehouse ID via product override (env empty, no operator pick)", () => {
    // The actual blocker for #36 — env is empty, operator hasn't
    // typed anything yet. After v1.3.0 the product-level override
    // unblocks the preview.
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: null,
      productWarehouseId: "460000999000123",
      appSettingsWarehouseId: null,
      envWarehouseId: "",
    });
    expect(result).toEqual({
      ok: true,
      warehouseId: "460000999000123",
      source: "product",
    });
  });

  it("BlueRaz product also unblocks via app-settings default when product override is empty", () => {
    const result = resolveProductionOutputWarehouseId({
      operatorOverride: null,
      productWarehouseId: null,
      appSettingsWarehouseId: "460000999000456",
      envWarehouseId: "",
    });
    expect(result).toEqual({
      ok: true,
      warehouseId: "460000999000456",
      source: "appSettings",
    });
  });
});

describe("describeWarehouseSource — human-readable labels", () => {
  it("labels each source distinctly", () => {
    expect(describeWarehouseSource("operator")).toBe("Operator pick");
    expect(describeWarehouseSource("product")).toBe("Product default");
    expect(describeWarehouseSource("appSettings")).toBe(
      "Zoho settings default",
    );
    expect(describeWarehouseSource("env")).toBe("Environment fallback");
  });

  it("labels are not the empty string for any source", () => {
    const sources = ["operator", "product", "appSettings", "env"] as const;
    for (const s of sources) {
      const label = describeWarehouseSource(s);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
