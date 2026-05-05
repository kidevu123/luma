CREATE TYPE "public"."batch_kind" AS ENUM('TABLET', 'PACKAGING');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('QUARANTINE', 'RELEASED', 'ON_HOLD', 'RECALLED', 'EXPIRED', 'DEPLETED');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('ACTIVE', 'INACTIVE', 'TERMINATED');--> statement-breakpoint
CREATE TYPE "public"."finished_lot_status" AS ENUM('PENDING_QC', 'RELEASED', 'ON_HOLD', 'SHIPPED', 'RECALLED');--> statement-breakpoint
CREATE TYPE "public"."inventory_bag_status" AS ENUM('AVAILABLE', 'IN_USE', 'EMPTIED', 'QUARANTINED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."machine_kind" AS ENUM('BLISTER', 'SEALING', 'PACKAGING', 'BOTTLE_HANDPACK', 'BOTTLE_CAP_SEAL', 'BOTTLE_STICKER', 'COMBINED');--> statement-breakpoint
CREATE TYPE "public"."packaging_material_kind" AS ENUM('BLISTER_FOIL', 'HEAT_SEAL_FILM', 'BOTTLE', 'CAP', 'INDUCTION_SEAL', 'LABEL', 'DESICCANT', 'COTTON', 'DISPLAY', 'CASE', 'INSERT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."po_status" AS ENUM('DRAFT', 'OPEN', 'RECEIVING', 'RECEIVED', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('CARD', 'BOTTLE', 'VARIETY');--> statement-breakpoint
CREATE TYPE "public"."qr_card_status" AS ENUM('IDLE', 'ASSIGNED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."station_kind" AS ENUM('BLISTER', 'SEALING', 'PACKAGING', 'BOTTLE_HANDPACK', 'BOTTLE_CAP_SEAL', 'BOTTLE_STICKER', 'COMBINED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER', 'ADMIN', 'MANAGER', 'LEAD', 'STAFF');--> statement-breakpoint
CREATE TYPE "public"."workflow_event_type" AS ENUM('CARD_ASSIGNED', 'CARD_FORCE_RELEASED', 'BAG_CLAIMED', 'STATION_RESUMED', 'OPERATOR_CHANGE', 'PRODUCT_MAPPED', 'BLISTER_COMPLETE', 'SEALING_COMPLETE', 'PACKAGING_SNAPSHOT', 'PACKAGING_TAKEN_FOR_ORDER', 'BOTTLE_HANDPACK_COMPLETE', 'BOTTLE_CAP_SEAL_COMPLETE', 'BOTTLE_STICKER_COMPLETE', 'VARIETY_SOURCES_ASSIGNED', 'BATCH_RELEASED', 'BATCH_HELD', 'BATCH_RECALLED', 'MATERIAL_CONSUMED', 'SUBMISSION_CORRECTED', 'BAG_FINALIZED', 'STATION_SCAN_TOKEN_ROTATED');--> statement-breakpoint
CREATE TYPE "public"."zoho_push_status" AS ENUM('PENDING', 'SUCCESS', 'FAILED', 'PARTIAL');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" uuid,
	"actor_role" "user_role",
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "batch_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by_id" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_id" uuid,
	"closed_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "batch_kind" NOT NULL,
	"batch_number" text NOT NULL,
	"tablet_type_id" uuid,
	"packaging_material_id" uuid,
	"vendor_name" text,
	"vendor_lot_number" text,
	"manufactured_at" date,
	"expiry_date" date,
	"status" "batch_status" DEFAULT 'QUARANTINE' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_by_id" uuid,
	"qty_received" integer DEFAULT 0 NOT NULL,
	"qty_on_hand" integer DEFAULT 0 NOT NULL,
	"coa_path" text,
	"coa_uploaded_at" timestamp with time zone,
	"coa_uploaded_by_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"brand_color_hex" text DEFAULT '#0d9488' NOT NULL,
	"logo_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" text,
	"full_name" text NOT NULL,
	"preferred_name" text,
	"email" text,
	"phone" text,
	"language" text DEFAULT 'en' NOT NULL,
	"status" "employee_status" DEFAULT 'ACTIVE' NOT NULL,
	"hired_on" date,
	"birthday" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finished_lot_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finished_lot_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"qty_consumed" integer NOT NULL,
	"derived_from_event_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finished_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"workflow_bag_id" uuid,
	"finished_lot_number" text NOT NULL,
	"produced_on" date NOT NULL,
	"expiry_date" date NOT NULL,
	"units_produced" integer NOT NULL,
	"displays_produced" integer,
	"cases_produced" integer,
	"status" "finished_lot_status" DEFAULT 'PENDING_QC' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_bags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"small_box_id" uuid NOT NULL,
	"bag_number" integer NOT NULL,
	"tablet_type_id" uuid NOT NULL,
	"batch_id" uuid,
	"pill_count" integer,
	"weight_grams" integer,
	"status" "inventory_bag_status" DEFAULT 'AVAILABLE' NOT NULL,
	"reserved_for_bottles" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "machine_kind" NOT NULL,
	"cards_per_turn" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "packaging_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"packaging_material_id" uuid NOT NULL,
	"batch_id" uuid,
	"po_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"qty_received" integer NOT NULL,
	"qty_on_hand" integer NOT NULL,
	"expiry_date" date,
	"coa_path" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "packaging_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"kind" "packaging_material_kind" NOT NULL,
	"uom" text DEFAULT 'each' NOT NULL,
	"par_level" integer,
	"zoho_item_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "po_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"tablet_type_id" uuid,
	"packaging_material_id" uuid,
	"qty_ordered" integer NOT NULL,
	"zoho_line_item_id" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_allowed_tablets" (
	"product_id" uuid NOT NULL,
	"tablet_type_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "product_allowed_tablets_product_id_tablet_type_id_pk" PRIMARY KEY("product_id","tablet_type_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_packaging_specs" (
	"product_id" uuid NOT NULL,
	"packaging_material_id" uuid NOT NULL,
	"qty_per_unit" integer NOT NULL,
	"per_scope" text DEFAULT 'UNIT' NOT NULL,
	"notes" text,
	CONSTRAINT "product_packaging_specs_product_id_packaging_material_id_per_scope_pk" PRIMARY KEY("product_id","packaging_material_id","per_scope")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"kind" "product_kind" NOT NULL,
	"tablets_per_unit" integer,
	"units_per_display" integer,
	"displays_per_case" integer,
	"default_shelf_life_days" integer,
	"zoho_item_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_number" text NOT NULL,
	"parent_po_number" text,
	"vendor_name" text,
	"status" "po_status" DEFAULT 'OPEN' NOT NULL,
	"zoho_po_id" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qr_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"scan_token" text NOT NULL,
	"status" "qr_card_status" DEFAULT 'IDLE' NOT NULL,
	"assigned_workflow_bag_id" uuid,
	"retired_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_bag_state" (
	"workflow_bag_id" uuid PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"product_id" uuid,
	"product_name" text,
	"inventory_bag_batch_id" uuid,
	"receipt_number" text,
	"is_finalized" boolean DEFAULT false NOT NULL,
	"is_on_hold" boolean DEFAULT false NOT NULL,
	"last_event_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_daily_throughput" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"product_id" uuid,
	"machine_id" uuid,
	"bags_blistered" integer DEFAULT 0 NOT NULL,
	"bags_sealed" integer DEFAULT 0 NOT NULL,
	"bags_packaged" integer DEFAULT 0 NOT NULL,
	"bags_finalized" integer DEFAULT 0 NOT NULL,
	"units_produced" integer DEFAULT 0 NOT NULL,
	"displays_produced" integer DEFAULT 0 NOT NULL,
	"cases_produced" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_material_burn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"packaging_material_id" uuid NOT NULL,
	"qty_consumed" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_station_live" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"current_workflow_bag_id" uuid,
	"current_product_id" uuid,
	"current_employee_name" text,
	"last_event_type" text,
	"last_event_at" timestamp with time zone,
	"busy_for_seconds" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid,
	"shipment_id" uuid,
	"receive_name" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by_id" uuid,
	"closed_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid,
	"carrier" text,
	"tracking_number" text,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivery_photo_path" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "small_boxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receive_id" uuid NOT NULL,
	"box_number" integer NOT NULL,
	"default_batch_id" uuid,
	"default_tablet_type_id" uuid,
	"total_bags" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"kind" "station_kind" NOT NULL,
	"machine_id" uuid,
	"scan_token" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tablet_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text,
	"name" text NOT NULL,
	"default_mg_per_tablet" integer,
	"zoho_item_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"role" "user_role" DEFAULT 'STAFF' NOT NULL,
	"employee_id" uuid,
	"authentik_subject" text,
	"disabled_at" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_bags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid,
	"inventory_bag_id" uuid,
	"receipt_number" text,
	"box_number" integer,
	"bag_number" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_bag_id" uuid NOT NULL,
	"event_type" "workflow_event_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"station_id" uuid,
	"employee_id" uuid,
	"user_id" uuid,
	"device_id" text,
	"page_session_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zoho_pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finished_lot_id" uuid NOT NULL,
	"zoho_receive_id" text,
	"zoho_overs_receive_id" text,
	"status" "zoho_push_status" DEFAULT 'PENDING' NOT NULL,
	"pushed_at" timestamp with time zone,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"amount_cents" bigint
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "batch_holds" ADD CONSTRAINT "batch_holds_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "batch_holds" ADD CONSTRAINT "batch_holds_opened_by_id_users_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "batch_holds" ADD CONSTRAINT "batch_holds_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "batches" ADD CONSTRAINT "batches_tablet_type_id_tablet_types_id_fk" FOREIGN KEY ("tablet_type_id") REFERENCES "public"."tablet_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "batches" ADD CONSTRAINT "batches_packaging_material_id_packaging_materials_id_fk" FOREIGN KEY ("packaging_material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "batches" ADD CONSTRAINT "batches_status_changed_by_id_users_id_fk" FOREIGN KEY ("status_changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "batches" ADD CONSTRAINT "batches_coa_uploaded_by_id_users_id_fk" FOREIGN KEY ("coa_uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_inputs" ADD CONSTRAINT "finished_lot_inputs_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_inputs" ADD CONSTRAINT "finished_lot_inputs_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lots" ADD CONSTRAINT "finished_lots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_bags" ADD CONSTRAINT "inventory_bags_small_box_id_small_boxes_id_fk" FOREIGN KEY ("small_box_id") REFERENCES "public"."small_boxes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_bags" ADD CONSTRAINT "inventory_bags_tablet_type_id_tablet_types_id_fk" FOREIGN KEY ("tablet_type_id") REFERENCES "public"."tablet_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "packaging_lots" ADD CONSTRAINT "packaging_lots_packaging_material_id_packaging_materials_id_fk" FOREIGN KEY ("packaging_material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "packaging_lots" ADD CONSTRAINT "packaging_lots_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_tablet_type_id_tablet_types_id_fk" FOREIGN KEY ("tablet_type_id") REFERENCES "public"."tablet_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_allowed_tablets" ADD CONSTRAINT "product_allowed_tablets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_allowed_tablets" ADD CONSTRAINT "product_allowed_tablets_tablet_type_id_tablet_types_id_fk" FOREIGN KEY ("tablet_type_id") REFERENCES "public"."tablet_types"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_packaging_specs" ADD CONSTRAINT "product_packaging_specs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_packaging_specs" ADD CONSTRAINT "product_packaging_specs_packaging_material_id_packaging_materials_id_fk" FOREIGN KEY ("packaging_material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_bag_state" ADD CONSTRAINT "read_bag_state_workflow_bag_id_workflow_bags_id_fk" FOREIGN KEY ("workflow_bag_id") REFERENCES "public"."workflow_bags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_daily_throughput" ADD CONSTRAINT "read_daily_throughput_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_daily_throughput" ADD CONSTRAINT "read_daily_throughput_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_burn" ADD CONSTRAINT "read_material_burn_packaging_material_id_packaging_materials_id_fk" FOREIGN KEY ("packaging_material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_station_live" ADD CONSTRAINT "read_station_live_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receives" ADD CONSTRAINT "receives_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receives" ADD CONSTRAINT "receives_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receives" ADD CONSTRAINT "receives_received_by_id_users_id_fk" FOREIGN KEY ("received_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipments" ADD CONSTRAINT "shipments_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "small_boxes" ADD CONSTRAINT "small_boxes_receive_id_receives_id_fk" FOREIGN KEY ("receive_id") REFERENCES "public"."receives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "small_boxes" ADD CONSTRAINT "small_boxes_default_tablet_type_id_tablet_types_id_fk" FOREIGN KEY ("default_tablet_type_id") REFERENCES "public"."tablet_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stations" ADD CONSTRAINT "stations_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_bags" ADD CONSTRAINT "workflow_bags_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_bags" ADD CONSTRAINT "workflow_bags_inventory_bag_id_inventory_bags_id_fk" FOREIGN KEY ("inventory_bag_id") REFERENCES "public"."inventory_bags"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_workflow_bag_id_workflow_bags_id_fk" FOREIGN KEY ("workflow_bag_id") REFERENCES "public"."workflow_bags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zoho_pushes" ADD CONSTRAINT "zoho_pushes_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batch_holds_batch_idx" ON "batch_holds" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "batches_kind_number_unique" ON "batches" USING btree ("kind","batch_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batches_status_idx" ON "batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batches_tablet_type_idx" ON "batches" USING btree ("tablet_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batches_packaging_material_idx" ON "batches" USING btree ("packaging_material_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "batches_expiry_idx" ON "batches" USING btree ("expiry_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_inputs_lot_idx" ON "finished_lot_inputs" USING btree ("finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_inputs_batch_idx" ON "finished_lot_inputs" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finished_lots_number_unique" ON "finished_lots" USING btree ("finished_lot_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lots_product_idx" ON "finished_lots" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lots_produced_idx" ON "finished_lots" USING btree ("produced_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_bags_box_idx" ON "inventory_bags" USING btree ("small_box_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_bags_batch_idx" ON "inventory_bags" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_bags_status_idx" ON "inventory_bags" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_bags_box_bagno_unique" ON "inventory_bags" USING btree ("small_box_id","bag_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "packaging_lots_material_idx" ON "packaging_lots" USING btree ("packaging_material_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "packaging_lots_batch_idx" ON "packaging_lots" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "packaging_materials_sku_unique" ON "packaging_materials" USING btree ("sku");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "packaging_materials_kind_idx" ON "packaging_materials" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "po_lines_po_idx" ON "po_lines" USING btree ("po_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_sku_unique" ON "products" USING btree ("sku");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_kind_idx" ON "products" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "po_number_unique" ON "purchase_orders" USING btree ("po_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "po_zoho_idx" ON "purchase_orders" USING btree ("zoho_po_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "po_status_idx" ON "purchase_orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "qr_cards_token_unique" ON "qr_cards" USING btree ("scan_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qr_cards_status_idx" ON "qr_cards" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_bag_state_stage_idx" ON "read_bag_state" USING btree ("stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_bag_state_finalized_idx" ON "read_bag_state" USING btree ("is_finalized");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_daily_throughput_day_product_machine_unique" ON "read_daily_throughput" USING btree ("day","product_id","machine_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_daily_throughput_day_idx" ON "read_daily_throughput" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_material_burn_day_material_unique" ON "read_material_burn" USING btree ("day","packaging_material_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receives_po_idx" ON "receives" USING btree ("po_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "receives_name_unique" ON "receives" USING btree ("receive_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_po_idx" ON "shipments" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "small_boxes_receive_idx" ON "small_boxes" USING btree ("receive_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stations_scan_token_unique" ON "stations" USING btree ("scan_token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tablet_types_sku_unique" ON "tablet_types" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_authentik_unique" ON "users" USING btree ("authentik_subject");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_bags_product_idx" ON "workflow_bags" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_bags_inventory_idx" ON "workflow_bags" USING btree ("inventory_bag_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_bags_started_idx" ON "workflow_bags" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_events_bag_idx" ON "workflow_events" USING btree ("workflow_bag_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_events_type_idx" ON "workflow_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_events_occurred_idx" ON "workflow_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_events_bag_occurred_idx" ON "workflow_events" USING btree ("workflow_bag_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_finalized_unique" ON "workflow_events" USING btree ("workflow_bag_id") WHERE event_type = 'BAG_FINALIZED';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_pushes_lot_idx" ON "zoho_pushes" USING btree ("finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_pushes_status_idx" ON "zoho_pushes" USING btree ("status");