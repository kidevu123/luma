-- ZOHO-STAGING-BUFFER-v1.1.0 — extend zoho_raw_bag_receive_status with the
-- review/buffer/auto-commit transitions documented in the v1.1.0 state
-- machine. ALTER TYPE values are split into their own migration per the
-- luma-drizzle-migration rule: the Drizzle pg migrator runs each .sql in
-- its own transaction, so the new enum values commit before the column
-- additions in 0063 reference them.
--
-- HELD          — operator paused the auto-commit clock; reset on unhold.
-- NEEDS_MAPPING — gateway returned structured mapping blockers; awaits a
--                 product/PO fix on the Luma side before re-arming.
-- COMMITTING    — claimed by the worker (or manual button) and a Zoho
--                 commit is in flight; recovers to PENDING/FAILED on
--                 transport failure.
-- VOIDED        — terminal: operator cancelled the staged op; never
--                 sent to Zoho.

ALTER TYPE zoho_raw_bag_receive_status ADD VALUE IF NOT EXISTS 'HELD';
ALTER TYPE zoho_raw_bag_receive_status ADD VALUE IF NOT EXISTS 'NEEDS_MAPPING';
ALTER TYPE zoho_raw_bag_receive_status ADD VALUE IF NOT EXISTS 'COMMITTING';
ALTER TYPE zoho_raw_bag_receive_status ADD VALUE IF NOT EXISTS 'VOIDED';
