ALTER TABLE "finished_lots" ADD COLUMN IF NOT EXISTS "zoho_manufacture_order_id" text;--> statement-breakpoint
ALTER TABLE "finished_lots" ADD COLUMN IF NOT EXISTS "zoho_manufacture_error" text;--> statement-breakpoint
ALTER TABLE "finished_lots" ADD COLUMN IF NOT EXISTS "nexus_batch_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "finished_lots" ADD COLUMN IF NOT EXISTS "nexus_batch_register_error" text;
