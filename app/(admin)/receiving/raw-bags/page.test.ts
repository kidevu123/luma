import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const formSrc = readFileSync(
  join(__dirname, "raw-bag-intake-form.tsx"),
  "utf8",
);
const panelSrc = readFileSync(
  join(__dirname, "../../../../components/admin/raw-bag-zoho-receive-panel.tsx"),
  "utf8",
);
const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");

describe("RAW-BAGS-READINESS-BADGES-1 · intake form wiring", () => {
  it("reuses evaluateRawBagIntakeDraftReadiness — no inline BLOCKED_ rules in JSX", () => {
    expect(formSrc).toMatch(/evaluateRawBagIntakeDraftReadiness/);
    expect(formSrc).not.toMatch(/BLOCKED_MISSING_RECEIPT/);
    expect(formSrc).toMatch(/FloorReadinessCell/);
  });

  it("shows Ready for floor column on bag rows", () => {
    expect(formSrc).toMatch(/Ready for floor/);
    expect(formSrc).toMatch(/evaluateRawBagIntakeDraftReadiness\(\{/);
  });

  it("lookup attaches server readiness evaluation", () => {
    expect(actionsSrc).toMatch(/loadReceiveBagReadinessEvaluations/);
    expect(actionsSrc).toMatch(/readiness/);
    expect(formSrc).toMatch(/result\.readiness/);
  });

  it("save result loads per-bag readiness from server", () => {
    expect(formSrc).toMatch(/loadIntakeBagReadinessAction/);
    expect(formSrc).toMatch(/Ready for floor — per bag/);
  });

  it("does not add product reassignment or floor scan changes", () => {
    expect(formSrc).not.toMatch(/saveSealingProductAction/);
    expect(actionsSrc).not.toMatch(/scanCardAction/);
    expect(actionsSrc).not.toMatch(/fireStageEventAction/);
  });

  it("wires Zoho receive panel on save and lookup", () => {
    expect(formSrc).toMatch(/RawBagZohoReceivePanel/);
    expect(formSrc).toMatch(/Zoho purchase receive — per physical bag/);
    expect(actionsSrc).toMatch(/previewRawBagZohoReceiveAction/);
    expect(actionsSrc).toMatch(/requireAdmin\(\)/);
    expect(actionsSrc).toMatch(/confirmHistoricalZohoReceiveAction/);
    expect(actionsSrc).toMatch(/verifyHistoricalZohoReceiveAction/);
    expect(formSrc).toMatch(/IntakeReceiveZohoSummaryBanner/);
    expect(panelSrc).toMatch(/Luma receipt/);
    expect(panelSrc).toMatch(/Zoho purchase receive ID/);
  });
});
