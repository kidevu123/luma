// PT-7D — pure tests for the in-memory filterRecommendations helper.
//
// The loader's only non-stubbable surface is the SQL fetch; everything
// else is the same helper exercised here. Coverage: each filter axis
// (status, severity, confidence, sendable, missing-config, product,
// material) plus interactions (dismissed hidden by default; acknowledged
// rows still visible).

import { describe, expect, it } from "vitest";
import {
  filterRecommendations,
  countRecommendations,
  type RecommendationRow,
} from "@/lib/production/material-recommendations-filter";
import type {
  ShortageConfidence,
  ShortageSeverity,
} from "@/lib/production/packtrack-shortage";

function row(over: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    id: over.id ?? "id-1",
    recommendationId: over.recommendationId ?? "rec-1",
    materialId: over.materialId ?? "mat-1",
    materialCode: over.materialCode ?? "LBL-001",
    materialName: over.materialName ?? "Bottle Label 30mL",
    productId: over.productId ?? null,
    productName: over.productName ?? null,
    productSku: over.productSku ?? null,
    compatibilityRole: over.compatibilityRole ?? null,
    currentOnHand: over.currentOnHand ?? 0,
    acceptedInventory: over.acceptedInventory ?? 0,
    projectedDemand: over.projectedDemand ?? 350,
    projectedShortageQuantity: over.projectedShortageQuantity ?? 350,
    recommendedOrderQuantity: over.recommendedOrderQuantity ?? 420,
    neededByDate: over.neededByDate ?? "2026-05-20",
    confidence: (over.confidence ?? "HIGH") as ShortageConfidence,
    severity: (over.severity ?? "CRITICAL") as ShortageSeverity,
    reason: over.reason ?? "Reason",
    sourceSignals: over.sourceSignals ?? [],
    missingInputs: over.missingInputs ?? [],
    warnings: over.warnings ?? [],
    sendableToPackTrack: over.sendableToPackTrack ?? true,
    generatedAt: over.generatedAt ?? new Date("2026-05-13T10:00:00Z"),
    expiresAt: over.expiresAt ?? new Date("2026-05-14T10:00:00Z"),
    acknowledgedAt: over.acknowledgedAt ?? null,
    dismissedAt: over.dismissedAt ?? null,
    recommendedSupplierHint: over.recommendedSupplierHint ?? null,
  };
}

describe("filterRecommendations — status axis", () => {
  it("ACTIVE excludes dismissed rows by default", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", dismissedAt: new Date() }),
      row({ id: "c", acknowledgedAt: new Date() }),
    ];
    const out = filterRecommendations(rows, { status: "ACTIVE" });
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("ACTIVE is the default when no status is passed", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", dismissedAt: new Date() }),
    ];
    const out = filterRecommendations(rows, {});
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("ACKNOWLEDGED returns only acknowledged rows", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", acknowledgedAt: new Date() }),
      row({ id: "c", dismissedAt: new Date() }),
    ];
    const out = filterRecommendations(rows, { status: "ACKNOWLEDGED" });
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });

  it("DISMISSED returns only dismissed rows", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", dismissedAt: new Date() }),
      row({ id: "c", acknowledgedAt: new Date() }),
    ];
    const out = filterRecommendations(rows, { status: "DISMISSED" });
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });

  it("ALL returns everything including dismissed and acknowledged", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", dismissedAt: new Date() }),
      row({ id: "c", acknowledgedAt: new Date() }),
    ];
    const out = filterRecommendations(rows, { status: "ALL" });
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("filterRecommendations — severity / confidence", () => {
  it("severity filter narrows to selected severities only", () => {
    const rows = [
      row({ id: "a", severity: "CRITICAL" }),
      row({ id: "b", severity: "MEDIUM" }),
      row({ id: "c", severity: "WATCH" }),
    ];
    const out = filterRecommendations(rows, {
      severity: ["CRITICAL", "MEDIUM"],
    });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("confidence filter narrows to selected confidence bands", () => {
    const rows = [
      row({ id: "a", confidence: "HIGH" }),
      row({ id: "b", confidence: "MEDIUM" }),
      row({ id: "c", confidence: "MISSING" }),
    ];
    const out = filterRecommendations(rows, { confidence: ["MISSING"] });
    expect(out.map((r) => r.id)).toEqual(["c"]);
  });

  it("empty severity array is treated as no filter", () => {
    const rows = [row({ id: "a" }), row({ id: "b", severity: "WATCH" })];
    const out = filterRecommendations(rows, { severity: [] });
    expect(out).toHaveLength(2);
  });
});

describe("filterRecommendations — sendable / missing-config flags", () => {
  it("sendableOnly excludes sendable_to_packtrack=false rows", () => {
    const rows = [
      row({ id: "a", sendableToPackTrack: true }),
      row({ id: "b", sendableToPackTrack: false }),
    ];
    const out = filterRecommendations(rows, { sendableOnly: true });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("missingConfigOnly requires non-empty missingInputs[]", () => {
    const rows = [
      row({ id: "a", missingInputs: [] }),
      row({ id: "b", missingInputs: ["materialCode"] }),
    ];
    const out = filterRecommendations(rows, { missingConfigOnly: true });
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("filterRecommendations — product / material scopes", () => {
  it("productId=MATERIAL_WIDE keeps only material-wide (product_id null) rows", () => {
    const rows = [
      row({ id: "a", productId: null }),
      row({ id: "b", productId: "prod-1", productName: "Foo" }),
    ];
    const out = filterRecommendations(rows, { productId: "MATERIAL_WIDE" });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("productId='<uuid>' keeps only that product's rows", () => {
    const rows = [
      row({ id: "a", productId: null }),
      row({ id: "b", productId: "prod-1" }),
      row({ id: "c", productId: "prod-2" }),
    ];
    const out = filterRecommendations(rows, { productId: "prod-1" });
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });

  it("materialId narrows to one material", () => {
    const rows = [
      row({ id: "a", materialId: "mat-1" }),
      row({ id: "b", materialId: "mat-2" }),
    ];
    const out = filterRecommendations(rows, { materialId: "mat-2" });
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("filterRecommendations — combined filters", () => {
  it("acknowledged rows remain visible under ACTIVE status (so the user sees what they've already acted on)", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", acknowledgedAt: new Date("2026-05-12") }),
      row({ id: "c", dismissedAt: new Date("2026-05-12") }),
    ];
    const out = filterRecommendations(rows, { status: "ACTIVE" });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("MISSING-confidence row stays in result set under no sendable filter", () => {
    const rows = [
      row({
        id: "a",
        confidence: "MISSING",
        sendableToPackTrack: false,
      }),
    ];
    expect(filterRecommendations(rows, {}).map((r) => r.id)).toEqual(["a"]);
  });

  it("MISSING-confidence row is excluded under sendableOnly=true", () => {
    const rows = [
      row({
        id: "a",
        confidence: "MISSING",
        sendableToPackTrack: false,
      }),
    ];
    expect(
      filterRecommendations(rows, { sendableOnly: true }).map((r) => r.id),
    ).toEqual([]);
  });
});

describe("countRecommendations", () => {
  it("breaks the row set down by status / sendable / missing / severity", () => {
    const rows = [
      row({ id: "a", severity: "CRITICAL" }),
      row({
        id: "b",
        severity: "HIGH",
        acknowledgedAt: new Date(),
      }),
      row({
        id: "c",
        severity: "MEDIUM",
        sendableToPackTrack: false,
        missingInputs: ["materialCode"],
        confidence: "MISSING",
      }),
      row({
        id: "d",
        severity: "WATCH",
        dismissedAt: new Date(),
      }),
    ];
    const c = countRecommendations(rows);
    expect(c.active).toBe(3);
    expect(c.acknowledged).toBe(1);
    expect(c.dismissed).toBe(1);
    expect(c.sendable).toBe(2);
    expect(c.missingConfig).toBe(1);
    expect(c.bySeverity).toEqual({
      CRITICAL: 1,
      HIGH: 1,
      MEDIUM: 1,
      WATCH: 0, // dismissed → excluded from active by-severity tally
    });
  });
});
