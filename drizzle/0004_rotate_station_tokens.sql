-- Rotate any existing station scan token that uses the old
-- Math.random() format ("blister-xxxxxxxx" etc., ~41 bits) to a
-- crypto-strong UUID. Stations that were already created with a
-- UUID-shaped token are left alone. This invalidates any
-- previously-saved bookmarks; admins must re-print station QRs.
UPDATE stations
SET scan_token = gen_random_uuid()::text
WHERE scan_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE qr_cards
SET scan_token = gen_random_uuid()::text
WHERE scan_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
