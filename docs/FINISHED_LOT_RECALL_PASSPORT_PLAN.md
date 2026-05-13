# Finished Lot / Recall Passport — Implementation Plan (LOT-1A)

**Status:** Plan only. No code, no migration, no UI change in LOT-1A.
**Scope:** Define the model + phases for an end-to-end recall passport: supplier lot → receive → raw bag → workflow bag → finished lot → shipped customer. Make every link queryable in both directions.
**Out of scope (this phase):** Nexus / QIP integration, TabletTracker, visual polish, master-branch merge.
**Date:** 2026-05-13.

---

## 1. Current-state audit

This section is a flat inventory of what already exists in `lib/db/schema.ts` and the surrounding code. **Nothing here is changing in LOT-1A.** The phases that follow (LOT-1B onward) will lean on these tables rather than replacing them — the goal is to *bridge* the gaps, not rewrite the model.

### 1.1 Raw-side hierarchy (already in place)

| Entity | Table | Key fields | Notes |
|---|---|---|---|
| Purchase order | `purchase_orders` | `poId` | One PO can spawn many receives. |
| Receive event | `receives` (`lib/db/schema.ts:518-534`) | `receiveName` (e.g. `"PO123-R1"`), `shipmentId`, `poId`, `receivedAt`, `receivedById` | This is the closest thing to an "internal receipt pad number" today. It is **per-receive event**, not per-bag. |
| Small box | `small_boxes` (`lib/db/schema.ts:536-551`) | `boxNumber`, `defaultBatchId`, `totalBags` | Optional grouping inside a receive. |
| Batch | `batches` (`lib/db/schema.ts:908`) | `vendorLotNumber` (the supplier / manufacturer lot) | One batch can hold many `inventory_bags`. |
| Raw bag | `inventory_bags` (`lib/db/schema.ts:555-589`) | `bagNumber`, `pillCount`, `weightGrams`, `vendorBarcode`, `batchId`, `status`, `notes` | **No QR code field at intake.** `vendorBarcode` is the manufacturer's own sticker that gets scanned for verification, not a Luma-issued QR. |

**Gap:** there is no Luma-issued QR code field on `inventory_bags` and no canonical "internal receipt number" stamped on the individual bag. Today operators reconstruct that ad-hoc from `receives.receiveName + inventory_bags.bagNumber`.

### 1.2 Workflow / production-side (already in place)

| Entity | Table | Key fields | Notes |
|---|---|---|---|
| Workflow bag | `workflow_bags` (`lib/db/schema.ts:~1030`) | `receiptNumber` (text), `qrCodeId` (FK to `qr_cards`), `inventoryBagId` (nullable FK) | This is the bag *as it moves through stations*. `receiptNumber` is denormalised for fast print. |
| QR card | `qr_cards` (`lib/db/schema.ts:1009-1023`) | `scanToken` (UUID), `status` IDLE / ASSIGNED / RETIRED, `assignedWorkflowBagId` | QRs are **pre-printed laminate badges** assigned to workflow bags at production start, *not* at raw intake. |
| Workflow events | `workflow_events` (event log, source of truth) | `eventType`, `workflowBagId`, `payload`, `occurredAt` + OP-1 accountability fields | All production state changes (BAG_FINALIZED, PACKAGING_COMPLETE, BAG_RELEASED, BAG_PAUSED, MATERIAL_CONSUMED, the five QC types, etc.) live here. |

**Gap:** the link from a `workflow_bag` back to its specific raw `inventory_bag` is `workflow_bags.inventoryBagId`, which is **nullable** today (some bags are created without an explicit inventory-bag FK, especially synthesised / legacy). Recall lookup cannot rely on this alone.

### 1.3 Finished-side (partially in place)

| Entity | Table | Key fields | Notes |
|---|---|---|---|
| Finished lot | `finished_lots` (`lib/db/schema.ts:956-978`) | `finishedLotNumber` (unique), `producedOn`, `expiryDate`, `unitsProduced`, `displaysProduced`, `casesProduced`, `status`, `workflowBagId` (nullable FK) | The lot code printed on cases / displays. Status enum: PENDING_QC, RELEASED, ON_HOLD, SHIPPED, RECALLED. |
| Finished-lot inputs | `finished_lot_inputs` (`lib/db/schema.ts:983-1002`) | `finishedLotId`, `batchId`, `qtyConsumed`, `derivedFromEventId` | Many-to-many between finished lots and **batches** — *not* individual inventory bags. |

**Gap (critical):** `finished_lot_inputs` resolves to **batch**, which means if a batch contained 10 inventory bags and only 3 went into a particular finished lot, today's model cannot say which 3. We need the M:N relationship one level deeper.

### 1.4 Packaging / roll linkage (already in place, event-based)

| Entity | Mechanism | Notes |
|---|---|---|
| Packaging lot ↔ workflow bag | `material_inventory_events` (`lib/db/schema.ts:830-870`) | Append-only event ledger with FKs to both `packaging_lot_id` AND `workflow_bag_id`. No direct FK between the two tables themselves — linkage is reconstructed by replaying events. |
| Roll mounted / weighed / unmounted | `MATERIAL_MOUNTED`, `MATERIAL_WEIGHED`, `MATERIAL_UNMOUNTED` events | Each carries `workflowBagId` (or null for between-bag activity) + `packagingLotId` + grams. `read_roll_usage` materialises per-packaging-lot state. |

**Implication for recall:** for a given finished lot, "which rolls / packaging lots touched it" is derivable by replaying events scoped to the contributing workflow bags. We do **not** need a new FK table — we need a *projection* that materialises this for fast recall lookup.

### 1.5 QC linkage (already in place)

The 5 QC event types (PACKAGING_DAMAGE_RETURN, REWORK_SENT, REWORK_RECEIVED, SCRAP_RECORDED, SUBMISSION_CORRECTED) all carry `workflowBagId` in their payload and are projected into `read_bag_state` (QC flags) + `read_operator_daily` (QC counters) + `read_sku_daily` + `read_station_quality_daily` via `lib/projector/qc-events.ts`. Recall lookup needs to surface the events themselves, not just the flags.

### 1.6 Customer / shipment / Nexus (mostly absent)

| Entity | Status |
|---|---|
| `customers` table | **Does not exist.** |
| `shipments` (`lib/db/schema.ts:502-516`) | Exists but minimal: `carrier`, `trackingNumber`, `shippedAt`, `deliveredAt`, `deliveryPhotoPath`, `poId`. No customer FK, no `finishedLotId` FK. |
| Nexus / QIP table or stub | **Does not exist.** |

This is the largest "absent" area. LOT-1B should not try to model customers fully — Nexus integration owns that — but LOT-1B should add an outbound contract (an opaque `customer_external_id` text field + a `shipment_finished_lots` link table) so the recall surface is wired even before Nexus lands.

### 1.7 Genealogy UI (already in place, single-bag scope)

`app/(admin)/genealogy/[bagId]/page.tsx` calls `deriveBagGenealogy(bagId)` and renders a chronological event stream for **one** `workflow_bag`. There is no:
- search-by-anything-else entry point (no search by supplier lot, no search by finished lot code),
- multi-bag rollup (no "this finished lot was made from these N raw bags"),
- recall mode / "show everything downstream from this raw bag" view.

---

## 2. Proposed schema

The proposed model preserves every existing table and adds a thin bridge layer. Naming conventions follow the codebase: snake_case in SQL, camelCase in `schema.ts`, table names already-plural. New tables marked **NEW**; existing tables that gain columns marked **EXT**.

### 2.1 Tables overview

```
purchase_orders ──┐
                  ├─► receives ──► small_boxes ──┐
shipments ────────┘                              │
                                                 ▼
       batches (vendor_lot_number) ◄──── inventory_bags
                                          (EXT: bag_qr_code, internal_receipt_number)
                                                 │
                                                 ▼
                                          workflow_bags
                                          (EXT: ensure inventory_bag_id non-null
                                                 for new bags going forward)
                                                 │
                          ┌──────────────────────┼──────────────────────┐
                          ▼                      ▼                      ▼
                workflow_events          finished_lots          material_inventory_events
                  (existing)            (EXT: trace_code,         (existing)
                                         packed_at, ...)
                                                 │
                       ┌─────────────────────────┼─────────────────────────┐
                       ▼                         ▼                         ▼
              finished_lot_raw_bags     finished_lot_outputs   finished_lot_packaging_lots
                       NEW                       NEW                       NEW
                                                 ▼
                                         finished_lot_qc_events
                                                 NEW (projection)
                                                 │
                                                 ▼
                               shipment_finished_lots (NEW link table)
                                                 │
                                                 ▼
                                          customers (NEW, stub-ish)
```

### 2.2 `inventory_bags` (EXT) — raw-bag passport

Add three nullable columns (keep nullable for back-compat with historical rows):

| Column | Type | Purpose |
|---|---|---|
| `bag_qr_code` | `text UNIQUE` | Luma-issued QR string printed at intake. Distinct from `vendorBarcode` (manufacturer's barcode). |
| `internal_receipt_number` | `text` | Human-readable code printed on the bag — typically `<receiveName>-B<bagNumber>`, but explicit so it survives if `receiveName` changes. |
| `declared_pill_count` | `integer` | Renamed-from / aliased-to `pillCount`. Keep both — `pillCount` is the live working count post-adjustment; `declared_pill_count` is the supplier-declared number at intake. |

Indexes: unique on `bag_qr_code`, btree on `internal_receipt_number`, btree on `batch_id` (already exists).

> **Rule (LOT-1B):** never repurpose `vendorBarcode` for the Luma QR. They are different identifiers — the vendor barcode is whatever the manufacturer put on the bag (often unscannable / proprietary); `bag_qr_code` is what Luma prints. Recall lookups index `bag_qr_code`, not `vendorBarcode`.

### 2.3 `finished_lots` (EXT) — printed-code clarity

Add columns to make the print contract explicit:

| Column | Type | Purpose |
|---|---|---|
| `trace_code` | `text UNIQUE NOT NULL` | The customer-facing code printed on displays / master cases. Same value as `finishedLotNumber` for newly-created lots; column added so the *print-code* concept is named separately from the internal `finishedLotNumber`. Different roles, same string today — they may diverge later (e.g. branded skew of the code per customer). |
| `packed_at` | `timestamptz NOT NULL` | When the final pack happened. Today derivable from `BAG_FINALIZED` event time but expensive to query at scale. |
| `expires_at` | `timestamptz` | Already partially captured as `expiryDate date`. Add `expires_at timestamptz` for time-zone-correct calculations; `expiryDate` stays for human display. |
| `finished_lot_code_alias` | `text` | Optional. Some customers ask Luma to print their own SKU code on the case. Stored here so recall can match either the canonical `trace_code` or the customer alias. |

### 2.4 `finished_lot_raw_bags` (NEW) — M:N at raw-bag granularity

This is the recall-critical bridge. Today's `finished_lot_inputs` resolves at batch level; this resolves at bag level.

```sql
CREATE TABLE finished_lot_raw_bags (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finished_lot_id      uuid NOT NULL REFERENCES finished_lots(id) ON DELETE CASCADE,
  inventory_bag_id     uuid NOT NULL REFERENCES inventory_bags(id) ON DELETE RESTRICT,
  -- The workflow_bag that consumed this raw bag (if any). When the raw
  -- bag was split across multiple workflow bags this row gets emitted
  -- per workflow_bag, so one (finished_lot_id, inventory_bag_id) pair
  -- may have multiple workflow_bag_id entries.
  workflow_bag_id      uuid REFERENCES workflow_bags(id) ON DELETE SET NULL,
  -- Quantity reconciliation. NULL when we only know "this bag
  -- contributed" but not the exact split — better honest-data
  -- discipline than guessing.
  qty_consumed_pills   integer,
  qty_consumed_grams   numeric(20,6),
  -- Confidence ladder consistent with PT-6 / PT-7:
  -- HIGH   = derived from an explicit RAW_CONSUMED event
  -- MEDIUM = derived from inventory_bag → workflow_bag → finished_lot chain
  -- LOW    = derived from batch-level finished_lot_inputs (downgraded)
  -- MISSING = no chain — flagged for operator review
  confidence           text NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW','MISSING')),
  derived_from_event_id uuid REFERENCES workflow_events(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON finished_lot_raw_bags (finished_lot_id);
CREATE INDEX ON finished_lot_raw_bags (inventory_bag_id);
CREATE INDEX ON finished_lot_raw_bags (workflow_bag_id);
```

> **Honest-data rule:** if a row's `qty_consumed_pills` is null and `confidence = MISSING`, the recall UI must show "contribution unconfirmed" — never a fabricated number. Same discipline as the PT-6 / PT-7 confidence ladder.

### 2.5 `finished_lot_outputs` (NEW) — what physically rolled off the line

```sql
CREATE TABLE finished_lot_outputs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finished_lot_id     uuid NOT NULL REFERENCES finished_lots(id) ON DELETE CASCADE,
  output_kind         text NOT NULL CHECK (output_kind IN ('DISPLAY','MASTER_CASE','LOOSE_UNIT','PALLET')),
  output_serial       text,             -- if individual cases get serialised
  unit_count          integer NOT NULL,
  packed_at           timestamptz NOT NULL,
  packed_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  print_payload       jsonb NOT NULL DEFAULT '{}'::jsonb, -- what was actually printed on the carton
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON finished_lot_outputs (finished_lot_id);
CREATE INDEX ON finished_lot_outputs (output_serial);
```

Rationale: `finished_lots.displaysProduced/casesProduced` are *totals*. For recall we sometimes need the per-output row (the master case with serial #M-2026-04-001 contains lot trace code X), and to know what was *printed* on it (the `print_payload` keeps a snapshot of name / lot / date / expires / customer-alias if any — exactly what an investigator needs without scanning the physical carton).

### 2.6 `finished_lot_packaging_lots` (NEW) — projection from events

This is a read-model / projection, not a source of truth. The source of truth stays `material_inventory_events`. We materialise it because recall has to be fast and the event replay across multiple bags is expensive.

```sql
CREATE TABLE finished_lot_packaging_lots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finished_lot_id     uuid NOT NULL REFERENCES finished_lots(id) ON DELETE CASCADE,
  packaging_lot_id    uuid NOT NULL REFERENCES packaging_lots(id) ON DELETE RESTRICT,
  material_kind       text NOT NULL,           -- LABEL / BOTTLE / CAP / PVC_ROLL / FOIL_ROLL / ...
  qty_consumed        numeric(20,6),
  qty_consumed_unit   text,                    -- 'each' or 'g'
  confidence          text NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW','MISSING')),
  first_used_at       timestamptz,
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON finished_lot_packaging_lots (finished_lot_id);
CREATE INDEX ON finished_lot_packaging_lots (packaging_lot_id);
```

Built by a rebuilder analogous to `lib/projector/packtrack-recommendations.ts` — walk finished lots, find their contributing workflow bags, replay `material_inventory_events` filtered to those bag IDs, aggregate by `packaging_lot_id`.

### 2.7 `finished_lot_qc_events` (NEW) — projection from QC events

```sql
CREATE TABLE finished_lot_qc_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finished_lot_id     uuid NOT NULL REFERENCES finished_lots(id) ON DELETE CASCADE,
  workflow_event_id   uuid NOT NULL REFERENCES workflow_events(id) ON DELETE CASCADE,
  qc_event_type       text NOT NULL,   -- PACKAGING_DAMAGE_RETURN / REWORK_SENT / etc.
  occurred_at         timestamptz NOT NULL,
  workflow_bag_id     uuid REFERENCES workflow_bags(id) ON DELETE SET NULL,
  accountable_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  payload_summary     jsonb NOT NULL,  -- denormalised: reason, qty, station, etc.
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON finished_lot_qc_events (finished_lot_id);
CREATE INDEX ON finished_lot_qc_events (workflow_event_id);
CREATE INDEX ON finished_lot_qc_events (qc_event_type);
```

This is the audit-trail surface — every QC event on every contributing workflow bag, pinned to the finished lot it ended up affecting. Investigator query: "show me every QC event for trace code X."

### 2.8 `customers` (NEW, stub) and `shipment_finished_lots` (NEW)

```sql
CREATE TABLE customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code       text UNIQUE NOT NULL,   -- short stable code
  display_name        text NOT NULL,
  external_id_nexus   text,                   -- mapping key to Nexus when LOT-1F lands
  external_id_qip     text,
  contact_email       text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipment_finished_lots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id         uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  finished_lot_id     uuid NOT NULL REFERENCES finished_lots(id) ON DELETE RESTRICT,
  qty_shipped         integer,
  qty_shipped_unit    text,        -- 'displays' / 'cases' / 'loose'
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON shipment_finished_lots (shipment_id);
CREATE INDEX ON shipment_finished_lots (finished_lot_id);
```

And on `shipments` (EXT): `customer_id uuid REFERENCES customers(id) ON DELETE SET NULL`.

**Stub-ness note:** `customers` is intentionally minimal in LOT-1B. The full customer master record (addresses, terms, etc.) is Nexus' job. LOT-1B / LOT-1C only need enough to answer "which customer is this shipment going to" so the recall lookup works.

---

## 3. Trace / recall rules

The recall surface must answer six search axes with a single underlying engine. Each axis is one or more SQL queries against the schema above, scoped down to "every finished lot touched" then expanded back out for every linked entity.

### 3.1 The six search axes

| Search input | Resolution path | Output |
|---|---|---|
| Supplier lot number (`batches.vendor_lot_number`) | `batches` → `inventory_bags (batch_id)` → `finished_lot_raw_bags (inventory_bag_id)` → `finished_lots` → outputs / QC / packaging / shipments | All finished lots that consumed *any* bag of this supplier lot, plus every shipment that contains those lots. |
| Internal receipt number (`inventory_bags.internal_receipt_number`) | `inventory_bags` → `finished_lot_raw_bags` → ... | Same flow, narrower (one specific bag's downstream). |
| Raw bag QR (`inventory_bags.bag_qr_code`) | identical to receipt-number axis | Same. |
| Finished lot code (`finished_lots.trace_code` or `finished_lot_code_alias`) | direct lookup → outputs + raw bags + packaging + QC + shipments | One row at the top, expanding into the full passport. |
| Product (`products.id`) + date range | `finished_lots WHERE product_id = ? AND packed_at BETWEEN ?` | Bulk view — useful for "show every Mango Peach packed last week." |
| Customer + (optional) date range | `customers` → `shipments` → `shipment_finished_lots` → `finished_lots` | What this customer received. |

### 3.2 The recall-passport API contract

Single server action / RSC loader: `getRecallPassport({ searchKind, searchValue })`. Returns:

```ts
type RecallPassport = {
  finishedLot: FinishedLotRow;          // 1
  rawBags: RawBagRow[];                  // N — via finished_lot_raw_bags
  workflowBags: WorkflowBagRow[];        // N — distinct contributing bags
  packagingLots: PackagingLotRow[];      // N — via finished_lot_packaging_lots
  rolls: RollUsageRow[];                 // subset of packagingLots filtered to roll kinds
  qcEvents: FinishedLotQcEventRow[];     // N — via finished_lot_qc_events
  outputs: FinishedLotOutputRow[];       // N — displays / cases / pallets
  shipments: ShipmentRow[];              // 0..N
  customers: CustomerRow[];              // 0..N
  // Honest-data discipline
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'MISSING';
  missingInputs: string[];
  warnings: string[];
};
```

Confidence = MIN across all contributing edges (same ladder as PT-6 / PT-7 / PBOM). Missing fields populate `missingInputs[]`; never substituted with guesses.

### 3.3 Inverse search (forward trace)

The same engine has to answer the *forward* direction:
- "Given a supplier-lot recall notice from the manufacturer, which customers received affected product?"

Implementation: `getForwardTrace({ supplierLotNumber })` returns the union of `customers` across all `shipment_finished_lots` for every finished lot that consumed the supplier lot. Used to drive recall notices.

### 3.4 Bidirectional view rule

When the recall UI renders a passport, every entity is itself clickable into its own recall view. Click a raw bag → see all finished lots downstream. Click a finished lot → see contributing bags. Click a customer → see all lots ever shipped to them. This is one engine reused — no special-case query paths.

---

## 4. Printing rules

### 4.1 What goes on which carton

| Carton type | What is printed | Source field |
|---|---|---|
| Master case | Trace code, product, packed date, expires, count | `finished_lots.trace_code`, `products.name`, `finished_lots.packed_at`, `finished_lots.expires_at`, output row |
| Display | Trace code, product, packed date, count | same minus expires (sometimes) |
| Loose unit | Trace code (small), product | same |
| Optional customer-alias label | `finished_lot_code_alias` | when set |

### 4.2 Print policy

- **Canonical code on every carton is `finished_lots.trace_code`.** That is the only string a customer-side recall lookup needs.
- **Internal receipt / bag code is *not* printed on customer-facing cartons.** Internal codes (`inventory_bags.internal_receipt_number`, `workflow_bags.receipt_number`) stay inside Luma — they're printed on raw bags + internal travelers, not shipped cases.
- **Supplier lot number is *not* printed on customer-facing cartons** unless the customer explicitly requests it (some retail customers do; route through `finished_lot_code_alias` or a per-customer template).
- **If a customer wants their own SKU/code printed**, store it in `finished_lot_code_alias` and add a per-customer print template later (LOT-1E concern).

### 4.3 Raw-bag print

Raw bag intake (LOT-1B) generates a printable label per `inventory_bag`. Contents: `bag_qr_code` (QR symbol + text), `internal_receipt_number`, `batch.vendor_lot_number`, product name, `declared_pill_count`, `weight_grams`, `received_at`. This label rides the bag through production. The QR is what an operator scans at every station handoff.

> Important: the raw-bag QR is a *different* identifier from the `qr_cards.scanToken` that gets assigned to a `workflow_bag` later. Two different physical labels, two different QR strings. They can be linked but never conflated.

---

## 5. Nexus / QIP future handoff (LOT-1F preview)

LOT-1F will add an outbound contract — JSON snapshots posted to Nexus for every shipped finished lot. The schema above is designed so that contract is a thin projection:

### 5.1 Outbound payload shape

```jsonc
{
  "customer_id": "uuid-or-external-id",
  "customer_code": "ACME",
  "shipped_at": "2026-05-10T15:00:00Z",
  "finished_lot": {
    "trace_code": "FL-2026-05-001",
    "product_sku": "MANGO-PEACH-30",
    "packed_at": "2026-05-09T13:22:00Z",
    "expires_at": "2027-05-09T13:22:00Z",
    "supplier_lot_visible": false,   // policy flag
    "supplier_lot_number": "MFG-LOT-XYZ"  // omitted when supplier_lot_visible=false
  },
  "shipment": { "carrier": "FedEx", "tracking": "..." },
  "qty_shipped": 12,
  "qty_unit": "cases",
  "recall_metadata": {
    "status": "RELEASED",   // RELEASED | ON_HOLD | RECALLED
    "issue_report_url": "https://luma.example.com/recall/FL-2026-05-001"
  }
}
```

### 5.2 Customer-facing dropdown semantics (Nexus side)

When a customer files an issue report on Nexus / QIP:
- The lot dropdown is **populated only from shipments that customer received.** Never free-form. Never the full Luma catalog.
- Each option: `"<trace_code> — <product> — shipped <date>"`.
- Hidden audit field on submit: the `shipment_finished_lots.id` row, not the trace code (so it survives if the customer mistypes).
- Supplier lot is **hidden by default**; permissions-gated.

LOT-1F is responsible for the actual REST contract, retries, and signing — the schema in §2 is sufficient input for it.

---

## 6. Implementation phases

| Phase | Scope | Deliverable | Estimated |
|---|---|---|---|
| **LOT-1A** | Plan only (this doc). | `docs/FINISHED_LOT_RECALL_PASSPORT_PLAN.md`. | ½ day |
| **LOT-1B** | Schema migration + receiving bridge. Adds `bag_qr_code`, `internal_receipt_number`, `declared_pill_count` to `inventory_bags`. Creates `finished_lot_raw_bags`, `finished_lot_outputs`, `finished_lot_packaging_lots`, `finished_lot_qc_events`, `customers`, `shipment_finished_lots`. Extends `finished_lots` with `trace_code`, `packed_at`, `expires_at`, `finished_lot_code_alias`. Adds receiving UI hook to print raw-bag labels with QR. Tests: pure helpers for QR generation, label print payload, intake validation. | Migration `0030` + new admin receive flow. | 2 days |
| **LOT-1C** | Production finalisation creates finished lot rows automatically. Hook into `BAG_FINALIZED` projector to write `finished_lots`, `finished_lot_raw_bags`, `finished_lot_outputs`. Backfill from `workflow_events` history. Add rebuilder for `finished_lot_packaging_lots` + `finished_lot_qc_events` projections (analogous to `lib/projector/packtrack-recommendations.ts`). | Projector module + rebuilder, wired into `scripts/rebuild-read-models.ts`. | 2 days |
| **LOT-1D** | Genealogy / recall lookup page. `/recall` or extension of `/genealogy` with the six search axes from §3.1. RSC page + server action `getRecallPassport`. Forward trace `getForwardTrace`. | New `/recall` page. | 2 days |
| **LOT-1E** | Print-label / export fields. Per-output print payload, per-customer template support, CSV export of recall passport. | Print template + export endpoint. | 1 day |
| **LOT-1F** | Nexus / QIP handoff contract. Outbound payload + signing + retry on transient failures. Permissioned supplier-lot visibility. | New `/settings/integrations/nexus` + outbound queue. | 1.5 days |
| **LOT-1G** | Staging verification + closeout. Seed N synthetic finished lots across N raw bags + N customers; exercise all six search axes; verify outbound Nexus payload; auth smoke; closeout doc entry. | Verification log + queue checkbox. | ½ day |

**Total:** ~9 days. The shape mirrors PT-6 / PT-7 / QC: plan → pure helpers → DB + projector → UI → outbound → verification.

---

## 7. Risks / open questions

These are the calls I *did not* make in this plan — they need explicit operator / business answers before LOT-1B starts.

| # | Question | Why it matters | Provisional answer (revisable) |
|---|---|---|---|
| 1 | Can one master case contain output from multiple raw bags? | Determines whether `finished_lot_outputs.print_payload` needs to enumerate raw bags. | Yes, occasionally — but the **trace code on the carton is single-valued**. Investigator drills via the passport, not the carton. |
| 2 | Do displays ever mix raw bags? | Same as #1 at a smaller granularity. | Same — yes, occasionally; trace code is single per display. |
| 3 | Should the printed code be the receipt number or the finished lot code? | Defines #4 in §4.2. | **Finished lot trace code on customer cartons; internal receipt number stays inside Luma.** This is the inverse of what some operators currently expect — explicit business approval needed before LOT-1E. |
| 4 | How are partial bags handled? | A bag may contribute 40 % to finished lot A and 60 % to finished lot B. | `finished_lot_raw_bags.qty_consumed_pills/grams` handles it. Confidence HIGH when an explicit split event exists; MEDIUM when inferred; MISSING when undecidable (UI shows "split unconfirmed"). |
| 5 | How are returned / reworked units merged back into a finished lot? | QC-3 has REWORK_RECEIVED but doesn't yet rejoin output to a lot. | Out of scope for LOT-1A-G. Track as a follow-up: REWORK_RECEIVED events that land back into a finished lot need an explicit lot-id payload field. Likely LOT-2. |
| 6 | What customer / shipment source will Nexus use? | Decides whether `customers.external_id_nexus` is leading or trailing key. | Provisional: Luma's `customers.customer_code` is the canonical key; Nexus stores its own UUID in `external_id_nexus`. Direction reversible once Nexus' contract is published. |
| 7 | Does a recall always promote the lot's status to RECALLED? | Affects projector behaviour. | No — RECALLED is a deliberate admin action. Recall *lookup* is read-only. RECALLED status flips only via a server action with full audit. |
| 8 | How do legacy / synthesised bags (no `inventory_bag_id`) fit into recall? | Many historical workflow bags pre-date the FK. | LOT-1C backfill marks them with `confidence = LOW` and `derived_from_event_id = null`. Recall surface shows them honestly ("legacy import — bag→lot link inferred from batch only"). |
| 9 | Who can see supplier lot numbers in Nexus payloads? | Some customers see their own supplier lot; some never. | `customers.supplier_lot_visible` flag (LOT-1F adds this column). Default off. |
| 10 | Should `bag_qr_code` collide-protect against `qr_cards.scan_token`? | Two namespaces, one scanner. | Yes — both are UUIDs, but prefix the printed string: `BAG-<uuid>` vs `WFB-<uuid>` so the scanner can route correctly without DB lookup. |

---

## 8. Stop conditions

LOT-1A is complete when:
1. `docs/FINISHED_LOT_RECALL_PASSPORT_PLAN.md` exists and includes all eight sections above.
2. The queue (`docs/CLAUDE_BUILD_QUEUE.md`) has a LOT-1 block with LOT-1A checked and LOT-1B–G enumerated.
3. No code, no migration, no schema change has landed.
4. The open questions in §7 are surfaced to the operator for answers before LOT-1B starts.

LOT-1B is ready when the answers to §7 #3 and §7 #6 land. The rest (§7 #1, #2, #4, #5, #7, #8, #9, #10) have defensible default answers above and can be deferred to their respective sub-phases.
