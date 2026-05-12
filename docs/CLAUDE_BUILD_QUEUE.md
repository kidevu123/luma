# Claude Build Queue — Luma production-intelligence rebuild

**Source of truth.** Claude reads this file at the start of every session, finds the first unchecked phase, executes only that phase, runs build/tests, updates the checkbox here, posts a short completion report into `docs/CURRENT_PHASE_STATUS.md`, and stops.

Process discipline (mandatory):
- Read this file first. Find the first unchecked phase. Execute only that one.
- Do not jump ahead. Do not start visual polish unless the checkbox says so.
- Do not touch TabletTracker.
- Run typecheck + tests + build. Smoke-test if routes changed.
- Mark the phase complete only when its acceptance criteria are met.
- Append a 5-15 line completion report to `docs/CURRENT_PHASE_STATUS.md`.
- Stop and wait. Never invent work outside the checklist.

Hard guardrails (carry forward from CLAUDE.md):
- No cutover. No live Zoho sync. No PillTracker / TabletTracker writes. No merge to main.
- Honest-data discipline: HIGH / MEDIUM / LOW / MISSING confidence everywhere.
- No emojis anywhere — code, UI, commits.
- Plan doc required for any phase whose acceptance criteria don't fit on one screen.

---

## Completed phases

### [x] Phase A — Foundation (event types + read-model tables)
Migration `0001` enum bump (11 event types). Migration `0002` standards + read-model tables. Schema changes verified live via `npx tsx scripts/verify-schema.ts`. Typecheck clean.

### [x] Phase B — Production metrics types + helpers
`lib/production/types.ts` confidence ladder. `lib/production/metrics.ts` `derive*` core. Vitest installed. Tests added. `docs/METRICS_DICTIONARY.md` published.

### [x] Phase C — Read-model projectors
`read_queue_state`, `read_sku_daily`, `read_material_reconciliation`, `read_station_quality_daily` projector modules wired into `projectEvent`. `scripts/rebuild-read-models.ts` seed/replay tool. Projector tests in `lib/projector/*.test.ts`.

### [x] Phase D — Standards / Bag genealogy / Material reconciliation admin
Shared `MetricCard` + `ConfidenceBadge`. Standards admin (4 pages). Bag genealogy timeline. Material reconciliation page. Floor-board KPI strip + bottleneck through metric API. Sidebar + tests.

### [x] Phase E — Command center wiring
`deriveQueueAging` exposes avg/p90/status. Floor-board rewritten as command center. `/operator-productivity`. `/packaging-output`. Final verification clean. Staged on LXC 122.

### [x] Phase E.5 — Diagnostics module
`lib/production/diagnostics.ts` audit module. Floor-board diagnostic panels. Tests + verify + deploy.

### [x] Phase E.6 — Replay infrastructure
`scripts/replay-workflow-events.ts`. Synthesizer post-projection step. Tests + deploy.

### [x] Phase F — Legacy synthesizer enhancements
F.1 derive `machine_ids[]` in legacy synthesizer. F.2 extract `units_yielded` from legacy payloads. Replay + tests + verify.

### [x] Phase G — Synthesizer prod run
G.1 backup. G.2 preflight + dry-run flag. G.3 deploy + dry-run + real run.

### [x] Phase H foundation — Material inventory model
H schema (migrations 0011-0012). Helpers `lib/production/{packaging,roll-usage}.ts`. 8 `derive*` material functions. Read-model rebuilders. Admin pages: materials + BOM + standards + receiving.

### [x] H.x0 — Route / operation compatibility
Migration `0013_route_operation_compat.sql`. `lib/production/routes.ts` mapping helpers. Tests + doc update + verify.

### [x] H.x0.5 — Generic product structure / Zoho item foundation
Migration `0014_generic_item_structure.sql`. Helpers + Zoho stubs. Admin pages + docs + tests. (Stubs only — live Zoho sync remains pending.)

### [x] H.x1 / H.x2 — Material read models + material metrics
H.x1 read models built into the H foundation projectors. H.x2 derive helpers folded into `lib/production/metrics.ts`. Confidence-banded.

### [x] H.x3 — Material usage learning + reconciliation
Schema `0015`. Learning rebuilder. Derive helpers. Reconciliation. Projector hook on `BLISTER_COMPLETE` (counter-segment ledger). Tests + verify.

### [x] H.x3.5 — Raw-item weight standards
Schema `0016`. PO reconciliation derive functions. Pages + CSV export + tests.

### [x] H.x3.6 — Bag allocation / variety pack
Schema `0017`. Bag-allocation + variety-pack helpers. PO report extensions + CSV + tests.

### [x] H.x4 — Roll workflow (mount / unmount / weigh / change)
Server actions in `app/(floor)/floor/[token]/roll-actions.ts`: `mountRollAction`, `unmountRollAction`, `weighRollAction`, `changeRollAction`. Floor UI `app/(floor)/floor/[token]/rolls/page.tsx` + `rolls-forms.tsx` (v2E observable forms — pending/error/success banners). `lib/production/active-rolls.ts` + `lib/projector/roll-usage.ts`. Tests: `active-rolls.test.ts` (32) + `roll-segment-ledger.test.ts` (25). Battle-tested live during VALIDATION-2C (PVC Roll 1 + Foil Roll 1 mount, mid-bag change at 15238, all math reconciled).

### [x] H.x5 / H.x6 — Admin material UI + receiving
Admin pages for raw-material receiving + packaging materials shipped under H foundation. PackTrack receiving was layered on top in PT-1+.

### [x] PT-1 / PT-2 / PT-3 — PackTrack receipt foundation
Migration `0020_packaging_receipt_event_types.sql` (5 enum values). Migration `0021_packaging_lot_receipt_fields.sql` (9 nullable columns + accepted_quantity backfill + partial unique index on `(packtrack_receipt_id, box_number)`). `lib/inbound/packaging-receipt.ts` `computeAcceptance` + `classifyVarianceSeverity`. `lib/integrations/packtrack/receipts.ts` import orchestrator. `app/api/integrations/packtrack/receipts/route.ts` POST-only webhook with `x-packtrack-secret` header auth + `x-packtrack-dry-run` support. Structured JSON logging.

### [x] PT-4 — PackTrack admin / mapping / receipt validation
`scripts/register-packtrack.ts` idempotent setup. `/settings/integrations/packtrack` mapping admin (status panel + add-mapping form + deactivate action). `/packaging-receipts` list with filters + badges. `/packaging-receipts/[lotId]/adjust` cycle-count flow with `PACKAGING_RECEIPT_ADJUSTED` + `PACKAGING_VARIANCE_RECORDED kind=CYCLE_COUNT_VARIANCE`. End-to-end webhook validation: declared=100 / counted=98 → all 4 events + idempotent re-send.

### [x] OP-1A — Operator / employee identity model AUDIT
No code change. Findings recorded in chat (and condensed in `docs/CURRENT_PHASE_STATUS.md`). Key findings:
- `workflow_events.employee_id` (FK employees) and `workflow_events.user_id` (FK users) already exist on the table; never populated by `projectEvent`.
- `employees` table is the right backbone (already FK'd from `users.employee_id`); no new `operator_profiles` table required.
- `users.employee_id` exists; `currentUser()` does not surface it.
- Floor PWA is fully anonymous — no `currentUser()` calls under `app/(floor)`. Auth is the URL station scan token.
- Operator code is free text, persisted in `sessionStorage` per station. `fireStageEventAction` (BLISTER/SEALING/BOTTLE_*_COMPLETE counters) does NOT take an operator field at all today; UI fires a separate `OPERATOR_CHANGE` first if one is set.
- Roll mount/unmount/weigh/change actions accept no operator field at all.
- `PACKAGING_DAMAGE_RETURN` / `REWORK_SENT` / `SCRAP_RECORDED` / `SUBMISSION_CORRECTED` event types exist in the enum but have NO live emission path. Out of scope for OP-1.
- `read_operator_daily` is keyed on `text operator_code`; misspellings produce phantom operators.
- `deriveBagGenealogy` already joins `employees.fullName` via `workflow_events.employee_id` — display path is wired and silent only because the column is empty.

---

## Pending phases (work in this exact order)

### [x] OP-1B — Employee / accountability foundation
**Objective.** Establish a stable accountability identity for every count submission without a new operator-profiles table. Use the existing `employees` + `users` tables; populate the existing `workflow_events.employee_id` / `.user_id` columns; encode source + name snapshot in payload.

**Files likely touched.**
- `lib/db/schema.ts` — add `employee_code text` on `employees`; partial unique index `(employee_code) WHERE status='ACTIVE' AND employee_code IS NOT NULL`. No new tables.
- `drizzle/0022_employee_code.sql` — isolated migration, journal `when` strictly increasing.
- `lib/auth.ts` — extend `CurrentUser` with `employeeId: string | null`; populate from `users.employee_id` lookup. Token payload bumped only if absolutely necessary (prefer DB lookup at `currentUser()` time, cached per-request).
- `lib/projector/index.ts` — extend `EventInput` with optional `enteredByUserId`, `accountableEmployeeId`, `accountabilitySource`, `accountableEmployeeNameSnapshot`. First two write to `workflow_events.user_id` / `.employee_id`. Source + snapshot land in payload.
- `lib/production/accountability.ts` — new helper `resolveAccountableEmployee({employeeId, employeeCode, freeText})` returning `{accountableEmployeeId, accountableEmployeeCode, nameSnapshot, source}` (LOGGED_IN_USER / EMPLOYEE_PICKER / EMPLOYEE_CODE / BADGE_SCAN / SUPERVISOR_OVERRIDE / LEGACY_TEXT / MANUAL_TEXT). Pure-ish: takes a `db`/`tx` for code → employee lookup.
- `lib/production/accountability.test.ts` — pure-helper tests + integration test against the resolver.

**Acceptance criteria.**
- New migration applies cleanly on staging. Verify via `psql` that `employee_code` column exists and the partial unique works.
- Existing `projectEvent` callers continue to compile without modification (additive optional fields only).
- `currentUser()` returns `{id, email, role, employeeId}` for any logged-in admin whose `users.employee_id` is set.
- `resolveAccountableEmployee` returns LEGACY_TEXT with confidence-LOW marker for free text; resolves a known `employee_code` to the matching `employees.id`; returns null when nothing matches and the caller asks to be strict.
- No call site changed yet — this phase is plumbing only.

**Tests required.**
- `lib/production/accountability.test.ts` — at least 8 cases: empty, by id, by code (active/inactive/missing), by free text, source resolution per input shape, name-snapshot capture.
- One projector test that asserts `workflow_events.employee_id` and `.user_id` land non-null when `EventInput` includes them.

**Stop condition.**
Migration applied on staging. `currentUser()` exposes `employeeId`. `EventInput` extended. `resolveAccountableEmployee` shipped + tested. No call site rewired yet. Typecheck + tests + build green. Update this checkbox. Append OP-1B report to `docs/CURRENT_PHASE_STATUS.md`. Stop.

---

### [x] OP-1C — Wire count-submission forms + actions
**Objective.** Every live count-submission form requires (or defaults from station-operator-session) an accountable employee, and every server action propagates it through `projectEvent` to populate `workflow_events.employee_id` and the payload accountability fields.

**Files likely touched.**
- New: a station-operator-session table (`station_operator_sessions(id, station_id, employee_id, opened_at, closed_at, accountability_source)`) + migration. Operator picks/scans at shift start; clears at shift end. Floor station page reads the open session for the station and passes the employee through forms as the default accountable employee.
- `app/(floor)/floor/[token]/page.tsx` — render "Current operator: {name}" + "Switch operator" + "End shift" controls. Block first-op count submissions when no session is open.
- `app/(floor)/floor/[token]/actions.ts` — `fireStageEventAction`, `packagingCompleteAction`, `pauseBagAction`, `resumeBagAction`, `setOperatorAction`, `scanCardAction`, `releaseBagAction`, `finalizeBagAction` accept and forward `accountableEmployeeId`/`accountabilitySource`.
- `app/(floor)/floor/[token]/roll-actions.ts` — same on `mountRollAction`, `unmountRollAction`, `weighRollAction`, `changeRollAction`.
- `app/(floor)/floor/[token]/bag-allocation-actions.ts` — same.
- `app/(admin)/inbound/packaging-materials/actions.ts` — admin path defaults to `currentUser().employeeId`; explicit override allowed.
- `app/(admin)/packaging-receipts/[lotId]/adjust/actions.ts` — same.
- `app/(floor)/floor/[token]/stage-action-buttons.tsx` + `rolls-forms.tsx` — surface a "Who is submitting this count?" picker when no current operator session, or a "submit on behalf of" override for supervisors (LEAD/MANAGER/ADMIN/OWNER role required for the override path).
- New: server action + page for opening/closing the station-operator-session. Idempotent.

**Acceptance criteria.**
- Every submission route in the table from OP-1A §4 (rows 1-12, plus admin rows 13-14) writes `workflow_events.employee_id` non-null when an accountable employee is resolvable. Verify by querying `workflow_events` after a smoke run.
- Floor PWA refuses a first-op count submission when no station-operator-session is open AND no per-form override was supplied.
- Admin actions default `accountableEmployeeId` from the logged-in user's `employeeId`; admin can explicitly select a different employee (supervisor override path).
- `accountability_source` values land in payload exactly as specified in OP-1B.
- Free-text fallback (LEGACY_TEXT / MANUAL_TEXT) is allowed only when explicitly enabled per form, and is marked confidence LOW.

**Tests required.**
- New e2e-style tests for the floor `fireStageEventAction` family asserting `accountableEmployeeId` is required-or-defaulted-from-session and that the resulting `workflow_events` row has the expected `employee_id`.
- Tests for the supervisor-override path: non-supervisor submitting on behalf of someone else is rejected; LEAD+ allowed.
- Existing tests must continue to pass (the API additions are additive optional inputs with strict server-side fallbacks).

**Stop condition.**
All live count-submission paths populate `workflow_events.employee_id`. Smoke run on staging confirms a fresh BLISTER_COMPLETE row carries the right `employee_id`. Typecheck + tests + build + auth smoke green. Update checkbox + status doc. Stop.

---

### [x] OP-1D — Damages / rework / scrap / supervisor-correction wiring (optional within OP-1)
**Decision (2026-05-08): DEFERRED to the QC subsystem phase.** No code changed. The live QC forms do not exist today; building them now would expand OP-1 scope past the accountability charter. The OP-1B / OP-1C plumbing (`projectEvent` accepts `enteredByUserId`, `accountableEmployeeId`, `accountabilitySource`, `accountableEmployeeNameSnapshot`; admin actions resolve via `resolveAdminAccountability`; floor actions via `resolveStationAccountability`) is ready, so when the QC subsystem phase wires `PACKAGING_DAMAGE_RETURN`, `REWORK_SENT`, `REWORK_RECEIVED`, `SCRAP_RECORDED`, and `SUBMISSION_CORRECTED` they each get full accountability for free. See `docs/CURRENT_PHASE_STATUS.md` for the rationale.

**Objective (original).** Decide phase-by-phase: either (a) defer entirely to QC subsystem (recommended — these have no live UI today), or (b) ship a minimal supervisor-correction action that emits `SUBMISSION_CORRECTED` with full accountability, while leaving damage/rework/scrap to QC. Pick at start of phase, document in chat, execute. Default = defer.

**Files likely touched.**
- If deferred: zero. Update this checkbox and `docs/CURRENT_PHASE_STATUS.md` with the decision + rationale.
- If shipped: `app/(admin)/genealogy/[bagId]/correct/page.tsx` + `actions.ts`; emits `SUBMISSION_CORRECTED` with both `entered_by_user_id` (the supervisor) and `accountable_employee_id` (the original operator preserved from the corrected event).

**Acceptance criteria.**
- Decision recorded.
- If shipped: correction event preserves original `accountable_employee_id`; new event's `entered_by_user_id` is the supervisor; payload includes `previousEventId`, `correctionReason`.

**Tests required.**
- If shipped: 3 tests covering original-actor preservation, supervisor-role enforcement, and payload-shape assertion.

**Stop condition.**
Decision in `docs/CURRENT_PHASE_STATUS.md`. If shipped, build + tests green. Update checkbox. Stop.

---

### [x] OP-1E — Operator metrics switch to employee_id
**Objective.** Replace `operator_code` text-keyed productivity rollups with stable `employee_id`. Keep the text column for backward-compat reads of legacy data; new rows populate both. `deriveOperatorMetrics` switches grouping to `employee_id` when available.

**Files likely touched.**
- `lib/db/schema.ts` — add `employee_id uuid` to `read_operator_daily`. Composite unique on `(day, employee_id)` partial-unique where employee_id IS NOT NULL; keep existing `(day, operator_code)` unique for legacy.
- `drizzle/0023_operator_daily_employee_id.sql`.
- `lib/projector/index.ts` `projectMetricsForFinalizedBag` — write both `operator_code` (backward compat) and `employee_id`. Increment by employee when available, else by code (legacy).
- `lib/production/metrics.ts` `deriveOperatorMetrics` — group by `employee_id` when populated; fall back to code grouping; return both keys + the `employees.fullName` for label resolution.
- `app/(admin)/operator-productivity/page.tsx` — render employee name, fall back to code. Confidence LOW for code-only rows.
- `app/(admin)/floor-board/_components/operator-shift.tsx` — same.

**Acceptance criteria.**
- New finalized bag with accountable employee populates `read_operator_daily.employee_id`.
- Legacy `operator_code`-only rows still appear, marked LOW confidence + "code only" label.
- Operator leaderboard uses `employees.fullName` when known.

**Tests required.**
- Unit test: projector populates both columns on finalize.
- Unit test: `deriveOperatorMetrics` reconciles employee + code rows without double-counting.

**Stop condition.**
Migration applied. New rows carry `employee_id`. Leaderboard renders names. Typecheck + tests + build green. Update checkbox. Stop.

---

### [x] OP-1F — Tests + verification
**Objective.** Final regression sweep across the OP-1 surface. No new features.

**Files likely touched.** Test files only.

**Acceptance criteria.**
- All OP-1B/C/D/E tests passing.
- New test: OP-1 invariant scanner — for each event type that the floor emits live (BLISTER_COMPLETE, SEALING_COMPLETE, BOTTLE_*_COMPLETE, PACKAGING_COMPLETE, BAG_PAUSED/RESUMED, ROLL_*, BAG_RELEASED/PICKED_UP, MATERIAL_RECEIVED, etc.), at least one row in the test corpus has `employee_id IS NOT NULL`.
- Honest disclosure docs: `docs/CURRENT_PHASE_STATUS.md` lists which event types still don't populate accountability and why.

**Tests required.** see above.

**Stop condition.** Full suite passes. Status doc updated. Stop.

---

### [x] PT-6 — 8-bucket reconciliation
**Objective.** Replace ad-hoc PO reconciliation with the canonical 8-bucket model: declared, received, counted, accepted, consumed, scrapped, on-hand, variance. Each bucket has source + confidence.

**Files likely touched.**
- `docs/PT-6_RECONCILIATION_PLAN.md` (new — required before code).
- `lib/production/po-reconciliation.ts` rewritten around 8-bucket primitives.
- `app/(admin)/po-reconciliation/page.tsx` rendered in 8-bucket layout.
- New tests covering every bucket transition.

**Acceptance criteria.**
- Plan doc accepted.
- Every bucket has a `source` enum + `confidence` ladder.
- Variance rows distinguish receipt-variance vs cycle-count-variance vs consumption-loss.

**Tests required.**
- Pure-math reconciliation tests for each bucket combination (≥20).
- Integration test against synthesized PO with known declared/counted/consumed values.

**Stop condition.** Plan accepted. Code shipped. Tests green. Stop.

---

### [x] H.x7 — Material panels (4 read-only)
**Objective.** Build 4 read-only admin panels surfacing the existing material read models (already specified in chat history as completed under task #187). Verify whether this is genuinely live or whether the placeholder is a stub. If genuinely live, mark complete; if a stub, finish per spec.

**Files likely touched.**
- `app/(admin)/material/{page.tsx,...}` — confirm what exists.
- Audit first; build only what's missing.

**Acceptance criteria.**
- 4 panels render real read-model data with confidence badges.
- No emission of any new event types.

**Tests required.**
- Loader tests; smoke against staging.

**Stop condition.** Panels live. Tests green. Stop.

---

### [ ] QC subsystem — Damages / rework / scrap / supervisor-correction live
**Objective.** Build the live emission paths for `PACKAGING_DAMAGE_RETURN`, `REWORK_SENT`, `REWORK_RECEIVED`, `SCRAP_RECORDED`, `SUBMISSION_CORRECTED`. Every emission carries OP-1 accountability.

**Files likely touched.**
- New plan doc cross-referenced from `docs/QC_REWORK_DAMAGE_AND_COUNT_CONFIDENCE_PLAN.md`.
- New floor + admin actions for each event type.
- Read-model rebuild + display surfaces.

**Acceptance criteria.**
- Every QC event emits with full OP-1 accountability fields.
- Read models surface scrap / rework / damage cleanly with confidence ladder.
- `/operator-productivity` "rework" / "corrections" columns populate from real events.

**Tests required.**
- Per-event-type emission tests + invariant tests.

**Stop condition.** All five event types live. `/operator-productivity` columns populated. Tests + build green. Stop.

**Sub-phases:**

- [x] **QC-0** — plan doc only (`docs/QC_SUBSYSTEM_IMPLEMENTATION_PLAN.md`). 2026-05-12.
- [x] **QC-1** — migration `0026_qc_subsystem_foundation` + `lib/production/qc-events.ts` payload contracts + tests. Verified 2026-05-12: tsc clean / vitest 844/844 / next build clean / migration applied / 5 columns + 2 indexes on staging / auth-smoke 45/45 PASS.
- [x] **QC-2** — five server actions emitting through `projectEvent` with full OP-1 accountability + tests. Verified 2026-05-12: tsc clean / vitest 861/861 / next build clean / staging live at SHA `0e36936` / auth-smoke 45/45 PASS.
- [ ] **QC-3** — floor QC quick-action panel + rework receiving surface.
- [ ] **QC-4** — `/qc-review` admin page + correction modal + ad-hoc scrap modal.
- [ ] **QC-5** — read-model projectors, genealogy / operator-productivity / material-reconciliation integration.
- [ ] **QC-6** — staging verification + manual TEST D-QC + closeout.

---

### [ ] PackTrack shortage recommendations (PT-7)
**Objective.** Forward-looking projection: given current PackTrack inventory + Luma consumption rate, surface "running out of bottles in N days" recommendations. Read-only; no live re-order push. (PackTrack live writes remain explicitly out of scope.)

**Files likely touched.**
- `lib/production/packtrack-shortage.ts` (new) — pure projection helper.
- `app/(admin)/material-alerts/page.tsx` — extend with shortage panel.
- New plan doc.

**Acceptance criteria.** Plan doc shipped. Projection visible on alerts page with confidence + source labels.

**Tests required.** Pure-math tests against synthetic burn rates.

**Stop condition.** Live on staging. Stop.

---

### [ ] Command center visual polish
**Objective.** Density / brand pass on `/floor-board`, `/genealogy`, `/operator-productivity`, `/packaging-output` per `docs/FLOOR_UI_POLISH_REQUIREMENTS.md`. No data-model changes; no new event types; no honest-data drift.

**Files likely touched.**
- The four pages above plus `_components` under `floor-board`.
- Shared `MetricCard` / `ConfidenceBadge` only if a primitive needs adjusting.

**Acceptance criteria.**
- All pages match the polish requirements doc.
- Confidence badges + honest-disclosure language preserved.
- No regression in tests.

**Tests required.** Visual regression is out of scope; existing test suite must remain green.

**Stop condition.** Polish doc requirements met. Build green. Stop.

---

### [ ] Zoho live sync
**Objective.** Replace the H.x0.5 stub with a live Zoho item sync. Read + write. Reconcile against Luma `products` and `tablet_types`. Idempotent. Operator-friendly admin UI.

**Files likely touched.**
- `lib/integrations/zoho/*` — new.
- `app/(admin)/settings/integrations/zoho/*` — extend the existing page.
- Background pg-boss job.
- Plan doc cross-referencing `docs/ZOHO_ITEM_SYNC_PLAN.md` (already drafted).

**Acceptance criteria.**
- Zoho item read works against staging credentials.
- Write path is gated behind an explicit "Push to Zoho" admin action — never automatic.
- Conflict resolution surfaces in UI; operator chooses.

**Tests required.**
- Mocked Zoho client tests.
- Integration test against the Zoho sandbox if available.

**Stop condition.** Manual end-to-end sync verified on staging. Stop.

---

### [ ] Nexus / QIP batch-complaint integration
**Objective.** Forward batch-complaint signals from Nexus / QIP into Luma so the affected `batches` rows can flip to HELD or RECALLED with audit + operator alert. Read-only inbound; no live writes back to Nexus / QIP from Luma.

**Files likely touched.**
- `lib/integrations/nexus-qip/*` (new).
- New webhook route under `app/api/integrations/nexus-qip/`.
- `lib/db/schema.ts` — possibly extend `batches` with `complaint_source` + `complaint_received_at`.
- Plan doc.

**Acceptance criteria.**
- Inbound webhook accepted, validated, idempotent.
- Affected batch transitions to HELD with audit + operator alert.

**Tests required.**
- Webhook validation + idempotency tests.

**Stop condition.** Webhook live + smoke-tested on staging. Stop.

---

## Anchor: spec-gap log

If, while executing a phase, you find something that the spec doesn't cover, post a single chat message tagged `spec-gap`, append a one-liner to `docs/CURRENT_PHASE_STATUS.md`, and continue without building it. Don't expand the queue mid-phase.
