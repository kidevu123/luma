-- ZOHO-RAW-BAG-RECEIVE-1 — enums only (table DDL in 0059).

DO $$ BEGIN
  CREATE TYPE zoho_raw_bag_receive_status AS ENUM (
    'PENDING',
    'PREVIEWED',
    'COMMITTED',
    'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE zoho_raw_bag_reconciliation_status AS ENUM (
    'UNCONFIRMED',
    'CONFIRMED_EXISTING',
    'RECEIVED_BY_LUMA',
    'RECONCILIATION_REQUIRED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
