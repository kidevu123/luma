# Luma Backlog

Items captured for future work. Not scheduled.

## Receive flow

- **Post-save receive editing screen** — After saving a raw bag intake, allow an admin to edit: QR scan token, weight, supplier lot, receipt number, notes. Each edit writes an audit_log entry. Useful when operator makes a typo and discovers it after save.
- **PO line item status should reflect Luma-side receive state** — Currently PO line status reflects Zoho status (to_be_received, partially_received, etc). Add a Luma-side received/intake state that tracks how many bags have been received against a PO line, independent of Zoho sync cadence.
- **Rename Purchase orders page to Shipments / Receives** — The table on the Purchase orders page shows receive records, not PO master data. Rename page title and nav label to "Shipments" or "Receives" to reduce operator confusion.

## Production UI

- **Consider renaming Packaging output to Production output** — "Packaging output" could be confused with packaging materials workflow. "Production output" or "Tablet production output" is more accurate for the blister/sealing/packaging station flow.
- **Start Production: station/product validation on server** — `resolveStartProductionProduct` runs client-side for UX. The server action currently accepts any `productId` without re-checking station kind compatibility. Consider adding a server-side guard once station validation requirements are clearer (may never be needed since the action already checks product existence and bag availability).
- **Start Production: COMBINED station product grouping** — COMBINED stations currently show all candidate products without filtering. If operators commonly run COMBINED stations with mixed tablet types, add a secondary grouping or hint in the product picker.

## QR cards

- **QR Card Management further UX cleanup** — Search, filter, and stats tiles are functional but the page needs visual polish when the card count grows large. Consider pagination or virtual scroll. The "Assigned to" context added in v0.2.13 is a first step.
- **QR Card Management table redesign** — Current layout is a scrolling card list sorted by label. Needs: numeric/lexicographic sort (card-1, card-2 ... card-10 before card-9 aesthetically), compact row table instead of large cards, clearer "assigned to" inline context (partially addressed in v0.2.13), and a separate section or filter for UNKNOWN/legacy cards that have not been typed. QR type distribution summary (N RAW_BAG, N VARIETY_PACK, N WORKFLOW_TRAVELER, N UNKNOWN) useful for ops.

## Documentation / onboarding

- **README.md needed** — Repo has no README. A minimal README should cover: what the system is, how to run locally (docker compose up, db migrate, seed), how to deploy (systemd timer on LXC 122), required environment variables, and links to key docs.
- **Architecture diagram needed** — Should cover all of the following so new engineers can orient without asking: deploy flow (git push → systemd pull → docker compose), branch strategy (work on main, deploy tag = HEAD), DB/migrations (Drizzle + drizzle-kit, migration files in lib/db/migrations), QR card lifecycle (IDLE → ASSIGNED/intake-reserved → ASSIGNED/active → IDLE on return), receive → production → finished lot → Zoho sync flow, Zoho Integration Service boundary (LXC 9503, never direct OAuth from Luma app), Authentik/session model (OIDC primary, Argon2id local fallback, role-gated office UI), and main app modules/pages (Inbound, Production, Batches, QR Cards, Settings, Floor PWA).
