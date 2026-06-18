-- RBA-NEGATIVE-ENDING-v1.4.14 — allow negative ending_balance_qty on
-- raw_bag_allocation_sessions when packaging output exceeds the vendor
-- label intake count.
--
-- The prior CHECK required ending_balance_qty >= 0. Coordinated lot
-- issue + repair closeout now treats packaging consumption as source
-- of truth; a negative ending balance records over-consumption vs the
-- weight-derived label without blocking closeout.
--
-- starting_balance_qty and consumed_qty remain non-negative.

ALTER TABLE "raw_bag_allocation_sessions"
  DROP CONSTRAINT IF EXISTS "rba_sessions_qty_signs";

ALTER TABLE "raw_bag_allocation_sessions"
  ADD CONSTRAINT "rba_sessions_qty_signs" CHECK (
    ("starting_balance_qty" IS NULL OR "starting_balance_qty" >= 0)
    AND ("consumed_qty" IS NULL OR "consumed_qty" >= 0)
  );
