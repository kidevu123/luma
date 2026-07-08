# PO Closeout One-Stop Workspace — Design

**Date:** 2026-07-08
**Status:** Approved by owner (brainstorming session)
**Baseline:** v1.24.2

## Problem

Closing out a PO today means jumping between PO Closeout, Partial Bag
Workbench, Production Output, Finished Lots, Zoho Production Operations,
Receive Detail, and Workflows — and searching several of them just to verify
numbers. Admins report all three pains equally: actions live elsewhere, data
verification is scattered, and there are too many small manual steps. Luma
should not be messy: one place to close out a PO, with everything visible and
every action in reach.

## Goal

`/po-closeout` becomes the single admin closeout workspace:

1. **Act in place** — partial-bag resolution, lot issue + release, Zoho
   preview/queue/retry, QR reservation repair, and the wrong-product/route
   correction wizard, all runnable from the bag row.
2. **Verify in place** — bag history/timeline, PO-level numbers cross-check,
   Zoho readiness detail (exact blockers), and the bag's admin-action audit
   trail, all in the row drawer.
3. **Guided mode** — a "Close this PO" run that batches the safe steps and
   walks the admin through the judgment steps one at a time.
4. **Cleaner nav** — the overlapping specialist pages are demoted to the
   collapsed Advanced group (kept, not deleted).

## Chosen approach (A — composition)

The drawer and guided mode **embed the existing forms and call the existing
server actions verbatim**. No new business logic, no action facade, no page
rebuild. Existing forms are extracted into embeddable components (props
`inventoryBagId`/`workflowBagId`/`onDone` instead of page assumptions); the
specialist pages render the same extracted components, so each form has
exactly one implementation used in two places. Guided mode is ordering +
presentation over the same components.

Rejected: **B** (new closeout server-action facade — a second door into the
same logic, drift risk) and **C** (task-inbox rebuild of the page — discards a
working, recently hardened surface; not incremental).

## Phase 1 — Bag drawer (v1.25.0)

### Data

New read-only loader `lib/db/queries/bag-closeout-detail.ts`:

```
loadBagCloseoutDetail(inventoryBagId) -> BagCloseoutDetail {
  summary          // existing BagProductionSummary (v1.24)
  timeline         // workflow events for the bag's runs (same loader the
                   // Workflows expand uses; capped at 50, newest first;
                   // includes corrections/recovery events)
  crossCheck       // ordered vs received vs produced vs remaining for this
                   // bag's PO line/flavor (reuses PO reconciliation derivation)
  zohoReadiness    // existing readiness evaluator verdict WITH its blocker
                   // list (e.g. "product missing zoho_item_id_display")
  adminActions     // audit_log rows targeting this bag / its workflows / its
                   // lot, filtered by action prefix (finished_lot.*,
                   // raw_bag_allocation.*, workflow_submissions.*,
                   // inventory_bag.*, qr_card.*, live_ops_repair.*), capped
                   // at 30, newest first
  applicableActions // derived from the row's classifier verdict: which
                   // action panels to render (fail-closed: unknown -> none)
}
```

Composes existing sources only; recomputes nothing; creates no new ledger.
Lazily loaded on drawer open via a server action (same pattern as
`loadBagEventsAction`), so page render cost is unchanged.

### Components

`app/(admin)/po-closeout/_drawer/`, one file per concern:

- `bag-drawer.tsx` — shell, lazy load, refetch-after-action
- `verify-panel.tsx` — summary + cross-check + timeline + audit (read-only)
- `partial-actions.tsx` — record remaining / use system-calculated / mark
  depleted / correct starting balance (embeds Partial Bag Workbench forms)
- `lot-actions.tsx` — auto-issue, release/hold (embeds Production Output /
  Finished Lots actions)
- `zoho-actions.tsx` — preview + queue / retry (embeds Zoho ops machinery;
  queueing keeps its explicit confirm)
- `qr-actions.tsx` — repair lost QR reservation (embeds Receive Detail action)
- `correction-launcher.tsx` — opens the v1.23 correction wizard for the bag

Each panel links to its specialist page ("open full page") for edge cases.
Server actions called are byte-identical to today's; only form components are
extracted/refactored to accept props.

## Liveness & correction propagation (guarantee)

- Every drawer read uses `unstable_noStore()`; detail is fetched fresh on
  every drawer open and refetched after every action. No caching anywhere in
  the closeout path.
- Corrections propagate by construction: the v1.23 correction service already
  synchronously reprojects read models, the lot, allocation, and the passport
  in one transaction, and every surface showing production numbers reads the
  same `BagProductionSummary` + read models. There is no second copy of the
  numbers to go stale.
- `AutoRefreshOnFocus` (v1.24.1) is additionally mounted on Receive Detail,
  Production Output, Partial Bag Workbench, and Finished Lots so any open tab
  re-pulls live data on focus.
- Every mutation re-checks eligibility inside its transaction (existing
  behavior), so a stale drawer/wizard can never apply an action against
  changed data — it re-evaluates and refuses with the current reason.

## Phase 2 — Guided "Close this PO" mode (v1.26.0)

Full-height overlay on the detail page, URL-addressable
(`?guided=1&step=n`) so refresh/back work.

1. **Step 0 — safe batch:** shows exactly what the existing PO-scoped
   auto-issue + auto-release batch services would do ("Issue 4 lots, release
   2 — nothing touches Zoho"), one confirm, runs them (each re-checks
   per-row), reports issued/skipped-with-reason.
2. **Steps 1..n — one unresolved bag per step,** dependency order:
   QR → floor → partial remaining → lot → QC → Zoho queue. DONE bags are
   skipped. Each step renders the Phase-1 verify panel + only the applicable
   action panel, headlined by the row's classifier reason. Floor-only steps
   (bag never started) render as "needs the floor — skip for now".
3. **Finish screen:** live rollup — done/remaining, what is still blocked and
   exactly why, with the honest note that the PO flips to Closed only when
   everything is resolved.

The queue is recomputed from live data at every step advance (never
snapshotted), so concurrent work makes steps disappear. Batching policy:
**batch safe, confirm risky** — auto-issue/auto-release in step 0; partials,
corrections, QR repairs, and Zoho queueing always get their own confirm.

## Phase 3 — Nav demotion (v1.27.0)

`lib/auth/admin-nav.ts` config change only:

- Reconciliation & output section becomes **"Close out POs"**
  (`/po-closeout`, minRole ADMIN) + **Traceability lookup**.
- Production Output, Partial Bag Workbench, Finished Lots, Zoho Production
  Ops, PO Reconciliation (+v2) move to the collapsed **Advanced** group with
  their current minRoles unchanged.
- No route deletions; bookmarks and cross-links keep working.
- v1.24.2 access-policy tests updated to pin the new placement; no role gains
  or losses anywhere.

## Safety rails (unchanged, restated)

- No auto Zoho commit — queueing stays an explicit per-decision confirm, even
  in guided mode.
- Guards identical to today: drawer/wizard call the same `requireAdmin`/
  `requireLead`-gated server actions.
- Page loads and drawer opens are strictly read-only.
- Every mutation writes its existing audit rows and revalidates the closeout
  paths (v1.24.1 machinery).
- Blocked actions show the classifier's exact reason; never a disabled
  mystery button; ambiguity fails closed to verify-only.

## Testing

- **Phase 1:** pure unit tests for `BagCloseoutDetail` composition and
  `applicableActions` derivation (fail-closed on unknown verdicts);
  structural tests that action panels call existing server actions only (no
  new mutation endpoints), that specialist pages render the same extracted
  components (single form implementation), and that drawer loaders are
  noStore + write-free.
- **Phase 2:** pure queue-derivation tests (dependency order, DONE skipped,
  floor-only marked skip, live recompute on advance); structural test that
  step 0 uses the existing batch actions.
- **Phase 3:** access-policy test updates (ADMIN sees "Close out POs";
  demoted pages keep routes + guards; MANAGER/LEAD/STAFF gain nothing).
- All existing suites stay green, modified only where placement is pinned.

## Rollout & verification

Three MINOR releases (≈1.25.0 / 1.26.0 / 1.27.0), each with the standard
gates (typecheck, typecheck:scripts, lint, full tests, build), CHANGELOG,
deploy via `luma-deploy`, health check, and read-only production
verification — including an end-to-end walkthrough on **PO-00238**, which
contains every case class (partials, over-consumed wrong-product bags,
NEEDS_MAPPING Zoho ops, multi-run bags).

## Success criteria

- A typical PO can be closed end-to-end without leaving `/po-closeout`.
- Every number an admin needs to verify a bag is visible in its drawer.
- Corrections applied anywhere appear on every Luma surface on next render,
  and open tabs self-refresh on focus.
- Specialist pages remain available under Advanced with unchanged behavior.
- No new business logic paths; all existing invariants and test suites keep
  protecting the same code.
