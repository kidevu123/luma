-- Normal successful intake creates RELEASED batches; quarantine is exception-only.
ALTER TABLE "batches" ALTER COLUMN "status" SET DEFAULT 'RELEASED';
