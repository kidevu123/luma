-- P2-QUEUE-1 — per-bag queue read model. One row per active workflow
-- bag describing its NEXT destination and whether it is ready to move.
-- Maintained exclusively by the projector (lib/projector/bag-queue.ts);
-- rebuilt by scripts/rebuild-read-models.ts. Complements (does not
-- replace) read_queue_state, which is a per-stage aggregate.
CREATE TABLE IF NOT EXISTS "read_bag_queue" (
  "workflow_bag_id" uuid PRIMARY KEY
    REFERENCES "workflow_bags"("id") ON DELETE CASCADE,
  -- Where the bag goes next: SEALING_QUEUE, PACKAGING_QUEUE,
  -- BOTTLE_STICKER_QUEUE, BOTTLE_INDUCTION_QUEUE, FINISHED_GOODS_QUEUE.
  "queue_stage_key" text NOT NULL,
  -- Station kinds that may claim it there. Usually one; both bottle
  -- finishing kinds while neither finishing step has run (BOTTLE-ORDER-FLEX-1).
  "eligible_station_kinds" text[] NOT NULL,
  "product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "product_name" text,
  "bag_label" text NOT NULL,
  -- READY: prerequisite stage reached, bag can be worked on arrival.
  -- UPSTREAM_RUNNING: visible for overlap scanning; Complete stays gated.
  "ready_state" text NOT NULL,
  -- The station currently holding the bag (mirrors read_station_live);
  -- NULL once released and waiting in the queue.
  "claimed_by_station_id" uuid REFERENCES "stations"("id") ON DELETE SET NULL,
  "ready_at" timestamptz,
  -- When work started at the upstream station — ETA math input.
  "upstream_started_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "read_bag_queue_stage_idx"
  ON "read_bag_queue" ("queue_stage_key", "ready_state");
CREATE INDEX IF NOT EXISTS "read_bag_queue_claimed_idx"
  ON "read_bag_queue" ("claimed_by_station_id")
  WHERE "claimed_by_station_id" IS NOT NULL;

-- P2-BOTTLE-FLEX-1 — express BOTTLE-ORDER-FLEX-1 in route data.
-- STICKERING (seq 3) and INDUCTION_SEAL (seq 4) on the BOTTLE route run
-- in either order after fill; sequence alone cannot say so because of
-- route_operations_seq_unique. Operations sharing a non-null group are
-- order-independent among themselves.
ALTER TABLE "route_operations"
  ADD COLUMN IF NOT EXISTS "order_independent_group" text;

UPDATE "route_operations" ro
SET "order_independent_group" = 'BOTTLE_FINISHING'
FROM "production_routes" r, "operation_types" o
WHERE ro."route_id" = r."id"
  AND ro."operation_type_id" = o."id"
  AND r."code" = 'BOTTLE'
  AND o."code" IN ('STICKERING', 'INDUCTION_SEAL');
