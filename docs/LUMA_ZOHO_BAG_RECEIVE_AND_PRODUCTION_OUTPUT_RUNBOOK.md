# Luma → Zoho bag receive and production-output runbook

Operational guide for the two-step inventory workflow:

1. **Bag-finish receive** — one Zoho purchase receive per physical bag (raw tablets into inventory).
2. **Production-output assembly** — one Zoho assembly/bundle per finished lot (consumes raw + packaging; **does not** create another purchase receive when bag is already received).

**Default posture:** All live commits **disabled**. Preview always allowed when configured.

---

## Architecture

```
Floor / Admin (Luma)
    → Zoho Integration Service (LXC 9503, :8000)
        → Zoho Inventory API
```

Luma never calls Zoho OAuth directly. See [ZOHO_SHARED_SERVICE_PRODUCTION_OUTPUT_CONTRACT.md](./ZOHO_SHARED_SERVICE_PRODUCTION_OUTPUT_CONTRACT.md) and [ZOHO_RAW_BAG_RECEIPT_GRANULARITY.md](./ZOHO_RAW_BAG_RECEIPT_GRANULARITY.md).

---

## Phase 1 — Bag-finish receive (raw intake)

### When to use

Physical bag of raw tablets is finalized on the floor and must appear in Zoho Inventory against the correct PO line.

### Preconditions

See checklist sections **A**, **B**, **C** in [ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md](./ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md).

### Preview

- Eligibility: `assessBagFinishReceiveEligibility` (AVAILABLE bag, policy satisfied).
- Zoho preview via raw intake path (capability `luma.raw_intake.preview`).
- Confirm PO line, raw item, **declared physical quantity**, receive date.

### Commit (PM-approved window only)

1. Set `ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=true` on Luma ( `/etc/luma/.env` ).
2. Set `ENABLE_LIVE_INVENTORY_WRITES=true` on Zoho CT 9503.
3. Grant `luma.raw_intake.commit` only (keep `luma.production_output.commit` **disabled** unless output is also approved).
4. Execute **one** bag receive commit.
5. Close all gates; revoke commit capability; verify guards.

**Idempotency key:** `luma-bag-finish-receive:{inventory_bag_id}`

### Success criteria

- Luma `zoho_raw_bag_receives`: COMMITTED, `RECEIVED_BY_LUMA`.
- Zoho PR created once; PO line received qty increased by **full bag qty**.
- Bag may remain AVAILABLE for floor consumption tracking.

---

## Phase 2 — Production-output assembly

### When to use

Finished lot is issued with closed allocation; Zoho must record assembled singles (unit composite) consuming raw tablet + packaging from stock.

### Preconditions

See checklist sections **A**, **B**, **D** in [ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md](./ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md).

**Requires:** Source bag already `RECEIVED_BY_LUMA` (durable receive proof).

### Preview

- Consolidated op upserted per finished lot (`zoho_production_output_ops`).
- Luma calls `POST /zoho/luma/production-output/preview` with body from `buildProductionOutputServicePayloadFromLuma()`.
- Confirm:
  - `preview_valid=true`, `blockers=[]`
  - `planned_commit_sequence` is assembly-only when receive proof present
  - Component consumption matches BOM × output qty
  - Source receipt PR ID matches bag receive

### Commit (PM-approved window only)

1. Queue op (`READY` → `QUEUED`) if required.
2. Set `ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=true` on Luma.
3. Set `ENABLE_LIVE_INVENTORY_WRITES=true` on Zoho.
4. Grant `luma.production_output.commit` only (keep `luma.raw_intake.commit` **disabled** unless receive is also in scope).
5. Execute **one** `processConsolidatedProductionOutputCommit`.
6. Close all gates; revoke commit capability; verify guards.

**Idempotency key:** `luma-production-output:{finishedLotId}`

**Payload rule:** Never POST internal `source: "LUMA"` body to Zoho commit. Always use `buildProductionOutputServicePayloadFromLuma()` (preview and commit share this mapper).

### Success criteria

- Luma op: `COMMITTED`, `zoho_bundle_ids` populated from response `steps[]`.
- Zoho: bundle/assembly created; **no** new purchase receive when `assembly_only=true`.
- `zoho_receive_id` on op remains null for assembly-only commits.

---

## Operational warnings (read before any live window)

| Hazard | Guidance |
|--------|----------|
| Receive consumed qty instead of physical bag qty | Always receive **declared_pill_count** (e.g. 500), never output qty (e.g. 10). |
| Production-output creates purchase receive | If `planned_commit_sequence` includes `receive`, stop — bag must already be received. |
| Trusting historical Choco PRs without proof | Require durable `zoho_raw_bag_receives` + `RECEIVED_BY_LUMA` for assembly. |
| Leaving `ENABLE_LIVE_INVENTORY_WRITES=true` | Close immediately after single attempt; verify `false`. |
| Leaving commit capabilities granted | Set `luma.*.commit` to **disabled** after window. |
| Hot-patch without committing | Hot-patches are for emergencies only; merge durability fix before next SKU. |
| Manual reconciliation of ambiguous history | Do not replay or patch idempotency without PM + Zoho PM; fix forward in code. |
| `WAREHOUSE_LIST_EMPTY` warning | Confirm `warehouse_required=false` in preview; if true, stop (`BLOCKED_WAREHOUSE_CONFIG`). |
| Preview/commit payload drift | Preview and commit must both use `buildProductionOutputServicePayloadFromLuma()`; only `notes` may differ. |
| Idempotency key reuse with different body | HTTP 409; never change payload under same key — fix mapper first. |
| Double posting | One receive per bag; one committed production-output op per finished lot. |

---

## Read-only verification commands (production)

Run from LXC 122 / CT 9503 — **no writes**.

```bash
# Luma health + SHA
curl -s http://127.0.0.1:3000/api/health

# Luma gates
grep -E 'ZOHO_PRODUCTION_OUTPUT_COMMIT|ZOHO_BAG_FINISH' /etc/luma/.env

# Zoho health + live-write gate
curl -s http://127.0.0.1:8000/health
grep ENABLE_LIVE /opt/zoho-integration-service/.env
```

---

## Pilot reference

Full FIX Relax proof: [FIX_RELAX_PILOT_CLOSEOUT.md](./FIX_RELAX_PILOT_CLOSEOUT.md).

Rollout checklist: [ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md](./ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md).
