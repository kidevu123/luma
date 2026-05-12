// QC-3 — pure tests for the floor QC quick-action panel.

import { describe, expect, it } from "vitest";
import {
  QC_PANEL_STATION_KINDS,
  QUICK_DAMAGE_ENTRIES,
  damageHasReworkShortcut,
  defaultUnitForStation,
  reasonCodeForQuickType,
  reasonRequiresNotes,
  shouldRenderQcPanel,
} from "./qc-panel-helpers";
import { QC_REASON_CODES } from "./qc-events";

describe("shouldRenderQcPanel", () => {
  it("returns true for packaging stations (primary QC surface)", () => {
    expect(shouldRenderQcPanel("PACKAGING")).toBe(true);
  });
  it("returns true for sealing stations (rework receiving)", () => {
    expect(shouldRenderQcPanel("SEALING")).toBe(true);
  });
  it("returns true for combined stations (blister+sealing in one)", () => {
    expect(shouldRenderQcPanel("COMBINED")).toBe(true);
  });
  it("returns false for blister-only stations (no QC events surfaced today)", () => {
    expect(shouldRenderQcPanel("BLISTER")).toBe(false);
  });
  it("returns false for the bottle stations (out of QC-3 scope)", () => {
    expect(shouldRenderQcPanel("BOTTLE_HANDPACK")).toBe(false);
    expect(shouldRenderQcPanel("BOTTLE_CAP_SEAL")).toBe(false);
    expect(shouldRenderQcPanel("BOTTLE_STICKER")).toBe(false);
  });
  it("returns false for null / undefined / unknown station kinds", () => {
    expect(shouldRenderQcPanel(null)).toBe(false);
    expect(shouldRenderQcPanel(undefined)).toBe(false);
    expect(shouldRenderQcPanel("MADE_UP")).toBe(false);
  });
});

describe("QUICK_DAMAGE_ENTRIES", () => {
  it("ships exactly five quick-action damage entries", () => {
    expect(QUICK_DAMAGE_ENTRIES).toHaveLength(5);
  });

  it("every entry's reasonCode is a real QC_REASON_CODES value", () => {
    for (const e of QUICK_DAMAGE_ENTRIES) {
      expect(QC_REASON_CODES as ReadonlyArray<string>).toContain(e.reasonCode);
    }
  });

  it("entry types and reason codes are 1:1 — no duplicates", () => {
    const types = new Set(QUICK_DAMAGE_ENTRIES.map((e) => e.type));
    const reasons = new Set(QUICK_DAMAGE_ENTRIES.map((e) => e.reasonCode));
    expect(types.size).toBe(QUICK_DAMAGE_ENTRIES.length);
    expect(reasons.size).toBe(QUICK_DAMAGE_ENTRIES.length);
  });

  it("does NOT include OTHER in the quick-action list (OTHER requires notes; routes through the open Other form)", () => {
    for (const e of QUICK_DAMAGE_ENTRIES) {
      expect(e.reasonCode).not.toBe("OTHER");
    }
  });
});

describe("reasonCodeForQuickType", () => {
  it("maps each quick type to its reason code", () => {
    expect(reasonCodeForQuickType("DAMAGED_PACKAGING")).toBe("DAMAGED_PACKAGING");
    expect(reasonCodeForQuickType("RIPPED_CARD")).toBe("RIPPED_CARD");
    expect(reasonCodeForQuickType("BAD_SEAL")).toBe("BAD_SEAL");
    expect(reasonCodeForQuickType("LABEL_ISSUE")).toBe("LABEL_ISSUE");
    expect(reasonCodeForQuickType("COUNT_VARIANCE")).toBe("COUNT_VARIANCE");
  });
});

describe("defaultUnitForStation", () => {
  it("packaging stations default to cards", () => {
    expect(defaultUnitForStation("PACKAGING")).toBe("cards");
    expect(defaultUnitForStation("SEALING")).toBe("cards");
    expect(defaultUnitForStation("COMBINED")).toBe("cards");
  });
});

describe("reasonRequiresNotes", () => {
  it("only OTHER requires notes (mirrors qc-events.ts superRefine)", () => {
    expect(reasonRequiresNotes("OTHER")).toBe(true);
    expect(reasonRequiresNotes("BAD_SEAL")).toBe(false);
    expect(reasonRequiresNotes("DAMAGED_PACKAGING")).toBe(false);
  });
});

describe("damageHasReworkShortcut", () => {
  it("only BAD_SEAL surfaces the Send-to-rework shortcut", () => {
    expect(damageHasReworkShortcut("BAD_SEAL")).toBe(true);
    expect(damageHasReworkShortcut("DAMAGED_PACKAGING")).toBe(false);
    expect(damageHasReworkShortcut("RIPPED_CARD")).toBe(false);
    expect(damageHasReworkShortcut("LABEL_ISSUE")).toBe(false);
    expect(damageHasReworkShortcut("COUNT_VARIANCE")).toBe(false);
  });
});

describe("QC_PANEL_STATION_KINDS metadata", () => {
  it("includes packaging + sealing + combined", () => {
    expect([...QC_PANEL_STATION_KINDS]).toEqual(["PACKAGING", "SEALING", "COMBINED"]);
  });
});
