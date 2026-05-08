# Current Phase Status

Append-only log. Each entry: phase name, date (UTC), result, notes. Latest entry first.

---

## OP-1C — Wire count-submission forms + actions (complete)
- Date: 2026-05-08
- Result: every live floor + admin count-submission action now resolves an accountable employee and propagates it through `projectEvent` (workflow_events.employee_id) or merges it into the `material_inventory_events` / `raw_bag_allocation_events` payload.
- Schema: migration `drizzle/0023_station_operator_sessions.sql` adds `station_operator_sessions` table (id, station_id, employee_id, employee_name_snapshot, accountability_source, opened_at, closed_at, opened_by_user_id, closed_by_user_id, notes) plus a partial unique index `WHERE closed_at IS NULL` enforcing one open session per station. Drizzle journal `_journal.json` extended (idx 23, when 1780300000000).
- Helper: `lib/production/station-operator-session.ts` exports `getActiveStationSession`, `resolveStationAccountability` (override → session → free-text precedence with SUPERVISOR_OVERRIDE / STATION_OPERATOR_SESSION / LEGACY_TEXT source labels), `withAccountabilityPayload` for material/raw-bag event payload merge, and `resolveAdminAccountability` for admin actions defaulting from `currentUser().employeeId`.
- Floor server actions for opening/closing the session: new `app/(floor)/floor/[token]/operator-session-actions.ts` with `openOperatorSessionAction`, `endOperatorSessionAction`, `listActiveEmployeeOptions`. Open closes any existing open session first; partial unique guarantees at-most-one-active per station.
- Floor page UI: new `operator-session-form.tsx` client component renders "Operator on shift" or "Open shift" panel above the bag card; observable forms with pending/error/success banners. `floor/[token]/page.tsx` reads the active session + employee options server-side and passes them in.
- Floor actions wired (every projectEvent/material-event call site now propagates accountability):
  - `actions.ts`: `scanCardAction` (CARD_ASSIGNED + PRODUCT_MAPPED + BAG_PICKED_UP), `fireStageEventAction` (BLISTER/SEALING/BOTTLE_*_COMPLETE — with first-op refusal when no employee resolves), `pauseBagAction`, `resumeBagAction`, `setOperatorAction`, `packagingCompleteAction`, `releaseBagAction`, `finalizeBagAction`. All accept `overrideEmployeeCode` for supervisor on-behalf-of submissions.
  - `roll-actions.ts`: `mountRollAction`, `unmountRollAction`, `weighRollAction`, `changeRollAction` (all 7 material_inventory_events inserts merge accountability into payload via `withAccountabilityPayload`; segments + deplete + remount in changeRollAction share one resolved accountability per submission).
  - `bag-allocation-actions.ts`: `openAllocationSessionAction`, `closeAllocationSessionAction`, `returnRawBagAction`, `markBagDepletedAction`, `adjustRawBagAction` (all 5 wired; `adjustRawBagAction` is now wrapped in a transaction so the resolver has a tx).
- Admin actions wired:
  - `inbound/packaging-materials/actions.ts` `receivePackagingMaterialAction` (4 events) + the roll-receive path (1 event) — defaults from logged-in user's employeeId via `resolveAdminAccountability`.
  - `packaging-receipts/[lotId]/actions.ts` `adjustPackagingLotAction` — both PACKAGING_RECEIPT_ADJUSTED + PACKAGING_VARIANCE_RECORDED kind=CYCLE_COUNT_VARIANCE merged with admin accountability.
- First-op refusal: `fireStageEventAction` rejects BLISTER_COMPLETE / BOTTLE_HANDPACK_COMPLETE when no operator session is open AND no override resolves, with the message "No operator on shift. Open a shift on this station before submitting the first count."
- Tests: `lib/production/station-operator-session.test.ts` (11 cases — precedence routing for override/session/free-text/all-null, override wins over session, session-fallthrough on bogus override, payload merge mutation safety, admin-side default-from-user, supervisor override path, missing-employee admin path).
- Verification: `npx tsc --noEmit` clean. `npx vitest run` 654/654 pass (30 files; +11 new). `npx next build` clean.
- Migration deploy on staging: pending the next deploy-timer tick. Verify after push that station_operator_sessions table + partial unique exist on LX122.
- Smoke run on staging (per stop condition): pending — will run a fresh BLISTER_COMPLETE through the floor PWA after deploy and confirm the resulting workflow_events row carries employee_id.
- Spec note: floor PWA stays anonymous (no auth refactor). Supervisor-override on the floor uses the per-form `overrideEmployeeCode` field; admin actions enforce role at the `requireAdmin()` layer. Floor UI for surfacing the override input on each action is deferred to OP-1F polish — the action API accepts the field today and the operator session covers the default-flow for now.
- Next phase: OP-1D (damages/rework/scrap/supervisor-correction wiring — defer-or-ship decision per queue).

---

## OP-1B — Employee / accountability foundation (complete)
- Date: 2026-05-08
- Result: plumbing-only foundation shipped. No call site rewired yet (per queue stop condition).
- Schema: migration `drizzle/0022_employee_code.sql` adds `employees.employee_code text` plus partial unique index `employees_code_active_unique` filtered to `status='ACTIVE' AND employee_code IS NOT NULL`. Migration is additive only; existing rows untouched. Journal `_journal.json` extended with `idx 22, when 1780200000000`.
- Drizzle schema: `employees` table updated to mirror the column + unique index in `lib/db/schema.ts`.
- Auth: `lib/auth.ts` `CurrentUser` extended with `employeeId: string | null`. Populated at `currentUser()` time via a per-request cache on `users.id` so repeat calls within a request hit a single DB lookup.
- Projector: `lib/projector/index.ts` exports a new `AccountabilitySource` union (`LOGGED_IN_USER | EMPLOYEE_PICKER | EMPLOYEE_CODE | BADGE_SCAN | SUPERVISOR_OVERRIDE | STATION_OPERATOR_SESSION | LEGACY_TEXT | MANUAL_TEXT`). `EventInput` extended with optional `enteredByUserId`, `accountableEmployeeId`, `accountabilitySource`, `accountableEmployeeNameSnapshot`. The two FK ids land on `workflow_events.user_id` / `.employee_id`; source + snapshot merge into payload as `accountability_source` / `accountable_employee_name_snapshot`. Fully backwards-compatible — every existing call site continues to compile unchanged.
- Helper: `lib/production/accountability.ts` ships `resolveAccountableEmployee(tx, input, opts)` plus `accountabilityConfidence(source, isStable)`. Resolves employeeId → code → badgeSubject → free-text in precedence order; rejects malformed UUIDs without a DB hit; honours `strict: true` to refuse free-text fallback; case-insensitive code lookup constrained to `status='ACTIVE'`. Confidence ladder: HIGH (logged-in / picker / scan / station-session), MEDIUM (typed code), LOW (free text or non-stable), MISSING (no source).
- Tests: `lib/production/accountability.test.ts` (18 cases — empty input, strict-mode refusal, free-text/legacy fallback, MANUAL_TEXT hint, by-id, malformed UUID short-circuit, source hint override, by-code, code+freetext fallthrough, badgeSubject → BADGE_SCAN, whitespace handling, name snapshot, inactive/missing code in strict mode, plus 5 confidence-ladder cases). `lib/projector/event-input-accountability.test.ts` (3 cases — values populate, null fall-through, payload merge preservation). All 21 OP-1B tests pass.
- Compatibility fix: `scripts/synthesize-legacy.ts` system-actor literal updated with `employeeId: null` to satisfy the new `CurrentUser` shape.
- Verification: `npx tsc --noEmit` clean. `npx vitest run` 643/643 pass (29 files; +18 accountability + 3 projector contract = 21 new). `npx next build` clean.
- Migration deploy on staging: pending the next deploy-timer tick (handled by the LX122 systemd timer that pulls the `production-intelligence-command-center` branch every 60s; verify via `psql` after push that the column + partial unique are present).
- Known limitations: still no live emission path for `PACKAGING_DAMAGE_RETURN` / `REWORK_SENT` / `SCRAP_RECORDED` / `SUBMISSION_CORRECTED` (OP-1A finding; deferred to the QC subsystem phase). No call site is rewired yet — that's OP-1C.
- Next phase: OP-1C (wire count-submission forms + actions).

---

## OP-1A — Operator / employee identity audit (complete)
- Date: 2026-05-08
- Result: audit complete; no code changed.
- Findings (condensed; full audit in chat history):
  - `workflow_events.employee_id` (FK employees) and `workflow_events.user_id` (FK users) already exist on the table; never populated by `projectEvent`. Single biggest gap. Filling these is the OP-1B plumbing change.
  - `employees` is the right backbone (already FK'd from `users.employee_id`). No new `operator_profiles` table required.
  - Floor PWA is fully anonymous — auth is the URL station scan token; no `currentUser()` calls under `app/(floor)`.
  - `fireStageEventAction` (BLISTER/SEALING/BOTTLE_*_COMPLETE counters) takes no operator field at all today; UI fires a separate `OPERATOR_CHANGE` event before each count if operator code is set.
  - Roll mount/unmount/weigh/change actions accept no operator field.
  - `PACKAGING_DAMAGE_RETURN` / `REWORK_SENT` / `SCRAP_RECORDED` / `SUBMISSION_CORRECTED` event types exist but have NO live emission path. Out of scope for OP-1; deferred to QC subsystem.
  - `read_operator_daily` is keyed on free-text `operator_code`. Misspellings produce phantom operators. OP-1E switches the key to `employee_id`.
  - `deriveBagGenealogy` already joins `employees.fullName` via `workflow_events.employee_id` — display path is wired and silent only because the column is empty. Filling `employee_id` makes genealogy "free."
- Decisions baked into the queue:
  - No new operator-profiles table. Use `employees` + add `employee_code` column in OP-1B.
  - QC events (damage/rework/scrap/correction) deferred to the QC subsystem phase.
- Next phase: OP-1B (employee/accountability foundation).
