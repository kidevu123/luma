# FIX Relax 1ct pilot — closeout summary

**Status:** Complete (2026-06-11). **No further live commits authorized** for this pilot unless PM opens a new approval window.

This document records the first end-to-end proof of Luma bag-finish receive + assembly-only production-output commit for a new SKU (FIX Relax 1ct).

## Pilot proof (authoritative)

| Artifact | Value |
|----------|--------|
| Source bag | `e7fac20d-6514-4d6f-b8a1-bc4d120c5c3c` |
| Luma receipt | `PO-00249-R1-B1-2` |
| Human lot | `146-26-1980` |
| Zoho purchase receive | **PR-00569** / `5254962000006735004` |
| Receive quantity | **500** (full declared physical bag qty) |
| Finished lot | `61c0ad45-dd1a-4764-b560-57291cf35022` |
| Production-output op | `f0256ebc-5f3c-4d54-aff8-3e76228a3847` |
| Zoho bundle (assembly) | `5254962000006741002` |
| Product | FIX Relax 1ct (`95c61efe-a36a-44df-8fee-8e66d659ed80`) |
| Unit composite | `5254962000001258190` |
| Output | 10 singles |
| Raw tablet consumed | `5254962000001258058` × 10 |
| Packaging consumed | `5254962000000679541` × 10 |
| Commit sequence | `["unit_assembly"]` only |
| Purchase receive step | **Absent** (assembly-only) |
| Idempotency (receive) | `luma-bag-finish-receive:e7fac20d-6514-4d6f-b8a1-bc4d120c5c3c` |
| Idempotency (output) | `luma-production-output:61c0ad45-dd1a-4764-b560-57291cf35022` |

Canonical constants also live in `lib/zoho/v1206-fix-relax-pilot-contract.ts`.

---

## Pilot flow (10 steps)

### 1. Composite verification

- Confirmed Zoho unit composite `5254962000001258190` exists and is active.
- Inspected composite BOM on Zoho Integration Service (CT 9503): raw tablet × 1, packaging × 1 per unit; not batch-tracked.

### 2. Luma product mapping

- Product `FIX Relax 1ct` mapped with `zoho_item_id_unit`, `product_family=FIX_RELAX`, tablets-per-unit and packaging structure populated.
- Floor QR / workflow card available for pilot bag.

### 3. Floor walkthrough

- Operator path validated: allocation → finalize → finished lot → production-output preview eligibility.
- Closed allocation session required before output preview.

### 4. Bag-finish receive preview

- Preview against Zoho Integration `raw_intake` preview path.
- Verified PO line, raw item, quantity **500** (declared physical count, not consumed/output qty).

### 5. Controlled bag receive commit

- **Succeeded:** PR-00569, qty 500, `reconciliation_status=RECEIVED_BY_LUMA`.
- Bag remains **AVAILABLE** with ending balance after floor consumption (not depleted by receive).
- One controlled live window; gates closed immediately after.

### 6. Luma/Zoho family mapping + BOM contract fixes

- **Initial failure:** `BOM_QUANTITY_PENDING` blocked production-output preview.
- **Fix (durable):** `lib/zoho/v1206-fix-relax-pilot-contract.ts` — normalized BOM qty 1:1, `requires_component_batches=false`, wired via `sourceAllocationBuildOptsForSku()`.
- **Deployed:** commit `253105c` (v0.4.109 image line).

### 7. Production-output preview

- **Succeeded:** HTTP 200, `preview_valid=true`, `blockers=[]`, `planned_commit_sequence=["unit_assembly"]`.
- Source receipt PR-00569 present; component stock checks raw × 10, packaging × 10.
- **Warning only:** `WAREHOUSE_LIST_EMPTY` (`warehouse_required=false`, validation skipped).

### 8. Controlled production-output assembly commit

- **Succeeded in Zoho:** bundle `5254962000006741002`, qty 10, no purchase receive.
- **Initial failures:**
  - Network timing on first attempt (Luma `fetch failed`).
  - HTTP **422** — Luma posted internal `source: "LUMA"` body instead of Zoho service contract.
  - HTTP **409** idempotency conflict after hotfix (key already used with different payload hash).
- **Luma persistence gap:** Zoho idempotency recorded success before Luma row updated; one-time reconciliation from idempotency proof.

### 9. Durability hardening

- **Hot-patched then committed:**
  - `lib/zoho/production-output-service-payload.ts` — `buildProductionOutputServicePayloadFromLuma()` shared by preview + commit.
  - `parseZohoCommitResponseIds()` — reads bundle IDs from `steps[]`.
- **Deployed:** commit `70586e9` (v0.4.110).

### 10. Gate closure

- Luma: `ZOHO_PRODUCTION_OUTPUT_COMMIT_ENABLED=false`, `ZOHO_BAG_FINISH_RECEIVE_COMMIT_ENABLED=false`.
- Zoho: `ENABLE_LIVE_INVENTORY_WRITES=false`.
- Capabilities: `luma.production_output.commit` **disabled**, `luma.raw_intake.commit` **disabled**; preview capabilities remain **allowed**.

---

## What succeeded

- Full pilot chain: Zoho master data → Luma mapping → bag receive → assembly-only output.
- Assembly-only policy honored (no second purchase receive on output).
- Idempotency keys stable per bag / per finished lot.
- Preview and commit contract aligned after durability fix.

## What failed initially

| Issue | Symptom | Resolution |
|-------|---------|------------|
| BOM not normalized in Luma | `BOM_QUANTITY_PENDING` | FIX Relax pilot contract module (`253105c`) |
| Wrong commit payload shape | HTTP 422 `Field required` on `purchaseorder_id`, `source_bag_id` | Service payload mapper (`70586e9`) |
| Zoho succeeded, Luma lagged | FAILED op despite bundle in Zoho | One-time idempotency reconciliation (not a pattern to repeat) |
| Idempotency payload drift | HTTP 409 `ZOHO_IDEMPOTENCY_CONFLICT` | Fix mapper before retry; never change payload under same key |
| Warehouse list empty | `WAREHOUSE_LIST_EMPTY` warning | Non-blocking for this org; verify before future SKUs |

## What is now durable (in repo)

| Area | Location |
|------|----------|
| FIX Relax BOM + receipt proof constants | `lib/zoho/v1206-fix-relax-pilot-contract.ts` |
| Preview/commit shared Zoho body | `lib/zoho/production-output-service-payload.ts` |
| Consolidated preview + commit wiring | `lib/db/queries/zoho-production-output-consolidated.ts` |
| Bundle ID parsing from commit response | `lib/zoho/production-output-source-allocations.ts` (`parseZohoCommitResponseIds`) |
| Tests | `lib/zoho/fix-relax-final-contract.test.ts`, `production-output-service-payload.test.ts`, `production-output-commit-response.test.ts` |

## Final deployed versions (closeout verification)

| System | Version / SHA | Notes |
|--------|----------------|-------|
| Luma (LXC 122) | **≥ `70586e9`** (health reported `38586b9` at closeout) | v0.4.110+ durability included |
| Zoho Integration (CT 9503) | **1.21.2** | Production-output preview + commit |
| Gates | All commit paths **closed** | See runbook |

## Related docs

- [LUMA_ZOHO_BAG_RECEIVE_AND_PRODUCTION_OUTPUT_RUNBOOK.md](./LUMA_ZOHO_BAG_RECEIVE_AND_PRODUCTION_OUTPUT_RUNBOOK.md)
- [ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md](./ZOHO_SKU_ROLLOUT_READINESS_CHECKLIST.md)
- [ZOHO_RAW_BAG_RECEIPT_GRANULARITY.md](./ZOHO_RAW_BAG_RECEIPT_GRANULARITY.md)
- [ZOHO_SHARED_SERVICE_PRODUCTION_OUTPUT_CONTRACT.md](./ZOHO_SHARED_SERVICE_PRODUCTION_OUTPUT_CONTRACT.md)
