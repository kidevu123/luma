# Cleanup track closeout — 2026-06-25

**Status:** Low-risk cleanup **complete**. **Stop line** — do not continue refactors from this track without a separate brief.

**Latest cleanup commit:** `05705bb` (`v1.5.19`)  
**Policy:** `VERSIONING.md` — docs-only changes do not bump `package.json`.

---

## Versions covered (v1.5.7 → v1.5.19)

| Version | Theme |
|---------|--------|
| **1.5.7** | `typecheck:scripts` gate + `tsconfig.scripts.json` for 12 operational npm scripts |
| **1.5.8** | Removed unused deps (`react-grid-layout`, `recharts`, `pg-boss`); honest pg-boss docs |
| **1.5.9** | Raw-bag batch lookup fix; Zoho seed failure no longer masks successful intake |
| **1.5.10** | Zoho route labeling (current vs legacy); PO reconciliation cross-link copy |
| **1.5.11** | Atomic supplier-lot batch increment; intake race error copy; batch reuse tests |
| **1.5.12** | Daily Zoho PO sync cron + deploy runbook |
| **1.5.13** | `ZOHO_PO_SYNC_ENABLED` wired into app container |
| **1.5.14** | PO sync timer timezone fix (US Eastern) |
| **1.5.15** | `@deprecated` + no-importer guards on dead raw-bag helpers |
| **1.5.16** | Removed `buildRawBagIntakeReceivePayload` + local `upsertRawBagReceiveRow` |
| **1.5.17** | Dead UI/server-action removal; Zoho note `source?` fields removed; intake trim |
| **1.5.18** | Placeholder tests removed; stale floor-board docs corrected; pilot gitignore |
| **1.5.19** | Six tracked pilot one-shots archived to `scripts/archive/pilot/` |

See `CHANGELOG.md` for per-release detail.

---

## What was removed

### Dead code & UI
- `buildRawBagIntakeReceivePayload`, local `upsertRawBagReceiveRow` (`raw-bag-intake-receive.ts`)
- `components/production/luma-ui.tsx` (~850 lines, never imported)
- `packaging-output/auto-issue-controls.tsx` + `actions.ts` (superseded by `backlog-row-actions.tsx`)
- `floor/[token]/source-allocation-panel.tsx` (never wired)
- `floor-board/_hooks/use-floor-live-refresh.ts` (superseded by `live-refresh.tsx`)
- Ignored `source?` on `RawBagReceiveNotesInput` / `ProductionOutputNotesInput`
- Unused exports: `RawBagReceiveBuildInput`, `parseZohoPurchaseReceiveId` re-export
- Vacuous placeholder tests in synthesizer-dryrun, active-rolls, material-learning

### Dependencies (v1.5.8)
- `react-grid-layout`, `@types/react-grid-layout`, `recharts`, `pg-boss`

### Staging debris
- Untracked root `scripts/_pilot-*.ts` debris (gitignored)
- Six tracked pilots **moved** (not deleted) to `scripts/archive/pilot/`

---

## What was hardened

- **Guard tests:** forbidden reintroduction of removed raw-bag helpers; `zoho-live-commit-eligibility` unwired guard; synthesizer dry-run source checks
- **Canonical paths pinned:** `buildBagFinishReceivePayload`, `seedPendingRawBagReceiveRows`, live `upsertRawBagReceiveRow` in `bag-finish-receive.ts`
- **Receiving:** atomic batch reuse, friendlier PO race errors (v1.5.11)
- **Tooling:** `typecheck:scripts`, eslint/typecheck/vitest/build gates green at **4608** tests
- **Docs:** floor-board `_components/` marked live; pilot archive README; runbook archive pointer

**Explicitly not changed:** live Zoho commit payloads, frozen payload shape, `shared-raw-bag-receive-commit.ts`, schema/migrations, production-output commit behavior, env live-write gates.

---

## Intentionally deferred

Each item below needs its **own brief** before work starts. Do not batch into drive-by refactors.

| Priority | Item | Why deferred |
|----------|------|--------------|
| **Low** | Wire `zoho-live-commit-eligibility.ts` into queue UI pages | Module complete; comments-only references today; guard test in place |
| **Medium** | BOM dispatcher dedup (`sourceAllocationBuildOptsForProduct` vs admin preview) | Active duplicate logic; behavior-sensitive |
| **Medium** | `CommitSource` type consolidation across shared commit modules | Three parallel types; touch commit paths |
| **Medium** | StatusChip consolidation (5+ inline copies) | UI refactor scope |
| **High** | Merge `loadRawBagReceiveContext` with `loadBagFinishReceiveContext` | Historical verify bypass semantics |
| **Out of scope (audit)** | Unique receipt-number migration (LF-1) | Schema change |
| **Out of scope (audit)** | Zoho seed failure repair script (LF-5) | New script + ops path |
| **Intentional** | `v1206-*-pilot-contract.ts` fallback modules | Active until Luma BOM derivation covers all SKUs |
| **Intentional** | `pilot-production-output-commit-window.ts` | Script-only pilot tooling, not dead |
| **Intentional** | Parallel routes (`/po-reconciliation-v2`, legacy Zoho ops pages) | Documented migration lenses |

---

## Risk ranking (deferred work)

1. **High** — raw-bag context loader merge (wrong eligibility on historical verify)
2. **Medium** — BOM dispatcher, CommitSource consolidation, StatusChip sweep (wide diff, easy to miss edge cases)
3. **Low** — live-commit eligibility UI wiring (additive if done carefully)
4. **Schema / ops** — receipt unique index, seed repair script (require migration/deploy planning)

---

## Operator notes

- Live was healthy through the track; deploy timer pulls `main` — verify `/api/health` after `v1.5.19` lands.
- New ad-hoc pilots: create under root `scripts/_pilot-*.ts` (gitignored) → review → archive under `scripts/archive/pilot/` when done.
- **Do not run archived pilots** without explicit operator approval and staging gates (`ALLOW_STAGING_QA_DATA`, etc.).

---

## Gate snapshot at closeout

- typecheck / typecheck:scripts / eslint / vitest **4608** / build — pass at `05705bb`
- No further cleanup commits planned from this track.
