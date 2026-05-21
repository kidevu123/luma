---
name: luma-data-honesty
description: Prevent misleading UI and data claims. Never imply missing = zero, suggested = confirmed, manual PO = verified, damage = scrap, etc. Use the canonical label vocabulary.
---

# Luma data honesty

## When this skill applies

Any UI copy, label, audit message, error message, response body, or
log line. This is non-negotiable across the whole codebase.

## Never imply

| Wrong | Right |
|-------|-------|
| missing = zero | "Missing" / "(no record)" |
| suggested = confirmed | "Suggested" vs "Confirmed by operator" |
| manual PO = verified PO | "Manual PO reference" vs "Verified local PO" / "Verified Zoho" |
| estimated = actual | "Estimated" vs "Actual" |
| receipt number = finished lot trace code | Receipt # is `RB-...`; trace code is `FL-...`. Distinct. |
| raw bag QR = workflow QR card | Raw bag QR (`BAG-uuid`, sticky on bag) ≠ workflow QR card (reusable floor badge) |
| damage = scrap | "Damage reported" → "Sent to rework" → "Scrap recorded". Three separate events. |
| rework sent = rework received | Two separate events with their own accountability. |
| receipt variance = production loss | Receipt variance is supplier / receiving; production loss is workflow events. |
| cycle-count variance = supplier shortage | Variance has multiple causes; never assume supplier. |
| LOW / MEDIUM confidence = confirmed | Confidence stays as-is; CONFIRMED is a separate explicit operator action. |

## Canonical label vocabulary

When labelling data quality / state, use exactly these strings:

| Label | Meaning |
|-------|---------|
| `Actual` | Recorded by a person or device at the time |
| `Estimated` | Derived from a model or rule, not measured |
| `Supplier-declared` | What the vendor put on the documents — not verified by Luma |
| `Physically counted` | An operator counted the items in front of them |
| `Manual reference` | Operator typed a value with no upstream verification |
| `Verified local PO` | Matched to a Luma `purchase_orders` row |
| `Verified Zoho` | Matched against a Zoho invoice / PO in cached data |
| `Missing` | Field was expected but not present — never silently coerced to zero or empty |
| `Legacy` | Imported from the pre-Luma system; treat carefully |
| `Suggested` | Engine-generated, awaiting operator confirmation |
| `Confirmed by operator` | Operator pressed Confirm; status=CONFIRMED, confidence=HIGH |
| `CSR/internal only` | This field is hidden from customer-scope responses |
| `Customer hidden` | Same idea, from the customer's perspective |

## Empty state copy

When a list is empty, say so honestly:

- `"No confirmed allocations exist for this invoice yet."` (not
  `"All clear"`)
- `"No Zoho invoice lines available yet. Invoice rows arrive via
  the apply phase of COMMERCIAL-TRACE-3."`
- `"No usable finished-lot candidates found for this invoice line."`
- `"No active count-based materials. Add one at /settings/materials,
  or toggle QA visibility above."`

Never empty-state with `"Coming soon"`, `"Under construction"`, or
similar placeholder copy. State the actual data condition.

## Numeric formatting

- Currency is integer cents in storage. Display only via the
  canonical formatter.
- Quantities preserve unit; never strip the unit silently.
- Dates render with timezone-aware helpers; never via raw `toString()`.
- Numeric ranges in copy: `±7d` not `7d`, `> 60d` not `60+ days`.

## Confidence + status vocabulary

Allocation rows use exactly:

- `confidence ∈ {HIGH, MEDIUM, LOW, MISSING}`
- `status ∈ {SUGGESTED, NEEDS_REVIEW, CONFIRMED, REJECTED}`
- `confirmed ∈ {true, false}` (true only after explicit operator action)

Never invent new values; never coerce LOW/MEDIUM to HIGH in
display; never coerce SUGGESTED to CONFIRMED.

## Audit messages

Audit row `action` field uses snake_case domain phrases:

- `invoice_allocation.generate`, `invoice_allocation.regenerate`,
  `invoice_allocation.confirm`, `invoice_allocation.reject`,
  `invoice_allocation.clear_unconfirmed`
- `production.start_from_admin`
- `zoho.invoice.dry_run`

Audit `after` jsonb carries the actual state change (counts,
statuses, IDs) — not narration.
