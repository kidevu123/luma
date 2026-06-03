# Bug / UI backlog

**Purpose:** Prioritized, visible bug and UI-friction work — separate from launch hardening and recovery tooling.

**Last updated:** 2026-06-03 (PARTIAL-BAG-NOT-LISTED-AFTER-PARTIAL-PACKAGING-1 closeout)

**Live baseline:** v0.4.88 @ `4e335aa` (verify via `/api/health` — deploy drift expected until v0.4.90 lands)

---

## 1. P0 — Launch blockers

| Title | Area | Why it matters | Status | Size | Risk | Owner |
|-------|------|----------------|--------|------|------|-------|
| Incomplete receive/QR before floor start | Receiving / floor | Operators hit confusing blocks mid-shift | **Mitigated** — HARDENING-1 (0.4.79) badges + scan block | S | Low | Shipped |
| Partial bags vanish after partial packaging | Admin / inventory | `/partial-bags` empty while workflow partial path active | **Fixed** 0.4.90 — admin review rows + safe ledger return | M | Med | Shipped |
| Legacy workflow bags without inventory link | Data / admin | `Legacy bag …` in submissions; hand-pack blocks | Open — PM-gated repair only | L | High | PM + Sahil |
| Live Zoho production output writes | Output | Business gate | **Paused** by design | — | — | PM |

---

## 2. P1 — Bugs / workflow friction

| Title | Area | Why it matters | Status | Size | Risk | Owner |
|-------|------|----------------|--------|------|------|-------|
| Settings “Version” showed git SHA only | Admin / settings | Admins could not match package semver to release notes | **Fixed** batch-1 | XS | Low | Shipped |
| Inbound bag table showed raw `BAG-*` as floor QR | Receiving | Wizard bags look ready but need physical card assign | **Fixed** batch-1 | XS | Low | Shipped |
| Raw-bag intake: no pointer to floor-readiness check | Receiving | After save, admins unsure if bags are floor-ready | **Fixed** batch-1 | XS | Low | Shipped |
| LAUNCH_CONTROL / checklist stale version SHA | Docs | Pre-shift checks reference wrong release | **Fixed** batch-1 | XS | None | Shipped |
| Recovery apply path missing | Production / rolls | Cannot fix bad roll state in-app | Not built — dry-run only | L | High | Deferred |
| Admin recovery preview UI | Admin | Supervisors need read-only plan without CLI | Not built | M | Med | Deferred |
| Floor employee UX (multi-page, pickers) | Floor PWA | Validation UI not production-simple | Future phase | L | Med | See `FLOOR_UI_POLISH_REQUIREMENTS.md` |
| Sealing segment UX clarity | Floor sealing | Operators unsure segment vs final close | **Improved** SEALING-SEGMENT-UX-1 (0.4.82) | M | Med | Shipped |
| Op # / override vs open shift | Floor | Confusing dual accountability | Open | S | Med | Plan: station-behavior-audit |

---

## 3. P2 — UI polish / clarity

| Title | Area | Why it matters | Status | Size | Risk | Owner |
|-------|------|----------------|--------|------|------|-------|
| Workflow submissions 200-row cap notice | Admin | Users may think list is complete | **Exists** — limit message when 200 | — | — | OK |
| Link workflow submissions ↔ shift review | Admin | Supervisors search bags vs counter review | **Improved** batch-1 cross-links | XS | Low | Shipped |
| Raw-bags page per-bag readiness badges | Receiving | Only inbound detail has badges today | **Shipped** RAW-BAGS-READINESS-BADGES-1 (0.4.83) | S | Low | Shipped |
| QR cards list: emphasize label over token | Admin / QR | Tokens are internal; label is what operators see | Open | S | Low | Next batch |
| Shift review default window copy | Admin | First visit clarity | Open | XS | Low | Next batch |
| Floor board command center | Admin | No single at-a-glance floor view | Deferred | L | Med | Post-pilot |

---

## 4. P3 — Hardening / future improvements

| Title | Area | Why it matters | Status | Size | Risk | Owner |
|-------|------|----------------|--------|------|------|-------|
| Batch RELEASED gate on all blister starts | Floor | Only vendor-barcode path checks batch today | Open | S | Med | PM decision |
| Mandatory raw-bag intake vs wizard + later QR | Receiving | Two intake paths, different QR semantics | Open | M | Med | PM decision |
| Deploy timer overlap / conflicts=fail | Infra | Rare double-deploy | Open | S | Low | Infra |
| Camera scan root-cause | Floor | Scan failures | Plan doc only | M | Med | Deferred |
| Legacy `workflow_bags.receipt_number` backfill | Data | Display coalesce vs canonical | PM decision | M | High | PM only |

---

## 5. Deferred / not now

| Title | Notes |
|-------|--------|
| Material-change recovery **apply** | Blocked until preview UI + training |
| Nexus commercial-trace expansion | Read-only endpoints shipped; not floor UX |
| Broad floor redesign | `FLOOR_UI_POLISH_REQUIREMENTS.md` — not this quarter |
| New migrations for convenience | Only when a specific bug requires it |

---

## Shipped reference (recent — not backlog)

| Version | Slice |
|---------|--------|
| 0.4.83 | RAW-BAGS-READINESS-BADGES-1 |
| 0.4.82 | SEALING-SEGMENT-UX-1 |
| 0.4.81 | TEST-STABILIZATION-1 |
| 0.4.80 | BUG-UI-FIX-BATCH-1 |
| 0.4.79 | PRODUCTION-DATA-ENTRY-HARDENING-1 |
| 0.4.78 | SHIFT-REVIEW-1 |
| 0.4.77 | Recovery dry-run CLI |
| 0.4.76 | Counter snapshot guards |
| 0.4.75 | Pause/end-shift copy |
| 0.4.74 | Sealing product persist + lock |
| 0.4.72 | Hand-pack tablet context |

---

## How to use this doc

1. Pick from **P1** or **P2** for the next bug/UI batch (3–5 XS/S items).
2. Do not pull **P3** or **Deferred** into a batch unless PM promotes them.
3. Close items here when merged; add new rows from floor feedback or screenshots.
