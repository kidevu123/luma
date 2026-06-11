-- P3-USERS — real-person name + delete support.
--
-- name: display name shown as the primary identity (email secondary).
-- deleted_at: user deletion marker. Deletion anonymizes the row in
-- place (name → 'Deleted user', email → tombstone, credentials
-- cleared) so every FK to the user keeps resolving and owned resources
-- display under the canonical "Deleted user" identity. Nothing leaves
-- the DB (repo soft-delete convention).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
