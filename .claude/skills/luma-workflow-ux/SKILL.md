---
name: luma-workflow-ux
description: Make Luma operator workflows simple. Use floor language, not schema language. Operators should not bounce through Batches / QR Cards / Finished Lots to do one task.
---

# Luma workflow UX

## When this skill applies

Use when adding or editing any admin page, server action, sidebar
entry, or operator-facing label. Read this before writing JSX or copy.

## Operators don't think in tables

The sidebar and copy must use floor language. DB-table names belong
in advanced pages, not on the main paths.

| Use | Avoid |
|-----|-------|
| Receive raw pills | Inventory bags |
| Receive packaging / materials | Packaging lots |
| Start production | Workflow bags |
| Live floor | Workflow events |
| Packaging / pack-out | Packaging output |
| Lookup receipt / batch | Recall lookup |
| QC review | QC events |

## Preferred operator workflows (the seven jobs)

1. **Receive raw pills** — `/receiving/raw-bags`.
2. **Receive packaging / materials** — `/inbound/packaging-materials`.
3. **Start production** — `/production/start` (not `/qr-cards`).
4. **Move bag through stations** — floor PWA + `/floor-board`.
5. **Packaging / pack-out** — `/packaging-output`.
6. **QC review** — `/qc-review`.
7. **Lookup receipt / batch** — `/recall`.

Sidebar groups: Floor work · Management · Configuration · Advanced.
`Advanced` collapsed by default, holds DB-style routes (Batches,
QR cards, Finished lots, Material reconciliation, Bag genealogy).

## Receiving-flow contract

- Raw pill receiving starts from PO / vendor / order context when
  available. Manual PO reference is allowed; label it honestly.
- PO selection shows all PO lines **as cards** with product name,
  SKU, ordered qty, vendor, verification state. Not a dropdown.
- Filter input appears when a PO has more than six lines.
- Receipt number and QR travel **with the raw bag**, not the box.
- One task should not bounce operators through Batches, QR cards,
  Finished lots, Recall, and Genealogy. If it does, the design is
  wrong.

## Distinct labels — never confuse these

- Receipt number ≠ finished lot trace code.
- Raw bag QR (`BAG-uuid`, sticky on the bag) ≠ Reusable workflow
  QR card (floor badge, IDLE/ASSIGNED/RETIRED).
- Manual PO reference ≠ Verified local PO.
- Count-based packaging (bottles, caps, labels, displays, cases)
  ≠ Roll material (PVC / foil).
- Suggested allocation ≠ Confirmed by operator.

## What goes under Advanced

DB-table-style routes that operators rarely need on the main path:
`/qr-cards` (QR card management), `/batches`, `/finished-lots`,
`/material-reconciliation`, `/genealogy`, `/roll-variance`,
`/active-rolls`, `/po-reconciliation`, `/metrics`,
`/packaging-receipts`. Keep them reachable, not primary.
