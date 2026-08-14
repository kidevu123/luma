// MULTI-SEALING-SAME-BAG-1 / P2-SIBLING-ATTRIBUTION-1 — structural pins
// for stale sibling sealing-pin release.
//
// WHY THIS FILE EXISTS. These three assertions lived in
// app/(floor)/floor/[token]/stage-action-buttons.test.ts, which read
// actions.ts with record-stage-event.ts spliced in. P4b Task 5 deleted
// that file with the component it scanned, and the pins went dead with
// it — but the behaviour did not move anywhere, it is still exactly here
// in record-stage-event.ts. So they are restored pointing at the LIVE
// module rather than at a stitched copy of it.
//
// WHY STRUCTURAL AND NOT BEHAVIOURAL. All three facts are about WHERE a
// call sits and WHAT it writes inside a database transaction, and this
// repo runs no Postgres in the suite (vitest.config.ts, by design). A
// source scan is the only thing that can hold them short of staging; it
// is a weak test of a strong invariant, which is why each one names the
// failure it is preventing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "record-stage-event.ts"), "utf8");

/** recordStageEvent's transaction BODY — from `db.transaction(async (tx)
 *  => {` to the `});` that closes it.
 *
 *  Slicing to the body (rather than "before some later export") is what
 *  makes the placement assertions real: a call that drifted out of the
 *  transaction but stayed above the next export would still have passed
 *  a "comes before X" check while committing separately from the event
 *  it belongs to. */
function transactionBody(): string {
  const open = src.indexOf("await db.transaction(async (tx) => {");
  expect(open).toBeGreaterThan(-1);
  // The transaction is opened at 4-space indent inside a try block, so
  // its closing line is the first `    });` at that same indent.
  const close = src.indexOf("\n    });", open);
  expect(close).toBeGreaterThan(open);
  return src.slice(open, close);
}

/** The whole releaseStaleSiblingSealingPins helper — sliced to the NEXT
 *  function declaration rather than a fixed character budget, which the
 *  helper has already outgrown once (it is 1684 chars against the old
 *  1600-char window, so the tail was going unchecked). */
function siblingHelper(): string {
  const start = src.indexOf("async function releaseStaleSiblingSealingPins");
  expect(start).toBeGreaterThan(-1);
  // The helper's own closing brace: the first `}` at column 0 after the
  // declaration. Stopping at the NEXT declaration instead would swallow
  // that function's doc comment, and a fixed character budget is what
  // went stale in the first place.
  const close = src.indexOf("\n}\n", start);
  expect(close).toBeGreaterThan(start);
  return src.slice(start, close + 2);
}

describe("stale sibling sealing pins — release stays inside the transaction", () => {
  it("fires after the primary auto-release and INSIDE the transaction", () => {
    // The failure this prevents: the call drifting OUT of the tx, which
    // would let the sealing close commit while the sibling pin release
    // fails separately — leaving another sealer pinned to a bag that is
    // done. Anchored on the transaction body itself, so "still above
    // some later export" is not mistaken for "still inside".
    const body = transactionBody();
    expect(body).toMatch(/await releaseStaleSiblingSealingPins\(tx, \{/);
    const primaryIdx = body.indexOf("await maybeAutoReleaseAfterComplete");
    const siblingIdx = body.indexOf("await releaseStaleSiblingSealingPins");
    expect(primaryIdx).toBeGreaterThan(-1);
    expect(siblingIdx).toBeGreaterThan(primaryIdx);
    // Non-vacuous: the slice must be the real body, not an empty string
    // or the whole file.
    expect(body.length).toBeGreaterThan(500);
    expect(body).not.toContain("export async function projectBagReleasedEvent");
  });

  it("is gated on the FINAL sealing close, never a partial one", () => {
    // A partial close-out ends this lane, not the bag: other sealers may
    // still be working it, so clearing their pins would be wrong.
    const body = transactionBody();
    const siblingIdx = body.indexOf("await releaseStaleSiblingSealingPins");
    expect(body.slice(Math.max(0, siblingIdx - 200), siblingIdx)).toMatch(
      /isSealingFinal && !isPartialSealingClose/,
    );
  });

  it("emits real BAG_RELEASED events scoped to other SEALING stations", () => {
    const helper = siblingHelper();
    // The negative assertion below is only worth anything if the window
    // covers the WHOLE helper, so the window is derived from the source
    // rather than budgeted. The scanner this replaced sliced a fixed
    // 1600 characters; the helper is 1538 today, so that budget did in
    // fact still cover it — but only by 62 characters, and a scanner
    // that silently degrades from "does not write the read model" to
    // "does not write the read model in its first 1600 characters" is
    // not one to leave in place. These two assertions say the slice
    // really is exactly the helper: it ends at the closing brace, and it
    // has not run on into the next function.
    expect(helper.trimEnd().endsWith("}")).toBe(true);
    expect(helper).not.toContain("maybeAutoReleaseAfterComplete");
    // Through the shared projection — never a direct read-model write,
    // which would leave workflow_events (the source of truth) silent
    // about a release that happened.
    expect(helper).toMatch(/projectBagReleasedEvent/);
    expect(helper).not.toMatch(/update\(readStationLive\)/);
    // Only OTHER sealing stations pinned to THIS bag. Packaging keeps
    // its pin; the firing station is handled by the primary release.
    expect(helper).toMatch(/eq\(stations\.kind, "SEALING"\)/);
    expect(helper).toMatch(/ne\(readStationLive\.stationId, args\.firingStationId\)/);
    expect(helper).toMatch(
      /eq\(readStationLive\.currentWorkflowBagId, args\.workflowBagId\)/,
    );
    // Per-sibling idempotency suffix: several siblings in one gesture
    // must not collide on the caller's single clientEventId.
    expect(helper).toMatch(/-auto-release-sibling-/);
  });

  it("marks the event as a system-cleared pin, not an operator's release", () => {
    // P2-SIBLING-ATTRIBUTION-1. The accountability carried is the FIRING
    // station's operator — the sibling's operator did nothing. Without
    // this marker the audit trail reads as station A's operator
    // releasing station B's bag.
    const helper = siblingHelper();
    expect(helper).toMatch(/auto_release_reason: "STALE_SIBLING_SEALING_PIN"/);
  });
});

describe("AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS covers every releasing kind", () => {
  it("lists all six, SEALING included", () => {
    // P2-AUTO-ADVANCE-1: the manual Release button is gone from every
    // station, so a kind missing here strands its bags with no operator
    // affordance to unstick them. SEALING is called out because the
    // scanner that held it was the one deleted with the buttons.
    const block =
      src.match(
        /AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS = new Set\(\[([\s\S]*?)\]\)/,
      )?.[1] ?? "";
    expect(block).not.toBe("");
    for (const kind of [
      "BLISTER",
      "HANDPACK_BLISTER",
      "SEALING",
      "BOTTLE_HANDPACK",
      "BOTTLE_CAP_SEAL",
      "BOTTLE_STICKER",
    ]) {
      expect(block).toContain(`"${kind}"`);
    }
  });

  it("every listed kind has a release stage, so none can be a silent no-op", () => {
    const block =
      src.match(
        /AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS = new Set\(\[([\s\S]*?)\]\)/,
      )?.[1] ?? "";
    const kinds = Array.from(block.matchAll(/"([A-Z_]+)"/g), (m) => m[1]);
    expect(kinds.length).toBe(6);
    const progression = readFileSync(
      join(__dirname, "..", "stage-progression.ts"),
      "utf8",
    );
    const releaseTable =
      progression.match(
        /STATION_RELEASE_FROM_STAGE[\s\S]*?= \{([\s\S]*?)\n\};/,
      )?.[1] ?? "";
    for (const kind of kinds) {
      // maybeAutoReleaseAfterComplete returns early when the kind has no
      // STATION_RELEASE_FROM_STAGE entry — listing a kind without one
      // looks like coverage and delivers nothing.
      expect(releaseTable).toMatch(new RegExp(`\\b${kind}:`));
    }
  });
});
