# PackTrack shortage recommendations (PT-7) — plan

> **Phase:** PT-7A (plan only).
> **Drafted:** 2026-05-13.
> **Status:** no code shipped, no migration created, no PackTrack call made.
> **Predecessors complete:** PT-6 (8-bucket reconciliation), H.x7 (material panels), QC subsystem, PBOM-1 + PBOM-2 (BOM kind + product-compatibility gates).

This document is the contract for PT-7B through PT-7F. Anything later that diverges from this file is wrong; if reality forces a divergence, edit this file in the same commit.

---

## 1. Why this exists

Luma already has the inputs it needs to project *which packaging materials are about to run out*:

- `read_material_lot_state` knows current on-hand per packaging lot, with HIGH / MEDIUM / LOW / MISSING confidence (PT-6).
- `read_material_reconciliation_v2` knows accepted vs counted vs declared (PT-6's 8-bucket model with `accepted_value = COALESCE(counted, declared)`).
- `product_packaging_specs` (PBOM-1) defines consumption per finished unit / display / case.
- `product_material_compatibility` (PBOM-2) defines which materials are approved per product / scope, including a `required` flag.
- `read_sku_daily` + `read_material_consumption_daily` (Phase C / H) carry recent actual consumption.
- The QC subsystem records confirmed scrap that decrements lot state honestly.

What's missing is the **forward-looking projection** that fuses these signals into "we need to reorder N units of material X by date Y, and here's why, with this confidence". Today an operator has to mentally cross-reference five surfaces to see a shortage; PT-7 makes it a single recommendation.

**PT-7 is read-only on the PackTrack side.** Luma does not write POs into PackTrack. Luma generates a recommendation; PackTrack surfaces it to the owner; the owner approves; PackTrack creates the PO under its existing workflow. The receipt then flows back to Luma via the existing PackTrack → packaging-receipt path (PT-1) and closes the loop.

---

## 2. Hard boundary with PackTrack

| Concern | Owner |
|---|---|
| Inventory truth (on-hand, accepted) | **Both** — Luma tracks operational consumption + receipt-time truth; PackTrack tracks procurement-side truth (boxes ordered, en route, supplier confirms). PT-6 reconciliation already surfaces variance between them. |
| Usage / consumption rate | **Luma** — derived from `read_material_consumption_daily`, `read_sku_daily`, packaging events. |
| Shortage detection | **Luma** — pure math over Luma's read models. |
| Lead-time data | **PackTrack** — Luma reads it; doesn't write it. Initial PT-7B uses a config-supplied or hard-coded lead-time per material; PT-7E ingests live PackTrack lead-times. |
| Purchase orders | **PackTrack** — Luma never creates a PO. |
| Supplier relationships | **PackTrack**. |
| Owner approval | **PackTrack** — Luma generates the *recommendation*; PackTrack carries the approval workflow. |
| Receipt-time truth back into Luma | **PackTrack → Luma** — uses the existing PT-1 packaging-receipt push. |

If a future flow needs Luma to push the recommendation to PackTrack, that's PT-7E. PT-7B-D are entirely internal to Luma and require no PackTrack changes.

---

## 3. Recommendation model

One row per (material × needed-by-date × generation timestamp). A recommendation captures Luma's best-effort projection at generation time; new data invalidates old recommendations rather than mutating them.

### 3.1 Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `recommendation_id` | uuid | Y | Primary key. |
| `material_code` | text | Y | `packaging_materials.sku`. The stable identifier PackTrack also uses. |
| `material_name` | text | Y | `packaging_materials.name`. Operator-facing. |
| `material_id` | uuid | Y | Luma-side FK to `packaging_materials.id`. Not sent to PackTrack but kept for joins. |
| `product_id` | uuid | N | When the projection is product-specific (this material is consumed by Mango Peach at this rate). Null when the projection is material-wide. |
| `product_name` | text | N | Denormalized from `products.name`. |
| `product_sku` | text | N | Denormalized from `products.sku`. PackTrack handoff uses this as `product_code`. |
| `compatibility_role` | text | N | The PBOM-2 role this material plays for the product (`CARD_MATERIAL`, `DISPLAY_BOX`, `MASTER_CASE`, etc.). Null when not product-scoped. |
| `current_on_hand` | numeric | Y | From `read_material_lot_state.qty_on_hand` summed across active lots for this material. |
| `accepted_inventory` | numeric | Y | From `read_material_reconciliation_v2.accepted_value` summed across the material's lots (PT-6's `accepted = COALESCE(counted, declared)`). Can exceed `current_on_hand` when boxes are in-house but not yet on the shop floor; can be below when adjustments cut on-hand. |
| `projected_demand` | numeric | Y | Consumption Luma expects between `generated_at` and `needed_by_date` based on the rolling-window rate (see §5). |
| `projected_shortage_quantity` | numeric | Y | `max(projected_demand − accepted_inventory, 0)`. Zero means no shortage; positive means we'll be short by this many units. |
| `recommended_order_quantity` | numeric | Y | `projected_shortage_quantity` rounded up to the material's `min_order_quantity` (config); see §6. |
| `needed_by_date` | date | Y | The day inventory crosses zero given the current rate, minus the configured lead-time buffer. |
| `confidence` | text (enum) | Y | `HIGH` / `MEDIUM` / `LOW` / `MISSING` — see §4. |
| `reason` | text | Y | Single-sentence summary the owner reads first (e.g. *"Mango Peach printed cards run out 2026-05-23 at the current rate of 1,200/day"*). |
| `source_signals` | jsonb | Y | Array of `{ kind, label, value, confidence }` entries explaining the projection. See §3.2. Never empty when `confidence != MISSING`. |
| `severity` | text | Y | `CRITICAL` (already past needed_by_date) / `HIGH` (within lead time) / `MEDIUM` (within 2× lead time) / `WATCH` (further out). |
| `recommended_supplier_hint` | text | N | Optional supplier preference when known (most recent successful receipt's `packaging_lots.supplier`). PackTrack still picks the actual supplier. |
| `min_order_quantity_applied` | numeric | N | When `recommended_order_quantity` was rounded up, this records by how much. |
| `lead_time_days_used` | int | N | The lead-time value Luma plugged into the projection. PackTrack overrides this once PT-7E lands. |
| `generated_at` | timestamptz | Y | When this recommendation was projected. |
| `expires_at` | timestamptz | N | When the projection should no longer be trusted; default 24h after `generated_at`. After this, a new projection generates a new row. |
| `superseded_by` | uuid | N | FK to a newer recommendation that replaced this one. Older rows are kept for audit. |
| `acknowledged_at` | timestamptz | N | When Luma sent this to PackTrack (PT-7E). Null while pending. |
| `dismissed_at` | timestamptz | N | When the owner explicitly dismissed it without ordering. |
| `created_at` | timestamptz | Y | Insert time. |

### 3.2 source_signals schema

Each signal is one input that fed the recommendation. Operators trust a recommendation more when they can see what fed it.

```ts
type SourceSignal =
  | { kind: "CURRENT_ON_HAND";       label: string; value: number; confidence: Confidence; explanation?: string }
  | { kind: "ACCEPTED_INVENTORY";    label: string; value: number; confidence: Confidence; explanation?: string }
  | { kind: "DAILY_USAGE_RATE";      label: string; value: number; window_days: number; confidence: Confidence }
  | { kind: "PRODUCT_REQUIREMENT";   label: string; product_sku: string; per_unit: number; per_display: number; per_case: number }
  | { kind: "COMPATIBILITY_REQUIRED";label: string; product_sku: string; role: string }
  | { kind: "PACKTRACK_LEAD_TIME";   label: string; days: number; confidence: Confidence }
  | { kind: "RECENT_RECEIPT";        label: string; received_at: string; quantity: number; source: "PACKTRACK"|"MANUAL_LUMA"|"ZOHO"|"IMPORT" }
  | { kind: "REORDER_THRESHOLD";     label: string; par_level: number }
  | { kind: "SCRAP_RECENT";          label: string; quantity: number; window_days: number }
  | { kind: "MISSING_CONFIG";        label: string; what: string };
```

Banned patterns (per PT-6 / QC honesty rules — enforced in the language scan):
- Do NOT label a `RECEIPT_VARIANCE` signal as "production loss".
- Do NOT label a `CYCLE_COUNT_VARIANCE` signal as "supplier shortage".
- Do NOT fabricate a daily usage rate when no consumption rows exist — emit `MISSING_CONFIG`.

---

## 4. Confidence rules

| Confidence | When |
|---|---|
| **HIGH** | All of: (a) lot state confidence = HIGH (counted or weigh-back derived); AND (b) configured BOM line(s) for this material against a product (or material-wide); AND (c) ≥ 7 days of `read_material_consumption_daily` rows; AND (d) PBOM-2 compatibility row exists when product-scoped. |
| **MEDIUM** | Exactly one of these gaps: (a) lot state confidence = MEDIUM (supplier-declared only); OR (b) BOM configured but consumption window < 7 days (use config-default rate from material standards); OR (c) lead-time is config-supplied (not yet pulled live from PackTrack). |
| **LOW** | Two or more gaps from MEDIUM list, OR any of: legacy/imported lot state (`source_system='IMPORT'`); LOW lot-state confidence; usage rate derived from `read_sku_daily` × BOM rather than direct material consumption. |
| **MISSING** | Any of: no compatibility row when product-scoped AND no material-wide consumption history; no `packaging_materials.sku`; no usable lot-state row at all. **Recommendation is generated but `recommended_order_quantity` is null and the row is labeled "manual review required".** Never silently treated as "no shortage". |

Confidence per-signal flows into a worst-case overall, identical to PT-6's `overallConfidence` semantics. A single `MISSING_CONFIG` signal forces overall = MISSING (cannot quote a quantity).

---

## 5. Shortage rules — when a recommendation is emitted

The projector runs daily (and on-demand from the admin page in PT-7D). It walks every active packaging material and emits a recommendation if **any** of these fire:

1. **Required material on zero inventory.**
   `product_material_compatibility.required = true AND accepted_inventory = 0` → `severity=CRITICAL`, `confidence` from §4, `reason="Required {role} for {product_sku} has zero accepted inventory."`

2. **Projected runout before lead-time horizon.**
   `current_on_hand / daily_usage_rate < lead_time_days + safety_buffer_days` → `severity=HIGH` if < lead time, `severity=MEDIUM` if < 1.5× lead time, `severity=WATCH` otherwise.

3. **Below par level.**
   `current_on_hand < packaging_materials.par_level` AND projected_demand > 0 → at least `severity=WATCH`, escalates with rule 2.

4. **Production target unmet.**
   When `dueTargets` (existing standards table) sets a target output and the implied material demand exceeds `accepted_inventory` → `severity=HIGH`. Driven by `product_packaging_specs.qtyPerUnit` × target unit count.

5. **Compatibility configured but never received.**
   `product_material_compatibility.active = true AND active = required = true AND no packaging_lots ever received for this material` → `severity=HIGH`, `confidence=MISSING`, `reason="Compatibility configured but no receipts on file — verify material code with supplier."`

### 5.1 What does NOT trigger a recommendation
- **Receipt variance alone.** A lot with `receipt_variance > 0` is a procurement-side question, surfaced on `/po-reconciliation-v2`. PT-7 doesn't auto-recommend reorders for variance — that's already a `MANUAL_REVIEW` bucket on PT-6.
- **Cycle-count variance alone.** Same reason.
- **Scrap above noise floor.** Scrap that exceeds `wasteAllowancePercent` is a QC signal, not a reorder signal. PT-7 picks up its effect through the resulting `current_on_hand` decrement and the recent consumption rate — no double-counting.
- **PVC / FOIL / BLISTER_FOIL rolls.** Out of scope. Those are tracked via `read_roll_usage` and recommended for reorder through the existing roll-receiving flow, not PT-7. The recommendation projector explicitly excludes these kinds.

---

## 6. recommended_order_quantity formula

```
shortage          = max(projected_demand − accepted_inventory, 0)
target_buffer     = projected_demand × safety_buffer_percent (default 20%)
raw_qty           = shortage + target_buffer
min_order_qty     = packaging_materials_config.min_order_quantity (PT-7C adds the column)
recommended_qty   = ceil(raw_qty / min_order_qty) × min_order_qty
                    when min_order_qty > 0, else raw_qty
```

Honest behaviour when inputs are missing:
- `daily_usage_rate` unknown → `projected_demand = null`, `recommended_order_quantity = null`, recommendation still emitted with `confidence=MISSING` and signal `MISSING_CONFIG{what="usage_history"}`. The owner sees "we don't have enough data to size this order" rather than a guessed number.
- `safety_buffer_percent` not configured → default 20%; signal logs that the default was used.
- `min_order_quantity` not configured → no rounding; the raw quantity is presented as-is with a signal noting the absence.

---

## 7. Data sources

| Source | Used for | Confidence band of source |
|---|---|---|
| `read_material_lot_state.qty_on_hand` | `current_on_hand` | row-level (HIGH/MEDIUM/LOW/MISSING per lot) |
| `read_material_reconciliation_v2.accepted_value` | `accepted_inventory` | row-level (`accepted_confidence`) |
| `read_material_consumption_daily` | `daily_usage_rate` (preferred) | HIGH when ≥7 days, MEDIUM with shorter window |
| `read_sku_daily.bags_completed × product_packaging_specs.qty_per_unit` | `daily_usage_rate` fallback when consumption-daily empty | MEDIUM |
| `product_material_compatibility (active, required)` | scope projection by product + role | HIGH when present |
| `product_packaging_specs.qty_per_unit / waste_allowance_percent` | per-unit consumption + waste | HIGH when configured |
| `packaging_materials.par_level` | rule 3 (par-level trigger) | row-level |
| `packaging_lots.supplier, source_system` | `recommended_supplier_hint`, `RECENT_RECEIPT` signal, source tag | HIGH when source_system='PACKTRACK' |
| `dueTargets` (from `standards` admin) | rule 4 (production target unmet) | HIGH when configured |
| PackTrack lead-time (PT-7E) | `lead_time_days_used` | HIGH after PT-7E; config-default before |
| `workflow_events` of type `SCRAP_RECORDED` | `SCRAP_RECENT` signal (informational only) | HIGH from QC-2 |
| `read_roll_usage` | **explicitly skipped** for PVC/FOIL/BLISTER_FOIL kinds | n/a |

The projector reads from these in a single transaction (snapshot semantics) so a recommendation reflects a consistent state of the world.

---

## 8. PackTrack handoff contract

The outbound payload sent to PackTrack (PT-7E) when a recommendation is acknowledged for handoff. Stable JSON wire format; versioned via the `schema_version` field so PackTrack can evolve independently.

```json
{
  "schema_version": "1.0",
  "source": "LUMA",
  "generated_at": "2026-05-13T18:00:00Z",
  "recommendation_id": "550e8400-e29b-41d4-a716-446655440000",
  "material_code": "MP-CARD-001",
  "material_name": "Mango Peach printed card",
  "product_code": "MP-30CT",
  "compatibility_role": "CARD_MATERIAL",
  "current_on_hand": 1240,
  "accepted_inventory": 1880,
  "projected_demand": 9600,
  "projected_shortage_quantity": 7720,
  "recommended_order_quantity": 8000,
  "needed_by_date": "2026-05-23",
  "confidence": "MEDIUM",
  "severity": "HIGH",
  "reason": "Mango Peach printed cards run out 2026-05-23 at the current rate of 1,200/day.",
  "supporting_signals": [
    { "kind": "CURRENT_ON_HAND",     "label": "On-hand across 3 active lots", "value": 1240, "confidence": "HIGH" },
    { "kind": "ACCEPTED_INVENTORY",  "label": "Accepted at receipt", "value": 1880, "confidence": "HIGH" },
    { "kind": "DAILY_USAGE_RATE",    "label": "Avg daily consumption (last 7 days)", "value": 1200, "window_days": 7, "confidence": "MEDIUM" },
    { "kind": "PRODUCT_REQUIREMENT", "label": "Per finished card", "product_sku": "MP-30CT", "per_unit": 1, "per_display": 20, "per_case": 400 },
    { "kind": "COMPATIBILITY_REQUIRED", "label": "Required CARD_MATERIAL for Mango Peach", "product_sku": "MP-30CT", "role": "CARD_MATERIAL" },
    { "kind": "PACKTRACK_LEAD_TIME", "label": "Lead time (config default)", "days": 7, "confidence": "MEDIUM" },
    { "kind": "RECENT_RECEIPT",      "label": "Most recent receipt", "received_at": "2026-04-15", "quantity": 5000, "source": "PACKTRACK" }
  ],
  "recommended_supplier_hint": "Acme Print Co",
  "luma_links": {
    "recommendation": "https://luma.example/qc-review#rec-550e8400",
    "material": "https://luma.example/packaging-inventory?material=mp-card-001",
    "reconciliation": "https://luma.example/po-reconciliation-v2?material=mp-card-001"
  }
}
```

**Contract rules:**
- `recommendation_id` is the idempotency key on PackTrack's side — duplicate payloads do not create duplicate POs.
- `confidence != MISSING` is a hard precondition for sending. Missing-config recommendations stay on Luma until the gap is filled.
- `recommended_order_quantity` is a *recommendation*, not a binding number. PackTrack's PO can differ.
- No PO creation. No supplier API call from Luma.
- Owner approval happens entirely on the PackTrack side; the receipt that eventually comes back to Luma carries the PackTrack PO id (`packaging_lots.packtrack_po_id`) which closes the audit loop.

---

## 9. Approval flow

```
+--------+   1. project & rank                              +-----------+
| Luma   | -----------------------------------------------> | Luma DB   |
|        |    write read_material_recommendations row       | (read     |
+--------+                                                   |  models)  |
   |                                                         +-----------+
   | 2. admin acknowledges on /qc-review or
   |    /material-alerts (PT-7D)
   v
+--------+   3. POST recommendation payload (PT-7E)         +-----------+
| Luma   | -----------------------------------------------> | PackTrack |
|        |    (acknowledged_at set; idempotent on rec_id)   | inbox     |
+--------+                                                   +-----------+
                                                                   |
                                                                   | 4. owner approves
                                                                   v
                                                              +-----------+
                                                              | PackTrack |
                                                              | creates PO|
                                                              +-----------+
                                                                   |
                                                                   | 5. supplier ships
                                                                   v
                                                              +-----------+
                                                              | PackTrack |
                                                              | receives  |
                                                              +-----------+
                                                                   |
                                                                   | 6. PT-1 receipt push
                                                                   v
+--------+   7. packaging_lots row written w/ packtrack_po_id      +-----------+
| Luma   | <----------------------------------------------- | PackTrack |
|        |    PT-6 reconciliation v2 picks up the receipt   | API       |
+--------+    Recommendation marked fulfilled / superseded   +-----------+
```

Steps 4-6 are entirely owned by PackTrack. Luma never executes them.

---

## 10. Implementation phases

| Phase | Scope | Files (estimate) | Days |
|---|---|---|---|
| **PT-7A** | Plan only — this document. | 1 doc | 0.5 |
| **PT-7B** | Pure helpers in `lib/production/packtrack-shortage.ts`: `computeDailyUsageRate`, `projectShortage`, `computeRecommendedQuantity`, `classifyConfidence`, `classifySeverity`, `buildSourceSignals`. All take typed inputs; no DB calls; unit-tested with fixture matrices. | 2 new files (helper + test), ~40 tests | 1.5 |
| **PT-7C** | Migration 0029: `read_material_recommendations` table (rebuilder-driven read model; not append-only — replaced per-material per-run). `min_order_quantity` + `safety_buffer_percent` columns on `packaging_materials`. `lib/projector/recommendations.ts` rebuilder. `scripts/rebuild-read-models.ts` extension. | 1 migration, 2 new files, ~15 tests | 1.5 |
| **PT-7D** | Admin UI: extend `/material-alerts` with the recommendation table (severity-sorted, with the supporting_signals expandable accordion). New action `dismissRecommendationAction`. New action `acknowledgeRecommendationAction` (sets `acknowledged_at` — does NOT send to PackTrack yet, that's PT-7E). | 1 page edit, 1 action file, ~10 tests | 1 |
| **PT-7E** | Outbound PackTrack API client. `lib/integrations/packtrack/recommendations.ts` — posts the §8 payload to PackTrack's recommendations inbox. Idempotent on `recommendation_id`. Config in `/settings/integrations/packtrack`. Mock-and-record tests; real integration test gated on env. | 1 new client, 1 action wiring, ~10 tests | 1.5 |
| **PT-7F** | Staging verification: rebuild read models, generate a real recommendation for a real low-stock material, verify confidence labelling matches reality, manually acknowledge → confirm PackTrack received it (if PT-7E live) or confirm the local row was marked acknowledged. | 0 new files (verification only) | 0.5 |

**Total estimate:** 6.5 working days end-to-end.

**PT-7B readiness:** ✅ yes — all upstream phases (PT-6, QC, PBOM-1+2) are complete and provide the inputs PT-7B needs. PT-7B is pure-math + DB-handle-stub testable; no PackTrack contact required.

---

## 11. Risks / open questions

1. **Lead-time data source.** PT-7B and PT-7C use a config-default `lead_time_days` per material (or material kind). Live lead-times from PackTrack land in PT-7E. Until then, every recommendation carries a `PACKTRACK_LEAD_TIME` signal with `confidence: MEDIUM` and `label: "config default"`. Documented; not blocking.

2. **Daily usage rate window.** The plan uses a 7-day rolling window. Short for items used sporadically (a master case style used once per month would always read as "MISSING_CONFIG"). PT-7B may need a 28-day fallback window with `confidence: LOW`. Decide in PT-7B based on real data.

3. **Multi-product materials.** A single material (e.g. a generic master case) may be consumed by many products. The plan resolves this by emitting one recommendation per material (not per material × product) when `product_material_compatibility` lists multiple approved products, with `product_id = null` and a `supporting_signals` entry per product. PBOM-2's compatibility matrix makes this a one-query join.

4. **Materials with no PackTrack source.** Some materials may have only `source_system='MANUAL_LUMA'` or `'IMPORT'` receipts (legacy). Recommendations for these are still emitted but `recommended_supplier_hint` is null and a signal flags "no PackTrack history". PackTrack can still receive the recommendation; the owner picks a supplier.

5. **Stale recommendations.** `expires_at` defaults to 24h. The projector wipes-and-rewrites the table on each run, so a stale row is replaced rather than mutated. Acknowledged rows that age past `expires_at` without a fulfilling receipt should re-surface as a fresh recommendation — PT-7C decides the dedup rule.

6. **What if PackTrack rejects the payload schema?** PT-7E uses `schema_version="1.0"`. If PackTrack returns a 4xx, Luma records `last_send_error` on the recommendation and surfaces the failure on `/material-alerts`. No automatic retry — operator-driven.

7. **Recommendation churn.** A material right at the threshold may flip between "shortage" and "no shortage" daily. Mitigation: hysteresis — once a recommendation lands, don't withdraw it until on-hand exceeds `1.2 ×` the trigger threshold. PT-7C implements.

8. **PBOM-2 `required` flag interaction.** A required material with zero inventory is a CRITICAL shortage regardless of projected demand (rule §5.1). This catches the "we haven't started producing yet but we already can't" case.

9. **Variety packs.** A variety pack consumes child products' cards plus its own display + case. PT-7B's `projected_demand` math walks `item_conversions` for variety routes so the parent variety pack's per-day demand propagates to each child's cards correctly. Existing variety helpers (H.x3.6) cover the math; PT-7B reuses them.

10. **Honest-data invariants stay.** PT-7's vocabulary cannot use "production loss" for receipt variance or "supplier shortage" for cycle-count variance. The existing banned-phrase scan (qc-review-language.test.ts) gets PT-7's source files added in PT-7B.

---

## 12. Definition of done (subsystem-wide)

When PT-7F closes, all of the following must be true:

- A daily projector run produces a `read_material_recommendations` row for every material that triggers one of §5's rules, never for materials that don't.
- Every recommendation has at least one `supporting_signals` entry (or `MISSING_CONFIG`); never empty.
- `confidence != MISSING` recommendations carry a non-null `recommended_order_quantity`.
- `/material-alerts` shows the recommendations sorted by severity, with the signals accordion.
- An admin can acknowledge a recommendation; the row records `acknowledged_at`.
- PT-7E, when wired, sends an idempotent payload to PackTrack's recommendations inbox; PackTrack creates the PO under its existing workflow; the eventual receipt closes the loop via PT-1.
- Banned-phrase scan extended to PT-7 source files and passes.
- All tests pass; staging deploy clean; auth-smoke unaffected.

---

*End of PT-7A plan. Next phase: PT-7B (pure shortage calculation helpers + tests).*
