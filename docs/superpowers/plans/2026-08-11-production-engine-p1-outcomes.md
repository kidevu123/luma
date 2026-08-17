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

### Known Phase 3 gaps (P4 work)

- **(a) CLOSED — P4a Task 5**, commit `feat(sse): every stationed notify
  carries stationKind via process cache`. Non-flow events (`BAG_PAUSED`,
  `BAG_RESUMED`, etc.) used to carry `stationKind: null`, so same-kind
  tablets missed pause/resume updates — a paused bag's peers only
  learned the truth on next reload. Fixed with an in-process
  stationId-to-kind cache (`lib/projector/station-kind-cache.ts`);
  `projectEvent`'s notify block now falls back to the cache whenever
  `queueInfo.stationKind` is null but the event carries a `stationId`,
  so every stationed notify (flow and non-flow alike) is stamped with
  its originating station's kind.
- Events with both `stationId: null` AND non-flow type match no tablet
  at all under the current relevance rule — no station refreshes.
- The inactive-station page does not mount the refresher, so
  re-activating a station does not self-recover the tablet; a one-line
  mount in that branch would make it self-recover within 60s via the
  existing 404-then-poll path.
- Consider a `subscribers.size` gauge on the notify bus for observability
  into live SSE connection counts per process.

## Phase 4a outcomes

Branch `feat/production-engine-p4a`. Full fidelity: `advanceBag` now handles all normal-floor workflows without legacy-action fallback.

**Decisions recorded:**

- **Packaging damage granularity:** loose units (operator-counted ripped/damaged loose cards). Mapped to `damaged` field in `AdvanceInput` with `unit: "units"` semantics; routed as `rippedCards` to `recordPackagingComplete`.
- **Ambiguous product resolution:** operator pick from filtered list (2–3 compatible products auto-filtered by station kind). `PICK_PRODUCT` `NextAction` variant; unambiguous cases auto-resolve.

**Gap (a) closure:** Non-flow events (`BAG_PAUSED`, `BAG_RESUMED`, etc.) now carry `stationKind` via in-process memoization (`lib/projector/station-kind-cache.ts`), so same-kind tablets refresh on pause/resume without reload.

## Phase 4b outcomes

Branch `feat/production-engine-p4b`. The operator screen lands.

**What shipped:**

- **OperatorScreen component** (`app/(floor)/floor/[token]/operator-screen.tsx`): renders `StationView` NextAction cases (OPEN_SHIFT, SCAN_TO_CLAIM, PICK_PRODUCT, COMPLETE, CONFIRM_BAG_EMPTY, RESOLVE_PARTIAL, BLOCKED) as a single-screen workflow. Chrome: station label, More/Help buttons. No legacy panels or scanner form in the render path. All writes via `advanceBag`, `claimQueuedBag`, `raiseProductionException`, or reused pause/session actions (barrel-only imports).

- **assignBagProduct extraction** (Task 1): P1-style verbatim extraction of the product-resolution transaction (`PRODUCT_MAPPED` event + `ensureOpenRawBagAllocationSessionForWorkflowBag` + audit) from `saveSealingProductAction` into `lib/production/engine/assign-bag-product.ts`. `advanceBag` calls it when a bag has no product at sealing and intent is COMPLETE with productId. AUTO picks auto-submit on the screen; the engine stays explicit.

- **COMBINED-at-packaging routing** (Task 2): `pickOperationForStationKind(ops, stationKind, opts?: {preferOperation?: string})` added to `resolve-operation.ts`. When bag inputs carry cases/displays/loose (packaging gesture), `advanceBag` passes `preferOperation: "PACKAGING"` and the route picks packaging, not blister segment. Combined stations now route correctly based on gesture, not just station kind.

- **Production exception event** (Task 2): migration `0072_production_exception_event.sql` adds `PRODUCTION_EXCEPTION_RAISED` event type. Projector: non-progressing (no stage transition, no throughput column). Engine `raiseProductionException({stationId, workflowBagId?, category, detail, clientEventId})` emits the event with accountability. Act Now rail picks up all six exception categories (machine/quality/bag/material/product/other).

- **Single exception workflow** (Task 4): six category buttons (machine → pause+DOWNTIME_STARTED; quality → QA_HOLD_STARTED; bag → BAG_PAUSED; material/product/other → PRODUCTION_EXCEPTION_RAISED). QA holds are now real (event stored, not soft-suppressed) and releasable by supervisor (QA_HOLD_RELEASED). Help checklist matches spec's decision tree per station kind.

- **THE CUTOVER** (Task 5): `page.tsx` main path becomes `getStationView` + `<OperatorScreen>`. Panels, scanner form, stage-action-buttons, scan-card-form deleted from main path (files remain or deleted if no other routes depend on them; each deletion justified in commit). The floor now sees a single, scan-first screen per the spec.

- **Boundary to zero** (Task 6): ESLint rule `app/(floor)` imports from engine barrel only. Pre-existing 75 violations eliminated or re-exported. Severity flipped to `"error"`. Ratchet test replaced by two probes asserting blocked/allowed.

- **Observability:** `subscriberCount()` exported from `notify-bus.ts`, exposed as `sseSubscribers: <number>` on `/api/health` JSON. Operators and on-call can monitor live SSE connections per process.

**Deferred to P5:**

- Supervisor gating: supervisor PIN (inline or session-based), unlock for QC panel, rolls page, bag allocation, variety-pack access, bagless reports.
- Partial-close handoff: inline supervisor PIN to approve handoff to next sealer when operator declines "bag empty."
- Hold dismissal options: whether operator can dismiss holds on the rail (vs. supervisor only).

**Tracked follow-ups (post-cutover, filed for P5 decision):**

- **`damagedPackaging` always writes 0 through advanceBag.** [CLOSED — P6
  Task 5, 2026-08-17 user decision] The operator screen now collects a
  `damagedPackaging` count (packaging-material damage: foil, cases, labels)
  alongside the existing `damaged` count (loose-unit/card damage). Added to
  `resolve-completion.ts`'s PACKAGING_OPERATIONS branch as
  `{key:"damagedPackaging", label:"Damaged packaging", unit:"units", required:false}`;
  extended in `types.ts` (`CompletionInput` key union + `AdvanceInput.inputs`);
  mapped in `advance.ts`'s `buildRecordPackagingCompleteInput` replacing the
  hardcoded 0 (absent → 0, counterPresses precedent). Screen renders it via the
  same CompletionInput-driven loop; no special-casing.

- **QA-hold rollback trap.** Any bag held via `QA_HOLD_STARTED` under
  1.34 sets `read_bag_state.is_on_hold = true`. Rolling back to 1.33
  strands those bags — 1.33's UI has no code path that clears the
  column, so every station refuses to work them until 1.34 (or a hand-
  written UPDATE) returns. Documented in the smoke checklist's
  "Rollback (Phase 4b)" block with the SQL one-liner to run BEFORE any
  revert. Mirror when this note relocates.

**Deferred to P6 (from P4b):**

- Data-driven routes: `queueAfterWorkAt` and `resolve-operation` sourced from `route_operations` (vs. hardcoded legacy table). Legacy table deletion and `read_queue_state` double-count fix. CLOSED — P6 Tasks 2+3.
- Barrel curation: legacy action deletion (once no UI calls them). CLOSED — P6 Task 4 (8 dead actions retired).
- Value-pinned duplication guards: `dup_guard_count` tests on high-risk writes. CLOSED — P6 Task 6 (`FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS` and `FRESH_BAG_STATION_KINDS` source-literal parity tests added).

## Phase 5 outcomes

Branch `worktree-production-engine-p5` (merged to `feat/production-engine-p5`).
Version: `1.34.0` → `1.35.0`.

**What shipped:**

- **Migration 0073** (`drizzle/0073_supervisor_and_reports.sql`): `employees.supervisor_pin_hash` + `employees.is_supervisor`; `station_supervisor_sessions` (15-min TTL, one-OPEN-per-station partial unique index); `station_exception_reports` (bagless MACHINE/OTHER reports with acknowledged_at/acknowledged_by).

- **Supervisor session engine** (`lib/production/engine/supervisor-session.ts`): `openSupervisorSession` (argon2id verify, dummy-hash timing-oracle hardening on all rejection legs, one generic refusal sentence — no oracle); `closeSupervisorSession`; `requireSupervisorSession` (lazy expiry); pure `supervisorSessionRemainingSeconds`. Source-scan test pins that `pin` appears only as the input-type field and in the verify call. Admin PIN setter at `settings/employees` (hash via lib/auth.ts, audit `SUPERVISOR_PIN_SET`, no hash in payload).

- **Floor unlock UI** (`app/(floor)/floor/[token]/supervisor-sheet.tsx`): employee code + PIN inputs, server action via `operator-actions.ts`; persistent banner with name, live countdown, and `[ Exit ]` on success. `getStationView` populates `StationView.supervisor` from the open session.

- **Server-side gating** (`requireSupervisorSession` inside each flow): `qc-actions.ts`, `roll-actions.ts`, `bag-allocation-actions.ts`, `variety-run-actions.ts`. Manual bag pick routes through `supervisorClaimBagAction` (supervisor gate + claim path + audit `floor.supervisor.manual_bag_claim`). Bag-allocation and variety-pack pages render a locked state when no open session. Hand-crafted requests refused without a valid session.

- **RESOLVE_PARTIAL inline supervisor check**: LOW-confidence resolution requires an OPEN supervisor session (server-side `requireSupervisorSession`); blocker `PARTIAL_SUPERVISOR_REQUIRED`. Screen opens the supervisor sheet inline when the case is RESOLVE_PARTIAL-low and `view.supervisor` is null. `LeadCodeField` legacy badge removed.

- **Bagless station reports** (`lib/production/engine/raise-station-report.ts`): `raiseStationReport({stationId, category, detail})`, MACHINE and OTHER categories only. Report Problem: machine/other without a pinned bag submit through it (disabled-state removed). Act Now: unacknowledged reports union into the rail (MACHINE crit, OTHER warn) within the same EXCEPTION_ROWS_MAX=3 budget as workflow-event exceptions, sorted by recency.

- **Act Now acknowledgment**: unacknowledged `station_exception_reports` rows render `[ Acknowledge ]` on the admin floor-board rail (server action `acknowledgeStationReportAction`; requireAdmin; audit `STATION_REPORT_ACKNOWLEDGED`; `acknowledged_at` + `acknowledged_by` written). Acknowledged rows leave the rail (query filters `acknowledged_at IS NULL`). Workflow-event exceptions (DOWNTIME/QA) NOT acknowledgeable — they resolve through their own flows.

**Smoke section (Phase 5 / v1.35.0):**

1. **Supervisor unlock, 15-min expiry, exit:**
   - On the floor tablet's More menu, tap Supervisor. Enter supervisor employee code + PIN. On success the banner appears ("Supervisor: [name] — N:NN remaining"). Wait for the TTL to elapse: banner disappears and gated pages return locked. Tap Exit to close the session early — banner disappears immediately.

2. **Wrong PIN — generic refusal, no oracle:**
   - On the unlock sheet enter a correct employee code but wrong PIN. You receive: "That code and PIN combination does not unlock this station." Enter a non-existent employee code + any PIN. You receive the same sentence. The two responses are indistinguishable to the caller.

3. **Gated action refused server-side — hand-crafted request:**
   ```
   curl -X POST https://<floor-host>/floor/api/<token>/qc-actions \
     -H 'Content-Type: application/json' \
     -d '{"action":"releaseHold","bagId":"<any-uuid>"}' \
   ```
   Without a valid supervisor session the response is `{"error":"Supervisor unlock required for this."}`.

4. **Manual pick requires unlock:**
   - Without a supervisor session open, the Manual bag pick panel in More is hidden or disabled. After unlock the panel appears; selecting a bag claims it through the standard scan path.

5. **RESOLVE_PARTIAL-low prompts the sheet inline:**
   - Navigate a bag to a partial-resolution with LOW confidence. When `view.supervisor` is null the supervisor sheet opens automatically before allowing the override. With a session open the override submits directly.

6. **Bagless MACHINE report reaches the rail and acknowledges:**
   - At a floor tablet with no bag scanned, tap Report Problem → Machine. Submit a detail. The report appears on `/floor-board` Act Now as a CRIT row with `[ Acknowledge ]`. Click it — the row disappears on next render.

7. **Gated pages show locked state:**
   - Navigate to `/floor/<token>/bag-allocation` or `/floor/<token>/variety-pack` without a supervisor session. The page renders "Supervisor unlock required for this." In both cases unlock first and the page shows its normal content.

8. **`scripts/verify-bottle-partial-qr-release-e2e.ts` requires a supervisor session now:**
   Whoever runs this script must first open a supervisor session for the station under test (or stub `requireSupervisorSession` to return a mock session in the test environment). The script is unchanged but the RESOLVE_PARTIAL-LOW gate it exercises now enforces a real check.

9. **Admin PIN set:**
   - In the admin UI at `settings/employees`, select a supervisor employee, set `is_supervisor = true`, and enter a new PIN. The PIN is hashed via argon2id; the audit row records action `SUPERVISOR_PIN_SET` with no hash in the payload.

**Deferred to P6 (from P5):**

- Unlock throttle if tablets leave the LAN: per-station attempt counter with exponential back-off. Current mitigation: station scan-token boundary + LAN-only deployment + audit trail. PIN-set may also move to OWNER-only role if role tiers tighten. OPEN — moved to post-overhaul backlog.
- Post-commit audit outside transaction: `supervisorClaimBagAction` writes the `floor.supervisor.manual_bag_claim` audit row after the claim transaction commits, matching the `releaseQaHold` precedent. This is a pre-existing design class — the audit is still reliable but not atomically coupled to the write. OPEN — moved to post-overhaul backlog.
- Downtime-end flow: `DOWNTIME_ENDED` event type exists but nothing emits it. Downtime exceptions age off the rail after 4 hours rather than being resolved. CLOSED — P6 Task 6; `raiseDowntimeEnded` + `resolveDowntimeAction` + `[ Resolved ]` button on admin Act Now rail.
- `damagedPackaging` rework-field decision (carried from P4b): CLOSED — P6 Task 5 (2026-08-17 user decision). The operator screen now collects packaging-material damage via the `damagedPackaging` CompletionInput field.
- Data-driven routes, barrel curation (carried from P4b P6 list). `read_queue_state` double-count: CLOSED — P6 Task 5; SEALING_QUEUE/POST_BLISTER_STAGING and PACKAGING_QUEUE/POST_SEAL_STAGING now use read_bag_queue.queue_stage_key for disambiguation.
- Value-pinned duplication guards (carried from P4b P6 list). CLOSED — P6 Task 6.

## Phase 6 outcomes

Branch `worktree-production-engine-p6`. Version: `1.35.0` → `1.36.0`.

**What shipped:**

- **Migration 0074** (`drizzle/0074_handpack_route_operation.sql`): `HANDPACK_BLISTER` operation type row and route_operations row on CARD_BLISTER. `resolve-operation.ts` drops the HANDPACK_BLISTER alias from `STATION_KIND_ALIAS`; `COMPLETE_EVENT_FOR_OPERATION` maps it to `HANDPACK_BLISTER_COMPLETE`. Station-event-mapping pins extended to 0074.

- **Data-driven route twins** (`lib/production/engine/route-data.ts`): `loadRouteGraph()` (process-lifetime cache); pure twins `queueAfterWorkAtFromGraph`, `queueRankFromGraph`, `queueKeysForStationKindFromGraph`. Parity pins against transcribed fixtures (0013+0071+0074 migration-text guards) prove twin === hardcoded for every (route, stationKind) in the enumerated matrix including bottle narrowing and sticker-only cases.

- **Consumers switched; subsumed tables deleted** (P6 Task 3): `queue-transitions.ts` and `floor-event-relevance.ts` resolve from the graph. Deleted: `queueAfterWorkAt` route map, `QUEUE_RANK`, `queueKeysForStationKind` table. Survivors with why-comments: `EVENT_STAGE_PREREQ`, `STATION_PICKUP_FROM_STAGE`, `STATIONS_THAT_FINALIZE`, `bothBottleFinishingDone`.

- **Legacy action retirement** (P6 Task 4): 8 dead actions removed (`fireStageEventAction`, `releaseBagAction`, `finalizeBagAction`, `packagingCompleteAction`, `saveSealingProductAction`, `resolveScannedBagAllocationAction`, `lookupCardByTokenAction`, `verifyVendorBarcodeAction`). Survivors listed with reasons.

- **Damaged-packaging field + queue-state disambiguation** (P6 Task 5): `damagedPackaging` CompletionInput key added to PACKAGING_OPERATIONS branch; `buildRecordPackagingCompleteInput` maps it (absent → 0). `read_queue_state` SEALING_QUEUE/POST_BLISTER_STAGING and PACKAGING_QUEUE/POST_SEAL_STAGING use `read_bag_queue.queue_stage_key` for non-overlapping counts.

- **Cleanup ledger closeout** (P6 Task 6): `blockerForWithDetail` parameterized factory in `resolve-exceptions.ts` (4 dynamic-detail codes — ADVANCE_FAILED, ADVANCE_REJECTED, OPEN_ALLOCATION_ON_BAG, PRODUCT_ASSIGN_REJECTED — moved from inline literals to catalogue-backed construction); value-pin tests for `FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS` and `FRESH_BAG_STATION_KINDS` extract set literals from source and assert equality; `raiseDowntimeEnded` engine function + `resolveDowntimeAction` admin server action + `[ Resolved ]` button on Act Now rail; DOWNTIME_ENDED added to non-progression pin; STAGE_DEFS structural pin added.

**Post-overhaul backlog (honest opens):**

- Unlock throttle off-LAN: no per-station attempt counter or exponential back-off yet. Current mitigation is station scan-token boundary + LAN-only deployment + audit trail.
- Post-commit audit outside transaction: `supervisorClaimBagAction` and `releaseQaHold` write their audit rows after the transaction commits. Reliable but not atomically coupled to the write. Belongs to a broader refactor pass.
- Camera-scanner DOM harness: the floor PWA has no automated browser test exercising the QR scanner input pathway; coverage relies on manual smoke checks.
- Inactive-station self-recovery: the inactive-station page does not mount the SSE refresher, so re-activating a station requires a manual reload rather than self-recovering within 60s.
