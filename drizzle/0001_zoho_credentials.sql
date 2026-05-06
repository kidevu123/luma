-- Zoho Inventory credentials store. One row per company; updated
-- via /settings/zoho. We keep refresh_token alongside the most-
-- recent access token + its expiry so the runtime can call
-- refresh-on-demand without poking the DB twice.
CREATE TABLE IF NOT EXISTS "zoho_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL,
  "client_id" text NOT NULL,
  "client_secret" text NOT NULL,
  "refresh_token" text NOT NULL,
  "access_token" text,
  "access_token_expires_at" timestamptz,
  "data_center" text NOT NULL DEFAULT 'us',
  "warehouse_id" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by_id" uuid REFERENCES "users"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "zoho_credentials_company_unique"
  ON "zoho_credentials"("company_id");
