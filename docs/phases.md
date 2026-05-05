# Luma — phased build + migration plan

## Phase 0 — foundation (DONE)

- LXC 122 provisioned. IP 192.168.1.134.
- Docker + git + node_exporter installed.
- Repo scaffolded: Next.js 15, Drizzle, Postgres, OTel, deploy unit.
- Six-context schema (`lib/db/schema.ts`) drafted.
- `/api/health` route ready.

## Phase 1 — schema + auth + admin shell

1. Generate first migration (`npm run db:generate`).
2. Bring stack up; verify `/api/health` green.
3. Authentik OIDC client (or temp local email + Argon2id seed: `admin@luma`).
4. Admin shell — sidebar with: Dashboard, Master data, Inbound,
   Batches, Production, Output, Settings.
5. Audit-log infrastructure (`lib/db/audit.ts`).
6. Prometheus + Grafana scrape job for `192.168.1.134:9464`.

## Phase 2 — master data + inbound

1. CRUD: tablet_types, products, machines, stations, packaging_materials.
2. BOM editor: `product_packaging_specs` per product, per scope (UNIT |
   DISPLAY | CASE).
3. PO sync from `zoho-integration-service` (read-only).
4. Receiving flow: shipment -> receive -> small_boxes -> inventory_bags
   with batch capture per box default + per-bag override.
5. Packaging lot intake — UI to log a new lot (qty, expiry, COA upload).

## Phase 3 — batches lifecycle

1. Batch list (filters: kind, status, expiry, on_hold).
2. Detail page with status transitions (QUARANTINE -> RELEASED via
   COA upload, ON_HOLD with reason, RECALLED).
3. Batch holds CRUD with mandatory reason + audit.
4. Batch genealogy view — for any batch, list finished lots that
   contain it (recursive read of `finished_lot_inputs`).
5. Recall query UI: "given batch X, which shipped lots are at risk?"

## Phase 4 — production event surface (the floor)

1. QR card admin: add/retire/release.
2. Station admin: kind, machine link, scan_token rotation.
3. Floor PWA at `/floor/*`:
   - Station auth via scan_token in URL.
   - Card scan -> create `workflow_bag`, fire CARD_ASSIGNED.
   - Stage event buttons: BLISTER_COMPLETE, SEALING_COMPLETE,
     PACKAGING_SNAPSHOT, BOTTLE_*.
   - Force-release card with reason (LEAD+ only).
4. Server-Sent Events endpoint streaming live board updates.
5. pg-boss projector worker that listens on `pg_notify('workflow_events')`
   and updates: `read_station_live`, `read_bag_state`,
   `read_daily_throughput`, `read_material_burn`. One row written per
   event, idempotent on `event.id`.
6. On `BAG_FINALIZED`: create `finished_lots` row + insert
   `finished_lot_inputs` (tablet batch from inventory_bag + packaging
   batches via BOM × FIFO over packaging_lots).

## Phase 5 — output (Zoho push)

1. Zoho push: when finished_lot enters RELEASED status, enqueue a
   pg-boss job that POSTs to `zoho-integration-service`.
2. Track in `zoho_pushes`. Retry with exponential backoff.
3. Admin override: re-push, mark resolved.

## Phase 6 — reporting + dashboards

1. Daily throughput page (read_daily_throughput).
2. Material burn alerts (read_material_burn vs `par_level`).
3. Grafana dashboard: bags/hour, machine utilization, station
   occupancy, scrap rate, material on-hand.
4. PDF reports via @react-pdf/renderer (mirrors payroll).

## Phase 7 — legacy ETL + dual-run cutover

1. Read-only ETL: pull a snapshot of the legacy SQLite, translate into
   the Luma Postgres. Idempotent re-runnable.
2. Single station (M1) on floor PWA. Both apps live, end-of-day
   reconciliation.
3. Expand floor coverage station-by-station as numbers match.
4. Office surface flips: receiving, materials, reports.
5. Cut-over. Legacy archived.
