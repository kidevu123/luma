# Production Data Entry Hardening Audit

**Slice:** PRODUCTION-DATA-ENTRY-HARDENING-0 (audit/plan only)  
**Base SHA:** `307090d1c39b74f1801b03469535fe21cb00a60c`  
**Verified version:** `0.4.78`  
**Date:** 2026-06-02  
**Author:** Cursor audit (read-only; no app/schema changes)

---

## Executive summary

Luma has **two receiving paths** with different QR semantics, and the floor correctly **blocks** several downstream cases (IDLE QR, missing hand-pack tablet lineage, missing admin-start QR) rather than letting operators guess. The largest launch risk is **starting production without a durable `workflow_bags.inventory_bag_id` link** when intake-reserved QR cards are scanned but `inventory_bags.bag_qr_code` does not match `qr_cards.scan_token`—the floor still creates a `workflow_bag` and may proceed at blister with weak receipt identity.

**Recommended next slice:** PRODUCTION-DATA-ENTRY-HARDENING-1 — shared pure `evaluateFloorReadiness()` + read-only badges on receiving/intake + **hard block** on floor fresh-bag scan and admin start when readiness is not `READY_FOR_FLOOR`.

---

## 1. Current data flow (receive → floor)

```mermaid
flowchart LR
  PO[purchase_orders] --> R[receives]
  R --> SB[small_boxes]
  SB --> IB[inventory_bags]
  IB -->|bag_qr_code = scan_token| QC[qr_cards RAW_BAG]
  QC -->|floor scan CARD_ASSIGNED| WB[workflow_bags]
  WB --> WE[workflow_events]
  WE --> RBS[read_bag_state]
  RBS --> Floor[Floor PWA stations]
```

### Path A — PO receive wizard (`/inbound/new`)

| Step | Code | What happens |
|------|------|----------------|
| Create receive | `lib/db/queries/receives.ts` → `createReceiveWithBoxes` | Inserts `receives` → `small_boxes` → `inventory_bags` per box spec |
| Receipt # | `buildInternalReceiptNumber({ receiveName, boxNumber, bagNumber })` | Stored on `inventory_bags.internal_receipt_number` |
| Tablet type | Required on each box spec | `inventory_bags.tablet_type_id` (NOT NULL in schema) |
| QR on bag row | `buildRawBagQrPayload` | `inventory_bags.bag_qr_code` = `BAG-<inventory_bag_uuid>` (system namespace) |
| Physical floor badge | **Not created** | No `qr_cards` row; no link to reusable production card |

### Path B — Raw bag intake (`/receiving/raw-bags`)

| Step | Code | What happens |
|------|------|----------------|
| Atomic save | `lib/db/queries/raw-bag-intake.ts` → `createRawBagIntakeAtomic` | Upserts PO (local/Zoho/manual ref), batch, receive, small_box, N `inventory_bags` |
| Receipt # | Operator-typed per row | `inventory_bags.internal_receipt_number` (required; duplicate-checked) |
| QR link | `requireQr: true` in `preflightRawBagIntake` | `inventory_bags.bag_qr_code` = physical `qr_cards.scan_token`; cards marked `ASSIGNED`, `assigned_workflow_bag_id` null |
| Tablet / PO | Required tablet + PO mode | `receives.po_id`, optional `receives.po_line_id` |

### Path C — Add/edit bag on existing receive (`/inbound/[id]/add-bag`, bag edit)

| Step | Code | Notes |
|------|------|-------|
| Add bag | `lib/db/queries/receive-add-bag.ts` | Receipt + optional explicit QR; validates `validateQrCardForRawBag`; reserves card |
| Edit bag | `lib/db/queries/bag-edits.ts` | Can assign/change QR; blocks if bag already in `workflow_bags` |

### Floor production start

| Entry | Code | Sets `workflow_bags.inventory_bag_id`? |
|-------|------|----------------------------------------|
| Floor scan (intake-reserved card) | `app/(floor)/floor/[token]/actions.ts` → `scanCardAction` | **Only if** `lookupInventoryBagByQrScanToken(tx, card.scanToken)` finds a row |
| Admin start production | `app/(admin)/production/start/actions.ts` | **Always** (requires `inventoryBagId` input + `bag.bagQrCode` → `qr_cards`) |
| Legacy TT import | `lib/legacy/tt-importer.ts` | Often populated; may lack modern intake link |

After `CARD_ASSIGNED`, the projector updates `read_bag_state` (stage, COALESCE product/receipt from `workflow_bags`). Product may be set at first-op (`PRODUCT_MAPPED`) or deferred to sealing, where `saveSealingProductAction` persists it before segment/close-out (SEALING-PRODUCT-PERSIST-1, live on main).

---

## 2. Canonical fields

| Concern | Canonical store | Display / denormalized | Notes |
|---------|-------------------|------------------------|-------|
| **Receipt number** | `inventory_bags.internal_receipt_number` | `COALESCE(internal_receipt_number, workflow_bags.receipt_number)` in submissions/shift-review | `workflow_bags.receipt_number` is **legacy TT denorm**; new Luma paths do not write it |
| **Tablet type** | `inventory_bags.tablet_type_id` → `tablet_types` | Resolved via `resolveWorkflowBagReceivedTabletContext` | Hand-pack completion uses inventory path only; sealing filter may use legacy event payload |
| **PO / receive context** | `receives.po_id`, `receives.po_line_id`, `receives.receive_name` | Join: `inventory_bags` → `small_boxes` → `receives` → `purchase_orders` | Manual PO mode creates/ links `purchase_orders` with status OPEN |
| **Raw bag QR (sticky)** | `inventory_bags.bag_qr_code` | Distinct from `qr_cards.scan_token` when wizard used `BAG-*` | Data-honesty: raw bag QR ≠ workflow QR card unless explicitly linked |
| **Floor QR card** | `qr_cards` (`card_type = RAW_BAG`) | `qr_cards.scan_token` must equal `inventory_bags.bag_qr_code` for floor scan lookup | Intake-reserved: `status = ASSIGNED`, `assigned_workflow_bag_id IS NULL` |
| **Workflow bag link** | `workflow_bags.inventory_bag_id` | Also in `CARD_ASSIGNED` payload `inventory_bag_id` | Nullable in schema; nullable bags are launch risk |
| **Product timing** | `workflow_bags.product_id` | First-op blister/combined may map product at start; hand-pack defers; **sealing** uses explicit **Save product** → `saveSealingProductAction` persists `product_id` + `PRODUCT_MAPPED` (v0.4.74+, refresh-safe, locked) | Product is **not** required at receiving or floor start |

---

## 3. Audit answers (Phase 1)

### 3.1 How is a received inventory bag created?

1. **Receive wizard:** `createReceiveWithBoxes` — batch upsert, small_box, N bags with auto receipt + `BAG-*` QR.  
2. **Raw bag intake:** `createRawBagIntakeAtomic` — operator rows with receipt, QR, counts.  
3. **Add bag:** `addBagToReceive` on open receive.  
4. **Legacy import:** `tt-importer` (read-only ETL path; not for new ops).

### 3.2 How is a QR/bag card linked to an inventory bag?

- **Intake:** `inventory_bags.bag_qr_code = qr_cards.scan_token`; QR → `ASSIGNED` (no workflow bag yet).  
- **Bag edit / add-bag:** `validateQrCardForRawBag` + uniqueness on `bag_qr_code`.  
- **Wizard path:** No `qr_cards` link — only `BAG-<uuid>` on the inventory row.

### 3.3 How is `workflow_bags.inventory_bag_id` set?

- **Admin start:** always on insert.  
- **Floor fresh scan:** set only when `lookupInventoryBagByQrScanToken` succeeds; otherwise insert omits `inventoryBagId` (gap).  
- **Legacy import:** set from TT `bag_id` mapping when present.

### 3.4 Where is `tablet_type_id` stored canonically?

`inventory_bags.tablet_type_id` (NOT NULL). Propagated into `CARD_ASSIGNED` payload when known; hand-pack uses `resolveWorkflowBagReceivedTabletContext`.

### 3.5 Where is receipt number stored canonically?

`inventory_bags.internal_receipt_number`. Legacy `workflow_bags.receipt_number` + `box_number` / `bag_number` from TT import only.

### 3.6 Where is PO/receive context stored?

`receives` (+ `purchase_orders`, optional `po_lines`). Reachable only through `inventory_bags.small_box_id` join chain.

### 3.7 Where does product context appear, and when?

| Stage | Behavior |
|-------|----------|
| First-op blister / bottle handpack / combined | Operator or admin picks product → `PRODUCT_MAPPED` |
| Hand-pack blister | Product deferred; tablet from received bag |
| Sealing | `saveSealingProductAction` persists product before segment/close-out; server re-reads `workflow_bags.product_id` |
| Packaging | Expects product saved at sealing |

### 3.8 Fields required before blister / hand-pack / sealing

| Gate | Required for floor |
|------|-------------------|
| QR card `RAW_BAG` + not `IDLE` | Floor scan + lookup |
| Intake link `bag_qr_code = scan_token` | Strongly expected; not enforced on workflow insert |
| `inventory_bags.tablet_type_id` | Hand-pack complete; sealing product filter (warn-only if missing) |
| `internal_receipt_number` | Submissions label; shift-review display |
| `workflow_bags.inventory_bag_id` | Hand-pack complete; shift-review `MISSING_LINEAGE` |
| `workflow_bags.product_id` | First-op blister close-out when station requires it; sealing close-out after Save product |
| Batch `RELEASED` | Vendor barcode verify path only (`verifyVendorBarcodeAction`) |

### 3.9 Legacy / unlinked paths still in use

- TT-imported `workflow_bags` with `receipt_number` but null `inventory_bag_id`.  
- Receive wizard bags with `BAG-*` code but no `qr_cards` link (cannot use standard floor card scan until QR assigned).  
- `HANDPACK_BLISTER_COMPLETE` payload `tablet_type_id` fallback for sealing on old bags.  
- `qr_cards` UUID fallback in `lookupCardByTokenAction` for old printed labels.

### 3.10 Pages that allow incomplete lineage to move forward

| Surface | Gap |
|---------|-----|
| Floor `scanCardAction` (ASSIGNED, no WF) | Creates `workflow_bag` without `inventory_bag_id` if QR not linked to inventory row |
| Floor `receivedCards` query | Includes cards where `inventory_bags` join is null (`isNull(tabletTypeId)` allowed) |
| Receive wizard | Ships bags without physical QR card assignment |
| Sealing | If tablet unknown, shows all active card products (hint only) |
| Admin start | **Blocks** missing `bagQrCode` / invalid QR — good reference pattern |

### 3.11 Current “ready” / “not ready” UI

| Location | Signal |
|----------|--------|
| Floor scan | Errors: IDLE QR, missing hand-pack tablet context |
| `classifyFloorScanCard` | “Receive the bag first” for IDLE |
| Workflow submissions | `Legacy bag …` / `Missing received-bag context` via `buildBagLabel` |
| Shift review | `MISSING_LINEAGE` flag |
| Raw bag intake | PO verification badges (`VERIFIED_LOCAL`, `MANUAL_REFERENCE`, etc.) |
| Sealing | `getSealingProductFilterHint` when tablet unknown |
| **No** unified per-bag “Ready for floor” badge on receiving pages |

---

## 4. Proposed “Ready for Floor” validation model

Pure function (no DB writes), e.g. `lib/production/floor-readiness.ts`:

```ts
export type FloorReadinessStatus =
  | "READY_FOR_FLOOR"
  | "BLOCKED_MISSING_RECEIPT"
  | "BLOCKED_MISSING_TABLET"
  | "BLOCKED_MISSING_INVENTORY_BAG_LINK"   // workflow context: no inv bag on WF row
  | "BLOCKED_MISSING_QR_LINK"              // inv bag: no bag_qr_code or no matching qr_cards row
  | "BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT" // receive join broken or po_id null on non-legacy
  | "BLOCKED_QR_NOT_INTAKE_RESERVED"       // IDLE or active WF assignment
  | "BLOCKED_BATCH_NOT_RELEASED"           // when batch_id set and status != RELEASED
  | "WARNING_LEGACY_BAG"                   // TT-era workflow_bags.receipt_number only
  | "WARNING_PRODUCT_DEFERRED_TO_SEALING"  // product_id null but otherwise OK for blister start
  | "WARNING_ALREADY_ASSIGNED_OR_ACTIVE"   // QR tied to active workflow_bag
  | "WARNING_INCOMPLETE_OPTIONAL_CONTEXT"; // e.g. null declared count, manual PO ref
```

### Evaluation inputs (read-only query shape)

For an **inventory bag** (primary key for receiving UI):

- `inventory_bags.*` + joins to `small_boxes`, `receives`, `purchase_orders`, `tablet_types`  
- `qr_cards` where `scan_token = bag_qr_code`  
- Optional: existing `workflow_bags` for this `inventory_bag_id`

For a **QR card** (floor scan picker):

- `qr_cards.*` + join `inventory_bags` on `bag_qr_code = scan_token`

### Decision rules (conservative)

| Check | Block if |
|-------|----------|
| Receipt | `internal_receipt_number` null or empty |
| Tablet | `tablet_type_id` null (schema prevents on new rows; legacy/import only) |
| QR link | No `bag_qr_code`, or no `qr_cards` row with `RAW_BAG`, or card `IDLE` |
| PO/receive | No `small_box` / `receive` row, or `receive.po_id` null **and** not marked legacy import |
| Workflow link (when evaluating WF) | `inventory_bag_id` null |
| Active assignment | `qr_cards.assigned_workflow_bag_id` not null **and** bag not finalized |

### Station-specific questions (same evaluator, different strictness)

| Question | Rule |
|----------|------|
| Start at blister? | `READY_FOR_FLOOR` + product mapping exists for tablet (`product_allowed_tablets`) + QR intake-reserved |
| Start at hand-pack blister? | Same + tablet resolvable (no manual picker) |
| Reach sealing safely? | `inventory_bag_id` set + tablet resolvable; product saved at sealing via `saveSealingProductAction` |
| Workflow submissions identity? | `internal_receipt_number` present |
| Shift review genealogy? | `inventory_bag_id` on workflow bag |
| If blocked, admin action? | Map status → concrete route (see §6) |

### Admin action map (no operator guessing)

| Status | Admin/receiving action |
|--------|------------------------|
| `BLOCKED_MISSING_QR_LINK` | `/receiving/raw-bags` or inbound bag edit — assign `RAW_BAG` card |
| `BLOCKED_MISSING_RECEIPT` | Edit bag receipt or re-enter intake row |
| `BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT` | Link receive to PO; fix intake PO mode |
| `BLOCKED_MISSING_INVENTORY_BAG_LINK` | Data repair / recovery dry-run; do not start floor |
| `WARNING_LEGACY_BAG` | PM-gated repair procedure only |

---

## 5. Proposed first implementation slice (HARDENING-1)

**Scope:** Read-only badges + blocking guards (no schema migration).

### 5.1 New shared module

| File | Role |
|------|------|
| `lib/production/floor-readiness.ts` | Pure `evaluateInventoryBagReadiness`, `evaluateQrCardReadiness` |
| `lib/production/floor-readiness.test.ts` | Table-driven cases from audit gaps |

### 5.2 UI / route touchpoints

| Location | Change |
|----------|--------|
| `/receiving/raw-bags` + intake result | Badge per saved bag row |
| `/inbound/[id]` bag table | Badge column; link to edit |
| `app/(floor)/floor/[token]/actions.ts` → `scanCardAction` | **Throw** if QR readiness ≠ ready (mirror admin start) |
| `lookupCardByTokenAction` | Return readiness status for scan chip |
| `app/(admin)/production/start/actions.ts` | Reuse evaluator (already strict; align messages) |
| Optional | `/workflow-submissions` filter “Missing floor readiness” |

### 5.3 Read-only vs block

| Surface | HARDENING-1 |
|---------|-------------|
| Receiving pages | Read-only badge |
| Floor fresh-bag scan | **Block** |
| Admin start | **Block** (already mostly; unify copy) |
| Downstream pickup scan | No change (existing stage gates) |

### 5.4 Explicit non-goals (HARDENING-1)

- No operator tablet/product override  
- No silent backfill of `inventory_bag_id`  
- No migration / `floor_readiness` column  
- No recovery apply UI  
- No changes to sealing product persistence (already live in v0.4.74+)

---

## 6. Safety rules (locked)

1. **Never guess** missing tablet, product, or receipt on the floor.  
2. **No normal operator override** for lineage — supervisor uses admin/receiving routes.  
3. **No silent backfill** of links in projector or floor actions.  
4. **Product selection before sealing** must not be inferred from tablet alone; persist + lock in SEALING-PRODUCT-PERSIST-1.  
5. Use data-honesty labels: `Missing`, `Manual reference`, `Legacy`, `Suggested` — never “0” or empty-as-OK.

---

## 7. Test plan (HARDENING-1)

| Layer | Tests |
|-------|-------|
| Unit | `floor-readiness.test.ts` — all statuses, legacy vs intake paths |
| Integration | Extend `scan-card-form.test.ts` / `actions.test.ts` — block unlinked ASSIGNED card |
| Regression | Admin start still passes with fully linked QA bag |
| Smoke | Auth smoke unchanged; optional script `scripts/audit-floor-readiness-counts.ts` (read-only) |
| Manual | Pre-shift checklist: badge green on intake bags before floor scan |

---

## 8. Migration assessment

| Need | Assessment |
|------|------------|
| Current schema | **Sufficient** for v1 readiness via joins |
| New columns | **Not required** for badges + blocks |
| Optional future | Materialized `read_inventory_bag_readiness` or enum on `inventory_bags` if reporting volume demands it |
| `workflow_bags.receipt_number` | Consider backfill from `internal_receipt_number` in a **PM-gated** repair script only — not in HARDENING-1 |

---

## 9. Live read-only staging counts

**Status:** Not run from this audit environment.

- Staging health at audit time: `ok`, SHA `307090d1c39b74f1801b03469535fe21cb00a60c` (matches base).  
- No `DATABASE_URL` locally; SSH to LXC `192.168.1.134` not available (permission denied).

**Run on LXC 122 (read-only)** — paste into `docker compose exec -T db psql -U luma -d luma`:

```sql
-- 1. Inventory bags missing tablet (should be 0 on clean schema)
SELECT COUNT(*) AS missing_tablet FROM inventory_bags WHERE tablet_type_id IS NULL;

-- 2. Workflow bags without inventory link
SELECT COUNT(*) AS wf_null_inventory FROM workflow_bags WHERE inventory_bag_id IS NULL;

-- 3. QR cards RAW_BAG by link state
SELECT status, COUNT(*) FROM qr_cards WHERE card_type = 'RAW_BAG' GROUP BY status;

-- 4. Intake-reserved QR with no inventory join
SELECT COUNT(*) AS assigned_qr_no_inv
FROM qr_cards qc
LEFT JOIN inventory_bags ib ON ib.bag_qr_code = qc.scan_token
WHERE qc.card_type = 'RAW_BAG' AND qc.status = 'ASSIGNED' AND ib.id IS NULL;

-- 5. Inventory bags missing internal receipt
SELECT COUNT(*) AS missing_receipt FROM inventory_bags WHERE internal_receipt_number IS NULL OR trim(internal_receipt_number) = '';

-- 6. Active workflow bags (30d) that would fail hand-pack lineage
SELECT COUNT(*) AS recent_wf_missing_lineage
FROM workflow_bags wb
JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
WHERE wb.inventory_bag_id IS NULL
  AND wb.started_at > now() - interval '30 days'
  AND rbs.is_finalized = false;

-- 7. Recent workflow bags likely showing Legacy label (no inv join, no receipt coalesce)
SELECT COUNT(*) AS recent_legacy_label_risk
FROM workflow_bags wb
LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
WHERE wb.started_at > now() - interval '30 days'
  AND ib.id IS NULL
  AND (wb.receipt_number IS NULL OR trim(wb.receipt_number) = '');
```

Record counts in PM ticket when run; compare QA_TEST_* vs production-like rows using `po_number NOT LIKE 'QA_TEST_%'`.

---

## 10. Open PM decisions

1. **Single receiving path for launch?** Mandate raw-bag intake (physical QR) vs allow wizard-only + later QR assignment.  
2. **Is `BAG-*` scan ever valid at floor?** Today floor expects `qr_cards.scan_token`; confirm whether sticker printers encode card tokens only.  
3. **PO required for floor?** Block when `receives.po_id` null (manual reference only) vs warn.  
4. **Batch RELEASED gate on blister start?** Currently only on vendor barcode verify — extend to all starts?  
5. **Priority vs SEALING-PRODUCT-PERSIST-1** — LAUNCH_CONTROL ranks sealing persist first; confirm ordering with data-entry hardening.  
6. **Backfill `workflow_bags.receipt_number`** from inventory — one-time script Y/N?

---

## 11. Recommendation

| Priority | Item |
|----------|------|
| **Build next** | PRODUCTION-DATA-ENTRY-HARDENING-1 — evaluator + receiving badges + floor/admin block on not-ready |
| **Run before pilot** | Staging SQL §9 on production-like rows |
| **Wait** | Recovery preview UI, apply path, large receiving rebuild |
| **Already shipped** | SEALING-PRODUCT-PERSIST-1 (v0.4.74+) — product deferred to sealing, persisted on Save product |

**Pilot gate:** No blister production on bags unless intake shows **Ready for floor** (green badge) and floor scan returns linked receipt + tablet context.

---

## Key code references

| Area | Path |
|------|------|
| Receive wizard bags | `lib/db/queries/receives.ts` |
| Raw bag intake | `lib/db/queries/raw-bag-intake.ts`, `lib/production/raw-bag-intake.ts` |
| Floor scan | `app/(floor)/floor/[token]/actions.ts` |
| Tablet context | `lib/production/workflow-bag-tablet-context.ts` |
| Admin start | `app/(admin)/production/start/actions.ts` |
| QR validation | `lib/production/start-production.ts`, `lib/db/queries/bag-edits.ts` |
| Submissions labels | `app/(admin)/workflow-submissions/workflow-table.tsx` |
| Shift review flags | `lib/production/shift-review.ts` |
| Schema | `lib/db/schema.ts` (`inventory_bags`, `workflow_bags`, `qr_cards`, `receives`) |
