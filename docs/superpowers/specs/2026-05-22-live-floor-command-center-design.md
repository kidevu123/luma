# Live Floor Command Center — Design Spec

**Date:** 2026-05-22
**Status:** Approved

---

## Problem Statement

The current floor board renders a hardcoded machine layout and surfaces raw counts with no operational intelligence. A supervisor cannot answer any of these questions from the board today:

1. Am I hitting today's target?
2. What is slowing us down right now?
3. Where is quality breaking down?
4. Which machines or operators need attention?

All the data to answer these questions exists in the read models. The board does not surface it correctly. Additionally, the machine layout is hardcoded — new machines, alternate routes (e.g. bottle hand-fill station), and configuration changes require code changes to appear on the board.

---

## Goals

1. Answer the four supervisor questions at a glance, always visible.
2. Render floor topology dynamically from DB — any registered station auto-appears.
3. Per-user configurable widget layout — supervisors arrange the board to suit how they work.
4. All metrics update live via SSE with no manual refresh.

---

## Constraints

- Single shift, 6am start. All time windows reset at 6am. No shift selector needed.
- No emojis anywhere. Lucide icons + colored chips + text only.
- Read models are the data source. No fold-on-read outside projectors.
- Per-user layout persists across devices (stored in Postgres, not localStorage).

---

## Layout Structure

Three fixed zones, always present:

```
┌─────────────────────────────────────────────┐
│ Zone 1: Shift Status Bar (56px, pinned)     │
├─────────────────────────────────────────────┤
│                                             │
│ Zone 2: Configurable Widget Grid            │
│         (flex height, 12-column grid)       │
│                                             │
├─────────────────────────────────────────────┤
│ Zone 3: KPI Strip (48px, pinned)            │
└─────────────────────────────────────────────┘
```

Zones 1 and 3 are always pinned. Zone 2 is the user-configurable area.

---

## Zone 1: Shift Status Bar

Four cells, one per supervisor question. Always visible. Color-coded: emerald = good, amber = attention, coral = action required.

| Cell | Data source | Green condition | Amber | Coral |
|---|---|---|---|---|
| Target | `read_daily_throughput` units vs. daily goal | On pace or ahead | <10% behind pace | >10% behind pace |
| Bottleneck | `read_queue_state.queueStatus` across all stages | All FLOWING or EMPTY | Any AGING | Any STALLED |
| Quality | `read_bag_metrics.yieldPct` aggregate today | ≥98% first-pass | 94–97% | <94% |
| Attention | Idle machines >5 min (`read_station_live.busyForSeconds` gap) + count of `read_bag_state.reworkPending = true` | None flagged | 1 item | 2+ items |

Example cell content:
- Target (amber): `847 / 1,200 units — behind 83 units`
- Bottleneck (coral): `Heat Sealing — queue stalled, oldest bag 22 min`
- Quality (green): `Yield 97.4% — first-pass clean`
- Attention (amber): `HS2 idle 9 min`

The pace calculation for Target uses: `(units_produced / minutes_elapsed_since_6am) * minutes_remaining_in_shift`. Shift end time defaults to 16:00 (10-hour shift). If the daily goal is not set for a product (`products.daily_unit_goal IS NULL`), the cell shows a neutral state with raw count only.

---

## Zone 2: Configurable Widget Grid

### Grid mechanics

- 12-column grid using `react-grid-layout`
- Widgets snap to grid on drag/drop
- Each widget has a minimum size (defined per widget type)
- Edit mode toggled by a button in the top bar ("Edit Layout" / "Done")
- In edit mode: widgets show drag handles and a remove (×) button; widget picker slides in from the right
- Layout saves automatically on drop and on exit from edit mode

### Widget catalog

| Widget key | Default included | Min size | Description |
|---|---|---|---|
| `floor-map` | Yes | 8×6 | Dynamic machine topology (see Section below) |
| `queue-health` | Yes | 4×4 | Table: all stages, queue depth, age, status badge |
| `throughput-chart` | No | 6×4 | Bags/hr trend line, shift so far, target rate overlay |
| `operator-board` | No | 6×5 | Per operator: bags completed, active time, damage events |
| `quality-watch` | Yes | 4×5 | Live feed: damage/rework/correction events with bag ID + operator |
| `machine-focus` | No | 4×4 | Single-machine expanded view; user selects which machine |
| `recent-events` | No | 4×5 | Raw workflow event stream |

Default layout (what a new user sees first time):
- `floor-map` spanning columns 1–8, rows 1–6
- `queue-health` spanning columns 9–12, rows 1–4
- `quality-watch` spanning columns 9–12, rows 5–6

### Layout persistence

Table: `user_dashboard_config`

```sql
CREATE TABLE user_dashboard_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  board_key   text NOT NULL DEFAULT 'floor-command',
  layout_json jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, board_key)
);
```

`layout_json` stores an array of widget descriptors:

```json
[
  {
    "key": "floor-map",
    "x": 0, "y": 0, "w": 8, "h": 6
  },
  {
    "key": "machine-focus",
    "x": 8, "y": 0, "w": 4, "h": 4,
    "config": { "stationId": "uuid-of-hs2" }
  }
]
```

On first load, if no config row exists for the user, the default layout is rendered and a row is inserted on first save.

---

## Zone 3: KPI Strip

Six fixed cells, always pinned at the bottom. Data from read models, updated via SSE.

| Cell | Source | Unit |
|---|---|---|
| Bags Today | `read_daily_throughput.bagsFinalized` | count |
| Units Out | `read_daily_throughput.unitsProduced` | count |
| Avg Cycle Time | `read_bag_metrics.totalSeconds` / bags today | mm:ss per bag |
| Active Operators | count of `read_station_live` rows with event in last 15 min | count |
| First-Pass Yield | `read_bag_metrics.yieldPct` aggregate today | % |
| Total Downtime | `(minutes_since_6am * active_station_count) - sum(read_station_live.busyForSeconds / 60)` across all non-idle stations | hh:mm |

---

## Floor Map Widget — Dynamic Topology

### Step group mapping

Defined in code as a constant (not in DB). Maps `station_kind` enum values to named step groups:

```typescript
const STEP_GROUPS: Record<string, StationKind[]> = {
  "Filling":    ["BLISTER", "BOTTLE_HANDPACK"],
  "Sealing":    ["SEALING", "BOTTLE_CAP_SEAL"],
  "Finishing":  ["PACKAGING", "BOTTLE_STICKER", "COMBINED"],
  "Pack Out":   ["HANDPACK_BLISTER"],
};
```

### Rendering logic

1. Fetch all active stations from DB with their `station_kind` and live state from `read_station_live`.
2. Group stations by step using `STEP_GROUPS`.
3. Render only step columns that have at least one station — if no `BOTTLE_HANDPACK` station exists in DB, the Filling step shows only the blister machine.
4. Within a step column, multiple stations of the same kind stack vertically (e.g. 3 heat sealers in Sealing).
5. Between step columns, queue badges and connector lines rendered from `read_queue_state` for that stage transition.

### Machine card content

Each card shows:
- **Header**: station name, status dot (running / paused / idle / error)
- **Illustration**: v8 SVG keyed by `machine_kind`
- **Rate**: bags/hr this station over last 60 min vs. target rate (e.g. `6/hr · target 8`)
- **Queue**: bags waiting before this station with AGING/STALLED color
- **Yield**: first-pass yield % for bags through this station today

Card border color:
- Emerald: running, at or above target rate
- Amber: running but below target rate, OR queue AGING
- Coral: stopped/idle >threshold, OR queue STALLED, OR yield <threshold
- Gray: no active bag assigned

### Pack-out stations

Stations with `station_kind` in `["HANDPACK_BLISTER", "COMBINED"]` render as an operator grid (initials avatars) rather than a machine SVG. This accurately represents employees working at a table.

### Target rate source

Each machine's target rate (bags/hr) comes from `product_packaging_specs.target_bags_per_hour integer` — a new column added in this feature. If `NULL` for a given product/spec, the rate comparison is omitted from the card (raw bags/hr shown without a target).

---

## Live Updates

SSE stream (existing `pg_notify` → SSE infrastructure):
- Zone 1 status bar re-evaluates on any `workflow_events` notification
- Machine cards re-render on `read_station_live` update for that station
- Queue badges re-render on `read_queue_state` update for that stage
- KPI strip re-renders on `read_daily_throughput` update

Debounce: 500ms on the router refresh (existing pattern). Widget grid does not re-layout on SSE — only data within widgets updates.

---

## Machine Focus Widget — Config

The Machine Focus widget shows an expanded single-machine view. The user selects which station to watch when adding the widget from the picker. The `stationId` is stored in `layout_json[].config`. If the station goes offline or is deleted from master data, the widget shows a "Station not found" state with a reconfigure prompt.

---

## Data Layer Changes

New or modified read functions in `lib/production/`:

| Function | Purpose |
|---|---|
| `getStationsWithLiveState()` | Joins `stations` + `read_station_live`; returns all stations with current status |
| `getQueueHealthSummary()` | Returns all `read_queue_state` rows with computed worst-stage flag |
| `getShiftTargetStatus()` | Computes on-pace calculation from `read_daily_throughput` + product daily goal + minutes since 6am |
| `getAttentionItems()` | Returns machines idle >5min + rework queue depth >0 |
| `getOperatorDailySummary()` | Returns `read_operator_daily` rows for today |

`getShiftTargetStatus()` reads `products.daily_unit_goal integer` (new column added in this feature). Shift window is always 06:00–16:00 local time (`company.timezone`).

`user_id` in `user_dashboard_config` references the user's subject claim from the Authentik OIDC session (stored as `uuid` in whatever session/user table the app maintains for OIDC users).

---

## Out of Scope

- Multi-shift support (single 6am shift only)
- Shared/team layout presets (per-user only)
- Widget-level SSE subscriptions (all widgets share the same SSE stream)
- Mobile layout (floor board is wall-monitor / iPad landscape only)
- Historical playback
