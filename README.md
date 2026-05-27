# Luma

Production-floor traceability for Haute Nutrition. Tracks tablets from
purchase order through receiving, floor production, and finished-lot
output. Replaces TabletTracker with an event-sourced architecture,
batches as a first-class domain, and packaging-material genealogy.

**Deployed app (production):** [https://luma.booute.duckdns.org](https://luma.booute.duckdns.org)

## What Luma is for

Luma is the single-tenant operations system for pill manufacturing:
inbound tablet bags, QR-tracked floor production, finished-lot output,
and queued Zoho assembly operations. Office staff use the admin UI;
operators use floor station pages on tablets.

## Current high-level workflows

These flows exist in `main` today. Wording is intentionally cautious —
some areas (variety-pack parent QR, live Zoho writes) are still being
refined.

1. **Receive pills / raw tablet intake** — PO-driven intake at
   `/receiving/raw-bags`. Creates `receives`, `small_boxes` (when used),
   and `inventory_bags`. Each bag gets a **RAW_BAG** QR card assigned
   during intake (`inventory_bags.bag_qr_code` stores the card's
   `scan_token`).

2. **Receive packaging** — packaging material intake at
   `/inbound/packaging-materials` (separate from tablet receiving).
   The legacy wizard at `/inbound/new` is a supervisor fallback only.

3. **QR card inventory and assignment** — pre-printed cards in
   `qr_cards` (`RAW_BAG`, `VARIETY_PACK`, etc.). Admin manages stock at
   `/qr-cards`. **Printed bag labels must encode `qr_cards.scan_token`,
   not `qr_cards.id`.** Legacy labels may still resolve via an `id`
   fallback in floor lookup until reprinted.

4. **Product mapping / tablet mappings** — each `product` links to
   allowed tablet types via `product_allowed_tablets`. This drives floor
   product-picker narrowing. Zoho composite IDs (`zoho_item_id_unit`,
   `_display`, `_case`) are configured separately on the product detail
   page; see `npm run audit:product-zoho-readiness` for fleet readiness.

5. **Floor station scanning** — operators open the station URL
   (`/floor/[token]`, token = `stations.scan_token`), then scan the bag
   QR. **Camera scan is the primary path** when HTTPS is available;
   typed scan and dropdown selection are fallbacks. Production state
   is append-only in `workflow_events`; UIs read projected read models.

6. **Production output** — finished units and lots (`finished_lots`,
   `finished_lot_inputs`). Admin reporting at `/packaging-output`
   (labeled "Production output" in the UI).

7. **Zoho operations / dry-run readiness** — assembly work is modeled
   in `zoho_assembly_ops` and surfaced at `/zoho-operations`. All Zoho
   traffic goes through the **Zoho Integration Service**
   (`ZOHO_INTEGRATION_URL`, default `http://192.168.1.205:8000`).
   **Live Zoho writes remain disabled unless deliberately enabled** for
   the environment. Use dry-run planners and the readiness audit before
   enabling outbound usage.

8. **Authentik / SSO** — admin routes under `app/(admin)/` expect an
   Authentik OIDC session (primary). Local Argon2id password auth exists
   as a fallback path. Floor station pages authenticate via the station
   URL token, not SSO.

## App areas (selected)

| Area | Path |
|---|---|
| Admin app | `app/(admin)/` |
| Floor station PWA | `app/(floor)/floor/[token]/` |
| Receive pills | `app/(admin)/receiving/raw-bags/` |
| Receive packaging | `app/(admin)/inbound/packaging-materials/` |
| Receives history | `app/(admin)/inbound/` |
| QR cards | `app/(admin)/qr-cards/` |
| Products / BOM / mappings | `app/(admin)/products/` |
| Production output | `app/(admin)/packaging-output/` |
| Zoho operations queue | `app/(admin)/zoho-operations/` |
| Floor command center | `app/(admin)/floor-board/` |
| Finished lots | `app/(admin)/finished-lots/` |

## Local development

```bash
npm install
npm run dev          # requires DATABASE_URL, AUTH_SECRET, etc.
npm run typecheck
npm test
npm run build
```

Optional:

```bash
npm run verify:deploy
# LUMA_HOST=https://luma.booute.duckdns.org npm run verify:deploy

DATABASE_URL=postgres://... npm run audit:product-zoho-readiness
```

Environment variables are **not** committed. Use `.env.example` as a
starting point locally; production secrets live in `/etc/luma/.env` on
LXC 122 (mode `0600`).

## Version and deploy

- **Production host:** LXC 122 (`luma`, `192.168.1.134`). Public URL:
  `https://luma.booute.duckdns.org`.
- **Deploy:** a systemd timer on the LXC pulls `main` (~every 60s) and
  runs `docker compose up -d --build` when HEAD changes.
- **Build metadata:** admin footer and floor station footer show
  `package.json` version, git SHA, and branch (`BUILD_GIT_SHA`,
  `BUILD_GIT_BRANCH`). `/api/health` returns `sha` and DB connectivity
  (used by `npm run verify:deploy`).
- Do not push to `main` without clean `typecheck`, `test`, and `lint`.

## Safety rules for agents and developers

- **No direct Zoho OAuth or API calls from Luma** — use the Zoho
  Integration Service gateway only.
- **Do not enable live Zoho writes** or set `dry_run=false` without
  explicit environment sign-off.
- **Never commit or log secrets** (`/etc/luma/.env`, bearer tokens).
- **Do not bundle unrelated concurrent work** in one branch or commit.
- **Verify before claiming done:** `npm run typecheck`, `npm test`,
  `npm run build` (and staging checks when touching production paths).
- **Floor / QR / receive changes need extra care** — coordinate when
  another agent is active on station scan behavior.

## Further reading

- `docs/architecture.md` — stack, directories, data concepts, deployment
- `docs/architecture/luma-system-overview.mmd` — Mermaid system diagram
- `docs/phases.md` — phased build plan
- `docs/versioning.md` — version bump policy
- `CLAUDE.md` — project guardrails for AI agents
