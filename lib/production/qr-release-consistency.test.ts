// P2-PARTIAL-KEEP v1.10.1 — QR release consistency + held-finalized visibility.
// Source-structural assertions (these paths are DB-bound; the default vitest
// run has no Postgres harness — see vitest.config.ts).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const closeActionsSrc = repo("app/(floor)/floor/[token]/bag-allocation-actions.ts");
const adminCorrectionsSrc = repo("lib/production/partial-bag-admin-corrections.ts");
const lifecycleSrc = repo("lib/production/raw-bag-allocation-lifecycle.ts");
const packagingActionsSrc = repo("app/(floor)/floor/[token]/actions.ts");
const partialBagsSrc = repo("lib/production/partial-bags.ts");
const partialPageSrc = repo("app/(admin)/partial-bags/page.tsx");

const RAW_BAG_RELEASE_FILES: Array<[string, string]> = [
  ["bag-allocation-actions.ts", closeActionsSrc],
  ["partial-bag-admin-corrections.ts", adminCorrectionsSrc],
  ["raw-bag-allocation-lifecycle.ts", lifecycleSrc],
];

describe("QR release consistency — releasing a RAW_BAG QR clears assignedWorkflowBagId", () => {
  for (const [name, src] of RAW_BAG_RELEASE_FILES) {
    it(`${name}: no bare 'status: IDLE' release that leaves assignedWorkflowBagId set`, () => {
      // The old inconsistency: .set({ status: "IDLE" }) on a qr card.
      expect(src).not.toMatch(/\.set\(\{\s*status:\s*"IDLE"\s*\}\)/);
      // Every IDLE release now also nulls the assignment.
      expect(src).toMatch(
        /status:\s*"IDLE",\s*assignedWorkflowBagId:\s*null/,
      );
    });

    it(`${name}: release is still gated on a confirmed-empty / depleted state`, () => {
      // EMPTIED guard (close + lifecycle helper + admin correction) or the
      // markBagDepleted action which sets DEPLETED + EMPTIED.
      expect(src).toMatch(/EMPTIED|DEPLETED/);
    });
  }

  it("held-partial packaging path holds the QR (releases ONLY inside the confirmed-empty branch)", () => {
    const i = packagingActionsSrc.indexOf(
      "function resolveDeferredQrReleaseAfterPackaging",
    );
    const block = packagingActionsSrc.slice(i, i + 2400);
    // The only IDLE release is inside the `if (release)` branch; the held
    // branch writes an audit and never touches the card.
    expect(block).toMatch(/if \(release\)\s*\{[\s\S]*status: "IDLE", assignedWorkflowBagId: null/);
    expect(block).toMatch(/floor\.bag_kept_partial/);
    // The kept-partial (held) audit must NOT be followed by an IDLE update.
    const heldIdx = block.indexOf("floor.bag_kept_partial");
    expect(block.slice(heldIdx)).not.toMatch(/status: "IDLE"/);
  });
});

describe("Partial-bags workbench surfaces finalized held partial bottle bags", () => {
  it("loader keys off the QR card (ASSIGNED) + finalized BOTTLE bag, with scalar subselects", () => {
    expect(partialBagsSrc).toMatch(/loadHeldFinalizedPartialBottleBags/);
    expect(partialBagsSrc).toMatch(/eq\(qrCards\.status, "ASSIGNED"\)/);
    expect(partialBagsSrc).toMatch(/eq\(readBagState\.isFinalized, true\)/);
    expect(partialBagsSrc).toMatch(/eq\(products\.kind, "BOTTLE"\)/);
    // System remaining + operator estimate via scalar subselects (no fan-out).
    expect(partialBagsSrc).toMatch(/systemRemainingQty: sql/);
    expect(partialBagsSrc).toMatch(/operatorRemainingEstimate: sql/);
    expect(partialBagsSrc).toMatch(/operator_remaining_estimate' ~ '\^\[0-9\]\+\$'/);
  });

  it("page renders the held-finalized section with a needs-review signal", () => {
    expect(partialPageSrc).toMatch(/loadHeldFinalizedPartialBottleBags/);
    expect(partialPageSrc).toMatch(/Held finalized partial bottle bags/);
    expect(partialPageSrc).toMatch(/derivePartialBagAttention/);
    expect(partialPageSrc).toMatch(/System remaining/);
    expect(partialPageSrc).toMatch(/Operator est\./);
    // Healthy held partials are not alarmed.
    expect(partialPageSrc).toMatch(/Held · reusable/);
  });
});
