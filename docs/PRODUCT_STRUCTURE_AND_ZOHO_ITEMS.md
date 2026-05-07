# Product structure + Zoho item foundation

**Branch:** `production-intelligence-command-center`
**Phase:** H.x0.5 (compatibility layer expansion)
**Last updated:** 2026-05-07
**Migration:** `0014_generic_item_structure.sql` (additive, idempotent)

This document explains:
1. The two-layer model — **product structure** vs **packaging BOM**.
2. The generic identity layer (`items`) we now have for any kind of pill, gummy, jar, kit, or future product.
3. The Zoho foundation that has landed (mapping + snapshots) and what's still needed for live sync.

It does **not** describe a finished feature. The schema and helpers are in place; the live sync, the live UI for mapping, and the live use of structure inside the projector are deferred to follow-up phases.

---

## 1. Two layers, kept separate on purpose

| Question | Answer | Layer |
|---|---|---|
| "How does one item become another?" | **Product structure** (`item_conversions`) | Generic conversion ledger |
| "What materials are consumed to make those units?" | **Packaging BOM** (`product_packaging_specs`) | Per-product material list |

Every confusing legacy column — `tablets_per_unit`, `units_per_display`, `displays_per_case` — is a **product structure** fact. We do not collapse them into the BOM.

A BOM line says *"each finished case requires 1 master case carton, 1 outer label, 24 inserts."* It does not say *"a case contains 24 displays."* Those are different statements and they live in different tables.

The reasons we keep them separate:

- A new product type (gummy → pouch → case) needs the same structure model. If structure and BOM are merged, every new product type forces a schema change. With them separate, the BOM stays product-specific while the structure stays universally generic.
- Material standards (PVC, foil, shrink film) consume on a per-blister or per-bottle basis — that's BOM territory. Pack-level scaling (case → display → unit) is structure territory. Mixing them produces wrong totals when one part has waste and the other does not.
- Zoho's item catalog is structure-aware (it knows "case" and "each") but BOM-blind. Keeping the two layers separate lets us map Zoho items into structure cleanly.

---

## 2. The generic identity layer: `items`

`items` is a thin polymorphic registry that points back at the three existing master tables:

| `items.source_kind` | Source row |
|---|---|
| `TABLET_TYPE` | `tablet_types.id` |
| `PACKAGING_MATERIAL` | `packaging_materials.id` |
| `PRODUCT` | `products.id` |
| `STANDALONE` | virtual intermediates (e.g. "blister card before sealing") |

Why polymorphic instead of consolidating? Because the existing tables have years of data with stable IDs, foreign keys all over the projector, the legacy importer, the synthesizer, and Zoho push targets. Consolidation would be a migration with deep blast radius. The registry gives every item a *single* ID without disturbing those data flows.

**Backfill ran in migration 0014.** Every existing row in `tablet_types`, `packaging_materials`, and `products` got a corresponding `items` row with item codes prefixed `TT:`, `PM:`, `PROD:` for global uniqueness. New rows added through the existing admin pages do not auto-create item rows — that is a follow-up wiring task. For now, `items` should be backfilled by a one-line SQL after a new product is created (admin UI helper lands later).

**Item categories** — controlled by a CHECK constraint:
`RAW_MATERIAL`, `PACKAGING_MATERIAL`, `COMPONENT`, `INTERMEDIATE_GOOD`, `FINISHED_GOOD`, `SELLABLE_SKU`, `SERVICE`, `OTHER`.

**Pack levels** — used by `item_conversions`:
`RAW`, `COMPONENT`, `INTERMEDIATE`, `UNIT`, `INNER_PACK`, `DISPLAY`, `CASE`, `PALLET`, `FINISHED_GOOD`, `SELLABLE`.

---

## 3. `item_conversions` — generic "1 X contains N Y"

Every row says: **1 *parent_item* (at *parent_pack_level*) contains *N* *child_item* (at *child_pack_level*)**.

Direction is fixed; the migration check enforces `parent_item_id <> child_item_id`. Reading the table is unambiguous.

### How current CARD product fits

```
Tablet (RAW)              ← child of Card (UNIT)        20 tablets per card
Card (UNIT)               ← child of Display (DISPLAY)  12 cards per display
Display (DISPLAY)         ← child of Case (CASE)        24 displays per case
```

Each row goes into `item_conversions`. The `product_id` ties the chain to the specific finished good; the `route_id` is optional (today's products have one route, but a product run on a custom route can override its conversions per route).

### How current BOTTLE product fits

```
Tablet (RAW)              ← child of Bottle (UNIT)      30 tablets per bottle
Bottle (UNIT)             ← child of Display (DISPLAY)  12 bottles per display
Display (DISPLAY)         ← child of Case (CASE)        24 displays per case
```

Two CASE-level conversion rows in CARD and BOTTLE both have `parent_pack_level = 'CASE'` — they converge on the case-packaging operation, exactly like the route layer's `PACKAGING` operation does.

### How a future POUCH product fits — without code

```
Gummy (RAW)               ← child of Pouch (UNIT)        10 gummies per pouch
Pouch (UNIT)              ← child of Case (CASE)         48 pouches per case
```

Steps an admin takes:
1. Create the products row (existing flow).
2. Insert two `items` rows (gummy + pouch) — `RAW_MATERIAL` and `FINISHED_GOOD` categories.
3. Insert two `item_conversions` rows.

No enum migration, no projector edit, no metric-API edit. The product structure helper will compute "10,000 gummies needed for 200 cases" with `HIGH` confidence the moment the conversion rows exist.

---

## 4. Helpers that callers must use

`lib/production/product-structure.ts`:

| Function | Purpose |
|---|---|
| `deriveProductStructure(productId)` | Returns ordered conversion chain (CASE → DISPLAY → … → RAW). |
| `deriveItemConversionChain(itemId)` | Walks parent → child links from any starting item. |
| `convertItemQuantity(fromItemId, toItemId, quantity)` | Generic forward/inverse conversion via the chain. |
| `deriveRequiredInputsForOutput(productId, qty, unit)` | Expands "200 cases of X" into displays + units + tablets. |
| `derivePackagingAndMaterialRequirements(productId, qty, unit)` | Multiplies BOM lines by target. Returns `MetricResult`s with `combineConfidence` rollup. |

All return MetricResult-shaped values (`{ value, unit, confidence, missingInputs, label, explanation }`). Empty states use the canonical labels:

- `Product structure missing` — no `item_conversions` for this product.
- `Product route missing` — no `product_route_assignments`.
- `Packaging BOM missing` — no `product_packaging_specs`.
- `Zoho item mapping missing` — Zoho-specific helpers only.

Helpers never invent a number. If a chain is incomplete, the missing step's `requiredQuantity` carries `confidence = MISSING` and the rest of the tree is honest about what it can compute.

---

## 5. Zoho foundation

Three tables landed in 0014:

| Table | Purpose |
|---|---|
| `external_systems` | Registry of upstream systems. Seeded with `ZOHO`, `PACKTRACK`, `NEXUS`, `QIP`. |
| `external_item_mappings` | Maps a Zoho external_item_id (text) to a Luma item / product / packaging-material. `mapping_type` defaults to `UNKNOWN`. |
| `external_inventory_snapshots` | Append-only. Records what Zoho reported, with verbatim payload. Never overrides Luma genealogy. |

**The contract:** Luma is the production-truth source. Zoho enriches setup (item catalog, sellable SKU codes) and demand (sales orders, on-hand). It does not — and will never — overwrite genealogy.

`lib/integrations/zoho/items.ts` exports the API contract:

| Function | Behavior today |
|---|---|
| `listZohoItems()` | Throws `ZohoNotConfiguredError`. |
| `listZohoInventorySnapshots()` | Throws `ZohoNotConfiguredError`. |
| `getZohoSystemId()` | Live; reads the seeded row. |
| `upsertExternalItemMapping(input)` | Live; inserts/updates the mapping row, never overwriting non-null Luma references. |
| `recordExternalInventorySnapshot(input)` | Live; appends. Never mutates anything else. |
| `mapZohoItemToLumaItem(zohoItem)` | Pure classifier; returns `UNKNOWN` for ambiguous items. Admin must confirm. |

**What's still needed before live Zoho item sync:**

1. Wire the existing `lib/zoho/client.ts` OAuth client to the items endpoint (path: `/inventory/v1/items`).
2. Implement `listZohoItems` + `listZohoInventorySnapshots` against the live API.
3. Schedule a periodic sync job (pg-boss, 1 min cadence is fine — `external_item_mappings` and snapshots are upsert-safe).
4. Build the mapping UI: search + filter by `mapping_type`, "Map to Luma item" action that flips a row's `luma_item_id`.
5. Wire production code that needs Zoho mapping (e.g. push-to-Zoho on finished-lot release) to `external_item_mappings` instead of the current ad-hoc `zoho_item_id` columns scattered across master tables.

---

## 6. PackTrack and Nexus / QIP — the same pattern

The `external_systems` table seeded `PACKTRACK`, `NEXUS`, and `QIP` precisely because the same shape applies:

- PackTrack will eventually consume Luma material requirements + finished lots (read-only).
- Nexus / QIP will consume finished-lot genealogy for QA review (read-only).

Each integration uses the same three tables (`external_systems`, `external_item_mappings`, `external_inventory_snapshots`) — there is no per-vendor schema. New vendors land as data rows.

---

## 7. Risks if we hardcode anyway

1. **Mismatched conversion rates.** A future `POUCH` product needs to run on the floor. If H.x3 reads `products.units_per_display` literally, pouches with `units_per_display = NULL` get either 0 (silent) or 1 (wrong) — neither is honest.
2. **Wrong PVC / foil rollup.** Bottle-route products would silently aggregate roll usage if the helper assumes `BLISTER` only. Splitting roll math by `route_operations.allowed_machine_kind` keeps it clean.
3. **Zoho push collisions.** Today's `tablet_types.zoho_item_id` and `packaging_materials.zoho_item_id` are inline columns. They don't survive a re-mapping cleanly. The new `external_item_mappings` table is the long-term home; using it requires wiring it through the push code.
4. **PackTrack drift.** Without a single mapping table, every external system grows its own ad-hoc fields and the master tables get hard to reason about.

---

## 8. What H.x3 / H.x4 / H.x7 must do differently after H.x0.5

- **H.x3** (PACKAGING_COMPLETE projector hook → MATERIAL_CONSUMED_ESTIMATED): consumption math reads `product_packaging_specs` (already kind-agnostic) — but the projector must NOT add a `if (product.kind === "CARD") ...` branch when the time comes to scale by route. Use the helpers here.
- **H.x4** (mountRollAction / unmountRollAction / weighRollAction): when reasoning about which products a roll affects, use `getRouteForProduct(productId)` + `getOperationForStage(routeId, stageKey)` to confirm the operation expects rolls. Do not check `product.kind`.
- **H.x7** (read-only material UI panels): show "expected vs actual" by composing `derivePackagingAndMaterialRequirements` with the metric-layer roll/material outputs. A future POUCH product surfaces in the same panels because the helpers return MetricResults regardless of route.
