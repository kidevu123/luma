-- LOT-1G — send-state persistence for the Nexus / QIP handoff.
--
-- Adds three nullable columns to shipment_finished_lots so the
-- sendFinishedLotToNexusAction can record success / failure inline.
-- Same pattern as PT-7E's migration 0030 on read_material_recommendations.
--
-- nexus_sent_at: timestamp of the most recent successful outbound POST.
-- nexus_last_sent_response: mapped response body from Nexus (jsonb).
-- nexus_last_send_error: last failure reason; cleared on success.
--
-- All nullable. Rebuilds (none today, but future projector work) must
-- preserve these — operator state lives outside the projector.

ALTER TABLE "shipment_finished_lots"
  ADD COLUMN IF NOT EXISTS "nexus_sent_at"            timestamptz,
  ADD COLUMN IF NOT EXISTS "nexus_last_sent_response" jsonb,
  ADD COLUMN IF NOT EXISTS "nexus_last_send_error"    text;

CREATE INDEX IF NOT EXISTS "shipment_finished_lots_nexus_sent_at_idx"
  ON "shipment_finished_lots" ("nexus_sent_at")
  WHERE "nexus_sent_at" IS NOT NULL;
