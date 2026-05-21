-- QR-CARD-TYPE — Add card_type classification to qr_cards.
--
-- Physical inventory:
--   bag-card-1..200 → RAW_BAG (single-bag workflow)
--   variety-pack-1..5 → VARIETY_PACK (multi-source variety run)
--   WORKFLOW_TRAVELER — future use (transfer tickets, etc.)
--   UNKNOWN — default for legacy cards with unrecognized tokens

CREATE TYPE "qr_card_type" AS ENUM ('RAW_BAG', 'VARIETY_PACK', 'WORKFLOW_TRAVELER', 'UNKNOWN');

ALTER TABLE "qr_cards"
  ADD COLUMN "card_type" "qr_card_type" NOT NULL DEFAULT 'UNKNOWN';

-- Backfill known card types from scan_token prefix
UPDATE "qr_cards"
  SET "card_type" = 'RAW_BAG'
  WHERE "scan_token" LIKE 'bag-card-%';

UPDATE "qr_cards"
  SET "card_type" = 'VARIETY_PACK'
  WHERE "scan_token" LIKE 'variety-pack-%';
