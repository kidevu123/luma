# Floor Board Command Center — Layered Metrics Design

**Date:** 2026-06-02  
**Status:** Approved (user: "ok go for it")

---

## Problem

`/floor-board` has access to rich read models and `lib/production/metrics.ts`, but the UI stacks duplicate KPI blocks, buries the floor map, and does not answer "what do I do now?" for shift leads. A prior "Pro Max" pass added more sections and made the problem worse.

## Goals

Serve **four audiences** from one URL without one flat metric dump:

| Audience | Need | Surface |
|----------|------|---------|
| Shift lead (A) | Next action in &lt;30s | Act Now sidebar + map |
| Production manager (B) | Cycles, scans, yield | Manager drawer (tables) |
| Owner (C) | $ and runway | Owner pulse strip + `/dashboard` |
| Wall TV (D) | Readable at distance | `?mode=tv` |

**Principle:** Hub + layers. Full analytics stay on `/metrics`; floor board links outward instead of duplicating.

## Architecture

- **Single data load** on `page.tsx` (existing parallel fetches). No duplicate SQL in UI.
- **Act Now** built client-side or server-side from `FloorManagerSnapshot`, `AttentionItem[]`, `FloorProductionIntelligence` — no new tables.
- **Metrics** only from `metrics.ts` / documented snapshot loaders; UI formats only.
- **Modes** via query param: `lead` (default) | `manager` | `owner` | `tv`.
- **SSE** unchanged (`/api/floor-board/stream` → `router.refresh()`).

## Layout (Lead mode — default)

```
┌ Status bar (4 cells) ─────────────────────────────────────┐
├───────────────────────────────┬─────────────────────────┤
│ Widget grid (flex-1)          │ Act Now (fixed ~280px)  │
│ Floor map primary             │ Stuck bags, idle, etc.  │
├───────────────────────────────┴─────────────────────────┤
│ Owner pulse (1 row, optional emphasis in owner mode)    │
├ Production details (collapsible, manager mode opens) ───┤
├ Production metrics (canonical, 2 compact rows) ─────────┤
├ Shift KPI strip (6 cells) ──────────────────────────────┤
└─────────────────────────────────────────────────────────┘
```

**TV mode:** Hide edit chrome, sidebar, owner strip, details; enlarge status + map + pulse; optional 15s rotation in Act Now (phase 4).

## Act Now panel (Section 13.2 alignment)

Priority-ordered items with severity (`crit` | `warn` | `info`):

1. Stalled / oldest in-flight bags (from `snapshot.inFlight`, top 5)
2. Paused &gt;30m (`dashboard.pausedBagsOverThreshold` + bag list)
3. Idle stations (`getAttentionItems` idle_machine)
4. Rework pending (`rework_pending`)
5. Lane imbalance label (`plant.laneImbalanceLabel`)
6. Damage cluster (`plant.damageClusterActive`)
7. Material runway &lt;3d (`plant.materialRunwayDays`)
8. Bottleneck summary (`deriveBottleneck` via intelligence bundle)

Each row: title, detail, link to bag/station/`/metrics` where applicable.

## Pulse strip

- Row 1: `deriveDashboardMetrics` keys + bottleneck (no per-card LIVE badge).
- Row 2: queue WIP (`deriveQueueAging`).
- No second "Production Command" hero grid.

## Manager drawer

- Collapsed by default in **lead** mode; expanded by default in **manager** mode.
- Content: existing `ProductionManagerWidget` (dense tables).
- Lazy load optional future optimization; phase 1 uses existing server snapshot.

## Owner pulse

- WIP bags, pause minutes + ~$, material runway, shift finalized/units.
- Links: `/dashboard`, `/metrics/forecast` when available.

## Out of scope (this spec)

- New projector tables or Phase-15 gap fills (OEE quality, unit costs).
- Replacing `/metrics` pages.
- Push notifications (Section 14 alerts) — separate work.

## Phasing

| Phase | Deliverable |
|-------|-------------|
| 1 | Layout: map + Act Now sidebar; remove duplicate heroes; modes query param |
| 2 | Owner pulse strip; manager drawer default by mode |
| 3 | TV mode styling |
| 4 | TV rotation; top-20 metrics links on `/metrics` |

## Testing

- Manual: `/floor-board`, `/floor-board?mode=tv`, `?mode=manager`.
- `npm run build` typecheck.
- Verify no client import of `postgres` / server-only metrics loaders.

## References

- `docs/metrics-strategy.md` §13.2 Floor lead live
- `docs/METRICS_DICTIONARY.md`
- `docs/superpowers/specs/2026-05-22-live-floor-command-center-design.md`
