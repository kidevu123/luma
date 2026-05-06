-- Phase A: standards/config + read-model tables for the production-
-- intelligence rebuild. NO enum changes here — those are isolated in
-- 0008 because Drizzle silently rolls back ALTER TYPE ADD VALUE when
-- it ships in the same migration as DDL that needs the new value.
--
-- Hand-written instead of trusting drizzle-kit's auto-generator —
-- the kit's snapshot history is incomplete (only 0000 + 0009 in
-- meta/) so its diff includes spurious recreates of tables that
-- already exist. This file is the minimal additive set.

-- ─── Standards / config ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "production_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"shift_start" text NOT NULL,
	"shift_end" text NOT NULL,
	"planned_break_minutes" integer DEFAULT 0 NOT NULL,
	"days_of_week_mask" integer DEFAULT 127 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_calendars_effective_idx" ON "production_calendars" ("effective_from","effective_to");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "station_standards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid,
	"machine_id" uuid,
	"product_id" uuid,
	"ideal_cycle_seconds" numeric(10,3),
	"target_units_per_hour" numeric(10,3),
	"expected_yield_pct" numeric(5,2),
	"output_unit" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "station_standards"
	ADD CONSTRAINT "station_standards_station_id_fk"
	FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "station_standards"
	ADD CONSTRAINT "station_standards_machine_id_fk"
	FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "station_standards"
	ADD CONSTRAINT "station_standards_product_id_fk"
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "station_standards"
	ADD CONSTRAINT "station_standards_created_by_id_fk"
	FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
-- At least one of station_id / machine_id must be set; both is
-- allowed (a station-specific override on a machine-wide default).
ALTER TABLE "station_standards"
	ADD CONSTRAINT "station_standards_scope_chk"
	CHECK ("station_id" IS NOT NULL OR "machine_id" IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "station_standards_lookup_idx" ON "station_standards" ("station_id","product_id","effective_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "station_standards_machine_lookup_idx" ON "station_standards" ("machine_id","product_id","effective_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "station_standards_active_idx" ON "station_standards" ("is_active");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "labor_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text NOT NULL,
	"hourly_rate_cents" integer NOT NULL,
	"burden_multiplier" numeric(5,3) DEFAULT '1.000' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "labor_rates"
	ADD CONSTRAINT "labor_rates_created_by_id_fk"
	FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "labor_rates_role_effective_idx" ON "labor_rates" ("role","effective_from");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "due_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_kind" text NOT NULL,
	"reference_id" text NOT NULL,
	"product_id" uuid,
	"target_quantity" integer NOT NULL,
	"target_unit" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"completed_at" timestamp with time zone,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "due_targets"
	ADD CONSTRAINT "due_targets_product_id_fk"
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "due_targets"
	ADD CONSTRAINT "due_targets_created_by_id_fk"
	FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "due_targets_reference_unique" ON "due_targets" ("reference_kind","reference_id","product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "due_targets_due_at_idx" ON "due_targets" ("due_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "due_targets_open_idx" ON "due_targets" ("completed_at");
--> statement-breakpoint

-- ─── Read models (Phase A) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "read_queue_state" (
	"stage_key" text PRIMARY KEY NOT NULL,
	"wip" integer DEFAULT 0 NOT NULL,
	"oldest_age_seconds" integer,
	"avg_age_seconds" integer,
	"p90_age_seconds" integer,
	"bags_over_threshold" integer DEFAULT 0 NOT NULL,
	"queue_status" text DEFAULT 'EMPTY' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "read_sku_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"product_id" uuid NOT NULL,
	"product_sku" text NOT NULL,
	"product_kind" text NOT NULL,
	"tablets_consumed" integer DEFAULT 0 NOT NULL,
	"bags_completed" integer DEFAULT 0 NOT NULL,
	"displays_completed" integer DEFAULT 0 NOT NULL,
	"cases_completed" integer DEFAULT 0 NOT NULL,
	"bottles_completed" integer DEFAULT 0 NOT NULL,
	"loose_cards" integer DEFAULT 0 NOT NULL,
	"loose_displays" integer DEFAULT 0 NOT NULL,
	"damages" integer DEFAULT 0 NOT NULL,
	"rework" integer DEFAULT 0 NOT NULL,
	"scrap" integer DEFAULT 0 NOT NULL,
	"avg_lead_time_seconds" integer,
	"avg_cycle_seconds" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "read_sku_daily"
	ADD CONSTRAINT "read_sku_daily_product_id_fk"
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_sku_daily_day_product_unique" ON "read_sku_daily" ("day","product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_sku_daily_day_idx" ON "read_sku_daily" ("day");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "read_material_reconciliation" (
	"workflow_bag_id" uuid PRIMARY KEY NOT NULL,
	"received_qty" integer,
	"consumed_qty" integer,
	"finished_qty" integer,
	"scrap_qty" integer,
	"remaining_qty" integer,
	"variance_qty" integer,
	"variance_pct" numeric(7,3),
	"is_estimated" boolean DEFAULT false NOT NULL,
	"missing_inputs" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "read_material_reconciliation"
	ADD CONSTRAINT "read_material_recon_bag_fk"
	FOREIGN KEY ("workflow_bag_id") REFERENCES "workflow_bags"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recon_variance_idx" ON "read_material_reconciliation" ("variance_qty");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recon_estimated_idx" ON "read_material_reconciliation" ("is_estimated");
