import { describe, expect, it } from "vitest";
import {
  appendCommitTriggerToNotes,
  buildProductionOutputNotes,
  buildRawBagReceiveNotes,
  formatCommitTriggerLine,
  type CommitTrigger,
  type ProductionOutputNotesInput,
  type RawBagReceiveNotesInput,
  ZOHO_NOTES_MAX_LENGTH,
} from "./zoho-commit-notes";

// ─── Raw-bag receive notes ────────────────────────────────────────

const FULL_RAW_BAG: RawBagReceiveNotesInput = {
  lumaOperationId: "op-aaaa-1111-bbbb-2222-cccc-3333-dddd",
  lumaReceiveId: "receive-1",
  poNumber: "PO-1024",
  poLineReference: "PL-1024-3",
  receiptNumber: "R-0042",
  boxNumber: "B-7",
  bagNumber: 3,
  internalReceiptNumber: "INT-2026-0042",
  bagQrCode: "BAG-xyz-abc-123",
  tabletType: "FIX Relax 1ct",
  supplierLotNumber: "VL-2026-08",
  vendorBarcode: "8901234567890",
  receivedQuantity: 500,
  receiveDate: "2026-06-15",
};

describe("buildRawBagReceiveNotes — frozen body", () => {
  it("includes every priority-1 identifier — op id, receipt #, bag #, internal receipt #, qty", () => {
    const notes = buildRawBagReceiveNotes(FULL_RAW_BAG);
    expect(notes).toContain(FULL_RAW_BAG.lumaOperationId);
    expect(notes).toContain("R-0042");
    expect(notes).toContain("Bag #: 3");
    expect(notes).toContain("INT-2026-0042");
    expect(notes).toContain("Qty: 500");
  });

  it("leads with the Luma operation id (top priority for cross-system lookup)", () => {
    const firstLine = buildRawBagReceiveNotes(FULL_RAW_BAG).split("\n")[0]!;
    expect(firstLine).toMatch(/^Luma op:/);
    expect(firstLine).toContain(FULL_RAW_BAG.lumaOperationId);
  });

  it("does NOT include a Source line in the frozen body (that's appended at commit time)", () => {
    expect(buildRawBagReceiveNotes(FULL_RAW_BAG)).not.toMatch(/^Source:/m);
    expect(buildRawBagReceiveNotes(FULL_RAW_BAG)).not.toMatch(/Commit trigger:/);
  });

  it("includes secondary identifiers when supplied", () => {
    const notes = buildRawBagReceiveNotes(FULL_RAW_BAG);
    expect(notes).toContain("FIX Relax 1ct");
    expect(notes).toContain("PO-1024");
    expect(notes).toContain("VL-2026-08");
    expect(notes).toContain("BAG-xyz-abc-123");
  });

  it("omits missing fields cleanly (no 'field: —' filler)", () => {
    const sparse: RawBagReceiveNotesInput = {
      lumaOperationId: "op-1",
      receivedQuantity: 100,
      receiveDate: "2026-06-15",
    };
    const notes = buildRawBagReceiveNotes(sparse);
    expect(notes).not.toMatch(/^\s*\w+: —\s*$/m);
    expect(notes).not.toContain("null");
    expect(notes).not.toContain("undefined");
    expect(notes).toMatch(/Luma op:/);
    expect(notes).toMatch(/Qty: 100/);
  });

  it("trims and drops empty-string optional fields", () => {
    const notes = buildRawBagReceiveNotes({
      ...FULL_RAW_BAG,
      receiptNumber: "  ",
      supplierLotNumber: "",
    });
    expect(notes).not.toMatch(/Receipt #/);
    expect(notes).not.toMatch(/Supplier lot/);
  });

  it("is pure — same inputs always produce the same output (required for freezing)", () => {
    expect(buildRawBagReceiveNotes(FULL_RAW_BAG)).toBe(
      buildRawBagReceiveNotes(FULL_RAW_BAG),
    );
  });
});

describe("buildRawBagReceiveNotes — safe truncation", () => {
  it("default max length is the documented Zoho-safe limit", () => {
    expect(ZOHO_NOTES_MAX_LENGTH).toBe(2000);
  });

  it("drops lowest-priority fields when over budget, preserving priority-1", () => {
    const notes = buildRawBagReceiveNotes(FULL_RAW_BAG, { maxLength: 120 });
    expect(notes.length).toBeLessThanOrEqual(120);
    expect(notes).toContain(FULL_RAW_BAG.lumaOperationId);
    expect(notes).toMatch(/Receipt #|R-0042/);
    expect(notes).toMatch(/Qty: 500/);
    expect(notes).not.toContain("Vendor barcode");
    expect(notes).not.toContain("Bag QR");
  });

  it("never drops the operation id even if every other field has to go", () => {
    const notes = buildRawBagReceiveNotes(FULL_RAW_BAG, { maxLength: 80 });
    expect(notes).toContain(FULL_RAW_BAG.lumaOperationId);
  });
});

// ─── Production-output notes ──────────────────────────────────────

const FULL_PO: ProductionOutputNotesInput = {
  lumaOperationId: "op-pop-aaaa-bbbb-cccc",
  finishedLotId: "lot-uuid-1111-2222",
  finishedLotNumber: "LOT-2026-06-A",
  finishedLotTraceCode: "TRC-A-001",
  productName: "FIX Relax 1ct",
  productSku: "LUMA-fix-relax-1ct",
  productionDate: "2026-06-15",
  packedDate: "2026-06-15",
  casesProduced: 5,
  looseDisplaysProduced: 3,
  looseSinglesProduced: 7,
  unitsProduced: 1080 + 36 + 7,
  sourceBagSummaries: [
    "bag-uuid-1 · R-0042 · LOT-A",
    "bag-uuid-2 · R-0043 · LOT-A",
  ],
};

describe("buildProductionOutputNotes — frozen body", () => {
  it("includes every priority-1 identifier — op id, lot #, lot id, sku, units", () => {
    const notes = buildProductionOutputNotes(FULL_PO);
    expect(notes).toContain(FULL_PO.lumaOperationId);
    expect(notes).toContain("LOT-2026-06-A");
    expect(notes).toContain(FULL_PO.finishedLotId);
    expect(notes).toContain("LUMA-fix-relax-1ct");
    expect(notes).toContain("Units:");
  });

  it("leads with the Luma operation id", () => {
    const firstLine = buildProductionOutputNotes(FULL_PO).split("\n")[0]!;
    expect(firstLine).toMatch(/^Luma op:/);
    expect(firstLine).toContain(FULL_PO.lumaOperationId);
  });

  it("includes Cases / Displays / Singles breakdown", () => {
    expect(buildProductionOutputNotes(FULL_PO)).toContain(
      "Cases / Displays / Singles: 5 / 3 / 7",
    );
  });

  it("falls back to trace code when the lot number is missing", () => {
    expect(
      buildProductionOutputNotes({ ...FULL_PO, finishedLotNumber: null }),
    ).toContain("Lot #: TRC-A-001");
  });

  it("includes source bag summaries when supplied", () => {
    const notes = buildProductionOutputNotes(FULL_PO);
    expect(notes).toContain("bag-uuid-1 · R-0042 · LOT-A");
    expect(notes).toContain("bag-uuid-2 · R-0043 · LOT-A");
  });

  it("does NOT include a Source line in the frozen body", () => {
    expect(buildProductionOutputNotes(FULL_PO)).not.toMatch(/^Source:/m);
    expect(buildProductionOutputNotes(FULL_PO)).not.toMatch(/Commit trigger:/);
  });

  it("omits empty optional fields cleanly", () => {
    const sparse: ProductionOutputNotesInput = {
      lumaOperationId: "op-1",
      finishedLotId: "lot-1",
      unitsProduced: 100,
    };
    const notes = buildProductionOutputNotes(sparse);
    expect(notes).not.toContain("Cases / Displays / Singles:");
    expect(notes).not.toContain("Source bags");
    expect(notes).toContain("Luma op:");
    expect(notes).toContain("Units: 100");
  });
});

describe("buildProductionOutputNotes — safe truncation", () => {
  it("drops source bag list first (lowest priority)", () => {
    const notes = buildProductionOutputNotes(FULL_PO, { maxLength: 200 });
    expect(notes.length).toBeLessThanOrEqual(200);
    expect(notes).not.toContain("Source bags");
    expect(notes).toContain(FULL_PO.lumaOperationId);
    expect(notes).toContain("LUMA-fix-relax-1ct");
  });

  it("preserves priority-1 identifiers under any reasonable budget", () => {
    const notes = buildProductionOutputNotes(FULL_PO, { maxLength: 150 });
    expect(notes).toContain(FULL_PO.lumaOperationId);
    expect(notes).toContain(FULL_PO.finishedLotId);
    expect(notes).toMatch(/SKU:/);
    expect(notes).toMatch(/Units:/);
  });
});

// ─── Commit-trigger line ─────────────────────────────────────────

describe("formatCommitTriggerLine — one line, accurate to the trigger", () => {
  it("AUTO_COMMIT_AFTER_BUFFER renders the buffer message", () => {
    expect(formatCommitTriggerLine({ kind: "AUTO_COMMIT_AFTER_BUFFER" })).toBe(
      "Commit trigger: auto-commit after 24h buffer",
    );
  });

  it("MANUAL_COMMIT_NOW includes the actor when supplied", () => {
    expect(
      formatCommitTriggerLine({ kind: "MANUAL_COMMIT_NOW", actor: "lead@luma" }),
    ).toBe("Commit trigger: manual commit-now by lead@luma");
  });

  it("MANUAL_COMMIT_NOW omits the actor when missing", () => {
    expect(
      formatCommitTriggerLine({ kind: "MANUAL_COMMIT_NOW", actor: null }),
    ).toBe("Commit trigger: manual commit-now");
  });

  it("CRON_RETRY renders the retry message", () => {
    expect(formatCommitTriggerLine({ kind: "CRON_RETRY" })).toBe(
      "Commit trigger: cron retry",
    );
  });

  it("is always exactly one line — accounting can grep for it", () => {
    const triggers: CommitTrigger[] = [
      { kind: "AUTO_COMMIT_AFTER_BUFFER" },
      { kind: "MANUAL_COMMIT_NOW", actor: "lead@luma" },
      { kind: "MANUAL_COMMIT_NOW", actor: null },
      { kind: "CRON_RETRY" },
    ];
    for (const t of triggers) {
      expect(formatCommitTriggerLine(t)).not.toContain("\n");
    }
  });
});

// ─── Append commit-trigger to frozen notes ───────────────────────

describe("appendCommitTriggerToNotes", () => {
  const FROZEN = buildRawBagReceiveNotes(FULL_RAW_BAG);

  it("appends ONE line to the frozen body, separated by a newline", () => {
    const out = appendCommitTriggerToNotes(FROZEN, {
      kind: "MANUAL_COMMIT_NOW",
      actor: "lead@luma",
    });
    expect(out.startsWith(FROZEN)).toBe(true);
    expect(out).toMatch(/\nCommit trigger: manual commit-now by lead@luma$/);
  });

  it("works when the frozen body is empty (suffix only, no leading newline)", () => {
    const out = appendCommitTriggerToNotes("", { kind: "AUTO_COMMIT_AFTER_BUFFER" });
    expect(out).toBe("Commit trigger: auto-commit after 24h buffer");
  });

  it("never mutates the frozen body content (only appends)", () => {
    // Pin the bytes-after-append invariant: every character of the
    // frozen body appears in the same position in the combined output.
    const out = appendCommitTriggerToNotes(FROZEN, { kind: "CRON_RETRY" });
    expect(out.slice(0, FROZEN.length)).toBe(FROZEN);
  });

  it("preserves the commit-trigger suffix when length budget forces truncation", () => {
    // Body alone is ~250 chars; force a budget that requires trimming.
    const out = appendCommitTriggerToNotes(FROZEN, {
      kind: "MANUAL_COMMIT_NOW",
      actor: "lead@luma",
    }, { maxLength: 150 });
    expect(out.length).toBeLessThanOrEqual(150);
    expect(out).toMatch(/Commit trigger:/);
  });

  it("drops lower-priority body lines from the end to make room for the suffix", () => {
    // Budget large enough to preserve at least priority-1 + suffix
    // but small enough to force dropping lower-priority lines.
    const out = appendCommitTriggerToNotes(FROZEN, {
      kind: "AUTO_COMMIT_AFTER_BUFFER",
    }, { maxLength: 250 });
    expect(out.length).toBeLessThanOrEqual(250);
    // Priority-1 op id still present:
    expect(out).toContain(FULL_RAW_BAG.lumaOperationId);
    // Suffix present:
    expect(out).toMatch(/Commit trigger:/);
    // Lowest-priority body line gone:
    expect(out).not.toContain("Luma receive: receive-1");
  });

  it("if even priority-1 + suffix don't fit, the suffix STILL survives", () => {
    // Pathologically small budget — only the suffix should make it.
    const out = appendCommitTriggerToNotes(FROZEN, {
      kind: "AUTO_COMMIT_AFTER_BUFFER",
    }, { maxLength: 50 });
    expect(out).toMatch(/Commit trigger:/);
  });

  it("uses the default max length when none supplied", () => {
    const out = appendCommitTriggerToNotes(FROZEN, {
      kind: "AUTO_COMMIT_AFTER_BUFFER",
    });
    expect(out.length).toBeLessThanOrEqual(ZOHO_NOTES_MAX_LENGTH);
    expect(out).toMatch(/Commit trigger:/);
    expect(out).toContain(FULL_RAW_BAG.lumaOperationId);
  });
});

// ─── Manual vs auto: same frozen body, suffix differs ───────────

describe("manual and auto share the FROZEN body — only the suffix differs", () => {
  it("raw-bag: frozen body is byte-identical, suffix changes with trigger", () => {
    const frozen = buildRawBagReceiveNotes(FULL_RAW_BAG);
    const autoOut = appendCommitTriggerToNotes(frozen, {
      kind: "AUTO_COMMIT_AFTER_BUFFER",
    });
    const manualOut = appendCommitTriggerToNotes(frozen, {
      kind: "MANUAL_COMMIT_NOW",
      actor: "lead@luma",
    });
    // The first frozen.length chars are identical:
    expect(autoOut.slice(0, frozen.length)).toBe(frozen);
    expect(manualOut.slice(0, frozen.length)).toBe(frozen);
    // The suffix differs:
    expect(autoOut.slice(frozen.length)).toMatch(/auto-commit after 24h buffer$/);
    expect(manualOut.slice(frozen.length)).toMatch(
      /manual commit-now by lead@luma$/,
    );
  });

  it("production-output: same property", () => {
    const frozen = buildProductionOutputNotes(FULL_PO);
    const autoOut = appendCommitTriggerToNotes(frozen, {
      kind: "AUTO_COMMIT_AFTER_BUFFER",
    });
    const manualOut = appendCommitTriggerToNotes(frozen, {
      kind: "MANUAL_COMMIT_NOW",
      actor: "lead@luma",
    });
    expect(autoOut.slice(0, frozen.length)).toBe(frozen);
    expect(manualOut.slice(0, frozen.length)).toBe(frozen);
  });
});
