# Production Engine Phase 1 — staging smoke checklist

Run on LXC 122 after deploying the Phase 1 branch. Phase 1 ships zero
operator-visible change, so every item below is a "nothing moved" check
except the last two, which verify the DB behaviours the test suite
cannot reach.

## Zero-change checks
- [ ] Open a BLISTER station URL. The screen is identical to the
      pre-deploy screenshot: same panels, same order, same wording.
- [ ] Open a SEALING station URL. Same.
- [ ] Open a PACKAGING station URL. Same.
- [ ] A station with no open shift still shows the operator picker.

## Behaviour checks
- [ ] Complete a blister bag. The event lands, the count is right, the
      bag advances to BLISTERED.
- [ ] Seal a segment on a bag. Count and lane state unchanged from
      pre-deploy behaviour.
- [ ] Complete packaging on a bag. Cases/displays/loose all record, and
      packaging material consumption fires as before.
- [ ] Complete packaging on a bag via advanceBag: same cases/displays/loose
      counts and material consumption as the legacy packagingCompleteAction.
      Assert against zoho-side payload expectations unchanged.
      NOT EXECUTABLE until P4b wires a caller to advanceBag — do not check
      this box during P4a smoke; it belongs to the P4b run.
- [ ] A handpack blister completion still issues blister card material
      (this path moved into record-stage-event.ts — confirm it did not
      regress).
- [ ] A partial-sealing close-out still auto-releases.
- [ ] **Bottle finishing fires exactly once each.** On a bottle bag, fire
      cap-seal, then sticker (both succeed). Now re-fire either one: it
      must REFUSE with "This bag has already been cap-sealed." /
      "This bag has already been stickered." Guard moved to
      lib/production/engine/record-stage-event.ts:190-205; no CI test
      reaches it because it reads prior workflow_events.
- [ ] **First count needs an operator on shift.** With no shift open on a
      BLISTER station (and no employee override on the form), submit a
      first blister count. It must REFUSE with "No operator on shift...".
      Accountability throw moved to
      lib/production/engine/record-stage-event.ts:344-351.

## DB behaviours the test suite cannot verify
- [ ] **Idempotency.** Submit the same completion twice with the same
      clientEventId (double-tap the button, or replay the request).
      Exactly one workflow_event row exists. This depends on the partial
      unique index on (workflow_bag_id, event_type, client_event_id).
- [ ] **Concurrent claim.** Two stations scan the same queued bag at
      once. One wins; the other gets a clear message and no duplicate
      read_station_live row.

## Rollback (Phase 1)
If any behaviour check fails, revert the branch. The extraction in
Task 7 is the highest-risk change: record-stage-event.ts holds logic
that previously lived inside fireStageEventAction.

## Rollback (Phase 4b)

Phase 4b did not ship behind a feature flag. Rollback is a `git revert`
of the merge commit plus a redeploy — the systemd timer will pick up
the previous stamp on the next pull. There is no runtime toggle.

**Trigger criteria — any of these justifies a revert:**
- A normal operator flow is blocked with no More / Help path out
  (screen stuck without a scan-again, pause, or supervisor route).
- The screen records the wrong counts on a completed bag (counter values
  land in the wrong workflow_event column, or bag advances with a count
  the operator did not enter).
- Read models are empty and `npm run rebuild:read-models` (below) does
  not recover — the new screen renders entirely from read models and
  will show "No current work" everywhere without them.

**QA-hold rollback trap — DO THIS BEFORE REVERTING.**

QA holds land in v1.34 as a real event (`QA_HOLD_STARTED`) that sets
`read_bag_state.is_on_hold = true`. The v1.33 UI has NO code path that
sets or clears that column: any bag held under 1.34 will stay
`is_on_hold=true` after the revert and every station will refuse to
work it, with no operator path to release. Release every open hold
before rolling back:

```sql
-- Run on LXC 122's Postgres BEFORE the revert. Confirms the bags this
-- will re-open, then clears the column.
SELECT workflow_bag_id FROM read_bag_state WHERE is_on_hold = true;
UPDATE read_bag_state SET is_on_hold = false WHERE is_on_hold = true;
```

Skipping this leaves every held bag stranded until 1.34 (or a hand-
written UPDATE) returns.

## Deploy prerequisite — read models rebuild

Run `npm run rebuild:read-models` immediately after the Phase 4b
deploy lands. The new operator screen renders entirely from read
models (`read_station_live`, `read_bag_queue`); a bag in flight from
before the deploy has no queue row and will not appear in any
station's UP NEXT without a rebuild. This has been outstanding since
v1.31.0 — the rebuild is idempotent and finishes in seconds on a
healthy DB (abort and investigate if it runs past ~2 minutes; that
means the in-flight scope is not being applied).

## First-morning operator comms

Post on the floor before the first shift after the cutover:

- **The station screen changed.** One screen per station now — the
  panels are gone. What used to be many buttons is a single scan-first
  workflow.
- **Release and Finalize are gone (since 1.31).** The bag advances on
  its own once a stage completes; there is no button to press.
- **Pause, Report problem, Enter code, End shift** all live under the
  More button in the top-right of the station screen.
- **Bagless machine-down cannot be filed on the screen.** Every Report
  Problem write today needs a bag pinned at the station — a
  machine-down report with no bag will not go through. Tell a
  supervisor in person until P5 ships the bagless path.

## Phase 2 (v1.31.0) — queue and auto-advance

Run these two FIRST, in order, before any floor behaviour check.

- [ ] **Migration landed the finishing group.** Immediately after the
      migration runs:
      `SELECT count(*) FROM route_operations WHERE order_independent_group = 'BOTTLE_FINISHING';`
      must return exactly `2`, and both rows must be on the BOTTLE route:
      `SELECT r.code, o.code FROM route_operations ro JOIN production_routes r
      ON r.id = ro.route_id JOIN operation_types o ON o.id =
      ro.operation_type_id WHERE ro.order_independent_group =
      'BOTTLE_FINISHING';` -> exactly two rows, both `BOTTLE`, one
      `STICKERING` and one `INDUCTION_SEAL`. Any other count means the
      order-independent finishing pair is wrong and bottle bags will queue
      to the wrong station — stop and fix before letting the floor scan.
- [ ] **Backfill the queue once, post-deploy.** Run
      `npm run rebuild:read-models` ONE time after the deploy. Bags already
      in flight when the deploy landed have no `read_bag_queue` row and will
      never appear in any station's `upNext` without it. Record the wall
      time of the run here: `________`. It replays only in-flight bags, so
      it should finish in seconds to well under two minutes; if it exceeds
      ~2 minutes, abort the smoke and investigate (a runtime that long means
      the in-flight scope is not being applied and the rebuild is walking
      finished history).

- [ ] Complete a blister bag: NO release button appears; the bag shows on a
      sealing tablet's queue as READY without any operator action.
- [ ] Scan-claim while upstream still runs (overlap): sealing can claim a
      STARTED bag; Complete stays blocked until blister finishes.
- [ ] Bottle fill complete: bag auto-releases; BOTH finishing stations see it
      queued. After one finishing step, only the other station sees it.
- [ ] Packaging complete on a pinned bag: finalizes with no button; the
      queue row disappears.
- [ ] The not-pinned finalize fallback still renders for a PACKAGED bag that
      is no longer current at the station.
- [ ] Sealing handoff button still present mid-bag (multi-sealer flow).
- [ ] `npm run rebuild:read-models` repopulates read_bag_queue to the same
      rows (spot-check one bag before/after).
- [ ] claimQueuedBag double-tap: same clientEventId twice -> one BAG_PICKED_UP.
- [ ] Two stations claim the same queued bag: one wins, the loser gets
      "Another station is already working on this bag."
- [ ] **Median-cycle SQL sanity.** For a product with 5+ recent bags at a
      station kind, `loadMedianCycleMinutesByProduct` returns a plausible
      number of minutes (not null, not negative, not absurdly large); a
      product with fewer than 5 recent bags gets `etaMinutes: null`.
- [ ] **Upstream-holder queue visibility.** A bag still being blistered
      (held by the blister station, whose kind is NOT in the sealing row's
      `eligible_station_kinds`) appears in the sealing station's `upNext`.
      A bag already claimed by a second SEALING station (a true destination
      peer) does NOT appear in the first sealing station's `upNext`.
- [ ] **Concurrent same-kind claim.** Two stations of the SAME kind claim
      one queued bag at once. The loser's response carries blocker code
      `BAG_ALREADY_CLAIMED` ("Another station is already working on this
      bag.") — assert the code, not that the queue row is gone. The
      winner's claim REWRITES the row to the winner's downstream
      destination rather than deleting it; only `BAG_FINALIZED` deletes a
      queue row.
- [ ] **Two-sealer overlap, final close.** Sealer B overlap-claims a bag
      still being sealed on sealer A. Sealer A fires the final sealing
      close. Sealer B's station returns to the scan form immediately
      (stale sibling pin auto-released) rather than staying stuck showing
      the now-finished bag. The sibling's `BAG_RELEASED` payload carries
      `auto_release_reason: "STALE_SIBLING_SEALING_PIN"` — check the event
      row, so the audit does not read as sealer A's operator releasing
      sealer B's bag.
- [ ] **Finishing re-claim is refused, station stays free.** Take a bottle
      bag whose sticker step has already run (bag at SEALED, waiting on
      cap-seal or packaging) and scan its card at the SAME sticker station.
      The pickup is REFUSED with a message naming what remains — "This bag
      has already been stickered here — it is waiting for cap-sealing."
      (or "...waiting for packaging." once both finishing steps are done).
      The station is NOT pinned: it returns to the scan form and can
      immediately claim the next bag. Repeat at a cap-seal station whose
      cap-seal already fired. Before the fix this pinned the station with
      no exit — complete refused, no release or finalize button — until
      packaging finalized the bag.

## Phase 3 (v1.32.0) — realtime

- [ ] Two tablets, blister + sealing: complete a bag at blister; the sealing
      tablet's queue updates within ~2s with NO touch.
- [ ] Unrelated station (e.g. BOTTLE_STICKER) does NOT refresh on that event
      (watch the network tab: no router.refresh fetch).
- [ ] Bad token: GET /floor/api/stream/<garbage-uuid> returns 404 with no
      station-existence oracle (inactive station also 404).
- [ ] Kill the app server mid-connection; tablet falls back to 60s polling,
      then reconnects SSE within ~60s of the server returning.
- [ ] Admin floor-board stream still works (payload extension is additive).
- [ ] SSE connection count: with N tablets open, `SELECT count(*) FROM
      pg_stat_activity WHERE query LIKE '%LISTEN%'` stays at 1 (one bus
      connection per process, not per tablet).
- [ ] Inactive-station page does not self-recover when re-activated (pre-existing; reload the tablet manually after re-activating a station).
- [ ] Two sealers + one bag: pickup at sealer A clears the bag from sealer
      B's pickup list within ~2s (the same-kind arm's payoff).
- [ ] Pause a STARTED bag at blister; the sealing tablet's pickup list updates
      within ~2s (P4a: non-flow events carry stationKind via process cache,
      gap (a) closed). Reload confirms truth.

## Phase 4b (v1.34.0) — THE OPERATOR SCREEN

Per-station-kind operator-screen render and workflow checklist:

- [ ] **Blister station:** open shift (operator picker) → station shows name + "No current work" → scan/enter bag QR → SCAN_TO_CLAIM state with camera + UP NEXT queue + "Enter code manually" option → claim picks bag → COMPLETE state shows "Blister count:" counter input field + DONE button → enter count (e.g., 1000) + submit DONE → bag auto-advances to sealing queue without release button. Auto-advance occurs within ~2s on sealing tablet's upNext.

- [ ] **Sealing station:** open shift → SCAN_TO_CLAIM → claim → multi-segment workflow: COMPLETE with "Seal passes:" counter and "Pause" button under More → enter count (e.g., 500) + DONE → CONFIRM_BAG_EMPTY shows "[ Yes, bag empty ]" and "[ No, more to work ]" buttons. Answer "No" → returns to the COMPLETE counter for the next sealing run (station stays pinned to the bag). Answer "Yes" → bag auto-advances.

- [ ] **Packaging station:** open shift → SCAN_TO_CLAIM → claim → COMPLETE shows three counters: "Cases:", "Displays:", "Loose units:" (or "Loose cards:" if handpack product) → enter counts (e.g., 9, 25, 0) + DONE → if loose cards damaged ("[ Yes ]" / "[ No ]"), enter damaged count if yes → bag auto-finalizes, queue row disappears.

- [ ] **Handpack blister station:** same flow as blister (counter input "Blister count:"), but input emits HANDPACK_BLISTER_COMPLETE event.

- [ ] **Bottle-fill station:** COMPLETE with counter "Fill count:" → auto-releases to both finishing stations (stickering + cap-seal) if pinned.

- [ ] **PICK_PRODUCT (AUTO path):** Station with unambiguous product → scan bag → auto-submit happens silently, no PICK_PRODUCT case shown; bag proceeds directly to COMPLETE state.

- [ ] **PICK_PRODUCT (PICK path):** Product ambiguous (2-3 candidates by station kind) → scan bag → PICK_PRODUCT shows 2-3 filtered buttons (e.g., "Hyroxi MIT A", "Hyroxi MIT B") → select one → proceeds to COMPLETE.

- [ ] **Partial flow:** On a sealing bag mid-seal, under More → "Pause with reason" (reuse existing pause action) → reason dropdown → submit → bag pauses. On same station, scan the paused bag → "[ Why? ]" button (Help) under BLOCKED → shows pause reason in checklist. Resume via supervisor (P5 scope). Alternatively, under More → "Close sealing early" → sets sealing-close mode → COMPLETE counter now labeled "Final seal passes:" → enter count + DONE → CONFIRM_BAG_EMPTY (final yes/no) → if yes, bag advances; if no, cannot proceed (handoff to next sealer).

- [ ] **RESOLVE_PARTIAL confirmation:** On a partial-close bag, the sheet renders one of two lines above the counter — "Estimated remaining: <n> units" when the previous operator's partial-close carried a numeric estimate, or "System cannot confidently determine remaining quantity." when it did not. Both variants must appear on the rendered flow across the two cases (text matches operator-screen.tsx's PartialBag/PartialWorkflowBag components; there is no "system computed" label anywhere).

- [ ] **Exception workflow — six categories:**
  - [ ] Machine: click "Report problem" under More → "[ Machine ]" category → enter a short reason in the "What's wrong?" textarea (no machine picker — the machine is derived from the station's binding) → Send → attempts pauseBagAction (best-effort — silently no-ops with no bag pinned) AND emits DOWNTIME_STARTED. Bag shows on Act Now rail; stations see BLOCKED. Supervisor clears the downtime later (P5).
  - [ ] Quality: click "Report problem" → "[ Quality ]" → form optional fields (allow empty) → submits, emits QA_HOLD_STARTED event. Bag now shows BLOCKED "QA Hold: <detail or empty>". Supervisor can release hold (below).
  - [ ] Bag: click "Report problem" → "[ Bag ]" category → emits BAG_PAUSED (reuse action), bag shows paused reason.
  - [ ] Material: click "Report problem" → "[ Material ]" → brief reason text → emits PRODUCTION_EXCEPTION_RAISED, Act Now rail picks it up.
  - [ ] Product: click "Report problem" → "[ Product ]" → reason → emits PRODUCTION_EXCEPTION_RAISED.
  - [ ] Other: click "Report problem" → "[ Other ]" → reason → emits PRODUCTION_EXCEPTION_RAISED.

- [ ] **QA hold round-trip:** Once a QA_HOLD_STARTED bag exists (bag shows BLOCKED), verify supervisor (or ops) can release it. Under More or via supervisor unlock (scope: P5 inline PIN or supervisor session), "Release QA hold" option appears → click → bag returns to previous state (was at COMPLETE, goes back to COMPLETE; was at SCAN_TO_CLAIM goes to SCAN_TO_CLAIM). Emit QA_HOLD_RELEASED event. Re-scan bag at same station confirms it is no longer blocked.

- [ ] **Help checklist:** On BLOCKED state (or via "?" button anytime), the sheet renders `evaluateChecks()`'s output as a static pass/fail list — not a decision tree. Up to eight rows in this order: bag recognized, product recognized, station correct, materials available, previous step complete, not on hold, not paused, not finished. The three "bag-in-hand" rows (bag, product, station) are DROPPED on an idle SCAN_TO_CLAIM view and replaced with the note "No bag at this station yet." The first failing row's operator sentence appears in the amber footer, and [ Notify supervisor ] is DISABLED when no bag is pinned (helper text: "Scan the bag this is about first.").

- [ ] **Fresh-bag start at first-op stations:** Station is first-in-route (e.g., blister for a TABLET batch). Scan a bag that has no prior workflow_events → SCAN_TO_CLAIM shows no UPSTREAM_RUNNING holder (upNext is empty) → claim → COMPLETE (not skipped). Before engine, this path would have errored or skipped SCAN_TO_CLAIM. After, the station can start fresh bags.

- [ ] **End-shift counter:** Operator clicks "End shift" under More → counter shows total bags completed this shift (sum of final stage events, e.g., 3 blisters, 2 seals, 1 packaged) → message "Contact supervisor if count disagrees." Operator confirms/cancels.

- [ ] **sseSubscribers visible:** GET /api/health returns JSON with `sseSubscribers: <number>` field. Open two tablets on the same floor server → `sseSubscribers` shows 2. Close one → next /api/health call shows 1. Refresh confirms subscriber count matches open connections.

- [ ] **Packaging via COMBINED routing (preferOperation):** Combined station receives a bag with packaging inputs (cases/displays/loose). Engine picks PACKAGING operation (not BLISTER) from combined's available ops (verify via log or test). Packaging counter fields render, not blister segment. Inputs route to the packaging path, not blister-then-packaging.

- [ ] **Legacy panel deletion:** Verify the old `stage-action-buttons.tsx` and `scan-card-form.tsx` are no longer in the main page render path. Main page code under ~200 lines. If those files still exist, they are only used by other routes (e.g., rolls page) or deleted. Scanner tests for those panels have been deleted or replaced by engine tests.

- [ ] **Previously non-executable item now executable:** From the P4a smoke checklist, the box "Complete packaging on a bag via advanceBag" no longer carries "NOT EXECUTABLE until P4b" label. It is now checked as executable (OperatorScreen wires advanceBag for packaging complete). Verify the box is unlabeled.
