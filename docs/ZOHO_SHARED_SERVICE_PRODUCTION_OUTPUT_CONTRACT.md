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
