# Luma Backlog

Items captured for future work. Not scheduled.

## Receive flow

- **Post-save receive editing screen** — After saving a raw bag intake, allow an admin to edit: QR scan token, weight, supplier lot, receipt number, notes. Each edit writes an audit_log entry. Useful when operator makes a typo and discovers it after save.
- **PO line item status should reflect Luma-side receive state** — Currently PO line status reflects Zoho status (to_be_received, partially_received, etc). Add a Luma-side received/intake state that tracks how many bags have been received against a PO line, independent of Zoho sync cadence.
- **Rename Purchase orders page to Shipments / Receives** — The table on the Purchase orders page shows receive records, not PO master data. Rename page title and nav label to "Shipments" or "Receives" to reduce operator confusion.

## Production UI

- **Consider renaming Packaging output to Production output** — "Packaging output" could be confused with packaging materials workflow. "Production output" or "Tablet production output" is more accurate for the blister/sealing/packaging station flow.

## QR cards

- **QR Card Management further UX cleanup** — Search, filter, and stats tiles are functional but the page needs visual polish when the card count grows large. Consider pagination or virtual scroll. The "Assigned to" context added in v0.2.13 is a first step.
