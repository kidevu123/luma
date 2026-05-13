-- PT-7E — outbound PackTrack handoff bookkeeping.
--
-- Two new columns on read_material_recommendations:
--   - sent_at: timestamp of the most recent successful outbound POST
--   - last_sent_response: the response body returned by PackTrack (or
--     a stripped-down version of it) so investigators can answer
--     "what did PackTrack say when we tried this?"
--
-- last_send_error already exists from PT-7C (0029) and is reused for
-- failure traces. PT-7E only adds the success-side bookkeeping.
--
-- Both columns are nullable. Rebuilds preserve them (the projector
-- already keeps `recommendation_id` / `acknowledged_at` / `dismissed_at`
-- / `last_send_error` across rebuilds; sent_at / last_sent_response
-- belong to the same operator-state cluster).

ALTER TABLE "read_material_recommendations"
  ADD COLUMN IF NOT EXISTS "sent_at"            timestamptz,
  ADD COLUMN IF NOT EXISTS "last_sent_response" jsonb;

-- Hot index: "show every recommendation that has been sent" view.
CREATE INDEX IF NOT EXISTS "read_material_recommendations_sent_idx"
  ON "read_material_recommendations" ("sent_at")
  WHERE "sent_at" IS NOT NULL;
