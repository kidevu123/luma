# Zoho Production Output Mapping Design

Status: design plus Slice A implementation notes. No live Zoho commit/apply behavior.

Slice A note: v0.4.55 implements the preview-snapshot table with only
`DRAFT` and `PREVIEWED` statuses. Future approval/commit statuses below remain
design targets and require separate migrations.

Branch context: `codex/zoho-production-output-preview-form-1-clean` already adds a preview-only finished-lot card that calls `/zoho/luma/production-output/preview`. This document defines the durable mapping model needed before any future live production-output commit can be considered.

## 1. Durable Mapping Needed

Luma needs one durable production-output operation per finished lot and selected Zoho output PO line. The row must freeze the exact Zoho target and the exact Luma quantity basis that was previewed and later approved.

The durable record should answer:

- Which finished lot is being posted?
- Which workflow bag/genealogy snapshot backs it?
- Which Zoho PO and PO line will receive the output?
- Which warehouse and composite item IDs are being used?
- Which quantities were sent for units, displays, cases, damage reported, ripped cards, and loose cards?
- Which preview response was reviewed?
- Which idempotency key will be reused for live commit?
- Who selected, previewed, approved, committed, failed, or voided it?

Do not infer this from raw tablet PO lineage or packaging material PO lines. Production output PO/line selection is explicit and must be reviewed as its own business operation.

## 2. Recommended Persistence Boundary

Store the mapping per finished lot, in a dedicated `zoho_production_output_ops` table.

Do not store this on:

- `products`: product composite IDs already belong there, but PO/line/quantity/genealogy are lot-specific.
- `workflow_bags`: a workflow bag can be missing for manual/legacy lots, and Zoho output happens at finished-lot issue/release time.
- `po_lines`: one PO line can receive multiple finished lots.
- `zoho_assembly_ops`: those rows model older atomic receive/assemble operations; the new Zoho v1.19 contract is a consolidated production-output operation.
- `zoho_pushes`: legacy purchase_receive status table is too thin and lacks preview/approval/mapping snapshots.

## 3. Proposed Table

Suggested additive table:

```sql
CREATE TABLE IF NOT EXISTS zoho_production_output_ops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finished_lot_id uuid NOT NULL REFERENCES finished_lots(id) ON DELETE RESTRICT,
  workflow_bag_id uuid REFERENCES workflow_bags(id) ON DELETE SET NULL,

  status text NOT NULL DEFAULT 'DRAFT',

  zoho_purchaseorder_id text NOT NULL,
  zoho_purchaseorder_line_item_id text NOT NULL,
  zoho_warehouse_id text NOT NULL,
  zoho_unit_composite_item_id text NOT NULL,
  zoho_display_composite_item_id text,
  zoho_case_composite_item_id text,

  quantity_good integer NOT NULL,
  unit_assembly_quantity integer NOT NULL,
  display_assembly_quantity integer NOT NULL DEFAULT 0,
  case_assembly_quantity integer NOT NULL DEFAULT 0,
  quantity_damaged integer,
  quantity_ripped integer,
  quantity_loose integer,
  metrics_state text NOT NULL DEFAULT 'MISSING',
  genealogy_state text NOT NULL DEFAULT 'MISSING',

  receive_date date NOT NULL,
  luma_operation_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  request_payload jsonb NOT NULL,

  preview_http_status integer,
  preview_response jsonb,
  previewed_at timestamptz,
  previewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  approved_at timestamptz,
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  committed_at timestamptz,
  committed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  zoho_reference_id text,
  commit_response jsonb,
  last_error text,

  selected_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS zoho_prod_output_ops_luma_op_unique
  ON zoho_production_output_ops(luma_operation_id);

CREATE UNIQUE INDEX IF NOT EXISTS zoho_prod_output_ops_idem_unique
  ON zoho_production_output_ops(idempotency_key);

CREATE INDEX IF NOT EXISTS zoho_prod_output_ops_lot_idx
  ON zoho_production_output_ops(finished_lot_id);

CREATE INDEX IF NOT EXISTS zoho_prod_output_ops_status_idx
  ON zoho_production_output_ops(status);

CREATE UNIQUE INDEX IF NOT EXISTS zoho_prod_output_ops_active_lot_unique
  ON zoho_production_output_ops(finished_lot_id)
  WHERE status IN ('DRAFT', 'PREVIEWED', 'APPROVED', 'COMMITTING');
```

Recommended CHECK constraints:

- `status IN ('DRAFT','PREVIEWED','APPROVED','COMMITTING','COMMITTED','FAILED','VOIDED')`
- quantities are `>= 0`
- display composite ID required when `display_assembly_quantity > 0`
- case composite ID required when `case_assembly_quantity > 0`
- approved/committed timestamps align with status

Use text status rather than enum for the first slice. This avoids enum migration churn while the workflow is still being tested.

## 4. State Machine

`DRAFT`
: Mapping selected/edited locally, no successful preview yet.

`PREVIEWED`
: Preview endpoint returned a successful preview response and the exact request/response snapshot is stored.

`APPROVED`
: Admin explicitly approves the exact request hash for future live commit. After this, target IDs and quantities are immutable.

`COMMITTING`
: Future worker/action has started live commit. Not part of preview slice.

`COMMITTED`
: Future live commit succeeded; store `zoho_reference_id` and response.

`FAILED`
: Future live commit failed after approval; request fields remain immutable, retry uses the same idempotency key unless PM approves void + new operation.

`VOIDED`
: Human voids a draft/previewed/failed operation. Committed operations should not be voided in Luma unless Zoho rollback semantics are explicitly defined.

## 5. Repeated Previews

Before approval:

- Admin may edit PO, PO line, warehouse, notes, or other mapping inputs.
- Each changed request should update the same active DRAFT/PREVIEWED row for the finished lot, incrementing `updated_at`, replacing `request_hash`, `request_payload`, `idempotency_key`, and preview fields.
- Keep an audit_log row for each preview attempt. If detailed preview history matters, add a child `zoho_production_output_previews` table later. Do not force that in Slice A.

After approval:

- Do not allow edits to PO, PO line, warehouse, composite IDs, receive date, or quantities.
- If the mapping is wrong, require voiding the approved row before commit, with a reason and audit row. This protects against accidental commit of a payload that was not the one reviewed.

## 6. Genealogy Handling

Genealogy should not be silently required for preview, but it must be visible.

Recommended `genealogy_state` values:

- `HIGH`: finished lot has direct workflow bag and finished-lot passport/raw-bag links.
- `LOW`: only batch-level or legacy inferred genealogy exists.
- `MISSING`: no workflow bag and no usable finished-lot raw-bag/passport links.

Preview can run with `LOW` or `MISSING` genealogy because the Zoho preview endpoint mainly validates PO/item/warehouse quantity. Approval for live commit should be blocked or require explicit override until PM decides. The UI must label this as `Missing`, not “0 inputs”.

## 7. Metrics Handling

Do not treat unavailable metrics as true zero for approval/commit.

For preview, Luma can still send the Zoho contract’s numeric fields, but the durable row must retain whether metrics were actual or missing:

- `metrics_state = 'HIGH'`: `read_bag_metrics` row exists for the workflow bag; store measured values.
- `metrics_state = 'MISSING'`: no metrics row or no workflow bag; store nullable metric columns as `NULL`, and the preview builder may map them to `0` only because the current Zoho contract requires numbers.

Future commit should either:

- block when `metrics_state = 'MISSING'`, or
- require an explicit “No damage/ripped/loose metrics available; commit with zero values” admin acknowledgement.

Recommended default: block commit on missing metrics until PM approves the acknowledgement policy.

## 8. Idempotency

Live commit idempotency must live on the durable operation row, not be recomputed from the form at click time.

Use:

- `luma_operation_id = luma-production-output:<finishedLotId>:<opId or sequence>`
- `idempotency_key = luma-production-output-<opId>-<request_hash_prefix>`

Preview-only may use a payload-aware key to avoid 409 conflicts while admins edit. Once approved, the stored key becomes immutable and is reused for future commit/retry.

## 9. Existing Outbox Interaction

Current `zoho_assembly_ops` are auto-enqueued after finished lot create. They model older atomic tablet-receive and unit/display/case assembly operations, not the consolidated production-output endpoint.

Recommended rule:

- Do not delete or weaken `zoho_assembly_ops` in the mapping slice.
- Add a separate production-output operation table and UI.
- On finished-lot detail, show both systems honestly: “legacy assembly outbox” and “production output preview/approval”.
- Before any live commit slice, PM must decide whether consolidated production output replaces the old assembly outbox for finished goods, or runs alongside it for a transition period. Running both live would risk double-posting inventory.

Legacy `zoho_pushes` can remain untouched. If later code needs one shared status surface, link `zoho_pushes.finished_lot_id` to the new operation or retire it in a separate migration; do not overload it now.

## 10. Admin UI Before Approval

Finished lot detail should show:

- Product and composite item IDs: unit/display/case.
- Output quantities from the finished lot: units/displays/cases.
- Metric status: `Actual` or `Missing`, with damaged/ripped/loose values.
- Genealogy status: `HIGH`, `LOW`, or `Missing`.
- Explicit Zoho target: PO ID, PO line item ID, warehouse ID.
- Preview result: HTTP status, preflight, steps, warnings, request ID, response body.
- Request hash and idempotency key.
- A checkbox/confirmation before approval: “Approve this exact previewed request for future Zoho commit.”

No “Send to Zoho” button should exist until a later PM-approved live-write slice.

## 11. Required audit_log Entries

Use these action names:

- `zoho.production_output.mapping_saved`
- `zoho.production_output.preview_requested`
- `zoho.production_output.preview_succeeded`
- `zoho.production_output.preview_failed`
- `zoho.production_output.approved`
- `zoho.production_output.voided`
- future only: `zoho.production_output.commit_started`
- future only: `zoho.production_output.commit_succeeded`
- future only: `zoho.production_output.commit_failed`

Audit `after` should include operation ID, finished lot ID, status, request hash, non-secret Zoho target IDs, metrics/genealogy state, and preview/commit HTTP status. Never include bearer secrets.

## 12. Minimal Implementation Slices

Slice A: durable preview mapping

- Add table and Drizzle schema mirror.
- Update preview action to upsert DRAFT/PREVIEWED operation rows.
- Store request hash, payload, response, metrics/genealogy state, user, and audit rows.
- No approval and no commit.

Slice B: approval gate

- Add approve/void actions.
- Freeze approved request fields.
- Add UI diff when current finished-lot data differs from approved request payload.
- Still no commit.

Slice C: commit readiness design/implementation

- PM decides whether consolidated endpoint replaces `zoho_assembly_ops`.
- Add commit worker/action only after approval gate is live and tested.
- Use stored idempotency key and payload only.
- Do not recompute payload at commit time except for a warning diff.

## 13. Tests Required

Slice A:

- Migration shape test for table, indexes, and CHECK constraints.
- Payload persistence test: preview upserts one active row per finished lot.
- Changed mapping before approval updates active row and changes request hash/idempotency key.
- Missing warehouse/product IDs block before HTTP.
- Missing metrics stored as `metrics_state = 'MISSING'`, not silently actual zero.
- No `/commit` string or live endpoint path.
- No bearer secret rendered or stored in audit.

Slice B:

- Approved rows cannot be edited.
- Void requires reason and audit row.
- Approval stores exact request hash and user.
- UI labels mapping as `Previewed`, `Approved`, or `Missing` honestly.

Slice C:

- Commit can run only from APPROVED.
- Commit uses stored payload/idempotency key.
- Failed commit retries do not create duplicate operations.
- Existing `zoho_assembly_ops` cannot also live-post the same finished lot unless PM explicitly enables transition mode.

## 14. PM Decisions Needed

1. Should live commit block when genealogy is `LOW` or `MISSING`, or allow an explicit override?
2. Should live commit block when metrics are missing, or allow an explicit “commit damaged/ripped/loose as zero” acknowledgement?
3. Does the consolidated production-output endpoint replace the existing `zoho_assembly_ops` outbox, or do both coexist temporarily?
4. Should preview history be a child table from day one, or is latest-preview snapshot plus audit_log enough for initial testing?
5. Is one active production-output operation per finished lot sufficient, or can one finished lot be split across multiple Zoho PO lines?

## 15. Recommendation

READY FOR PM DECISION.

Build Slice A next only after PM confirms the missing metrics/genealogy policy and whether finished lots may split across PO lines. Do not build live commit/apply until Slice B approval is in place and the outbox interaction decision is settled.
