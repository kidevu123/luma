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

describe("stale sibling sealing pins — release stays inside the transaction", () => {
  it("fires after the primary auto-release and before the transaction ends", () => {
    // The failure this prevents: the call drifting OUT of the tx (e.g.
    // next to the exported projectBagReleasedEvent helper), which would
    // let the sealing close commit while the sibling pin release fails
    // separately — leaving another sealer pinned to a bag that is done.
    expect(src).toMatch(/await releaseStaleSiblingSealingPins\(tx, \{/);
    const primaryIdx = src.indexOf("await maybeAutoReleaseAfterComplete");
    const siblingIdx = src.indexOf("await releaseStaleSiblingSealingPins");
    const outsideTxnIdx = src.indexOf(
      "export async function projectBagReleasedEvent",
    );
    expect(primaryIdx).toBeGreaterThan(-1);
    expect(siblingIdx).toBeGreaterThan(primaryIdx);
    expect(siblingIdx).toBeLessThan(outsideTxnIdx);
  });

  it("is gated on the FINAL sealing close, never a partial one", () => {
    // A partial close-out ends this lane, not the bag: other sealers may
    // still be working it, so clearing their pins would be wrong.
    const siblingIdx = src.indexOf("await releaseStaleSiblingSealingPins");
    expect(src.slice(Math.max(0, siblingIdx - 200), siblingIdx)).toMatch(
      /isSealingFinal && !isPartialSealingClose/,
    );
  });

  it("emits real BAG_RELEASED events scoped to other SEALING stations", () => {
    const helperIdx = src.indexOf("async function releaseStaleSiblingSealingPins");
    expect(helperIdx).toBeGreaterThan(-1);
    const helper = src.slice(helperIdx, helperIdx + 1600);
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
    const helperIdx = src.indexOf("async function releaseStaleSiblingSealingPins");
    const helper = src.slice(helperIdx, helperIdx + 1600);
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
