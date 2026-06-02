# PRODUCTION-OVERLAP-AUDIT-1 — Overlapping Station Work

**Audit-only. No code changes in this document.**

Reported incident: scanning Bag Card 117 at a SEALING station while the
bag was still at stage STARTED (active on BLISTER/HANDPACK_BLISTER) produced:

> "SEALING station expects bag at BLISTERED (bag is STARTED)."

---

## 1. Exact error source

`app/(floor)/floor/[token]/actions.ts:416–418` inside `scanCardAction`:

```typescript
const allowedStages = STATION_PICKUP_FROM_STAGE[station.kind] ?? [];
if (!state?.stage || !allowedStages.includes(state.stage)) {
  throw new Error(
    `${station.kind} station expects bag at ${list} (bag is ${state?.stage ?? "unknown"}).`,
  );
}
```

`STATION_PICKUP_FROM_STAGE` is defined in `lib/production/stage-progression.ts`:

```typescript
export const STATION_PICKUP_FROM_STAGE = {
  SEALING: ["BLISTERED"],   // ← only one allowed stage
  PACKAGING: ["SEALED"],
  BOTTLE_CAP_SEAL: ["BLISTERED"],
  BOTTLE_STICKER: ["SEALED"],
};
```

The bag was at `STARTED`. `"BLISTERED"` does not include `"STARTED"`. Error thrown.

---

## 2. Is this a guard bug or correct enforcement?

**Correct enforcement of the current model.** The guard is working as
designed. The model is fundamentally sequential: SEALING is only allowed
to work on bags that have already completed BLISTER. This is not a bug in
the guard; the guard faithfully expresses the model.

The second guard — `EVENT_STAGE_PREREQ.SEALING_COMPLETE = ["BLISTERED"]`
in the same file — also enforces this. Even if the scan were allowed,
SEALING_COMPLETE could not fire until the bag reaches BLISTERED.

---

## 3. Current bag stage model

`read_bag_state.stage` is a **single text column** (nullable, no foreign key):

```
schema.ts:2479  stage: text("stage").notNull(), // STARTED | BLISTERED | SEALED | PACKAGED | FINALIZED
```

The projector (`lib/projector/index.ts`) advances it forward-only:

| Event fired | New stage |
|---|---|
| `BLISTER_COMPLETE` / `HANDPACK_BLISTER_COMPLETE` | BLISTERED |
| `SEALING_COMPLETE` | SEALED |
| `PACKAGING_COMPLETE` | PACKAGED |
| `BAG_FINALIZED` | FINALIZED |

`STAGE_RANK` is a flat integer map: STARTED=1, BLISTERED=2, SEALED=3,
PACKAGED=4, FINALIZED=5. Advancement is strictly forward; there is no
concept of parallel paths or partial stages.

`read_station_live` has **one slot per station**:

```
schema.ts:2461  currentWorkflowBagId: uuid("current_workflow_bag_id"),
```

A station holds at most one bag at a time. Pause/resume is **bag-global**
(`read_bag_state.isPaused`, `pausedAt`, `pausedSecondsAccum`), not
per-station.

---

## 4. What "overlapping station work" means concretely

On the factory floor, a blister run takes 30–90 minutes. The SEALING
machine can be set up, warmed, and ready before BLISTER finishes. The
team wants to:

1. Scan a bag card at SEALING **while BLISTER is still running** (bag is STARTED)
2. The floor page shows SEALING is "waiting" for BLISTER to complete
3. Once BLISTER fires `BLISTER_COMPLETE` → bag moves to BLISTERED
4. SEALING immediately becomes actionable — operator presses Complete

The current model stops at step 1.

---

## 5. Where all guards live (complete list)

| Location | Guard | Effect |
|---|---|---|
| `stage-progression.ts:42` | `STATION_PICKUP_FROM_STAGE.SEALING = ["BLISTERED"]` | Scan rejected if bag ≠ BLISTERED |
| `actions.ts:411–418` | enforces the above at runtime | Error thrown to the floor UI |
| `stage-progression.ts:15` | `EVENT_STAGE_PREREQ.SEALING_COMPLETE = ["BLISTERED"]` | SEALING_COMPLETE rejected if bag ≠ BLISTERED |
| `actions.ts:557–565` | `checkStageProgression()` call in `fireStageEventAction` | Same — server-side guard |
| `stage-action-buttons.tsx` | `checkStageProgression()` call in client UI | Hides/disables Complete button |

---

## 6. What would need to change (minimum viable overlap)

Two separate concerns:

**A. Allow the scan (pickup)**

Change `STATION_PICKUP_FROM_STAGE.SEALING` from `["BLISTERED"]` to
`["STARTED", "BLISTERED"]`. One line in `stage-progression.ts`.

This lets SEALING scan and "claim" a STARTED bag. The bag is now shown
on the SEALING floor page. The station holds `currentWorkflowBagId`.

**B. Floor UI must handle "waiting" state**

Once SEALING holds a STARTED bag:
- `checkStageProgression({ eventType: "SEALING_COMPLETE", currentStage: "STARTED" })` returns `allowed: false`
- So the Complete button is already disabled/hidden — no code change needed there
- But the current UI probably shows a confusing empty state or error banner

The page needs a "Waiting for BLISTER" banner when:
- Station holds a bag AND bag stage is STARTED (or HANDPACK_BLISTER_COMPLETE not yet fired)

**C. SEALING_COMPLETE guard stays unchanged**

`EVENT_STAGE_PREREQ.SEALING_COMPLETE = ["BLISTERED"]` must remain as-is.
This is the correct behavior — SEALING can't complete before BLISTER does.

---

## 7. Risk analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Elapsed timer starts at SEALING scan, not at SEALING work start | Low | Cycle-time reports show longer SEALING time; acceptable for now, fixable separately |
| BLISTER tries to "own" bag while SEALING already holds it | None | CARD_ASSIGNED event prevents a card from being double-scanned; BLISTER already owns the card |
| `read_station_live` shows SEALING as "busy" while bag is physically on BLISTER | Low | A "waiting" banner makes this clear on-screen |
| Pause/resume is bag-global — SEALING operator could pause a bag that BLISTER is actively running | Medium | Document limitation; address in station-sessions refactor if needed |
| No schema migration needed | — | Confirmed — `stage-progression.ts` is pure TS, no DB |

---

## 8. Recommended architecture

**Phase 1 (minimum, now): Relax pickup guard only**

Single-line change: `["STARTED", "BLISTERED"]` in `STATION_PICKUP_FROM_STAGE.SEALING`.

Add "waiting" banner to floor page for SEALING holding a STARTED bag.

No schema changes. No projector changes. No new event types. Existing
SEALING_COMPLETE guard unchanged.

**Phase 2 (future, if needed): Station-sessions model**

If pause/resume per-station or per-station cycle-time accuracy becomes
important:
- New `station_sessions` table: `(stationId, workflowBagId, status: WAITING|ACTIVE|COMPLETE, claimedAt, startedAt)`
- Projector gains session lifecycle events
- Elapsed timer driven from `station_sessions.startedAt` (when bag becomes BLISTERED at SEALING)
- `read_station_live` gains `sessionStatus`

This is a significant scope increase and should wait until Phase 1 is
validated in production.

---

## 9. Files involved

**Phase 1 only:**

| File | Change |
|---|---|
| `lib/production/stage-progression.ts` | `STATION_PICKUP_FROM_STAGE.SEALING: ["STARTED", "BLISTERED"]` |
| `app/(floor)/floor/[token]/page.tsx` | "Waiting for BLISTER" banner when stage=STARTED at SEALING |
| `app/(floor)/floor/[token]/stage-action-buttons.tsx` | Possibly: suppress confusing UI copy in waiting state |
| Tests for stage-progression | New test: SEALING pickup accepts STARTED; SEALING_COMPLETE still rejects STARTED |

**Do NOT touch in Phase 1:**

- `lib/db/schema.ts` — no schema changes
- `lib/projector/index.ts` — no projector changes
- `lib/db/migrations/` — no migrations
- `app/(floor)/floor/[token]/actions.ts` lines 505–1000 (fireStageEventAction, finalizeAction, releaseAction)
- Zoho push paths
- Receive-edit flow
- QR retire/release flow
- Camera/scan form logic
- `station-pause-reasons.ts`, `floor-station-mobile-nav.ts` (already stable)

---

## 10. Suggested first implementation slice

**PRODUCTION-OVERLAP-1-A: Relax SEALING pickup guard**

```typescript
// lib/production/stage-progression.ts, line 42
export const STATION_PICKUP_FROM_STAGE = {
  SEALING: ["STARTED", "BLISTERED"],   // was: ["BLISTERED"]
  // ...
};
```

Tests to add:
- SEALING may pick up a STARTED bag (returns no error)
- SEALING may pick up a BLISTERED bag (still works)
- `checkStageProgression({ eventType: "SEALING_COMPLETE", currentStage: "STARTED" })` → `allowed: false` (already passing; add as regression test)

**PRODUCTION-OVERLAP-1-B: "Waiting" banner on SEALING floor page**

When `currentAtStation !== null && bagState.stage === "STARTED"` and
`station.kind === "SEALING"`:

```tsx
<div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
  Waiting for BLISTER to complete — sealing will unlock automatically.
</div>
```

These are independent commits. A is safe to ship first without B; the
SEALING_COMPLETE button is already guarded.

---

## Deploy status (at time of audit)

- `main` branch: `40a3ea8` (v0.4.10)
- Staging (LXC 122): likely at `ba225da` (v0.4.9) — one commit behind
- Staging should be polled via `http://192.168.1.134:3000/api/health` to confirm

The overlap block has existed since the model was designed. It is not a
regression from any recent commit. No urgency to patch staging before
implementing the fix.

---

## Summary

| Question | Answer |
|---|---|
| Error source | `scanCardAction` line 417, `STATION_PICKUP_FROM_STAGE.SEALING = ["BLISTERED"]` |
| Bug or model? | Correct model enforcement — not a guard bug |
| Model type | Single-stage linear state machine, one slot per station |
| Root tables | `read_bag_state.stage` (text), `read_station_live.currentWorkflowBagId` |
| Minimum fix | Change `["BLISTERED"]` to `["STARTED", "BLISTERED"]` + waiting banner |
| Schema migration? | No |
| Projector changes? | No |
| New event types? | No |
| First safe slice | `stage-progression.ts` one-liner + regression test |
| Phase 2 (future) | Station-sessions table if per-session timers become critical |
