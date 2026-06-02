# Material Change Recovery Plan

**Status:** Dry-run foundation only — no apply path shipped  
**Planner:** `lib/production/material-change-recovery.ts` → `planMaterialChangeRecovery(input, context)`  
**Companion:** `docs/PAUSE_ENDSHIFT_COUNTER_PROCEDURE.md`, `lib/production/counter-snapshot-guard.ts`

---

## Purpose

When a floor counter snapshot is blocked, duplicated, or taken after an early physical reset, supervisors need a **read-only preview** of what a material-change recovery correction *would* do before any future apply tooling exists.

The pure planner returns:

- eligibility (`OK` | `WARNING` | `BLOCKED`)
- blockers and warnings
- before state and after-state preview
- proposed preview events (`previewOnly: true`, `willPersist: false`)
- affected read models

Nothing in this slice writes to production data.

---

## RECOVERY-DRY-RUN-HARNESS-1 — CLI harness

### Command

```bash
npx tsx scripts/material-change-recovery-dry-run.ts \
  --workflow-bag-id <uuid> \
  --station-id <uuid> \
  --old-roll-lot-id <uuid> \
  --new-roll-lot-id <uuid> \
  --segment-count <int> \
  --recovery-kind partial_removed|depleted \
  --material-role PVC|FOIL \
  --reason operator_correction \
  --requested-by sahil \
  --event-boundary-timestamp 2026-06-02T15:00:00.000Z
```

Optional flags:

| Flag | Purpose |
|------|---------|
| `--boundary-event-id <uuid>` | Use a workflow event's `occurred_at` as the boundary (instead of explicit timestamp) |
| `--event-boundary-timestamp <iso8601>` | Required when `--boundary-event-id` is omitted |
| `--ending-weight-grams <int>` | Partial-roll recovery ending weight |
| `--minimum-expected-segment-count <int>` | Lower-bound guard for counter reversal policy |
| `--allow-counter-reversal` | Opt in when segment count is below minimum expected |
| `--requested-by-role <text>` | Secondary requester metadata |
| `--json` | Machine-readable output |
| `--help` | Usage |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Dry-run generated successfully (`OK` or `WARNING`) |
| `2` | Planner **BLOCKED** the scenario (not a script crash) |
| `1` | Missing/invalid args or runtime failure |

### Safety boundaries

Every run prints:

```
DRY RUN ONLY — no data was changed, no events were written, no read models were rebuilt.
```

The harness:

- **SELECT-only** DB reads via `loadMaterialChangeRecoveryContext`
- Calls **`planMaterialChangeRecovery`** only
- Does **not** call `projectEvent`, `writeAudit`, insert/update/delete, or read-model rebuilds
- Does **not** expose an apply command

Proposed events in output are labeled **NOT PERSISTED**.

### Sample output (human)

```
DRY RUN ONLY — no data was changed, no events were written, no read models were rebuilt.

Eligibility: WARNING
Boundary: 2026-06-02T15:00:00.000Z

Blockers:
  (none)

Warnings:
  - [READ_MODEL_REBUILD_REQUIRED] Applying this recovery would require material and genealogy read-model rebuilds.

Proposed preview events (NOT PERSISTED):
  - ROLL_COUNTER_SEGMENT_RECORDED role=PVC lot=... previewOnly=true
  - ROLL_DEPLETED role=PVC lot=... previewOnly=true
  - ROLL_MOUNTED role=PVC lot=... previewOnly=true

Next steps:
  - Review warnings and proposed preview events with a supervisor.
  - Apply is not shipped. Do not manually edit production data.
```

### When eligibility is BLOCKED

Common blockers:

- `MISSING_WORKFLOW_BAG` / `MISSING_STATION` / roll lots not found in loaded context
- `DUPLICATE_SEGMENT_RISK` — equivalent segment already exists
- `FINALIZED_BAG_BOUNDARY` / `FINISHED_LOT_BOUNDARY`
- `OLD_ROLL_NOT_ACTIVE_AT_BOUNDARY` — old roll was not active on the machine

**Do not** manually edit DB rows. Escalate to Sahil with the dry-run output. No apply path exists.

### What this does not do

- No recovery apply / confirm action
- No admin UI
- No historical backfill automation
- No exception path for finalized bags or finished lots
- No Zoho or floor behavior changes

---

## Related slices (not shipped)

| Slice | Purpose |
|-------|---------|
| `SHIFT-REVIEW-1` | Admin post-shift segment review |
| `RECOVERY-PREVIEW-UI-1` | Read-only admin preview (still no apply) |
| Future apply slice | Requires PM approval, migrations, and rebuild strategy |
