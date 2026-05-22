# Live Floor Command Center — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the floor board into a three-zone command center with a live shift status bar, per-user configurable widget grid (react-grid-layout), and dynamic machine topology driven from the database.

**Architecture:** `page.tsx` stays as a server component that fetches initial data and passes it as props to a `FloorCommandClient` client component. The client owns the react-grid-layout grid, edit mode state, and layout persistence. SSE events trigger `router.refresh()` which re-flows fresh server data as props. No fold-on-read — all data comes from existing read models plus five new query functions in `lib/production/floor-command.ts`.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict, Drizzle ORM + Postgres 16, react-grid-layout 1.4, recharts 2.x, Tailwind v3, Lucide icons, vitest (already installed).

---

## File Map

**Create:**
- `lib/floor-command/types.ts` — shared types (WidgetKey, WidgetLayout, StatusCell, etc.)
- `lib/floor-command/step-groups.ts` — STEP_GROUPS constant + groupStationsByStep()
- `lib/production/floor-command.ts` — five new DB query functions
- `lib/floor-command/__tests__/floor-command.test.ts` — unit tests for pure functions
- `app/api/dashboard-config/route.ts` — GET + PUT layout persistence
- `app/(admin)/floor-board/_components/status-bar.tsx` — Zone 1 (four status cells)
- `app/(admin)/floor-board/_components/kpi-strip.tsx` — Zone 3 (six KPI cells)
- `app/(admin)/floor-board/_components/floor-command-client.tsx` — Client Component wrapper
- `app/(admin)/floor-board/_components/widget-grid.tsx` — react-grid-layout integration + edit mode
- `app/(admin)/floor-board/_components/widget-picker.tsx` — slide-in widget picker panel
- `app/(admin)/floor-board/_components/widgets/floor-map-widget.tsx`
- `app/(admin)/floor-board/_components/widgets/queue-health-widget.tsx`
- `app/(admin)/floor-board/_components/widgets/throughput-chart-widget.tsx`
- `app/(admin)/floor-board/_components/widgets/operator-board-widget.tsx`
- `app/(admin)/floor-board/_components/widgets/quality-watch-widget.tsx`
- `app/(admin)/floor-board/_components/widgets/machine-focus-widget.tsx`
- `app/(admin)/floor-board/_components/widgets/recent-events-widget.tsx`
- `drizzle/0045_floor_command_center.sql` — migration

**Modify:**
- `lib/db/schema.ts` — add `dailyUnitGoal` to products, `targetBagsPerHour` to machines, add `userDashboardConfig` table
- `app/(admin)/floor-board/page.tsx` — complete rewrite using new architecture
- `package.json` — add react-grid-layout, recharts

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime packages**

```bash
cd /Users/kidevu/luma
npm install react-grid-layout recharts
npm install --save-dev @types/react-grid-layout
```

Expected: `package.json` updated, no peer-dep errors.

- [ ] **Step 2: Verify installs**

```bash
node -e "require('react-grid-layout'); require('recharts'); console.log('OK')"
```

Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add react-grid-layout and recharts for command center"
```

---

## Task 2: Schema changes + migration

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `drizzle/0045_floor_command_center.sql`

- [ ] **Step 1: Add columns to products and machines in schema.ts**

In `lib/db/schema.ts`, find the `products` table definition (around line 390) and add `dailyUnitGoal` as the last column before the closing `}`):

```typescript
// Inside the products pgTable definition, after the last existing column:
dailyUnitGoal: integer("daily_unit_goal"),
```

Find the `machines` table definition (around line 438) and add `targetBagsPerHour`:

```typescript
// Inside the machines pgTable definition, after cardsPerTurn:
targetBagsPerHour: integer("target_bags_per_hour"),
```

- [ ] **Step 2: Add userDashboardConfig table to schema.ts**

Add this new table at the end of `lib/db/schema.ts`, before the `// --- Inferred types ---` section (or at the bottom of the table definitions):

```typescript
export const userDashboardConfig = pgTable(
  "user_dashboard_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    boardKey: text("board_key").notNull().default("floor-command"),
    layoutJson: jsonb("layout_json").$type<Array<Record<string, unknown>>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("udc_user_board_unique").on(t.userId, t.boardKey)],
);

export type UserDashboardConfig = typeof userDashboardConfig.$inferSelect;
export type UserDashboardConfigInsert = typeof userDashboardConfig.$inferInsert;
```

- [ ] **Step 3: Write the migration SQL**

Create `/Users/kidevu/luma/drizzle/0045_floor_command_center.sql`:

```sql
-- 0045: floor command center — add daily_unit_goal, target_bags_per_hour, user_dashboard_config

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS daily_unit_goal integer;

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS target_bags_per_hour integer;

CREATE TABLE IF NOT EXISTS user_dashboard_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  board_key   text NOT NULL DEFAULT 'floor-command',
  layout_json jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT udc_user_board_unique UNIQUE (user_id, board_key)
);
```

- [ ] **Step 4: Apply the migration**

```bash
npm run db:migrate
```

Expected output: migration `0045_floor_command_center.sql` applied, no errors.

- [ ] **Step 5: Verify columns exist**

```bash
npm run db:migrate 2>&1 | tail -5
```

Expected: clean exit (no errors — Drizzle migrations are idempotent).

- [ ] **Step 6: Commit**

```bash
git add lib/db/schema.ts drizzle/0045_floor_command_center.sql
git commit -m "feat: add daily_unit_goal, target_bags_per_hour, user_dashboard_config schema"
```

---

## Task 3: Shared types + step-groups

**Files:**
- Create: `lib/floor-command/types.ts`
- Create: `lib/floor-command/step-groups.ts`

- [ ] **Step 1: Create lib/floor-command/types.ts**

```typescript
// lib/floor-command/types.ts

export type WidgetKey =
  | "floor-map"
  | "queue-health"
  | "throughput-chart"
  | "operator-board"
  | "quality-watch"
  | "machine-focus"
  | "recent-events";

export type WidgetConfig = {
  stationId?: string; // used by machine-focus
};

export type WidgetLayout = {
  key: WidgetKey;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: WidgetConfig;
};

export type StatusLevel = "good" | "warn" | "crit" | "neutral";

export type StatusCell = {
  label: string;
  value: string;
  detail?: string;
  level: StatusLevel;
};

export type ShiftStatusData = {
  target: StatusCell;
  bottleneck: StatusCell;
  quality: StatusCell;
  attention: StatusCell;
};

export type StationKind =
  | "BLISTER"
  | "SEALING"
  | "PACKAGING"
  | "BOTTLE_HANDPACK"
  | "BOTTLE_CAP_SEAL"
  | "BOTTLE_STICKER"
  | "COMBINED"
  | "HANDPACK_BLISTER";

export type StationWithLive = {
  id: string;
  label: string;
  kind: StationKind;
  machineId: string | null;
  machineName: string | null;
  machineTargetBagsPerHour: number | null;
  isActive: boolean;
  currentWorkflowBagId: string | null;
  currentProductId: string | null;
  currentProductName: string | null;
  currentEmployeeName: string | null;
  lastEventType: string | null;
  lastEventAt: Date | null;
  busyForSeconds: number | null;
};

export type StepGroup = {
  label: string;
  kinds: StationKind[];
  stations: StationWithLive[];
};

export type QueueHealthRow = {
  stageKey: string;
  wip: number;
  oldestAgeSeconds: number | null;
  avgAgeSeconds: number | null;
  p90AgeSeconds: number | null;
  bagsOverThreshold: number;
  queueStatus: "EMPTY" | "FLOWING" | "AGING" | "STALLED";
};

export type ShiftTargetStatus = {
  unitsProduced: number;
  dailyGoal: number | null;
  minutesElapsed: number;
  minutesRemaining: number;
  projectedTotal: number | null;
  gapUnits: number | null;
};

export type AttentionItem = {
  type: "idle_machine" | "rework_pending";
  label: string;
  detail: string;
};

export type OperatorDailyRow = {
  operatorCode: string;
  employeeId: string | null;
  bagsFinalized: number;
  activeSecondsTotal: number;
  damageEventsTotal: number;
  reworkSentTotal: number;
  correctionsTotal: number;
};

export const WIDGET_CATALOG: {
  key: WidgetKey;
  label: string;
  description: string;
  defaultW: number;
  defaultH: number;
  minW: number;
  minH: number;
  defaultIncluded: boolean;
}[] = [
  {
    key: "floor-map",
    label: "Floor Map",
    description: "Dynamic machine topology — stations from DB, grouped by step",
    defaultW: 8,
    defaultH: 6,
    minW: 6,
    minH: 4,
    defaultIncluded: true,
  },
  {
    key: "queue-health",
    label: "Queue Health",
    description: "All stages: queue depth, age, AGING/STALLED status",
    defaultW: 4,
    defaultH: 4,
    minW: 3,
    minH: 3,
    defaultIncluded: true,
  },
  {
    key: "quality-watch",
    label: "Quality Watch",
    description: "Live feed of damage, rework, and correction events",
    defaultW: 4,
    defaultH: 5,
    minW: 3,
    minH: 3,
    defaultIncluded: true,
  },
  {
    key: "throughput-chart",
    label: "Throughput Chart",
    description: "Bags/hr trend line for the shift, with target rate overlay",
    defaultW: 6,
    defaultH: 4,
    minW: 4,
    minH: 3,
    defaultIncluded: false,
  },
  {
    key: "operator-board",
    label: "Operator Board",
    description: "Per-operator: bags completed, active time, damage events",
    defaultW: 6,
    defaultH: 5,
    minW: 4,
    minH: 3,
    defaultIncluded: false,
  },
  {
    key: "machine-focus",
    label: "Machine Focus",
    description: "Expanded single-machine view — choose which station to watch",
    defaultW: 4,
    defaultH: 4,
    minW: 3,
    minH: 3,
    defaultIncluded: false,
  },
  {
    key: "recent-events",
    label: "Recent Events",
    description: "Raw workflow event stream",
    defaultW: 4,
    defaultH: 5,
    minW: 3,
    minH: 3,
    defaultIncluded: false,
  },
];

export const DEFAULT_LAYOUT: WidgetLayout[] = [
  { key: "floor-map",     x: 0, y: 0, w: 8, h: 6 },
  { key: "queue-health",  x: 8, y: 0, w: 4, h: 4 },
  { key: "quality-watch", x: 8, y: 4, w: 4, h: 5 },
];
```

- [ ] **Step 2: Create lib/floor-command/step-groups.ts**

```typescript
// lib/floor-command/step-groups.ts

import type { StationKind, StationWithLive, StepGroup } from "./types";

export const STEP_GROUP_DEFS: { label: string; kinds: StationKind[] }[] = [
  { label: "Filling",  kinds: ["BLISTER", "BOTTLE_HANDPACK"] },
  { label: "Sealing",  kinds: ["SEALING", "BOTTLE_CAP_SEAL"] },
  { label: "Finishing", kinds: ["PACKAGING", "BOTTLE_STICKER", "COMBINED"] },
  { label: "Pack Out", kinds: ["HANDPACK_BLISTER"] },
];

// Pack-out station kinds render as operator grids, not machine SVGs.
export const PACK_OUT_KINDS: StationKind[] = ["HANDPACK_BLISTER", "COMBINED"];

export function groupStationsByStep(stations: StationWithLive[]): StepGroup[] {
  return STEP_GROUP_DEFS
    .map((def) => ({
      label: def.label,
      kinds: def.kinds,
      stations: stations.filter((s) => def.kinds.includes(s.kind)),
    }))
    .filter((g) => g.stations.length > 0);
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/floor-command/
git commit -m "feat: add floor-command shared types and step-groups"
```

---

## Task 4: Data layer — lib/production/floor-command.ts

**Files:**
- Create: `lib/production/floor-command.ts`

All functions read from existing read models and tables. No fold-on-read. No new read models needed.

- [ ] **Step 1: Create the file**

```typescript
// lib/production/floor-command.ts
"use server";

import { db } from "@/lib/db";
import {
  machines,
  products,
  readQueueState,
  readStationLive,
  readDailyThroughput,
  readBagState,
  readOperatorDaily,
  readBagMetrics,
  stations,
  workflowEvents,
} from "@/lib/db/schema";
import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type {
  AttentionItem,
  OperatorDailyRow,
  QueueHealthRow,
  ShiftTargetStatus,
  StationWithLive,
} from "@/lib/floor-command/types";

// ---------------------------------------------------------------------------
// Shift window helpers
// ---------------------------------------------------------------------------

const SHIFT_START_HOUR = 6;  // 06:00 local
const SHIFT_END_HOUR = 16;   // 16:00 local (10-hour shift)

/** Returns minutes elapsed since 6am and minutes remaining until 4pm,
 *  clamped to [0, 600]. Uses UTC if tz is invalid. */
export function computeShiftProgress(now: Date, tz: string): {
  minutesElapsed: number;
  minutesRemaining: number;
  shiftStartUtc: Date;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const shiftStartLocal = new Date(
    `${localDate}T${String(SHIFT_START_HOUR).padStart(2, "0")}:00:00`,
  );
  const shiftEndLocal = new Date(
    `${localDate}T${String(SHIFT_END_HOUR).padStart(2, "0")}:00:00`,
  );
  // Convert local midnight → UTC offset
  const offsetMs = now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: tz })).getTime();
  const shiftStartUtc = new Date(shiftStartLocal.getTime() - offsetMs);
  const shiftEndUtc = new Date(shiftEndLocal.getTime() - offsetMs);

  const elapsed = Math.max(0, Math.floor((now.getTime() - shiftStartUtc.getTime()) / 60000));
  const remaining = Math.max(0, Math.floor((shiftEndUtc.getTime() - now.getTime()) / 60000));

  return { minutesElapsed: elapsed, minutesRemaining: remaining, shiftStartUtc };
}

// ---------------------------------------------------------------------------
// 1. Stations with live state
// ---------------------------------------------------------------------------

export async function getStationsWithLiveState(): Promise<StationWithLive[]> {
  const rows = await db
    .select({
      id: stations.id,
      label: stations.label,
      kind: stations.kind,
      machineId: stations.machineId,
      machineName: machines.name,
      machineTargetBagsPerHour: machines.targetBagsPerHour,
      isActive: stations.isActive,
      currentWorkflowBagId: readStationLive.currentWorkflowBagId,
      currentProductId: readStationLive.currentProductId,
      currentProductName: products.name,
      currentEmployeeName: readStationLive.currentEmployeeName,
      lastEventType: readStationLive.lastEventType,
      lastEventAt: readStationLive.lastEventAt,
      busyForSeconds: readStationLive.busyForSeconds,
    })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .leftJoin(readStationLive, eq(stations.id, readStationLive.stationId))
    .leftJoin(products, eq(readStationLive.currentProductId, products.id))
    .where(eq(stations.isActive, true))
    .orderBy(stations.label);

  return rows.map((r) => ({
    ...r,
    kind: r.kind as StationWithLive["kind"],
  }));
}

// ---------------------------------------------------------------------------
// 2. Queue health summary
// ---------------------------------------------------------------------------

export async function getQueueHealthSummary(): Promise<QueueHealthRow[]> {
  const rows = await db
    .select({
      stageKey: readQueueState.stageKey,
      wip: readQueueState.wip,
      oldestAgeSeconds: readQueueState.oldestAgeSeconds,
      avgAgeSeconds: readQueueState.avgAgeSeconds,
      p90AgeSeconds: readQueueState.p90AgeSeconds,
      bagsOverThreshold: readQueueState.bagsOverThreshold,
      queueStatus: readQueueState.queueStatus,
    })
    .from(readQueueState)
    .orderBy(readQueueState.stageKey);

  return rows.map((r) => ({
    ...r,
    queueStatus: r.queueStatus as QueueHealthRow["queueStatus"],
  }));
}

// ---------------------------------------------------------------------------
// 3. Shift target status
// ---------------------------------------------------------------------------

export async function getShiftTargetStatus(tz: string): Promise<ShiftTargetStatus> {
  const now = new Date();
  const { minutesElapsed, minutesRemaining, shiftStartUtc } = computeShiftProgress(now, tz);

  // Sum units produced today across all products/machines
  const todayStr = shiftStartUtc.toISOString().slice(0, 10);
  const throughputRows = await db
    .select({
      unitsProduced: sql<number>`coalesce(sum(${readDailyThroughput.unitsProduced}), 0)`,
      productId: readDailyThroughput.productId,
    })
    .from(readDailyThroughput)
    .where(eq(readDailyThroughput.day, sql`${todayStr}::date`))
    .groupBy(readDailyThroughput.productId);

  const unitsProduced = throughputRows.reduce((acc, r) => acc + (r.unitsProduced ?? 0), 0);

  // Find the active product's daily goal (first product with a goal set)
  let dailyGoal: number | null = null;
  if (throughputRows.length > 0) {
    const productRow = await db
      .select({ dailyUnitGoal: products.dailyUnitGoal })
      .from(products)
      .where(eq(products.id, throughputRows[0]!.productId))
      .limit(1);
    dailyGoal = productRow[0]?.dailyUnitGoal ?? null;
  }

  const projectedTotal =
    minutesElapsed > 0 && dailyGoal !== null
      ? Math.round((unitsProduced / minutesElapsed) * (minutesElapsed + minutesRemaining))
      : null;

  const gapUnits =
    dailyGoal !== null && projectedTotal !== null
      ? dailyGoal - projectedTotal
      : null;

  return { unitsProduced, dailyGoal, minutesElapsed, minutesRemaining, projectedTotal, gapUnits };
}

// ---------------------------------------------------------------------------
// 4. Attention items
// ---------------------------------------------------------------------------

export async function getAttentionItems(): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const now = new Date();
  const idleThresholdMs = 5 * 60 * 1000; // 5 minutes

  // Idle machines: active stations with no current bag, last event >5min ago
  const liveRows = await db
    .select({
      stationId: readStationLive.stationId,
      label: sql<string>`${stations.label}`,
      lastEventAt: readStationLive.lastEventAt,
      currentWorkflowBagId: readStationLive.currentWorkflowBagId,
    })
    .from(readStationLive)
    .innerJoin(stations, eq(readStationLive.stationId, stations.id))
    .where(and(eq(stations.isActive, true), isNull(readStationLive.currentWorkflowBagId)));

  for (const row of liveRows) {
    if (row.lastEventAt && now.getTime() - row.lastEventAt.getTime() > idleThresholdMs) {
      const idleMinutes = Math.floor((now.getTime() - row.lastEventAt.getTime()) / 60000);
      items.push({
        type: "idle_machine",
        label: row.label,
        detail: `idle ${idleMinutes} min`,
      });
    }
  }

  // Rework pending bags
  const reworkRows = await db
    .select({
      workflowBagId: readBagState.workflowBagId,
      currentOperatorCode: readBagState.currentOperatorCode,
    })
    .from(readBagState)
    .where(eq(readBagState.reworkPending, true))
    .limit(10);

  for (const row of reworkRows) {
    items.push({
      type: "rework_pending",
      label: `Bag ${row.workflowBagId.slice(0, 8)}`,
      detail: row.currentOperatorCode ?? "unknown operator",
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// 5. Operator daily summary
// ---------------------------------------------------------------------------

export async function getOperatorDailySummary(tz: string): Promise<OperatorDailyRow[]> {
  const now = new Date();
  const { shiftStartUtc } = computeShiftProgress(now, tz);
  const todayStr = shiftStartUtc.toISOString().slice(0, 10);

  const rows = await db
    .select({
      operatorCode: readOperatorDaily.operatorCode,
      employeeId: readOperatorDaily.employeeId,
      bagsFinalized: readOperatorDaily.bagsFinalized,
      activeSecondsTotal: readOperatorDaily.activeSecondsTotal,
      damageEventsTotal: readOperatorDaily.damageEventsTotal,
      reworkSentTotal: readOperatorDaily.reworkSentTotal,
      correctionsTotal: readOperatorDaily.correctionsTotal,
    })
    .from(readOperatorDaily)
    .where(eq(readOperatorDaily.day, sql`${todayStr}::date`))
    .orderBy(desc(readOperatorDaily.bagsFinalized));

  return rows;
}

// ---------------------------------------------------------------------------
// 6. KPI strip data
// ---------------------------------------------------------------------------

export type KpiStripData = {
  bagsToday: number;
  unitsOut: number;
  avgCycleSeconds: number | null;
  activeOperators: number;
  firstPassYieldPct: number | null;
  stationsCurrentlyIdle: number;
};

export async function getKpiStripData(tz: string): Promise<KpiStripData> {
  const now = new Date();
  const { shiftStartUtc } = computeShiftProgress(now, tz);
  const todayStr = shiftStartUtc.toISOString().slice(0, 10);

  const [throughput, bagMetrics, liveStations] = await Promise.all([
    db
      .select({
        bagsFinalized: sql<number>`coalesce(sum(${readDailyThroughput.bagsFinalized}), 0)`,
        unitsProduced: sql<number>`coalesce(sum(${readDailyThroughput.unitsProduced}), 0)`,
      })
      .from(readDailyThroughput)
      .where(eq(readDailyThroughput.day, sql`${todayStr}::date`)),

    db
      .select({
        avgTotalSeconds: sql<number>`coalesce(avg(${readBagMetrics.totalSeconds}), 0)`,
        avgYieldPct: sql<number>`coalesce(avg(${readBagMetrics.yieldPct}), 0)`,
        cnt: sql<number>`count(*)`,
      })
      .from(readBagMetrics)
      .where(gte(readBagMetrics.finalizedAt, shiftStartUtc)),

    db
      .select({
        stationId: readStationLive.stationId,
        lastEventAt: readStationLive.lastEventAt,
        currentWorkflowBagId: readStationLive.currentWorkflowBagId,
      })
      .from(readStationLive)
      .innerJoin(stations, eq(readStationLive.stationId, stations.id))
      .where(eq(stations.isActive, true)),
  ]);

  const idleThresholdMs = 5 * 60 * 1000;
  const activeThresholdMs = 15 * 60 * 1000;

  const activeOperators = liveStations.filter(
    (s) => s.lastEventAt && now.getTime() - s.lastEventAt.getTime() < activeThresholdMs,
  ).length;

  const stationsCurrentlyIdle = liveStations.filter(
    (s) =>
      s.currentWorkflowBagId === null &&
      s.lastEventAt &&
      now.getTime() - s.lastEventAt.getTime() > idleThresholdMs,
  ).length;

  const bagData = bagMetrics[0];
  const t = throughput[0];

  return {
    bagsToday: t?.bagsFinalized ?? 0,
    unitsOut: t?.unitsProduced ?? 0,
    avgCycleSeconds: bagData && Number(bagData.cnt) > 0 ? Math.round(Number(bagData.avgTotalSeconds)) : null,
    activeOperators,
    firstPassYieldPct: bagData && Number(bagData.cnt) > 0 ? Math.round(Number(bagData.avgYieldPct) * 10) / 10 : null,
    stationsCurrentlyIdle,
  };
}

// ---------------------------------------------------------------------------
// 7. Recent events (for recent-events widget)
// ---------------------------------------------------------------------------

export type RecentEventRow = {
  id: string;
  eventType: string;
  workflowBagId: string;
  stationId: string | null;
  operatorCode: string | null;
  occurredAt: Date;
};

export async function getRecentEvents(limit = 30): Promise<RecentEventRow[]> {
  const rows = await db
    .select({
      id: workflowEvents.id,
      eventType: workflowEvents.eventType,
      workflowBagId: workflowEvents.workflowBagId,
      stationId: workflowEvents.stationId,
      operatorCode: workflowEvents.operatorCode,
      occurredAt: workflowEvents.occurredAt,
    })
    .from(workflowEvents)
    .orderBy(desc(workflowEvents.occurredAt))
    .limit(limit);

  return rows;
}
```

- [ ] **Step 2: Check TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "floor-command" | head -20
```

Expected: no errors on the new file. Fix any missing column names by checking the schema (e.g., if `readBagMetrics.finalizedAt` doesn't exist, use `readBagMetrics.createdAt` or whatever the timestamp column is named).

- [ ] **Step 3: Commit**

```bash
git add lib/production/floor-command.ts
git commit -m "feat: add floor-command data layer functions"
```

---

## Task 5: Unit tests for pure functions

**Files:**
- Create: `lib/floor-command/__tests__/floor-command.test.ts`

The only function worth unit-testing without a DB is `computeShiftProgress`.

- [ ] **Step 1: Create the test file**

```typescript
// lib/floor-command/__tests__/floor-command.test.ts
import { describe, expect, it } from "vitest";
import { computeShiftProgress } from "@/lib/production/floor-command";

describe("computeShiftProgress", () => {
  it("returns ~0 elapsed at 6:01am", () => {
    // 2026-05-22 06:01 America/Toronto (UTC-4)
    const now = new Date("2026-05-22T10:01:00Z");
    const result = computeShiftProgress(now, "America/Toronto");
    expect(result.minutesElapsed).toBeGreaterThanOrEqual(0);
    expect(result.minutesElapsed).toBeLessThan(5);
    expect(result.minutesRemaining).toBeGreaterThan(590);
  });

  it("returns ~300 elapsed at 11am", () => {
    // 2026-05-22 11:00 America/Toronto (UTC-4)
    const now = new Date("2026-05-22T15:00:00Z");
    const result = computeShiftProgress(now, "America/Toronto");
    expect(result.minutesElapsed).toBeGreaterThanOrEqual(295);
    expect(result.minutesElapsed).toBeLessThanOrEqual(305);
  });

  it("clamps remaining to 0 after shift end", () => {
    // 2026-05-22 17:00 America/Toronto — after shift end
    const now = new Date("2026-05-22T21:00:00Z");
    const result = computeShiftProgress(now, "America/Toronto");
    expect(result.minutesRemaining).toBe(0);
  });

  it("handles UTC timezone without throwing", () => {
    const now = new Date("2026-05-22T10:00:00Z");
    expect(() => computeShiftProgress(now, "UTC")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm run test -- lib/floor-command/__tests__/floor-command.test.ts
```

Expected: 4 tests pass. If timezone offset math fails, adjust the UTC times in the test to match your local offset.

- [ ] **Step 3: Commit**

```bash
git add lib/floor-command/__tests__/
git commit -m "test: add computeShiftProgress unit tests"
```

---

## Task 6: Layout config API route

**Files:**
- Create: `app/api/dashboard-config/route.ts`

- [ ] **Step 1: Create the route**

```typescript
// app/api/dashboard-config/route.ts
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { userDashboardConfig } from "@/lib/db/schema";
import { DEFAULT_LAYOUT } from "@/lib/floor-command/types";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const BOARD_KEY = "floor-command";

const WidgetLayoutSchema = z.object({
  key: z.string(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  config: z
    .object({ stationId: z.string().optional() })
    .optional(),
});

const PutBodySchema = z.object({
  layout: z.array(WidgetLayoutSchema).min(1).max(20),
});

export async function GET() {
  const user = await requireSession();

  const existing = await db
    .select({ layoutJson: userDashboardConfig.layoutJson })
    .from(userDashboardConfig)
    .where(
      and(
        eq(userDashboardConfig.userId, user.id),
        eq(userDashboardConfig.boardKey, BOARD_KEY),
      ),
    )
    .limit(1);

  const layout = existing[0]?.layoutJson ?? DEFAULT_LAYOUT;
  return NextResponse.json({ layout });
}

export async function PUT(req: NextRequest) {
  const user = await requireSession();
  const body = await req.json();
  const parsed = PutBodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid layout" }, { status: 400 });
  }

  await db
    .insert(userDashboardConfig)
    .values({
      userId: user.id,
      boardKey: BOARD_KEY,
      layoutJson: parsed.data.layout,
    })
    .onConflictDoUpdate({
      target: [userDashboardConfig.userId, userDashboardConfig.boardKey],
      set: {
        layoutJson: parsed.data.layout,
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "dashboard-config" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/dashboard-config/
git commit -m "feat: add dashboard-config GET/PUT API for layout persistence"
```

---

## Task 7: Zone 1 — Status Bar component

**Files:**
- Create: `app/(admin)/floor-board/_components/status-bar.tsx`

- [ ] **Step 1: Create status-bar.tsx**

```tsx
// app/(admin)/floor-board/_components/status-bar.tsx
import type { ShiftStatusData, StatusCell, StatusLevel } from "@/lib/floor-command/types";

const LEVEL_STYLES: Record<StatusLevel, { border: string; badge: string; text: string; dot: string }> = {
  good:    { border: "border-emerald-500/40", badge: "bg-emerald-500/10", text: "text-emerald-400", dot: "bg-emerald-400" },
  warn:    { border: "border-amber-500/40",   badge: "bg-amber-500/10",   text: "text-amber-400",   dot: "bg-amber-400" },
  crit:    { border: "border-red-500/40",     badge: "bg-red-500/10",     text: "text-red-400",     dot: "bg-red-400" },
  neutral: { border: "border-white/10",       badge: "bg-white/5",        text: "text-slate-400",   dot: "bg-slate-500" },
};

function StatusCellView({ cell }: { cell: StatusCell }) {
  const s = LEVEL_STYLES[cell.level];
  return (
    <div className={`flex items-center gap-3 px-4 py-2 rounded border ${s.border} ${s.badge} flex-1 min-w-0`}>
      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${s.dot}`} />
      <div className="min-w-0">
        <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">{cell.label}</div>
        <div className={`text-sm font-semibold truncate ${s.text}`}>{cell.value}</div>
        {cell.detail && (
          <div className="text-[11px] text-slate-500 truncate">{cell.detail}</div>
        )}
      </div>
    </div>
  );
}

export function StatusBar({ data }: { data: ShiftStatusData }) {
  return (
    <div className="flex items-stretch gap-2 px-4 py-2 bg-slate-900/80 border-b border-white/10 h-14">
      <StatusCellView cell={data.target} />
      <StatusCellView cell={data.bottleneck} />
      <StatusCellView cell={data.quality} />
      <StatusCellView cell={data.attention} />
    </div>
  );
}
```

- [ ] **Step 2: Create the builder function that converts raw data into ShiftStatusData**

Add this to `lib/production/floor-command.ts` (append at the bottom of the file):

```typescript
// Add to lib/production/floor-command.ts

import type { ShiftStatusData, StatusCell } from "@/lib/floor-command/types";
import type { QueueHealthRow, AttentionItem, ShiftTargetStatus } from "@/lib/floor-command/types";

export function buildShiftStatusData(
  target: ShiftTargetStatus,
  queues: QueueHealthRow[],
  yieldPct: number | null,
  attention: AttentionItem[],
): ShiftStatusData {
  // Target cell
  let targetCell: StatusCell;
  if (target.dailyGoal === null) {
    targetCell = {
      label: "Target",
      value: `${target.unitsProduced.toLocaleString()} units`,
      detail: "no daily goal set",
      level: "neutral",
    };
  } else {
    const gapPct = target.projectedTotal !== null
      ? (target.dailyGoal - target.projectedTotal) / target.dailyGoal
      : 0;
    const level = gapPct > 0.1 ? "crit" : gapPct > 0 ? "warn" : "good";
    const gapLabel = target.gapUnits !== null && target.gapUnits > 0
      ? `behind ${target.gapUnits.toLocaleString()} units`
      : "on pace";
    targetCell = {
      label: "Target",
      value: `${target.unitsProduced.toLocaleString()} / ${target.dailyGoal.toLocaleString()} units`,
      detail: gapLabel,
      level,
    };
  }

  // Bottleneck cell
  const stalled = queues.filter((q) => q.queueStatus === "STALLED");
  const aging = queues.filter((q) => q.queueStatus === "AGING");
  let bottleneckCell: StatusCell;
  if (stalled.length > 0) {
    const worst = stalled[0]!;
    const ageMin = worst.oldestAgeSeconds ? Math.floor(worst.oldestAgeSeconds / 60) : null;
    bottleneckCell = {
      label: "Bottleneck",
      value: worst.stageKey.replace(/_/g, " ").toLowerCase(),
      detail: ageMin !== null ? `stalled — oldest bag ${ageMin} min` : "stalled",
      level: "crit",
    };
  } else if (aging.length > 0) {
    const worst = aging[0]!;
    const ageMin = worst.oldestAgeSeconds ? Math.floor(worst.oldestAgeSeconds / 60) : null;
    bottleneckCell = {
      label: "Bottleneck",
      value: worst.stageKey.replace(/_/g, " ").toLowerCase(),
      detail: ageMin !== null ? `aging — oldest bag ${ageMin} min` : "aging",
      level: "warn",
    };
  } else {
    bottleneckCell = { label: "Bottleneck", value: "all stages flowing", level: "good" };
  }

  // Quality cell
  let qualityCell: StatusCell;
  if (yieldPct === null) {
    qualityCell = { label: "Quality", value: "no data yet", level: "neutral" };
  } else {
    const level = yieldPct >= 98 ? "good" : yieldPct >= 94 ? "warn" : "crit";
    qualityCell = {
      label: "Quality",
      value: `${yieldPct.toFixed(1)}% first-pass yield`,
      level,
    };
  }

  // Attention cell
  let attentionCell: StatusCell;
  if (attention.length === 0) {
    attentionCell = { label: "Attention", value: "all machines active", level: "good" };
  } else {
    const first = attention[0]!;
    attentionCell = {
      label: "Attention",
      value: `${first.label} — ${first.detail}`,
      detail: attention.length > 1 ? `+${attention.length - 1} more` : undefined,
      level: attention.length >= 2 ? "crit" : "warn",
    };
  }

  return { target: targetCell, bottleneck: bottleneckCell, quality: qualityCell, attention: attentionCell };
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "status-bar\|floor-command" | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/\(admin\)/floor-board/_components/status-bar.tsx lib/production/floor-command.ts
git commit -m "feat: add Zone 1 status bar and buildShiftStatusData"
```

---

## Task 8: Zone 3 — KPI Strip component

**Files:**
- Create: `app/(admin)/floor-board/_components/kpi-strip.tsx`

- [ ] **Step 1: Create kpi-strip.tsx**

```tsx
// app/(admin)/floor-board/_components/kpi-strip.tsx
import type { KpiStripData } from "@/lib/production/floor-command";

function formatSeconds(s: number | null): string {
  if (s === null) return "--";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function KpiCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 border-r border-white/10 last:border-0 flex-1">
      <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">{label}</div>
      <div className="text-lg font-bold text-slate-100 tabular-nums">{value}</div>
    </div>
  );
}

export function KpiStrip({ data }: { data: KpiStripData }) {
  return (
    <div className="flex items-stretch h-12 bg-slate-900/90 border-t border-white/10">
      <KpiCell label="Bags Today" value={data.bagsToday.toLocaleString()} />
      <KpiCell label="Units Out" value={data.unitsOut.toLocaleString()} />
      <KpiCell label="Avg Cycle" value={formatSeconds(data.avgCycleSeconds)} />
      <KpiCell label="Active Operators" value={String(data.activeOperators)} />
      <KpiCell
        label="First-Pass Yield"
        value={data.firstPassYieldPct !== null ? `${data.firstPassYieldPct}%` : "--"}
      />
      <KpiCell label="Stations Idle" value={String(data.stationsCurrentlyIdle)} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/\(admin\)/floor-board/_components/kpi-strip.tsx
git commit -m "feat: add Zone 3 KPI strip component"
```

---

## Task 9: Floor Map widget

**Files:**
- Create: `app/(admin)/floor-board/_components/widgets/floor-map-widget.tsx`

This widget renders the dynamic machine topology. Machines are keyed by `station.kind` to select their SVG illustration. The SVGs use the v8 CSS class grammar from the design system (`base`, `body`, `glass`, `glow`, etc.).

- [ ] **Step 1: Create floor-map-widget.tsx**

```tsx
// app/(admin)/floor-board/_components/widgets/floor-map-widget.tsx
"use client";

import { groupStationsByStep, PACK_OUT_KINDS } from "@/lib/floor-command/step-groups";
import type { StationWithLive, StepGroup } from "@/lib/floor-command/types";
import { Users } from "lucide-react";

// v8 CSS class machine illustrations — inline SVG per machine_kind.
// These use the design system's .base, .body, .glass, .glow class grammar
// with CSS vars: --bg-base, --emerald, --amber, --coral, --steel.

function BlisterSvg() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full" aria-hidden="true">
      <rect className="base" x="5" y="5" width="90" height="50" rx="4" />
      <rect className="body" x="10" y="12" width="55" height="36" rx="2" />
      <rect className="body-d" x="68" y="12" width="22" height="36" rx="2" />
      <rect className="panel" x="14" y="16" width="47" height="28" rx="1" />
      <rect className="glass" x="16" y="18" width="43" height="24" rx="1" />
      <rect className="glow" x="14" y="37" width="47" height="4" rx="1" />
      <circle className="det" cx="73" cy="20" r="3" />
      <circle className="det" cx="83" cy="20" r="3" />
      <rect className="scrn" x="70" y="28" width="16" height="12" rx="1" />
    </svg>
  );
}

function SealerSvg() {
  return (
    <svg viewBox="0 0 100 32" className="w-full h-full" aria-hidden="true">
      <rect className="base" x="3" y="3" width="94" height="26" rx="3" />
      <rect className="body" x="8" y="7" width="60" height="18" rx="2" />
      <rect className="body-d" x="72" y="7" width="18" height="18" rx="2" />
      <rect className="panel" x="12" y="10" width="52" height="12" rx="1" />
      <rect className="glow" x="12" y="18" width="52" height="2" />
      <rect className="seam" x="8" y="15" width="60" height="1" />
      <circle className="det" cx="76" cy="13" r="2" />
      <circle className="det" cx="84" cy="13" r="2" />
    </svg>
  );
}

function StickerSvg() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full" aria-hidden="true">
      <circle className="base" cx="20" cy="30" r="18" />
      <circle className="body" cx="20" cy="30" r="12" />
      <circle className="body-d" cx="20" cy="30" r="6" />
      <rect className="body" x="44" y="10" width="20" height="40" rx="3" />
      <rect className="body-d" x="68" y="10" width="20" height="40" rx="3" />
      <rect className="glass" x="46" y="12" width="16" height="36" rx="2" />
      <rect className="glass" x="70" y="12" width="16" height="36" rx="2" />
      <line x1="38" y1="30" x2="44" y2="30" className="glow" strokeWidth="2" />
      <line x1="64" y1="30" x2="68" y2="30" className="glow" strokeWidth="2" />
    </svg>
  );
}

function PackagingSvg() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full" aria-hidden="true">
      <rect className="base" x="10" y="20" width="50" height="35" rx="2" />
      <rect className="body" x="13" y="23" width="44" height="29" rx="1" />
      <polygon className="body-d" points="10,20 35,5 60,20" />
      <polygon className="panel" points="13,20 35,8 57,20" />
      <rect className="glow" x="18" y="38" width="34" height="3" rx="1" />
      <rect className="base" x="65" y="30" width="30" height="25" rx="2" />
      <rect className="body" x="67" y="32" width="26" height="21" rx="1" />
      <polygon className="body-d" points="65,30 80,20 95,30" />
    </svg>
  );
}

function HandpackSvg() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full" aria-hidden="true">
      <rect className="base" x="5" y="30" width="90" height="25" rx="3" />
      <rect className="body" x="8" y="33" width="84" height="19" rx="2" />
      <rect className="seam" x="8" y="42" width="84" height="1" />
      <circle className="det" cx="20" cy="22" r="8" />
      <circle className="body-d" cx="20" cy="22" r="5" />
      <circle className="det" cx="50" cy="20" r="8" />
      <circle className="body-d" cx="50" cy="20" r="5" />
      <circle className="det" cx="80" cy="22" r="8" />
      <circle className="body-d" cx="80" cy="22" r="5" />
    </svg>
  );
}

function MACHINE_SVG({ kind }: { kind: string }) {
  switch (kind) {
    case "BLISTER":
    case "BOTTLE_HANDPACK": return <BlisterSvg />;
    case "SEALING":
    case "BOTTLE_CAP_SEAL": return <SealerSvg />;
    case "BOTTLE_STICKER":  return <StickerSvg />;
    case "PACKAGING":
    case "COMBINED":        return <PackagingSvg />;
    case "HANDPACK_BLISTER": return <HandpackSvg />;
    default: return <PackagingSvg />;
  }
}

function formatBusyTime(seconds: number | null): string {
  if (seconds === null) return "";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

type CardStatus = "running" | "paused" | "idle" | "empty";

function getCardStatus(station: StationWithLive): CardStatus {
  if (!station.lastEventAt) return "empty";
  const now = Date.now();
  const age = now - station.lastEventAt.getTime();
  if (station.currentWorkflowBagId) {
    return age < 30 * 60 * 1000 ? "running" : "paused";
  }
  return age < 5 * 60 * 1000 ? "idle" : "empty";
}

const CARD_STATUS_STYLES: Record<CardStatus, string> = {
  running: "border-emerald-500/60 shadow-emerald-900/40",
  paused:  "border-amber-500/50",
  idle:    "border-slate-600/50",
  empty:   "border-slate-700/30 opacity-50",
};

function MachineCard({ station }: { station: StationWithLive }) {
  const status = getCardStatus(station);
  const isPack = PACK_OUT_KINDS.includes(station.kind);

  return (
    <div
      className={`flex flex-col rounded border bg-slate-900 p-2 gap-1 ${CARD_STATUS_STYLES[status]}`}
      style={{ minWidth: 120 }}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] font-semibold text-slate-300 truncate">{station.label}</span>
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            status === "running" ? "bg-emerald-400" :
            status === "paused"  ? "bg-amber-400" :
            status === "idle"    ? "bg-slate-500" :
            "bg-slate-700"
          }`}
        />
      </div>

      {isPack ? (
        <div className="flex items-center gap-1 h-10 text-slate-500">
          <Users size={14} />
          <span className="text-[10px]">hand pack</span>
        </div>
      ) : (
        <div className="h-10 opacity-70">
          <MACHINE_SVG kind={station.kind} />
        </div>
      )}

      {station.currentEmployeeName && (
        <div className="text-[10px] text-slate-400 truncate">{station.currentEmployeeName}</div>
      )}
      {station.currentProductName && (
        <div className="text-[10px] text-slate-500 truncate">{station.currentProductName}</div>
      )}
      {station.machineTargetBagsPerHour && station.busyForSeconds !== null && (
        <div className="text-[10px] text-slate-500">
          {formatBusyTime(station.busyForSeconds)} on bag · target {station.machineTargetBagsPerHour}/hr
        </div>
      )}
    </div>
  );
}

function StepColumn({ group }: { group: StepGroup }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-1">
        {group.label}
      </div>
      <div className="flex flex-col gap-2">
        {group.stations.map((s) => (
          <MachineCard key={s.id} station={s} />
        ))}
      </div>
    </div>
  );
}

function QueueBadge({ wip, status }: { wip: number; status: string }) {
  const color =
    status === "STALLED" ? "bg-red-500/20 text-red-400 border-red-500/40" :
    status === "AGING"   ? "bg-amber-500/20 text-amber-400 border-amber-500/40" :
    wip > 0              ? "bg-slate-700/50 text-slate-400 border-slate-600/40" :
                           "bg-transparent text-slate-600 border-transparent";

  return (
    <div className={`flex flex-col items-center justify-center self-center px-3 py-1 rounded border text-[10px] font-semibold ${color}`}>
      <span>{wip}</span>
      <span className="font-normal opacity-70">in queue</span>
    </div>
  );
}

export function FloorMapWidget({ stations }: { stations: StationWithLive[] }) {
  const groups = groupStationsByStep(stations);

  if (groups.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        No active stations found. Add stations in master data.
      </div>
    );
  }

  return (
    <div className="flex items-start gap-4 p-3 overflow-x-auto h-full">
      {groups.map((group, i) => (
        <div key={group.label} className="flex items-start gap-3">
          <StepColumn group={group} />
          {i < groups.length - 1 && (
            <div className="flex items-center self-center">
              <div className="w-6 h-px bg-slate-600" />
              <div className="w-0 h-0 border-t-4 border-b-4 border-l-4 border-t-transparent border-b-transparent border-l-slate-600" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add the v8 machine SVG styles to the global CSS**

The SVG classes (`base`, `body`, `body-d`, `glass`, `glow`, `panel`, `det`, `seam`, `scrn`) need to be defined. Find the global CSS file (usually `app/globals.css` or `styles/globals.css`) and append:

```css
/* v8 machine illustration SVG class grammar */
svg .base   { fill: var(--mc-base, #0f1520); }
svg .body   { fill: var(--mc-body, #1a2535); }
svg .body-l { fill: var(--mc-body-l, #243040); }
svg .body-d { fill: var(--mc-body-d, #101820); }
svg .panel  { fill: var(--mc-panel, #1e2d42); }
svg .glass  { fill: var(--mc-glass, #2a4060); opacity: 0.6; }
svg .glow   { fill: var(--mc-glow, #2ee8a5); opacity: 0.8; }
svg .glow-d { fill: var(--mc-glow-d, #1aaa78); opacity: 0.6; }
svg .warn   { fill: var(--mc-warn, #f5b544); opacity: 0.9; }
svg .det    { fill: var(--mc-det, #2a3548); }
svg .seam   { fill: var(--mc-seam, #2a3548); }
svg .scrn   { fill: var(--mc-scrn, #0a1525); }
```

- [ ] **Step 3: Commit**

```bash
git add app/\(admin\)/floor-board/_components/widgets/floor-map-widget.tsx
git commit -m "feat: add floor-map widget with dynamic topology rendering"
```

---

## Task 10: Queue Health + Quality Watch widgets

**Files:**
- Create: `app/(admin)/floor-board/_components/widgets/queue-health-widget.tsx`
- Create: `app/(admin)/floor-board/_components/widgets/quality-watch-widget.tsx`

- [ ] **Step 1: Create queue-health-widget.tsx**

```tsx
// app/(admin)/floor-board/_components/widgets/queue-health-widget.tsx
"use client";

import type { QueueHealthRow } from "@/lib/floor-command/types";

const STATUS_STYLES = {
  STALLED:  { badge: "bg-red-500/20 text-red-400", bar: "bg-red-500" },
  AGING:    { badge: "bg-amber-500/20 text-amber-400", bar: "bg-amber-500" },
  FLOWING:  { badge: "bg-emerald-500/20 text-emerald-400", bar: "bg-emerald-500" },
  EMPTY:    { badge: "bg-slate-700/40 text-slate-500", bar: "bg-slate-700" },
} as const;

function formatAge(seconds: number | null): string {
  if (seconds === null) return "--";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function QueueHealthWidget({ queues }: { queues: QueueHealthRow[] }) {
  if (queues.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        No queue data yet
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2 overflow-y-auto h-full">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Queue Health</div>
      {queues.map((q) => {
        const s = STATUS_STYLES[q.queueStatus];
        return (
          <div key={q.stageKey} className="flex items-center gap-2 py-1.5 border-b border-white/5">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-medium text-slate-300 truncate">
                {q.stageKey.replace(/_/g, " ").toLowerCase()}
              </div>
              <div className="text-[10px] text-slate-600">
                oldest: {formatAge(q.oldestAgeSeconds)}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-sm font-bold tabular-nums text-slate-200">{q.wip}</span>
              <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${s.badge}`}>
                {q.queueStatus}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create quality-watch-widget.tsx**

```tsx
// app/(admin)/floor-board/_components/widgets/quality-watch-widget.tsx
"use client";

import type { RecentEventRow } from "@/lib/production/floor-command";

const QUALITY_EVENT_TYPES = new Set([
  "DAMAGE_REPORTED",
  "REWORK_SENT",
  "REWORK_RECEIVED",
  "CORRECTION_LOGGED",
  "BAG_SCRAPPED",
  "HOLD_PLACED",
  "HOLD_RELEASED",
]);

const EVENT_STYLES: Record<string, string> = {
  DAMAGE_REPORTED: "text-red-400",
  REWORK_SENT:     "text-amber-400",
  REWORK_RECEIVED: "text-sky-400",
  CORRECTION_LOGGED: "text-purple-400",
  BAG_SCRAPPED:    "text-red-500",
  HOLD_PLACED:     "text-orange-400",
  HOLD_RELEASED:   "text-emerald-400",
};

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function QualityWatchWidget({ events }: { events: RecentEventRow[] }) {
  const qualityEvents = events.filter((e) => QUALITY_EVENT_TYPES.has(e.eventType));

  return (
    <div className="flex flex-col gap-1 p-2 overflow-y-auto h-full">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Quality Watch</div>
      {qualityEvents.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-sm text-emerald-400">
          First-pass clean
        </div>
      ) : (
        qualityEvents.map((e) => (
          <div key={e.id} className="flex items-start gap-2 py-1.5 border-b border-white/5">
            <div className="flex-1 min-w-0">
              <div className={`text-[11px] font-semibold truncate ${EVENT_STYLES[e.eventType] ?? "text-slate-400"}`}>
                {e.eventType.replace(/_/g, " ").toLowerCase()}
              </div>
              <div className="text-[10px] text-slate-600 truncate">
                bag {e.workflowBagId.slice(0, 8)}
                {e.operatorCode ? ` · ${e.operatorCode}` : ""}
              </div>
            </div>
            <div className="text-[10px] text-slate-600 flex-shrink-0">{timeAgo(new Date(e.occurredAt))}</div>
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/\(admin\)/floor-board/_components/widgets/queue-health-widget.tsx \
        app/\(admin\)/floor-board/_components/widgets/quality-watch-widget.tsx
git commit -m "feat: add queue-health and quality-watch widgets"
```

---

## Task 11: Throughput Chart + Operator Board widgets

**Files:**
- Create: `app/(admin)/floor-board/_components/widgets/throughput-chart-widget.tsx`
- Create: `app/(admin)/floor-board/_components/widgets/operator-board-widget.tsx`

- [ ] **Step 1: Create throughput-chart-widget.tsx**

```tsx
// app/(admin)/floor-board/_components/widgets/throughput-chart-widget.tsx
"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type ThroughputDataPoint = {
  label: string;   // e.g. "07:00"
  bagsPerHour: number;
  targetBagsPerHour: number | null;
};

export function ThroughputChartWidget({
  data,
  targetBagsPerHour,
}: {
  data: ThroughputDataPoint[];
  targetBagsPerHour: number | null;
}) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        No throughput data yet
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2 h-full">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Throughput (bags/hr)</div>
      <div className="flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="label"
              tick={{ fill: "#64748b", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "#64748b", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{ background: "#0f1a2b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4 }}
              labelStyle={{ color: "#94a3b8", fontSize: 11 }}
              itemStyle={{ color: "#2ee8a5", fontSize: 11 }}
            />
            {targetBagsPerHour !== null && (
              <ReferenceLine
                y={targetBagsPerHour}
                stroke="#f5b544"
                strokeDasharray="4 4"
                label={{ value: `target ${targetBagsPerHour}`, fill: "#f5b544", fontSize: 10 }}
              />
            )}
            <Line
              type="monotone"
              dataKey="bagsPerHour"
              stroke="#2ee8a5"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "#2ee8a5" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create operator-board-widget.tsx**

```tsx
// app/(admin)/floor-board/_components/widgets/operator-board-widget.tsx
"use client";

import type { OperatorDailyRow } from "@/lib/floor-command/types";

function formatActiveTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function OperatorBoardWidget({ operators }: { operators: OperatorDailyRow[] }) {
  if (operators.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-sm">
        No operator data yet
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2 overflow-y-auto h-full">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Operator Board</div>
      <div className="grid grid-cols-5 text-[9px] text-slate-600 uppercase tracking-wider pb-1 border-b border-white/10">
        <span className="col-span-2">Operator</span>
        <span className="text-right">Bags</span>
        <span className="text-right">Active</span>
        <span className="text-right">Damage</span>
      </div>
      {operators.map((op) => (
        <div key={op.operatorCode} className="grid grid-cols-5 items-center py-1 border-b border-white/5">
          <div className="col-span-2 flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-[9px] font-bold text-slate-300 flex-shrink-0">
              {op.operatorCode.slice(0, 2).toUpperCase()}
            </div>
            <span className="text-[11px] text-slate-300 truncate">{op.operatorCode}</span>
          </div>
          <span className="text-right text-sm font-bold tabular-nums text-slate-200">{op.bagsFinalized}</span>
          <span className="text-right text-[10px] text-slate-400">{formatActiveTime(op.activeSecondsTotal)}</span>
          <span className={`text-right text-[10px] font-semibold ${op.damageEventsTotal > 0 ? "text-red-400" : "text-slate-600"}`}>
            {op.damageEventsTotal || "--"}
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/\(admin\)/floor-board/_components/widgets/throughput-chart-widget.tsx \
        app/\(admin\)/floor-board/_components/widgets/operator-board-widget.tsx
git commit -m "feat: add throughput-chart and operator-board widgets"
```

---

## Task 12: Machine Focus + Recent Events widgets

**Files:**
- Create: `app/(admin)/floor-board/_components/widgets/machine-focus-widget.tsx`
- Create: `app/(admin)/floor-board/_components/widgets/recent-events-widget.tsx`

- [ ] **Step 1: Create machine-focus-widget.tsx**

```tsx
// app/(admin)/floor-board/_components/widgets/machine-focus-widget.tsx
"use client";

import type { StationWithLive } from "@/lib/floor-command/types";
import { Settings } from "lucide-react";

function formatSeconds(s: number | null): string {
  if (s === null) return "--";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function MachineFocusWidget({
  station,
  stationId,
  isEditing,
  onReconfigure,
}: {
  station: StationWithLive | null;
  stationId: string | undefined;
  isEditing: boolean;
  onReconfigure?: () => void;
}) {
  if (!stationId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-500">
        <Settings size={20} />
        <span className="text-sm">Select a station to focus</span>
        {isEditing && (
          <button
            onClick={onReconfigure}
            className="text-xs text-sky-400 underline"
          >
            Configure
          </button>
        )}
      </div>
    );
  }

  if (!station) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-500">
        <span className="text-sm">Station not found</span>
        {isEditing && (
          <button onClick={onReconfigure} className="text-xs text-sky-400 underline">
            Reconfigure
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3 h-full">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold text-slate-300">{station.label}</div>
          <div className="text-[10px] text-slate-500">{station.kind.replace(/_/g, " ").toLowerCase()}</div>
        </div>
        {isEditing && (
          <button onClick={onReconfigure} className="text-[10px] text-sky-400">
            Change
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {[
          { label: "Operator", value: station.currentEmployeeName ?? "--" },
          { label: "Product", value: station.currentProductName ?? "--" },
          { label: "Time on bag", value: formatSeconds(station.busyForSeconds) },
          { label: "Target rate", value: station.machineTargetBagsPerHour ? `${station.machineTargetBagsPerHour}/hr` : "--" },
        ].map(({ label, value }) => (
          <div key={label} className="bg-slate-800/60 rounded p-2">
            <div className="text-[9px] text-slate-600 uppercase tracking-wider">{label}</div>
            <div className="text-sm font-semibold text-slate-200 truncate">{value}</div>
          </div>
        ))}
      </div>

      {station.lastEventType && (
        <div className="text-[10px] text-slate-500">
          Last: {station.lastEventType.replace(/_/g, " ").toLowerCase()}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create recent-events-widget.tsx**

```tsx
// app/(admin)/floor-board/_components/widgets/recent-events-widget.tsx
"use client";

import type { RecentEventRow } from "@/lib/production/floor-command";

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function RecentEventsWidget({ events }: { events: RecentEventRow[] }) {
  return (
    <div className="flex flex-col gap-1 p-2 overflow-y-auto h-full">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Recent Events</div>
      {events.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-sm text-slate-600">No events yet</div>
      ) : (
        events.map((e) => (
          <div key={e.id} className="flex items-start gap-2 py-1 border-b border-white/5">
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-medium text-slate-300 truncate">
                {e.eventType.replace(/_/g, " ").toLowerCase()}
              </div>
              <div className="text-[9px] text-slate-600">
                {e.workflowBagId.slice(0, 8)}
                {e.operatorCode ? ` · ${e.operatorCode}` : ""}
              </div>
            </div>
            <div className="text-[9px] text-slate-700 flex-shrink-0">{timeAgo(new Date(e.occurredAt))}</div>
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/\(admin\)/floor-board/_components/widgets/machine-focus-widget.tsx \
        app/\(admin\)/floor-board/_components/widgets/recent-events-widget.tsx
git commit -m "feat: add machine-focus and recent-events widgets"
```

---

## Task 13: Widget Grid + Edit Mode (Client Component)

**Files:**
- Create: `app/(admin)/floor-board/_components/widget-grid.tsx`
- Create: `app/(admin)/floor-board/_components/widget-picker.tsx`

This is the core client-side orchestration component. It owns layout state, edit mode, and calls the config API.

- [ ] **Step 1: Create widget-grid.tsx**

```tsx
// app/(admin)/floor-board/_components/widget-grid.tsx
"use client";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { useCallback, useState } from "react";
import GridLayout, { type Layout, WidthProvider } from "react-grid-layout";
import { WIDGET_CATALOG, type WidgetKey, type WidgetLayout } from "@/lib/floor-command/types";
import { FloorMapWidget } from "./widgets/floor-map-widget";
import { QueueHealthWidget } from "./widgets/queue-health-widget";
import { QualityWatchWidget } from "./widgets/quality-watch-widget";
import { ThroughputChartWidget } from "./widgets/throughput-chart-widget";
import { OperatorBoardWidget } from "./widgets/operator-board-widget";
import { MachineFocusWidget } from "./widgets/machine-focus-widget";
import { RecentEventsWidget } from "./widgets/recent-events-widget";
import type { WidgetGridData } from "./floor-command-client";
import { X, GripVertical } from "lucide-react";

const ResponsiveGridLayout = WidthProvider(GridLayout);

function WidgetShell({
  title,
  isEditing,
  onRemove,
  children,
}: {
  title: string;
  isEditing: boolean;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full bg-slate-900 border border-white/10 rounded overflow-hidden">
      {isEditing && (
        <div className="flex items-center justify-between px-2 py-1 bg-slate-800 border-b border-white/10 cursor-grab active:cursor-grabbing">
          <div className="flex items-center gap-1 text-slate-500">
            <GripVertical size={12} />
            <span className="text-[10px]">{title}</span>
          </div>
          <button
            onClick={onRemove}
            className="text-slate-600 hover:text-red-400 transition-colors"
            aria-label={`Remove ${title} widget`}
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function renderWidget(
  key: WidgetKey,
  config: WidgetLayout["config"],
  data: WidgetGridData,
  isEditing: boolean,
): React.ReactNode {
  switch (key) {
    case "floor-map":
      return <FloorMapWidget stations={data.stations} />;
    case "queue-health":
      return <QueueHealthWidget queues={data.queues} />;
    case "quality-watch":
      return <QualityWatchWidget events={data.recentEvents} />;
    case "throughput-chart":
      return (
        <ThroughputChartWidget
          data={data.throughputPoints}
          targetBagsPerHour={data.targetBagsPerHour}
        />
      );
    case "operator-board":
      return <OperatorBoardWidget operators={data.operators} />;
    case "machine-focus": {
      const station = data.stations.find((s) => s.id === config?.stationId) ?? null;
      return (
        <MachineFocusWidget
          station={station}
          stationId={config?.stationId}
          isEditing={isEditing}
        />
      );
    }
    case "recent-events":
      return <RecentEventsWidget events={data.recentEvents} />;
    default:
      return null;
  }
}

function widgetTitle(key: WidgetKey): string {
  return WIDGET_CATALOG.find((w) => w.key === key)?.label ?? key;
}

export function WidgetGrid({
  layout,
  onLayoutChange,
  data,
  isEditing,
  onRemoveWidget,
}: {
  layout: WidgetLayout[];
  onLayoutChange: (next: WidgetLayout[]) => void;
  data: WidgetGridData;
  isEditing: boolean;
  onRemoveWidget: (key: WidgetKey) => void;
}) {
  const glLayout: Layout[] = layout.map((w) => ({
    i: w.key,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    minW: WIDGET_CATALOG.find((c) => c.key === w.key)?.minW ?? 2,
    minH: WIDGET_CATALOG.find((c) => c.key === w.key)?.minH ?? 2,
    isDraggable: isEditing,
    isResizable: isEditing,
  }));

  const handleLayoutChange = useCallback(
    (newLayout: Layout[]) => {
      if (!isEditing) return;
      const updated: WidgetLayout[] = layout.map((w) => {
        const item = newLayout.find((l) => l.i === w.key);
        if (!item) return w;
        return { ...w, x: item.x, y: item.y, w: item.w, h: item.h };
      });
      onLayoutChange(updated);
    },
    [layout, isEditing, onLayoutChange],
  );

  return (
    <ResponsiveGridLayout
      layout={glLayout}
      cols={12}
      rowHeight={60}
      margin={[8, 8]}
      containerPadding={[8, 8]}
      onLayoutChange={handleLayoutChange}
      isDraggable={isEditing}
      isResizable={isEditing}
      draggableHandle=".cursor-grab"
    >
      {layout.map((w) => (
        <div key={w.key}>
          <WidgetShell
            title={widgetTitle(w.key)}
            isEditing={isEditing}
            onRemove={() => onRemoveWidget(w.key)}
          >
            {renderWidget(w.key, w.config, data, isEditing)}
          </WidgetShell>
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
```

- [ ] **Step 2: Create widget-picker.tsx**

```tsx
// app/(admin)/floor-board/_components/widget-picker.tsx
"use client";

import { WIDGET_CATALOG, type WidgetKey, type WidgetLayout } from "@/lib/floor-command/types";
import { Plus, X } from "lucide-react";

export function WidgetPicker({
  currentLayout,
  onAdd,
  onClose,
}: {
  currentLayout: WidgetLayout[];
  onAdd: (key: WidgetKey) => void;
  onClose: () => void;
}) {
  const activeKeys = new Set(currentLayout.map((w) => w.key));

  return (
    <div className="flex flex-col w-64 bg-slate-800 border-l border-white/10 h-full overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-xs font-semibold text-slate-300">Add Widget</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
          <X size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-1 p-2">
        {WIDGET_CATALOG.map((w) => {
          const isActive = activeKeys.has(w.key);
          return (
            <button
              key={w.key}
              onClick={() => !isActive && onAdd(w.key)}
              disabled={isActive}
              className={`flex items-start gap-2 p-2 rounded text-left transition-colors ${
                isActive
                  ? "opacity-40 cursor-not-allowed bg-slate-700/30"
                  : "hover:bg-slate-700/60 cursor-pointer"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-semibold text-slate-300">{w.label}</div>
                <div className="text-[10px] text-slate-500 leading-snug">{w.description}</div>
              </div>
              {!isActive && <Plus size={12} className="text-slate-500 flex-shrink-0 mt-0.5" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/\(admin\)/floor-board/_components/widget-grid.tsx \
        app/\(admin\)/floor-board/_components/widget-picker.tsx
git commit -m "feat: add widget-grid (react-grid-layout) and widget-picker"
```

---

## Task 14: FloorCommandClient + SSE Listener

**Files:**
- Create: `app/(admin)/floor-board/_components/floor-command-client.tsx`

This is the top-level Client Component. It manages layout state, saves to the API, and wires the existing SSE refresh.

- [ ] **Step 1: Define the WidgetGridData type in floor-command-client.tsx**

The server will compute all data and pass it down as props. This avoids client-side fetching for initial render.

```tsx
// app/(admin)/floor-board/_components/floor-command-client.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Edit2, Check } from "lucide-react";
import type { QueueHealthRow, StationWithLive, WidgetKey, WidgetLayout, OperatorDailyRow } from "@/lib/floor-command/types";
import type { KpiStripData, RecentEventRow } from "@/lib/production/floor-command";
import type { ThroughputDataPoint } from "./widgets/throughput-chart-widget";
import type { ShiftStatusData } from "@/lib/floor-command/types";
import { DEFAULT_LAYOUT, WIDGET_CATALOG } from "@/lib/floor-command/types";
import { StatusBar } from "./status-bar";
import { KpiStrip } from "./kpi-strip";
import { WidgetGrid } from "./widget-grid";
import { WidgetPicker } from "./widget-picker";

export type WidgetGridData = {
  stations: StationWithLive[];
  queues: QueueHealthRow[];
  operators: OperatorDailyRow[];
  recentEvents: RecentEventRow[];
  throughputPoints: ThroughputDataPoint[];
  targetBagsPerHour: number | null;
};

type Props = {
  shiftStatus: ShiftStatusData;
  kpiData: KpiStripData;
  widgetData: WidgetGridData;
  savedLayout: WidgetLayout[];
};

export function FloorCommandClient({ shiftStatus, kpiData, widgetData, savedLayout }: Props) {
  const router = useRouter();
  const [layout, setLayout] = useState<WidgetLayout[]>(
    savedLayout.length > 0 ? savedLayout : DEFAULT_LAYOUT,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SSE — re-fetch server data on any floor event
  useEffect(() => {
    const es = new EventSource("/api/floor-board/stream");
    const handler = () => router.refresh();
    es.addEventListener("floor", handler);
    es.addEventListener("ping", () => {}); // keep-alive, no action
    return () => {
      es.removeEventListener("floor", handler);
      es.close();
    };
  }, [router]);

  const saveLayout = useCallback((next: WidgetLayout[]) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      fetch("/api/dashboard-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: next }),
      }).catch(console.error);
    }, 800);
  }, []);

  const handleLayoutChange = useCallback(
    (next: WidgetLayout[]) => {
      setLayout(next);
      saveLayout(next);
    },
    [saveLayout],
  );

  const handleAddWidget = useCallback(
    (key: WidgetKey) => {
      const def = WIDGET_CATALOG.find((w) => w.key === key);
      if (!def) return;
      const next: WidgetLayout[] = [
        ...layout,
        { key, x: 0, y: Infinity, w: def.defaultW, h: def.defaultH },
      ];
      setLayout(next);
      saveLayout(next);
    },
    [layout, saveLayout],
  );

  const handleRemoveWidget = useCallback(
    (key: WidgetKey) => {
      const next = layout.filter((w) => w.key !== key);
      setLayout(next);
      saveLayout(next);
    },
    [layout, saveLayout],
  );

  const handleDoneEditing = () => {
    setIsEditing(false);
    setShowPicker(false);
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* Zone 1: Shift Status Bar */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="flex-1">
          <StatusBar data={shiftStatus} />
        </div>
        <div className="px-3 flex-shrink-0">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowPicker((p) => !p)}
                className="text-[11px] text-sky-400 border border-sky-500/40 px-2 py-1 rounded hover:bg-sky-500/10"
              >
                + Add Widget
              </button>
              <button
                onClick={handleDoneEditing}
                className="flex items-center gap-1 text-[11px] text-emerald-400 border border-emerald-500/40 px-2 py-1 rounded hover:bg-emerald-500/10"
              >
                <Check size={11} />
                Done
              </button>
            </div>
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="flex items-center gap-1 text-[11px] text-slate-500 border border-white/10 px-2 py-1 rounded hover:text-slate-300 hover:border-white/20"
            >
              <Edit2 size={11} />
              Edit Layout
            </button>
          )}
        </div>
      </div>

      {/* Zone 2: Configurable Widget Grid */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <WidgetGrid
            layout={layout}
            onLayoutChange={handleLayoutChange}
            data={widgetData}
            isEditing={isEditing}
            onRemoveWidget={handleRemoveWidget}
          />
        </div>
        {isEditing && showPicker && (
          <WidgetPicker
            currentLayout={layout}
            onAdd={handleAddWidget}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>

      {/* Zone 3: KPI Strip */}
      <div className="flex-shrink-0">
        <KpiStrip data={kpiData} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "floor-command-client\|widget-grid\|widget-picker" | head -20
```

Expected: no errors. If `WidthProvider` or `GridLayout` types fail, check that `@types/react-grid-layout` installed correctly.

- [ ] **Step 3: Commit**

```bash
git add app/\(admin\)/floor-board/_components/floor-command-client.tsx
git commit -m "feat: add FloorCommandClient with SSE, edit mode, layout persistence"
```

---

## Task 15: Rewire page.tsx

**Files:**
- Modify: `app/(admin)/floor-board/page.tsx`

The existing page is a large server component. Replace it entirely with the new three-zone architecture. The old data fetching logic is replaced by the five new floor-command functions.

- [ ] **Step 1: Read the first 20 lines of the current page.tsx to confirm import style**

```bash
head -25 /Users/kidevu/luma/app/\(admin\)/floor-board/page.tsx
```

Confirm the `requireSession()` import path and `dynamic` export before proceeding.

- [ ] **Step 2: Replace page.tsx**

Overwrite `app/(admin)/floor-board/page.tsx` with:

```tsx
// app/(admin)/floor-board/page.tsx
import { requireSession } from "@/lib/auth-guards";
import {
  buildShiftStatusData,
  getAttentionItems,
  getKpiStripData,
  getOperatorDailySummary,
  getQueueHealthSummary,
  getRecentEvents,
  getShiftTargetStatus,
  getStationsWithLiveState,
} from "@/lib/production/floor-command";
import { db } from "@/lib/db";
import { company } from "@/lib/db/schema";
import { userDashboardConfig } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { FloorCommandClient } from "./_components/floor-command-client";
import type { WidgetLayout } from "@/lib/floor-command/types";
import { DEFAULT_LAYOUT } from "@/lib/floor-command/types";

export const dynamic = "force-dynamic";

async function getCompanyTimezone(): Promise<string> {
  const rows = await db.select({ timezone: company.timezone }).from(company).limit(1);
  return rows[0]?.timezone ?? "America/Toronto";
}

export default async function FloorBoardPage() {
  const user = await requireSession();
  const tz = await getCompanyTimezone();

  const [
    stations,
    queues,
    targetStatus,
    attentionItems,
    operators,
    recentEvents,
    kpiData,
    savedLayoutRow,
  ] = await Promise.all([
    getStationsWithLiveState(),
    getQueueHealthSummary(),
    getShiftTargetStatus(tz),
    getAttentionItems(),
    getOperatorDailySummary(tz),
    getRecentEvents(50),
    getKpiStripData(tz),
    db
      .select({ layoutJson: userDashboardConfig.layoutJson })
      .from(userDashboardConfig)
      .where(
        and(
          eq(userDashboardConfig.userId, user.id),
          eq(userDashboardConfig.boardKey, "floor-command"),
        ),
      )
      .limit(1),
  ]);

  // Aggregate first-pass yield from today's bag metrics for the status bar
  // (reuse kpiData.firstPassYieldPct which already computed it)
  const yieldPct = kpiData.firstPassYieldPct;

  const shiftStatus = buildShiftStatusData(targetStatus, queues, yieldPct, attentionItems);

  const savedLayout = (savedLayoutRow[0]?.layoutJson as WidgetLayout[] | undefined) ?? DEFAULT_LAYOUT;

  return (
    <FloorCommandClient
      shiftStatus={shiftStatus}
      kpiData={kpiData}
      savedLayout={savedLayout}
      widgetData={{
        stations,
        queues,
        operators,
        recentEvents,
        throughputPoints: [], // TODO Task 16: derive hourly throughput points from readDailyThroughput
        targetBagsPerHour: stations.find((s) => s.machineTargetBagsPerHour)?.machineTargetBagsPerHour ?? null,
      }}
    />
  );
}
```

**Note:** The `company` table may have a different export name — check `lib/db/schema.ts` for the correct export (`company`, `companies`, or similar) and adjust the import if needed.

- [ ] **Step 3: Full typecheck**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Fix any column name mismatches (e.g., if `readBagMetrics.finalizedAt` doesn't exist, find the correct timestamp column via `grep -n "finalizedAt\|createdAt" lib/db/schema.ts`).

- [ ] **Step 4: Start dev server and verify the page loads**

```bash
npm run dev
```

Open http://localhost:3000/floor-board and verify:
1. Zone 1 status bar renders with 4 cells (color-coded)
2. Zone 2 shows floor-map widget by default
3. Zone 3 KPI strip shows 6 cells
4. "Edit Layout" button appears in top bar
5. No console errors

- [ ] **Step 5: Test edit mode**

Click "Edit Layout". Verify:
1. Widgets show drag handles and X buttons
2. "+ Add Widget" button appears
3. Click "+ Add Widget" — picker slides in with widget list
4. Add a widget — verify it appears in the grid
5. Drag a widget to a new position
6. Click "Done" — handles disappear
7. Refresh the page — layout persists (config was saved to DB)

- [ ] **Step 6: Commit**

```bash
git add app/\(admin\)/floor-board/page.tsx
git commit -m "feat: rewrite floor-board as three-zone command center"
```

---

## Task 16: Hourly throughput data for the chart widget

**Files:**
- Modify: `lib/production/floor-command.ts`

The throughput chart widget (`ThroughputChartWidget`) needs hourly `ThroughputDataPoint[]` — bags completed per hour since 6am. This requires querying `workflow_events` for BAG_FINALIZED events grouped by hour.

- [ ] **Step 1: Add getHourlyThroughput() to lib/production/floor-command.ts**

Append to `lib/production/floor-command.ts`:

```typescript
export type HourlyThroughputPoint = {
  label: string;        // "07:00", "08:00", etc.
  bagsPerHour: number;
};

export async function getHourlyThroughput(tz: string): Promise<HourlyThroughputPoint[]> {
  const now = new Date();
  const { shiftStartUtc } = computeShiftProgress(now, tz);

  // Count BAG_FINALIZED events per hour since shift start
  const rows = await db.execute(sql`
    SELECT
      date_trunc('hour', occurred_at AT TIME ZONE ${tz}) AS hour_local,
      count(*) AS bag_count
    FROM workflow_events
    WHERE event_type = 'BAG_FINALIZED'
      AND occurred_at >= ${shiftStartUtc}
    GROUP BY 1
    ORDER BY 1
  `);

  return (rows as Array<{ hour_local: Date; bag_count: string }>).map((r) => ({
    label: new Date(r.hour_local).toLocaleTimeString("en-CA", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }),
    bagsPerHour: parseInt(r.bag_count, 10),
  }));
}
```

- [ ] **Step 2: Wire getHourlyThroughput into page.tsx**

In `app/(admin)/floor-board/page.tsx`, add `getHourlyThroughput(tz)` to the `Promise.all` array and pass the result into `widgetData.throughputPoints`. Replace the `// TODO Task 16` comment:

```typescript
// In the Promise.all:
getHourlyThroughput(tz),

// In widgetData:
throughputPoints: hourlyThroughput,
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Verify chart renders**

Start dev server, add the Throughput Chart widget via Edit Layout, verify it renders a line chart (or shows "No throughput data yet" before any bags are finalized today).

- [ ] **Step 5: Commit**

```bash
git add lib/production/floor-command.ts app/\(admin\)/floor-board/page.tsx
git commit -m "feat: add hourly throughput data for chart widget"
```

---

## Self-Review Checklist

After all tasks are complete:

- [ ] Run `npm run test` — all tests pass
- [ ] Run `npx tsc --noEmit` — zero errors
- [ ] `npm run lint` — zero lint errors
- [ ] Start dev server and walk through the golden path:
  - Floor board loads with 3 zones
  - Status bar shows all 4 cells with correct colors
  - Floor map renders active stations from DB (dynamic topology)
  - Edit mode: add, move, resize, remove widgets
  - Layout persists across page refreshes
  - SSE triggers a re-render when a workflow event fires
  - Throughput chart shows hourly bars (or empty state gracefully)
  - Operator board shows today's operators
  - Quality watch shows quality events (or "first-pass clean")
