-- 0044 — VARIETY-2b: Add variety_qr_card_id FK to variety_runs.
--
-- Adds a nullable FK from variety_runs to qr_cards so variety pack runs
-- are traceable to the QR card record, not just a plain text token.
-- parent_scan_token is kept for compatibility and display.
--
-- Backfill: matches existing rows by scan_token where card_type = 'VARIETY_PACK'.
-- Rows with no matching card (legacy / pre-QR-pool rows) remain null.

ALTER TABLE "variety_runs"
  ADD COLUMN IF NOT EXISTS "variety_qr_card_id" UUID
    REFERENCES "qr_cards"("id") ON DELETE SET NULL;
-- ON DELETE SET NULL is intentional and consistent with all FK columns in this schema.
-- Hard-deletes on qr_cards never occur (soft-delete-only project convention).
-- If a card were ever hard-deleted, the run row keeps its parent_scan_token for display.

UPDATE "variety_runs" vr
SET "variety_qr_card_id" = qc.id
FROM "qr_cards" qc
WHERE qc.scan_token  = vr.parent_scan_token
  AND qc.card_type   = 'VARIETY_PACK'
  AND vr.variety_qr_card_id IS NULL;

CREATE INDEX IF NOT EXISTS "variety_runs_qr_card_idx"
  ON "variety_runs"("variety_qr_card_id")
  WHERE "variety_qr_card_id" IS NOT NULL;
