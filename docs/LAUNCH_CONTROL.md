# Launch Control

**Purpose:** Single source of truth for what is live on staging/production, what is intentionally not shipped, and what blocks blister-room launch. Updated by PM/QA passes — not by feature work.

---

## Zoho Push to Zoho — go-live posture (active)

| Field | Value |
|-------|-------|
| **Luma version** | `1.0.1` |
| **Luma SHA** | `ca2b9a2` (verify `/api/health`) |
| **Zoho Integration** | `1.21.3` |
| **Workflow** | Preview-first, PM-gated live commit |
| **Day-1 live-commit SKUs** | FIX Relax 1ct, Hyroxi MIT B - Sweet Trip only |
| **Default gates** | All commit gates **closed**; preview capabilities **allowed** |

**Canonical doc index:** [ZOHO_PUSH_GO_LIVE_INDEX.md](./ZOHO_PUSH_GO_LIVE_INDEX.md)

**Supersedes:** The v0.4.x snapshot below for Zoho push launch truth. Floor/blister slices in the historical section remain accurate unless contradicted above.

**Last verified:** 2026-06-02 (Zoho Push go-live activation)

---

## Historical snapshot (pre–Zoho push go-live)

**Last verified:** 2026-06-02 (BUG-UI-BACKLOG-RESET-1)

### Current live snapshot (legacy reference)

| Field | Value |
|-------|-------|
| **Version** | `0.4.79` (superseded by v1.0.1 for Zoho push) |
| **Git SHA** | verify `/api/health` — expect `41864de…` after 0.4.79 deploy |
| **Staging health** | `ok` (app + db) |
| **Deploy verify** | `npm run verify:deploy` → exit 0, SHA match |
| **Auth smoke** | PASS=52, REDIR=1, FAIL=0 (`/workflow-submissions`, `/shift-review`) |
| **Latest migration** | `0053_zoho_production_output_commit_readiness` (journal idx 52) — applied on staging; no pending migrations detected |

**Verify commands (read-only):**

```bash
command git rev-parse HEAD
grep '"version"' package.json
curl -sS http://192.168.1.134:3000/api/health | jq .
npm run verify:deploy
# Auth smoke (on LXC 122):
docker compose exec -T -e ALLOW_STAGING_QA_DATA=true app node_modules/.bin/tsx scripts/smoke-authenticated-routes.ts
```

**Related docs:**

- `docs/BLISTER_ROOM_READINESS_CHECKLIST.md` — operator/admin pre-shift and floor checklist
- `docs/PRODUCTION_DATA_ENTRY_HARDENING_AUDIT.md` — receive → QR → floor lineage audit
- `docs/BUG_UI_BACKLOG.md` — prioritized bug/UI friction backlog
- `docs/CURRENT_PHASE_STATUS.md` — append-only historical phase log (older entries); use *this* doc for launch truth

---

## Shipped (live in v0.4.69–v0.4.73)

These slices are merged to `main`, deployed to staging, and verified unless noted.

| Slice | Version | What operators/admins get |
|-------|---------|---------------------------|
| **Station Management** | 0.4.69 | Admin rename/add/deactivate/reactivate stations; inactive stations block new floor actions but allow end-shift exit |
| **Partial Roll Swap** | 0.4.69 | Mid-bag PVC/foil change with depleted vs partial-removal paths; partial removal returns old roll to AVAILABLE |
| **Workflow Submissions display** | 0.4.70 | Receipt # from `inventory_bags.internal_receipt_number`; human-readable bag labels; honest `Legacy bag …` fallback |
| **Deploy verification hardening** | 0.4.71 | Rebuild-on-drift deploy script; `verify:deploy` fails on SHA/health mismatch; `/workflow-submissions` in auth smoke |
| **Hand-pack tablet context** | 0.4.72 | Hand-pack resolves tablet from received bag lineage; missing lineage blocks; no manual tablet picker for linked bags |
| **Material-change recovery dry-run** | 0.4.73 | `planMaterialChangeRecovery()` — blockers, warnings, preview only; **no DB writes, no UI, no apply** |
| **Blister pause count snapshot** | 0.4.64+ | Machine-jam / pause flows require counter snapshot on blister stations (prerequisite for end-shift discipline) |

---

## Intentionally NOT shipped

Do not assume these exist on the floor or in admin UI.

| Capability | Status | Notes |
|------------|--------|-------|
| Material-change recovery **apply** path | Not built | Dry-run planner only (`lib/production/material-change-recovery.ts`) |
| Admin recovery UI | Not built | No preview screen, no confirm/apply |
| Live Zoho production output writes | Paused | Queue/readiness/mock commit state only; no live HTTP to Zoho |
| Legacy/unlinked hand-pack tablet override | Removed/blocked | Missing lineage blocks; repair is admin/PM procedure, not operator override |
| **Sealing finished-product persistence + lock** | Shipped (v0.4.74+) | `saveSealingProductAction` writes `workflow_bags.product_id`; Save product is refresh-safe; segment/close-out re-read server-side |
| Finished-lot / finalized bag auto-repair | Not built | Any correction needs PM approval + scripted repair |
| DB repair scripts on production | Out of scope for operators | Exist for one-off ops; never run without Sahil |

---

## Task board (P0 / P1 / P2)

Prioritized for **blister-room launch**. "Active" = in flight or needs daily attention; not necessarily open code tasks.

### Closed (verified on staging)

- STATION-MGMT-1 — station admin + inactive floor guard
- PARTIAL-ROLL-SWAP-LAUNCH-P1 — depleted vs partial roll removal
- WORKFLOW-SUBMISSIONS-DISPLAY-P1 — receipt + bag labels
- DEPLOY-VERIFY-1 — drift guard + verify:deploy + workflow-submissions smoke
- HANDPACK-TABLET-CONTEXT-1 — lineage-based tablet on hand-pack
- SEALING-PRODUCT-PERSIST-1 — Save product persists + locks `workflow_bags.product_id` at sealing
- MATERIAL-CHANGE-RECOVERY-DRY-RUN-1 — planner + tests, no apply
- SHIFT-REVIEW-1 — read-only post-shift blister review (`/shift-review`)
- PRODUCTION-DATA-ENTRY-HARDENING-1 — ready-for-floor validation + inbound badges + floor scan block (0.4.79)
- LAUNCH-CONTROL-RESET-P1 — this documentation pass

### Active

- **Blister-room floor dual-run** — physical production on Luma floor PWA with Sahil on-call for red flags (see checklist)
- **Pre-shift verification ritual** — health, verify:deploy, auth smoke, rolls, stations, data entry completeness

### Next (P1 — ranked)

1. **Bug/UI fix batches** — see `docs/BUG_UI_BACKLOG.md` (visible friction, not more hardening by default)
2. Pause/end-shift count workflow validation + operator training
3. Raw-bags page floor-readiness badges (inbound detail already has them)
4. Script-backed recovery dry-run harness (CLI — exists; document for supervisors)
5. Admin recovery preview UI (read-only plan output, still no apply)
6. Legacy/unlinked bag repair procedure (documented + scripted, PM-gated)
7. Deploy timer overlap lock / Conflicts=fail hardening

### Blocked (until PM explicitly unblocks)

- Recovery apply path (needs dry-run harness + preview UI + training first)
- Live Zoho production output commit (business + technical readiness gates remain)
- Any finalized/finished-lot correction without explicit PM sign-off

### Deferred (not launch blockers)

- Sealing flow clarity / segment UX (`docs/superpowers/plans/2026-05-28-sealing-flow-clarity-1.md`)
- Floor board command center
- Camera scan root-cause / QR payload plans
- Station/sealing behavior audits (post-blister-room)
- Nexus commercial-trace expansion (read-only endpoints already shipped earlier)

---

## Launch risk summary

| Risk | Mitigation / current state |
|------|----------------------------|
| Floor can physically outrun data entry | Checklist requires receive + QR link + lineage before first scan; missing lineage **blocks** hand-pack |
| Recovery tooling is dry-run only | Operators cannot "fix" bad roll state in-app; stop floor and call Sahil |
| Missing-lineage bags block rather than guess | Hand-pack and submissions use honest labels; no fabricated PO/tablet |
| Deploy drift | `luma-deploy.sh` rebuilds on SHA mismatch; `verify:deploy` fails CI/local checks |
| Zoho live writes intentionally paused | Finished-lot Zoho path is preview/queue/readiness only |
| Counter snapshot confusion | Pause/end-shift requires snapshot; physical machine reset after snapshot is operator procedure (see checklist) |
| Inactive station misconfiguration | Only `Hand Pack Blister Smoke` inactive on staging; real hand-pack station active |
| Incomplete receive/QR lineage before floor | HARDENING-1 adds readiness gate; hand-pack already blocks missing tablet lineage |

---

## Do not touch without PM approval

| Action | Why |
|--------|-----|
| Recovery **apply** (events, roll-lot updates, projector rebuild) | No apply path exists; untested on live bags |
| Finalized / finished-lot repair or backfill | Genealogy and Zoho readiness implications |
| Live Zoho production output write or `/commit` enablement | Gateway-only, dry-run/queue culture until explicit go-live |
| DB repair scripts (`scripts/repair-*`, `scripts/apply-*`) | Can mutate production truth |
| Manual tablet/product overrides for linked bags | Violates lineage-first model shipped in 0.4.72 |
| Deactivating production stations without floor notice | Blocks operators mid-shift |
| Force deploy without verify:deploy green | Reintroduces drift class fixed in 0.4.71 |

---

## Staging read-only spot checks (2026-05-27)

| Check | Result |
|-------|--------|
| Active stations | 9 active (Blister Room, 3× sealing, packaging, 3× bottle, Blister Hand Pack Station) |
| Inactive stations | `Hand Pack Blister Smoke` only (intentional test station) |
| Active PVC/foil rolls | `PVC-3` (IN_USE), `Legacy FOIL-01` (IN_USE) |
| Bag Card 137 | Linked; receipt `352178`; tablet `MIT B Strawberry Pink`; stage `BLISTERED` |
| Workflow submissions route | Auth smoke PASS 200 |

---

## Change log for this doc

| Date | Change |
|------|--------|
| 2026-05-27 | Added SEALING-PRODUCT-PERSIST-1 to P1 board and launch risks |
| 2026-05-27 | Initial launch-control reset at v0.4.73 / `5c975ee` |
