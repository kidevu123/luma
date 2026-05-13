// PT-7E — pure tests for deriveSendBlockReason (the UI's
// disabled-button gate). Imported from the panel as a named export so
// the action-side and the UI-side stay in agreement about what blocks
// a send.

import { describe, expect, it } from "vitest";
import { deriveSendBlockReason } from "./_recommendations-panel";
import type { RecommendationRow } from "@/lib/production/material-recommendations-filter";
import type {
  ShortageConfidence,
  ShortageSeverity,
} from "@/lib/production/packtrack-shortage";

function row(over: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    id: "id-1",
    recommendationId: "rec-1",
    materialId: "mat-1",
    materialCode: "LBL-001",
    materialName: "Bottle Label 30mL",
    productId: null,
    productName: null,
    productSku: null,
    compatibilityRole: null,
    currentOnHand: 0,
    acceptedInventory: 0,
    projectedDemand: 350,
    projectedShortageQuantity: 350,
    recommendedOrderQuantity: 420,
    neededByDate: "2026-05-20",
    confidence: "HIGH" as ShortageConfidence,
    severity: "CRITICAL" as ShortageSeverity,
    reason: "Runs out",
    sourceSignals: [],
    missingInputs: [],
    warnings: [],
    sendableToPackTrack: true,
    generatedAt: new Date("2026-05-13T10:00:00Z"),
    expiresAt: null,
    acknowledgedAt: new Date("2026-05-13T09:00:00Z"),
    dismissedAt: null,
    recommendedSupplierHint: null,
    sentAt: null,
    lastSentResponse: null,
    lastSendError: null,
    ...over,
  };
}

describe("deriveSendBlockReason", () => {
  it("returns null when the row is ready to send and config is present", () => {
    expect(deriveSendBlockReason(row(), true)).toBeNull();
  });

  it("blocks with 'PackTrack handoff not configured' when config is missing (priority over other reasons)", () => {
    expect(deriveSendBlockReason(row(), false)).toBe(
      "PackTrack handoff not configured",
    );
    // Even when the row has other issues, the missing-config reason
    // wins because the operator can't act on anything else first.
    expect(
      deriveSendBlockReason(
        row({ acknowledgedAt: null, sendableToPackTrack: false }),
        false,
      ),
    ).toBe("PackTrack handoff not configured");
  });

  it("blocks 'Dismissed' rows", () => {
    expect(
      deriveSendBlockReason(row({ dismissedAt: new Date() }), true),
    ).toBe("Dismissed");
  });

  it("blocks 'Not acknowledged' rows", () => {
    expect(
      deriveSendBlockReason(row({ acknowledgedAt: null }), true),
    ).toBe("Not acknowledged");
  });

  it("blocks 'Not sendable' rows", () => {
    expect(
      deriveSendBlockReason(row({ sendableToPackTrack: false }), true),
    ).toBe("Not sendable");
  });

  it("blocks 'Missing configuration' for MISSING confidence", () => {
    expect(
      deriveSendBlockReason(
        row({ confidence: "MISSING", sendableToPackTrack: true }),
        true,
      ),
    ).toBe("Missing configuration");
  });

  it("blocks zero / null recommended quantity", () => {
    expect(
      deriveSendBlockReason(row({ recommendedOrderQuantity: 0 }), true),
    ).toBe("No recommended quantity");
    expect(
      deriveSendBlockReason(row({ recommendedOrderQuantity: null }), true),
    ).toBe("No recommended quantity");
  });
});
