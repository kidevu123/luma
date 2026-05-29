-- MULTI-SEALING-SAME-BAG-1 — per-machine sealing output without closing the bag.
--
-- ISOLATED migration: enum ALTER only. SEALING_SEGMENT_COMPLETE records
-- counter output while global stage stays BLISTERED; SEALING_COMPLETE
-- remains the lane-close event that advances to SEALED.

ALTER TYPE "workflow_event_type" ADD VALUE IF NOT EXISTS 'SEALING_SEGMENT_COMPLETE';
