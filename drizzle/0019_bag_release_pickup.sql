-- Phase VALIDATION-2D — bag release + pickup workflow events.
--
-- BAG_RELEASED: a station hands the bag forward without finalizing.
-- Clears that station's read_station_live entry. Does NOT close the
-- workflow_bag and does NOT touch qr_cards (the card travels with the
-- bag through stations).
--
-- BAG_PICKED_UP: the next station scans the still-ASSIGNED card and
-- claims the bag. Updates that station's read_station_live entry but
-- never advances the bag's stage by itself.
--
-- ALTER TYPE ... ADD VALUE silently rolls back when bundled with other
-- DDL inside a single migration on populated DBs (drizzle/postgres-js
-- gotcha). This file therefore contains nothing else.

ALTER TYPE workflow_event_type ADD VALUE IF NOT EXISTS 'BAG_RELEASED';
ALTER TYPE workflow_event_type ADD VALUE IF NOT EXISTS 'BAG_PICKED_UP';
