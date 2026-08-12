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
   **Resolved in P2** — `counterPresses` now passes through on
   presence, not truthiness (`057b95f`).
2. `intentToEventType("CLAIM")` yields `BAG_PICKED_UP`, which is absent
   from `ALLOWED_EVENTS_BY_KIND` and is rejected.
   **Resolved in P2** — `CLAIM` short-circuits at the top of
   `advanceBagInner`, before `resolveOperation`, and is handled by the
   new `claimQueuedBag` path (`057b95f`, locked/idempotent as of
   `8584025`, race-loser blocker code corrected in `4030fd9`).
3. `STATION_KIND_ALIAS` maps `HANDPACK_BLISTER` to `BLISTER`, producing
   `BLISTER_COMPLETE`, which that station kind disallows.
   **Resolved in P2** — `intentToEventType` takes station kind as a
   third parameter and a `COMPLETE_EVENT_FOR_STATION_KIND` override
   table maps `HANDPACK_BLISTER` to `HANDPACK_BLISTER_COMPLETE`
   (`057b95f`). Still uncorroborated at the route-operation layer; see
   Task 7's note that the real fix remains a `HANDPACK_BLISTER` route
   operation.

It also drops `overrideEmployeeCode`, `sealingCloseMode`,
`partialCloseReason`, `partialCloseReasonNote`, `packsRemaining`, and
`cardsReopened`. Packaging's three counts collapse into one `countTotal`
and `damaged` is discarded, so `advanceBag` is not yet a substitute for
`packagingCompleteAction`. **These remain Phase 4 work** — not touched
in P2.

**The bottle route conflict is real and unresolved.** Migration
`0013_route_operation_compat.sql` seeds `STICKERING` at sequence 3 and
`INDUCTION_SEAL` at sequence 4, while `BOTTLE-ORDER-FLEX-1` in
`lib/production/stage-progression.ts` treats the two as interchangeable.
Two passing tests in `station-event-mapping.test.ts` pin the
contradiction; delete them when Phase 2 resolves it. Note the route half
reads only `0013` — resolving it via a NEW migration would leave that
half passing, though the `stage-progression` half would still fail.
**Resolved in P2** — `order_independent_group` on `route_operations`
(migration 0071) expresses the divergence in data instead of code
(`cc60a3b`, `630df4d`); the two contradiction-pinning tests were
replaced per their own instructions.

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

## Phase 2 outcomes

Branch `feat/production-engine-p2`. Three short notes for whoever reads
`read_bag_queue` or `upNext` next:

- **`claimed_by_station_id` means "the station holding the bag," not "a
  peer's reservation."** A holder blocks visibility and claiming only
  when the holder's own kind appears in the row's
  `eligible_station_kinds` — a true destination peer (second sealer, the
  other bottle finishing station). A holder of any other kind is
  upstream: it neither hides the row from a downstream station's queue
  nor blocks that station's claim. That asymmetry is the overlap scan,
  and it is deliberate, not a gap.
- **A missing ETA is the honest answer, not a bug.** `upNext` computes
  `etaMinutes` only when the row is `UPSTREAM_RUNNING` with a live
  holder; a released-but-still-`UPSTREAM_RUNNING` row (stale
  `upstream_started_at`, no holder) and a product with fewer than five
  recent samples both get `null` rather than a guess clamped to zero.
  READY rows never carry an ETA at all — they are waiting on an
  operator, not on upstream.
- **Partial sealing close deliberately does not clear sibling pins.**
  The stale-sibling-release added in P2 only fires on the final sealing
  close (`isSealingFinal && !isPartialSealingClose`); a partial close
  leaves other sealers' pins in place because the bag is still sealable
  at those stations. Scoped out on purpose, not an oversight — see Task
  5's concerns section for the argument that it may deserve revisiting
  once the bag also auto-releases at BLISTERED on a partial close.

## Phase 3 outcomes

Branch `feat/production-engine-p3`. Realtime shipped: floor tablets receive stream events from pg_notify and auto-refresh queues without operator touch. SSE route `/floor/api/stream/<stationToken>` is authed by station token and filtered by relevance rule:

- **Own event:** if the event originates from the tablet's own station, refresh always.
- **Same-kind peer:** if the event is from a different station but the same kind (e.g. SEALING to SEALING), refresh only when the event concerns a bag eligible for that station's queue.
- **Claimable queue:** if the event stage matches a station kind in the bag's next route step, refresh.

The stream uses hello-gated polling invariant: polling stops as soon as a connection proves live (EventSource open); if the connection drops, polling resumes at 60s. If the server restarts, the tablet reconnects SSE within ~60s.

What CI cannot verify: the stream route end-to-end (staging smoke); EventSource reconnect behaviour under real traffic (staging smoke); the pg_notify round-trip latency and per-station filtering under load (staging smoke). Relevance rule and payload construction are pure-tested.

### Phase 2 deferred minors (final-review triaged, none floor-reachable)

- Sibling-release payload marker shipped (`auto_release_reason`); the
  repair-path events (`CARD_FORCE_RELEASED`, `SUBMISSION_CORRECTED`) remain
  outside `FLOW_EVENTS` — a void-repaired bag regains its queue row on next
  pickup or rebuild. Revisit when claims gain a UI caller.
- Same-bag deadlock window between the claim lock and projector write order:
  documented at the `.for("update")` site; consistent-ordering refactor
  belongs to the phase that wires claims to the UI (P4).
- The finishing re-claim guard (`P2-FINISHING-RECLAIM-1`) has no contract
  test; the staging checklist covers it. A `STICKER_ONLY` bag re-scanned at
  its sticker station gets a slightly wrong "waiting for cap-sealing"
  message — inherited gate pattern, P4 copy pass.
- Smaller: STICKER_ONLY end-to-end transition coverage; rank-guard fail-open
  comment; unfiltered qrCards join (shared with station-view);
  `resolveRouteCodeForQueue` null-product fallback test; migration-text
  assertions unbound; scanner slice bound; `actions.ts:2589` copy.
