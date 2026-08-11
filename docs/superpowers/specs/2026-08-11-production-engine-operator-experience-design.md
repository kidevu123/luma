# Production Engine + Operator Experience Overhaul

**Date:** 2026-08-11
**Status:** Approved design, pending implementation plan
**Scope:** Umbrella spec covering four subsystems — Production Engine,
operator tablet rewrite, auto-advance queues, operator/supervisor split.

---

## Problem

Luma exposes its state machine to operators.

`app/(floor)/floor/[token]/` is 17,657 lines. `page.tsx` (1,397 lines)
runs roughly fifteen sequential resolution queries before it can
render, separately determining fresh bags, eligible pickups, started
resumes, partial packaging resumes, sealing-final-close bags, partial
sealing state, product mapping, tablet compatibility, packaging BOMs,
station prerequisites, active rolls, idle roll lots, operator sessions,
QC/rework, allocations, and timers. `actions.ts` (3,511 lines) exports
fourteen server actions the UI must choose between.

The backend logic is sound. The problem is that every one of those
concepts reaches the tablet, so an operator standing at a sealer is
asked to make decisions that are properly the system's.

### The spine already exists and is unused

Migration `0013_route_operation_compat.sql` seeded `route_operations`
with exactly the model this overhaul needs:

```
CARD_BLISTER: RECEIVING_QUEUE → BLISTER_QUEUE → POST_BLISTER_STAGING
              → SEALING_QUEUE → POST_SEAL_STAGING → PACKAGING_QUEUE
              → FINISHED_GOODS_QUEUE
```

Each row carries `stage_key`, `next_stage_key`, `allowed_station_kind`,
`allowed_machine_kind`, `requires_scan`, `requires_counter`,
`requires_timer`, and `output_unit`. Pooled queues, staging states
between stations, and per-operation input requirements are already data
in production.

`lib/production/routes.ts` reads this table and its header says "new
code should resolve routes through these helpers." The floor page
instead resolves stages through hardcoded tables in
`lib/production/stage-progression.ts` and `first-op-product.ts`.

This design starts using the spine that is already there.

---

## Decisions taken

| Decision | Choice |
|---|---|
| Spec scope | One umbrella spec, all four subsystems |
| Queue model | Pooled by station kind |
| Sealing lane-close | Operator confirms when engine cannot prove the bag is spent |
| Machine signals (counter auto-read, auto-pause) | Out of scope entirely |
| Supervisor access | Hybrid — PIN unlock on tablet, `/admin` for the rest |
| Rollout | Rewrite in place, no feature flags |
| Engine architecture | Data-driven on `route_operations`, legacy fallback during migration |

### Explicitly out of scope

Machine telemetry of any kind. There is no Modbus, OPC-UA, PLC polling,
or machine-signal ingestion anywhere in the repo, so counter auto-read
and automatic pause on machine-stop / roll-removal have no data source.
Operators continue to type counts and pause manually. This is a
hardware integration project, not a software one.

---

## Architecture

### One read, one write

The tablet makes exactly two engine calls.

```
lib/production/engine/
  types.ts              StationView, NextAction, Blocker, AdvanceInput, AdvanceResult
  station-view.ts       getStationView(stationId)  — the single read
  advance.ts            advanceBag(input)          — the single write
  resolve-operation.ts  (bag, station) → route_operations row
  resolve-bag.ts        scan token | station context → bag
  resolve-product.ts    product + tablet compatibility
  resolve-materials.ts  BOM, lots, rolls
  resolve-completion.ts what DONE requires at this operation
  resolve-exceptions.ts blockers + diagnosis
```

The 131 existing non-test modules in `lib/production` remain. They
become the engine's implementation, not the UI's vocabulary.

Mapping to the originally requested API:

| Requested | Provided by |
|---|---|
| `resolveBag()` | `resolve-bag.ts` |
| `resolveProduct()` | `resolve-product.ts` |
| `resolveMaterials()` | `resolve-materials.ts` |
| `resolveStation()`, `resolveNextStage()` | `resolve-operation.ts` — both are lookups on the same `route_operations` row, so they are one module |
| `resolveCompletion()` | `resolve-completion.ts` |
| `resolveExceptions()` | `resolve-exceptions.ts` |
| `advance()` | `advance.ts` |

**Import boundary.** Code under `app/(floor)/` may import from
`lib/production/engine` only. Enforced by an ESLint
`no-restricted-imports` rule so the leak cannot silently reopen.

### The contract that stops the leak

`NextAction` is a server-computed discriminated union. The tablet
renders six cases and never reasons about stages.

```ts
type NextAction =
  | { kind: "SCAN_TO_CLAIM"; expected: UpNextBag | null }
  | { kind: "START"; label: string }
  | { kind: "COMPLETE"; label: string; inputs: CompletionInput[] }
  | { kind: "CONFIRM_BAG_EMPTY" }
  | { kind: "RESOLVE_PARTIAL"; estimate: number | null; needsEntry: boolean }
  | { kind: "OPEN_SHIFT" }
  | { kind: "BLOCKED"; blockers: Blocker[] };
```

`OPEN_SHIFT` is the state when `StationView.operator` is null. Every
`advanceBag()` intent requires an open operator session, because
`workflow_events.employee_id` is sourced from it
(`station_operator_sessions`, one open session per station). The engine
returns `OPEN_SHIFT` rather than a blocker, since it is the normal
start-of-shift state and not a fault.

`CompletionInput[]` is derived from the route operation
(`requiresCounter`, `outputUnit`), not from a station-kind `switch`.

```ts
type StationView = {
  station: { id: string; label: string; kind: string; machineName: string | null };
  operator: { sessionId: string; name: string } | null;
  supervisor: { employeeName: string; expiresAt: string } | null;
  current: CurrentWork | null;
  upNext: UpNextBag[];
  nextAction: NextAction;
  capabilities: { canPause: boolean; canReportProblem: boolean };
};

type CurrentWork = {
  workflowBagId: string;
  bagLabel: string;
  productName: string | null;
  statusLine: string;                 // "Ready to seal"
  progress: { done: number; expected: number; unit: string } | null;
};

type UpNextBag = {
  workflowBagId: string;
  bagLabel: string;
  productName: string | null;
  readyState: "READY" | "UPSTREAM_RUNNING";
  etaMinutes: number | null;
};
```

### `advanceBag()`

```ts
type AdvanceInput = {
  stationId: string;
  workflowBagId: string;
  operatorSessionId: string;
  intent: "CLAIM" | "COMPLETE" | "CONFIRM_BAG_EMPTY" | "RESOLVE_PARTIAL";
  inputs: {
    counter?: number;
    damaged?: number;
    cases?: number;
    displays?: number;
    loose?: number;
    physicalQty?: number;
  };
  clientEventId: string;              // idempotency
};

type AdvanceResult =
  | { ok: true; view: StationView }
  | { ok: false; blocker: Blocker };
```

One transaction: validate station → validate bag → resolve product →
record production events → consume materials → update stage → advance
queue state → update inventory → refresh projector → write `audit_log`
→ `pg_notify`.

It returns the fresh `StationView`, so a completion needs no refetch.

`clientEventId` reuses the existing convention verified by
`lib/production/client-event-id-rule.test.ts`. A double-tap or a flaky
tablet connection cannot double-count production.

---

## Queues and auto-advance

### `read_bag_queue`

New read model, one row per active workflow bag, maintained by the
projector. Folds-on-read stay forbidden outside the projector.

| Column | Purpose |
|---|---|
| `workflow_bag_id` | PK |
| `queue_stage_key` | e.g. `SEALING_QUEUE`, from `route_operations.next_stage_key` |
| `eligible_station_kind` | from `route_operations.allowed_station_kind` |
| `product_id`, `product_name`, `bag_label` | display without joins |
| `ready_state` | `READY` \| `UPSTREAM_RUNNING` |
| `claimed_by_station_id` | null when unclaimed |
| `ready_at` | queue ordering |

`read_station_live.currentWorkflowBagId` continues to answer "what is
at my station." `read_bag_queue` answers "what is coming."

### Release and finalize disappear

When a completion event commits, the engine itself sets
`queue_stage_key = op.nextStageKey`, clears `claimed_by_station_id`,
and emits `BAG_RELEASED`. No operator action.

At packaging, `next_stage_key = FINISHED_GOODS_QUEUE`, so
`PACKAGING_COMPLETE` and `BAG_FINALIZED` fire in the same transaction.
The finalize button goes with it.

Physical movement of the bag remains the only manual step between
stations, and scanning remains mandatory to claim — physical
confirmation is a human decision, so "expected next bag" is always a
prompt (`[Scan to confirm]`) and never an auto-claim.

### Overlap scanning survives

A bag enters `SEALING_QUEUE` with `ready_state = UPSTREAM_RUNNING`
while blister is still running. Sealing can claim it early
(`BAG_PICKED_UP`), but `COMPLETE` stays blocked until the bag reaches
`BLISTERED`. This preserves the behavior currently expressed by
`STATION_PICKUP_FROM_STAGE`.

### Sealing lane-close

Several sealers can share one blistered bag; each fires
`SEALING_SEGMENT_COMPLETE` with its own card count, and the bag-level
`SEALING_COMPLETE` must fire before packaging. `needsSealingLaneClose()`
exists today because bags get stranded at exactly this step.

The word "segment" never appears in the operator UI. `DONE` records the
segment. The engine then fires `SEALING_COMPLETE` automatically only
when it can prove the bag is spent (cumulative sealed cards meet or
exceed expected sealable output from blister). Otherwise `nextAction`
becomes `CONFIRM_BAG_EMPTY`, a single question:

```
Is this bag finished?
[ Yes, bag empty ]   [ No, more to seal ]
```

### ETA

`UpNextBag.etaMinutes` derives from the rolling median cycle time for
that product and station kind, using `blister-cycle-math.ts` and
`capacity.ts`. When there are too few recent completions to be
confident, the field is `null` and the UI omits the line rather than
guessing.

### Realtime

New route `/floor/api/stream/[token]` — station scan-token auth,
CSRF-exempt, matching the floor API convention. It subscribes to the
existing `lib/projector/notify-bus.ts` exactly as
`/api/floor-board/stream` does; the admin stream stays
`requireSession()`-gated and unchanged.

The `pg_notify` payload gains `queueStageKey` and `stationKind` so each
tablet filters to events it cares about, instead of every station
refetching on every floor event.

Because `advanceBag()` returns the fresh `StationView`, SSE only
carries changes originating at *other* stations.

---

## The operator screen

One route, one component, six render cases matching `NextAction`.
Persistent chrome is the station name, `⋮ More`, and `? Help`.

```
┌──────────────────────────────┐
│ SEALING 2                    │
│                              │
│ BAG 1042                     │
│ Chocolate Brown              │
│                              │
│ 52 / 52                      │
│ ████████████████████████████ │
│                              │
│        [ COMPLETE ]          │
│                              │
│ Scan next bag                │
│                              │
│                  ⋮ More      │
└──────────────────────────────┘
```

| `NextAction` | Screen |
|---|---|
| `SCAN_TO_CLAIM` | Live camera, `UP NEXT · 1042 · Chocolate Brown · [Scan to confirm]` |
| `START` | Bag identity + `[ Start Sealing ]` |
| `COMPLETE` | Progress + required inputs inline + `[ DONE ]` |
| `CONFIRM_BAG_EMPTY` | `[ Yes, bag empty ]` / `[ No, more to seal ]` |
| `RESOLVE_PARTIAL` | See below |
| `OPEN_SHIFT` | Operator picker + `[ Open shift ]` |
| `BLOCKED` | One-sentence blocker + `[ Why? ]` |

### Removed from operator mode

The bag dropdown, product picker, eligible-pickup list, resume list,
and fresh-card list are gone from the operator experience. They exist
only under supervisor unlock as manual override. Typed-code entry stays
under `More` for a damaged QR.

### `More`

Pause, Change material, Report problem, Enter code manually,
Supervisor, End shift.

### Partial bags

The operator sees the conclusion, never the machinery (previous
product, consumed quantity, allocation history, source, supervisor
requirement). Existing confidence levels drive it:

- **HIGH / MEDIUM** — `PARTIAL BAG DETECTED · Estimated remaining:
  1,240 units · [ Use bag ]`
- **LOW** — `CHECK BAG · System cannot confidently determine remaining
  quantity. Enter physical quantity: [____] [ Continue ]`

`lib/production/partial-bag-lifecycle.test.ts` enforces that LOW
confidence requires a supervisor badge. That rule is preserved: the LOW
screen collects the physical quantity and then prompts for supervisor
PIN inline, as one flow rather than two. See Open Decisions.

All historical and accountability detail moves to the supervisor and
admin views.

### Exceptions

`Report problem` is the single exception workflow — six categories, one
follow-up question, recorded automatically:

```
Something wrong?
[ Material ] [ Machine ] [ Product ]
[ Bag ]      [ Quality ] [ Other ]
```

It reuses existing events where they exist — `DOWNTIME_STARTED`
(machine), `QA_HOLD_STARTED` (quality), `BAG_PAUSED` (bag) — and adds
one new `PRODUCTION_EXCEPTION_RAISED` event for categories with no
current equivalent. All land on the `/floor-board` Act Now rail.

`PRODUCTION_EXCEPTION_RAISED` is a new value on
`workflow_event_type_enum` and therefore requires a migration. The
projector must treat it as non-progressing — it records an exception
without advancing stage or queue state.

**Notification is in-app only.** The repo has no email, SMS, push, or
Slack channel. `[ Notify supervisor ]` and `[ Notify maintenance ]`
write an event that surfaces on the Act Now rail, a supervisor inbox,
and a badge on any tablet in supervisor mode.

### `? Help`

Runs `resolveExceptions()` and prints a diagnosis, not documentation:

```
Why can't I continue?

✓ Bag recognized
✓ Product recognized
✓ Station correct
✓ Materials available
✕ Previous stage incomplete

The bag is waiting for:
Sealing at Station 3

[ Notify Supervisor ]
```

This calls the **same function** that produces `Blocker[]` for
`NextAction = BLOCKED`. The help screen therefore cannot disagree with
why the button is disabled — a single code path, not two.

---

## Operator / supervisor separation

### Auth primitive

No supervisor PIN exists in the repo today. `userRoleEnum`
(OWNER/ADMIN/MANAGER/LEAD/STAFF) belongs to the Authentik *user*
identity space, which is distinct from `employees`. Two schema
additions:

- `employees.supervisor_pin_hash` — argon2id, already a dependency
- `employees.is_supervisor` — boolean

Unlock creates a `station_supervisor_sessions` row with a 15-minute
TTL. A persistent banner shows the supervisor name and remaining time
with an `[ Exit ]` action. `audit_log` is written on unlock and on
every action taken under the unlock.

### Where each capability lives

| On the tablet (PIN unlock) | On `/admin` (Authentik) |
|---|---|
| Partial-bag override | Corrections wizard |
| Manual bag selection (the old dropdown) | QC dispositions |
| Force-advance / unblock | Rework |
| Roll management | Manual allocations |
| End operator session | Recovery workflows |
| Void last submission | Audit |
| | Production closeout |

The dividing line is physical presence: if the decision requires
standing at the machine, it stays on the tablet.

`/floor/[token]/rolls` stays (physical work at the machine).
`/floor/[token]/bag-allocation` and `/floor/[token]/variety-pack`
become supervisor-gated.

---

## Error handling

`advanceBag()` never throws to the UI. Every failure path returns a
structured blocker:

```ts
type Blocker = {
  code: string;              // stable, greppable
  operatorSentence: string;  // plain language, no jargon
  supervisorDetail: string;  // the real reason, for the unlock view
  suggestedAction: "SCAN_AGAIN" | "NOTIFY_SUPERVISOR" | "WAIT_UPSTREAM"
                 | "ENTER_QUANTITY" | "NONE";
};
```

No optimistic UI on advance — production counts are truth and must not
render before they commit.

Two tablets racing to claim the same queued bag is expected, not
exceptional: the transaction that loses receives a `Blocker` explaining
that another station claimed the bag, and its view refreshes to the
next queued item.

---

## Testing

- **Parity harness.** Replay a corpus of real bags and assert engine
  decisions match legacy decisions. No legacy path is deleted until its
  parity test passes.
- **Resolver unit tests**, one suite per `resolve-*` module.
- **Transaction tests** for `advanceBag()`: idempotency under repeated
  `clientEventId`, and concurrent claim of the same queued bag.
- **`StationView` snapshots** per station kind.
- **Regression gate.** All 5,000+ existing tests stay green through
  Phase 1, which ships zero visual change.

---

## Phasing

Rewrite in place, no feature flags.

| Phase | Lands | Visible effect |
|---|---|---|
| P1 | Engine behind the current UI; existing actions become thin wrappers over `advanceBag()` | None — parity checkpoint |
| P2 | `read_bag_queue`, auto-advance, auto-finalize | Release and finalize buttons disappear |
| P3 | Station SSE at `/floor/api/stream/[token]` | Tablets stop needing refresh |
| P4 | Operator screen rewrite; `page.tsx` and `stage-action-buttons.tsx` replaced | The new tablet experience |
| P5 | Supervisor PIN, panel moves to `/admin` | Operator/supervisor split |
| P6 | Delete legacy tables, fallbacks, and dead modules | Special cases actually removed |

### Known rollout risk

Because the rollout is in place with no flags, **P2 changes floor
behavior before the new UI exists** — operators lose the release button
while still on the old screen. This is inherent to the no-flags choice
and is survivable, but it requires an operator heads-up the morning it
ships.

---

## Data reconciliation

The seeded `BOTTLE` route in `0013_route_operation_compat.sql` fixes
`STICKERING` before `INDUCTION_SEAL` in sequence. `BOTTLE-ORDER-FLEX-1`
in `lib/production/stage-progression.ts` says cap-seal and stickering
run in either order after fill. The data and the code disagree.

Before the engine resolves bottle routes from data, `route_operations`
must express order-independence for these two operations — either as a
shared sequence number or an explicit `order_independent_group` column.
Resolve during P2.

## Legacy tables to migrate into `route_operations`

Deleted in P6 once parity holds:

- `EVENT_STAGE_PREREQ`
- `STATION_RELEASE_FROM_STAGE`
- `STATION_PICKUP_FROM_STAGE`
- `STATION_STARTED_RESUME_FROM_STAGE`
- `STATIONS_THAT_FINALIZE`
- `FIRST_OP_STATION_KINDS`
- `PRODUCT_AT_START_STATION_KINDS`
- `STATION_KIND_TO_PRODUCT_KINDS`
- `ALLOWED_EVENTS_BY_KIND` (in `actions.ts`)
- `LEGACY_*` maps in `routes.ts`

---

## Open decisions

1. **LOW-confidence partial bags.** The existing rule requires a
   supervisor badge; the requested design had the operator enter a
   quantity and continue unaided. This spec preserves the supervisor
   gate. Relaxing it is a business decision, not a technical one.
2. **External notification.** `[ Notify supervisor ]` is in-app only.
   If a page/SMS is wanted, that is additional infrastructure.
