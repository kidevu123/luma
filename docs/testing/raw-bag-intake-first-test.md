# Raw Bag Intake — First Workflow Test

## 1. Preconditions

| Item | Expected state |
|------|---------------|
| Branch | `luma-live-testing` |
| SHA | `671df96` or newer |
| User | Logged in as Lead or above |
| Zoho env | Configured (`ZOHO_INTEGRATION_URL`, `ZOHO_SERVICE_BEARER_SECRET` prefix `463a378c`, `ZOHO_BRAND=haute_brands`, `ZOHO_DRY_RUN_WRITES_ENABLED=true`) |
| PO dropdown | Uses local DB cache — no live Zoho PO fetch required |
| Zoho readiness banner | Will show `NEEDS_REAUTH` — this is **cosmetic only** (books/crm/expense tokens expired; inventory token is valid). Intake is not blocked. |

## 2. Recommended test POs

All of the following are OPEN, have `zoho_po_id`, and have lines with `zoho_line_item_id` and a mapped tablet type:

| PO | Vendor | Lines | Note |
|----|--------|-------|------|
| PO-00222 | TOPC | 6 | Recommended first choice |
| PO-00206 | CamDex LLC | 6 | Good alternative |
| PO-00210 | Zenith DBA CSSD | 6 | Good alternative |
| PO-00093 | Konig | 3 | Large qty, clean mapping |
| PO-00103 | Konig | 9 | Multiple tablet types |

Avoid `QA_TEST_PO_VAL_0001` (no zoho_po_id) and `PO-00115` (2 lines missing zoho_line_item_id) for the first test.

## 3. Test steps

1. Navigate to `/inbound/raw-bags` (or Receiving → Receive pills in sidebar).
2. **Confirm PO dropdown** shows only OPEN/RECEIVING POs — not CLOSED/CANCELLED/DRAFT.
   - Badge should read "N open/receiving POs" (not "84 POs loaded").
3. **Select PO** — choose `PO-00222` or any PO from the recommended list above.
4. **Select PO line / tablet type** — the line picker appears after PO selection. Pick any line.
5. **Enter bag details:**
   - Supplier lot number (any string, e.g. `LOT-TEST-001`)
   - Bag count (e.g. `2`)
   - Declared count per bag (e.g. `1000`)
   - Weight per bag in grams (optional)
   - Receipt start number (e.g. `R-001`)
   - Notes (optional)
6. **Submit** the form.
7. **Confirm success toast** and page reset.

## 4. Expected results after submit

| Table | Expected |
|-------|----------|
| `receives` | 1 new row with `po_line_id` linking to the selected line |
| `small_boxes` | 1 row (one small box per receive event) |
| `inventory_bags` | N rows equal to bag count entered |
| `workflow_bags` | None yet — bags are not in production until scanned |
| Zoho | **No Zoho write occurs at intake time** |

To confirm in DB:
```sql
SELECT * FROM inventory_bags ORDER BY created_at DESC LIMIT 5;
SELECT * FROM receives ORDER BY created_at DESC LIMIT 3;
```

## 5. Production start link

After intake, navigate to `/production/start`, scan one of the new bag QR codes. Confirm the bag is recognized and can be assigned to a blister/sealing station. This completes the raw bag → production linkage.

## 6. Later: TABLET_RECEIVE dry-run readiness

After at least one production run completes (bag goes to FINALIZED):

1. Navigate to `/finished-lots` and find the resulting lot.
2. Click "Enqueue Zoho operations".
3. The resulting `zoho_assembly_ops` rows should have status `PENDING` (not `NEEDS_MAPPING`) for TABLET_RECEIVE ops on bags received against the recommended POs — because those POs and lines already have Zoho IDs.
4. Navigate to `/zoho-operations`, find the PENDING TABLET_RECEIVE op, click dry-run.

## 7. Known issues / failure notes

| Issue | Cause | Impact |
|-------|-------|--------|
| `Zoho: NEEDS_REAUTH` banner | `books`/`crm`/`expense` tokens expired for `haute_brands`; `inventory` token is valid | Cosmetic only — intake is not blocked |
| Assembly dry-run blocked | All 61 products missing `zoho_item_id`, `zoho_item_id_display`, `zoho_item_id_case` | Blocks UNIT/DISPLAY/CASE assembly ops; does not block raw bag intake or TABLET_RECEIVE |
| PO-00115 lines show NEEDS_MAPPING | 2 lines missing `zoho_line_item_id` | Use a different PO for first test |
| `lib/zoho/client.ts` direct Zoho call | Legacy `/settings/zoho` OAuth credential form | Does not affect intake; do not expand this pattern |
| Live PO sync unavailable | `/zoho/purchaseorders/list` returns 403 for current credential | Not needed for intake; local PO cache (17 OPEN POs with Zoho IDs) is sufficient |
