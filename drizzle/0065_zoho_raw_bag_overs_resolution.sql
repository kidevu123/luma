-- OVERS-RESOLUTION-v1.2.0 — operator decisions on over-receive rows.
--
-- Adds six additive columns to zoho_raw_bag_receives so operators can
-- record HOW they resolved an over-receive blocker without losing the
-- bag-level intake truth. The four canonical decisions:
--
--   adjust_down          — send a smaller receive to Zoho; bag's
--                          declared count stays at the vendor-shipped
--                          quantity (preserves report truth)
--   hold_for_po_update   — park until Procurement bumps PO quantity in
--                          Zoho; unhold to retry
--   needs_overs_po       — tag for a future overs PO; stays in
--                          NEEDS_REVIEW so the sub-queue shows it
--   reconciled_manually  — terminal void; operator handled outside Luma
--
-- parent_op_id is a forward stub for the v1.3.0+ split workflow (one
-- row splits into two children: original-PO portion + overs-PO
-- portion). Today it stays NULL on every row.
--
-- All additive. Index on overs_decision lets the "Awaiting overs PO"
-- widget hit O(log n) lookups.

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "overs_decision" text;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "overs_decision_at" timestamptz;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "overs_decision_by_user_id" uuid
  REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "overs_decision_note" text;

-- Only populated when overs_decision = 'adjust_down'. The new lower
-- quantity going to Zoho. inventory_bags.declared_pill_count is NEVER
-- touched by the resolution actions.
ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "adjusted_received_quantity" integer;

-- Reserved for the v1.3.0+ split workflow. NULL on every row today.
ALTER TABLE "zoho_raw_bag_receives"
  ADD COLUMN IF NOT EXISTS "parent_op_id" uuid
  REFERENCES "zoho_raw_bag_receives"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "zoho_raw_bag_receives_overs_decision_idx"
  ON "zoho_raw_bag_receives" ("overs_decision")
  WHERE "overs_decision" IS NOT NULL;
