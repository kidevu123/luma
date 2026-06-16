# Overs / extras resolution — design report

**Status:** design only. Code TBD pending review of this report.

**Scope guard:** Phase D.5 already detects overs and parks the row
in `NEEDS_REVIEW` with code `OVER_RECEIVE_EXCEEDS_PO_REMAINING`.
This design adds the **resolution** workflow on top of that detection.
It does NOT implement live overs-PO creation (that depends on Zoho
gateway endpoints not yet built); it adds the operator decisions and
the audit trail those decisions produce, with explicit hooks for the
future split-to-overs-PO flow.

---

## 1. Problem statement

Zoho purchase orders have a fixed line quantity. Receiving a quantity
that exceeds the PO line's remaining-to-receive triggers a structured
blocker (`OVER_RECEIVE_EXCEEDS_PO_REMAINING`). The current v1.1.0
behaviour:

- Detect → status `NEEDS_REVIEW` with the blocker in
  `mapping_blockers`.
- UI surfaces the explicit decision copy.
- Manual commit-now button hidden; cron skips.
- No retry budget burn.

What's missing today: a structured way for the operator to act on the
parked row. Today they can only `Void` (terminal) or wait. The five
actions the spec calls out — adjust down, hold for PO update, mark
for overs PO, void/reconcile, future split — are not yet exposed.

---

## 2. State machine

The existing v1.1.0 state machine on `zoho_raw_bag_receives`:

```
PENDING ──► PREVIEWED ──► (claim) ──► COMMITTING ──► COMMITTED
                                            │
                                            ├──► NEEDS_MAPPING (4xx + product gap)
                                            ├──► NEEDS_REVIEW  (4xx + receiving exception)
                                            ├──► FAILED         (4xx + no structured blockers)
                                            └──► PENDING        (5xx / transport)
PENDING / PREVIEWED ──(operator hold)──► HELD
PENDING / PREVIEWED ──(operator void)──► VOIDED
```

This design adds transitions OUT of `NEEDS_REVIEW`:

```
NEEDS_REVIEW ──(adjust_down)────► PENDING   (with new payload + new idempotency key + fresh buffer)
NEEDS_REVIEW ──(hold_for_po)────► HELD      (with structured held_reason)
NEEDS_REVIEW ──(needs_overs_po)─► NEEDS_REVIEW (parked; tagged with overs_decision='needs_overs_po')
NEEDS_REVIEW ──(reconcile_void)─► VOIDED    (with void_reason='reconciled_manually')
NEEDS_REVIEW ──(split)──────────► (FUTURE — splits row into 2 children, deferred)
```

Important: `needs_overs_po` is a **self-loop**. The row stays in
`NEEDS_REVIEW` but acquires a structured `overs_decision` tag that
surfaces it in a separate "awaiting overs PO" sub-queue. Once the
split workflow ships, the operator clicks "Split now" on that
tagged row.

### Invariants

- Adjust-down is the only resolution that re-arms the row for
  commit. All other resolutions either park (HELD / NEEDS_REVIEW
  with tag) or terminate (VOIDED).
- The cron must not auto-commit `NEEDS_REVIEW` rows regardless of
  the `overs_decision` value. This is already enforced by the
  loader's `RAW_BAG_COMMITTABLE_STATUSES` set; we don't change it.
- Manual commit-now must not be enabled on `NEEDS_REVIEW` rows.
  Already enforced by the staging-buttons component.
- `adjust_down` MUST mint a fresh `commit_idempotency_key`. Same key
  + different payload at the gateway would either replay the old
  result (silent acceptance of old qty) or 409. Either is wrong;
  fresh key is correct.

---

## 3. DB changes (migration 0065)

Additive only, on `zoho_raw_bag_receives`:

| Column | Type | Default | Why |
|---|---|---|---|
| `overs_decision` | `text` | `NULL` | One of: `'adjust_down'`, `'hold_for_po_update'`, `'needs_overs_po'`, `'reconciled_manually'`. NULL when no decision is needed. |
| `overs_decision_at` | `timestamptz` | `NULL` | When the operator chose. Mirrors `held_at` / `voided_at` shape. |
| `overs_decision_by_user_id` | `uuid` | `NULL` | Audit; references `users.id` with `ON DELETE SET NULL`. |
| `overs_decision_note` | `text` | `NULL` | Free-text operator reasoning. ≤ 1000 chars. |
| `adjusted_received_quantity` | `integer` | `NULL` | Set only when `overs_decision = 'adjust_down'`. The new lower quantity going to Zoho. The bag-side `inventory_bags.declared_pill_count` stays at its true value (preserves the "vendor sent X" truth). |
| `parent_op_id` | `uuid` | `NULL` | Reserved for the future split workflow. NULL today. References `zoho_raw_bag_receives.id` (self-FK, `ON DELETE SET NULL`). Adding the column now so a v1.3.0 split migration is purely data, not schema. |

Index:

```sql
CREATE INDEX IF NOT EXISTS zoho_raw_bag_receives_overs_decision_idx
  ON zoho_raw_bag_receives (overs_decision)
  WHERE overs_decision IS NOT NULL;
```

so the "Awaiting overs PO" widget can list rows in O(log n).

**No enum changes.** All four `overs_decision` values are stored as
text. If we ever need stricter validation, we can add a CHECK
constraint later.

**No changes to `zoho_production_output_ops`.** Overs are receive-side
only.

---

## 4. UI

### 4.1 Resolve-overs panel

On `/partial-bags/[id]/zoho-receive`, when the staged op is in
`NEEDS_REVIEW` AND `mapping_blockers` contains
`OVER_RECEIVE_EXCEEDS_PO_REMAINING`, the existing
"Business decision required" alert grows a **`Resolve overs`** call-
to-action button. Clicking it opens an inline panel (or a small
modal — pick whichever matches the existing design system; we'll use
an inline expansion to avoid extra modal infrastructure).

Panel layout:

```
┌─ Resolve overs ──────────────────────────────────────────────┐
│ This receive exceeds the remaining PO line quantity by N      │
│ tablets. Pick how this should be handled.                     │
│                                                                │
│ ⦿ Adjust down to remaining                                    │
│   Send a smaller receive to Zoho. The bag will still show     │
│   its true intake count; the difference (N tablets) will not  │
│   be billed against this PO.                                  │
│   [ New receive qty: ___________ ] (defaults to remaining)    │
│   [ Reason (required, ≤ 500 chars): _____________________ ]   │
│                                                                │
│ ○ Hold until PO is updated                                    │
│   Park this receive. Procurement bumps PO #N in Zoho, then    │
│   you unhold to re-attempt.                                   │
│   [ Reason (required, ≤ 500 chars): _____________________ ]   │
│                                                                │
│ ○ Mark for overs PO                                            │
│   Tag this receive for a future overs-PO. It stays parked     │
│   and shows up in the "Awaiting overs PO" queue.              │
│   [ Note (optional, ≤ 500 chars): ______________________ ]    │
│                                                                │
│ ○ Reconcile manually (terminal void)                          │
│   You're handling this outside Luma. Mark voided with a       │
│   reason that says where it was resolved.                     │
│   [ Reason (required, ≤ 500 chars): _____________________ ]   │
│                                                                │
│ [ Cancel ]  [ Apply decision ]                                │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 Buttons that change

| State | Buttons visible (before this PR) | Buttons after this PR |
|---|---|---|
| `PENDING` / `PREVIEWED` (normal) | Push, Hold, Void | (unchanged) |
| `NEEDS_REVIEW` + `OVER_RECEIVE` | Hold, Void | Hold, Void, **`Resolve overs`** |
| `NEEDS_REVIEW` + other code | Hold, Void | (unchanged) |
| `NEEDS_MAPPING` | Hold, Void | (unchanged) |
| `HELD` (any reason) | Unhold, Void | (unchanged) — the held_reason text shows the prior overs decision if applicable |

### 4.3 New "Awaiting overs PO" queue (small widget)

On `/zoho-production-operations` (or a new top-level
`/zoho-overs-queue` — pick whichever matches your nav; recommendation
is to add it as a small widget on the production-operations page so
operators don't need to know about another route):

```
Awaiting overs PO (N)
┌────────────────────────────────────────────────────────┐
│ Receive #PO-00244-R1, bag 1, BlueRaz, 408 over          │
│ Tagged 2026-06-16 by lead@luma                         │
│ Note: "ask procurement to make PR-OVERS-001"           │
│ [Open] [Cancel tag (back to NEEDS_REVIEW review state)]│
└────────────────────────────────────────────────────────┘
```

`Cancel tag` clears `overs_decision` only (back to plain
`NEEDS_REVIEW`), in case the operator made the wrong call.

### 4.4 Bag-edit conflict

If an operator edits the bag (qty, supplier lot, etc.) while a
resolved overs decision is in flight, the existing edit-handler
already calls `regenerateFrozenRawBagReceivePayload` (Phase E). That
fn currently clears `mapping_blockers` and `commit_error`. We extend
it to ALSO clear `overs_decision` / `adjusted_received_quantity` /
`overs_decision_*` columns, so the new payload starts a fresh review.
The cleared decision is preserved in the audit row written by the
freeze; nothing is lost.

---

## 5. Operator copy (canonical strings)

### Top of the panel

> "This receive exceeds the remaining PO line quantity by **N**
> tablets. Pick how this should be handled. Until you decide, the
> receive stays parked — it will not auto-commit and the "Push to
> Zoho now" button is disabled."

### Per-option microcopy

**Adjust down to remaining**

> "Send a smaller receive to Zoho. The bag's intake count stays at
> the vendor-shipped quantity (so reports still show the truth); we
> just send the lower number to Zoho. The difference will need to be
> reconciled elsewhere — typically a future overs PO or a manual
> adjustment in Zoho. Use this when the vendor over-shipped and
> Procurement decides we won't pay for the extra."

**Hold until PO is updated**

> "Park this receive while Procurement bumps PO #N in Zoho. When the
> PO is updated and you're ready to retry, click **Unhold** — the
> receive returns to the queue with a fresh 24h review buffer. Use
> this when the over-receive is legitimate and the PO needs to grow
> to match."

**Mark for overs PO**

> "Tag this receive for a future overs-PO. The row stays parked
> here, but it also appears in the **"Awaiting overs PO"** queue so
> Procurement can see what's pending. When the new overs PO exists,
> a future Luma release will let you split this receive between the
> original PO and the overs PO."

**Reconcile manually (terminal void)**

> "Mark this receive **VOIDED** because you're handling the
> overage outside Luma — directly in Zoho, on paper, or via a
> different process. This is terminal: you can't undo it from here.
> Use the reason field to record where you actually reconciled."

### Audit-log strings

- `zoho_raw_bag_receive.overs_decision.adjust_down`
- `zoho_raw_bag_receive.overs_decision.hold_for_po_update`
- `zoho_raw_bag_receive.overs_decision.needs_overs_po`
- `zoho_raw_bag_receive.overs_decision.reconciled_manually`
- `zoho_raw_bag_receive.overs_decision.cleared` (for "cancel tag")

---

## 6. Server actions

In
`app/(admin)/partial-bags/[inventoryBagId]/zoho-receive/staging-actions.ts`:

```ts
type OversDecision =
  | { kind: "adjust_down"; newQuantity: number; reason: string }
  | { kind: "hold_for_po_update"; reason: string }
  | { kind: "needs_overs_po"; note?: string }
  | { kind: "reconciled_manually"; reason: string };

export async function resolveOversBlockerAction(
  opId: string,
  decision: OversDecision,
): Promise<RawBagStagingActionResult>;

export async function clearOversDecisionAction(
  opId: string,
): Promise<RawBagStagingActionResult>;
```

Each branch:

| Branch | Validation | Mutations |
|---|---|---|
| `adjust_down` | newQuantity int, 1 ≤ newQuantity < zoho_received_quantity; reason non-empty ≤ 500 | regenerate frozen payload with `adjusted_received_quantity`; set `commit_request_payload.received_quantity = newQuantity`; mint fresh `commit_idempotency_key`; reset `auto_commit_eligible_at` to env-derived value; clear `mapping_blockers` / `commit_error`; transition status `NEEDS_REVIEW → PENDING`; write structured audit. The bag's `inventory_bags.declared_pill_count` is **NOT** touched. |
| `hold_for_po_update` | reason non-empty ≤ 500 | status `NEEDS_REVIEW → HELD`; `held_at = now()`; `held_reason = "Awaiting PO update — " || reason`; `auto_commit_eligible_at = NULL`; `overs_decision = 'hold_for_po_update'`; `overs_decision_note = reason`; write audit. Unhold reverts to PENDING per the existing unhold flow and ALSO clears `overs_decision`. |
| `needs_overs_po` | note optional ≤ 500 | status stays `NEEDS_REVIEW`; `overs_decision = 'needs_overs_po'`; `overs_decision_note = note ?? null`; write audit. Row appears in the "Awaiting overs PO" widget. |
| `reconciled_manually` | reason non-empty ≤ 500 | status `NEEDS_REVIEW → VOIDED`; `voided_at = now()`; `void_reason = "Reconciled manually — " || reason`; `overs_decision = 'reconciled_manually'`; write audit. Terminal. |

`clearOversDecisionAction` (cancel-tag for `needs_overs_po`): clears
the four `overs_decision_*` columns. Status stays `NEEDS_REVIEW`. Used
when an operator changed their mind before any overs PO is created.

### Idempotency key derivation for `adjust_down`

```ts
buildRawBagCommitIdempotencyKey({
  opId,
  zohoPoId,
  zohoLineItemId,
  receivedQuantity: newQuantity,   // ← was 4408, now 4000 → different key
  receiveDate,
});
```

Because `receivedQuantity` is in the key inputs, changing it produces
a fresh key automatically — no special-case code needed.

---

## 7. Tests

### Pure-function tests (no DB)

1. **`resolveOversBlockerAction` payload-shape validator** (Zod or
   manual): reject empty reason, oversize note, non-positive
   newQuantity, newQuantity ≥ current qty, missing kind.
2. **`buildRawBagCommitIdempotencyKey` with new quantity** produces a
   different key than with the old quantity (already covered by Phase
   D's idempotency tests, but assert again in the overs context to
   pin the contract).
3. **Audit-action vocabulary** test: pin the five canonical action
   strings so the audit-log readers don't drift.

### State-machine tests

4. `adjust_down` transitions `NEEDS_REVIEW → PENDING` and clears
   `mapping_blockers` + `commit_error`.
5. `hold_for_po_update` transitions `NEEDS_REVIEW → HELD` and writes
   structured `held_reason` AND `overs_decision='hold_for_po_update'`.
6. `needs_overs_po` does NOT transition status; sets
   `overs_decision='needs_overs_po'`.
7. `reconciled_manually` transitions `NEEDS_REVIEW → VOIDED` with a
   `void_reason` that includes the canonical prefix.
8. `clearOversDecisionAction` clears all four `overs_decision_*`
   columns without changing status.

### Source-pin tests (the pattern Phase F/H used)

9. The resolve-overs panel renders only when status is
   `NEEDS_REVIEW` AND `OVER_RECEIVE_EXCEEDS_PO_REMAINING` is in
   `mapping_blockers`.
10. The panel does NOT render for generic NEEDS_REVIEW with a
    different code.
11. The "Awaiting overs PO" widget queries rows with
    `overs_decision = 'needs_overs_po'`.
12. The cron loader's `RAW_BAG_COMMITTABLE_STATUSES` set is
    unchanged (sanity — no accidental NEEDS_REVIEW inclusion).
13. Manual commit-now action refuses NEEDS_REVIEW regardless of
    `overs_decision` value.

### Integration tests (where the existing patterns allow)

14. `regenerateFrozenRawBagReceivePayload` clears
    `overs_decision_*` columns on edit (so the operator's
    decision doesn't leak into a freshly-edited payload).
15. The audit row written by each action has the canonical action
    string from #3.

### Negative tests

16. `adjust_down` with `newQuantity = current_qty` is rejected (no
    actual adjustment).
17. `adjust_down` with `newQuantity = 0` is rejected.
18. Calling `resolveOversBlockerAction` on a row that is NOT in
    `NEEDS_REVIEW` is rejected with a state-blocked error (defence
    in depth).

---

## 8. In scope NOW vs deferred

### In scope (target: v1.2.0)

- Migration 0065 (additive columns + index)
- Schema mirror in `lib/db/schema.ts`
- `resolveOversBlockerAction` + `clearOversDecisionAction` server
  actions
- "Resolve overs" UI panel + canonical operator copy
- "Awaiting overs PO" widget (lightweight; on the production-ops
  page)
- All 5 audit-action strings + writeAudit calls
- The 13–18 tests listed above
- Documentation: this file + a runbook update telling operators
  what each decision does and what happens next

### Deferred (target: v1.3.0+)

- **Split workflow.** Creates two child `zoho_raw_bag_receives`
  rows: one with the original PO's remaining quantity, one with the
  overs quantity targeted at a (yet-to-be-created) overs PO. The
  current `parent_op_id` column is the join point.
- **Overs-PO creation on the Luma side.** Either a "Create overs PO"
  button that calls a Zoho gateway POST (when that endpoint exists),
  or a one-shot script that procurement runs against Zoho directly.
- **Live "remaining qty on PO line"** from Zoho. Today the operator
  has to know the remaining quantity from outside Luma (e.g. the
  blocker message gives the over-by amount, or they check Zoho).
  Future: the gateway's `/zoho/cached/po/<id>/lines` endpoint
  (planned alongside the warehouse cache) lets Luma show the
  remaining-qty inline.
- **Auto-adjust when the PO is updated.** Currently `hold_for_po_update`
  stays HELD forever unless the operator manually unholds. A future
  job could compare cached PO remaining qty to the held row's qty
  and emit a notification / auto-unhold when the PO grew enough.

### Out of scope forever

- Negotiating prices / accepting partial credits / writing off the
  difference. That stays in Zoho / accounting.
- Modifying `inventory_bags.declared_pill_count` to "match" the
  adjusted-down qty. The bag-level truth stays — the discrepancy
  lives in the staged-op layer, not on the bag.

---

## 9. Operational considerations

- **Auditability.** Every transition writes an audit row with the
  canonical action string. Audit-log readers don't need to parse
  free-text reasons to figure out what kind of decision was made.
- **Reversibility.** `adjust_down`, `hold_for_po_update`, and
  `needs_overs_po` are reversible (the operator can void or change
  their mind). `reconciled_manually` is terminal.
- **Data integrity.** The bag-side `inventory_bags.declared_pill_count`
  is the single source of truth for "what the vendor shipped." The
  staged-op layer is the source of truth for "what we tell Zoho." If
  those diverge, the operator's audit trail explains why.
- **First deploy.** Like v1.1.0, this PR can ship with live writes
  still OFF. The resolve-overs UI works regardless of write gates
  (the resolution actions are DB-only — `adjust_down` regenerates
  the staged payload but the commit still has to wait for env gates
  to flip).

---

## 10. Open questions for review

1. **Adjust-down quantity input — UX choice.** Should the panel
   default the input to "remaining PO qty" (requires knowing
   remaining) or leave blank? My recommendation: leave blank but
   include the over-by amount in the alert so the operator can do
   the subtraction. Switch to defaulting once the cached-PO endpoint
   lands.
2. **"Awaiting overs PO" widget placement.** Inline on
   `/zoho-production-operations` (recommended), or its own route
   `/zoho-overs-queue`? Recommendation: inline widget. Cheap to ship,
   easy to remove.
3. **Should `clearOversDecisionAction` require a reason?** Right now
   I have it as a no-reason action because clearing a tag is low-
   risk. Operator UX preference?
4. **Should `hold_for_po_update` ALSO carry a structured
   `overs_decision` tag?** I currently propose yes (so we can
   distinguish "operator paused because over-receive" from "operator
   paused for other reasons"). Worth confirming.

---

## 11. Effort estimate

| Phase | Effort |
|---|---|
| Migration 0065 + schema mirror | 30 min |
| Server actions + validators | 1.5 h |
| UI panel + widget + copy | 2 h |
| Tests (13–18) | 1 h |
| Docs | 30 min |
| **Total v1.2.0 shippable scope** | **~5.5 h** |

---

**End of design report. No code written. Awaiting review.**
