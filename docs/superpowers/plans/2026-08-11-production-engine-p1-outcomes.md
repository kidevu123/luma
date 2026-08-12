# Production Engine Phase 1 — outcomes and Phase 2 preconditions

**Branch:** `feat/production-engine-p1` (22 commits, `93741c9..304c70d`)
**Plan:** `2026-08-11-production-engine-p1.md`
**Spec:** `../specs/2026-08-11-production-engine-operator-experience-design.md`
**Smoke checklist:** `2026-08-11-production-engine-p1-staging-smoke.md`

## What shipped

`lib/production/engine/` — the single contract the floor UI will talk to:

| Module | Contents |
|---|---|
| `types.ts` | `StationView`, `NextAction`, `Blocker`, `AdvanceInput/Result` |
| `stage-lexicon.ts` | bridge between the two stage vocabularies |
| `resolve-operation.ts` | `(product, stationKind)` to `route_operations` row |
| `resolve-completion.ts` | required operator inputs, derived from route data |
| `resolve-exceptions.ts` | blockers and the diagnosis checklist, one evaluation |
| `station-view.ts` | `getStationView` (thin) + `assembleStationView` (pure) |
| `advance.ts` | `advanceBag` (total) + `buildRecordStageEventInput` (pure) |
| `record-stage-event.ts` | `fireStageEventAction`'s body, moved verbatim |
| `index.ts` | the barrel — the only permitted floor entry point |

Plus an ESLint boundary restricting `app/(floor)/**` to the barrel, and
`fireStageEventAction` delegating to the shared `recordStageEvent`.

## What Phase 1 actually proved

Phase 1 delivered one proven thing and one unproven thing. Do not let a
green suite blur them.

**Proven — the extraction.** ~360 lines moved out of
`fireStageEventAction`. Two independent reviews reconstructed the move
and found exactly 5 changed lines, all mechanical (`authStation` hoisted
to the caller, four `parsed.data.` to `input.`, one cast). The three
release helpers differ by one added `export`. The existing 5,300-test
suite covers this path and stayed green.

**Unproven — the engine surface.** `getStationView` and `advanceBag`
have no production caller. Their queries have never run against a real
schema. The CHANGELOG's "land behind the existing floor UI" is accurate:
the engine exists, its pure logic is tested, and nothing calls it.

## What CI does not verify

This repo runs no database in its test suite (`vitest.config.ts`), so
these rest on the staging smoke checklist, not on CI:

- Idempotency under a repeated `clientEventId` — depends on a partial
  unique index swallowing a duplicate insert.
- Concurrent claim of one bag by two stations.
- That `getStationView`'s SQL returns what `assembleStationView` expects.
- That the `recordStageEvent` extraction is identical in effect — the
  5,300 tests guarding it are themselves pure.

## Withdrawn during execution

- **Task 8 Step 5, the `page.tsx` rewire.** Reverted. It could not be
  done literally (66 `currentAtStation` usages read fields `StationView`
  lacks), and the partial version introduced a torn read — the label came
  from a different `read_station_live` query than the bag, so a
  disagreement rendered "—" with a bag present — and added roughly four
  serial round trips including two duplicate queries to a page operators
  load all shift. `page.tsx` has a zero diff. The real rewire is Phase 4
  work, once those 66 usages go away.
- **Restoring the ESLint boundary to `"error"`.** Not achievable in
  Phase 1: 82 pre-existing violations across 15 floor files, removable
  only by the Phase 4 screen rewrite. The rule ships at `"warn"` with a
  ratchet test pinned at the current count of 80.

## Phase 2 preconditions — read before wiring any caller

**`advanceBag` cannot currently succeed on three station kinds.** All
three are documented in a block comment above the function:

1. `buildRecordStageEventInput` never sets `counterPresses`, so any
   SEALING or COMBINED segment returns `SEALING_COUNTER_PRESS_ERROR`.
2. `intentToEventType("CLAIM")` yields `BAG_PICKED_UP`, which is absent
   from `ALLOWED_EVENTS_BY_KIND` and is rejected.
3. `STATION_KIND_ALIAS` maps `HANDPACK_BLISTER` to `BLISTER`, producing
   `BLISTER_COMPLETE`, which that station kind disallows.

It also drops `overrideEmployeeCode`, `sealingCloseMode`,
`partialCloseReason`, `partialCloseReasonNote`, `packsRemaining`, and
`cardsReopened`. Packaging's three counts collapse into one `countTotal`
and `damaged` is discarded, so `advanceBag` is not yet a substitute for
`packagingCompleteAction`.

**The bottle route conflict is real and unresolved.** Migration
`0013_route_operation_compat.sql` seeds `STICKERING` at sequence 3 and
`INDUCTION_SEAL` at sequence 4, while `BOTTLE-ORDER-FLEX-1` in
`lib/production/stage-progression.ts` treats the two as interchangeable.
Two passing tests in `station-event-mapping.test.ts` pin the
contradiction; delete them when Phase 2 resolves it. Note the route half
reads only `0013` — resolving it via a NEW migration would leave that
half passing, though the `stage-progression` half would still fail.

**A throw after a committed write returns `ADVANCE_FAILED`.**
`advanceBag`'s catch also covers `getStationView`, so a failure after
`recordStageEvent` has committed still reports an error. Retry is safe
only if the client reuses the same `clientEventId`. **The Phase 2 UI must
not mint a fresh `clientEventId` on retry.**

**The barrel is not purely "advanceBag-only."** It also exports
`projectBagReleasedEvent`, a raw workflow-event writer, because floor
code already called it and the alternative was the deep path the
boundary now restricts.

## Deferred minors

- `ADVANCE_REJECTED` / `ADVANCE_FAILED` are literals in `advance.ts`
  rather than `blockerFor` entries. Both need a dynamic
  `supervisorDetail` the static catalogue cannot hold. Revisit at a third.
- `station-event-mapping.test.ts` header says "set every sequence to 0
  and every mapping test still passes" — now true only of the mapping
  describe, since the divergence block asserts sequences 3 and 4.
- `advance.ts` cites `resolve-operation.ts:26` for `STATION_KIND_ALIAS`;
  a JSDoc expansion moved it to line 35.
- The damage-granularity question is open: at packaging, does the floor
  count damaged cases, displays, or loose cards? `resolve-completion.ts`
  ships `unit: null` rather than guessing. Phase 4 must ask.

## Known-unrelated test failures

Five failures in
`app/(admin)/finished-lots/[id]/zoho-production-output-preview-actions.test.ts`
predate this branch — verified by running that file at the pre-branch
commit. They are not caused by this work and were failing on `main`.
