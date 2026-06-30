// P2-PARTIAL-KEEP v1.10 — bottle partial-bag workflow completeness.
// Source-structural assertions (the floor/admin surfaces are server/DB-bound
// and the default vitest run has no Postgres harness; see vitest.config.ts).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) =>
  readFileSync(join(__dirname, "..", "..", "..", "..", p), "utf8");

const stageButtonsSrc = readFileSync(
  join(__dirname, "stage-action-buttons.tsx"),
  "utf8",
);
const scanFormSrc = readFileSync(join(__dirname, "scan-card-form.tsx"), "utf8");
const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");
const partialBagsSrc = repo("lib/production/partial-bags.ts");
const qrListSrc = repo("app/(admin)/qr-cards/qr-cards-list.tsx");

describe("Floor close-out forces an explicit empty-vs-partial choice", () => {
  it("offers both outcomes with clear copy", () => {
    expect(stageButtonsSrc).toMatch(/Bag is empty — release QR/);
    expect(stageButtonsSrc).toMatch(/Bag still has product — keep QR with this bag/);
    // Radio group (a real either/or), not a single ambiguous checkbox.
    expect(stageButtonsSrc).toMatch(/name="bottle-bag-outcome"/);
    expect(stageButtonsSrc).toMatch(/bottlePartialChoice/);
  });

  it("does not let the run close until the bottle outcome is chosen", () => {
    expect(stageButtonsSrc).toMatch(/bottleChoiceMissing/);
    expect(stageButtonsSrc).toMatch(/disabled=\{pending \|\| bottleChoiceMissing\}/);
    expect(stageButtonsSrc).toMatch(/closing the run does not assume\s*\n?\s*the bag is empty/);
  });

  it("ties keep-partial to the choice and still submits keepBagPartial", () => {
    expect(stageButtonsSrc).toMatch(
      /const keepBagPartial = bottlePartialChoice === "partial"/,
    );
    expect(stageButtonsSrc).toMatch(/fd\.set\("keepBagPartial", "true"\)/);
    // Optional estimate still safely coerced (v1.9.1 regression preserved).
    expect(stageButtonsSrc).toMatch(/coercePartialRemainingEstimate/);
  });
});

describe("Scan/resume shows a held partial bottle bag clearly", () => {
  it("bottle-aware header + 'QR stays on the physical bag' reuse guidance", () => {
    expect(scanFormSrc).toMatch(/Partial bottle bag held for reuse/);
    expect(scanFormSrc).toMatch(/still attached to a physical bag/i);
    expect(scanFormSrc).toMatch(/different product than last time/i);
    expect(scanFormSrc).toMatch(/Continue with this partial bag/);
  });

  it("shows system remaining and operator estimate as distinct rows", () => {
    expect(scanFormSrc).toMatch(/System remaining/);
    expect(scanFormSrc).toMatch(/Operator estimate/);
    expect(scanFormSrc).toMatch(/operatorRemainingEstimate/);
    expect(scanFormSrc).toMatch(/previousProductKind/);
  });

  it("partial reuse context now carries the operator estimate + product kind", () => {
    expect(partialBagsSrc).toMatch(/operatorRemainingEstimate: number \| null/);
    expect(partialBagsSrc).toMatch(/previousProductKind: string \| null/);
    // Read from the latest BAG_FINALIZED via the dedicated helper.
    expect(partialBagsSrc).toMatch(/bottleFinalizePayloadRemainingEstimate/);
    expect(partialBagsSrc).toMatch(/eventType, "BAG_FINALIZED"/);
  });
});

describe("Admin needs-review signal on QR-cards list", () => {
  it("renders a 'Needs review' chip driven by derivePartialBagAttention", () => {
    expect(qrListSrc).toMatch(/derivePartialBagAttention/);
    expect(qrListSrc).toMatch(/Needs review/);
    expect(qrListSrc).toMatch(/attention\.needsReview/);
  });
});

describe("Empty/release path writes a clear audit reason", () => {
  it("releasing an empty bottle bag audits the reason distinctly from keep-partial", () => {
    expect(actionsSrc).toMatch(/floor\.bag_qr_released_empty/);
    expect(actionsSrc).toMatch(/reason: "bag_confirmed_empty"/);
    // Held path keeps its own audit.
    expect(actionsSrc).toMatch(/floor\.bag_kept_partial/);
  });

  it("release still only happens when confirmed empty (no regression)", () => {
    expect(actionsSrc).toMatch(/shouldReleaseQrAfterPackagingClose/);
    expect(actionsSrc).toMatch(/status: "IDLE", assignedWorkflowBagId: null/);
  });
});
