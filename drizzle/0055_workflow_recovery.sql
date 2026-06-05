-- WORKFLOW-RECOVERY-1 — wrong-route recovery event + read_bag_state flags.

ALTER TYPE "public"."workflow_event_type" ADD VALUE IF NOT EXISTS 'WORKFLOW_RECOVERY';

ALTER TABLE read_bag_state
  ADD COLUMN IF NOT EXISTS recovery_status text,
  ADD COLUMN IF NOT EXISTS excluded_from_output boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS read_bag_state_excluded_from_output_idx
  ON read_bag_state (excluded_from_output)
  WHERE excluded_from_output = true;
