// OP-1F — accountability invariant scanner.
//
// Walks every live floor + admin action file and asserts that every
// event-emission call site is wired for OP-1 accountability:
//
//   - `projectEvent(tx, { ... })` call sites must include the four
//     accountability fields (enteredByUserId / accountableEmployeeId /
//     accountabilitySource / accountableEmployeeNameSnapshot) OR the
//     event type must be on the explicit DEFERRED list.
//
//   - `tx.insert(materialInventoryEvents).values({ ... })` and
//     `tx.insert(rawBagAllocationEvents).values({ ... })` call sites
//     must wrap their payload with `withAccountabilityPayload(...)`.
//
// This catches the regression where someone adds a new emission
// without threading accountability — the scanner notices and fails
// before the reviewer has to. Pure static check; no DB needed.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");

/** Files that emit live events from server actions. The scanner
 *  enforces accountability on every emission in these files. */
const LIVE_EMISSION_FILES: ReadonlyArray<string> = [
  "app/(floor)/floor/[token]/actions.ts",
  // STAGE-EVENT-EXTRACT-1: fireStageEventAction's guard sequence and
  // transaction body live here now; it emits BLISTER_COMPLETE,
  // SEALING_COMPLETE, BAG_RELEASED and friends.
  "lib/production/engine/record-stage-event.ts",
  // PACKAGING-COMPLETE-EXTRACT-1: packagingCompleteAction's guard
  // sequence and transaction body live here now; it emits
  // PACKAGING_COMPLETE and BAG_FINALIZED (auto-finalize).
  "lib/production/engine/record-packaging-complete.ts",
  // ASSIGN-PRODUCT-EXTRACT-1: saveSealingProductAction's guard sequence
  // and transaction body live here now; it emits PRODUCT_MAPPED.
  "lib/production/engine/assign-bag-product.ts",
  // P2-QUEUE-1: the CLAIM intent's write half. Emits BAG_PICKED_UP
  // through projectEvent directly (a claim is not a stage event), so it
  // needs the same accountability wiring as every other emission.
  "lib/production/engine/claim-queued-bag.ts",
  // P4b Task 2/4: the single exception workflow's shared write path.
  // raiseProductionException / raiseDowntimeStarted / raiseQaHoldStarted
  // all delegate here rather than calling projectEvent directly — this
  // is the actual accountability-wired call site the scanner must
  // exercise (fix-round-1: the old entry, raise-production-exception.ts,
  // has zero projectEvent calls post-extraction and was silently
  // skipped by the `argsList.length === 0` guard below — a vacuous
  // pass, not a real check).
  "lib/production/engine/emit-stationed-event.ts",
  // Kept for event-type COVERAGE only (the describe block below that
  // greps for each ACCOUNTABLE_EVENTS literal) — these three carry the
  // literal `eventType: "X"` strings as arguments to
  // emitStationedExceptionEvent, not to projectEvent, so they add zero
  // rows to the projectEvent-call-site checks (correctly skipped by the
  // same `argsList.length === 0` guard) but are still where
  // PRODUCTION_EXCEPTION_RAISED / DOWNTIME_STARTED / QA_HOLD_STARTED
  // are spelled out as string literals.
  "lib/production/engine/raise-production-exception.ts",
  "lib/production/engine/raise-downtime.ts",
  "lib/production/engine/raise-qa-hold.ts",
  // Fix round 2 (N1): the release half. Same coverage-only reasoning
  // as its three siblings above.
  "lib/production/engine/raise-qa-hold-release.ts",
  "app/(floor)/floor/[token]/roll-actions.ts",
  "app/(floor)/floor/[token]/bag-allocation-actions.ts",
  "app/(admin)/inbound/packaging-materials/actions.ts",
  "app/(admin)/packaging-receipts/[lotId]/actions.ts",
];

/** Required keys on every `projectEvent(tx, { ... })` argument
 *  object. The accountability resolver returns these as a single
 *  block; missing any one means the call is half-wired. */
const ACCOUNTABILITY_KEYS = [
  "enteredByUserId",
  "accountableEmployeeId",
  "accountabilitySource",
  "accountableEmployeeNameSnapshot",
] as const;

/** Event types that MUST be wired with full accountability today. */
const ACCOUNTABLE_EVENTS: ReadonlyArray<string> = [
  // workflow_events
  "CARD_ASSIGNED",
  "PRODUCT_MAPPED",
  "BAG_PICKED_UP",
  "BLISTER_COMPLETE",
  "SEALING_COMPLETE",
  "PACKAGING_SNAPSHOT",
  "PACKAGING_COMPLETE",
  "BOTTLE_HANDPACK_COMPLETE",
  "BOTTLE_CAP_SEAL_COMPLETE",
  "BOTTLE_STICKER_COMPLETE",
  "BAG_PAUSED",
  "BAG_RESUMED",
  "BAG_RELEASED",
  "BAG_FINALIZED",
  // P6 Task 4 — OPERATOR_CHANGE removed from the accountable-events
  // coverage list: setOperatorAction was retired (zero non-test callers
  // post P4b; operator handoff runs through operator-session-actions.ts
  // openOperatorSessionAction / closeOperatorSessionAction, which emit
  // STATION_OPERATOR_* events). The projector still handles the type for
  // historical events, and the DB enum still carries it — but no live
  // action emits it today, so the coverage assertion moved off it.
  "PRODUCTION_EXCEPTION_RAISED",
  "DOWNTIME_STARTED",
  "QA_HOLD_STARTED",
  "QA_HOLD_RELEASED",
  // material_inventory_events
  "MATERIAL_RECEIVED",
  "ROLL_MOUNTED",
  "ROLL_UNMOUNTED",
  "ROLL_WEIGHED",
  "ROLL_DEPLETED",
  "ROLL_COUNTER_SEGMENT_RECORDED",
  "PACKAGING_BOX_RECEIVED",
  "PACKAGING_BOX_COUNTED",
  "PACKAGING_VARIANCE_RECORDED",
  "PACKAGING_RECEIPT_ADJUSTED",
  // raw_bag_allocation_events
  "RAW_BAG_OPENED",
  "RAW_BAG_PARTIAL_CONSUMED",
  "RAW_BAG_RETURNED_TO_STOCK",
  "RAW_BAG_DEPLETED",
  "RAW_BAG_ADJUSTED",
];

/** Event types that are intentionally NOT wired live today. The OP-1D
 *  decision deferred these to the QC subsystem phase. The scanner
 *  must not fail for them, and the wider doc set must explicitly
 *  acknowledge they are deferred. */
const DEFERRED_EVENTS: ReadonlyArray<string> = [
  "PACKAGING_DAMAGE_RETURN",
  "REWORK_SENT",
  "REWORK_RECEIVED",
  "SCRAP_RECORDED",
  "SUBMISSION_CORRECTED",
];

/** Find every balanced `(...)` argument list that follows a given
 *  function-call pattern in `src`. Returns the inner text (between
 *  the outer parens) for each match. */
function findCallArgs(src: string, callPattern: RegExp): string[] {
  const out: string[] = [];
  callPattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = callPattern.exec(src)) !== null) {
    const start = m.index + m[0].length; // immediately after "("
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth > 0) i++;
    }
    if (depth === 0) {
      out.push(src.slice(start, i));
    }
  }
  return out;
}

/** Pull the literal eventType value out of a projectEvent argument
 *  block. Returns null when the call uses a variable instead. */
function extractEventType(args: string): string | null {
  const m = /eventType:\s*"([A-Z_]+)"/.exec(args);
  if (m) return m[1] ?? null;
  return null; // dynamic eventType — caller variable
}

describe("OP-1 invariant scanner — every live emission carries accountability", () => {
  const sources: Record<string, string> = {};
  for (const rel of LIVE_EMISSION_FILES) {
    sources[rel] = readFileSync(join(REPO_ROOT, rel), "utf8");
  }

  describe("projectEvent(tx, { ... }) call sites — workflow_events", () => {
    for (const [rel, src] of Object.entries(sources)) {
      const argsList = findCallArgs(src, /\bprojectEvent\(\s*tx\s*,\s*\{/g);
      if (argsList.length === 0) continue;
      it(`${rel} — every projectEvent call includes all 4 accountability keys`, () => {
        const failures: string[] = [];
        for (const args of argsList) {
          const eventType = extractEventType(args);
          if (eventType && DEFERRED_EVENTS.includes(eventType)) continue;
          const missing = ACCOUNTABILITY_KEYS.filter(
            (k) => !args.includes(`${k}:`),
          );
          if (missing.length > 0) {
            failures.push(
              `eventType=${eventType ?? "<dynamic>"} missing ${missing.join(", ")}`,
            );
          }
        }
        if (failures.length > 0) {
          expect(failures.join("\n")).toBe("");
        }
      });
    }
  });

  describe("tx.insert(materialInventoryEvents).values({ ... }) — material events", () => {
    for (const [rel, src] of Object.entries(sources)) {
      // Capture the entire .values({...}) argument that follows
      // .insert(materialInventoryEvents).
      const argsList = findCallArgs(
        src,
        /\.insert\(\s*materialInventoryEvents\s*\)\s*\.values\(/g,
      );
      if (argsList.length === 0) continue;
      it(`${rel} — every materialInventoryEvents insert wraps payload with withAccountabilityPayload`, () => {
        const failures: string[] = [];
        for (let idx = 0; idx < argsList.length; idx++) {
          const args = argsList[idx]!;
          // We treat the entire values argument as the call site;
          // the payload key inside it must be a withAccountabilityPayload(...) call.
          const hasWrapper = /payload:\s*withAccountabilityPayload\(/.test(args);
          if (!hasWrapper) {
            const head = args.slice(0, 200).replace(/\s+/g, " ").trim();
            failures.push(`insert #${idx + 1}: ${head}…`);
          }
        }
        if (failures.length > 0) {
          expect(failures.join("\n")).toBe("");
        }
      });
    }
  });

  describe("tx.insert(rawBagAllocationEvents).values({ ... }) — allocation events", () => {
    for (const [rel, src] of Object.entries(sources)) {
      const argsList = findCallArgs(
        src,
        /\.insert\(\s*rawBagAllocationEvents\s*\)\s*\.values\(/g,
      );
      if (argsList.length === 0) continue;
      it(`${rel} — every rawBagAllocationEvents insert wraps payload with withAccountabilityPayload`, () => {
        const failures: string[] = [];
        for (let idx = 0; idx < argsList.length; idx++) {
          const args = argsList[idx]!;
          const hasWrapper = /payload:\s*withAccountabilityPayload\(/.test(args);
          if (!hasWrapper) {
            const head = args.slice(0, 200).replace(/\s+/g, " ").trim();
            failures.push(`insert #${idx + 1}: ${head}…`);
          }
        }
        if (failures.length > 0) {
          expect(failures.join("\n")).toBe("");
        }
      });
    }
  });

  describe("event-type coverage — every accountable type is emitted somewhere", () => {
    const allSrc = Object.values(sources).join("\n");
    for (const eventType of ACCOUNTABLE_EVENTS) {
      it(`${eventType} is referenced by at least one live action`, () => {
        // Match either:
        //   - `eventType: "X"`            — direct call site
        //   - `"X",`                      — z.enum array entry whose value
        //                                   the action then forwards to projectEvent
        //   - `eventType: "X"` inside a   — same as above, just whitespace variations
        // The bare quoted string is the most reliable signal across
        // both shapes. We require the literal to appear in at least
        // one live emission file.
        const re = new RegExp(`"${eventType}"`);
        expect(re.test(allSrc)).toBe(true);
      });
    }
  });

  describe("deferred event-type coverage — none of these are emitted live", () => {
    const allSrc = Object.values(sources).join("\n");
    for (const eventType of DEFERRED_EVENTS) {
      it(`${eventType} is NOT emitted by any live action (deferred to QC subsystem)`, () => {
        // If a future phase wires one of these, they should also wire
        // accountability AND remove the type from DEFERRED_EVENTS so
        // the projectEvent-args test above starts enforcing the
        // wiring. Until then, the literal must not appear in the live
        // action files.
        const re = new RegExp(`"${eventType}"`);
        expect(re.test(allSrc)).toBe(false);
      });
    }
  });
});
