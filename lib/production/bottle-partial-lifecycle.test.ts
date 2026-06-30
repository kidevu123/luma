// P2-PARTIAL-KEEP — full bottle partial-bag lifecycle, exercised through the
// REAL decision helpers that the server actions / projector use. There is no
// Postgres integration harness in the default vitest run (see vitest.config.ts:
// "we deliberately avoid running tests that hit a real database"), so this test
// chains the pure decision functions across the intended lifecycle to prove the
// end-to-end behavior at the logic level. A true DB-backed E2E remains a
// follow-up via the scripts/verify-*.ts staging pattern (documented in CHANGELOG).
//
// Lifecycle covered:
//   1. A QR/bag runs a bottle production run.
//   2. The run is closed "keep as partial" → QR stays assigned (not IDLE).
//   3. The same QR can be resumed later.
//   4. It can be used for a DIFFERENT bottle product (new workflow bag).
//   5. When the bag is finally empty, the QR is released only then.

import { describe, it, expect } from "vitest";
import {
  shouldReleaseQrAtFinalizationWithIntent,
  shouldReleaseQrAfterPackagingClose,
  isPartialBagResume,
} from "./bag-allocation";
import {
  canResumeFinalizedWorkflowOnInventoryBag,
  canRestartAvailablePartialRawBag,
  type PartialBagSession,
} from "./partial-bag-restart";

type Session = PartialBagSession;

describe("bottle partial-bag lifecycle (decision-level E2E)", () => {
  it("Step 2 — closing a bottle run 'keep partial' HOLDS the QR (deferred at finalize, held after close)", () => {
    // At BAG_FINALIZED the packaging path defers the release decision.
    expect(
      shouldReleaseQrAtFinalizationWithIntent(
        { defer_qr_release: true },
        // session still OPEN at the instant of finalize (output close runs after)
        { allocationStatus: "OPEN", endingBalanceQty: null },
      ),
    ).toBe(false);

    // After the production-output close computes remaining = 4200 (> 0), the
    // re-decision holds the QR.
    expect(
      shouldReleaseQrAfterPackagingClose({
        keepPartial: true,
        endingBalanceQty: 4200,
      }),
    ).toBe(false);

    // Even if the operator left it implicit and the computed remaining is > 0,
    // the QR is still held (a partial bag is never dropped).
    expect(
      shouldReleaseQrAfterPackagingClose({
        keepPartial: false,
        endingBalanceQty: 4200,
      }),
    ).toBe(false);
  });

  it("Step 3 — the held partial bag is resumable (CLOSED session with remaining > 0)", () => {
    const sessions: Session[] = [
      {
        allocationStatus: "CLOSED",
        endingBalanceQty: 4200,
        closedAt: new Date("2026-06-30T12:00:00Z"),
      },
    ];
    expect(isPartialBagResume(sessions[0])).toBe(true);
    // Inventory flips to AVAILABLE on a partial close, so both resume paths pass.
    expect(
      canResumeFinalizedWorkflowOnInventoryBag({
        inventoryStatus: "AVAILABLE",
        sessions,
      }),
    ).toBe(true);
    expect(
      canRestartAvailablePartialRawBag({
        inventoryStatus: "AVAILABLE",
        sessions,
      }),
    ).toBe(true);
  });

  it("Step 4 — reuse for a DIFFERENT bottle product is gated only by resumability, not product identity", () => {
    // The resume eligibility helpers never reference product_id — a partial bag
    // resumed into a new run picks a fresh product (Variety vs 12ct), so the
    // same QR can carry a different bottle product next time.
    const sessions: Session[] = [
      { allocationStatus: "CLOSED", endingBalanceQty: 1500, closedAt: new Date() },
    ];
    expect(
      canResumeFinalizedWorkflowOnInventoryBag({
        inventoryStatus: "AVAILABLE",
        sessions,
      }),
    ).toBe(true);
    // (Product switching safety is enforced in scanCardAction by creating a new
    // workflow bag and never copying product_id — asserted in the floor source
    // checks; here we assert the eligibility gate is product-agnostic.)
  });

  it("Step 5 — once the bag is actually empty, the QR is released (and only then)", () => {
    // Operator/derived close says 0 remaining → release.
    expect(
      shouldReleaseQrAfterPackagingClose({
        keepPartial: false,
        endingBalanceQty: 0,
      }),
    ).toBe(true);
    // An empty bag is no longer a partial resume.
    expect(
      isPartialBagResume({ allocationStatus: "CLOSED", endingBalanceQty: 0 }),
    ).toBe(false);
    // Explicit keep-partial still wins even at 0 (operator override), so an
    // accidental release cannot happen against the operator's stated intent.
    expect(
      shouldReleaseQrAfterPackagingClose({
        keepPartial: true,
        endingBalanceQty: 0,
      }),
    ).toBe(false);
  });

  it("regression — unknown remaining never drops the QR (safe default)", () => {
    expect(
      shouldReleaseQrAfterPackagingClose({
        keepPartial: false,
        endingBalanceQty: null,
      }),
    ).toBe(false);
    // A finalized bag with no usable session is not silently resumable either —
    // it needs an admin closeout first (never a phantom reuse).
    expect(
      canResumeFinalizedWorkflowOnInventoryBag({
        inventoryStatus: "IN_USE",
        sessions: [
          { allocationStatus: "OPEN", endingBalanceQty: null, closedAt: null },
        ],
      }),
    ).toBe(false);
  });
});
