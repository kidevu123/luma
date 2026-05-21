# Zoho item sync — implementation plan

**Status:** schema + helpers + classifier in place (H.x0.5). Live API not implemented. Live UI not implemented.
**Owner contract:** Luma is production-of-record. Zoho enriches; it never overrides.

This document is the spec for the engineer who eventually wires the live sync. It states what exists, what is missing, and the rules the live implementation must follow.

---

## What exists today

### Tables
- `external_systems` — registry; `ZOHO`, `PACKTRACK`, `NEXUS`, `QIP` already seeded.
- `external_item_mappings` — keyed on `(external_system_id, external_item_id)`. `mapping_type` defaults to `UNKNOWN`. `payload jsonb` preserves the verbatim Zoho row.
- `external_inventory_snapshots` — append-only audit of what Zoho reported. Has `payload jsonb` for the full record.

### Helpers (`lib/integrations/zoho/items.ts`)
- `getZohoSystemId()` — returns the seeded UUID. Live; safe.
- `upsertExternalItemMapping(input)` — live; idempotent. Never nullifies an existing Luma reference.
- `recordExternalInventorySnapshot(input)` — live; append-only.
- `mapZohoItemToLumaItem(zohoItem)` — pure classifier; conservative (returns `UNKNOWN` for ambiguous items).
- `listZohoItems()` / `listZohoInventorySnapshots()` — **stubs**. Throw `ZohoNotConfiguredError`.

### Existing OAuth client (do not duplicate)
- `lib/zoho/client.ts` already handles per-company OAuth, token refresh, and structured `ZohoApiError`. The new sync **must** use this client, not roll its own.

---

## What's missing

| Piece | Notes |
|---|---|
| Live `listZohoItems()` | Calls `/inventory/v1/items` paginated, returns `ZohoItemSummary[]`. Use the existing OAuth client. |
| Live `listZohoInventorySnapshots()` | Calls `/inventory/v1/items` (same endpoint, picks the inventory fields). Or `/inventory/v1/inventoryadjustments` if a snapshot stream is preferred. Decide based on what gives accurate `quantity_available`. |
| Periodic sync job | New pg-boss handler `zoho.items.sync`. Runs hourly. Pages through Zoho, calls upsertExternalItemMapping per item, calls recordExternalInventorySnapshot per item. |
| Mapping UI | New `/settings/integrations/zoho-items` body. Today the page is a placeholder. Add: search, filter by `mapping_type`, "Map to Luma item" action. |
| Cutover from inline `zoho_item_id` columns | `tablet_types.zoho_item_id`, `packaging_materials.zoho_item_id`, `products.zoho_item_id` all exist as inline columns. They are not removed in H.x0.5; the live sync should treat `external_item_mappings` as authoritative going forward and read inline columns only as fallback. A later phase deletes the inline columns once every code path is migrated. |
| Error handling | `ZohoNotConfiguredError` is a structured error. Sync job catches it and renders "Setup needed" on the admin page; never logs as a hard failure. |
| Rate limit | Zoho Inventory documents 100 req/min for paid tiers; the sync job must page with backoff. The existing client probably already handles this — confirm before running. |

---

## Implementation order (recommended)

1. Build `listZohoItems()` returning the first page only. Verify it returns plausible data via the admin UI (a small "Sync now" button).
2. Add the sync job; run it on demand. Confirm `external_item_mappings` rows appear.
3. Add the mapping UI: list, filter by mapping_type, "Map to Luma item" picker.
4. Add `recordExternalInventorySnapshot` to the same job.
5. Schedule the job (hourly is fine).
6. Migrate one push-to-Zoho code path (finished-lot release) to read from `external_item_mappings` instead of inline `zoho_item_id`. Verify parity. Then migrate the rest.
7. Once all read paths use `external_item_mappings`, drop the inline `zoho_item_id` columns.

---

## Rules the live sync MUST follow

1. **Never overwrite a non-null Luma reference.** Use `COALESCE(EXCLUDED.luma_*, existing)` semantics in the upsert (the helper already does this).
2. **Default `mapping_type` to `UNKNOWN`.** A Zoho item appears unmapped until an admin explicitly sets the type. The classifier `mapZohoItemToLumaItem` is a *suggestion*, not an automatic apply.
3. **Snapshots are immutable.** Never `UPDATE` an `external_inventory_snapshots` row. New data → new row. Tag rows with `snapshot_at`.
4. **Production code that needs a mapping but finds none must surface "Zoho item mapping missing".** Use the `missing()` helper from `lib/production/confidence.ts`. Do not invent a fallback.
5. **Sync failures must be silent in the UI** beyond a "last sync failed at HH:MM" notice — they must never block production scanning, finalize, or finished-lot release.
6. **No retroactive write to `tablet_types`, `packaging_materials`, or `products`.** The live sync writes only to `external_item_mappings` + `external_inventory_snapshots`. The existing master tables are read-only from sync's perspective.

---

## Test plan for the live sync

- Stub the OAuth client; assert that one Zoho item produces one `external_item_mappings` row.
- Re-run the sync; assert no duplicate (idempotency on the unique index).
- Manually map a row to a Luma item; re-run sync; assert the Luma reference is preserved.
- Set `mapping_type` to `FINISHED_GOOD`; re-run sync with the same Zoho row but now its name has changed; assert `external_item_name` updates but `mapping_type` and `luma_*` references do not.
- Simulate a transient Zoho error; assert the snapshot is not written and the run is logged as failed without raising.
