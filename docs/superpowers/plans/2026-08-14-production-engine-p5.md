# Production Engine — Phase 5 Implementation Plan (supervisor separation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tablet gains a real supervisor boundary — PIN unlock with a time-boxed audited session gates everything the operator screen deliberately hides (manual override, QC, rolls, allocation pages, partial overrides), and the two P4 residue gaps close (bagless machine-down reports; RESOLVE_PARTIAL's typed lead badge becomes an inline supervisor check).

**Architecture:** Migration 0073 adds `employees.supervisor_pin_hash` + `employees.is_supervisor`, a `station_supervisor_sessions` table (15-minute TTL), and a `station_exception_reports` table for bagless reports (a dedicated table rather than a nullable `workflow_events.workflow_bag_id` — the events invariant stays intact). An engine `supervisor-session` module owns unlock/verify/close with `lib/auth.ts`'s existing argon2id helpers; **enforcement is server-side** — every gated action calls `requireSupervisorSession` inside its flow; the banner/UI is cosmetic. Act Now surfaces and acknowledges bagless reports.

**Tech Stack:** unchanged; argon2 already a dependency (`lib/auth.ts:90-96` has the id-mode hash/verify helpers — reuse, do not re-implement).

**Spec:** `docs/superpowers/specs/2026-08-11-production-engine-operator-experience-design.md` — "Operator / supervisor separation" section governs (auth primitive, the tablet-vs-admin capability table, audit on unlock AND on every action under it). Accumulated P5 items: `docs/superpowers/plans/2026-08-11-production-engine-p1-outcomes.md` (P4b section: bagless reports; RESOLVE_PARTIAL inline PIN; qc-panel/rolls/bag-allocation/variety-pack gating; hold acknowledgment; the damagedPackaging rework-field decision is NOT in scope — leave listed for P6).

## Global Constraints

- No emoji in product or code. TypeScript strict. No DB in tests (pure logic carries coverage; DB halves ride staging smoke). Boundary is `"error"` — floor files import only the engine barrels (`@/lib/production/engine` server, `.../client` browser); barrel additions individually justified.
- Every unlock and every supervisor-gated action writes `audit_log` (spec hard requirement). PINs never logged, never in payloads, never in error strings.
- Migrations: additive only; file `0073_*`, journal idx 72, `when` 1785200000000 (strictly increasing over 0072's 1785100000000); no ALTER TYPE involved; mirror in `lib/db/schema.ts`.
- Suite 0 failures after every task (5304/0 at branch); typecheck/lint 0 errors; build green. Version `1.34.0` → `1.35.0` final task; bracketed CHANGELOG header.
- Do NOT push.

---

### Task 1: Migration 0073 + schema

`drizzle/0073_supervisor_and_reports.sql`:
- `ALTER TABLE employees ADD COLUMN IF NOT EXISTS supervisor_pin_hash text;` and `ADD COLUMN IF NOT EXISTS is_supervisor boolean NOT NULL DEFAULT false;`
- `station_supervisor_sessions` (id uuid PK gen_random_uuid, station_id uuid NOT NULL REFERENCES stations ON DELETE CASCADE, employee_id uuid NOT NULL REFERENCES employees, opened_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, closed_at timestamptz) + partial unique index: one OPEN (closed_at IS NULL) session per station — mirror `station_operator_sessions`' migration-0023 pattern (read it first).
- `station_exception_reports` (id uuid PK, station_id uuid NOT NULL REFERENCES stations ON DELETE CASCADE, category text NOT NULL, detail text NOT NULL, employee_id uuid REFERENCES employees, employee_name_snapshot text, created_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz, acknowledged_by uuid REFERENCES users) + partial index on station_id WHERE acknowledged_at IS NULL.
Journal entry idx 72 / when 1785200000000 (verify tail first); `lib/db/schema.ts` mirrors placed adjacent to their referenced tables, comment style matching neighbors. Suite/typecheck/lint/build. Commit `feat(supervisor): migration 0073 — pin columns, supervisor sessions, exception reports`.

### Task 2: Engine supervisor-session module + admin PIN setter

`lib/production/engine/supervisor-session.ts`:
- `openSupervisorSession({stationId, employeeCode, pin})` — ACTIVE employee by code with `is_supervisor=true` AND non-null hash; verify via lib/auth.ts's argon2id verify; close any open session for the station; insert with `expires_at = now() + 15 minutes`; `writeAudit` action `SUPERVISOR_UNLOCK` (actor employee, target station). Total function: `{ok:true, session:{id, employeeName, expiresAt}} | {ok:false, blocker}`. ONE generic failure sentence for unknown-code / wrong-pin / not-supervisor / unset-pin (`SUPERVISOR_PIN_INVALID`, "That code and PIN combination does not unlock this station.") — the specific cause goes in supervisorDetail only; no oracle.
- `closeSupervisorSession(stationId)` — closed_at + audit `SUPERVISOR_LOCK`.
- `requireSupervisorSession(tx, stationId)` — the OPEN unexpired row or null; lazily closes expired rows.
- Pure `supervisorSessionRemainingSeconds(expiresAt, now)` + tests (positive, zero-clamp, expired).
- A source-scan test pinning that the string `pin` appears in the module ONLY in the verify call + input type (repo scanner precedent) — PIN material must be unloggable by construction.
Barrel: server exports all; `client.ts` exports the type + remaining-seconds only. ADMIN PIN SETTER: grep `app/(admin)` for the employees CRUD surface; report where it lives; add PIN-set + is_supervisor toggle there (hash via lib/auth.ts, audit `SUPERVISOR_PIN_SET`, no hash in audit payload); if no employees surface exists, add a minimal one under the admin layout's existing conventions and say so. Commit `feat(supervisor): session engine with argon2id unlock and lazy expiry`.

### Task 3: Floor unlock UI + banner

`app/(floor)/floor/[token]/supervisor-sheet.tsx` — More▸Supervisor opens it: employee code + PIN inputs (sheet style per existing sheets; errors inside the sheet per M2 convention), submit via a new thin action in `operator-actions.ts` (zod/authStation/delegate/map). On success: the spec's persistent banner on OperatorScreen — supervisor name + live countdown (client-side tick from `supervisorSessionRemainingSeconds`, re-synced on every view refresh) + `[ Exit ]` calling the close action. `getStationView` populates the existing `StationView.supervisor` field (typed since P1, null till now) from the open session. Model tests: banner state from view; countdown display; expiry renders as locked. Commit `feat(floor): supervisor unlock sheet and session banner`.

### Task 4: Server-side gating + supervisor tools

Gate with `requireSupervisorSession` SERVER-SIDE inside each flow (UI visibility from `view.supervisor` is cosmetic; a hand-crafted request must be refused):
- `qc-actions.ts` — every mutating action (including Release hold).
- `roll-actions.ts` — mutations only; the rolls PAGE stays reachable (physical work at the machine).
- `bag-allocation-actions.ts`, `variety-run-actions.ts` — all mutations; both PAGES (`bag-allocation/page.tsx`, `variety-pack/page.tsx`) render a "Supervisor unlock required" state when no open session.
Refusals use each surface's existing error shape with one operator sentence ("Supervisor unlock required for this."). Verify each gated action writes audit (most do via their flows; add where missing — list in report).
Supervisor tools in More when unlocked: manual bag selection (the old dropdown reborn: claimable bags from the queue + eligible-pickups loader; claim via the sanctioned P4b scan path — read `resolveFreshBagStart`/`startFreshBag` and reuse, no new claim logic), end operator session (existing action), and "Corrections" as a deep-link to the admin correction wizard (spec puts corrections on /admin; the floor does NOT build voiding). Commit `feat(supervisor): server-side gating and supervisor tools`.

### Task 5: RESOLVE_PARTIAL inline supervisor check + bagless reports

(a) LOW-confidence partial: replace the typed lead badge (`LeadCodeField` legacy parity, documented in P4b) — `advanceBag` RESOLVE_PARTIAL on a LOW-confidence resolution requires an OPEN supervisor session (server-side `requireSupervisorSession` in the flow; blocker `PARTIAL_SUPERVISOR_REQUIRED` reworded to point at the unlock). Screen: when the case is RESOLVE_PARTIAL-low and `view.supervisor` is null, open the supervisor sheet inline first (spec: "presents as one screen"), then submit. Remove the badge field. Preserves the P1 ruling with a real check.
(b) Bagless reports: `lib/production/engine/raise-station-report.ts` — `raiseStationReport({stationId, category, detail})`, categories MACHINE | OTHER only (bagged categories keep their event paths), inserts `station_exception_reports` with the active operator session's employee snapshot + audit; total-function. Report Problem: machine/other WITHOUT a pinned bag now submit through it (bagged path unchanged); remove the disabled-state for those two categories; update helper copy. Act Now: union unacknowledged reports into the rail (MACHINE crit, OTHER warn) respecting the P4b cap-3 on exception-class rows. Smoke doc: update the first-morning comms bullet (bagless machine-down NOW files; supervisors see it on the board). Commit `feat(floor): inline supervisor check for low-confidence partials; bagless station reports`.

### Task 6: Act Now acknowledgment

Admin floor-board: unacknowledged report rows get `[ Acknowledge ]` (admin session user → acknowledged_by, audit `STATION_REPORT_ACKNOWLEDGED`); acknowledged rows leave the rail. Workflow-event exceptions (DOWNTIME/QA) deliberately NOT acknowledgeable — they resolve through their own flows (QA via Release hold; downtime-end is P6) — comment + outcomes note. Commit `feat(admin): acknowledge station reports on the act-now rail`.

### Task 7: v1.35.0

Version; CHANGELOG `## [1.35.0] — <date>`; smoke section (unlock/15-min expiry/exit; wrong-PIN generic refusal — no oracle, same response for unknown code; a gated action refused server-side with a hand-crafted request while locked; RESOLVE_PARTIAL-low prompts the sheet inline; bagless machine report reaches the rail and acknowledges; gated pages show the locked state); outcomes P5 section + P6 remainder. Commit `chore(release): v1.35.0 production engine phase 5`.

---

## Exit criteria

Suite 0 failures; every spec-P5 tablet capability behind a SERVER-checked session; audit on unlock + every gated action; PIN never in logs/payloads/error strings; bagless machine-down filable and acknowledgeable; LOW-confidence partial requires a real supervisor check; boundary stays 0/error.

## Deferred to P6

Data-driven route resolution from route_operations; legacy action deletion; barrel curation; value-pinned duplication guards; `read_queue_state` double-count fix; downtime-end flow; damagedPackaging rework-field decision.
