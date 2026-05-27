# Luma — Architecture Reference

Living reference for developers and AI agents. Update when workflows or
deployment facts change. Wording stays factual — do not mark a flow
"complete" here unless it is verified in current `main`.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + React 19 |
| Language | TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Database | Postgres 16 via Drizzle ORM |
| Background jobs | pg-boss |
| Auth | Authentik OIDC (primary); Argon2id local password fallback |
| Styling | Tailwind v3 + shadcn primitives (vendored in repo) |
| Observability | OpenTelemetry → Prometheus `:9464`; optional OTLP traces |
| QR | `jsqr` + native `BarcodeDetector` on floor (HTTPS); `qrcode` server-side |
| Container | Multi-stage Dockerfile; docker compose on LXC 122 |
| Testing | Vitest |

---

## Deployment (current)

| Item | Value |
|---|---|
| App LXC | **122** — hostname `luma`, LAN `192.168.1.134` |
| Public URL | **https://luma.booute.duckdns.org** |
| Deploy mechanism | systemd timer → `git pull` on `/opt/luma` → `docker compose up -d --build` when HEAD changes |
| Postgres | sidecar on LXC 122 |
| Zoho Integration Service | **http://192.168.1.205:8000** (`ZOHO_INTEGRATION_URL`; LXC ID 9503 on Proxmox) |
| Authentik (SSO) | LXC 111 |
| Prometheus | LXC 112 — scrapes app metrics |
| Grafana | LXC 106 |
| Proxmox host | `192.168.1.190` |

Secrets: `/etc/luma/.env` on the LXC (mode `0600`). Never commit or print.

**Runtime version surface:** admin footer and floor footer read
`package.json` version plus `BUILD_GIT_SHA` / `BUILD_GIT_BRANCH`.
`GET /api/health` returns `{ status, checks, sha }` for deploy verification
(`npm run verify:deploy`).

---

## Directory map (important paths)

```
app/
  (admin)/              Office UI — Authentik OIDC + role gates
    receiving/raw-bags/ Receive pills (primary tablet intake)
    inbound/              Receives history; packaging receive; legacy wizard
    qr-cards/             QR card inventory
    products/             Products, BOM, tablet mappings, Zoho assembly IDs
    packaging-output/     Production output reporting
    zoho-operations/      Zoho assembly op queue UI
    floor-board/          Live command center (SSE)
    finished-lots/        Finished lots + genealogy
    batches/              Batch lifecycle
    machines/             Physical equipment
    settings/             Hub incl. Zoho gateway connectivity
  (floor)/floor/[token]/ Floor station PWA (station scan_token auth)
  api/
    health/               Deploy SHA + DB ping
    floor-board/          SSE for live board
    metrics/              Prometheus scrape
    integrations/         PackTrack / webhooks

lib/
  db/schema.ts            All tables (single file)
  db/queries/             Domain query modules
  projector/              Read-model rebuild from workflow_events
  production/             Floor/production helpers (not floor UI)
  zoho/                   Gateway clients, assembly planner, readiness helpers
  auth.ts / auth-guards.ts

scripts/
  migrate.ts, seed.ts
  audit-product-zoho-readiness.ts   Read-only product Zoho ID audit
  verify-deploy.ts                  Compare local HEAD to /api/health SHA
  rebuild-read-models.ts, replay-workflow-events.ts

docs/                   Project documentation (this file, phases, plans)
drizzle/                Migrations — additive-only discipline
deploy/lxc/             Server-side install/deploy helpers
```

---

## Key data concepts

### purchase_orders / po_lines

Inbound commercial structure synced from Zoho (via gateway). PO lines
describe what was ordered; receiving attaches bags to a line.

### receives

A `receive` records intake for a shipment / PO context. Tablet intake
at **Receive pills** creates receives linked to `inventory_bags` (and
optional `small_boxes`).

### inventory_bags

One physical bag of tablets: weight, batch link, `bag_qr_code` (the
assigned RAW_BAG card's **`scan_token`**). Read-model `bag_state` is
projected from `workflow_events`.

### qr_cards

Pre-printed laminate inventory. Types include **`RAW_BAG`** (per-bag
traveler), **`VARIETY_PACK`** (separate workflow — must not be assigned
to raw bags), and others.

**QR lifecycle (intended):**

1. Cards exist in inventory (typically `IDLE`).
2. Receive pills **assigns** a `RAW_BAG` card to a bag; card stays tied
   to that bag until a safe release path runs.
3. Floor scans the bag QR at a station.
4. **Labels must print `qr_cards.scan_token`.** `lookupCardByTokenAction`
   also accepts `qr_cards.id` as a backward-compatible fallback for
   legacy misprinted labels (remove fallback once labels are retired).

### batches

`batches` group tablet or packaging lots with status lifecycle
(QUARANTINE → RELEASED, holds, recall). Production refuses to start
when the input tablet batch is not **RELEASED**.

### products / product_allowed_tablets

`products` are finished SKUs (`kind`: CARD, BOTTLE, VARIETY). The
**`product_allowed_tablets`** join lists which `tablet_types` may feed a
product. Floor product pickers filter on this mapping — products with
no mapping do not narrow correctly for a scanned bag.

**Zoho product IDs** (`zoho_item_id_unit`, `zoho_item_id_display`,
`zoho_item_id_case`) are separate from tablet mappings. Required display/case
IDs depend on `units_per_display` and `displays_per_case`. Legacy
`zoho_item_id` may still exist; new intake should use unit column.
Classifier: `lib/zoho/product-zoho-readiness.ts`.

### stations vs machines

| Concept | Role |
|---|---|
| **Station** | Floor scan **location** — URL `/floor/[token]` where `token` = `stations.scan_token`. Not physical equipment. |
| **Machine** | Physical equipment record for attribution and reporting. |

Hand-pack and similar **station kinds** are scan points; they should not
be confused with blister/sealing **machines** in admin copy (see STATION-2
work in CHANGELOG).

### workflow_events

Append-only **source of truth** for production. Projector jobs (pg-boss,
`pg_notify`) maintain read models (`read_station_live`, `read_bag_state`,
`read_daily_throughput`, `read_material_burn`). No fold-on-read outside
the projector.

### finished_lots / finished_lot_inputs

Output lots and genealogy edges to input batches/bags. Created when bags
are finalized through the production workflow.

### zoho_assembly_ops

Queued assembly operations per finished lot (tablet receive, unit/display/case
assemble). Status includes `READY`, `NEEDS_MAPPING`, `SKIPPED`, etc.
Admin UI: `/zoho-operations`. Planning/dry-run: `lib/zoho/assembly-planner.ts`.
**Outbound execution stays gated** — live writes off unless deliberately enabled.

Older `zoho_pushes` may still exist for legacy paths; new assembly work
centers on `zoho_assembly_ops`.

---

## Floor workflow (current intent)

1. Operator opens **station URL** (bookmark per station).
2. Operator **scans bag QR** (camera primary on HTTPS; typed scan backup;
   dropdown is recovery-only).
3. Product may auto-select when exactly one mapped product matches bag
   tablet type + station kind rules.
4. Events append to `workflow_events`; board/SSE read models update.

**HTTPS is required** for `getUserMedia` / reliable camera scan on phones.
HTTP deploys cannot depend on camera as primary UX.

Station scan behavior is under active refinement — treat floor UI files
as high-conflict during parallel agent work.

---

## Product mapping and Zoho readiness

| Concern | Mechanism |
|---|---|
| Floor picker eligibility | `product_allowed_tablets` |
| Zoho composite item IDs | `products.zoho_item_id_{unit,display,case}` |
| Supervisor visibility | Product detail: floor readiness + Zoho readiness banners |
| Fleet audit | `npm run audit:product-zoho-readiness` (read-only, needs `DATABASE_URL`) |

---

## Auth model (cautious)

- **Admin:** Authentik OIDC session expected for `/admin/*` and related
  server actions. Role gates via `requireAdmin` and similar.
- **Floor:** station `scan_token` in URL; CSRF-exempt floor API pattern.
- Do not document middleware ordering as exhaustive here — verify in
  `middleware.ts` / `auth-guards.ts` when changing auth.

---

## Open design areas (not claimed complete)

- Station UX polish and camera scan reliability on production tablets
- Product / **brand** separation (brand often embedded in product names today)
- Saved receive **edit / audit** workflows
- Partial bag holding UX
- Variety-pack parent QR workflow end-to-end
- **Zoho live writes** disabled until deliberately enabled per environment
- Retiring QR `id` fallback after all labels encode `scanToken`

---

## System diagram

See `docs/architecture/luma-system-overview.mmd`.
