# Luma

Production-floor traceability for Haute Nutrition. Tracks tablets from
purchase order through receiving, floor production, and finished-lot
output. Designed to replace TabletTracker with a clean event-sourced
architecture.

## What Luma does

1. **Receive pills / raw bags** — inbound shipments are received;
   inventory bags are created and weighed.
2. **Assign RAW\_BAG QR cards** — during receiving, each physical bag
   gets a QR card assigned to it. That card travels with the bag.
3. **Bags become available for floor production** — once a bag is
   received and its tablet batch is in RELEASED status, it can be
   picked up on the floor.
4. **Floor stations scan station URL / token, then scan bag QR** —
   operators open the station page (URL contains a station token),
   then scan the bag's QR code to start the workflow.
5. **Production events move the bag through the workflow** — events
   (BLISTER\_COMPLETE, SEALING\_COMPLETE, PACKAGING\_SNAPSHOT, etc.)
   are appended to `workflow_events` (append-only, source of truth).
   Read models are updated by a pg-boss projector.
6. **Pack-out / production output finalises units and lots** — when a
   bag is finalised, a `finished_lots` row is created and genealogy
   edges (`finished_lot_inputs`) link it to its input batches.
7. **Zoho operations are queued, not live-written** — Zoho pushes are
   enqueued in `zoho_operations` and executed via the
   `zoho-integration-service` on a separate LXC. During current
   testing, live Zoho writes are disabled by default.

## App areas

| Area | Path |
|---|---|
| Admin app | `app/(admin)/` |
| Floor station app | `app/(floor)/floor/[token]/` |
| Receiving | `app/(admin)/receiving/` |
| QR card management | `app/(admin)/qr-cards/` |
| Products / mappings | `app/(admin)/products/` |
| Tablet types | `app/(admin)/tablet-types/` |
| Inventory / bags / batches | `app/(admin)/inbound/`, `app/(admin)/batches/` |
| Floor board (live view) | `app/(admin)/floor-board/` |
| Finished lots | `app/(admin)/finished-lots/` |
| Production output | `app/(admin)/production/` |
| Zoho operations queue | `app/(admin)/zoho-operations/` |
| Packaging | `app/(admin)/packaging/`, `app/(admin)/packaging-inventory/` |

## Local development

```bash
# Install dependencies
npm install

# Run dev server (requires Postgres running locally or via Docker)
npm run dev

# Type check
npm run typecheck

# Run tests
npm test

# Build for production
npm run build

# Verify a running deploy matches local HEAD
npm run verify:deploy
# or
LUMA_HOST=http://192.168.1.134:3000 npm run verify:deploy
```

A `DATABASE_URL` and `AUTH_SECRET` environment variable are required.
Copy `.env.example` (if present) or configure `/etc/luma/.env` on the
LXC (mode 0600, never committed).

## Version and deploy

- The app footer displays the current version, git SHA, and branch,
  read from `package.json` and build-time env vars injected by the
  Dockerfile.
- Production is LXC 122 (`luma`, 192.168.1.134).
- Deploys are driven from `main`. A systemd timer checks for HEAD
  changes and runs `docker compose up -d --build` when the branch has
  moved.
- Do not push to `main` without passing typecheck and lint.

## Safety rules for agents and developers

- **All Zoho access must go through `zoho-integration-service`** on
  LXC 9503. No direct Zoho OAuth calls from this app.
- **Do not enable live Zoho writes** unless explicitly approved for
  the current environment.
- **Do not set `dry_run=false`** on Zoho operations without sign-off.
- **Never print or commit secrets.** Credentials live in
  `/etc/luma/.env` on the LXC.
- **Keep receiving / floor QR behaviour carefully tested** before any
  change to QR assignment or workflow event emission.

## Further reading

- `docs/phases.md` — phased build plan
- `docs/architecture.md` — tech stack, directory map, key concepts
- `docs/architecture/luma-system-overview.mmd` — Mermaid system
  diagram
- `docs/versioning.md` — version bump policy
- `CLAUDE.md` — project-level guardrails for AI agents
