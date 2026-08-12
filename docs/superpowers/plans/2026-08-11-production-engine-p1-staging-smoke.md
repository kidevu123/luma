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
- [ ] A handpack blister completion still issues blister card material
      (this path moved into record-stage-event.ts — confirm it did not
      regress).
- [ ] A partial-sealing close-out still auto-releases.

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
