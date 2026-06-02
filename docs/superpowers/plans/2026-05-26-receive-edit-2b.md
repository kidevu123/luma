# RECEIVE-EDIT-2B — Receive-level edit & status audit plan

**Status:** Audit / design only (no implementation in this doc)  
**Base:** `origin/main` @ `b057ff2` (v0.3.7) as of 2026-05-27  
**Prior work:** RECEIVE-EDIT-2A-1 (per-bag edit + history), AUDIT-LOG-1 (global viewer)

---

## A. Current model summary

### Entity hierarchy

```
purchase_orders → receives → small_boxes → inventory_bags
                      ↓
                 shipments (optional)
                      ↓
              batches (TABLET) linked per bag via batch_id
```

### `receives` (DB + UI)

| Field | Editable today? | UI |
|-------|-----------------|-----|
| `receive_name` | No (set at intake, unique) | Title on `/inbound/[id]` |
| `received_at` | No | Summary sidebar |
| `received_by_id` | No | — |
| `closed_at` | No | Open/Closed pill (derived) |
| `notes` | No | Read-only card when non-empty |
| `po_id` | No | Description line (PO + vendor) |
| `po_line_id` | No | — |
| `shipment_id` | No | Shipment card (read-only) |

There is **no** `editReceive`, `receive.edit` audit action, or `/inbound/[id]/edit` route.

### `inventory_bags` (DB + UI)

| Field | Intake | Bag edit (`/inbound/.../bag/.../edit`) |
|-------|--------|----------------------------------------|
| `weight_grams` | Yes | Yes (blocked if `workflow_bags` link exists) |
| `notes` | Yes | Yes (always) |
| `internal_receipt_number` | Yes | Yes (+ edit reason; not in production) |
| `bag_qr_code` | Yes | Yes (+ QR reserve/release audit side effects) |
| `batch_id` (supplier lot) | Yes | Via `supplierLotNumber` (+ may create `batches` QUARANTINE) |
| `declared_pill_count` | Set from intake `pillCountPerBag` | **Display only** on receive detail |
| `pill_count` | Same as declared at intake | **Not editable** |
| `status` | `AVAILABLE` at intake | **Display only**; not in `BagEditInput` / patch |
| `vendor_barcode` | Optional at intake | Not on edit form |
| `tablet_type_id` | Per box default | Not editable post-save |

### `batches` (tablet supplier lot — **not** bag status)

- Table: `batches.status` enum: `QUARANTINE` | `RELEASED` | `ON_HOLD` | `RECALLED` | `EXPIRED` | `DEPLETED`
- **Default at receive intake:** new tablet batches created as **`QUARANTINE`** (`lib/db/queries/receives.ts`).
- **Release workflow exists:** `/batches` → `setBatchStatus` → `batch.status_released` audit (`lib/db/queries/batches.ts`, `app/(admin)/batches/status-actions.tsx`). QUARANTINE → RELEASED is a first-class admin action (requires lead).
- Receive detail links to Batches with copy: “Release in the Batches tab once QA signs off.”

### `inventory_bags.status` (bag lifecycle — separate from batch QUARANTINE)

Enum: `AVAILABLE` | `IN_USE` | `EMPTIED` | `QUARANTINED` | `VOID`

| Status | Typical meaning | Set by |
|--------|-----------------|--------|
| `AVAILABLE` | Ready for floor allocation / start | Receive intake; bag-allocation close (partial balance) |
| `IN_USE` | Open allocation session | `bag-allocation-actions` |
| `EMPTIED` | Fully consumed | Allocation close when balance = 0 |
| `QUARANTINED` | Bag held out of picking | Legacy import / manual paths (rare in UI) |
| `VOID` | Voided | Rare |

**Do not confuse** batch `QUARANTINE` with bag `QUARANTINED`.

### Production gates (read paths only for this plan)

1. **Start production** (`production/start`, floor scan): bag must be `AVAILABLE`; QR must be intake-reserved or valid.
2. **Vendor barcode verify** (floor): bag `AVAILABLE` + linked batch **`RELEASED`** or verify is `blocked`.
3. **Bag allocation** (floor): rejects `VOID` / `QUARANTINED` bags.
4. **Bag edit** (`lib/db/queries/bag-edits.ts`): if `workflow_bags.inventory_bag_id` exists → **only notes** editable.

Schema rule (locked): production must not consume a batch that is not `RELEASED` (`lib/db/schema.ts` header).

### Audit log today (receive-related writes)

| Action | Target | When |
|--------|--------|------|
| `batch.create` | Batch | Intake + bag edit (new lot) |
| `inventory_bag.edit` | InventoryBag | Bag edit |
| `qr_card.released_at_bag_edit` | QrCard | Bag edit (QR swap) |
| `qr_card.reserved_at_bag_edit` | QrCard | Bag edit (QR swap) |
| `batch.status_*` | Batch | Batches admin status changes |
| `batch.hold_open` / `batch.hold_close` | Batch | Holds |

No `receive.edit` or `inventory_bag.status_*` actions exist.

---

## B. What is safe to edit now (recommended v1 scope)

### RECEIVE-EDIT-2B-1 — Receive metadata (smallest receive-level slice)

| Field | Safe? | Rationale |
|-------|-------|-----------|
| `receives.notes` | **Yes** | No production coupling; clerical correction |
| `receives.closed_at` | **Yes with care** | Operational “receive closed” flag; does not move inventory; allow set/clear with audit + lead role |

**Not in 2B-1:** `receive_name`, `po_id`, `po_line_id`, `shipment_id`, `received_at` (traceability / PO variance).

### RECEIVE-EDIT-2B-2 — Declared pill count (bag-level, not receive-level)

| Field | Safe? | Rationale |
|-------|-------|-----------|
| `declared_pill_count` | **Yes when not in production** | Immutable intake declaration correction; mirror weight rules |
| `pill_count` | **Optional sync** | Schema says `pill_count` is live working count — if still `AVAILABLE` and never allocated, syncing declared → pill_count avoids UI drift |

**UI:** Add to existing bag edit form; require edit reason if changing declared count by more than a threshold (or always).

### Explicitly safe today (already shipped — 2A)

Bag weight, notes, receipt #, QR token, supplier lot (batch link) — see `bag-edits.ts`.

---

## C. What should be deferred

| Item | Why defer |
|------|-----------|
| **Bag `status` post-save edit** | High risk: gates start production, allocation, partial-bag lists; no audit vocabulary; easy to create “AVAILABLE bag on UNRELEASED batch” confusion |
| **Receive PO / line reassignment** | PO variance, Zoho, reconciliation — needs product rules |
| **Receive rename (`receive_name`)** | Unique index; breaks printed labels / operator mental model |
| **Shipment edit on receive** | Low frequency; tie to carrier integrations later |
| **Batch release from receive page** | Already on `/batches`; duplicating risks inconsistent COA workflow |
| **Bag `QUARANTINED` / `VOID` toggles** | No documented operator workflow; could hide bags from allocation incorrectly |
| **Tablet type change post-save** | Genealogy + product mapping impact |

---

## D. Recommended smallest next implementation

### Task name: **RECEIVE-EDIT-2B-1 — Receive notes + close flag**

**Scope:**

1. Add `/inbound/[id]/edit` (or inline “Edit receive” on detail) for `notes` + `closed_at` only.
2. New query `lib/db/queries/receive-edits.ts` (mirror `bag-edits.ts` pattern): validate, transaction, `writeAudit`.
3. Audit: `receive.edit`, `targetType: "Receive"`, before/after `{ notes, closedAt }`.
4. Receive detail: link “Edit receive details” when user has lead; show closed state clearly.
5. **Do not** change bags, batches, or PO links.

**Follow-up (2B-2):** `declaredPillCount` on bag edit form + audit snapshot field + summarize in `bag-edit-history` / audit viewer.

---

## E. Files likely to change (2B-1 only)

| File | Change |
|------|--------|
| `lib/db/queries/receive-edits.ts` | **New** — edit + audit |
| `lib/db/queries/receive-edits.test.ts` | **New** — validation |
| `app/(admin)/inbound/[id]/edit/page.tsx` | **New** — form |
| `app/(admin)/inbound/[id]/edit/actions.ts` | **New** — server action |
| `app/(admin)/inbound/[id]/page.tsx` | Link + copy |
| `app/(admin)/inbound/[id]/page.test.ts` | Structural guards |
| `lib/receive/bag-edit-history.ts` or `lib/audit/audit-log-view.ts` | Optional: `receive.edit` label |
| `package.json` / `CHANGELOG.md` | Patch bump |

**Do not touch:** `app/(floor)/**`, `scan-card-form`, `actions.ts` (floor), schema/migrations, Zoho write paths.

---

## F. Tests required

### 2B-1

- Pure: `validateReceiveEdit` — closed_at set/clear, notes length
- Integration (optional): `receive-edits` with test DB if pattern exists (`bag-edits.db.test.ts`)
- Structural: `page.test.ts` — edit link, `requireLead`, audit action string
- Regression: existing bag edit tests unchanged

### 2B-2 (later)

- `declaredPillCount` blocked when `isInProduction`
- Audit summarizes declared count change
- Receive detail column updates after edit

---

## G. Risks / rollback notes

| Risk | Mitigation |
|------|------------|
| Operators confuse **batch QUARANTINE** vs **bag QUARANTINED** | UI copy on receive detail + edit pages; link to `/batches` for release |
| Editing `closed_at` while bags still being received | Lead-only; confirm dialog if bags added after close (future) |
| Declared count edit breaks PO reconciliation | Edit reason required; show declared vs `pill_count` in audit |
| Bag status edit breaks production | **Defer** until state machine + audit + guards designed |
| Accidental floor regression | **Hard boundary:** no `app/(floor)` files in 2B PRs |

**Rollback:** Revert admin-only routes; audit rows remain (acceptable).

---

## H. Boundary — do not touch floor station files

These paths are **out of scope** for RECEIVE-EDIT-2B (Claude active on floor scan):

- `app/(floor)/**`
- `scan-card-form.tsx`, `camera-scanner.tsx`
- Floor `actions.ts` (`lookupCardByTokenAction`, `scanCardAction`, etc.)
- Station start / QR lookup / production scan flow
- Parked branch `cursor/station-3b-scan-flow-parked`

Inbound admin and `lib/db/queries/receive-edits.ts` only.

---

## Answers to audit questions (quick reference)

1. **Receive-level fields:** `receive_name`, `po_id`, `po_line_id`, `shipment_id`, `received_at`, `received_by_id`, `closed_at`, `notes` — see §A.
2. **Safe after save:** `notes`, `closed_at` (2B-1). Bag fields already per 2A.
3. **Do not edit without bigger design:** PO/line/shipment/receive_name/received_at; bag status; batch release from receive.
4. **QUARANTINE:** Owned by **`batches.status`**, not bags. Changed via `/batches` `setBatchStatus`. Release QUARANTINE→RELEASED exists. Blocks production via verify + schema policy (batch must be RELEASED).
5. **AVAILABLE (bags):** Set at intake; restored after partial allocation close; required for start production and allocation picking.
6. **Bag status editable today?** **No** (display only).
7. **Make bag status editable?** **Not safe** without explicit transitions + audit + floor guard audit — defer.
8. **Declared pill count:** **Per bag** (`declared_pill_count`); copy of intake per-bag count; `pill_count` is separate live field.
9. **Audit for new edits:** `receive.edit` / extend `inventory_bag.edit` with `declaredPillCount` in before/after; reuse `writeAudit` + global viewer.
10. **Smallest slice:** **RECEIVE-EDIT-2B-1** (receive notes + `closed_at`).

---

## Merge / deploy recommendation

- **No merge in this task** (audit only).
- When implementing 2B-1: branch from current `main`, isolated PR, no floor files.
- Deploy: app-only, no migrations; verify on staging with lead user at `/inbound/[id]/edit`.
