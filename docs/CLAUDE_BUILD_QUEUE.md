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

### [x] QC subsystem — Damages / rework / scrap / supervisor-correction live
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
- [x] **QC-3** — floor QC quick-action panel + rework receiving surface. Verified 2026-05-12: tsc clean / vitest 876/876 / next build clean / staging live at SHA `c0393da` / packaging floor page renders panel markers; auth-smoke 45/45 PASS.
- [x] **QC-4** — `/qc-review` admin page + correction modal + ad-hoc scrap modal + partial-rework receive. Verified 2026-05-12: tsc clean / vitest 901/901 / next build clean / staging live at SHA `93f5bd5` / `/qc-review` returns 200 under admin auth; auth-smoke 46/46 PASS (was 45 + the new route).
- [x] **QC-5** — read-model projectors, genealogy / operator-productivity / material-reconciliation integration. Verified 2026-05-13: migration 0027 applied (3 new read_bag_state flags + partial index live) / tsc clean / vitest 919/919 / next build clean / staging live at SHA `aee76f3` / auth-smoke 46/46 PASS.
- [x] **QC-6** — final QC subsystem verification + closeout. Verified 2026-05-13: tsc clean / vitest 919/919 (123/123 across QC-touched files) / next build clean / staging live at SHA `aee76f3` / migration 0027 applied / read_bag_state QC flags + read_operator_daily QC counters + workflow_events QC indexes all present / all five QC enum types still in workflowEventTypeEnum / auth-smoke 46/46 PASS / `/qc-review`, `/operator-productivity`, `/genealogy/[bagId]`, `/po-reconciliation-v2`, `/material-alerts` all return 200 / live damage/rework/scrap event counts = 0 (no production damage on staging yet — expected); 460 legacy SUBMISSION_CORRECTED events present from pre-QC-5 synthesizer (forward-only projector is a documented limitation, not a bug).

---

### [x] PackTrack shortage recommendations (PT-7)
**Objective.** Forward-looking projection: given current PackTrack inventory + Luma consumption rate, surface "running out of bottles in N days" recommendations. Read-only; no live re-order push. (PackTrack live writes remain explicitly out of scope.)

**Files likely touched.**
- `lib/production/packtrack-shortage.ts` (new) — pure projection helper.
- `app/(admin)/material-alerts/page.tsx` — extend with shortage panel.
- New plan doc.

**Acceptance criteria.** Plan doc shipped. Projection visible on alerts page with confidence + source labels.

**Tests required.** Pure-math tests against synthetic burn rates.

**Stop condition.** Live on staging. Stop.

**Sub-phases:**

- [x] **PT-7A** — plan doc only (`docs/PACKTRACK_SHORTAGE_RECOMMENDATIONS_PLAN.md`). 2026-05-13.
- [x] **PT-7B** — pure shortage calculation helpers (`lib/production/packtrack-shortage.ts`) + 59 fixture tests. No DB. Verified 2026-05-13: tsc clean / vitest 1036/1036 / next build clean.
- [x] **PT-7C** — migration 0029 (`read_material_recommendations` table + 3 ordering fields on `packaging_materials`: `min_order_quantity` / `safety_buffer_percent` / `order_multiple`). `lib/projector/packtrack-recommendations.ts` rebuilder hydrates `ShortageRecommendationInput` from live read models, skips PVC / FOIL / BLISTER_FOIL, derives product scope from PBOM-2 (0 or 2+ products → material-wide; exactly 1 → product-scoped), preserves `acknowledged_at` / `dismissed_at` / `recommendation_id` across rebuilds, deletes stale active rows, leaves operator-touched rows untouched. Wired into `scripts/rebuild-read-models.ts`. 15 stub-tx tests cover kind filtering / scope inference / sendable gating / MOQ + order-multiple flow / upsert preservation. Verified 2026-05-13: tsc clean / vitest 1052/1052 / next build clean / staging live at SHA `f004a1a` / migration 0029 applied / `read_material_recommendations` table + 3 new `packaging_materials` columns present / auth-smoke 47/47 PASS.
- [x] **PT-7D** — `/material-alerts` shortage-recommendations panel reading from `read_material_recommendations` (PT-7C). New `lib/db/queries/material-recommendations.ts` loader with pure in-memory `filterRecommendations` helper + `countRecommendations`. New `app/(admin)/material-alerts/_recommendations-panel.tsx` client component (filters: status / severity / confidence / sendable / missing-config / product / material). New `app/(admin)/material-alerts/actions.ts` server actions `acknowledgeMaterialRecommendationAction` + `dismissMaterialRecommendationAction` — both `requireAdmin`, both idempotent, both write `audit_log`, dismiss appends a `[dismissed: ...]` tag to `warnings[]`. Banned-language scan extended to the 4 new files. **No PackTrack call** — PT-7E is the outbound integration. 21 new tests (16 filter / 5 action). Verified 2026-05-13: tsc clean / vitest 1074/1074 / next build clean / staging live at SHA `e56812f` / `/material-alerts` returns 200 / auth-smoke 47/47 PASS.
- [x] **PT-7E** — outbound PackTrack recommendation client. New `lib/integrations/packtrack/recommendations.ts` (`validatePackTrackRecommendationConfig`, `buildPackTrackRecommendationPayload`, `sendRecommendationToPackTrack`, `mapPackTrackRecommendationResponse`). Migration 0030 adds `sent_at` + `last_sent_response` to `read_material_recommendations`. New action `sendMaterialRecommendationToPackTrackAction` — gates every send by acknowledged / not-dismissed / sendable / confidence ≠ MISSING / qty > 0 / config present; writes `sent_at` + `last_sent_response` on success, `last_send_error` on failure; idempotent header `x-luma-recommendation-id`; secret header `x-luma-packtrack-secret`. `/material-alerts` panel grows a "Send to PackTrack" button when all gates pass and shows "Send blocked: <reason>" otherwise. `/settings/integrations/packtrack` page gains a recommendation-handoff status card. No auto-send. No PO creation from Luma. 28 new tests (15 client + 8 send-action + 7 helper). Verified 2026-05-13: tsc clean / vitest 1093/1093 / next build clean / staging live at SHA `ef60c94` / migration 0030 applied / `sent_at` + `last_sent_response` columns present / `/material-alerts` + `/settings/integrations/packtrack` both 200 / auth-smoke 47/47 PASS / PackTrack env intentionally unset on staging → "PackTrack handoff not configured" surfaces honestly.
- [x] **PT-7F** — staging verification + closeout. Wrote `scripts/verify-pt7f.ts` (an in-container end-to-end harness) that seeds a QA recommendation row against `QA_TEST_DISPLAY_BOX`, acknowledges it (UPDATE + audit), spins up an in-process mock PackTrack receiver, sends through the outbound client with the mock URL/secret passed via `config` opt (no app env mutation, no restart), verifies the mock captured `x-luma-packtrack-secret` + `x-luma-recommendation-id` headers and the right JSON payload, persists `sent_at` + `last_sent_response` + audit, exercises the 500-failure branch (persists `last_send_error`, preserves prior `sent_at`), re-exercises the defensive gates (MISSING confidence + zero qty), confirms 3 audit-log entries land for the lifecycle, and deletes the QA row. Verified 2026-05-13: tsc clean / vitest 1093/1093 / next build clean / staging live at SHA `9923c2c` / migration 0030 applied / `sent_at` + `last_sent_response` + `last_send_error` columns present / `verify-pt7f.ts` exits 0 / auth-smoke 47/47 PASS. PackTrack endpoint env intentionally left unset on staging after verification.

---

### [x] Finished Lot / Recall Passport (LOT-1)
**Objective.** End-to-end recall surface that ties a supplier lot, an internal receipt number, a raw-bag QR, a finished lot trace code, a product+date, and (later) a customer/shipment into one queryable passport. Every link bidirectional. Honest-data confidence ladder reused from PT-6 / PT-7.

**Files likely touched.**
- `lib/db/schema.ts` — extend `inventory_bags`, `finished_lots`, `shipments`; new `finished_lot_raw_bags`, `finished_lot_outputs`, `finished_lot_packaging_lots`, `finished_lot_qc_events`, `customers`, `shipment_finished_lots`.
- `drizzle/0030_finished_lot_recall_passport.sql` (or split per LOT-1B vs LOT-1C).
- `lib/projector/finished-lot-passport.ts` (new) — rebuilder for the two projection tables.
- `app/(admin)/recall/page.tsx` (new) or extension of `/genealogy`.
- Raw-bag intake UI (`/inbound` extension or new sub-page).
- New plan doc.

**Acceptance criteria.** All six search axes (supplier lot / receipt # / raw QR / finished lot code / product+date / customer) resolve to the same passport. Forward trace from supplier-lot recall to affected customers. Confidence ladder visible in UI. No banned phrases.

**Tests required.** Pure-helper tests for QR-code generation + label payload + passport assembly; stub-tx tests for the projector; route smoke for the new pages.

**Stop condition.** Live on staging. Real seeded recall scenario walked end-to-end. Stop.

**Sub-phases:**

- [x] **LOT-1A** — plan doc only (`docs/FINISHED_LOT_RECALL_PASSPORT_PLAN.md`). 2026-05-13.
- [x] **LOT-1B** — schema migration + receiving bridge. Migration `0031_finished_lot_recall_passport` adds: `inventory_bags` gains `bag_qr_code` (unique partial) / `internal_receipt_number` / `declared_pill_count`; `finished_lots` gains `trace_code` (unique partial) / `packed_at` / `expires_at` / `finished_lot_code_alias`; `shipments` gains `customer_id`; new tables `customers` / `finished_lot_raw_bags` (bag-level M:N going one level deeper than `finished_lot_inputs`) / `finished_lot_outputs` / `finished_lot_packaging_lots` / `finished_lot_qc_events` / `shipment_finished_lots`. New `lib/production/recall-passport.ts` pure-helper module with 9 exported helpers (`buildInternalReceiptNumber`, `validateInternalReceiptNumber`, `normalizeSupplierLotNumber`, `buildRawBagQrPayload` + JSON variant, `getRawBagReceiptIdentity`, `buildFinishedLotTraceCode`, `validateTraceCode`, `rollupRecallConfidence`, `shouldExposeSupplierLot`). BAG- and FL- prefixes guarantee distinct scanner namespaces. 33 new tests. **No receiving UI** in this phase — backend-only; UI deferred to LOT-1C/LOT-1D per the prompt's "if too risky" carve-out. Print-policy decision per LOT-1A §7 #3 (trace_code customer-facing, internal_receipt_number internal). Customer-key decision per LOT-1A §7 #6 (Luma `customer_code` canonical; `zoho_customer_id` + `nexus_customer_id` nullable externals). Verified 2026-05-13: tsc clean / vitest 1126/1126 / next build clean / staging live at SHA `a9d6fb9` / migration 0031 applied / all 12 new column/table additions confirmed via psql / auth-smoke 47/47 PASS.
- [x] **LOT-1C** — finished-lot projector + recall-passport projection wiring. New `lib/projector/finished-lot-passport.ts` emits four projections per `finished_lots` row: `finished_lot_raw_bags` (HIGH from `workflow_bag.inventory_bag_id`, LOW fan-out from `finished_lot_inputs` batches, MISSING/skip when neither chain yields), `finished_lot_outputs` (LOOSE/DISPLAY/MASTER_CASE — zero counts skipped, never fabricated; `print_payload` jsonb snapshot carries trace_code + product but NEVER supplier_lot), `finished_lot_packaging_lots` (replays `material_inventory_events` where `workflow_bag_id` + `packaging_lot_id` are known), `finished_lot_qc_events` (5 QC types filtered by contributing workflow_bags via INSERT…SELECT ON CONFLICT DO NOTHING). Hooks: `lib/projector/index.ts` BAG_FINALIZED block (no-op when no finished_lots row exists; never auto-creates), `lib/db/queries/finished-lots.ts createFinishedLot()` (calls projector on insert), `scripts/rebuild-read-models.ts` (full rebuilder wired into the standard transaction). Trace-code policy: preserves existing; falls back to `FL-<finishedLotNumber>`. PROJECTOR-source outputs are DELETE+INSERT so re-runs reflect current counts; operator-added outputs are preserved via `print_payload->>'source'` source marker. 22 new pure-helper tests. **No receiving UI** — backend helpers from LOT-1B are ready; intake form fields deferred to LOT-1D per LOT-1B's documented carve-out. Verified 2026-05-14: tsc clean / vitest 1148/1148 / next build clean / staging live at SHA `61795d3` / rebuild script ran clean (0 finished_lots → 0 projected, no fake data) / 4 projection tables remain empty (expected, no finished_lots rows on staging) / auth-smoke 47/47 PASS.
- [x] **LOT-1D** — `/recall` search UI + `getRecallPassport` / `getForwardTrace` loaders. Six search axes: supplier_lot / internal_receipt_number / raw_bag_qr / finished_lot_trace_code / product_date_range / customer_date_range. New `lib/production/recall-passport-loaders.ts` (~520 lines) with bidirectional expansion (bags ↔ lots), parallel fetches, MIN-across confidence rollup, honest warnings + missingLinks (never invents data). Page fully rewritten with 8 passport sections (summary, warnings, raw bags, production genealogy with link to existing `/genealogy/<bagId>`, finished outputs, packaging/material, QC events, shipments/customers). Receiving bridge: `lib/db/queries/receives.ts createReceiveWithBoxes()` now pre-allocates bag UUIDs and stamps `bag_qr_code` (`BAG-<uuid>`) + `internal_receipt_number` (`<receive>-B<box>-<bag>`) + `declared_pill_count` on every new inventory_bag in one batched INSERT; `receive-wizard.tsx` shows operators a live preview of the format and explains the issuance discipline. `vendor_barcode` untouched. Sidebar entry "Recall lookup" was already present. 10 new tests. Banned-language scan extended. Verified 2026-05-14: tsc clean / vitest 1158/1158 / next build clean / staging live at SHA `3f26707` / `/recall` returns 200 under auth / new search panel renders all 6 kinds / empty-state surfaces honestly (staging has 0 finished_lots → "No matches" text) / auth-smoke 47/47 PASS.
- [x] **LOT-1E** — finished-lot label payloads + recall-passport CSV. New `lib/production/finished-lot-labels.ts` exports 6 helpers: `buildFinishedLotLabelPayload` (INTERNAL / CUSTOMER), `buildCustomerSafeLabelPayload`, `shouldExposeSupplierLotForCustomer`, `formatTraceCodeForPrint`, `buildRecallPassportCsv`, `getCsvHeaders`. Print policy enforced in code: trace_code is the customer-facing QR; internal_receipt_number stays internal; supplier_lot hidden by default and only flips visible on explicit `customers.supplier_lot_visible=true`; print_payload is a snapshot (not live recalc); missing fields render as the literal "missing" instead of blank. New `/finished-lots/[id]/labels` page renders side-by-side CUSTOMER + INTERNAL label cards, one per output (falls back to deriving from finished_lots counts when projector hasn't snapshotted). New `/recall/export.csv` GET route handler streams CSV with section-tagged rows (summary / raw_bag / output / packaging_lot / qc_event / shipment); toggle `?customer_supplier_lot_visible=true` for internal exports. `/recall` page gains 2 CSV-export buttons + "Print labels" button; `/finished-lots/[id]` page gains "Print labels" header button. **No new QR library added** — QR payload text is rendered explicitly so an external printer / encoder can pick it up; graphic generation deferred. 23 new tests. Banned-language scan extended. Verified 2026-05-14: tsc clean / vitest 1180/1180 / next build clean / staging live at SHA `1493cbf` / new routes present (`/finished-lots/[id]/labels`, `/recall/export.csv`) / auth-smoke 47/47 PASS.
- [x] **LOT-1F** — Nexus / QIP outbound handoff contract. Contract-only (no DB persistence — deferred to LOT-1G after the persistence shape on `shipment_finished_lots` is decided). New `lib/integrations/nexus/finished-lots.ts` (~340 lines) exports 6 helpers: `validateNexusConfig`, `buildNexusFinishedLotPayload` (schema_version=1.0, customer-safe by default; supplier_lot hidden unless `customers.supplier_lot_visible=true`; **never** carries `internal_receipt_number`; required-field guards on trace_code / nexus_customer_id / shipment), `buildNexusFinishedLotPayloadsForCustomer` (batch), `isFinishedLotSendableToNexus` (typed reasons), `sendFinishedLotToNexus` (POST with `x-luma-nexus-secret` + `x-luma-finished-lot-id` + `x-luma-trace-code` headers, 5 failure codes), `stripNexusSecret` (defensive redaction). New admin action `sendFinishedLotToNexusAction` (loads context, gates by `isFinishedLotSendableToNexus`, builds + posts payload; returns result without persistence). `/finished-lots/[id]/labels` page gains a read-only Nexus handoff status card (4 readiness checks + supplier-lot-visibility flag). No send button yet — operator can already see if a lot would be sendable. **No real Nexus POST attempted on staging** (env intentionally unset → "not configured" surfaces honestly). 28 new tests. Banned-language scan extended. Verified 2026-05-14: tsc clean / vitest 1208/1208 / next build clean / staging live at SHA `d5efb66` / auth-smoke 47/47 PASS / Nexus env unset → status card shows "not configured" / `/recall` + `/finished-lots/[id]/labels` still 200.
- [x] **LOT-1G** — staging verification + closeout. Migration 0032 adds `nexus_sent_at` / `nexus_last_sent_response` / `nexus_last_send_error` (+ partial index) to `shipment_finished_lots`. `sendFinishedLotToNexusAction` now persists send state in one transaction with `audit_log` entries (`nexus.finished_lot.send` / `nexus.finished_lot.send_failed`); failure path PRESERVES prior `nexus_sent_at` so a transient retry never wipes the last good send. New `_send-button.tsx` client component renders a gated "Send to Nexus" button on `/finished-lots/[id]/labels` with canonical copy "Send to Nexus creates a customer-facing finished-lot record for issue reporting. It does not create a complaint ticket." `scripts/verify-lot1g.ts` (~310 lines) is an in-container harness that seeds QA-only rows, spawns a mock Nexus receiver, exercises happy + 500-failure paths, asserts headers + payload + DB state, and cleans up. Verified 2026-05-14: tsc clean / vitest 1208/1208 / next build clean / staging live at SHA `30d5f24` / migration 0032 applied / 3 nexus_* columns present / `verify-lot1g.ts` exits 0 with all assertions passing / auth-smoke 47/47 PASS.

---

### [x] Command center visual polish
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

**Closeout (2026-05-14, SHA `41fa733`):** Polished 4 pages with minimal-diff edits, presentation-only:
- `/packaging-output` — promoted "Damage rate" + "On-time completion" from inline prose to first-class `MetricCard`s; new local `SectionTitle` (eyebrow + heading + inline subtitle + hairline divider).
- `/operator-productivity` — added a subtle "QC activity" pill next to operator names when damages + rework + scrap + corrections > 0; uses the same aesthetic as the existing "legacy code only" pill; no row-wide coloring.
- `/genealogy/[bagId]` — unmapped event types now render as a real default badge (slate border + slate-800 fill, same h-5 / px-1.5 rhythm as styled badges) with a `title` attr labelling them generic.
- `/floor-board` — bottle-line empty state now uses a status dot + horizontal layout + right-aligned `idle` tag, matching LaneRow rhythm; replaces the weak dashed-box prose.

No business-logic, loader, projector, migration, or formula changes anywhere. ConfidenceBadge / MetricCard primitives untouched. Dead `app/(admin)/floor-board/_components/` directory left in place for a separate cleanup phase. New `lib/production/command-center-polish.test.ts` adds 17 static guards (emoji regex against Unicode pictograph / dingbat blocks, banned-phrase scan, ConfidenceBadge presence). Verified 2026-05-14: tsc clean / vitest 1225/1225 / next build clean / staging live at SHA `41fa733` / all 4 polished routes return 200 / auth-smoke 47/47 PASS.

---

### [x] UI-2 — Command center design system
**Objective.** Codify the 5-tone visual vocabulary from the polish v1 work into a reusable component layer under `components/production/ui.tsx`, then apply it minimal-diff across 4 production-floor pages (`/floor-board`, `/material-alerts`, `/qc-review`, `/recall`).

**Files likely touched.**
- `components/production/ui.tsx` — new.
- The four target pages — section wrappers, alert callouts, empty states, identity blocks.
- `lib/production/command-center-polish.test.ts` — extend banned-phrase + emoji scan.

**Acceptance criteria.**
- 5 primitives (`ProductionStatusRail` / `ProductionSection` / `ProductionAlertCard` / `ProductionEmptyState` / `ProductionIdentityBlock`) plus a 5-tone vocabulary (`GOOD` / `WARN` / `CRITICAL` / `INFO` / `MUTED`).
- Imports only `cn` from `@/lib/utils` — no DB imports, no server-only imports.
- Minimal-diff application — no business-logic, loader, projector, migration, or formula changes.

**Tests required.** Static-guard scan extended; existing suite stays green.

**Stop condition.** Design system landed and applied on all 4 pages. Build green. Stop.

**Closeout (2026-05-14, SHA `ac5994c`):** 5-primitive design system landed and applied minimal-diff across `/floor-board` (bottle-lane idle row + "why metrics empty" amber section), `/material-alerts` (zero-alert empty state), `/qc-review` (three sections gain tone-driven rails), `/recall` (passport summary stats via `ProductionIdentityBlock`; two zero-state Cards via `ProductionEmptyState`). Polish test file grows from 4 to 8 scanned sources (added the three new pages + the design-system file itself); test count goes from 1225 → **1241 / 1241 PASS across 55 files**. Tone-rail vocabulary stays consistent (`TONE_RAIL` / `TONE_BORDER` / `TONE_BG` records). Six-axis `Stat` helper removed from `/recall` — `ProductionIdentityBlock` is now the only summary-stat renderer there. Verified 2026-05-14: tsc clean / vitest 1241/1241 / next build clean / staging live at SHA `ac5994c` / all 4 edited routes return 200 / auth-smoke 47/47 PASS.

---

### [x] ZOHO-0 — Zoho live sync audit + plan
**Objective.** Audit existing Zoho code (lib/zoho/client.ts, lib/integrations/zoho/items.ts, /settings/zoho, /settings/integrations/zoho-items, schema columns, env vars). Define ownership boundaries (Zoho / Luma / PackTrack). Map objects in/out. Phase the implementation. No code, no schema, no live writes.

**Stop condition.** `docs/ZOHO_LIVE_SYNC_PLAN.md` committed. Owner reviews.

**Closeout (2026-05-14, SHA `5b30b7f`):** 443-line plan doc landed at `docs/ZOHO_LIVE_SYNC_PLAN.md`. Findings: Luma writes zero data to Zoho today (`createPurchaseReceive` declared but never called). `lib/zoho/client.ts` does direct OAuth — contradicts CLAUDE.md's "go through the gateway" guidance. `ZOHO_INTEGRATION_URL` env var is plumbed but unread. Ownership: Zoho owns item / customer / SO / PO masters; Luma owns workflow / genealogy / QC / trace codes; PackTrack owns packaging PO workflow. Top open question for ZOHO-1: gateway vs direct-OAuth path.

---

### [x] ZOHO-1 — Zoho gateway config + status page + connectivity check
**Objective.** Wire Luma to the LXC Zoho integration gateway. Status / connectivity only — no item / customer / sales-order / PO sync. Connectivity probe writes one `zoho_sync_runs` row with `sync_type='CONNECTIVITY_CHECK'`. No live Zoho writes.

**Owner decisions baked in.**
- Gateway path locked in: `ZOHO_INTEGRATION_URL` (default `http://192.168.1.190:9503`). Direct OAuth path (`lib/zoho/client.ts`) stays for legacy `/settings/zoho` Test-connection button only.
- Optional shared secret via `ZOHO_INTEGRATION_SECRET` — sent as `x-luma-zoho-secret` header, never logged, never displayed.
- Luma stores zero Zoho tokens — the gateway owns them.

**Files touched.**
- `drizzle/0033_zoho_gateway_sync_runs.sql` — new enums `zoho_sync_kind` + `zoho_sync_run_status`; new tables `zoho_sync_runs` + `zoho_sync_state`.
- `lib/integrations/zoho/gateway.ts` — gateway client (validate / health / orgs / headers / strip-secret / map-error).
- `lib/integrations/zoho/gateway.test.ts` — 49 unit tests including static guards forbidding any POST/PUT/DELETE/PATCH and any direct-OAuth import.
- `app/(admin)/settings/integrations/zoho/{page,actions,test-connection-button}.tsx` — admin status page + connectivity-check action.
- `lib/db/schema.ts`, `drizzle/meta/_journal.json`, `scripts/smoke-authenticated-routes.ts` — schema + journal + auth smoke route.

**Stop condition.** New page reachable. Test connection button writes one CONNECTIVITY_CHECK row honestly. Build / vitest / auth smoke green. Stop. Do not start item / customer sync.

**Closeout (2026-05-14, SHA `1a6d09f`):** Connectivity-only Zoho gateway phase landed. Migration 0033 applied on staging; both enums + both tables present in psql; `zoho_sync_runs` count = 0 (no probe clicked yet). Gateway-on-`9503` does NOT currently listen on Proxmox — settings page will honestly surface `UNREACHABLE` until the gateway is brought up. Deploy initially hit the silent-fail-then-skip trap; recovered manually via `docker compose up -d --build` per the documented pattern. tsc clean / vitest 1290/1290 (+49 vs UI-2's 1241; +1 test file) / next build clean / staging live at SHA `1a6d09f` / `/settings/integrations/zoho` returns 200 / auth-smoke 48/48 PASS (up from 47). No Zoho writes anywhere; no items / customers / SO / PO sync attempted.

---

### [x] ZOHO-GW-1 — Locate + bring up the Zoho integration gateway
**Objective.** Find the existing Zoho API gateway and make its read-only health endpoint reachable from Luma. Operational phase — no code that touches Luma sync logic, no migration, no Zoho writes.

**Findings.** Gateway is LXC 9503 (`zoho-integration-service`) at `192.168.1.205:8000`. Auth via `X-Internal-Token`. Multi-brand (`boomin_brands` / **`haute_brands`** / `nirvana_kulture`). `/health` open, every other endpoint auth-protected. Orgs available via `/status` + `X-Brand`, NOT via a conventional `/organizations` path. `haute_brands` Zoho refresh tokens all currently expired.

**Wiring changes.**
- `docker-compose.yml` + `.env.example` + `deploy/lxc/install.sh` — flip `ZOHO_INTEGRATION_URL` default to real endpoint, plumb `ZOHO_INTEGRATION_SECRET` through compose explicit-env list.
- `/etc/luma/.env` on LX122 — secret pasted, value never echoed.
- `scripts/verify-zoho-gw-1.ts` — verification harness; mirrors `runConnectivityCheckAction` minus the auth wrapper.

**Closeout (2026-05-14, SHA `3d37edd`):** Connectivity check writes a real `zoho_sync_runs` row on staging — id `35f97003`, status `PARTIAL` (health=CONNECTED, orgs=GATEWAY_LACKS_ENDPOINT). Auth smoke 48/48 PASS. ZOHO-2 network/auth layer ready; gateway still needs operator re-authorization of `haute_brands` Zoho refresh tokens before item/customer reads will succeed.

---

### [x] ZOHO-GW-2 — Align Luma gateway client with real gateway contract
**Objective.** Update Luma's Zoho gateway client to match the real gateway's protocol: X-Internal-Token auth, X-Brand multi-brand selection, /status-based brand discovery, per-product token-status reporting, ZohoReadiness model.

**Files touched.**
- `lib/integrations/zoho/gateway.ts` — rewrite. New env `ZOHO_BRAND`. Headers: `X-Internal-Token` + `X-Brand`. New `fetchZohoBrandStatus`, `extractBrands`, `resolveBrandSelection`, `deriveZohoReadiness`. Old `fetchZohoOrganizations` kept as shim.
- `lib/integrations/zoho/gateway.test.ts` — 69 cases (up from 49). 3 static guards.
- `app/(admin)/settings/integrations/zoho/{page,actions,test-connection-button}.tsx` — surface readiness, selected brand, Zoho org id, per-product token status.
- `scripts/verify-zoho-gw-1.ts` — mirror new readiness path.
- `docker-compose.yml` + `.env.example` + `deploy/lxc/install.sh` — plumb `ZOHO_BRAND=haute_brands`.

**Closeout (2026-05-14, SHA `fdf7a63`):** Settings page shows `NEEDS_REAUTH` honestly because all `haute_brands` × {books, crm, expense, inventory} Zoho tokens are expired on the gateway side. tsc clean / vitest 1310/1310 / next build clean / auth smoke 48/48 PASS / verify-script exits 0 / `zoho_sync_runs` row `4432a636` persisted with status=PARTIAL. ZOHO-2 Luma-side ready; **blocked on operator re-authorizing the gateway's `haute_brands` Zoho refresh tokens (LXC 9503)**.

---

### [x] ZOHO-2A — Item + customer dry-run scaffolding (mocked-gateway tests)
**Objective.** Build the Luma-side dry-run engine and preview layer for item / customer sync. No live writes anywhere; mocked gateway responses in tests. When `haute_brands` tokens are refreshed, ZOHO-2B re-runs the same engine against live data.

**Gateway audit:** `GET /zoho/items/list` → `/inventory/v1/items`; `GET /zoho/contacts_inv/list` → `/inventory/v1/contacts`. Both require `X-Internal-Token` + `X-Brand`.

**Files touched.** `lib/integrations/zoho/items.ts` (replaces H.x0.5 stubs), `lib/integrations/zoho/customers.ts` (new), `lib/integrations/zoho/sync-dry-run.ts` (new — diff + orchestrator), 3 new test files, `app/(admin)/settings/integrations/zoho/{page,actions}.tsx` + new `dry-run-button.tsx`, `scripts/verify-zoho-2a.ts` (new), `lib/production/product-structure.test.ts` (removed H.x0.5 stub block).

**Closeout (2026-05-14, SHA `7c60dc9`):** Orchestrator blocks fetch when readiness != READY_FOR_DRY_RUN; writes exactly one PARTIAL ITEMS row + zero CUSTOMERS rows in that case. Diff engine covers 11 reason codes × 5 action codes for items + customers. tsc clean / vitest **1377/1377** (+67 vs ZOHO-GW-2's 1310; +3 test files) / next build clean / auth smoke 48/48 PASS / staging verify exits 0 with `result.kind=BLOCKED, readiness=NEEDS_REAUTH, fetcher invoked=false`. ZOHO-2B unblocked Luma-side; **gateway-side blocked on operator re-authorizing `haute_brands` tokens on LXC 9503**.

---

### [ ] ZOHO-2B — Live dry-run verification after haute_brands tokens are refreshed
**Objective.** Re-run `scripts/verify-zoho-2a.ts` against the live gateway after the gateway operator has re-authorized `haute_brands` × {books, crm, expense, inventory} Zoho refresh tokens. Confirm non-zero scanned counts and that the diff engine emits sensible CREATE_CANDIDATE / NEEDS_REVIEW / NO_CHANGE / UPDATE_CANDIDATE / CONFLICT rows against the real Zoho item + contact data.

**Prerequisites.** Operator action on LXC 9503: run gateway's brand re-auth flow for `haute_brands` Zoho refresh tokens.

**Acceptance criteria.**
- Connectivity check on `/settings/integrations/zoho` reports `READY_FOR_DRY_RUN`.
- `verify-zoho-2a.ts` exits 0 with `result.kind=OK` and `items.counts.scanned > 0` + `customers.counts.scanned > 0`.
- Two `zoho_sync_runs` rows written (one ITEMS, one CUSTOMERS) with `status=SUCCESS` (or `status=PARTIAL` if Zoho-side duplicates produce conflicts).
- No writes to products / customers / tablet_types / packaging_materials.

**Stop condition.** Diff against real Zoho data captured + audit row visible. Owner reviews the preview rows before authorizing ZOHO-3 apply.

---

### [ ] ZOHO-3 — Apply item + customer sync with mapping review
**Objective.** Implement `listZohoItems()` and customer-list helpers via the gateway. Add pg-boss handlers `zoho.items.sync` + `zoho.customers.sync` in DRY-RUN mode only (no writes outside `zoho_sync_runs`). Surface the proposed diff on `/settings/integrations/zoho-items`.

**Prerequisites.**
- The integration gateway on LXC port 9503 must be running (currently not listening as of ZOHO-1 closeout).
- Owner names the canonical Zoho `organization_id` (single-org case) OR picks from the `NEEDS_SELECTION` list on the gateway page.

**Files likely touched.**
- `lib/integrations/zoho/items.ts` — replace stubs with live gateway-backed calls.
- `lib/integrations/zoho/customers.ts` — new.
- `lib/jobs/handlers/zoho-items-sync.ts`, `zoho-customers-sync.ts` — new.
- `app/(admin)/settings/integrations/zoho-items/page.tsx` — extend to render dry-run diff.

**Acceptance criteria.**
- Dry-run sync produces an honest "Would create N / update M / leave K unchanged" diff against a real Zoho org.
- No writes outside `zoho_sync_runs` (kind=ITEMS / CUSTOMERS, status reflecting the run).
- Idempotency: re-running with no Zoho changes produces an identical diff.

**Tests required.**
- Mocked gateway responses for items + customers.
- Diff computation tests (overwrite-protection, no-op detection).

**Stop condition.** Dry-run produces a sensible diff against a real Zoho org. Owner reviews and signs off before ZOHO-3 flips the write switch.

---

### [ ] ZOHO-4 — Sales order + purchase order read sync

(See `docs/ZOHO_LIVE_SYNC_PLAN.md` §8.)

---

### [ ] ZOHO-5 — Optional finished-lot write-back (purchase_receives + attachment)

(See `docs/ZOHO_LIVE_SYNC_PLAN.md` §8.)

---

### [ ] ZOHO-6 — Staging verification + closeout

(See `docs/ZOHO_LIVE_SYNC_PLAN.md` §8.)

---

### [~] NEXUS-0 — Customer complaint integration plan (SUPERSEDED 2026-05-15)
**Status.** SUPERSEDED by `docs/COMMERCIAL_TRACEABILITY_PLAN.md`. Luma does NOT store customer complaints. The inbound webhook + `nexus_complaints` direction is abandoned. The companion document `docs/NEXUS_QIP_CUSTOMER_COMPLAINT_PLAN.md` stays committed for the boundary discussion + open-question record. Luma → Nexus outbound (LOT-1F/G) stays in place as the seed for Nexus's customer-scoped dropdown.

---

### [x] WORKFLOW-UX-1 — Workflow-first sidebar + raw-bag intake entrypoint
**Objective.** Rebuild the admin sidebar around floor jobs (Floor work / Management / Configuration / Advanced) instead of DB tables. Add `/receiving/raw-bags` placeholder for the "Receive raw pills" workflow entry. Rename `Recall lookup` → `Lookup receipt / batch`, `Packaging output` → `Packaging / pack-out`. Keep every existing route reachable; only nav + labels change.

**Files touched (1 commit, SHA `39c5140`).**
- `components/admin/sidebar.tsx` — rewrite. Four sections; Advanced collapsed by default via native `<details>` + auto-opens on deep-link.
- `components/admin/sidebar.test.ts` — 4 → 47 cases (section presence, Floor-work labels, DB-style labels absent from Floor-work, 24 routes asserted preserved, banned-phrase scan).
- `app/(admin)/receiving/raw-bags/page.tsx` — new admin-only placeholder, explains INTAKE-UX-1 lands next, links to `/inbound` so operators are never stuck.
- `scripts/smoke-authenticated-routes.ts` — auth smoke list 48 → 49.

**Closeout (2026-05-15, SHA `39c5140`):** Sidebar reorganized; no routes deleted. tsc clean / vitest 1420/1420 (+43 vs ZOHO-2A) / next build clean / auth smoke **49/49 PASS** on staging. New `/receiving/raw-bags` returns 200 under admin auth. Floor-work entries: Live floor / Receive raw pills / Receive packaging / Start production / Packaging / pack-out / QC review / Lookup receipt / batch.

---

### [x] INTAKE-WORKFLOW-1 — PO-driven one-screen raw bag intake + lookup
**Objective.** Replace the WORKFLOW-UX-1 placeholder at `/receiving/raw-bags` with the live PO-driven intake form. One screen captures PO + vendor + supplier lot + bag count + per-bag receipt # + per-bag QR + declared count. Atomic save. Lookup-by-receipt and lookup-by-QR both resolve to the same bag with full PO/vendor/product/supplier-lot context.

**Files touched (1 commit, SHA `59182fd`).**
- `drizzle/0034_receives_po_line.sql` — additive: `receives.po_line_id`.
- `lib/db/schema.ts`, `drizzle/meta/_journal.json` — mirror.
- `lib/production/raw-bag-intake.ts` + tests (46 cases).
- `lib/db/queries/raw-bag-intake.ts` — atomic save + lookup.
- `app/(admin)/receiving/raw-bags/{page,actions,raw-bag-intake-form}.tsx` — live UI.
- `scripts/verify-intake-workflow-1.ts` — end-to-end harness.

**Closeout (2026-05-15, SHA `59182fd`):** tsc clean / vitest **1466/1466** (+46 vs WORKFLOW-UX-1 / +1 test file) / next build clean (`/receiving/raw-bags` 235 B → 20.4 kB live form) / migration 0034 applied / verify-intake-workflow-1 exits 0 with every PO/vendor/product/supplier-lot link asserted + variance EXACT @ 200,000 + no finished_lots created during raw intake / auth smoke 49/49 PASS. Manual fallback path keeps receiving unblocked while `haute_brands` tokens stay expired.

This phase supersedes the earlier "INTAKE-UX-1" entry below — same target, broader scope (PO-driven, not just bag-shape).

---

### [x] WORKFLOW-CLEANUP-2 — PO line cards, material tabs, Start production page
**Objective.** Three workflow confusion points closed before Commercial Trace resumes: (1) PO lines render as clickable cards on `/receiving/raw-bags` instead of a dropdown, with filter input when a PO has more than six lines; (2) `/inbound/packaging-materials` splits count-based packaging and roll materials into tabs with QA/test materials hidden by default; (3) sidebar's "Start production" stops pointing at `/qr-cards` and lands on a real four-step workflow at `/production/start` that fires CARD_ASSIGNED via projectEvent (same path the floor PWA uses), `accountabilitySource: "MANUAL_TEXT"`. QR card administration (add / retire / print labels) moves under Advanced, still at `/qr-cards`.

**Files touched (1 commit, SHA `fe8778a`).**
- `components/admin/sidebar.tsx` — Start production href → `/production/start`; Advanced section gains QR card management.
- `components/admin/sidebar.test.ts` — refreshed Start-production assertion + 4 new WORKFLOW-CLEANUP-2 tests.
- `lib/production/material-filters.ts` + tests (8 cases) — `isQaTestMaterial` helper.
- `app/(admin)/inbound/packaging-materials/page.tsx` — search-params-driven tab switcher + QA filter + UI-2 primitives.
- `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx` — `PoLineCards` component replaces the PO line dropdown.
- `app/(admin)/production/start/{page,actions,start-production-form}.tsx` — new 4-step workflow page.
- `scripts/smoke-authenticated-routes.ts` — 49 → 50 routes.

**Closeout (2026-05-14, SHA `fe8778a`):** tsc clean / vitest **1478/1478** (+12 vs INTAKE-WORKFLOW-1) / next build clean (`/production/start` at 3.92 kB / 109 kB) / auth smoke **50/50 PASS** including `/production/start`. Sidebar still has Floor work / Management / Configuration / Advanced; Lookup receipt / batch appears once in primary nav; Batches stays under Advanced; no routes deleted. Data-honest labels enforced (Manual PO reference vs Verified local PO, PackTrack-origin vs Manual material receipt, Reusable workflow QR card vs Raw bag QR).

---

### [~] INTAKE-UX-1 — Single-screen raw-bag intake form (subsumed by INTAKE-WORKFLOW-1)
**Objective.** Replace the `/receiving/raw-bags` placeholder body with the live intake workflow: pick product / tablet type → enter supplier lot → enter bag count + per-bag pill count → scan or paste each bag's QR code → Luma issues internal receipt numbers → one click writes the `receive` + `small_boxes` + `inventory_bags` rows in a single transaction.

**Files likely touched.**
- `app/(admin)/receiving/raw-bags/page.tsx` — replace placeholder with live form.
- `app/(admin)/receiving/raw-bags/actions.ts` — new server action wrapping the existing `createReceiveWithBoxes()` from `lib/db/queries/receives.ts`.
- Possibly a new client component for the form (multi-step or single-page; design TBD).

**Acceptance criteria.**
- One screen, no wizard navigation. Operator enters product, supplier lot, bag count, per-bag count, QR codes, receipt numbers. Submits in one click.
- Internal receipt numbers (existing `buildInternalReceiptNumber` helper) are issued at save-time, displayed back to the operator.
- Idempotent: re-submitting same payload returns the same receive id.
- Audit-logged.

**Tests required.** Action validation matrix, idempotency, an in-container verify against a real receive flow.

**Stop condition.** Operator can scan 10 bags off a truck and have them in `inventory_bags` in under a minute. Verify script exits 0.

---

### [x] COMMERCIAL-TRACE-1 — Commercial traceability plan (paused; see COMMERCIAL-TRACE-2 below)
**Objective.** Audit-and-plan-only. Define the Zoho invoice → Luma finished-lot allocation model + Nexus read-only lookup contract. No code, no schema, no live calls. Replaces the abandoned NEXUS-1..6 ladder.

**Closeout (2026-05-15, SHA pending push):** `docs/COMMERCIAL_TRACEABILITY_PLAN.md` committed. Vision pivot recorded in `docs/CURRENT_PHASE_STATUS.md`. Old NEXUS-0 plan flagged SUPERSEDED at the top. Three new tables planned (`zoho_invoices`, `zoho_invoice_lines`, `finished_lot_invoice_allocations`); three new Nexus GET endpoints scoped (`/invoice-batches`, `/customer-batches`, `/batch-passport`); three secrets defined (outbound `NEXUS_FINISHED_LOT_SECRET` stays, new `NEXUS_LOOKUP_TOKEN` for customer scope, new `NEXUS_CSR_LOOKUP_TOKEN` for CSR scope). Confidence ladder uses existing HIGH/MEDIUM/LOW/MISSING vocabulary; only HIGH-confirmed allocations exposed to customer scope. 7 open questions + 12 risks recorded.

---

### [x] COMMERCIAL-TRACE-2 — Schema for Zoho invoices/lines + allocations
**Objective.** Land the migration for `zoho_invoices` + `zoho_invoice_lines` + `finished_lot_invoice_allocations`. Extend `shipment_finished_lots` with allocation-status columns. Add `INVOICES` to `zoho_sync_kind` enum. No engine — schema-only phase like ZOHO-1.

**Files touched (1 commit, SHA `bb4cc13`).**
- `drizzle/0035_zoho_sync_kind_invoices.sql` — standalone `ALTER TYPE "zoho_sync_kind" ADD VALUE 'INVOICES'`. Split because Postgres requires the enum value to commit before tables that reference it can be created in the same pass (Drizzle pg migrator runs each `.sql` in its own transaction).
- `drizzle/0036_commercial_trace_schema.sql` — `zoho_invoices`, `zoho_invoice_lines`, `finished_lot_invoice_allocations` plus `ADD COLUMN IF NOT EXISTS invoice_allocation_status` + `last_invoice_allocation_at` on `shipment_finished_lots`. `CHECK (quantity_allocated > 0)` enforced at the DB.
- `drizzle/meta/_journal.json` — registers idx 35 + idx 36 with strictly increasing `when` timestamps (1781500000000, 1781600000000).
- `lib/db/schema.ts` — mirrors the new tables + columns + extends `zohoSyncKindEnum` with `INVOICES`.
- `lib/production/commercial-trace.ts` — pure helpers: `normalizeInvoiceNumber`, `normalizeZohoInvoiceLineKey`, `validateAllocationQuantity`, `isCustomerSafeCommercialTraceField`, `commercialTraceVisibilityPolicy`. Confidence/status vocabularies. CSR-only-field list.
- `lib/production/commercial-trace.test.ts` — 27 cases covering schema shape, migration files, journal registration, allocation invariants, visibility policy (customer hides supplier lot / receipt / raw bag QR / operator / machine; CSR + internal see all), normalizers, and safety guardrails (no nexus_complaints, no complaint webhook/attachment/status-history tables, no live Zoho fetch, no Nexus invoice-batches endpoint yet).

**Visibility policy (owner decision 2026-05-15):**
- Customer scope NEVER exposes supplier_lot, supplier_lot_number, vendor_lot_number, internal_receipt_number, raw_bag_qr, bag_qr_code, operator_name, operator_id, employee_name, employee_id, machine_id, machine_label, station_id, station_label, qc_history.
- CSR + internal scope permit the full set; `blockedFields` empty.
- The helper is the only encoding today; future Nexus endpoints (COMMERCIAL-TRACE-6) MUST call `commercialTraceVisibilityPolicy(scope).allowField(field)` before returning any data.

**Closeout (2026-05-15, SHA `bb4cc13`):** tsc clean / vitest **1505/1505** (+27 vs WORKFLOW-CLEANUP-2 / +1 test file) / next build clean / migrations 0035 + 0036 applied on LX122 (`SELECT unnest(enum_range(NULL::zoho_sync_kind))` returns 7 values including `INVOICES`; three new tables visible in `information_schema.tables`; `shipment_finished_lots` gained both allocation columns; `pg_constraint` confirms `CHECK ((quantity_allocated > (0)::numeric))`) / auth smoke **50/50 PASS**. No data seeded. No live Zoho calls made. No UI added.

---

### [x] COMMERCIAL-TRACE-3 — Zoho invoice dry-run client + diff preview
**Objective.** Read-only invoice client + diff preview against the existing Luma snapshot (`customers` + `zoho_invoices`). Mocked-gateway tests; live calls block honestly while `haute_brands` Zoho tokens are expired. No allocations, no candidate-table writes (deferred to COMMERCIAL-TRACE-3B per ZOHO-2A precedent).

**Files touched (1 commit, SHA `8a747a6`).**
- `lib/integrations/zoho/invoices.ts` — `normalizeZohoInvoice`, `normalizeZohoInvoiceLine`, `fetchZohoInvoicesDryRun`, `fetchZohoInvoiceByNumberDryRun`, `deriveZohoInvoiceDiff`, `summarizeZohoInvoiceDryRun`, `runZohoInvoiceDryRun`, `mapZohoInvoiceGatewayError`.
- `lib/integrations/zoho/invoices.test.ts` — 39 cases (normalization, gateway fetchers, diff, summary, orchestrator BLOCKED + OK paths, safety guardrails).
- `app/(admin)/settings/integrations/zoho/{actions.ts,page.tsx,invoice-dry-run-button.tsx}` — `runZohoInvoiceDryRunAction` server action + UI section + button.

**Gateway audit (read-only against LXC 9503).** `GET /zoho/invoices/list` + `GET /zoho/invoices/get/{id}` proxy generically through `app/api/zoho_proxy.py` with `X-Internal-Token` + `X-Brand=haute_brands`. No bespoke invoice transformer (`_transform_books_invoices_create` is unused, POST path only); GETs pass through verbatim from Zoho Books. Invoice header carries `invoice_id`, `invoice_number`, `customer_id`, `customer_name`, `date`, `status`, `currency_code`, `sub_total`, `total`, `balance`. Detail GET adds `line_items[]` with `line_item_id`, `item_id`, `sku`, `name`, `quantity`, `unit`, `rate`, `item_total`.

**Closeout (2026-05-15, SHA `8a747a6`):** tsc clean / vitest **1544/1544** (+39 vs COMMERCIAL-TRACE-2 / +1 test file) / next build clean / auth smoke 50/50 PASS / live BLOCKED-path verified on LX122: `runZohoInvoiceDryRun` returned `{kind: BLOCKED, readiness: NEEDS_REAUTH}` and wrote one PARTIAL INVOICES row without calling `/zoho/invoices/list` or `/zoho/invoices/get`. `zoho_invoices`, `zoho_invoice_lines`, `finished_lot_invoice_allocations` all empty; no `shipment_finished_lots` row changed allocation status. UI section visible on `/settings/integrations/zoho` with the NEEDS_REAUTH banner. Secrets never rendered.

---

### [ ] COMMERCIAL-TRACE-4 — Allocation suggestion engine
**Objective.** Pure helpers: `suggestAllocationsForInvoiceLine`, `applyAllocation`, `confirmAllocation`. HIGH only from pack-out scan or operator confirm; MEDIUM from exact `(item_id, qty, ±7d, same customer)` match; LOW from fuzzy multi-candidate; MISSING surfaces in unresolved-invoices report.

**Files likely touched.** `lib/production/invoice-allocations.ts` + tests.

**Stop condition.** Engine emits correct suggestions for fixture invoice lines against fixture finished lots; idempotency proven.

---

### [ ] COMMERCIAL-TRACE-5 — Allocation review UI
**Objective.** `/admin/invoice-allocations` — invoices grouped by resolved / partially resolved / unresolved. Per-invoice line-by-line view; Confirm / Override / Skip buttons. Audit-logged.

**Acceptance criteria.** Page reachable; lints clean; auth smoke gains 2 routes.

---

### [ ] COMMERCIAL-TRACE-6 — Nexus read-only invoice/batch APIs
**Objective.** Three GET endpoints under `app/api/integrations/nexus/`: `/invoice-batches`, `/customer-batches`, `/batch-passport`. Shared auth middleware. Customer-scope cascade enforced. Audit log per call. Compose env: `NEXUS_LOOKUP_TOKEN` + `NEXUS_CSR_LOOKUP_TOKEN`.

**Stop condition.** Mock-receiver verify proves customer-safe vs CSR scopes; HIGH-only filter; cross-customer 404.

---

### [ ] COMMERCIAL-TRACE-7 — Staging verification with mock invoice + finished lot
**Objective.** `scripts/verify-commercial-trace-7.ts` — seed QA invoice + finished lot, run suggestion engine, confirm via action, hit all three Nexus endpoints, assert customer scope hides supplier_lot, CSR scope shows it. Cleanup.

**Stop condition.** Verify script exits 0; auth smoke 50/50 PASS (if endpoints added to smoke list).

---

### [ ] COMMERCIAL-TRACE-8 — Live Zoho verification after token reauth
**Objective.** After gateway operator re-authorizes `haute_brands` tokens, run invoice dry-run against real Zoho data. Promote a small batch via review UI. Validate Nexus endpoint outputs against a real customer's invoice.

**Prerequisite (operator).** SSH to LXC 9503, run gateway re-auth flow for `haute_brands` × {books, crm, expense, inventory}.

**Stop condition.** Real customer's real invoice resolves to real finished lots; CSR drill-through returns the right internal passport; production-ready signal.

---

## Anchor: spec-gap log

If, while executing a phase, you find something that the spec doesn't cover, post a single chat message tagged `spec-gap`, append a one-liner to `docs/CURRENT_PHASE_STATUS.md`, and continue without building it. Don't expand the queue mid-phase.
