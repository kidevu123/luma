# Handpack Blister Station Design

**Date:** 2026-05-21  
**Status:** Approved — ready for implementation planning

## Background

The blister machine can go down mid-shift (breakdown, material shortage, etc.). When
that happens, operators hand-pack pills into pre-made plastic blisters instead of running
PVC + foil through the machine. The rest of the production line — sealing, display
packing — is unchanged. Only the blistering step varies.

This is not a rare edge case. Running out of PVC is a real operational scenario where
all bags for the remainder of a shift move to hand packing.

## What Changes

Four additions to the system:

1. A new `HANDPACK_BLISTER` station kind
2. A new `HANDPACK_BLISTER_COMPLETE` event type
3. Sealing station shows a plastic blister count input when the incoming bag came from a handpack station
4. Material auto-loading for deterministic-material stations (handpack, bottle, cap seal)

---

## Section 1 — Station Kind

`HANDPACK_BLISTER` is added to `stationKindEnum`.

Routing behaviour mirrors `BLISTER` exactly:

| Property | Value |
|---|---|
| `STATION_PICKUP_FROM_STAGE` | `STARTED` |
| `STATION_RELEASE_FROM_STAGE` | `BLISTERED` |
| In `FIRST_OP_STATION_KINDS` | Yes — product picker required on fresh card scan |
| In `STATIONS_THAT_FINALIZE` | No |

The floor UI for the handpack station is identical to the blister machine station page:
scan bag → work → close out. Pause/resume, operator sessions, and downtime events all
work without additional changes.

Mutual exclusion is operational: when the machine is down, the `HANDPACK_BLISTER` station
is the one running. No system-level toggle is needed — whichever station type has bags
going to it is the active one.

---

## Section 2 — Event Type

`HANDPACK_BLISTER_COMPLETE` is added to `workflowEventTypeEnum`.

Payload: minimal — station ID, operator, timestamp. No machine counter, no PVC/foil
weight. The bag advances to `BLISTERED` stage identically to `BLISTER_COMPLETE`.

The read-model projector (`read_bag_state`, `read_station_live`) handles
`HANDPACK_BLISTER_COMPLETE` the same way it handles `BLISTER_COMPLETE` for stage
progression. Reports can distinguish the two event types to break down machine vs.
handpack throughput.

---

## Section 3 — Sealing Station Change

When a sealing operator scans a bag, the station checks the bag's event history for
`HANDPACK_BLISTER_COMPLETE`. If found, the close-out form shows one extra field:

> **Plastic blisters sealed** _(integer, required when handpack bag)_

`SEALING_COMPLETE` payload gains an optional `plasticBlisterCount` field. When present
and > 0, the system immediately emits `PACKAGING_MATERIAL_ISSUED` deducting that
quantity from the station's active pre-made blister lot.

For machine-blistered bags the field is not shown. No change to the existing sealing
flow.

---

## Section 4 — Material Auto-Loading

For station types where the consumed material is deterministic (not roll-based), the
station page auto-loads the available lot on open rather than requiring operators to
navigate to the rolls sub-page.

| Station kind | Auto-loads |
|---|---|
| `HANDPACK_BLISTER` | Pre-made plastic blisters — kind `BLISTER_CARD`, category `MATERIAL` |
| `BOTTLE_HANDPACK` | Bottles (`BOTTLE`) + Caps (`CAP`) |
| `BOTTLE_CAP_SEAL` | Induction seals (`INDUCTION_SEAL`) |

**Auto-load logic on station page open:**

Query `packaging_lots` for `AVAILABLE` lots matching the expected kind(s).

| Lots found | Behaviour |
|---|---|
| Exactly one | Auto-load silently — no operator action |
| Multiple | Show a single-step picker, default to oldest lot (FIFO) |
| None | Show a clear warning block before operator can start work |

**Why the blister machine keeps manual loading:** PVC and foil rolls require physical
mounting on the machine and a tare weight reading. The operator must confirm which
specific roll is loaded. That physical confirmation step cannot be safely skipped.

---

## Section 5 — Materials & Lots

The user adds a pre-made plastic blister entry in Settings → Packaging & Materials:

- Kind: `BLISTER_CARD`
- Category: `MATERIAL`
- UoM: `pcs`

When a shipment of pre-made blisters arrives, it is received into a `packaging_lot`
the same way any other material is received. No product BOM spec entry is needed —
consumption quantity comes from the sealing station count, not a per-unit BOM ratio.

---

## Section 6 — Reporting & Live Floor

- Live floor board: `HANDPACK_BLISTER` appears in the same `BLISTER_QUEUE` lane as the
  machine station. The station card name distinguishes which is running.
- Operator productivity, cycle times, throughput: unchanged — the same read-model
  projections apply to `HANDPACK_BLISTER_COMPLETE` events.
- Machine vs. handpack breakdown: derivable by grouping on event type in any report query.

---

## Schema Changes

| Object | Change |
|---|---|
| `stationKindEnum` | Add `HANDPACK_BLISTER` |
| `workflowEventTypeEnum` | Add `HANDPACK_BLISTER_COMPLETE` |
| `workflow_events` payload | `SEALING_COMPLETE` gains optional `plasticBlisterCount: number` |
| `stage-progression.ts` | Add `HANDPACK_BLISTER` to routing maps |
| Floor station page | New branch for `HANDPACK_BLISTER` kind |
| Sealing station page | Detect handpack bag, show count input |
| Station page (shared) | Auto-load logic for deterministic-material station kinds |

No new tables. No migrations beyond the two enum additions.
