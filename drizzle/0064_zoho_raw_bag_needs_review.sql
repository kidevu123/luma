-- ZOHO-STAGING-BUFFER-v1.1.0 — NEEDS_REVIEW for human-decision blockers.
--
-- NEEDS_MAPPING already exists (added in 0062) for SKU / Zoho ID gaps
-- that the OPERATOR can resolve on the product page. NEEDS_REVIEW is
-- distinct: it's for receiving exceptions like over-receive that
-- require a BUSINESS decision (adjust qty, hold for PO update, create
-- overs PO, split, void, reconcile-with-note). Splitting the two so
-- the queue can route them to different reviewers and so the
-- mapping_blockers code stays accurate to what's actually wrong.

ALTER TYPE zoho_raw_bag_receive_status ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW';
