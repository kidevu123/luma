# v1.1.0 staging-buffer — observation runbook

Use this to monitor real staging events while live writes stay OFF.
Run the queries periodically (or after each operator action) until
all 7 checks are GREEN at least once on freshly-seeded data.

## Observation-mode env posture (pinned)

```
ZOHO_AUTO_COMMIT_ENABLED                  = false
ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED     = false
ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED    = false
ZOHO_DRY_RUN_WRITES_ENABLED               = false
ZOHO_PRODUCTION_OUTPUT_PERSIST_ENABLED    = true     (staging on)
ZOHO_PRODUCTION_OUTPUT_PREVIEW_ENABLED    = true     (staging on)
ZOHO_AUTO_COMMIT_BUFFER_HOURS             = 24
LUMA_CRON_SECRET                          = <44-char>
```

## Baseline DB snapshot (taken at v1.1.1 deploy)

| Table | total_rows | with_eligibility | with_frozen_payload | committed_ever | committed_last_24h |
|---|---:|---:|---:|---:|---:|
| `zoho_raw_bag_receives` | 7 | 0 | 0 | 0 | 0 |
| `zoho_production_output_ops` | 3 | 0 | 3 | 2 | 0 |

The 7 existing raw-bag rows + 3 production-output rows pre-date the
freeze + buffer logic — they have no `auto_commit_eligible_at` and
will NEVER be auto-committed. New intake from now on will be seeded
with both.

---

## The 7 observation checks

Run each query against the live LXC. SSH path:
`ssh root@192.168.1.190 'pct exec 122 -- docker exec luma-db-1 psql -U luma -d luma -c "<query>"'`

### Check 1 — new raw-bag receives get `auto_commit_eligible_at`

```sql
SELECT
  id,
  inventory_bag_id,
  zoho_receive_status AS status,
  auto_commit_eligible_at,
  (auto_commit_eligible_at - created_at) AS buffer_offset,
  created_at
FROM zoho_raw_bag_receives
WHERE created_at > now() - interval '1 hour'
ORDER BY created_at DESC;
```

✅ GREEN when: new rows show non-null `auto_commit_eligible_at` and
`buffer_offset` is ~24h (or whatever `ZOHO_AUTO_COMMIT_BUFFER_HOURS` is set to).
🔴 RED when: new rows show null `auto_commit_eligible_at`.

### Check 2 — new raw-bag receives freeze payload + notes

```sql
SELECT
  id,
  inventory_bag_id,
  zoho_receive_status AS status,
  (commit_request_payload IS NOT NULL) AS has_frozen_payload,
  (commit_request_payload->>'notes' IS NOT NULL) AS has_notes,
  length(commit_request_payload->>'notes') AS notes_length,
  left(commit_request_payload->>'notes', 80) AS notes_first_80,
  commit_idempotency_key IS NOT NULL AS has_commit_key
FROM zoho_raw_bag_receives
WHERE created_at > now() - interval '1 hour'
ORDER BY created_at DESC;
```

✅ GREEN when: `has_frozen_payload = true`, `has_notes = true`,
`notes_first_80` contains identifiers like `Luma op:`, `Receipt #:`,
`Bag #:`, and `has_commit_key = true`.

### Check 3 — production-output previews persist

```sql
SELECT
  id,
  finished_lot_id,
  status,
  payload_kind,
  preview_status,
  (request_payload IS NOT NULL) AS has_frozen_payload,
  created_at,
  previewed_at
FROM zoho_production_output_ops
WHERE created_at > now() - interval '1 hour'
ORDER BY created_at DESC;
```

✅ GREEN when: new rows appear after an operator runs a preview.

### Check 4 — production-output frozen payload + notes

```sql
SELECT
  id,
  finished_lot_id,
  status,
  (request_payload->>'notes' IS NOT NULL) AS has_notes,
  length(request_payload->>'notes') AS notes_length,
  left(request_payload->>'notes', 120) AS notes_first_120
FROM zoho_production_output_ops
WHERE created_at > now() - interval '1 hour'
ORDER BY created_at DESC;
```

✅ GREEN when: `notes_first_120` contains `Luma op:`, `Lot #:`, `SKU:`,
`Units:`. Operator-supplied notes (if any) appear after a
`Operator notes:` header.

### Check 5 — UI shows expected controls

**Manual smoke (not SQL):** open the queue pages in a browser
(authenticated):

| Page | Expected controls per row |
|---|---|
| `/zoho-production-operations` | `Approve for auto-commit` · `Approve & commit now` · `Hold` · `Void` |
| `/partial-bags/[id]/zoho-receive` | `Push to Zoho now` · `Hold` · `Void` (and `Unhold` if held) |

✅ GREEN when:
- Hold + Void prompt for a reason (≤ 500 chars)
- Held rows show only `Unhold` + `Void`
- Voided rows show no commit/hold buttons; "Voided — will not be sent" copy visible
- Approve & commit now / Push to Zoho now (with current env) shows an
  error toast: *"Live commit disabled by env flag: ZOHO_..."* — confirms
  GUARD_BLOCKED reaches the operator UI

### Check 6 — NEEDS_REVIEW / NEEDS_MAPPING display

If an operator triggers a preview that returns mapping blockers
(missing Zoho IDs / wrong PO / etc.) or an over-receive scenario:

```sql
SELECT
  id,
  inventory_bag_id,
  zoho_receive_status AS status,
  mapping_blockers,
  commit_error
FROM zoho_raw_bag_receives
WHERE zoho_receive_status IN ('NEEDS_MAPPING', 'NEEDS_REVIEW')
ORDER BY updated_at DESC LIMIT 10;
```

✅ GREEN when:
- `OVER_RECEIVE_EXCEEDS_PO_REMAINING` → row in status `NEEDS_REVIEW`
- `PO_NOT_FOUND` / `LINE_MISMATCH` / Zoho-IDs-missing → row in `NEEDS_MAPPING`
- UI shows the overs-decision copy for NEEDS_REVIEW
- UI shows the mapping/config copy for NEEDS_MAPPING
- The two queues are visually distinct (different chip colour)

### Check 7 — cron continues to run but commits nothing

```sql
SELECT
  count(*) AS recent_commits_30min,
  COALESCE(max(committed_at)::text, 'never') AS latest_commit
FROM zoho_raw_bag_receives
WHERE committed_at > now() - interval '30 minutes'
UNION ALL
SELECT
  count(*),
  COALESCE(max(committed_at)::text, 'never')
FROM zoho_production_output_ops
WHERE committed_at > now() - interval '30 minutes';
```

✅ GREEN when: both queries return `0 | never`.

Plus the systemd journal:

```bash
ssh root@192.168.1.190 \
  'pct exec 122 -- journalctl -u luma-zoho-auto-commit.service --since "1 hour ago" --no-pager' \
  | grep -E '"committed":[^0]'
```

✅ GREEN when: no lines match (every sweep body has `"committed":0`).

### Bonus check — cron timer is firing

```bash
ssh root@192.168.1.190 \
  'pct exec 122 -- systemctl list-timers luma-zoho-auto-commit.timer --no-pager'
```

✅ GREEN when: `NEXT` shows a near-future timestamp and `LAST` was
≤ 5 minutes ago.
