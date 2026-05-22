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

- **QR Card Management table redesign** — ✅ Done in v0.2.20: Numeric sort (bag-card-1, bag-card-2, …, bag-card-200), enhanced search (label, token, receipt#, lot#), clearer assigned-to display ("Active workflow" / "Reserved at receive"), print labels page now only prints RAW_BAG idle cards. Compact list layout with tabs and stat tiles already in place.
- **QR Card Management variety-pack print labels** — Future: add a separate "Print idle variety pack labels" button and page. Currently the labels page only prints RAW_BAG idle cards.

## Documentation / onboarding

- **README.md needed** — Repo has no README. A minimal README should cover: what the system is, how to run locally (docker compose up, db migrate, seed), how to deploy (systemd timer on LXC 122), required environment variables, and links to key docs.
- **Architecture diagram needed** — Should cover all of the following so new engineers can orient without asking: deploy flow (git push → systemd pull → docker compose), branch strategy (work on main, deploy tag = HEAD), DB/migrations (Drizzle + drizzle-kit, migration files in lib/db/migrations), QR card lifecycle (IDLE → ASSIGNED/intake-reserved → ASSIGNED/active → IDLE on return), receive → production → finished lot → Zoho sync flow, Zoho Integration Service boundary (LXC 9503, never direct OAuth from Luma app), Authentik/session model (OIDC primary, Argon2id local fallback, role-gated office UI), and main app modules/pages (Inbound, Production, Batches, QR Cards, Settings, Floor PWA).
