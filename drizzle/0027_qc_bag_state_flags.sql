-- QC-5 — flags on read_bag_state for live QC event signals.
--
-- Three boolean columns flipped by lib/projector/qc-events.ts when
-- QC events fire on a bag:
--
--   rework_pending   — set on REWORK_SENT; cleared when cumulative
--                      REWORK_RECEIVED.received_quantity sum equals
--                      or exceeds the SENT row's quantity. Partial
--                      receives leave it on.
--
--   rework_received  — sticky flag once any REWORK_RECEIVED has
--                      fired for the bag. Used by genealogy + QC
--                      review to surface "this bag has been
--                      reworked at least once" without a join.
--
--   has_correction   — sticky flag once any SUBMISSION_CORRECTED
--                      lands against any event on the bag. Drives
--                      the "corrected submissions" warning chip on
--                      reconciliation and genealogy.
--
-- All three default to false. Additive only; no data backfill
-- needed — the projector will set them lazily as new QC events fire.

ALTER TABLE "read_bag_state"
  ADD COLUMN IF NOT EXISTS "rework_pending"  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "rework_received" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "has_correction"  boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "read_bag_state_rework_pending_idx"
  ON "read_bag_state" ("rework_pending")
  WHERE "rework_pending" = true;
