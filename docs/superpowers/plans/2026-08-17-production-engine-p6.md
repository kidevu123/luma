# Production Engine — Phase 6 Implementation Plan (data-driven routes + retirement)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine's route knowledge moves from hardcoded tables to `route_operations` data (with parity pins proving equivalence before anything is deleted), dead legacy floor actions are retired, the accumulated cleanup ledger closes, and the packaging screen regains its damaged-packaging field (user decision 2026-08-17).

**Architecture:** Data-driven resolution lands BEHIND parity: each hardcoded table (`queueAfterWorkAt`'s route map, `QUEUE_RANK`, `queueKeysForStationKind`) gains a data-backed twin sourced from `route_operations` (via a cached loader — route data changes only by migration), plus a parity test asserting twin === table for every seeded route; only tables whose twins prove out are deleted, and guards with independent value (`EVENT_STAGE_PREREQ` — the stage-progression safety net) explicitly SURVIVE with a comment saying why. Legacy actions are deleted only when caller-count is zero (grep-proved per action). The `HANDPACK_BLISTER` gap gets its real fix: a route operation row (migration 0074).

**Tech Stack:** unchanged. **Spec:** `docs/superpowers/specs/2026-08-11-production-engine-operator-experience-design.md` (P6 row of the phasing table + "Legacy tables to migrate" list — treat the list as CANDIDATES gated on parity, not a deletion order). Ledger inputs: `docs/superpowers/plans/2026-08-11-production-engine-p1-outcomes.md` P4b/P5 sections.

## Global Constraints

- No emoji. TypeScript strict. No DB in tests — the data-driven loaders are thin; parity pins run against FIXTURES transcribed from migrations 0013+0071+0074 with the established migration-text guard pattern; staging smoke covers live-data parity.
- Boundary stays 0/`"error"`. Audit/workflow-event invariants unchanged. Suite 0 failures after every task (5334/0 at branch); typecheck/lint 0 errors; build green.
- Deletions require PROOF: for tables, a passing parity twin; for actions, a zero-caller grep listed in the report; for scanner tests of deleted code, per-deletion justification naming replacement coverage.
- Migration 0074: journal idx 73, `when` 1785300000000 (verify tail = idx 72/1785200000000); additive only.
- Version `1.35.0` → `1.36.0` final task; bracketed CHANGELOG. Do NOT push.

---

### Task 1: Migration 0074 — HANDPACK_BLISTER route operation + damaged-packaging survey

`drizzle/0074_handpack_route_operation.sql`: insert an `operation_types` row `HANDPACK_BLISTER` ("Handpack blister", requires_scan/counter true, output cards) if absent, and a `route_operations` row on CARD_BLISTER — same stage/next keys as BLISTER (`BLISTER_QUEUE`→`POST_BLISTER_STAGING`), `allowed_station_kind='HANDPACK_BLISTER'`, sequence: pick the convention 0013 uses for parallel-entry ops — REs: sequence must not collide with the unique (route_id, sequence); use the next free sequence with a comment that entry ops are rank-equivalent via stage keys, not sequence. Update `resolve-operation.ts`: `STATION_KIND_ALIAS` drops HANDPACK_BLISTER (COMBINED alias stays, commented); `intentToEventType`'s override table keeps working (verify: the new op's code HANDPACK_BLISTER must map to HANDPACK_BLISTER_COMPLETE — extend `COMPLETE_EVENT_FOR_OPERATION` and delete the station-kind override if now redundant; keep whichever is simpler, state which). Update the station-event-mapping pins + fixtures (0074 rows added to SEEDED_ROUTES with the migration-text guard extended to 0074). Commit `feat(routes): HANDPACK_BLISTER as a real route operation (migration 0074)`.

### Task 2: Data-driven route twins + parity pins

`lib/production/engine/route-data.ts`: cached loader `loadRouteGraph()` (process-lifetime like station-kind-cache; route data changes only by migration — comment) returning per-route ordered operations with stage keys/kinds/groups from `getRouteOperations`. Pure twins derived from a `RouteGraph` value: `queueAfterWorkAtFromGraph`, `queueRankFromGraph`, `queueKeysForStationKindFromGraph` — semantics identical to the hardcoded versions incl. bottle order-independence via `orderIndependentGroup` and the finishing-destination narrowing. Parity test: build the graph from a FIXTURE transcribed from 0013+0071+0074 (migration-text guards) and assert twin(graph) === hardcoded for EVERY (route, stationKind, priors-subset) in an enumerated matrix — the matrix must include the bottle narrowing cases and sticker-only. NO production caller switches yet. Commit `feat(routes): data-driven route twins with exhaustive parity pins`.

### Task 3: Switch the consumers; delete subsumed tables

Switch `queue-transitions.ts` (projector path) and `floor-event-relevance.ts` to the graph twins — the graph value threads in from the callers' existing load points (projector: alongside its other per-event reads, using the cached loader; SSE route: at connect). Delete the now-subsumed hardcoded tables (`queueAfterWorkAt`'s route map, `QUEUE_RANK`, `queueKeysForStationKind`'s table) — the parity pins RETARGET to assert graph-vs-transcribed-fixture (they become the honest guard). SURVIVORS with why-comments: `EVENT_STAGE_PREREQ` + `checkStageProgression` (independent write-path safety net), `STATION_PICKUP_FROM_STAGE` (claim guards), `STATIONS_THAT_FINALIZE`, `bothBottleFinishingDone`. The spec's deletion list is thereby PARTIALLY executed — document the survivor rationale in the outcomes doc (deviation from spec's list, justified). Full suite + projector/SSE behavior unchanged by parity. Commit `feat(routes): queue and relevance resolve from route data; subsumed tables deleted`.

### Task 4: Legacy action retirement

For each legacy floor action still exported from `actions.ts` (`fireStageEventAction`, `releaseBagAction`, `releaseSealingHandoffAction`... wait — sealing handoff is LIVE in the new UI; enumerate first): grep callers repo-wide; DELETE actions with zero non-test callers (body already lives in engine modules where extracted) + their scanner-test slices (justified per deletion); actions still referenced (sealing handoff, pause/resume, sessions, QC, rolls, allocation, variety) STAY. Expected dead: fireStageEventAction, releaseBagAction, finalizeBagAction, packagingCompleteAction, saveSealingProductAction, resolveScannedBagAllocationAction, lookupCardByTokenAction, verifyVendorBarcodeAction — VERIFY each, delete only proven-dead, list survivors + reason. actions.ts shrinks accordingly; the OP-1/verify-script anchors repoint where scanned text moves (source-loading only). Commit `feat(floor): retire dead legacy actions`.

### Task 5: Damaged-packaging field (user decision) + read_queue_state honesty

(a) Packaging stations get a second compact input: `resolve-completion.ts` packaging branch adds `{key:"damagedPackaging", label:"Damaged packaging", unit:"units", required:false}` (extend the `CompletionInput` key union + `AdvanceInput.inputs`); `buildRecordPackagingCompleteInput` maps it (replacing the hardcoded 0) with presence semantics; screen renders it (CompletionInput-driven, no special-casing); tests through both mappers; update the P4b outcomes follow-up as closed. (b) `read_queue_state`'s documented double-count (SEALING_QUEUE vs POST_BLISTER_STAGING ambiguity) resolves using `read_bag_queue`'s claim data: read its header, implement the disambiguation it describes as now-possible, keep the honest-data comments accurate. Commit `feat(floor): damaged-packaging input restored; queue-state disambiguation`.

### Task 6: Cleanup ledger closeout

- `ADVANCE_REJECTED`/`ADVANCE_FAILED` → parameterized `blockerFor` factory (the third dynamic-detail code arrived with P5's gates — recheck; if still two, leave with an updated comment and say so).
- Value-pin the P4b inline duplications (`FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS` + predicate, `FRESH_BAG_STATION_KINDS`): a test importing both modules' SOURCE, extracting the literals, asserting equality (not name-mentions).
- Downtime-end: minimal `raiseDowntimeEnded` mirroring raise-downtime + a `[ Resolved ]` action on the rail's downtime rows (admin-authed, mirrors Task-P5-6's acknowledge pattern); DOWNTIME_ENDED event exists in the enum since Phase A — verify projector non-progression pin extends to it.
- Sweep the outcomes doc: mark every closed item with commit refs; whatever remains open moves to a final "Post-overhaul backlog" section (unlock throttle if off-LAN; post-commit-audit-outside-tx class; camera-scanner DOM harness; anything else honest).
Commit `chore(engine): cleanup ledger closeout`.

### Task 7: v1.36.0 — the overhaul closes

Version; CHANGELOG `## [1.36.0] — <date>`; smoke section (route-data parity spot-checks on staging: card+bottle+sticker-only bags route identically pre/post; handpack station completes via its own operation; damaged-packaging field records and reaches the Zoho payload; downtime resolve flow; retired-action 404s are unreachable from any UI); outcomes doc final section: the overhaul is complete — one-paragraph summary of what the six phases delivered against the original spec, plus the post-overhaul backlog. Commit `chore(release): v1.36.0 production engine phase 6 — overhaul complete`.

---

## Exit criteria

Suite 0 failures; queue/relevance resolve from route data with parity-pinned fixtures; HANDPACK_BLISTER is a real operation; proven-dead actions gone, survivors listed; damaged-packaging field live end-to-end; ledger items closed or honestly moved to the backlog; boundary 0/error intact.
