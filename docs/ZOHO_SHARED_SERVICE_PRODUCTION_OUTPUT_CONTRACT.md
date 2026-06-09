# Zoho shared service — Luma production output contract

Luma is the production source of truth. The shared Zoho integration service
(LXC 9503) owns Zoho auth, Books/Inventory API mechanics, purchase receives,
assemblies/manufactures, brand routing, retries, and Zoho-side idempotency.

Luma sends **one consolidated production-output request** per finished lot.
Luma does **not** call Zoho Books/Inventory directly for this flow.

## Endpoint

```
POST ${ZOHO_SERVICE_BASE_URL}/zoho/luma/production-output/commit
```

Legacy aliases for base URL: `ZOHO_INTEGRATION_URL`.

## Headers

| Header | Value |
|--------|--------|
| `Authorization` | `Bearer ${ZOHO_SERVICE_BEARER_SECRET}` |
| `X-Brand` | `${ZOHO_BRAND}` (default `haute_brands`) |
| `Idempotency-Key` | Stable per finished lot (see below) |
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |
| `X-Luma-Source` | `luma` |

Never log bearer secrets.

## Idempotency

Luma uses:

```
luma-production-output:<finishedLotId>
```

Retries for the same finished lot reuse this key unless the op is voided and
deliberately recreated. The shared service should treat duplicate keys as
safe replays and return the prior success response when applicable
(`X-Idempotency-Replay: true` optional).

## Request body (Luma → shared service)

```json
{
  "source": "LUMA",
  "luma_finished_lot_id": "<uuid>",
  "luma_workflow_bag_id": "<uuid or null>",
  "finished_lot_number": "<lot number>",
  "trace_code": "<trace code>",
  "product": {
    "luma_product_id": "<uuid>",
    "sku": "<sku>",
    "name": "<name>",
    "unit_composite_item_id": "<zoho item id>",
    "display_composite_item_id": "<zoho item id or null>",
    "case_composite_item_id": "<zoho item id or null>"
  },
  "source_receipts": [
    {
      "luma_inventory_bag_id": "<uuid>",
      "internal_receipt_number": "<receipt>",
      "luma_po_id": "<uuid or null>",
      "zoho_purchaseorder_id": "<zoho po id>",
      "luma_po_line_id": "<uuid or null>",
      "zoho_purchaseorder_line_item_id": "<zoho line item id>",
      "tablet_type_id": "<uuid>",
      "tablet_name": "<name>",
      "tablet_zoho_item_id": "<zoho item id>",
      "quantity_consumed": 1000
    }
  ],
  "output": {
    "units_produced": 900,
    "displays_produced": 20,
    "cases_produced": 5,
    "damaged_packaging": null,
    "ripped_cards": null,
    "loose_cards": null
  },
  "production_dates": {
    "produced_on": "YYYY-MM-DD",
    "packed_at": "ISO-8601 or null",
    "receive_date": "YYYY-MM-DD"
  },
  "component_batches": [
    {
      "item_id": "<Zoho component item ID>",
      "source_bag_id": "<Luma raw bag UUID>",
      "human_lot_number": "<batches.vendor_lot_number or batch_number>",
      "batches": [{ "batch_id": "<resolved via POST /zoho/items/batches/resolve>", "out_quantity": 2 }]
    }
  ],
  "luma_operation_snapshot": {
    "luma_operation_id": "luma-production-output:<finishedLotId>",
    "status": "finalized",
    "finalized_at": "<ISO-8601 from persisted op>",
    "product_id": "<Luma products.id UUID — not a Zoho item ID>",
    "product_family": "HYROXI_MIT_B",
    "finished_sku": "453535",
    "unit_composite_item_id": "<Zoho finished-good unit composite item ID>",
    "workflow_bag_id": "<uuid>",
    "finished_lot_id": "<uuid>",
    "source_allocations": [
      {
        "source_bag_id": "<inventory_bags.id>",
        "item_id": "<Zoho raw component item ID>",
        "human_lot_number": "<vendor lot>",
        "quantity": 900
      }
    ]
  },
  "verification": { "mode": "snapshot" },
  "idempotency_key": "luma-production-output:<finishedLotId>",
  "warehouse_id": "<optional>"
}
```

### Source receipt rules

- Prefer **closed/depleted** `raw_bag_allocation_sessions` linked to the finished lot.
- Do **not** fabricate consumption from batch genealogy for live commit.
- If no allocation ledger exists, Luma stores `NEEDS_MAPPING` and does not call commit.

### Output metrics

- `units_produced`, `displays_produced`, `cases_produced` come from `finished_lots`.
- Damage/ripped/loose come from `read_bag_metrics` when available; sent as `null` when missing (not assumed zero).

## Response (shared service → Luma)

Success (2xx):

```json
{
  "ok": true,
  "external_reference_id": "<zoho-side reference>",
  "message": "optional human summary"
}
```

Failure (4xx/5xx):

```json
{
  "ok": false,
  "message": "operator-safe error",
  "code": "OPTIONAL_MACHINE_CODE",
  "details": {}
}
```

Luma maps:

| Luma op status | Meaning |
|----------------|---------|
| `READY` | Payload built; awaiting manual queue |
| `NEEDS_MAPPING` | Missing Zoho IDs or allocation ledger |
| `QUEUED` | Persisted; awaiting commit processor |
| `COMMITTING` | In-flight HTTP commit |
| `COMMITTED` | Shared service success recorded |
| `FAILED` | Service/network failure; admin may retry |

## Luma feature flags

| Env | Default | Effect |
|-----|---------|--------|
| `ZOHO_PRODUCTION_OUTPUT_ENABLED` | `false` | Enables consolidated path + live commit |
| `ZOHO_PRODUCTION_OUTPUT_AUTO_QUEUE` | `false` | Auto-`QUEUED` after lot create when enabled |
| `ZOHO_LEGACY_ASSEMBLY_ENQUEUE_ENABLED` | `false` when consolidated on | Blocks new `zoho_assembly_ops` live enqueue |

## Double-posting guard

When consolidated production output is enabled, Luma **does not** live-enqueue
legacy `zoho_assembly_ops` for new lots unless
`ZOHO_LEGACY_ASSEMBLY_ENQUEUE_ENABLED=true` (explicit opt-in).

Consolidated commit is blocked if legacy assembly ops or successful legacy
`zoho_pushes` already exist for the same finished lot.

## Luma modules

| Module | Role |
|--------|------|
| `lib/zoho/luma-production-output-payload.ts` | Payload builder |
| `lib/zoho/production-output-service-client.ts` | HTTP commit client |
| `lib/db/queries/zoho-production-output-consolidated.ts` | Outbox + processor |
| `lib/zoho/enqueue-production-output-after-lot-create.ts` | Post-lot-create hook |
| `app/(admin)/zoho-production-operations/` | Admin ops UI |

Preview path (admin manual) remains at `/finished-lots/[id]` using
`/zoho/luma/production-output/preview` — separate from consolidated commit.

## Batch resolution (v1.20.6)

```
POST ${ZOHO_SERVICE_BASE_URL}/zoho/items/batches/resolve
```

Request:

```json
{
  "item_id": "<Zoho raw component item ID>",
  "human_lot_number": "<physical lot from batches.vendor_lot_number>"
}
```

Success (HTTP 200):

```json
{
  "resolved": true,
  "resolution": "unique",
  "batch_id": "...",
  "batch_number": "...",
  "available_balance": 42.5
}
```

Missing (HTTP 404, `error.code = BATCH_NOT_FOUND`):

```json
{
  "resolved": false,
  "resolution": "missing",
  "error": { "code": "BATCH_NOT_FOUND" }
}
```

Ambiguous (HTTP 422, `error.code = BATCH_MATCH_AMBIGUOUS`):

```json
{
  "resolved": false,
  "resolution": "ambiguous",
  "error": { "code": "BATCH_MATCH_AMBIGUOUS" },
  "candidates": [{ "batch_id": "...", "human_lot_number": "..." }]
}
```

Luma accepts transitional responses with `resolution: "unique"` (without
`resolved: true`) but normalizes internally to `UNIQUE | MISSING | AMBIGUOUS |
OPERATOR_SELECTED`. Luma never auto-selects from ambiguous candidates.

### Snapshot identifier semantics

- `product_id` in `luma_operation_snapshot` is the **Luma internal UUID**
  (`products.id`), not a Zoho item ID.
- `unit_composite_item_id` is the Zoho finished-good composite item ID
  (`products.zoho_item_id_unit`).
- Zoho must not compare `product_id` directly with `unit_composite_item_id`.

### Component batch quantity semantics

- `unit_assembly_quantity` = number of finished composite units to build
  (`finished_lots.units_produced`).
- `component_batches[].batches[].out_quantity` = raw component inventory consumed.
- **Required rule:**

```
out_quantity = bom_quantity_per_unit × unit_assembly_quantity
```

Luma must not hard-code `out_quantity` without deriving it from the live/normalized
Zoho BOM. Allocation ledger consumed quantity must match the derived value.

**Choco Drift (SKU 453535) — confirmed live BOM (non-batch-tracked):**

| Component | Zoho item ID | Qty per finished single |
|-----------|--------------|-------------------------|
| Blister card (packaging) | `5254962000005277428` | 1 |
| Raw tablet (Chocolate Brown) | `5254962000005946408` | 4 |

- `component_batches` must be `[]` or omitted.
- Do **not** call batch resolve for this SKU.
- Human lot (`152-000166`) stays in Luma snapshot/audit only — not as a Zoho batch.
- Source allocation quantity for raw tablets = `4 × unit_assembly_quantity`.

### Source bag identifier semantics

- `component_batches[].source_bag_id` and
  `luma_operation_snapshot.source_allocations[].source_bag_id` must be
  `inventory_bags.id` from a **closed** `raw_bag_allocation_sessions` row.
- Never use `workflow_bags.id`, receipt labels, or fixture UUIDs as `source_bag_id`.
