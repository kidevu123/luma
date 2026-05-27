CREATE TABLE IF NOT EXISTS "finished_lot_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finished_lot_id" uuid NOT NULL,
	"zoho_order_id" text NOT NULL,
	"product_sku" text NOT NULL,
	"qty_sold" integer NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_sales" ADD CONSTRAINT "finished_lot_sales_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finished_lot_sales_pair_unique" ON "finished_lot_sales" USING btree ("finished_lot_id","zoho_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_sales_order_idx" ON "finished_lot_sales" USING btree ("zoho_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_sales_lot_idx" ON "finished_lot_sales" USING btree ("finished_lot_id");