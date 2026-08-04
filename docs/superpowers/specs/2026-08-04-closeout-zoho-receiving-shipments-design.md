# Closeout Zoho truth, closeout UX, bag-drawer consistency, receiving by shipment

Date: 2026-08-04
Branch: `sandbox/ux-closeout-receiving` (deployed continuously to CT 123
`luma-sandbox`, 192.168.1.215, which runs a copy of the prod DB)
Status: approved by Sahil 2026-08-04

## Context

Four issues observed on the live system (screenshots reviewed 2026-08-04):

1. The PO closeout list shows 86 Active POs; the majority are already
   closed in Zoho. Luma computes Active/Closed purely from local bag
   state, so Zoho-closed POs never leave the Active tab.
2. The PO closeout detail header renders "PO PO-00206" (double "PO"),
   and the bag table has no sort or tablet filter.
3. The per-bag drawer shows contradictory guidance for a bag that is
   finalized and awaiting lot issue: it routes to the partial-bag
   path, offers a "Resolve remaining" form that reports "no open
   allocation session", links to the Partial Bag Workbench (which does
   not list the bag), and renders "Issue finished lot" as green text
   that is not actionable.
4. The Receives page lists one row per receive, and receives are
   created one per flavor, so a single 5-flavor shipment (PO-00206)
   reads as five unrelated rows.

## Decisions (locked with Sahil)

- **Zoho is the source of truth for PO closeout status.** A PO in a
  Zoho terminal state (closed / billed / cancelled) lands in the
  Closed tab regardless of leftover Luma bag state.
- **Suppress + flag pending output on Zoho-closed POs.** Pending Zoho
  output ops stop counting as open work and auto-commit skips them;
  the PO detail states "Closed in Zoho — N outputs were never pushed".
- **Real shipment entity for receiving.** The intake flow attaches
  receives to a shipment; the Receives page groups by shipment.
  Per-flavor receive records remain unchanged underneath.
- **Freshness: hourly Zoho PO sync + a manual "Refresh from Zoho"
  button** on the closeout page.

## 1. Closeout list reads Zoho

Current behavior (mapped in code):

- `luma-zoho-po-sync` (daily 03:59) maps Zoho status into the local
  enum `purchase_orders.status` (`lib/zoho/po-sync.ts:66-75`) with a
  terminal-status no-downgrade guard.
- `classifyPoCloseoutIndexBucket` (`lib/production/po-closeout.ts:351-381`)
  marks a PO Closed only when local status is RECEIVED/CLOSED **and**
  every received bag is done **and** no Zoho blockers. Ambiguity lands
  in Active by design.
- Many POs additionally sit at stale local `OPEN` even though Zoho has
  closed them — the sync itself is not updating them. Root cause to be
  diagnosed on the sandbox against the prod data copy (first
  implementation task; suspects: sync filter scope, terminal-status
  guard interaction, silent per-PO errors).

Changes:

- **Schema (additive only, per Drizzle migration rules):**
  `purchase_orders.zoho_status` (text, raw Zoho value verbatim) and
  `purchase_orders.zoho_status_synced_at` (timestamptz). The sync
  writes both on every run for every synced PO, independent of the
  mapped-enum guard. Raw value stored verbatim for data honesty; the
  mapped enum keeps its existing semantics.
- **Classifier:** `classifyPoCloseoutIndexBucket` gains a
  `zohoTerminal` input (true when `zoho_status` is one of the Zoho
  terminal states: received, closed, billed, cancelled — confirmed
  against live gateway data 2026-08-04: the raw field takes
  draft / issued / partially_received / received / cancelled across all
  87 synced POs; fully-received POs carry raw status "received", which
  is what Zoho presents as "closed"; "closed"/"billed" retained
  defensively for other Zoho variants). `zohoTerminal`
  forces the Closed bucket. Absence of `zoho_status` (never synced,
  e.g. manual POs) changes nothing: existing conservative logic
  applies. Missing is not treated as closed *or* open-in-Zoho.
- **Suppress + flag:** when `zohoTerminal`, pending Zoho output ops
  are excluded from open-work counts and Zoho blocker counts for that
  PO, and the auto-commit cron skips ops whose PO is Zoho-terminal
  (skip is logged in the op's status detail, not silently dropped).
  The PO detail page shows a banner: "Closed in Zoho — N outputs were
  never pushed to Zoho." Ops are left in their current status (not
  voided); nothing is destroyed.
- **List UI:** Closed-tab rows closed by Zoho (rather than by full
  Luma reconciliation) show a "Zoho" origin chip so the two kinds of
  Closed are distinguishable. The Active count therefore drops to POs
  with genuinely open work.
- **Sync cadence:** `luma-zoho-po-sync.timer` moves to hourly.
  A "Refresh from Zoho" button on the closeout list calls the existing
  sync path through `zoho-integration-service` (no new Zoho write
  paths, gateway only). The button is admin-only and rate-limited to
  one in-flight sync.

## 2. PO detail header + bag sort/filter

- Title in `app/(admin)/po-closeout/[poId]/page.tsx:189` changes from
  `` `PO ${summary.poNumber} — closeout` `` to
  `` `${summary.poNumber} — closeout` ``.
- The bag table gains a sort control: bag/receipt number (default,
  current order), tablet/flavor, date started, date completed, each
  asc/desc. `startedAt`/`finalizedAt`/`receivedAt` are already loaded;
  sorting is client-side over the loaded rows.
- A tablet/flavor filter chip row is added beside the existing status
  and production-state filter rows, listing the distinct flavors on
  the PO. Chips compose with the existing filters (AND semantics).

## 3. Bag drawer consistency (bug fix)

Root cause: for a bag with `finalizedAt` set, no finished lot, and no
open allocation session, `classifyPoCloseoutRow` returns action
`RECORD_REMAINING_OR_CLOSE_PARTIAL`, which
`deriveApplicableBagActions` (`lib/production/bag-closeout-actions.ts:24-83`)
maps to the partial-resolution panel — contradicting its own "no open
allocation session" check.

Fix (single source of truth stays in the derivation layer):

- When a bag is finalized + awaiting lot + **no open allocation
  session**, the derived action is `ISSUE_FINISHED_LOT`. The drawer
  renders the existing issue-lot action (reusing the specialist
  endpoint — the drawer never grows its own mutation endpoints), the
  partial panel is not rendered, and "Issue finished lot" in the
  production summary becomes the actual button for that action.
- The partial path remains for bags that genuinely have an open
  allocation session.
- Checklist, "What's next", the drawer panels, and the Partial Bag
  Workbench listing all read the same derivation, so they cannot
  disagree; a unit test asserts drawer action == workbench eligibility
  for the finalized-awaiting-lot case.
- The bag-table column currently headed "Partial Bag Workbench"
  becomes a neutral "Go to" quick-link column, populated only when the
  derived action has a destination page.
- Acceptance check on sandbox: bag receipt 352283 on PO-00206 shows a
  working "Issue finished lot" action and no partial-bag artifacts.

## 4. Receiving grouped by shipment

Schema already has `shipments` (`lib/db/schema.ts:579-602`) and
nullable `receives.shipment_id`; both are currently unused by intake
and UI. No schema changes needed.

- **Intake:** the receive-pills flow gains one step: choose an open
  shipment for the selected PO or create one (carrier and tracking
  optional; the common case is one tap on "New shipment"). Each
  per-flavor submit creates the same receive records as today, now
  with `shipment_id` set. A shipment is "open" until its PO closes or
  a user marks it delivered-complete; the same shipment can be
  selected across multiple submits.
- **Receives page:** grouping becomes PO → shipment → per-flavor
  receive lines (collapsed by default). Shipment row shows: shipment
  label, flavor count, bag total, received date range, status.
  PO-00206 renders as one shipment row ("5 flavors · 55 bags").
- **Legacy receives** with null `shipment_id` group under an "Earlier
  receives" section per PO. No synthetic shipment records are
  fabricated; missing linkage is shown as missing.
- Traceability, bag/box records, and Zoho receive pushes are untouched.

## Out of scope

- Backfilling legacy receives into shipments.
- Any change to floor workflows, QR lifecycle, or finished-lot logic
  beyond the action-derivation fix.
- Zoho writes of any kind from the sandbox (all Zoho write paths are
  disabled there).

## Testing & rollout

- Unit tests: classifier Zoho-terminal cases (terminal, non-terminal,
  never-synced), suppress+flag counting, bag action derivation for
  finalized-awaiting-lot with/without open allocation session,
  receives grouping with mixed shipment/null-shipment data.
- Migration: additive-only, journal inspected first, verified on the
  sandbox DB (prod copy) before merge.
- Full `luma-test-build-deploy` closeout (typecheck, vitest, next
  build, auth smoke) before any push; branch auto-deploys to CT 123
  every 60s for visual verification against real data, including the
  stale-Zoho-status diagnosis and PO-00206's 55 bags.
- Merge to `main` as v1.29.0 (MINOR: new functionality) after sandbox
  verification.

## Infrastructure record (already provisioned)

- CT 123 `luma-sandbox` = restore of CT 122 snapshot backup
  (2026-08-04 11:53), fresh MAC, DHCP 192.168.1.215, `onboot=0`.
- Zoho timers disabled (`luma-zoho-auto-commit`, `luma-zoho-po-sync`);
  all `ZOHO_*_ENABLED` flags false, `ZOHO_DRY_RUN_WRITES_ENABLED=true`,
  `ZOHO_ALLOW_SCRIPT_COMMIT_BYPASS=false` in `/etc/luma/.env`.
- `luma-deploy.service` drop-in `zz-sandbox.conf` pins
  `LUMA_BRANCH=sandbox/ux-closeout-receiving`.
- Known limitation: `APP_URL` still points at the prod URL, so
  Authentik OIDC round-trips may land on prod; use direct
  IP:3000 access (or add a sandbox Authentik provider later).
