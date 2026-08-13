# Production Engine — Phase 4b Implementation Plan (the operator screen)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tablet becomes the spec's single screen — station name, current work, one action, `⋮ More`, `? Help` — rendered from `StationView`'s NextAction cases, with scanning as the primary interaction; the legacy floor panels and their scanner tests retire, and the import boundary reaches zero and flips to `"error"`.

**Architecture:** `page.tsx` shrinks to `getStationView` + the new `<OperatorScreen view={...} token={...}>` client component (one render case per `NextAction` variant). `advanceBag`/`claimQueuedBag` become the ONLY write paths from the new UI. Two engine gaps close first (they gate the screen): `assignBagProduct` (P1-style extraction of `saveSealingProductAction`'s transaction) makes AUTO/PICK product resolution real, and the COMBINED-at-packaging routing gap closes in `resolve-operation`. The single exception workflow lands with migration 0072 (`PRODUCTION_EXCEPTION_RAISED`, projector non-progressing).

**Spec:** `docs/superpowers/specs/2026-08-11-production-engine-operator-experience-design.md` — "The operator screen", "Exceptions", "? Help" sections govern copy and layout. **P4b entry notes:** `docs/superpowers/plans/2026-08-11-production-engine-p1-outcomes.md` (P4a section + Known gaps).

## Global Constraints

- No emoji IN THE PRODUCT (UI uses Lucide icons + chips + text — repo convention). No emoji in code/tests/docs either.
- TypeScript strict; no DB in tests (pure logic + staging smoke); scanner-test edits legitimate ONLY where behaviour intentionally changes (this phase retires many — each deletion justified in the report by naming the replacement coverage).
- Extractions are verbatim relocations (P1 Task 7 discipline, verbatim-diff count in report).
- Suite 0 failures after every task (5462/0 at branch); typecheck/lint clean; build green.
- Boundary ratchet: 75 at branch → must reach 0 in Task 6, then severity flips to `"error"` and the ratchet test is replaced by the two lint probes.
- Version `1.33.0` → `1.34.0` final task; bracketed CHANGELOG header.
- THIS PHASE IS THE OPERATOR-VISIBLE REWRITE. The old and new screens must not coexist: the cutover is one task (Task 5), everything before it ships invisible.
- Do NOT push.

---

### Task 1: `assignBagProduct` extraction + AUTO becomes real

P1-style verbatim extraction of `saveSealingProductAction`'s transaction body (`actions.ts` ~1139-1257: product update + `PRODUCT_MAPPED` + `ensureOpenRawBagAllocationSessionForWorkflowBag` + audit) into `lib/production/engine/assign-bag-product.ts`; action delegates; barrel export. Then `advanceBag` accepts `intent: "COMPLETE"` with `productId` at sealing by calling `assignBagProduct` first when the bag has no product (mirroring the action sequence save-then-complete), and `getStationView`'s AUTO case stays display-only (the SCREEN auto-submits AUTO picks — engine stays explicit). Scanner splice per precedent. Commit `feat(engine): assignBagProduct extraction; product assignment through advanceBag`.

### Task 2: COMBINED-at-packaging routing + migration 0072

- `resolve-operation.ts`: COMBINED stations resolve BLISTER as today EXCEPT when the gesture is packaging-shaped — add `pickOperationForStationKind(ops, stationKind, opts?: { preferOperation?: string })`; `advanceBag` passes `preferOperation: "PACKAGING"` when the intent's inputs carry cases/displays/loose; pure tests for both routes. (The legacy `ALLOWED_EVENTS_BY_KIND.COMBINED` list is the behaviour reference.)
- Migration `0072_production_exception_event.sql`: `ALTER TYPE workflow_event_type ADD VALUE IF NOT EXISTS 'PRODUCTION_EXCEPTION_RAISED';` + journal (idx 71, when 1785100000000, strictly increasing). Projector: non-progressing (no STAGE_FOR_EVENT entry, no throughput column, FLOW_EVENTS untouched) — add an explicit test pinning non-progression. Engine `raiseProductionException({stationId, workflowBagId?, category, detail, clientEventId})` emitting the event with accountability; barrel export; OP-1 LIVE_EMISSION_FILES.
Commit `feat(engine): combined packaging routing; production exception event`.

### Task 3: The OperatorScreen component (parallel file, unmounted)

`app/(floor)/floor/[token]/operator-screen.tsx` (+ pure helpers colocated in `lib/production/engine/operator-screen-model.ts` where logic exceeds rendering). Renders from `StationView` per the spec's table: OPEN_SHIFT (operator picker + Open shift), SCAN_TO_CLAIM (camera via existing `camera-scanner.tsx` + `UP NEXT` from `view.upNext[0]` + typed-code fallback under More), PICK_PRODUCT (2-3 filtered buttons; single-option AUTO auto-submits), COMPLETE (progress + `CompletionInput[]`-driven fields + DONE), CONFIRM_BAG_EMPTY (two buttons), RESOLVE_PARTIAL (estimate/entry per spec), BLOCKED (operatorSentence + `[ Why? ]` opening the Help checklist). Chrome: station label; `⋮ More` (Pause w/ reason — reuse pause action; Change material → rolls page link where kind applies; Report problem → Task 4's flow; Enter code manually; End shift); `? Help` renders `evaluateChecks` results as the spec checklist. All writes via `advanceBag`/`claimQueuedBag`/`raiseProductionException`/existing pause+session actions (barrel-only imports). NOT mounted — page.tsx untouched; component tested via pure model tests (case selection, input assembly, auto-submit rule). Commit `feat(floor): OperatorScreen component (unmounted)`.

### Task 4: Single exception workflow

`app/(floor)/floor/[token]/report-problem.tsx` per spec: six category buttons → one follow-up (machine: which machine → pause+DOWNTIME_STARTED; quality: QA_HOLD_STARTED; bag: BAG_PAUSED; material/product/other: `raiseProductionException`) — reuse existing actions/events per spec's mapping table; everything lands on the Act Now rail (verify `act-now.ts` picks up DOWNTIME/QA events; add `PRODUCTION_EXCEPTION_RAISED` to its query). Wire into More + BLOCKED. Commit `feat(floor): single exception workflow`.

### Task 5: THE CUTOVER

`page.tsx` main render path becomes: resolve station → `getStationView` → `<FloorLiveRefresh>` + `<OperatorScreen>`. Delete the ~15 inline resolutions, panels, `stage-action-buttons.tsx` usage, `scan-card-form.tsx` usage from the main path (files may remain if other routes use them; otherwise delete file + its scanner tests, each deletion justified: "coverage replaced by <engine test> / obsolete behaviour"). `/floor/[token]/rolls` and QC panel links surface under More (supervisor-gating is P5). Inactive-station branch mounts FloorLiveRefresh (self-recovery). Also: bag-allocation + variety-pack pages keep their existing entry links under More. THIS is the visible change; `npm run build` + full suite + a written manual-render checklist in the report (every NextAction case reachable). Commit `feat(floor): operator screen cutover`.

### Task 6: Boundary to zero and `"error"`

Remove/rewire every remaining direct `@/lib/production/*` import under `app/(floor)` (count at branch: 75; the cutover should eliminate most). Engine barrel gains any legitimately-needed re-export (each justified). Flip severity to `"error"`; replace the ratchet test with the two probes asserting blocked/allowed; delete `BASELINE_VIOLATIONS`. Commit `feat(engine): floor import boundary at zero, enforced as error`.

### Task 7: subscribers gauge + v1.34.0

`notify-bus.ts` exports `subscriberCount()`; expose on `/api/health` payload (tiny; read health route first). Version 1.34.0; CHANGELOG; smoke: full operator-flow walkthrough per station kind (scan→work→done→auto-advance), exception flow, Help checklist, PICK_PRODUCT both paths, partial flow, the previously-not-executable engine-packaging item now EXECUTABLE (unlabel it), COMBINED packaging via preferOperation, boundary error enforcement note; outcomes doc P4b section. Commit `chore(release): v1.34.0 production engine phase 4b`.

---

## Exit criteria

Suite 0 failures; boundary 0 at `"error"`; the tablet shows the spec's screen; every write path from the new UI goes through the engine; smoke checklist covers the full operator flow; `page.tsx` under ~200 lines.

## Deferred to P5/P6

Supervisor PIN + `station_supervisor_sessions` + panel moves + manual override under supervisor unlock (P5); data-driven `queueAfterWorkAt`/`resolve-operation` from route_operations + legacy table deletion + `read_queue_state` double-count fix (P6).
