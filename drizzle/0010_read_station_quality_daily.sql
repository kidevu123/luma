-- Phase C: per-(day, station|machine, product) quality + unit rollup.
-- Drives OEE Quality + Performance once standards land. Empty by
-- default; populated by lib/projector/station-daily.ts at
-- BAG_FINALIZED time.
--
-- station_id is nullable because today's projector attributes at
-- machine granularity (readBagMetrics has machine_ids[], not a
-- station_id per output unit). Phase D / E may sharpen this.
--
-- Hand-written, additive only.

CREATE TABLE IF NOT EXISTS "read_station_quality_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"station_id" uuid,
	"machine_id" uuid,
	"product_id" uuid,
	"output_unit" text NOT NULL,
	"total_units" integer DEFAULT 0 NOT NULL,
	"good_units" integer DEFAULT 0 NOT NULL,
	"reject_units" integer DEFAULT 0 NOT NULL,
	"scrap_units" integer DEFAULT 0 NOT NULL,
	"rework_units" integer DEFAULT 0 NOT NULL,
	"damaged_units" integer DEFAULT 0 NOT NULL,
	"active_minutes" integer DEFAULT 0 NOT NULL,
	"planned_minutes" integer,
	"data_confidence" text DEFAULT 'HIGH' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "read_station_quality_daily"
	ADD CONSTRAINT "read_station_quality_daily_station_fk"
	FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "read_station_quality_daily"
	ADD CONSTRAINT "read_station_quality_daily_machine_fk"
	FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "read_station_quality_daily"
	ADD CONSTRAINT "read_station_quality_daily_product_fk"
	FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_station_quality_daily_unique"
	ON "read_station_quality_daily" ("day","machine_id","product_id","output_unit");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_station_quality_daily_day_idx"
	ON "read_station_quality_daily" ("day");
