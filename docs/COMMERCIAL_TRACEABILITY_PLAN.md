# Commercial traceability — implementation plan (COMMERCIAL-TRACE-1)

**Status.** Audit + plan only. No code, no schema changes, no live Zoho or Nexus calls.

**Authoring branch.** `production-intelligence-command-center`
**Authored.** 2026-05-15
**Supersedes.**
- `docs/NEXUS_QIP_CUSTOMER_COMPLAINT_PLAN.md` — the inbound-complaint-table direction. Luma does NOT store complaints. Complaint workflow (if it ever exists) lives entirely in Nexus.

**Companion docs.**
- `docs/FINISHED_LOT_RECALL_PASSPORT_PLAN.md` — recall passport (LOT-1A spec).
- `docs/ZOHO_LIVE_SYNC_PLAN.md` — Zoho sync §2 ownership boundaries.

---

## 1. Vision correction

The actor boundary changes from "Luma stores customer complaints from Nexus" to:

| System | Source of truth |
|---|---|
| **Luma** | Finished batches, trace codes, raw-bag genealogy, packaging lots, QC events, shipments, **invoice ↔ finished-lot allocations** |
| **Zoho** | Customers, items, sales orders, invoices, invoice lines, vendors, posted financial events |
| **Nexus** | Customer-facing lookup UI; CSR drill-through to Luma; never authoritative for batch identity or financial truth |

The user-facing flow becomes:

1. Customer opens Nexus.
2. Customer enters an **invoice number** OR picks a **finished-lot trace code** from a customer-scoped dropdown.
3. Nexus calls Luma's read-only API.
4. Luma resolves: invoice → lines → allocated finished lots → recall passport.
5. Nexus shows customer-safe view to the customer; full recall passport to the CSR.

There is no "complaint" entity in Luma. If a CSR opens a complaint ticket in Nexus, that ticket lives in Nexus only; Luma sees the lookup that preceded it but does not store complaint metadata.

### 1.1 What this plan keeps

- Luma's existing outbound `NexusFinishedLotPayload` (LOT-1F/G) — still useful as the seed that populates Nexus's per-customer lot list.
- `customers.nexus_customer_id` + `shipment_finished_lots.nexus_sent_at` — used as the auth + scoping key for the new Nexus lookup APIs.
- The recall-passport surface (`/recall`, `lib/production/recall-passport-loaders.ts`) — reused as the CSR drill-through target.

### 1.2 What this plan drops (vs the prior NEXUS-0 plan)

- `nexus_complaints` table.
- `complaint_attachments` table.
- `complaint_status_history` table.
- `app/api/integrations/nexus/complaints/route.ts` — inbound webhook.
- `/admin/complaints` admin page.
- `complaint_qc_events` join.
- Any auto-trigger of QC investigations from customer signals.

The old plan is marked **SUPERSEDED** at the top of `docs/NEXUS_QIP_CUSTOMER_COMPLAINT_PLAN.md`, but stays committed for the boundary discussion + the open-question record.

---

## 2. Current state audit

### 2.1 Luma side — already in place

| Surface | Path | Role |
|---|---|---|
| Finished lots | `finished_lots` table | Has `trace_code` (unique partial index), `packed_at`, `expires_at`, `product_id`, `units_produced`, `displays_produced`, `cases_produced`. The customer-facing identity. |
| Shipment ↔ finished-lot | `shipment_finished_lots` table | `(shipment_id, finished_lot_id) UNIQUE`. Already carries `customer_id`, `quantity`, `unit`, `shipped_at`, `nexus_sent_at` / `nexus_last_sent_response` / `nexus_last_send_error`. **This table is the join hinge for the entire COMMERCIAL-TRACE work.** |
| Customers | `customers` table | `customer_code` (Luma-canonical), `zoho_customer_id`, `nexus_customer_id`, `supplier_lot_visible`, `active`. Partial-indexed on both external IDs. |
| Recall passport | `lib/production/recall-passport-loaders.ts` | Existing 6-axis search: supplier_lot / internal_receipt_number / raw_bag_qr / finished_lot_trace_code / product+date / customer+date. Returns customer-safe vs internal views per the existing supplier-lot-visibility gate. |
| Outbound Nexus seed | `lib/integrations/nexus/finished-lots.ts` | Used today to pre-populate Nexus's per-customer lot dropdown when admin clicks "Send to Nexus" on `/finished-lots/[id]/labels`. **Stays.** |
| Zoho gateway | `lib/integrations/zoho/gateway.ts` (ZOHO-GW-2) | Reachable; `haute_brands` tokens currently expired. |
| Zoho item/customer dry-run | `lib/integrations/zoho/{items,customers,sync-dry-run}.ts` (ZOHO-2A) | Ready for live use once tokens refresh. |
| Sync audit tables | `zoho_sync_runs`, `zoho_sync_state` (migration 0033) | Available — invoice runs will write new `sync_type` enum values. |

### 2.2 Luma side — missing

- **No invoice tables.** `zoho_invoices` and `zoho_invoice_lines` do not exist.
- **No invoice ↔ finished-lot allocation table.** `finished_lot_invoice_allocations` does not exist.
- **No Zoho invoice client.** `lib/integrations/zoho/invoices.ts` does not exist (only items + customers + sync-dry-run).
- **No Nexus read-only endpoints.** `app/api/integrations/nexus/` directory does not exist.
- **`zoho_sync_kind` enum lacks `INVOICES` value.** Currently has `CONNECTIVITY_CHECK / ITEMS / CUSTOMERS / SALES_ORDERS / PURCHASE_ORDERS / FINISHED_LOT_PUSH`. The plan can either reuse `SALES_ORDERS` for invoices (semantically loose) or add `INVOICES` in COMMERCIAL-TRACE-2's migration — recommend adding the value since invoices and sales orders are different objects in Zoho.

### 2.3 Zoho side (verified during ZOHO-2A audit)

- Gateway route for invoices: `service=invoices, action=list, method=GET, endpoint_template=/inventory/v1/invoices, product=inventory`. Books has a parallel `invoices_books` service. Luma's call URL is `GET /zoho/invoices/list?per_page=200&page=1` with the standard `X-Internal-Token` + `X-Brand` headers.
- Per-invoice detail at `GET /zoho/invoices/get/{invoice_id}` — returns line items as nested `line_items` array.
- Pagination via `per_page` + `page` (Zoho native).
- Per-product token status: `haute_brands` × `inventory` currently expired (see ZOHO-GW-2 closeout).

### 2.4 Nexus side (assumed from prior plan + LOT-1F)

- Nexus already receives `NexusFinishedLotPayload` for each "Send to Nexus" click. It can already populate a per-customer dropdown today.
- Nexus needs **no DB changes** — it just calls Luma's new read-only endpoints when the customer enters an invoice number or picks a lot from the dropdown.
- Nexus must scope its calls to its own customer's `nexus_customer_id` (Luma will enforce in `Bearer` / per-call validation regardless).

---

## 3. Core flow + actors

```
                Production (existing)
                       │
                       ▼
              ┌──────────────────────┐
              │ Luma finished_lots   │  trace_code = FL-…
              │  + recall passport   │
              └──────────┬───────────┘
                         │ shipment_finished_lots (existing)
                         ▼
              ┌──────────────────────┐
              │ Luma shipments       │  one customer per shipment
              └──────────┬───────────┘
                         │
              ┌──────────┴────────────────────┐
              │                               │
              ▼                               ▼
   ┌──────────────────────┐         ┌──────────────────────┐
   │ Zoho invoice         │  ZOHO   │ Outbound Nexus seed  │
   │  + invoice_line      │ ─────►  │ (LOT-1F payload —    │
   │  (NEW: read-only     │ INVOICE │  per-customer lots)  │
   │  sync into Luma)     │  SYNC   └──────────────────────┘
   └──────────┬───────────┘
              │
              │  finished_lot_invoice_allocations (NEW)
              │  ── HIGH (explicit pick at pack)
              │  ── MEDIUM (exact qty/product/date match)
              │  ── LOW (inferred)
              │  ── MISSING (no link)
              ▼
   ┌──────────────────────┐
   │ Nexus customer       │  invoice number → finished lots
   │  lookup UI           │  trace code     → customer-safe summary
   │  + CSR drill-through │  → recall passport (internal scope)
   └──────────────────────┘
```

Actors:

| Role | Capability |
|---|---|
| Customer (in Nexus) | Enter invoice number; pick trace code from dropdown; see customer-safe lot summary; **no supplier lot, no machine, no operator** |
| CSR (in Nexus) | Everything the customer sees + drill-through to Luma's internal recall passport (full chain) |
| Luma operator (admin) | Confirm allocation suggestions; manually pick a lot when packing a shipment; see unresolved invoice-line list |
| Pack-out operator (future) | Scan a finished lot during pack-out → creates an explicit HIGH-confidence allocation row |

---

## 4. Data model + confidence

### 4.1 Confidence ladder (reuses Luma's existing HIGH/MEDIUM/LOW/MISSING vocabulary from `lib/production/confidence.ts`)

| Confidence | Origin | Used as Nexus-visible? |
|---|---|---|
| **HIGH** | Explicit pack-out scan or admin-confirmed allocation. Operator selected the specific finished lot for this invoice line. | **Yes** — only HIGH allocations are exposed via the customer-facing Nexus endpoints. |
| **MEDIUM** | Auto-match: exact `(zoho_item_id → product_id)` + exact quantity + invoice date within ±7 days of `shipment.shipped_at` + same `customer_id`. | Visible to **CSR only**, marked "auto-matched, unconfirmed". |
| **LOW** | Fuzzy match: same product + same customer + invoice date within ±30 days, but multiple candidate lots and Luma cannot pick one without operator help. | CSR-only, marked "candidate set, needs operator confirmation". |
| **MISSING** | No reliable link. Invoice line has no finished-lot allocation. | Surfaces on the admin unresolved-invoices report. Never exposed via Nexus endpoints. |

**Critical rule:** an unconfirmed MEDIUM/LOW allocation never becomes HIGH automatically. Operator action — clicking "Confirm" on the review UI — is the only path to HIGH. A scan during pack-out creates HIGH directly without a review step.

### 4.2 New tables (full DDL deferred to COMMERCIAL-TRACE-2)

```sql
-- Mirrors Zoho's invoice header. One row per Zoho invoice; never
-- written outside the sync path. raw_payload preserves the verbatim
-- Zoho row for forensics + future-field discovery.
CREATE TABLE zoho_invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zoho_invoice_id     text NOT NULL,
  invoice_number      text NOT NULL,
  zoho_customer_id    text,
  customer_id         uuid REFERENCES customers(id) ON DELETE SET NULL,
  invoice_date        date,
  status              text,                            -- Zoho-side: draft|sent|paid|overdue|void
  total_cents         bigint,
  currency_code       text,
  raw_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at      timestamptz,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX zoho_invoices_zoho_id_unique ON zoho_invoices (zoho_invoice_id);
CREATE INDEX zoho_invoices_number_idx ON zoho_invoices (invoice_number);
CREATE INDEX zoho_invoices_customer_idx ON zoho_invoices (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX zoho_invoices_date_idx ON zoho_invoices (invoice_date DESC);
CREATE INDEX zoho_invoices_status_idx ON zoho_invoices (status);

-- Mirrors Zoho's per-line records.
CREATE TABLE zoho_invoice_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zoho_invoice_line_id  text NOT NULL,
  zoho_invoice_uuid     uuid NOT NULL REFERENCES zoho_invoices(id) ON DELETE CASCADE,
  line_order            integer,                       -- preserved from Zoho's `lineorder` if available
  zoho_item_id          text,
  sku                   text,
  item_name             text,
  quantity              numeric(20, 6) NOT NULL,
  unit                  text,
  rate_cents            bigint,
  amount_cents          bigint,
  raw_payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX zoho_invoice_lines_zoho_line_id_unique ON zoho_invoice_lines (zoho_invoice_line_id);
CREATE INDEX zoho_invoice_lines_invoice_idx ON zoho_invoice_lines (zoho_invoice_uuid);
CREATE INDEX zoho_invoice_lines_item_idx ON zoho_invoice_lines (zoho_item_id) WHERE zoho_item_id IS NOT NULL;
CREATE INDEX zoho_invoice_lines_sku_idx ON zoho_invoice_lines (sku) WHERE sku IS NOT NULL;

-- The hinge: which Luma finished lot fulfilled which Zoho invoice line.
-- Multiple rows per invoice line (split allocation across lots), at most
-- one row per (invoice_line, finished_lot) pair.
CREATE TABLE finished_lot_invoice_allocations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zoho_invoice_line_uuid      uuid NOT NULL REFERENCES zoho_invoice_lines(id) ON DELETE CASCADE,
  finished_lot_id             uuid NOT NULL REFERENCES finished_lots(id) ON DELETE RESTRICT,
  shipment_finished_lot_id    uuid REFERENCES shipment_finished_lots(id) ON DELETE SET NULL,
  quantity_allocated          numeric(20, 6) NOT NULL,
  unit                        text NOT NULL,
  confidence                  text NOT NULL,           -- HIGH | MEDIUM | LOW (MISSING never persists)
  source                      text NOT NULL,           -- PACK_OUT_SCAN | OPERATOR_CONFIRM | AUTO_MATCH_EXACT | AUTO_MATCH_FUZZY | LEGACY_IMPORT
  confirmed                   boolean NOT NULL DEFAULT false,
  confirmed_by_user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at                timestamptz,
  notes                       text,
  created_by_user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX finished_lot_invoice_allocations_pair_unique
  ON finished_lot_invoice_allocations (zoho_invoice_line_uuid, finished_lot_id);
CREATE INDEX finished_lot_invoice_allocations_line_idx ON finished_lot_invoice_allocations (zoho_invoice_line_uuid);
CREATE INDEX finished_lot_invoice_allocations_lot_idx ON finished_lot_invoice_allocations (finished_lot_id);
CREATE INDEX finished_lot_invoice_allocations_confidence_idx
  ON finished_lot_invoice_allocations (confidence, confirmed);
CREATE INDEX finished_lot_invoice_allocations_shipment_finished_lot_idx
  ON finished_lot_invoice_allocations (shipment_finished_lot_id)
  WHERE shipment_finished_lot_id IS NOT NULL;
```

### 4.3 Why no `unit` mismatch enforcement at the DB level?

Zoho-side units are free-text (`bottles`, `each`, `case`, `display`, etc.). Luma's finished lots track `units_produced` / `displays_produced` / `cases_produced` separately. The allocation engine handles unit reconciliation at write-time (using existing `lib/production/product-structure.ts` conversion helpers); the table stores the post-resolution unit. Trying to enforce at the DB level would force a schema dance every time Zoho introduces a new unit name.

### 4.4 Invariants enforced by the engine, not the schema

1. `quantity_allocated > 0`.
2. `confidence` ∈ `{HIGH, MEDIUM, LOW}` (CHECK constraint at the table level).
3. `source` ∈ `{PACK_OUT_SCAN, OPERATOR_CONFIRM, AUTO_MATCH_EXACT, AUTO_MATCH_FUZZY, LEGACY_IMPORT}` (CHECK constraint).
4. `confirmed=true` requires `confirmed_by_user_id` + `confirmed_at` both non-null.
5. Sum of `quantity_allocated` across all rows for one `zoho_invoice_line_uuid` must not exceed `zoho_invoice_lines.quantity` (enforced in the engine; surfaces as a warning, not a hard reject, because Zoho-side quantity changes happen).

---

## 5. Zoho integration plan

### 5.1 New reads (COMMERCIAL-TRACE-3)

| Object | Gateway path | Cadence | Persistence |
|---|---|---|---|
| Invoices (list) | `GET /zoho/invoices/list?per_page=200&page=N` | Hourly, plus on-demand "Sync now" | `zoho_invoices` upsert; `zoho_invoice_lines` is filled from per-invoice GETs to capture line items |
| Invoice detail (with lines) | `GET /zoho/invoices/get/{zoho_invoice_id}` | Triggered when invoice header changes vs `last_synced_at` | `zoho_invoice_lines` upsert |
| Sales orders (optional, future) | `GET /zoho/salesorders/list` | Manual only | Read-only view; not persisted in COMMERCIAL-TRACE-1..7 |

The list endpoint returns a thin header (no line items in most Zoho deployments). To populate `zoho_invoice_lines` the sync calls the detail endpoint per invoice with a changed `last_modified_time`. The detail call is what gives us per-line `zoho_item_id` for the mapping engine.

### 5.2 Dry-run preview (COMMERCIAL-TRACE-3)

Mirrors the ZOHO-2A pattern: `runZohoInvoiceDryRun` returns a typed diff (CREATE_CANDIDATE / UPDATE_CANDIDATE / NO_CHANGE / NEEDS_REVIEW / CONFLICT) over `zoho_invoices` + `zoho_invoice_lines`. Reasons include:

- `missing_zoho_item_id` — invoice line has no item id (manual / one-off invoice). Goes to NEEDS_REVIEW.
- `unmapped_item` — `zoho_item_id` exists but `external_item_mappings` has no `luma_product_id`. Goes to NEEDS_REVIEW.
- `unknown_customer` — `zoho_customer_id` doesn't match any `customers.zoho_customer_id`. Goes to NEEDS_REVIEW.
- `duplicate_zoho_invoice_id` — same id appears twice. Goes to CONFLICT.
- `duplicate_invoice_number` — same `invoice_number` for different `zoho_invoice_id` (Zoho-side typo / re-issue). Goes to CONFLICT with a warning.
- `inactive_in_zoho` — invoice status is `void`. Goes to NEEDS_REVIEW (we still want to track voided invoices for audit, but they don't seed allocations).

### 5.3 Why not write back?

Per the ownership map in §1: Zoho owns invoices. Luma never edits invoice numbers, line quantities, or invoice status. The allocation table stores Luma-side knowledge about *which finished lots fulfilled the line* — it doesn't modify Zoho's view of the line.

### 5.4 Dependencies

- **ZOHO-GW-2** complete (gateway client speaks the real contract). ✅
- **ZOHO-2A** complete (item + customer dry-run + diff engine for the matching-step inputs). ✅
- **ZOHO-2B** **NOT** required as a hard prerequisite — the COMMERCIAL-TRACE-3 invoice dry-run can land while haute_brands tokens are still expired (tests use mocks, the live dry-run will fail honestly with NEEDS_REAUTH same as ZOHO-2A does today). But **ZOHO-2B + token reauth IS required before COMMERCIAL-TRACE-7 staging verification** can produce non-zero counts against live data.

---

## 6. Allocation engine

### 6.1 Suggestion algorithm (COMMERCIAL-TRACE-4)

Given one `zoho_invoice_lines` row, produce zero or more candidate `finished_lot_invoice_allocations` suggestions. Run in order:

1. **HIGH-confidence path — pack-out scan present.** If a `shipment_finished_lots` row exists with `shipment.customer_id = invoice.customer_id` and the row carries a verified `shipped_at` close to the invoice date and an operator explicitly scanned a lot at pack-out (a new `lot_picked_at_pack` boolean on `shipment_finished_lots` — COMMERCIAL-TRACE-2 schema add) — produce a HIGH suggestion with `source=PACK_OUT_SCAN`. No operator review needed.

2. **MEDIUM-confidence path — exact match.** Filter `finished_lots` by:
   - `products.id` matches the `external_item_mappings.luma_product_id` for the line's `zoho_item_id`.
   - There exists a `shipment_finished_lots` row with `shipped_at` within ±7 days of `invoice_date` and `customer_id = invoice.customer_id`.
   - Sum of unallocated quantity on that shipment_finished_lot ≥ the line quantity (after unit conversion via `product-structure.ts`).
   - If exactly one finished lot survives → MEDIUM suggestion with `source=AUTO_MATCH_EXACT`.

3. **LOW-confidence path — multiple candidates.** Same filter as #2 but **multiple** finished lots survive. Surface them all as LOW with `source=AUTO_MATCH_FUZZY`; the review UI presents the choice to the operator.

4. **MISSING path — nothing matches.** Surface on the unresolved-invoices report. No row written.

The engine is pure: takes `zoho_invoice_lines[]` + `finished_lots[]` + `shipment_finished_lots[]` + `external_item_mappings[]` + `customers[]` and returns suggestions. DB writes only happen when the operator clicks "Confirm" or the pack-out scan path fires.

### 6.2 Idempotency

- Re-running the suggestion engine against the same input produces the same suggestions.
- An existing HIGH/CONFIRMED allocation prevents the engine from re-suggesting that line. Operator can manually create additional allocations for split shipments.
- Re-confirming an already-confirmed row is a no-op.

### 6.3 What auto-promotion does NOT do

- Never silently flips MEDIUM/LOW to HIGH.
- Never bypasses the operator review step.
- Never marks an allocation `confirmed=true` without `confirmed_by_user_id` recorded.

---

## 7. Nexus contract — three read-only endpoints

All three live under `app/api/integrations/nexus/`. All require an `Authorization: Bearer <NEXUS_LOOKUP_TOKEN>` header (separate secret from `NEXUS_FINISHED_LOT_SECRET` and `NEXUS_INBOUND_SECRET` — different direction, different secret). Customer scope is enforced via `X-Nexus-Customer-Id` header which Nexus signs into its outbound call.

### 7.1 `GET /api/integrations/nexus/invoice-batches?invoice_number=<...>`

**Purpose.** Customer enters an invoice number, Nexus calls this to display the finished lots Luma associates with that invoice.

**Scope check.** Resolve `customers` by `nexus_customer_id` (from header). The invoice's `customer_id` must equal that customer. Else 404 (NOT "forbidden" — we don't want to leak whether the invoice exists for someone else).

**Response.** Customer-safe view:
```typescript
{
  invoice_number: string;
  invoice_date: string;                  // ISO
  status: "paid" | "sent" | "overdue" | ...;
  customer: { customer_code: string; customer_name: string };
  lines: Array<{
    item_name: string;                   // Luma product name preferred, falls back to Zoho item_name
    sku: string | null;
    quantity_ordered: number;
    unit: string;
    finished_lots: Array<{
      trace_code: string;
      packed_at: string;                 // ISO
      expires_at: string | null;
      quantity_allocated: number;
      unit: string;
      // NO supplier_lot. NO internal_receipt_number. NO machine/operator.
    }>;
    unresolved_quantity: number;         // line.quantity - sum(allocations.quantity_allocated)
  }>;
  warnings: string[];                    // e.g. "1 line on this invoice has no confirmed allocation"
}
```

**Only HIGH-confidence + confirmed allocations are included.** MEDIUM/LOW suggestions are invisible to the customer surface.

### 7.2 `GET /api/integrations/nexus/customer-batches?nexus_customer_id=<...>`

**Purpose.** Customer dropdown population — "show me every finished lot you have on file for me".

**Scope check.** `nexus_customer_id` from the query must equal the header. (Belt + suspenders.)

**Response.**
```typescript
{
  customer: { customer_code: string; customer_name: string };
  lots: Array<{
    shipment_finished_lot_id: string;    // the stable handle Nexus stores
    trace_code: string;
    product_name: string;
    product_sku: string;
    packed_at: string;
    expires_at: string | null;
    shipped_at: string | null;
    quantity_shipped: number;
    unit: string;
    invoice_numbers: string[];           // ALL invoices this lot appeared on (1 or more)
  }>;
}
```

Surfaces lots that are either pushed via the existing LOT-1F flow (`shipment_finished_lots.nexus_sent_at IS NOT NULL`) OR linked via `finished_lot_invoice_allocations` to a confirmed HIGH-confidence invoice line, whichever set is larger. Deduplicated on `shipment_finished_lot_id`.

### 7.3 `GET /api/integrations/nexus/batch-passport?trace_code=<...>&scope=customer|csr`

**Purpose.** After customer picks a lot, Nexus fetches the passport. `scope=customer` is the customer-safe view; `scope=csr` is the internal recall passport.

**Scope check.**
- `scope=customer`: lot must belong to the requesting `nexus_customer_id` (via `shipment_finished_lots` or via confirmed allocation). Else 404.
- `scope=csr`: requires a CSR-level Bearer token (a stronger secret — `NEXUS_CSR_LOOKUP_TOKEN`). When valid, returns the full internal passport regardless of `nexus_customer_id`.

**Response (`scope=customer`).** Same fields as the LOT-1F `recall_passport` block: confidence, warnings, missing_links, qc_summary, supplier_lot_visible (always false here), supplier_lot_number (always omitted), plus a small "what this lot was used for" block: invoice_numbers, packed_at, product_name. **No raw bags, no machine, no operator, no internal_receipt_number.**

**Response (`scope=csr`).** The full passport from `getRecallPassport(input)` — raw bags + workflow bags + outputs + packaging lots + QC events + shipments + invoice allocations. Includes `supplier_lot_number` when present. CSR-only.

### 7.4 Rate limiting + audit

- 20 req/s per IP, 200-burst (defensive; customer dropdowns may fire several lookups in quick succession).
- Every request writes a `audit_log` row `nexus.lookup.invoice_batches` / `nexus.lookup.customer_batches` / `nexus.lookup.batch_passport` with the resolved `customer_id`, the trace code or invoice number queried, and the scope. The audit trail is what tells us, after the fact, whether a CSR drilled through to a customer's lot.

### 7.5 What these endpoints don't do

- Never accept POSTs.
- Never accept complaint metadata.
- Never write to anything but `audit_log`.
- Never return `supplier_lot_number` to the customer scope.
- Never return data for a different customer's lots regardless of how the call was framed.

---

## 8. Security

### 8.1 Three secrets, three roles

| Secret env | Direction | Used by |
|---|---|---|
| `NEXUS_FINISHED_LOT_SECRET` (existing) | Luma → Nexus | `sendFinishedLotToNexusAction` — push the seed list |
| `NEXUS_LOOKUP_TOKEN` (NEW) | Nexus → Luma (customer scope) | `Bearer` on the three new GET endpoints; only unlocks customer-scope responses |
| `NEXUS_CSR_LOOKUP_TOKEN` (NEW) | Nexus → Luma (CSR scope) | `Bearer` on `scope=csr` calls; required to see internal recall passport |

The two inbound tokens are different so the customer-portal compromise blast radius stays small — even with `NEXUS_LOOKUP_TOKEN` leaked, an attacker can only ask Luma for one customer's lots at a time (the one identified in `X-Nexus-Customer-Id`).

### 8.2 Customer-scope validation cascade

For every customer-scope call:

1. Validate `Authorization: Bearer ...` matches `NEXUS_LOOKUP_TOKEN` (constant-time compare).
2. Extract `nexus_customer_id` from `X-Nexus-Customer-Id` header.
3. Look up `customers.id` where `nexus_customer_id` matches; 404 if missing.
4. For every result row returned, verify `shipment_finished_lots.customer_id` (or the resolved customer via allocations) equals the looked-up `customers.id`. Filter mismatches out.
5. Never echo the `nexus_customer_id` back in the response body — only `customer_code` + `customer_name` (which Nexus already knows).

### 8.3 No PII leakage

- Customer's address / phone / email never returned. (Nexus already has these from its own customer master.)
- Invoice rates / amounts are not returned by default — customer can see them in Zoho. Set `NEXUS_LOOKUP_INCLUDE_AMOUNTS=false` in env; CSR scope respects an override flag in the call.

### 8.4 Audit log

Every read writes a row. Includes:
- `actor`: the Bearer-token's role (`NEXUS_CUSTOMER_LOOKUP` / `NEXUS_CSR_LOOKUP`).
- `target_type`: `Invoice` / `Customer` / `FinishedLot`.
- `target_id`: invoice number / customer_id / trace_code (sliced).
- No PII in the audit payload.

---

## 9. Implementation phases

### COMMERCIAL-TRACE-1 — plan only (this document)
Stop. Owner reviews vision correction + supersession of NEXUS-0..6.

### COMMERCIAL-TRACE-2 — schema for Zoho invoices/lines + allocations
- Migration `00XX_zoho_invoices_and_allocations`:
  - Add `zoho_sync_kind` enum value `INVOICES` (separate from existing `SALES_ORDERS`).
  - Create `zoho_invoices`, `zoho_invoice_lines`, `finished_lot_invoice_allocations`.
  - Add `lot_picked_at_pack boolean default false` + `lot_picked_at_pack_by_user_id uuid` to `shipment_finished_lots` for the future HIGH-confidence pack-out path.
- Drizzle schema mirrored.
- No code yet that writes to these tables — schema-only phase like ZOHO-1.
- Tests: schema-level invariants (CHECK constraints, unique indexes).
- Stop: migration applied on staging, tables visible in psql.

### COMMERCIAL-TRACE-3 — Zoho invoice dry-run client + diff preview
- `lib/integrations/zoho/invoices.ts` — `fetchZohoInvoicesDryRun` (list + paginate) and `fetchZohoInvoiceDetail(invoiceId)` for line items. Normalizers + `deriveZohoInvoiceLumaTarget`.
- `lib/integrations/zoho/sync-dry-run.ts` extended (or a sibling `invoice-dry-run.ts`) with diff engine + orchestrator. Reuse the ZOHO-2A readiness gate (NEEDS_REAUTH still blocks).
- Mocked tests using fixtures.
- Settings page `/settings/integrations/zoho` gains a third dry-run section "Invoice dry-run".
- Stop: tsc/vitest/build green; dry-run button blocks honestly while tokens expired; closeout doc.

### COMMERCIAL-TRACE-4 — allocation suggestion engine
- `lib/production/invoice-allocations.ts` — pure helpers:
  - `suggestAllocationsForInvoiceLine(line, lumaContext) → Suggestion[]`
  - `applyAllocation(suggestion, db, actor) → DB write`
  - `confirmAllocation(allocationId, actor) → DB write`
- No UI yet. Tested against a wide fixture matrix (exact match → MEDIUM, multiple → LOW, missing item map → no suggestion, etc.).
- Stop: tests green; engine emits suggestions for fixture invoice lines against fixture finished lots.

### COMMERCIAL-TRACE-5 — allocation review UI
- New admin page `/admin/invoice-allocations` (or `/finished-lots/allocations`) — list of invoices with:
  - Resolved (all lines have HIGH-confirmed allocations) ✅
  - Partially resolved (some MEDIUM/LOW suggestions pending) ⚠️
  - Unresolved (MISSING for one or more lines) ❌
- Detail page per invoice: line-by-line view, suggestions, "Confirm" + "Override" + "Skip" buttons.
- Audit log entry per confirm.
- Stop: page reachable + lints clean; auth smoke gains 2 routes.

### COMMERCIAL-TRACE-6 — Nexus read-only invoice/batch APIs
- `app/api/integrations/nexus/invoice-batches/route.ts` (GET only).
- `app/api/integrations/nexus/customer-batches/route.ts` (GET only).
- `app/api/integrations/nexus/batch-passport/route.ts` (GET only).
- Shared auth middleware in `lib/integrations/nexus/lookup-auth.ts` (validates Bearer + scope + customer-id header).
- Audit-log writes per call.
- Compose env: `NEXUS_LOOKUP_TOKEN` + `NEXUS_CSR_LOOKUP_TOKEN`.
- Stop: in-process mock-receiver verify script proves the customer-safe vs CSR scopes return the right field set; HIGH-only filtering works; cross-customer requests get 404.

### COMMERCIAL-TRACE-7 — staging verification with mock invoice + finished lot
- `scripts/verify-commercial-trace.ts` — seeds a QA invoice + QA finished lot, runs the suggestion engine, confirms via the action, hits all three Nexus endpoints, asserts the customer scope hides supplier_lot and the CSR scope shows it. Cleanup.
- Stop: verify script exits 0.

### COMMERCIAL-TRACE-8 — live Zoho verification after tokens are refreshed
- Hard prerequisite: gateway operator re-authorizes `haute_brands` × {books, crm, expense, inventory} Zoho tokens on LXC 9503.
- Run the invoice dry-run against real Zoho data. Confirm non-zero `scanned` counts. Sign off the diff. Promote a small batch to confirmed allocations via the review UI. Validate Nexus endpoint outputs against a real customer's real invoice.
- Stop: production-ready signal.

---

## 10. Risks + open questions

### 10.1 Open questions

1. **How does Nexus surface "supplier lot visible" customers?** The existing `customers.supplier_lot_visible` flag affects the CSR drill-through. Should the customer-facing scope ever expose supplier_lot when this flag is true, or never regardless? Recommendation: never. The flag stays internal-only; customers see only trace_code.
2. **What unit does Zoho actually use on invoice lines?** Reasonable guess: a mix of `each`, `bottle`, `case`, `display`. The allocation engine needs `product-structure.ts` conversion rules between these. Need a real invoice payload sample at COMMERCIAL-TRACE-3 to confirm the unit names.
3. **Should `unresolved_quantity` ever be exposed to the customer in §7.1?** It's an honest signal but might confuse customers ("did you ship me everything?"). Recommendation: include but label as "tracking pending" rather than "missing".
4. **Pack-out scan capture — when does it exist?** This is COMMERCIAL-TRACE-2's `lot_picked_at_pack` boolean + a future floor PWA flow. The HIGH-confidence-from-scan path is *plumbed* in COMMERCIAL-TRACE-2 but not *enabled* until a pack-out station UI lands. Until then HIGH only comes from operator confirm. Owner OK with that?
5. **Should we backfill historical invoices?** Zoho probably has 2-3 years of invoices. The dry-run should default to last 90 days. Backfilling is a separate one-shot script run by the operator with date-range flags. Plan it for COMMERCIAL-TRACE-8 if needed.
6. **Sales orders vs invoices — both?** Some customers issue an SO first then invoice it. Allocations should hang off invoices (the "shipped" event) not SOs (the "ordered" event). SOs become useful for production planning, not commercial trace. COMMERCIAL-TRACE keeps SOs out of scope; ZOHO-4 may pick them up later.
7. **Nexus IP allowlist?** Belt + suspenders alongside the Bearer token. If Nexus runs on a known LXC, allowlist its IP in the reverse proxy. Defers to operations rather than this plan.

### 10.2 Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Auto-suggestion creates a false HIGH allocation | Engine never produces HIGH from auto-match. HIGH requires explicit scan or operator confirm. |
| 2 | Customer queries another customer's invoice via the Nexus endpoint | Customer-scope cascade in §8.2. Returns 404 (not 403 — no info leak). Audit-log row written. |
| 3 | Invoice line has no `zoho_item_id` (manual / one-off invoice) | NEEDS_REVIEW; never auto-allocates. |
| 4 | Customer was renamed in Zoho but `zoho_customer_id` is stable | Match by id, not name. Already the case in ZOHO-2A. |
| 5 | `external_item_mappings` has wrong `luma_product_id` for a Zoho item | Allocation engine surfaces it as LOW with the suspected wrong mapping called out. Operator can fix the mapping in `/settings/integrations/zoho-items` and re-run. |
| 6 | High-volume invoice flood (large customer mass-buys) | Engine processes one line at a time; pagination natural. No O(N²) anywhere. |
| 7 | A CSR drills through to internal passport unnecessarily | `audit_log` captures every CSR lookup; operations team can spot patterns. |
| 8 | Zoho schema drift in the invoice payload | `raw_payload jsonb` preserves verbatim. Code reads named fields with fallbacks. |
| 9 | Invoice gets voided in Zoho after Luma already allocated lots | Sync flips `status='void'`. Engine surfaces "this invoice is voided but has 2 HIGH allocations". Operator decides whether to keep them (re-issued under a new invoice with the same lots) or revoke. |
| 10 | Two invoices for the same finished lot (legitimate: split-shipment to two customers OR error: duplicate invoicing) | DB allows multiple allocations per `finished_lot_id`. Review UI surfaces "this lot has 2 invoice allocations" so an operator can confirm or remove one. |
| 11 | Operator confirms wrong lot | `confirmed_by_user_id` recorded. Operator can also explicitly delete the allocation row (soft-delete with audit) and re-confirm correct lot. |
| 12 | The Nexus API leaks supplier_lot to a CSR who isn't supposed to see it | `NEXUS_CSR_LOOKUP_TOKEN` is the gate. Roles inside Nexus that shouldn't see internal data shouldn't have the CSR token. Operations boundary. |

---

## 11. Stop condition for COMMERCIAL-TRACE-1

This document committed. The supersession of the old NEXUS-0..6 plan recorded in `docs/CURRENT_PHASE_STATUS.md` and `docs/CLAUDE_BUILD_QUEUE.md`. Owner answers questions §10.1 #1 (supplier_lot for customers — recommended NEVER), #2 (unit conventions — needs Zoho sample), and #4 (pack-out-scan timing) before COMMERCIAL-TRACE-2 starts.

**COMMERCIAL-TRACE-2 is ready** once the supersession is acknowledged and #1 is decided. Questions #2 / #4 are not blocking the schema phase — they shape the allocation engine in COMMERCIAL-TRACE-4.
