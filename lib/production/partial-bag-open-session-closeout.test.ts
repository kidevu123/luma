// SPLIT-BAG-2 — the Partial Bag Workbench no longer dead-ends when a bag still
// has an OPEN allocation session. Manual "Correct remaining" now closes that
// open session in place (physical count / weigh-back / supervisor estimate),
// alongside the v1.12.0 calculated path and the existing mark-depleted path.
//
// No Postgres harness in the default vitest run (see vitest.config.ts), so the
// DB write path is asserted structurally + by the sibling in-place patterns it
// mirrors (mark-depleted / void already close open sessions this way).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const correctionsSrc = repo("lib/production/partial-bag-admin-corrections.ts");
const reviewSrc = repo("lib/production/partial-bag-review-closeout.ts");
const pageSrc = repo("app/(admin)/partial-bags/page.tsx");
const actionsSrc = repo("app/(admin)/partial-bags/actions.ts");

describe("correctPartialBagRemaining — closes an OPEN session instead of dead-ending", () => {
  it("no longer tells the admin to close it at the floor", () => {
    expect(correctionsSrc).not.toMatch(/close it at the floor/i);
  });

  it("branches on an open session and closes it in place with the manual value", () => {
    // Loads the open session and, when present, updates it (does not just
    // create a disconnected correction session and leave the open one dangling).
    expect(correctionsSrc).toMatch(/const open = await loadOpenSession/);
    expect(correctionsSrc).toMatch(/if \(open\) \{[\s\S]*?\.update\(rawBagAllocationSessions\)/);
    expect(correctionsSrc).toMatch(/allocationStatus: closedAllocationStatus/);
    // Manual value + method drive the ending balance (not system-derived).
    expect(correctionsSrc).toMatch(/endingBalanceQty: args\.newRemaining/);
    expect(correctionsSrc).toMatch(/endingBalanceSource: args\.method/);
    // DEPLETED when 0, CLOSED when > 0.
    expect(correctionsSrc).toMatch(/args\.newRemaining > 0 \? "CLOSED" : "DEPLETED"/);
  });

  it("records provenance that an open session was closed manually", () => {
    expect(correctionsSrc).toMatch(/manual_closeout_open_session/);
    expect(correctionsSrc).toMatch(/closed_open_session: Boolean\(open\)/);
    expect(correctionsSrc).toMatch(/open_session_id: open\?\.id \?\? null/);
  });

  it("preserves the IDLE invariant on depletion (QR released with assignment cleared)", () => {
    // Empties → releaseQrIfEmptied, which sets IDLE + assignedWorkflowBagId null.
    expect(correctionsSrc).toMatch(/if \(newStatus === "EMPTIED"\) \{\s*await releaseQrIfEmptied/);
    expect(correctionsSrc).toMatch(/status: "IDLE", assignedWorkflowBagId: null/);
  });
});

describe("resolve-page gate — actionable reason, not a floor dead-end", () => {
  it("points to the workbench closeout options", () => {
    expect(reviewSrc).not.toMatch(/Close it at the floor before admin resolution/);
    expect(reviewSrc).toMatch(/Use calculated remaining/);
    expect(reviewSrc).toMatch(/Correct remaining/);
    expect(reviewSrc).toMatch(/Mark depleted/);
  });
});

describe("workbench UI — explicit open-allocation panel, all three options", () => {
  it("needs-closeout rows show an Open allocation session hint with the options", () => {
    expect(pageSrc).toMatch(/Open allocation session — close it here to reuse this bag/);
    expect(pageSrc).toMatch(/Use calculated remaining, Correct remaining \(manual count\),/);
    expect(pageSrc).toMatch(/Mark depleted/);
    expect(pageSrc).toMatch(/No floor step needed/);
  });

  it("keeps the calculated action, correction menu, and manual closeout link", () => {
    expect(pageSrc).toMatch(/UseCalculatedRemainingButton/);
    expect(pageSrc).toMatch(/PartialBagCorrectionMenu/);
    expect(pageSrc).toMatch(/Record closeout/);
  });
});

describe("authorization — ledger mutations stay admin/lead-gated", () => {
  it("manual correction + calculated closeout both require a guard", () => {
    expect(actionsSrc).toMatch(/correctPartialBagRemainingAction[\s\S]*?requireAdmin\(\)/);
    // v1.12.0 calculated action is lead-gated.
    expect(actionsSrc).toMatch(/useCalculatedRemainingAction[\s\S]*?requireLead\(\)/);
  });
});
