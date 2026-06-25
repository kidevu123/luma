# Luma Zoho PO sync cron — deploy + operations runbook

## Files in this directory

- `luma-zoho-po-sync.service` — systemd service unit (one-shot curl)
- `luma-zoho-po-sync.timer`   — systemd timer (daily at 03:59 US Eastern)

## What the cron does

Once per day at **03:59 US Eastern** (EST/EDT), the timer triggers the
service, which `POST`s to
`http://localhost:3000/api/cron/zoho-po-sync` with a bearer token.
The route:

1. Validates the bearer against `LUMA_CRON_SECRET`.
2. Checks `ZOHO_PO_SYNC_ENABLED=true` in the app env.
3. Calls `syncPurchaseOrdersFromZoho()` — the same apply path as the
   manual **Sync POs from Zoho** button on `/receiving/raw-bags`.
4. Writes one `zoho_sync_runs` row (`sync_type = PURCHASE_ORDERS`,
   `source = cron`, `dry_run = false`).
5. Writes one umbrella audit row and returns a JSON summary.

This is **read-only toward Zoho** (pull PO list + line details only).

## Required env

In `/etc/luma/.env` (mode 0600, read by the luma-app container):

```env
# Cron auth — same secret the systemd service uses
LUMA_CRON_SECRET=<generate-with-openssl-rand-base64-32>

# Master switch for the daily PO sync
ZOHO_PO_SYNC_ENABLED=true
```

On the LXC host (NOT inside the container), `/etc/luma/zoho-cron.env`
(mode 0600 root:root) must contain the same bearer secret:

```env
LUMA_CRON_SECRET=<same-secret-as-above>
```

## Install commands (on LXC 122 `luma`)

The LXC host clock must be **US Eastern**. On a fresh host (or if the
timer previously fired at the wrong hour while the clock was UTC):

```bash
sudo timedatectl set-timezone America/New_York
timedatectl   # should show Time zone: America/New_York (EST or EDT)
```

Then install the timer:

```bash
sudo cp /opt/luma/deploy/luma-zoho-po-sync.service /etc/systemd/system/
sudo cp /opt/luma/deploy/luma-zoho-po-sync.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now luma-zoho-po-sync.timer
```

Verify the timer fires at 03:59 **US Eastern**:

```bash
sudo systemctl list-timers luma-zoho-po-sync.timer --no-pager
# NEXT should read … 03:59:00 EDT (or EST in winter), not UTC
```

## Verification commands

```bash
# Trigger a one-off run
sudo systemctl start luma-zoho-po-sync.service

# Last run output
sudo journalctl -u luma-zoho-po-sync.service -n 20 --no-pager

# Direct curl test
sudo bash -c 'set -a; source /etc/luma/zoho-cron.env; set +a; \
  curl -s -X POST \
    -H "Authorization: Bearer $LUMA_CRON_SECRET" \
    -H "Content-Type: application/json" \
    http://127.0.0.1:3000/api/cron/zoho-po-sync'
```

Expected response when enabled and Zoho is reachable:

```json
{
  "ok": true,
  "summary": {
    "enabled": true,
    "status": "success",
    "result": { "fetched": 12, "poUpserted": 12, ... }
  }
}
```

When `ZOHO_PO_SYNC_ENABLED` is not `true`:

```json
{
  "ok": true,
  "summary": {
    "enabled": false,
    "status": "skipped",
    "skippedReason": "ZOHO_PO_SYNC_ENABLED is not 'true'."
  }
}
```

## Rollback / disable

```bash
# Stop the timer immediately
sudo systemctl disable --now luma-zoho-po-sync.timer

# Or flip the master switch without touching systemd
# ZOHO_PO_SYNC_ENABLED=false in /etc/luma/.env
# docker compose up -d app
```

The manual **Sync POs from Zoho** button on `/receiving/raw-bags`
continues to work regardless of the cron switch.
