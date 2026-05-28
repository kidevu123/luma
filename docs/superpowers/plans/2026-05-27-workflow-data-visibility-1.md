# WORKFLOW-DATA-VISIBILITY-1 — Production data visibility & editability map

**Date:** 2026-05-27  
**Baseline:** `c596e4a` / v0.4.28  
**Reference bag:** Bag Card 117 — `35902ff1-6e9e-4547-8893-a11f640a3263`  
**Scope:** Audit only for edit model; fix Workflows page crash.

---

## 1. Workflows page crash (root cause)

**Route:** `/workflow-submissions` (sidebar: **Workflows** under Inventory)

**Symptom:** Admin error boundary — “Page failed to render”, digest `1045651454`.

**Root cause:** The server page passes `Date` objects (and SQL `count()` as string) into the client `WorkflowTable`. Next.js serializes `Date` props to ISO strings at the RSC boundary. `fmtDatetime(bag.startedAt)` called `.toISOString()` on a string → `TypeError: d.toISOString is not a function` during client SSR.

**Fix (v0.4.29):** Serialize dates to ISO strings in `page.tsx`; coerce `eventCount` to number; use `formatWorkflowDatetime` / `formatWorkflowTimestamp` helpers that accept `Date | string`.

**Not the cause:** SQL groupBy query, Bag 117 finalized state, missing read models, or material events. Live DB query returns one bag successfully.

---

## 2. Where Bag Card 117 data is visible today

### A. Data element → where it lives

| Data | Primary source | Visible on |
|------|----------------|------------|
| Workflow / bag status | `read_bag_state` | Workflows table, Genealogy header, Production output queues, Live floor |
| Event sequence (full) | `workflow_events` | Genealogy `/genealogy/[bagId]`, Workflows expand (via `deriveBagGenealogy`) |
| Hand-pack completion | `HANDPACK_BLISTER_COMPLETE` event | Genealogy timeline; Workflows expand timeline (raw type label — no dedicated badge yet) |
| Sealing counter / cards | `SEALING_COMPLETE` payload: `counter_presses`, `cards_per_press`, `count_total` | Genealogy timeline payload; Workflows expand payload JSON + submission summary (`count_total` only; counter presses not in summary lines) |
| Packaging close-out | `PACKAGING_COMPLETE` payload + `read_bag_metrics` | Workflows table columns; expand submission entries; Production output; Metrics aggregates |
| Material consumption / skip | `material_inventory_events`; skip flags on `SEALING_COMPLETE` payload | Production output material burn (7d aggregate, not per-bag); event payload on genealogy; **no per-bag material panel on Workflows** |
| Operator attribution | `workflow_events.employee_id` / accountable fields; `read_bag_state.current_operator_code` | Genealogy timeline (employee name); Workflows table (last operator code only); Operator productivity (aggregates) |
| Timestamps / station elapsed | `workflow_events.occurred_at`; `read_bag_metrics.*_seconds` | Workflows (started, duration totals); Genealogy (per-event timestamps); Metrics (cycle time sections) |
| Finalized metrics | `read_bag_metrics` after `BAG_FINALIZED` | Workflows table; Production output; Metrics; Finished lot passport (if lot issued) |

### B. Admin pages (inventory)

| Page | Route | What Bag 117 shows |
|------|-------|-------------------|
| **Workflows** | `/workflow-submissions` | Row: stage FINALIZED, cases/displays/loose, damage, event count, active seconds, operator code, started. Expand: full timeline + submission summaries + read_bag_metrics totals. |
| **Bag genealogy** | `/genealogy` → `/genealogy/35902ff1-…` | Best single-bag view: event timeline with station/machine/employee, payload details, summary stats. |
| **Production output** | `/packaging-output` | 7d pack-out metrics; queue of finalized bags awaiting finished lot; material burn aggregate. |
| **Metrics** | `/metrics` | Windowed aggregates: throughput, cycle times, per-product/machine/station, operator leaderboard, material burn. |
| **Productivity** | `/operator-productivity` | Operator-level bags/hours/damage/corrections — not bag-specific drill-down. |
| **Audit log** | `/reports/audit-log` | Admin/floor mutations (lead role). Not a substitute for workflow event history. |
| **Find lot** | `/recall` | Receipt/lot passport when finished lot exists; links to genealogy per workflow bag. |
| **Finished lots** | `/finished-lots` | Only if a lot was issued from bag 117. |
| **QC review** | `/qc-review` | Damage/rework/correction workflows; corrections apply to submission events. |
| **Live floor** | `/floor-board` | Current station state — bag 117 is finalized so not on floor queue. |

### C. Gaps for Bag 117 specifically

- **Hand-pack:** visible in genealogy payload; Workflows expand shows raw `HANDPACK_BLISTER_COMPLETE` (no friendly badge in submission panel).
- **Sealing counter:** full payload visible in expand/genealogy; submission summary shows `count_total` (1818) but not `counter_presses` (303) or `cards_per_press` (6).
- **Material skip:** if sealing skipped blister-card lot, flags are in event payload only — no dedicated admin review queue beyond QC/material pages.
- **Bag # search:** Workflows filter placeholder mentions bag # but query filters receipt + product name only (UUID search via Genealogy).

---

## 3. What can currently be edited

| Action | Exists? | Where | Model |
|--------|---------|-------|-------|
| Edit `workflow_events` in place | **No** | — | Append-only event stream |
| Void / delete events | **No** | — | Soft-delete not exposed for production events |
| Submission correction | **Yes** | `/qc-review` → `submissionCorrectedAction` | Appends `SUBMISSION_CORRECTED` linked to original event; original untouched |
| Damage → scrap / rework | **Yes** | `/qc-review` | Appends `SCRAP_RECORDED`, `REWORK_SENT`, etc. |
| Force release QR card | **Yes** | Floor admin actions | `CARD_FORCE_RELEASED` event |
| Manual finalize | **Yes** | Floor (legacy fallback) | `BAG_FINALIZED` |
| Edit read models directly | **No** | — | Projector-derived from events |
| Audit log entries | **Write-only** | All mutations | `audit_log` append |
| Inbound bag edit | **Yes** | `/inbound/.../bag/.../edit` | Receiving domain only — not production workflow |
| Finished lot issue / hold | **Yes** | `/finished-lots` | Output domain |

**Honest summary:** Production traceability is **view-heavy, append-only**. The only structured “correction” path today is QC **SUBMISSION_CORRECTED** (supervisor/admin). There is no UI to reverse accidental finalize, reassign operator on past events, or fix sealing counter without a new correction event type.

---

## 4. Recommended correction model (do not implement yet)

**Principle:** Prefer **append-only correction events** over mutating historical `workflow_events`. Projectors and read models should consume corrections idempotently (pattern already started with `SUBMISSION_CORRECTED`).

### Likely first corrections (priority order)

1. **Wrong packaging count** — highest operator impact; extend QC correction to `PACKAGING_COMPLETE` payloads (cases/displays/loose/damage).
2. **Wrong sealing counter / count_total** — new correction type or generalize `SUBMISSION_CORRECTED` with sealing payload schema.
3. **Wrong operator on a submission** — correction event that updates accountability metadata without rewriting history.
4. **Accidental finalize** — supervisor `BAG_UNFINALIZED` or `FINALIZE_REVERSED` with strict admin gate + audit; projector must restore QR/station state safely.
5. **QC after close-out** — already partially covered by damage/rework/scrap flows.

### View-only vs editable

| View-only | Editable (via new/corrected events) |
|-----------|-------------------------------------|
| Raw event timeline | Submission numeric fields (via correction) |
| Audit log | Damage disposition |
| Genealogy ordering | Rework send/receive |
| Aggregated metrics (derived) | — |

### Permissions

| Action | Role |
|--------|------|
| View Workflows / Genealogy | Session (office) |
| Submission correction | Admin (`requireAdmin` on QC review) |
| Finalize reversal | Admin + explicit audit reason |
| Floor stage submissions | Station token + operator scan |

All correction mutations must write **audit_log** and preserve **accountable employee** from the original event where applicable (QC-0 pattern).

---

## 5. Recommended next implementation slice

1. **Deploy v0.4.29** — Workflows page fix (this task).
2. **Workflows UX polish (small):** Add `HANDPACK_BLISTER_COMPLETE` badge; show `counter_presses` / `cards_per_press` in sealing submission summary; enable bag # / UUID search on Workflows page.
3. **Correction expansion:** Wire `SUBMISSION_CORRECTED` (or successor) for sealing + packaging fields with projector updates to `read_bag_metrics`.
4. **Per-bag material panel:** Link from Workflows expand to material events for that bag (read-only).
5. **Finalize reversal:** Design event + projector rollback before building UI — high risk.

---

## 6. Hard-stop confirmation

No changes to: `scan-card-form.tsx`, `stage-progression.ts`, schema/migrations, QR/camera, Zoho/receive, material math, auto-release/auto-finalize, sealing counter logic, packaging payload semantics.
