# Codex project briefing — Luma

Production-floor traceability for Haute Nutrition. Replaces TabletTracker
with a clean event-sourced architecture, batches as a first-class
domain, packaging-material consumption, and the same observability +
deploy stack as the payroll platform.

## What this repo is

Single-tenant pill-manufacturing operations system. Tracks tablets from
PO -> receiving -> raw bag -> blister/sealing/packaging machines ->
finished bottles or cards -> Zoho receive push. Adds packaging
material lots (bottles, caps, labels, foil, cases) with full BOM and
batch genealogy so every finished lot's pedigree is one query away.

## Tech stack (locked)

Next.js 15 (App Router) + React 19 + TypeScript strict
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
Postgres 16 via Drizzle. pg-boss for jobs. Argon2id for local password
hashing (Authentik OIDC primary). Tailwind v3 + shadcn primitives copied
in. OpenTelemetry -> Prometheus on port 9464, traces optional via OTLP.
Single multi-stage Dockerfile, deploys to LXC 122 (`luma`,
192.168.1.134) via systemd timer pulling `main`.

## Six bounded contexts

1. **Master data** — products, tablet_types, machines, stations,
   employees, packaging_materials, BOM (`product_packaging_specs`),
   `product_allowed_tablets`.
2. **Inbound** — purchase_orders, po_lines, shipments, receives,
   small_boxes, inventory_bags, packaging_lots.
3. **Batches & Lots** — batches (kind=TABLET|PACKAGING with status
   lifecycle), batch_holds, finished_lots, finished_lot_inputs (the
   genealogy edge).
4. **Production (event-sourced)** — qr_cards, workflow_bags,
   workflow_events (append-only, source of truth), stations.
5. **Output** — zoho_pushes (calls `zoho-integration-service` on LXC
   9503; never direct OAuth from this app).
6. **Read models** — read_station_live, read_bag_state,
   read_daily_throughput, read_material_burn. Refreshed by pg-boss
   projector jobs subscribed to `pg_notify` on workflow_events.

## Conventions (locked)

- **workflow_events is the source of truth.** Any UI that reads
  production state reads a read-model row. Folds-on-read are forbidden
  outside the projector.
- **Money/qty as integers.** Cents, milligrams, units of UoM. No floats.
- **Times are timestamptz.** Display tz is `company.timezone`.
- **Soft-delete only.** Nothing leaves the DB. Statuses + voidedAt
  flags everywhere.
- **Every batch has a status.** Production refuses to start a workflow
  bag whose input batch isn't RELEASED.
- **Every mutation writes audit_log.** Same pattern as payroll-rebuild.
- **No emoji anywhere.** UI uses Lucide icons + colored chips + text.

## Architecture cheatsheet

- Floor scans (`/floor/api/*`) -> CSRF-exempt, station_scan_token auth.
- Office UI (`/admin/*`) -> Authentik OIDC, role-gated.
- Floor PWA installable on iPad / Android tablets.
- Live boards via Server-Sent Events streamed from `pg_notify`.
- Reporting via read models + Grafana dashboards (Prometheus scrapes
  192.168.1.134:9464).

## Infrastructure

- Proxmox host: `root@192.168.1.190`. LXC 122 = `luma` =
  192.168.1.134.
- Deploy: systemd timer pulls `main` every 60s, runs
  `docker compose up -d --build` only when HEAD changed or stamp
  drifted (mirrors payroll's drift-detection pattern).
- Authentik (LXC 111) for SSO, Zoho integration service (LXC 9503),
  Prometheus (LXC 112), Grafana (LXC 106).

## What you (Codex) should do first

Read `docs/phases.md` and execute the phased migration. Phase 1 is
read-only ETL from the legacy SQLite. Phase 2 is single-station
dual-run on the new floor PWA. Phase 3 is office UI + materials.

## Hard guardrails

- Never write to the legacy SQLite. ETL is one-way (read-only).
- Never bypass `zoho-integration-service` for Zoho calls.
- Never push to `main` without typecheck + lint clean.
- Never commit secrets. They live in `/etc/luma/.env` mode 0600 on
  the LXC.
