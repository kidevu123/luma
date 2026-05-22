# Luma — Architecture Reference

This document is a living reference for developers and AI agents working
in the Luma repo. Update it as workflows stabilise.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + React 19 |
| Language | TypeScript (strict — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Database | Postgres 16 via Drizzle ORM |
| Background jobs | pg-boss |
| Auth | Authentik OIDC (primary); Argon2id local password fallback |
| Styling | Tailwind v3 + shadcn primitives (copied into repo) |
| Observability | OpenTelemetry → Prometheus on port 9464; optional OTLP traces |
| QR decoding | jsqr (in-browser, camera) + `qrcode` (server-side generation) |
| Container | Single multi-stage Dockerfile; docker compose on LXC |
| Testing | Vitest |

---

## Directory map

```
app/
  (admin)/          Admin UI — all office-facing pages (OIDC-protected)
    batches/        Batch lifecycle management
    dashboard/      Operator dashboard
    floor-board/    Live production board (SSE-driven)
    finished-lots/  Finished lot list and genealogy
    inbound/        Inbound shipments, receives, inventory bags
    machines/       Machine admin
    packaging*/     Packaging material management and receipts
    products/       Product CRUD and tablet-type mappings
    production/     Pack-out / start-production pages
    qr-cards/       QR card inventory management
    receiving/      Receive pills workflow
    tablet-types/   Tablet type master data
    workflow-*/     Workflow submission review and validation
    zoho-operations/ Zoho push queue UI
  (auth)/           Login page
  (floor)/
    floor/[token]/  Floor station PWA — accessed via station token URL
  api/
    floor-board/    SSE endpoint for live board
    health/         Health + build SHA endpoint
    integrations/   Inbound webhooks / PackTrack integration
    metrics/        Prometheus metrics scrape endpoint
    nexus/          Read-only Nexus-facing endpoints

lib/
  db/
    schema.ts       Single Drizzle schema file — all tables
    index.ts        DB connection pool
    queries/        Per-domain query modules
    audit.ts        Audit log helpers
    compact.ts      DB utility helpers
  auth.ts           Session / OIDC helpers
  auth-guards.ts    Role-gating middleware helpers
  floor-command/    Floor event dispatch types and step groups
  inbound/          Inbound domain helpers (assembly planner etc.)
  legacy/           Read-only legacy SQLite ETL helpers
  metrics/          Prometheus metric definitions
  production/       Production event helpers
  projector/        pg-boss projector — listens on pg_notify, updates read models
  telemetry.ts      OTel bootstrap
  utils.ts          Shared utilities
  zoho/             Zoho gateway client (calls zoho-integration-service, never direct OAuth)

scripts/
  migrate.ts        Run Drizzle migrations
  seed.ts           Seed master data for local dev
  verify-deploy.ts  Compare local HEAD to running container's /api/health SHA
  repair-qr-inventory.ts  One-off QR inventory repair utility
  rebuild-read-models.ts  Force-rebuild all read-model projections
  replay-workflow-events.ts  Replay workflow events for projection repair
  synthesize-legacy.ts  ETL from legacy SQLite (read-only)

drizzle/            Migration files (journal + SQL) — do not edit by hand
docs/               All project documentation
deploy/lxc/         LXC-side deploy scripts (on the server, not bundled in the image)
```

---

## Key data concepts

### Inventory bags

An `inventory_bag` represents a single physical bag of tablets received
from a vendor. It has a weight, a batch assignment, and a current
`bag_state` maintained by the read-model projector.

### Receives / inbound records

A `receive` records the intake of a shipment for a purchase order line.
It links to `small_boxes` (optional) and to `inventory_bags`. Receiving
is where QR cards are assigned to physical bags.

### Batches

A `batch` groups a set of inventory bags under a single lot/batch
number (kind=TABLET) or a packaging lot (kind=PACKAGING). A batch has a
status lifecycle: QUARANTINE → RELEASED → (optional ON_HOLD, RECALLED).
Production refuses to start a workflow bag whose input batch is not
RELEASED.

### QR cards

`qr_cards` is an inventory of pre-printed QR cards managed by the
admin. Cards have a `card_type` and a `status`.

**Card types:**

| Type | Meaning |
|---|---|
| `RAW_BAG` | Assigned to an individual raw-material tablet bag |
| `VARIETY_PACK` | Used for variety-pack output tracking |
| `WORKFLOW_TRAVELER` | Tracks a bag through the floor workflow (may still need design cleanup) |
| `UNKNOWN` | Unclassified / legacy |

**Current QR lifecycle:**

1. QR cards are seeded into the system as inventory (idle/unassigned).
2. During Receive Pills, a `RAW_BAG` card is reserved and assigned to
   each physical bag.
3. That assigned card travels with the bag to the floor.
4. The floor station scans the assigned raw-bag QR — it should not
   accept idle/unassigned cards or `VARIETY_PACK` cards for this purpose.
5. The scan opens a workflow bag, and subsequent events are appended to
   `workflow_events`.

### Stations

A `station` represents a physical scan point on the floor (e.g. a
blister machine station, a sealing station, a packaging station). Each
station has a `scan_token` embedded in its URL. The floor PWA at
`/floor/[token]` authenticates purely from that URL token — no login
required on the floor device.

### Machines

A `machine` represents physical production equipment. Stations are
linked to machines, but the exact semantics of the
station-vs-machine relationship are still being refined (see open
questions below).

### Products and allowed tablet mappings

A `product` is a finished SKU. Products have a `product_allowed_tablets`
join to `tablet_types`, which controls which raw-bag tablet types can be
used to produce that product. This drives the product selection filter
on the floor station and the Start Production page.

### Workflow events (source of truth)

`workflow_events` is an append-only event log. It is the source of
truth for production state. Read models (`read_station_live`,
`read_bag_state`, `read_daily_throughput`, `read_material_burn`) are
maintained by a pg-boss projector that subscribes to
`pg_notify('workflow_events')`. Folds-on-read outside the projector
are forbidden.

### Zoho operations queue

`zoho_operations` holds queued pushes to Zoho Inventory / Books. All
Zoho calls go through the `zoho-integration-service` on a separate LXC
(never direct OAuth from this app). During current testing, live writes
are disabled by default.

---

## Current Start Production / floor station model

- **Admin Start Production** (`app/(admin)/production/`) is a
  supervisor fallback path for starting a workflow bag manually.
- **Normal production** should start from the floor station page
  (`/floor/[token]`): operator opens the station URL, which
  authenticates the station, then scans the bag's QR code.
- Product selection on the floor should be narrowed or auto-selected
  based on the bag's tablet type and the station type — the admin
  Start Production page should become less prominent once the floor
  station workflow is fully proven.

---

## Known open design questions / TODOs

- **Station vs machine cleanup** — the station/machine relationship
  has some semantic ambiguity that needs resolution.
- **Brand separation for products** — products may need brand-level
  grouping as the SKU list grows.
- **QR card management table** — needs better search, sorting, and
  bulk operations.
- **Camera scanning reliability on mobile HTTPS** — camera-based QR
  scanning must be verified to work consistently on iOS/Android floor
  tablets over HTTPS.
- **Start Production page prominence** — once floor station workflow is
  proven in production, the admin Start Production path should be
  demoted to a clearly-labelled fallback.
- **Product mapping UI / Zoho item IDs** — the product mapping UI
  should carry over Zoho item IDs consistently across edits.
- **Number inputs / mouse wheel** — number inputs in forms should
  not change value on mouse wheel scroll (accessibility / operator
  error prevention).
- **Keep this document current** — as workflows stabilise, update
  this file and the Mermaid diagram.

---

## Infrastructure summary

| Component | Location |
|---|---|
| App (LXC 122) | 192.168.1.134 — `luma` — docker compose |
| Postgres 16 | sidecar container on LXC 122 |
| Prometheus | LXC 112 — scrapes app:9464 |
| Grafana | LXC 106 |
| Authentik (SSO) | LXC 111 |
| Zoho integration service | LXC 9503 (192.168.1.205:8000 per docker-compose) |
| Proxmox host | 192.168.1.190 |

Secrets live in `/etc/luma/.env` (mode 0600) on the LXC. Never commit
or print them.

---

## System diagram

See `docs/architecture/luma-system-overview.mmd` for a Mermaid
flowchart of the end-to-end flow.
