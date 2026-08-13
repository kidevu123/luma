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

## Rollback
If any behaviour check fails, revert the branch. The extraction in
Task 7 is the highest-risk change: record-stage-event.ts holds logic
that previously lived inside fireStageEventAction.

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
