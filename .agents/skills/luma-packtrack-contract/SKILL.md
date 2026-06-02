---
name: luma-packtrack-contract
description: Keep PackTrack and Luma responsibilities clean. PackTrack owns packaging POs and packaging receiving. Luma owns production usage, reconciliation, and reorder recommendations.
---

# Luma ↔ PackTrack contract

## When this skill applies

Any time you touch `lib/integrations/packtrack/*`,
`/inbound/packaging-materials`, packaging lots, material alerts, or
the shortage-recommendation pipeline.

## Responsibility split

| System | Owns |
|--------|------|
| **PackTrack** | Packaging PO workflow, vendor relationships, packaging receiving at the dock, packaging item master |
| **Luma** | Production usage tracking, packaging consumption events, packaging reconciliation, shortage recommendation logic, material alerts |

## Data flow (one direction)

```
PackTrack receipt
  → POST /api/integrations/packtrack/receipts (webhook)
    → packaging_lots row (Luma)
    → material_inventory_events row (Luma)

Luma shortage recommendation
  → outbound to PackTrack (PT-7E flow)
    → read_material_recommendations row stays in Luma
    → PackTrack acknowledges; Luma updates ack/dismiss state
```

## Hard rules

- **PackTrack does not receive raw pills.** Tablet bags come from
  vendors via Luma's `/receiving/raw-bags` flow. PackTrack is
  packaging-only.
- **Luma does not silently create packaging POs.** If a shortage
  recommendation needs a PO, it's surfaced for an operator (or
  PackTrack) to act on. Luma never POSTs `purchase_orders/create`
  to Zoho directly.
- **Receipt variance ≠ production loss.** A packaging receipt that
  short-shipped is a PackTrack / vendor issue. Production loss is
  measured at the workflow event layer. Mixing them is a data-honesty
  violation.
- **Cycle-count variance ≠ supplier shortage.** If a cycle count
  comes up short, the cause could be miscount, theft, undocumented
  consumption, or supplier short-ship. Call it `variance`, not
  `shortage`, until reconciled.

## Receipt model

- `packaging_lots` rows carry `source_system` enum: `PACKTRACK`
  (from the webhook), `MANUAL_LUMA` (operator-entered on the
  packaging-materials receiving page), `IMPORT` (legacy historical).
- UI must call these out as "PackTrack-origin receipt" vs "Manual
  material receipt" — never just "receipt".
- Roll materials (PVC, foil) have their own field set on the
  receiving page; count-based packaging (bottles, caps, labels,
  displays, cases) has another. The two tabs are not interchangeable.

## Shortage recommendation contract

- `read_material_recommendations` is the canonical Luma-side table.
- Confidence: HIGH (proven usage trend) / MEDIUM (extrapolated) /
  LOW (single data point) / MISSING (no usage data yet).
- Severity: CRITICAL / WARN / INFO based on days-of-cover threshold.
- Outbound to PackTrack is read-only from PackTrack's side — Luma
  surfaces recommendations; PackTrack decides whether to create the
  PO.
- Ack / dismiss state lives in Luma; the recommendation row stays for
  the audit trail.

## What NOT to build in Luma

- A packaging-PO creation UI (PackTrack owns it).
- A vendor-management UI for packaging vendors (PackTrack owns it).
- A direct push to PackTrack that creates POs without PackTrack
  acknowledging — outbound is recommend-only.

## What NOT to build in PackTrack-facing code

- A raw-pill receiving flow.
- A production-usage feed (Luma owns it).
- A QC review interface.
