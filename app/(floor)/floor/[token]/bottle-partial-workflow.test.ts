// P2-PARTIAL-KEEP v1.10 — bottle partial-bag workflow completeness.
// Source-structural assertions (the floor/admin surfaces are server/DB-bound
// and the default vitest run has no Postgres harness; see vitest.config.ts).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) =>
  readFileSync(join(__dirname, "..", "..", "..", "..", p), "utf8");

// P4b Task 5 (THE CUTOVER) — stage-action-buttons.tsx and
// scan-card-form.tsx are DELETED. The two describe blocks that scanned
// their copy went with them; what those blocks protected is preserved
// elsewhere:
//   - the explicit empty-vs-partial close-out choice is now
//     AdvanceInput.keepBagPartial / partialRemainingEstimate, carried by
//     buildRecordPackagingCompleteInput (lib/production/engine/
//     advance.test.ts) and refused-by-default there rather than by a
//     radio group;
//   - the operator-estimate-vs-system-remaining distinction it asserted
//     in the scan form survives in partial-bags.ts, which the third test
//     of that block already covered and which is KEPT below.
// P6 Task 4 — packagingCompleteAction retired (thin forwarder with zero
// non-test callers post P4b). Deferred-QR / empty-vs-partial audit
// scanners below now read the engine source (record-packaging-complete.ts)
// DIRECTLY instead of splicing it back into actions.ts.
const engineSrc = readFileSync(
  join(
    __dirname,
    "../../../../lib/production/engine/record-packaging-complete.ts",
  ),
  "utf8",
);
const partialBagsSrc = repo("lib/production/partial-bags.ts");
const qrListSrc = repo("app/(admin)/qr-cards/qr-cards-list.tsx");

describe("Partial reuse context still separates operator estimate from system remaining", () => {
  it("partial reuse context carries the operator estimate + product kind", () => {
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

describe("Empty/release path writes a clear audit reason (engine)", () => {
  it("releasing an empty bottle bag audits the reason distinctly from keep-partial", () => {
    expect(engineSrc).toMatch(/floor\.bag_qr_released_empty/);
    expect(engineSrc).toMatch(/reason: "bag_confirmed_empty"/);
    // Held path keeps its own audit.
    expect(engineSrc).toMatch(/floor\.bag_kept_partial/);
  });

  it("release still only happens when confirmed empty (no regression)", () => {
    expect(engineSrc).toMatch(/shouldReleaseQrAfterPackagingClose/);
    expect(engineSrc).toMatch(/status: "IDLE", assignedWorkflowBagId: null/);
  });
});
