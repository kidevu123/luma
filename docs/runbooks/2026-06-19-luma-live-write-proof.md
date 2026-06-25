# Luma controlled live-write proof — runbook (DRAFT, not executed)

**Created:** 2026-06-19
**Owner approval required at every step.**
**Drafted for v1.4.18 deploy state.**

This runbook executes the two smallest live-write proofs needed
before Luma can be considered production-ready for Zoho writes:

1. Phase 1 — single bag-finish receive for source bag
   `57c8582e-6e0f-4223-9eb3-0dc8ebebe239` (Sweet Trip lot 352167 source).
2. Phase 2 — single production-output commit for finished lot 352167.

Phase 2 is gated on Phase 1 succeeding, the gateway-side
SOURCE_ALLOCATION_COMPONENT_NOT_IN_BOM scoping landing in production,
and an explicit owner go-ahead.

Do not start unless v1.4.18 is the deployed SHA and the audit script
confirms bag `57c8582e-…` is eligible.

## Pre-flight checks (read-only — do these BEFORE any gate flip)

```bash
# 1. Confirm Luma SHA matches v1.4.18 build (a8b8e2d31a936… or newer).
curl -fsS http://192.168.1.134:3000/api/health

# 2. Confirm Luma gates are still OFF.
ssh root@192.168.1.190 "pct exec 122 -- bash -c '
  grep -E \"^(ZOHO_AUTO_COMMIT|ZOHO_DRY_RUN|ZOHO_PRODUCTION_OUTPUT_|ZOHO_BAG_FINISH_)\" /etc/luma/.env'"

# 3. Confirm gateway is on v1.28.0+ (per-row source-allocation scoping).
curl -fsS http://192.168.1.205:8000/health 2>/dev/null || true

# 4. Confirm gateway live-write env (target state for Phase 1 commit).
ssh root@192.168.1.190 "pct exec 9503 -- bash -c '
  grep -E \"^(ENABLE_LIVE_INVENTORY_WRITES|LIVE_INVENTORY_WRITE_ALLOWED_APPS)\" /opt/zoho-integration-service/.env'"

# 5. Run the read-only source-bag receive coverage audit.
ssh root@192.168.1.190 "pct exec 122 -- docker exec luma-app-1 \
  node_modules/.bin/tsx scripts/audit-source-bag-zoho-receive-coverage.ts" \
  | grep 57c8582e

# 6. Run the dry-run backfill script scoped to just our bag — no writes.
ssh root@192.168.1.190 "pct exec 122 -- docker exec luma-app-1 \
  node_modules/.bin/tsx scripts/backfill-source-bag-zoho-receive-previews.ts \
  --inventory-bag-id=57c8582e-6e0f-4223-9eb3-0dc8ebebe239"

# 7. Capture pre-state of zoho_raw_bag_receives for bag 57c8582e
#    (expected: 0 rows).
ssh root@192.168.1.190 "pct exec 122 -- docker exec luma-db-1 psql -U luma -d luma -A -c \"
  SELECT COUNT(*) AS rows_for_bag FROM zoho_raw_bag_receives
  WHERE inventory_bag_id = '57c8582e-6e0f-4223-9eb3-0dc8ebebe239';\""
```

If any of the above fail, **STOP** and report.

## Phase 1 — single bag-finish receive proof

### Step 1.1 — Gateway operator (LXC 9503)

Open `/opt/zoho-integration-service/.env` and temporarily set:

```
ENABLE_LIVE_INVENTORY_WRITES=true
LIVE_INVENTORY_WRITE_ALLOWED_APPS=pack_track,luma
```

Restart the systemd unit so the new env is picked up:

```bash
ssh root@192.168.1.190 "pct exec 9503 -- systemctl restart zoho-integration-service"
ssh root@192.168.1.190 "pct exec 9503 -- systemctl status zoho-integration-service --no-pager" \
  | head -10
```

Verify the gateway is responsive:

```bash
curl -fsS http://192.168.1.205:8000/health || echo "GATEWAY DOWN"
```

### Step 1.2 — Luma operator (LX122)

Edit `/etc/luma/.env` and temporarily set:

```
ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=true
```

Leave every other Luma gate untouched:

```
ZOHO_AUTO_COMMIT_ENABLED=false              ← unchanged
ZOHO_DRY_RUN_WRITES_ENABLED=false           ← unchanged
ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=false ← unchanged
ZOHO_WAREHOUSE_ID=                          ← unchanged (empty)
```

Restart the app container so the gate is read:

```bash
ssh root@192.168.1.190 "pct exec 122 -- bash -c 'cd /opt/luma && docker compose restart app'"
ssh root@192.168.1.190 "pct exec 122 -- docker compose ps"
curl -fsS http://192.168.1.134:3000/api/health
```

### Step 1.3 — Commit ONLY bag `57c8582e-…`

Through the admin UI:

```
http://192.168.1.134:3000/admin/partial-bags/57c8582e-6e0f-4223-9eb3-0dc8ebebe239/zoho-receive
```

1. **Preview** — verifies the gateway accepts the planned payload.
2. **Commit to Zoho** — POSTs to gateway → creates the Zoho purchase
   receive. Idempotency key:
   `luma-bag-finish-receive:57c8582e-6e0f-4223-9eb3-0dc8ebebe239`.

Do not bulk-commit. Do not enable auto-commit. Do not touch any
other bag's receive page.

### Step 1.4 — Immediate gate roll-back

The instant the commit returns successful (or fails), revert the
gates in REVERSE order:

```bash
# Luma — flip back first.
ssh root@192.168.1.190 "pct exec 122 -- bash -c '
  sed -i s/ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=true/ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=false/ /etc/luma/.env
  cd /opt/luma && docker compose restart app'"

# Gateway — flip back AFTER Luma is locked.
ssh root@192.168.1.190 "pct exec 9503 -- bash -c '
  sed -i s/ENABLE_LIVE_INVENTORY_WRITES=true/ENABLE_LIVE_INVENTORY_WRITES=false/ /opt/zoho-integration-service/.env
  sed -i s/LIVE_INVENTORY_WRITE_ALLOWED_APPS=pack_track,luma/LIVE_INVENTORY_WRITE_ALLOWED_APPS=pack_track/ /opt/zoho-integration-service/.env
  systemctl restart zoho-integration-service'"
```

Verify both are off:

```bash
ssh root@192.168.1.190 "pct exec 122 -- grep ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED /etc/luma/.env"
ssh root@192.168.1.190 "pct exec 9503 -- grep -E '^(ENABLE_LIVE_INVENTORY_WRITES|LIVE_INVENTORY_WRITE_ALLOWED_APPS)' /opt/zoho-integration-service/.env"
```

### Step 1.5 — Verify Zoho-side artifact

```sql
SELECT id, inventory_bag_id, zoho_receive_status, reconciliation_status,
       zoho_purchase_receive_id, zoho_received_quantity, committed_at
FROM zoho_raw_bag_receives
WHERE inventory_bag_id = '57c8582e-6e0f-4223-9eb3-0dc8ebebe239'
  AND voided_at IS NULL;
```

Expected:
- exactly **one row**,
- `zoho_receive_status = COMMITTED`,
- `reconciliation_status = RECEIVED_BY_LUMA`,
- `zoho_purchase_receive_id` not null,
- `zoho_received_quantity > 0` (sweet trip bag intake = 6693 pills).

Cross-check on the Zoho side via the gateway:

```bash
curl -s -X GET \
  -H "X-Internal-Token: $ZOHO_INTEGRATION_SECRET" \
  -H "X-Brand: haute_brands" \
  "http://192.168.1.205:8000/zoho/purchase-receives/<the-id-just-returned>"
```

### Step 1.6 — Re-preview lot 352167

> **Note:** `scripts/_pilot-sweet-trip-352167-preview.ts` was never checked in.
> Archived Sweet Trip / FIX Relax one-shots live under
> `scripts/archive/pilot/` (see README there). Do not run without owner approval.

```bash
ssh root@192.168.1.190 "pct exec 122 -- docker exec luma-app-1 \
  node_modules/.bin/tsx scripts/_pilot-sweet-trip-352167-preview.ts" \
  | tee /tmp/sweet-trip-352167-post-receive-output.txt
```

Expected blocker delta:
- `SOURCE_BAG_ZOHO_RECEIPT_UNCONFIRMED` — **GONE** ✅
- `SOURCE_ALLOCATION_COMPONENT_NOT_IN_BOM` — should also be gone if
  gateway v1.28.0 is live and Luma sends `assembly_level`. Re-check.
- `BOM_COMPONENT_INSUFFICIENT_STOCK` — likely remains until prior
  Sweet Trip lots' production output is committed.

If `SOURCE_BAG_ZOHO_RECEIPT_UNCONFIRMED` does NOT clear, **STOP** and
investigate. Do not proceed to Phase 2.

## Phase 2 — single production-output commit (DO NOT EXECUTE WITHOUT OWNER APPROVAL)

Phase 2 prerequisites:

- [x] v1.4.18 deployed (`assembly_level` stamped on source allocations).
- [ ] Gateway v1.28.0 confirmed deployed and per-row scoping live.
- [ ] Phase 1 succeeded for bag `57c8582e-…`.
- [ ] The lot's existing frozen op `6d84bdeb-…` (NEEDS_MAPPING)
      has been voided via the admin UI (`/admin/zoho-production-operations/6d84bdeb-4200-4c2d-b14d-4d33fc85814c`),
      so a fresh preview can persist as PREVIEWED.
- [ ] The `BOM_COMPONENT_INSUFFICIENT_STOCK` blocker has cleared (or
      owner accepts emitting at negative-stock as a known one-off).
- [ ] Owner explicit "GO PHASE 2".

If all are checked, the steps mirror Phase 1 but:
- Replace bag-finish gate with `ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=true`.
- Use the admin "Commit production output" button on `/finished-lots/a4e11918-…#zoho-push`.
- Verify exactly one new `zoho_production_output_ops` row with
  `status = COMMITTED`, `committed_at` set,
  `zoho_manufacture_order_id` populated.
- Verify Zoho composite-item assembly was created.
- Roll back the production-output commit gate immediately.

Phase 2 is **not** authorized by this runbook draft. Do not execute.

## Rollback / abort matrix

| Scenario | Action |
|---|---|
| Gateway 4xx on Phase 1 preview | Flip gates back. Do NOT retry without diagnosing. |
| Gateway 5xx on Phase 1 commit | Flip gates back. Check `zoho_raw_bag_receives` — if a row was inserted, void it (admin UI) and document. |
| Receive lands but Zoho purchase_receive_id missing | Flip gates back. File incident. Do not retry. |
| Lot 352167 preview still shows `SOURCE_BAG_ZOHO_RECEIPT_UNCONFIRMED` after Phase 1 | Flip gates back. Check the loader joins. |
| Any production-output commit attempt during Phase 1 | This is forbidden. If observed, void the op immediately. |

## Hard rules (all phases)

- **Never** flip both gateway and Luma gates at the same time without
  the explicit per-phase sequence above.
- **Never** leave gates on after a phase completes — flip back BEFORE
  taking a break.
- **Never** chain Phase 1 → Phase 2 in the same gate window.
- **Never** widen `LIVE_INVENTORY_WRITE_ALLOWED_APPS` beyond
  `pack_track,luma` for these phases.
- **Never** touch `ZOHO_AUTO_COMMIT_ENABLED` for these phases.

---

End of runbook draft.
