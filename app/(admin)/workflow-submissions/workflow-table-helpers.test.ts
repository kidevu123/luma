import { describe, it, expect } from "vitest";
import {
  coerceEventCount,
  formatWorkflowDatetime,
  formatWorkflowTimestamp,
  getPayloadRecord,
} from "./workflow-table-helpers";

/** Bag Card 117 — finalized workflow with full event history (live snapshot). */
const BAG_117_ROW = {
  id: "35902ff1-6e9e-4547-8893-a11f640a3263",
  receiptNumber: null,
  bagNumber: 117,
  startedAt: "2026-05-28T12:00:00.000Z",
  finalizedAt: "2026-05-28T18:57:00.000Z",
  productName: "Test Product",
  productSku: "SKU-117",
  productKind: "CARD",
  stage: "FINALIZED",
  isFinalized: true,
  isPaused: false,
  operatorCode: "1234",
  lastEventAt: "2026-05-28T18:57:00.000Z",
  masterCases: 2,
  displaysMade: 14,
  looseCards: 0,
  damagedPackaging: 0,
  rippedCards: 0,
  unitsYielded: 1280,
  inputPillCount: null,
  activeSeconds: 3600,
  blisterSeconds: 900,
  sealingSeconds: 1200,
  packagingSeconds: 600,
  eventCount: 14,
} as const;

const BAG_117_SEALING_PAYLOAD = {
  counter_presses: 303,
  cards_per_press: 6,
  count_total: 1818,
};

describe("WORKFLOW-DATA-VISIBILITY-1 · RSC date serialization", () => {
  it("formatWorkflowDatetime accepts ISO strings from the server boundary", () => {
    expect(formatWorkflowDatetime(BAG_117_ROW.startedAt)).toBe("2026-05-28 12:00");
    expect(formatWorkflowDatetime(new Date(BAG_117_ROW.startedAt))).toBe("2026-05-28 12:00");
  });

  it("formatWorkflowTimestamp accepts ISO strings for genealogy events", () => {
    const occurredAt = "2026-05-28T18:41:00.141Z";
    expect(formatWorkflowTimestamp(occurredAt)).toBe("2026-05-28 18:41:00");
  });

  it("does not throw when formatting serialized finalized-bag dates", () => {
    expect(() => formatWorkflowDatetime(BAG_117_ROW.finalizedAt)).not.toThrow();
    expect(formatWorkflowDatetime(BAG_117_ROW.finalizedAt)).toMatch(/^2026-05-28/);
  });
});

describe("WORKFLOW-DATA-VISIBILITY-1 · postgres count coercion", () => {
  it("coerces string event counts from SQL count()", () => {
    expect(coerceEventCount("14")).toBe(14);
    expect(coerceEventCount(14n)).toBe(14);
  });
});

describe("WORKFLOW-DATA-VISIBILITY-1 · optional payload fields", () => {
  it("returns empty object for null or non-object payloads", () => {
    expect(getPayloadRecord(null)).toEqual({});
    expect(getPayloadRecord(undefined)).toEqual({});
    expect(getPayloadRecord([])).toEqual({});
  });

  it("reads sealing counter fields from Bag 117-style payload", () => {
    const p = getPayloadRecord(BAG_117_SEALING_PAYLOAD);
    expect(p["counter_presses"]).toBe(303);
    expect(p["count_total"]).toBe(1818);
  });
});

describe("WORKFLOW-DATA-VISIBILITY-1 · empty state inputs", () => {
  it("handles missing optional timestamps", () => {
    expect(formatWorkflowDatetime(null)).toBe("—");
    expect(formatWorkflowDatetime(undefined)).toBe("—");
  });

  it("finalized bag row shape uses serializable primitives only", () => {
    expect(typeof BAG_117_ROW.startedAt).toBe("string");
    expect(typeof BAG_117_ROW.eventCount).toBe("number");
    expect(BAG_117_ROW.isFinalized).toBe(true);
  });
});
