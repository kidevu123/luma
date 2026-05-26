CREATE TYPE "public"."material_event_type" AS ENUM('MATERIAL_RECEIVED', 'MATERIAL_ISSUED', 'MATERIAL_RETURNED', 'MATERIAL_CONSUMED_ESTIMATED', 'MATERIAL_CONSUMED_ACTUAL', 'MATERIAL_ADJUSTED', 'ROLL_MOUNTED', 'ROLL_UNMOUNTED', 'ROLL_WEIGHED', 'ROLL_DEPLETED', 'MATERIAL_SCRAPPED', 'ROLL_COUNTER_SEGMENT_RECORDED', 'PACKAGING_RECEIPT_IMPORTED', 'PACKAGING_BOX_RECEIVED', 'PACKAGING_BOX_COUNTED', 'PACKAGING_RECEIPT_ADJUSTED', 'PACKAGING_VARIANCE_RECORDED');--> statement-breakpoint
CREATE TYPE "public"."material_lot_status" AS ENUM('AVAILABLE', 'IN_USE', 'DEPLETED', 'HELD', 'SCRAPPED', 'ADJUSTED');--> statement-breakpoint
CREATE TYPE "public"."packaging_item_category" AS ENUM('MATERIAL', 'PACKAGING');--> statement-breakpoint
CREATE TYPE "public"."packaging_receipt_source" AS ENUM('PACKTRACK', 'MANUAL_LUMA', 'ZOHO', 'IMPORT');--> statement-breakpoint
CREATE TYPE "public"."qr_card_type" AS ENUM('RAW_BAG', 'VARIETY_PACK', 'WORKFLOW_TRAVELER', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."variety_run_status" AS ENUM('OPEN', 'CLOSED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."zoho_assembly_op_kind" AS ENUM('TABLET_RECEIVE', 'UNIT_ASSEMBLE', 'DISPLAY_ASSEMBLE', 'CASE_ASSEMBLE');--> statement-breakpoint
CREATE TYPE "public"."zoho_assembly_op_status" AS ENUM('PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'NEEDS_MAPPING', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."zoho_sync_kind" AS ENUM('CONNECTIVITY_CHECK', 'ITEMS', 'CUSTOMERS', 'SALES_ORDERS', 'PURCHASE_ORDERS', 'FINISHED_LOT_PUSH', 'INVOICES');--> statement-breakpoint
CREATE TYPE "public"."zoho_sync_run_status" AS ENUM('STARTED', 'SUCCESS', 'PARTIAL', 'FAILED');--> statement-breakpoint
ALTER TYPE "public"."packaging_material_kind" ADD VALUE 'BLISTER_CARD' BEFORE 'BLISTER_FOIL';--> statement-breakpoint
ALTER TYPE "public"."packaging_material_kind" ADD VALUE 'PVC_ROLL';--> statement-breakpoint
ALTER TYPE "public"."packaging_material_kind" ADD VALUE 'FOIL_ROLL';--> statement-breakpoint
ALTER TYPE "public"."packaging_material_kind" ADD VALUE 'SHRINK_BAND';--> statement-breakpoint
ALTER TYPE "public"."station_kind" ADD VALUE 'HANDPACK_BLISTER';--> statement-breakpoint
ALTER TYPE "public"."workflow_event_type" ADD VALUE 'HANDPACK_BLISTER_COMPLETE' BEFORE 'SEALING_COMPLETE';--> statement-breakpoint
ALTER TYPE "public"."workflow_event_type" ADD VALUE 'BAG_RELEASED' BEFORE 'SUBMISSION_CORRECTED';--> statement-breakpoint
ALTER TYPE "public"."workflow_event_type" ADD VALUE 'BAG_PICKED_UP' BEFORE 'SUBMISSION_CORRECTED';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blister_material_standards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid,
	"packaging_material_id" uuid NOT NULL,
	"material_role" text NOT NULL,
	"expected_grams_per_blister" numeric(10, 4),
	"expected_blisters_per_kg" numeric(10, 3),
	"setup_waste_grams" integer DEFAULT 0 NOT NULL,
	"changeover_waste_grams" integer DEFAULT 0 NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_code" text NOT NULL,
	"name" text NOT NULL,
	"zoho_customer_id" text,
	"nexus_customer_id" text,
	"supplier_lot_visible" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_inventory_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_system_id" uuid NOT NULL,
	"external_item_id" text NOT NULL,
	"item_code" text,
	"item_name" text,
	"quantity_on_hand" numeric(20, 6),
	"quantity_available" numeric(20, 6),
	"unit_of_measure" text,
	"warehouse_name" text,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_item_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_system_id" uuid NOT NULL,
	"external_item_id" text NOT NULL,
	"external_item_code" text,
	"external_item_name" text,
	"luma_item_id" uuid,
	"luma_product_id" uuid,
	"material_item_id" uuid,
	"mapping_type" text DEFAULT 'UNKNOWN' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_systems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finished_lot_invoice_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"finished_lot_id" uuid NOT NULL,
	"shipment_finished_lot_id" uuid,
	"quantity_allocated" numeric(20, 6) NOT NULL,
	"unit" text,
	"confidence" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'SUGGESTED' NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finished_lot_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finished_lot_id" uuid NOT NULL,
	"output_type" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit" text DEFAULT 'each' NOT NULL,
	"trace_code_printed" text,
	"print_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finished_lot_packaging_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finished_lot_id" uuid NOT NULL,
	"packaging_lot_id" uuid NOT NULL,
	"material_id" uuid,
	"quantity_used" numeric(20, 6),
	"unit" text,
	"confidence" text NOT NULL,
	"source" text NOT NULL,
	"first_used_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finished_lot_qc_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finished_lot_id" uuid NOT NULL,
	"workflow_event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finished_lot_raw_bags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finished_lot_id" uuid NOT NULL,
	"inventory_bag_id" uuid NOT NULL,
	"workflow_bag_id" uuid,
	"quantity_consumed_pills" integer,
	"quantity_consumed_weight" numeric(20, 6),
	"weight_unit" text,
	"confidence" text NOT NULL,
	"source" text NOT NULL,
	"derived_from_event_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid,
	"route_id" uuid,
	"parent_item_id" uuid NOT NULL,
	"child_item_id" uuid NOT NULL,
	"parent_quantity" numeric(20, 6) NOT NULL,
	"parent_unit_of_measure" text NOT NULL,
	"parent_pack_level" text NOT NULL,
	"child_quantity" numeric(20, 6) NOT NULL,
	"child_unit_of_measure" text NOT NULL,
	"child_pack_level" text NOT NULL,
	"effective_from" date DEFAULT now() NOT NULL,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"item_category" text NOT NULL,
	"default_unit_of_measure" text NOT NULL,
	"source_kind" text,
	"source_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "material_inventory_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "material_inventory_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_type" "material_event_type" NOT NULL,
	"packaging_material_id" uuid NOT NULL,
	"packaging_lot_id" uuid,
	"product_id" uuid,
	"workflow_bag_id" uuid,
	"machine_id" uuid,
	"station_id" uuid,
	"actor_user_id" uuid,
	"quantity_units" integer,
	"quantity_grams" integer,
	"unit_of_measure" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'system' NOT NULL,
	"client_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operation_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"requires_timer" boolean DEFAULT false NOT NULL,
	"requires_counter" boolean DEFAULT false NOT NULL,
	"requires_machine" boolean DEFAULT false NOT NULL,
	"requires_materials" boolean DEFAULT false NOT NULL,
	"output_unit" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_component_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"route_id" uuid,
	"component_item_id" uuid NOT NULL,
	"component_role" text NOT NULL,
	"quantity_per_finished_unit" numeric(20, 6) NOT NULL,
	"unit_of_measure" text NOT NULL,
	"effective_from" date DEFAULT now() NOT NULL,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_material_compatibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"route_id" uuid,
	"material_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"compatibility_role" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"default_for_product" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_route_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"is_default" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" date DEFAULT now() NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "production_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quality_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"check_type" text NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_bag_allocation_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "raw_bag_allocation_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"allocation_session_id" uuid,
	"inventory_bag_id" uuid NOT NULL,
	"workflow_bag_id" uuid,
	"po_id" uuid,
	"product_id" uuid,
	"route_id" uuid,
	"finished_lot_id" uuid,
	"event_type" text NOT NULL,
	"quantity" numeric(20, 6),
	"unit_of_measure" text DEFAULT 'tablets' NOT NULL,
	"quantity_source" text,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" text DEFAULT 'MEDIUM' NOT NULL,
	"missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_bag_allocation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventory_bag_id" uuid NOT NULL,
	"po_id" uuid,
	"workflow_bag_id" uuid,
	"product_id" uuid,
	"route_id" uuid,
	"finished_lot_id" uuid,
	"component_role" text,
	"allocation_status" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"opened_by_user_id" uuid,
	"closed_by_user_id" uuid,
	"starting_balance_qty" integer,
	"starting_balance_source" text,
	"ending_balance_qty" integer,
	"ending_balance_source" text,
	"consumed_qty" integer,
	"consumed_qty_source" text,
	"unit_of_measure" text DEFAULT 'tablets' NOT NULL,
	"confidence" text DEFAULT 'LOW' NOT NULL,
	"notes" text,
	"variety_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_item_weight_standards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tablet_type_id" uuid NOT NULL,
	"sample_source" text,
	"standard_unit_weight" numeric(12, 6) NOT NULL,
	"weight_unit" text DEFAULT 'g' NOT NULL,
	"effective_from" date DEFAULT now() NOT NULL,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"confidence" text DEFAULT 'MEDIUM' NOT NULL,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_material_consumption_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"packaging_material_id" uuid NOT NULL,
	"packaging_lot_id" uuid,
	"product_id" uuid,
	"machine_id" uuid,
	"station_id" uuid,
	"estimated_consumed_units" integer DEFAULT 0 NOT NULL,
	"actual_consumed_units" integer,
	"estimated_consumed_grams" integer DEFAULT 0 NOT NULL,
	"actual_consumed_grams" integer,
	"unit_of_measure" text NOT NULL,
	"variance_qty" integer,
	"variance_pct" numeric(7, 3),
	"confidence" text DEFAULT 'MEDIUM' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_material_lot_state" (
	"packaging_lot_id" uuid PRIMARY KEY NOT NULL,
	"packaging_material_id" uuid NOT NULL,
	"material_kind" text NOT NULL,
	"lot_number" text,
	"roll_number" text,
	"status" "material_lot_status" NOT NULL,
	"initial_quantity" integer,
	"current_quantity_estimate" integer,
	"initial_weight_grams" integer,
	"current_weight_grams_estimate" integer,
	"unit_of_measure" text NOT NULL,
	"consumed_estimated" integer DEFAULT 0 NOT NULL,
	"consumed_actual" integer,
	"adjusted_quantity" integer DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone,
	"confidence" text DEFAULT 'HIGH' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_material_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"material_code" text NOT NULL,
	"material_name" text NOT NULL,
	"product_id" uuid,
	"product_name" text,
	"product_sku" text,
	"compatibility_role" text,
	"current_on_hand" numeric(20, 6),
	"accepted_inventory" numeric(20, 6),
	"projected_demand" numeric(20, 6),
	"projected_shortage_quantity" numeric(20, 6),
	"recommended_order_quantity" numeric(20, 6),
	"needed_by_date" date,
	"confidence" text NOT NULL,
	"severity" text NOT NULL,
	"reason" text NOT NULL,
	"source_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sendable_to_packtrack" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"last_send_error" text,
	"sent_at" timestamp with time zone,
	"last_sent_response" jsonb,
	"superseded_by" uuid,
	"recommended_supplier_hint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_material_reconciliation_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"material_item_id" uuid,
	"packaging_lot_id" uuid,
	"raw_bag_id" uuid,
	"po_id" uuid,
	"product_id" uuid,
	"unit_of_measure" text NOT NULL,
	"declared_value" numeric(20, 6),
	"declared_confidence" text NOT NULL,
	"declared_source" text,
	"declared_missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counted_value" numeric(20, 6),
	"counted_confidence" text NOT NULL,
	"counted_source" text,
	"counted_missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accepted_value" numeric(20, 6),
	"accepted_confidence" text NOT NULL,
	"accepted_source" text,
	"accepted_missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consumed_estimated_value" numeric(20, 6),
	"consumed_estimated_confidence" text NOT NULL,
	"consumed_estimated_source" text,
	"consumed_estimated_missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consumed_actual_value" numeric(20, 6),
	"consumed_actual_confidence" text NOT NULL,
	"consumed_actual_source" text,
	"consumed_actual_missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scrapped_or_damaged_value" numeric(20, 6),
	"scrapped_or_damaged_confidence" text NOT NULL,
	"scrapped_or_damaged_source" text,
	"scrapped_or_damaged_missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"on_hand_value" numeric(20, 6),
	"on_hand_confidence" text NOT NULL,
	"on_hand_source" text,
	"on_hand_missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"receipt_variance_value" numeric(20, 6),
	"receipt_variance_confidence" text NOT NULL,
	"receipt_variance_severity" text NOT NULL,
	"cycle_count_variance_value" numeric(20, 6),
	"cycle_count_variance_confidence" text NOT NULL,
	"cycle_count_variance_severity" text NOT NULL,
	"consumption_variance_value" numeric(20, 6),
	"consumption_variance_confidence" text NOT NULL,
	"consumption_variance_severity" text NOT NULL,
	"unknown_variance_value" numeric(20, 6),
	"unknown_variance_confidence" text NOT NULL,
	"unknown_variance_severity" text NOT NULL,
	"overall_confidence" text NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_material_usage_learning" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid,
	"route_id" uuid,
	"packaging_material_id" uuid NOT NULL,
	"material_role" text NOT NULL,
	"machine_id" uuid,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"total_blisters_produced" bigint,
	"total_actual_weight_used_grams" integer,
	"avg_weight_per_blister" numeric(10, 4),
	"median_weight_per_blister" numeric(10, 4),
	"p90_weight_per_blister" numeric(10, 4),
	"last_sample_at" timestamp with time zone,
	"confidence" text DEFAULT 'MISSING' NOT NULL,
	"missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'LEARNED' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_roll_usage" (
	"packaging_lot_id" uuid PRIMARY KEY NOT NULL,
	"roll_number" text,
	"material_kind" text NOT NULL,
	"material_role" text,
	"machine_id" uuid,
	"mounted_at" timestamp with time zone,
	"unmounted_at" timestamp with time zone,
	"starting_weight_grams" integer,
	"ending_weight_grams" integer,
	"expected_used_grams" integer,
	"actual_used_grams" integer,
	"variance_grams" integer,
	"variance_pct" numeric(7, 3),
	"blisters_produced" integer,
	"projected_remaining_grams" integer,
	"projected_blisters_remaining" integer,
	"confidence" text DEFAULT 'MEDIUM' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE IF NOT EXISTS "route_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"operation_type_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"stage_key" text NOT NULL,
	"next_stage_key" text,
	"rework_stage_key" text,
	"allowed_station_kind" text,
	"allowed_machine_kind" text,
	"requires_scan" boolean DEFAULT true NOT NULL,
	"requires_counter" boolean DEFAULT false NOT NULL,
	"requires_timer" boolean DEFAULT false NOT NULL,
	"output_unit" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "route_quality_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_operation_id" uuid NOT NULL,
	"quality_check_id" uuid NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "route_station_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_operation_id" uuid NOT NULL,
	"station_id" uuid,
	"machine_id" uuid,
	"station_kind" text,
	"machine_kind" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shipment_finished_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"finished_lot_id" uuid NOT NULL,
	"customer_id" uuid,
	"quantity" integer,
	"unit" text,
	"shipped_at" timestamp with time zone,
	"notes" text,
	"nexus_sent_at" timestamp with time zone,
	"nexus_last_sent_response" jsonb,
	"nexus_last_send_error" text,
	"invoice_allocation_status" text DEFAULT 'UNALLOCATED' NOT NULL,
	"last_invoice_allocation_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "station_operator_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"employee_id" uuid,
	"employee_name_snapshot" text NOT NULL,
	"accountability_source" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"opened_by_user_id" uuid,
	"closed_by_user_id" uuid,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_dashboard_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"board_key" text DEFAULT 'floor-command' NOT NULL,
	"layout_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "udc_user_board_unique" UNIQUE("user_id","board_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "variety_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_scan_token" text NOT NULL,
	"variety_qr_card_id" uuid,
	"product_id" uuid,
	"status" "variety_run_status" DEFAULT 'OPEN' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zoho_assembly_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finished_lot_id" uuid NOT NULL,
	"op_kind" "zoho_assembly_op_kind" NOT NULL,
	"zoho_item_id" text,
	"quantity" integer NOT NULL,
	"status" "zoho_assembly_op_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"zoho_reference_id" text,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"last_error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"resolved_manually" boolean DEFAULT false NOT NULL,
	"resolved_note" text,
	"resolved_by_user_id" uuid,
	"source_inventory_bag_id" uuid,
	"source_po_line_id" uuid,
	"source_tablet_type_id" uuid,
	"component_role" text,
	"op_sequence" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zoho_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zoho_invoice_id" uuid NOT NULL,
	"zoho_invoice_line_id" text,
	"zoho_item_id" text,
	"sku" text,
	"item_name" text NOT NULL,
	"description" text,
	"quantity" numeric(20, 6) NOT NULL,
	"unit" text,
	"rate" numeric(20, 6),
	"amount" numeric(20, 4),
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zoho_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zoho_invoice_id" text NOT NULL,
	"invoice_number" text NOT NULL,
	"zoho_customer_id" text,
	"customer_id" uuid,
	"invoice_date" date,
	"status" text,
	"currency" text,
	"subtotal" numeric(20, 4),
	"total" numeric(20, 4),
	"balance" numeric(20, 4),
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zoho_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_type" "zoho_sync_kind" NOT NULL,
	"status" "zoho_sync_run_status" DEFAULT 'STARTED' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zoho_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_type" text NOT NULL,
	"external_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	"source_hash" text,
	"status" text DEFAULT 'SEEN' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "read_operator_daily_day_operator_unique";--> statement-breakpoint
ALTER TABLE "read_operator_daily" ALTER COLUMN "operator_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "employee_code" text;--> statement-breakpoint
ALTER TABLE "finished_lots" ADD COLUMN "trace_code" text;--> statement-breakpoint
ALTER TABLE "finished_lots" ADD COLUMN "packed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "finished_lots" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "finished_lots" ADD COLUMN "finished_lot_code_alias" text;--> statement-breakpoint
ALTER TABLE "finished_lots" ADD COLUMN "packtrack_consumption_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "finished_lots" ADD COLUMN "packtrack_consumption_error" text;--> statement-breakpoint
ALTER TABLE "inventory_bags" ADD COLUMN "bag_qr_code" text;--> statement-breakpoint
ALTER TABLE "inventory_bags" ADD COLUMN "internal_receipt_number" text;--> statement-breakpoint
ALTER TABLE "inventory_bags" ADD COLUMN "declared_pill_count" integer;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "target_bags_per_hour" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "status" "material_lot_status" DEFAULT 'AVAILABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "roll_number" text;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "gross_weight_grams" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "tare_weight_grams" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "net_weight_grams" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "current_weight_grams_estimate" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "weight_unit" text DEFAULT 'g';--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "width_mm" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "thickness_microns" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "material_spec" text;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "core_weight_grams" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "supplier" text;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "scan_token" text;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "confidence" text DEFAULT 'HIGH';--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "declared_quantity" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "counted_quantity" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "accepted_quantity" integer;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "box_number" text;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "supplier_lot_number" text;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "packtrack_po_id" text;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "packtrack_receipt_id" text;--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "source_system" "packaging_receipt_source";--> statement-breakpoint
ALTER TABLE "packaging_lots" ADD COLUMN "received_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "packaging_materials" ADD COLUMN "category" "packaging_item_category" DEFAULT 'PACKAGING' NOT NULL;--> statement-breakpoint
ALTER TABLE "packaging_materials" ADD COLUMN "min_order_quantity" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "packaging_materials" ADD COLUMN "safety_buffer_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "packaging_materials" ADD COLUMN "order_multiple" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "product_packaging_specs" ADD COLUMN "waste_allowance_percent" numeric(5, 2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "zoho_item_id_unit" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "zoho_item_id_display" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "zoho_item_id_case" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "daily_unit_goal" integer;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "is_tablet_po" boolean;--> statement-breakpoint
ALTER TABLE "qr_cards" ADD COLUMN "card_type" "qr_card_type" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "read_bag_state" ADD COLUMN "rework_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "read_bag_state" ADD COLUMN "rework_received" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "read_bag_state" ADD COLUMN "has_correction" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "read_operator_daily" ADD COLUMN "employee_id" uuid;--> statement-breakpoint
ALTER TABLE "read_operator_daily" ADD COLUMN "damage_events_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "read_operator_daily" ADD COLUMN "rework_sent_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "read_operator_daily" ADD COLUMN "rework_received_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "read_operator_daily" ADD COLUMN "scrap_units_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "read_operator_daily" ADD COLUMN "corrections_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "receives" ADD COLUMN "po_line_id" uuid;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "blister_material_standards" ADD CONSTRAINT "blister_material_standards_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "blister_material_standards" ADD CONSTRAINT "blister_material_standards_packaging_material_id_packaging_materials_id_fk" FOREIGN KEY ("packaging_material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "blister_material_standards" ADD CONSTRAINT "blister_material_standards_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_inventory_snapshots" ADD CONSTRAINT "external_inventory_snapshots_external_system_id_external_systems_id_fk" FOREIGN KEY ("external_system_id") REFERENCES "public"."external_systems"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_item_mappings" ADD CONSTRAINT "external_item_mappings_external_system_id_external_systems_id_fk" FOREIGN KEY ("external_system_id") REFERENCES "public"."external_systems"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_item_mappings" ADD CONSTRAINT "external_item_mappings_luma_item_id_items_id_fk" FOREIGN KEY ("luma_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_item_mappings" ADD CONSTRAINT "external_item_mappings_luma_product_id_products_id_fk" FOREIGN KEY ("luma_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_item_mappings" ADD CONSTRAINT "external_item_mappings_material_item_id_packaging_materials_id_fk" FOREIGN KEY ("material_item_id") REFERENCES "public"."packaging_materials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_invoice_allocations" ADD CONSTRAINT "finished_lot_invoice_allocations_invoice_line_id_zoho_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."zoho_invoice_lines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_invoice_allocations" ADD CONSTRAINT "finished_lot_invoice_allocations_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_invoice_allocations" ADD CONSTRAINT "finished_lot_invoice_allocations_shipment_finished_lot_id_shipment_finished_lots_id_fk" FOREIGN KEY ("shipment_finished_lot_id") REFERENCES "public"."shipment_finished_lots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_invoice_allocations" ADD CONSTRAINT "finished_lot_invoice_allocations_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_outputs" ADD CONSTRAINT "finished_lot_outputs_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_packaging_lots" ADD CONSTRAINT "finished_lot_packaging_lots_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_packaging_lots" ADD CONSTRAINT "finished_lot_packaging_lots_packaging_lot_id_packaging_lots_id_fk" FOREIGN KEY ("packaging_lot_id") REFERENCES "public"."packaging_lots"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_packaging_lots" ADD CONSTRAINT "finished_lot_packaging_lots_material_id_packaging_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_qc_events" ADD CONSTRAINT "finished_lot_qc_events_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_qc_events" ADD CONSTRAINT "finished_lot_qc_events_workflow_event_id_workflow_events_id_fk" FOREIGN KEY ("workflow_event_id") REFERENCES "public"."workflow_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_raw_bags" ADD CONSTRAINT "finished_lot_raw_bags_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_raw_bags" ADD CONSTRAINT "finished_lot_raw_bags_inventory_bag_id_inventory_bags_id_fk" FOREIGN KEY ("inventory_bag_id") REFERENCES "public"."inventory_bags"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_raw_bags" ADD CONSTRAINT "finished_lot_raw_bags_workflow_bag_id_workflow_bags_id_fk" FOREIGN KEY ("workflow_bag_id") REFERENCES "public"."workflow_bags"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "finished_lot_raw_bags" ADD CONSTRAINT "finished_lot_raw_bags_derived_from_event_id_workflow_events_id_fk" FOREIGN KEY ("derived_from_event_id") REFERENCES "public"."workflow_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_conversions" ADD CONSTRAINT "item_conversions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_conversions" ADD CONSTRAINT "item_conversions_route_id_production_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."production_routes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_conversions" ADD CONSTRAINT "item_conversions_parent_item_id_items_id_fk" FOREIGN KEY ("parent_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_conversions" ADD CONSTRAINT "item_conversions_child_item_id_items_id_fk" FOREIGN KEY ("child_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_inventory_events" ADD CONSTRAINT "material_inventory_events_packaging_material_id_packaging_materials_id_fk" FOREIGN KEY ("packaging_material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_inventory_events" ADD CONSTRAINT "material_inventory_events_packaging_lot_id_packaging_lots_id_fk" FOREIGN KEY ("packaging_lot_id") REFERENCES "public"."packaging_lots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_inventory_events" ADD CONSTRAINT "material_inventory_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_inventory_events" ADD CONSTRAINT "material_inventory_events_workflow_bag_id_workflow_bags_id_fk" FOREIGN KEY ("workflow_bag_id") REFERENCES "public"."workflow_bags"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_inventory_events" ADD CONSTRAINT "material_inventory_events_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_inventory_events" ADD CONSTRAINT "material_inventory_events_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_inventory_events" ADD CONSTRAINT "material_inventory_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_component_requirements" ADD CONSTRAINT "product_component_requirements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_component_requirements" ADD CONSTRAINT "product_component_requirements_route_id_production_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."production_routes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_component_requirements" ADD CONSTRAINT "product_component_requirements_component_item_id_items_id_fk" FOREIGN KEY ("component_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_material_compatibility" ADD CONSTRAINT "product_material_compatibility_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_material_compatibility" ADD CONSTRAINT "product_material_compatibility_route_id_production_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."production_routes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_material_compatibility" ADD CONSTRAINT "product_material_compatibility_material_id_packaging_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_route_assignments" ADD CONSTRAINT "product_route_assignments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_route_assignments" ADD CONSTRAINT "product_route_assignments_route_id_production_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."production_routes"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_events" ADD CONSTRAINT "raw_bag_allocation_events_allocation_session_id_raw_bag_allocation_sessions_id_fk" FOREIGN KEY ("allocation_session_id") REFERENCES "public"."raw_bag_allocation_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_events" ADD CONSTRAINT "raw_bag_allocation_events_inventory_bag_id_inventory_bags_id_fk" FOREIGN KEY ("inventory_bag_id") REFERENCES "public"."inventory_bags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_events" ADD CONSTRAINT "raw_bag_allocation_events_workflow_bag_id_workflow_bags_id_fk" FOREIGN KEY ("workflow_bag_id") REFERENCES "public"."workflow_bags"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_events" ADD CONSTRAINT "raw_bag_allocation_events_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_events" ADD CONSTRAINT "raw_bag_allocation_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_events" ADD CONSTRAINT "raw_bag_allocation_events_route_id_production_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."production_routes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_events" ADD CONSTRAINT "raw_bag_allocation_events_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_events" ADD CONSTRAINT "raw_bag_allocation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_sessions" ADD CONSTRAINT "raw_bag_allocation_sessions_inventory_bag_id_inventory_bags_id_fk" FOREIGN KEY ("inventory_bag_id") REFERENCES "public"."inventory_bags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_sessions" ADD CONSTRAINT "raw_bag_allocation_sessions_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_sessions" ADD CONSTRAINT "raw_bag_allocation_sessions_workflow_bag_id_workflow_bags_id_fk" FOREIGN KEY ("workflow_bag_id") REFERENCES "public"."workflow_bags"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_sessions" ADD CONSTRAINT "raw_bag_allocation_sessions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_sessions" ADD CONSTRAINT "raw_bag_allocation_sessions_route_id_production_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."production_routes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_sessions" ADD CONSTRAINT "raw_bag_allocation_sessions_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_sessions" ADD CONSTRAINT "raw_bag_allocation_sessions_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_sessions" ADD CONSTRAINT "raw_bag_allocation_sessions_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_bag_allocation_sessions" ADD CONSTRAINT "raw_bag_allocation_sessions_variety_run_id_variety_runs_id_fk" FOREIGN KEY ("variety_run_id") REFERENCES "public"."variety_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_item_weight_standards" ADD CONSTRAINT "raw_item_weight_standards_tablet_type_id_tablet_types_id_fk" FOREIGN KEY ("tablet_type_id") REFERENCES "public"."tablet_types"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_item_weight_standards" ADD CONSTRAINT "raw_item_weight_standards_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_consumption_daily" ADD CONSTRAINT "read_material_consumption_daily_packaging_material_id_packaging_materials_id_fk" FOREIGN KEY ("packaging_material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_consumption_daily" ADD CONSTRAINT "read_material_consumption_daily_packaging_lot_id_packaging_lots_id_fk" FOREIGN KEY ("packaging_lot_id") REFERENCES "public"."packaging_lots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_consumption_daily" ADD CONSTRAINT "read_material_consumption_daily_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_consumption_daily" ADD CONSTRAINT "read_material_consumption_daily_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_consumption_daily" ADD CONSTRAINT "read_material_consumption_daily_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_lot_state" ADD CONSTRAINT "read_material_lot_state_packaging_lot_id_packaging_lots_id_fk" FOREIGN KEY ("packaging_lot_id") REFERENCES "public"."packaging_lots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_recommendations" ADD CONSTRAINT "read_material_recommendations_material_id_packaging_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_recommendations" ADD CONSTRAINT "read_material_recommendations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_usage_learning" ADD CONSTRAINT "read_material_usage_learning_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_usage_learning" ADD CONSTRAINT "read_material_usage_learning_route_id_production_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."production_routes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_usage_learning" ADD CONSTRAINT "read_material_usage_learning_packaging_material_id_packaging_materials_id_fk" FOREIGN KEY ("packaging_material_id") REFERENCES "public"."packaging_materials"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_material_usage_learning" ADD CONSTRAINT "read_material_usage_learning_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_roll_usage" ADD CONSTRAINT "read_roll_usage_packaging_lot_id_packaging_lots_id_fk" FOREIGN KEY ("packaging_lot_id") REFERENCES "public"."packaging_lots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_roll_usage" ADD CONSTRAINT "read_roll_usage_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_station_quality_daily" ADD CONSTRAINT "read_station_quality_daily_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_station_quality_daily" ADD CONSTRAINT "read_station_quality_daily_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_station_quality_daily" ADD CONSTRAINT "read_station_quality_daily_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_operations" ADD CONSTRAINT "route_operations_route_id_production_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."production_routes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_operations" ADD CONSTRAINT "route_operations_operation_type_id_operation_types_id_fk" FOREIGN KEY ("operation_type_id") REFERENCES "public"."operation_types"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_quality_checks" ADD CONSTRAINT "route_quality_checks_route_operation_id_route_operations_id_fk" FOREIGN KEY ("route_operation_id") REFERENCES "public"."route_operations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_quality_checks" ADD CONSTRAINT "route_quality_checks_quality_check_id_quality_checks_id_fk" FOREIGN KEY ("quality_check_id") REFERENCES "public"."quality_checks"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_station_permissions" ADD CONSTRAINT "route_station_permissions_route_operation_id_route_operations_id_fk" FOREIGN KEY ("route_operation_id") REFERENCES "public"."route_operations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_station_permissions" ADD CONSTRAINT "route_station_permissions_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_station_permissions" ADD CONSTRAINT "route_station_permissions_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipment_finished_lots" ADD CONSTRAINT "shipment_finished_lots_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipment_finished_lots" ADD CONSTRAINT "shipment_finished_lots_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipment_finished_lots" ADD CONSTRAINT "shipment_finished_lots_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "station_operator_sessions" ADD CONSTRAINT "station_operator_sessions_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "variety_runs" ADD CONSTRAINT "variety_runs_variety_qr_card_id_qr_cards_id_fk" FOREIGN KEY ("variety_qr_card_id") REFERENCES "public"."qr_cards"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "variety_runs" ADD CONSTRAINT "variety_runs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "variety_runs" ADD CONSTRAINT "variety_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zoho_assembly_ops" ADD CONSTRAINT "zoho_assembly_ops_finished_lot_id_finished_lots_id_fk" FOREIGN KEY ("finished_lot_id") REFERENCES "public"."finished_lots"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zoho_assembly_ops" ADD CONSTRAINT "zoho_assembly_ops_source_inventory_bag_id_inventory_bags_id_fk" FOREIGN KEY ("source_inventory_bag_id") REFERENCES "public"."inventory_bags"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zoho_assembly_ops" ADD CONSTRAINT "zoho_assembly_ops_source_po_line_id_po_lines_id_fk" FOREIGN KEY ("source_po_line_id") REFERENCES "public"."po_lines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zoho_assembly_ops" ADD CONSTRAINT "zoho_assembly_ops_source_tablet_type_id_tablet_types_id_fk" FOREIGN KEY ("source_tablet_type_id") REFERENCES "public"."tablet_types"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zoho_invoice_lines" ADD CONSTRAINT "zoho_invoice_lines_zoho_invoice_id_zoho_invoices_id_fk" FOREIGN KEY ("zoho_invoice_id") REFERENCES "public"."zoho_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zoho_invoices" ADD CONSTRAINT "zoho_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "zoho_sync_runs" ADD CONSTRAINT "zoho_sync_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blister_material_standards_product_idx" ON "blister_material_standards" USING btree ("product_id","material_role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blister_material_standards_active_idx" ON "blister_material_standards" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_customer_code_unique" ON "customers" USING btree ("customer_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_zoho_idx" ON "customers" USING btree ("zoho_customer_id") WHERE zoho_customer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_nexus_idx" ON "customers" USING btree ("nexus_customer_id") WHERE nexus_customer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_active_idx" ON "customers" USING btree ("active") WHERE active = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_inventory_snapshots_system_item_idx" ON "external_inventory_snapshots" USING btree ("external_system_id","external_item_id","snapshot_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_inventory_snapshots_at_idx" ON "external_inventory_snapshots" USING btree ("snapshot_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_item_mappings_unique" ON "external_item_mappings" USING btree ("external_system_id","external_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_item_mappings_system_idx" ON "external_item_mappings" USING btree ("external_system_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_item_mappings_luma_item_idx" ON "external_item_mappings" USING btree ("luma_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_item_mappings_product_idx" ON "external_item_mappings" USING btree ("luma_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_systems_code_unique" ON "external_systems" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_line_idx" ON "finished_lot_invoice_allocations" USING btree ("invoice_line_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_lot_idx" ON "finished_lot_invoice_allocations" USING btree ("finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_shipment_lot_idx" ON "finished_lot_invoice_allocations" USING btree ("shipment_finished_lot_id") WHERE shipment_finished_lot_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_confidence_idx" ON "finished_lot_invoice_allocations" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_source_idx" ON "finished_lot_invoice_allocations" USING btree ("source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_status_idx" ON "finished_lot_invoice_allocations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_confirmed_idx" ON "finished_lot_invoice_allocations" USING btree ("confirmed");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_invoice_allocations_confirmed_at_idx" ON "finished_lot_invoice_allocations" USING btree ("confirmed_at") WHERE confirmed_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_outputs_lot_idx" ON "finished_lot_outputs" USING btree ("finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_outputs_type_idx" ON "finished_lot_outputs" USING btree ("output_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_outputs_trace_printed_idx" ON "finished_lot_outputs" USING btree ("trace_code_printed") WHERE trace_code_printed IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finished_lot_packaging_lots_unique" ON "finished_lot_packaging_lots" USING btree ("finished_lot_id","packaging_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_packaging_lots_lot_idx" ON "finished_lot_packaging_lots" USING btree ("finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_packaging_lots_lot_pkg_idx" ON "finished_lot_packaging_lots" USING btree ("packaging_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_packaging_lots_material_idx" ON "finished_lot_packaging_lots" USING btree ("material_id") WHERE material_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finished_lot_qc_events_pair_unique" ON "finished_lot_qc_events" USING btree ("finished_lot_id","workflow_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_qc_events_lot_idx" ON "finished_lot_qc_events" USING btree ("finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_qc_events_type_idx" ON "finished_lot_qc_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_qc_events_occurred_idx" ON "finished_lot_qc_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finished_lot_raw_bags_triple_unique" ON "finished_lot_raw_bags" USING btree ("finished_lot_id","inventory_bag_id","workflow_bag_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_raw_bags_lot_idx" ON "finished_lot_raw_bags" USING btree ("finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_raw_bags_bag_idx" ON "finished_lot_raw_bags" USING btree ("inventory_bag_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_raw_bags_workflow_idx" ON "finished_lot_raw_bags" USING btree ("workflow_bag_id") WHERE workflow_bag_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lot_raw_bags_confidence_idx" ON "finished_lot_raw_bags" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_conversions_product_idx" ON "item_conversions" USING btree ("product_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_conversions_route_idx" ON "item_conversions" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_conversions_parent_idx" ON "item_conversions" USING btree ("parent_item_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_conversions_child_idx" ON "item_conversions" USING btree ("child_item_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "items_item_code_unique" ON "items" USING btree ("item_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "items_source_unique" ON "items" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_category_idx" ON "items" USING btree ("item_category","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_source_idx" ON "items" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_events_lot_idx" ON "material_inventory_events" USING btree ("packaging_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_events_material_idx" ON "material_inventory_events" USING btree ("packaging_material_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_events_bag_idx" ON "material_inventory_events" USING btree ("workflow_bag_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_events_machine_idx" ON "material_inventory_events" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_events_type_occurred_idx" ON "material_inventory_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "operation_types_code_unique" ON "operation_types" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pcr_product_idx" ON "product_component_requirements" USING btree ("product_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pcr_component_idx" ON "product_component_requirements" USING btree ("component_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_material_compatibility_lookup_idx" ON "product_material_compatibility" USING btree ("product_id","scope","active") WHERE active = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_material_compatibility_default_unique" ON "product_material_compatibility" USING btree ("product_id","route_id","scope","compatibility_role") WHERE default_for_product = true AND active = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_material_compatibility_no_dupe" ON "product_material_compatibility" USING btree ("product_id","route_id","material_id","scope") WHERE active = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_material_compatibility_role_idx" ON "product_material_compatibility" USING btree ("compatibility_role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_route_assignments_product_idx" ON "product_route_assignments" USING btree ("product_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_route_assignments_route_idx" ON "product_route_assignments" USING btree ("route_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "production_routes_code_unique" ON "production_routes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quality_checks_code_unique" ON "quality_checks" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_events_bag_idx" ON "raw_bag_allocation_events" USING btree ("inventory_bag_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_events_session_idx" ON "raw_bag_allocation_events" USING btree ("allocation_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_events_po_idx" ON "raw_bag_allocation_events" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_events_product_idx" ON "raw_bag_allocation_events" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_events_finished_lot_idx" ON "raw_bag_allocation_events" USING btree ("finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_events_type_idx" ON "raw_bag_allocation_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_sessions_bag_idx" ON "raw_bag_allocation_sessions" USING btree ("inventory_bag_id","opened_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_sessions_po_idx" ON "raw_bag_allocation_sessions" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_sessions_product_idx" ON "raw_bag_allocation_sessions" USING btree ("product_id","allocation_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_sessions_workflow_idx" ON "raw_bag_allocation_sessions" USING btree ("workflow_bag_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rba_sessions_variety_run_idx" ON "raw_bag_allocation_sessions" USING btree ("variety_run_id") WHERE variety_run_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_item_weight_standards_lookup_idx" ON "raw_item_weight_standards" USING btree ("tablet_type_id","effective_from","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_material_consumption_daily_unique" ON "read_material_consumption_daily" USING btree ("day","packaging_material_id","packaging_lot_id","product_id","machine_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_consumption_daily_day_idx" ON "read_material_consumption_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_lot_state_status_idx" ON "read_material_lot_state" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_lot_state_material_idx" ON "read_material_lot_state" USING btree ("packaging_material_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_material_recommendations_recommendation_id_unique" ON "read_material_recommendations" USING btree ("recommendation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_material_recommendations_active_product_unique" ON "read_material_recommendations" USING btree ("material_id","product_id") WHERE product_id IS NOT NULL AND acknowledged_at IS NULL AND dismissed_at IS NULL AND superseded_by IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_material_recommendations_active_material_unique" ON "read_material_recommendations" USING btree ("material_id") WHERE product_id IS NULL AND acknowledged_at IS NULL AND dismissed_at IS NULL AND superseded_by IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recommendations_material_idx" ON "read_material_recommendations" USING btree ("material_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recommendations_product_idx" ON "read_material_recommendations" USING btree ("product_id") WHERE product_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recommendations_material_code_idx" ON "read_material_recommendations" USING btree ("material_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recommendations_confidence_idx" ON "read_material_recommendations" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recommendations_severity_idx" ON "read_material_recommendations" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recommendations_sendable_idx" ON "read_material_recommendations" USING btree ("sendable_to_packtrack") WHERE sendable_to_packtrack = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recommendations_generated_idx" ON "read_material_recommendations" USING btree ("generated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recommendations_expires_idx" ON "read_material_recommendations" USING btree ("expires_at") WHERE expires_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_recommendations_sent_idx" ON "read_material_recommendations" USING btree ("sent_at") WHERE sent_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_material_reconciliation_v2_scope_unique" ON "read_material_reconciliation_v2" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_reconciliation_v2_material_idx" ON "read_material_reconciliation_v2" USING btree ("material_item_id") WHERE material_item_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_reconciliation_v2_packaging_lot_idx" ON "read_material_reconciliation_v2" USING btree ("packaging_lot_id") WHERE packaging_lot_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_reconciliation_v2_raw_bag_idx" ON "read_material_reconciliation_v2" USING btree ("raw_bag_id") WHERE raw_bag_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_reconciliation_v2_po_idx" ON "read_material_reconciliation_v2" USING btree ("po_id") WHERE po_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_reconciliation_v2_overall_idx" ON "read_material_reconciliation_v2" USING btree ("overall_confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_usage_learning_lookup_idx" ON "read_material_usage_learning" USING btree ("packaging_material_id","material_role","product_id","machine_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_material_usage_learning_product_idx" ON "read_material_usage_learning" USING btree ("product_id","material_role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_roll_usage_machine_idx" ON "read_roll_usage" USING btree ("machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_station_quality_daily_unique" ON "read_station_quality_daily" USING btree ("day","machine_id","product_id","output_unit");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_station_quality_daily_day_idx" ON "read_station_quality_daily" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "route_operations_seq_unique" ON "route_operations" USING btree ("route_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_operations_route_idx" ON "route_operations" USING btree ("route_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_operations_stage_idx" ON "route_operations" USING btree ("route_id","stage_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_operations_operation_idx" ON "route_operations" USING btree ("operation_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "route_quality_checks_unique" ON "route_quality_checks" USING btree ("route_operation_id","quality_check_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_quality_checks_op_idx" ON "route_quality_checks" USING btree ("route_operation_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_station_permissions_op_idx" ON "route_station_permissions" USING btree ("route_operation_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shipment_finished_lots_pair_unique" ON "shipment_finished_lots" USING btree ("shipment_id","finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_finished_lots_shipment_idx" ON "shipment_finished_lots" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_finished_lots_lot_idx" ON "shipment_finished_lots" USING btree ("finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_finished_lots_customer_idx" ON "shipment_finished_lots" USING btree ("customer_id") WHERE customer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_finished_lots_nexus_sent_at_idx" ON "shipment_finished_lots" USING btree ("nexus_sent_at") WHERE nexus_sent_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_finished_lots_invoice_allocation_status_idx" ON "shipment_finished_lots" USING btree ("invoice_allocation_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_finished_lots_last_invoice_allocation_at_idx" ON "shipment_finished_lots" USING btree ("last_invoice_allocation_at") WHERE last_invoice_allocation_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "station_operator_sessions_active_unique" ON "station_operator_sessions" USING btree ("station_id") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "station_operator_sessions_employee_idx" ON "station_operator_sessions" USING btree ("employee_id") WHERE employee_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "station_operator_sessions_opened_idx" ON "station_operator_sessions" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variety_runs_token_status_idx" ON "variety_runs" USING btree ("parent_scan_token","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variety_runs_product_status_idx" ON "variety_runs" USING btree ("product_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "variety_runs_one_open_per_token_idx" ON "variety_runs" USING btree ("parent_scan_token") WHERE status = 'OPEN';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variety_runs_qr_card_idx" ON "variety_runs" USING btree ("variety_qr_card_id") WHERE variety_qr_card_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "zoho_assembly_ops_idem_unique" ON "zoho_assembly_ops" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_assembly_ops_lot_idx" ON "zoho_assembly_ops" USING btree ("finished_lot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_assembly_ops_status_idx" ON "zoho_assembly_ops" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_assembly_ops_inv_bag_idx" ON "zoho_assembly_ops" USING btree ("source_inventory_bag_id") WHERE source_inventory_bag_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_invoice_lines_invoice_idx" ON "zoho_invoice_lines" USING btree ("zoho_invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_invoice_lines_line_id_idx" ON "zoho_invoice_lines" USING btree ("zoho_invoice_line_id") WHERE zoho_invoice_line_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_invoice_lines_item_id_idx" ON "zoho_invoice_lines" USING btree ("zoho_item_id") WHERE zoho_item_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_invoice_lines_sku_idx" ON "zoho_invoice_lines" USING btree ("sku") WHERE sku IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "zoho_invoice_lines_invoice_line_id_unique" ON "zoho_invoice_lines" USING btree ("zoho_invoice_id","zoho_invoice_line_id") WHERE zoho_invoice_line_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "zoho_invoices_zoho_invoice_id_unique" ON "zoho_invoices" USING btree ("zoho_invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_invoices_invoice_number_idx" ON "zoho_invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_invoices_zoho_customer_id_idx" ON "zoho_invoices" USING btree ("zoho_customer_id") WHERE zoho_customer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_invoices_customer_id_idx" ON "zoho_invoices" USING btree ("customer_id") WHERE customer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_invoices_invoice_date_idx" ON "zoho_invoices" USING btree ("invoice_date") WHERE invoice_date IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_invoices_status_idx" ON "zoho_invoices" USING btree ("status") WHERE status IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_sync_runs_type_started_idx" ON "zoho_sync_runs" USING btree ("sync_type","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_sync_runs_status_idx" ON "zoho_sync_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "zoho_sync_state_object_external_unique" ON "zoho_sync_state" USING btree ("object_type","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_sync_state_last_seen_idx" ON "zoho_sync_state" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "zoho_sync_state_status_idx" ON "zoho_sync_state" USING btree ("status");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receives" ADD CONSTRAINT "receives_po_line_id_po_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."po_lines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employees_code_active_unique" ON "employees" USING btree ("employee_code") WHERE status = 'ACTIVE' AND employee_code IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finished_lots_trace_code_unique" ON "finished_lots" USING btree ("trace_code") WHERE trace_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lots_alias_idx" ON "finished_lots" USING btree ("finished_lot_code_alias") WHERE finished_lot_code_alias IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finished_lots_packed_at_idx" ON "finished_lots" USING btree ("packed_at") WHERE packed_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_bags_bag_qr_code_unique" ON "inventory_bags" USING btree ("bag_qr_code") WHERE bag_qr_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_bags_internal_receipt_idx" ON "inventory_bags" USING btree ("internal_receipt_number") WHERE internal_receipt_number IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "packaging_lots_status_idx" ON "packaging_lots" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "packaging_lots_packtrack_receipt_idx" ON "packaging_lots" USING btree ("packtrack_receipt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qr_cards_type_idx" ON "qr_cards" USING btree ("card_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_bag_state_rework_pending_idx" ON "read_bag_state" USING btree ("rework_pending") WHERE rework_pending = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_operator_daily_day_employee_unique" ON "read_operator_daily" USING btree ("day","employee_id") WHERE employee_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_operator_daily_day_code_legacy_unique" ON "read_operator_daily" USING btree ("day","operator_code") WHERE employee_id IS NULL AND operator_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_operator_daily_employee_idx" ON "read_operator_daily" USING btree ("employee_id") WHERE employee_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receives_po_line_idx" ON "receives" USING btree ("po_line_id") WHERE po_line_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_customer_idx" ON "shipments" USING btree ("customer_id") WHERE customer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_events_linked_event_idx" ON "workflow_events" USING btree ((payload->>'linked_event_id')) WHERE payload ? 'linked_event_id';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_linked_event_resolution_unique" ON "workflow_events" USING btree ((payload->>'linked_event_id'),"event_type") WHERE event_type IN ('SCRAP_RECORDED', 'REWORK_SENT') AND payload ? 'linked_event_id';