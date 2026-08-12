# Production Engine — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Floor tablets update in real time — a station-token SSE stream pushes relevant events to each tablet, which re-renders without any operator refresh.

**Architecture:** The projector's `pg_notify` payload gains `stationKind` and `queueStageKey` (sourced from work `applyBagQueueTransition` already does — no new per-event queries on the fast path). A new token-authed SSE route under `app/(floor)/floor/api/stream/[token]` subscribes to the existing in-process notify bus and forwards only events relevant to that station (own events, same-kind peers, and queue changes its kind can claim). A `FloorLiveRefresh` client component — the admin `LiveRefresh` pattern with a parameterized URL and no visible chrome — mounts in the floor page and calls `router.refresh()` on each relevant event.

**Tech Stack:** TypeScript strict, Next.js 15 route handlers + SSE (`ReadableStream`), existing `lib/projector/notify-bus.ts`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-11-production-engine-operator-experience-design.md` (Realtime section)

## Global Constraints

- No emoji anywhere in code, tests, comments, or CHANGELOG.
- TypeScript strict — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- No database in the test suite; pure functions carry coverage; DB/stream halves ride the staging smoke checklist. Do not mock `@/lib/db`.
- ~36 source-text scanner tests; `page.tsx` is scanned (`page.test.ts`) — the Task 4 mount will touch it; scanner fixes are source-loading-only unless behaviour legitimately changed (the mount is new behaviour: assertions may pin it, listed in the report).
- Full suite currently 5418 passed / 0 failed — must stay 0 after every task. `npm run typecheck && npm run lint` clean (0 errors; boundary ratchet ≤ 80 — NOTE: the new client component and route live under `app/(floor)/` and must import from `@/lib/production/engine` or non-`lib/production` modules only, or the ratchet trips).
- Version: `1.31.0` → `1.32.0` in Task 5 only; CHANGELOG header `## [1.32.0] — <date>` (bracketed — enforced by `lib/version.contract.test.ts`).
- Phase 3 ships NO visible UI change — `FloorLiveRefresh` renders `null`. If a station page looks different, the task is wrong.
- Do NOT push — the controller pushes.

## Facts (verified against the repo)

- `lib/projector/notify-bus.ts` is a payload-passthrough (`JSON.parse` → fan-out); extending the payload needs no bus change beyond the `FloorEvent` type it exports.
- The notify emit is `lib/projector/index.ts` (`// 4. pg_notify` block, ~line 743): payload `{eventType, workflowBagId, stationId, occurredAt}`. `applyBagQueueTransition` is called immediately BEFORE it and already fetches `stationKind` and computes the queue destination for flow events.
- `app/api/floor-board/stream/route.ts` is the admin SSE relay — session-authed; MIRROR its stream mechanics (hello/ping/floor events, heartbeat 25s, abort handling) exactly; only auth and filtering differ.
- `app/(admin)/floor-board/live-refresh.tsx` is the client pattern: EventSource + 200ms debounced `router.refresh()` + 30s polling fallback + SSE retry.
- `resolveStation(token)` is DUPLICATED in `app/(floor)/floor/[token]/actions.ts:137-146` and `qc-actions.ts:54` — same UUID regex + `stations.scanToken` lookup. Task 1 extracts it.
- There is NO `middleware.ts` — no CSRF layer to exempt; the SSE route is a plain GET.
- The floor page (`app/(floor)/floor/[token]/page.tsx`) is `force-dynamic`; `router.refresh()` re-runs it server-side.

---

### Task 1: Shared station-token resolver

**Files:**
- Create: `lib/production/station-token.ts`
- Create: `lib/production/station-token.test.ts`
- Modify: `app/(floor)/floor/[token]/actions.ts:137-146` — delegate to the shared module
- Modify: `app/(floor)/floor/[token]/qc-actions.ts:54-...` — same

**Interfaces:**
- Produces:

```ts
export function isStationTokenShape(token: string): boolean; // the UUID regex
export async function resolveStationByToken(token: string): Promise<
  typeof stations.$inferSelect | null
>;
```

- [ ] **Step 1: Write the failing test**

Create `lib/production/station-token.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isStationTokenShape } from "./station-token";

describe("isStationTokenShape", () => {
  it("accepts a v4-shaped uuid in any case", () => {
    expect(isStationTokenShape("a3f1c2d4-5b6e-4f7a-8b9c-0d1e2f3a4b5c")).toBe(true);
    expect(isStationTokenShape("A3F1C2D4-5B6E-4F7A-8B9C-0D1E2F3A4B5C")).toBe(true);
  });
  it("rejects junk, near-misses, and injection shapes", () => {
    for (const bad of ["", "not-a-token", "a3f1c2d4-5b6e-4f7a-8b9c", "a3f1c2d45b6e4f7a8b9c0d1e2f3a4b5c", "'; DROP TABLE stations; --"]) {
      expect(isStationTokenShape(bad)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/production/station-token.test.ts` → module not found.

- [ ] **Step 3: Implement**

Create `lib/production/station-token.ts`:

```ts
// Station scan-token resolution — the floor's auth primitive. Extracted
// from the duplicated copies in actions.ts / qc-actions.ts so the SSE
// stream route (P3) shares one definition.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stations } from "@/lib/db/schema";

const STATION_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isStationTokenShape(token: string): boolean {
  return STATION_TOKEN_RE.test(token);
}

export async function resolveStationByToken(token: string) {
  if (!isStationTokenShape(token)) return null;
  const [row] = await db.select().from(stations).where(eq(stations.scanToken, token));
  return row ?? null;
}
```

- [ ] **Step 4: Delegate the two duplicates**

In both action files, replace the local `resolveStation` BODY with a call to `resolveStationByToken(token)` (keep the local function name and callers unchanged — smallest diff, scanners unaffected except line counts). Import from `@/lib/production/station-token`. CAUTION: both files are scanner-scanned; run the full suite — source-loading fixes only if a scanner reacts, listed in the report.

- [ ] **Step 5: Verify + commit**

`npx vitest run && npm run typecheck && npm run lint` → 0 failures.

```bash
git add lib/production/station-token.ts lib/production/station-token.test.ts \
        "app/(floor)/floor/[token]/actions.ts" "app/(floor)/floor/[token]/qc-actions.ts"
git commit -m "feat(sse): shared station-token resolver"
```

---

### Task 2: Extended notify payload + relevance helper

**Files:**
- Modify: `lib/projector/bag-queue.ts` — `applyBagQueueTransition` returns what it learned
- Modify: `lib/projector/index.ts` — notify payload gains `stationKind` + `queueStageKey`
- Modify: `lib/projector/notify-bus.ts` — `FloorEvent` type gains the two fields
- Create: `lib/production/engine/floor-event-relevance.ts` + colocated test
- Modify: `lib/production/engine/index.ts` — export the helper

**Interfaces:**
- Produces:

```ts
// bag-queue.ts — return type changes from Promise<void>:
export async function applyBagQueueTransition(tx, ev, occurredAt): Promise<{
  stationKind: string | null;   // fetched kind, null on the non-flow fast path
  queueStageKey: string | null; // destination applied this event, else null
}>;

// notify-bus.ts
export type FloorEvent = {
  eventType: string;
  workflowBagId: string;
  stationId: string | null;
  stationKind: string | null;
  queueStageKey: string | null;
  occurredAt: string;
};

// floor-event-relevance.ts
export function queueKeysForStationKind(kind: string): readonly string[];
export function floorEventRelevantToStation(
  ev: { stationId: string | null; stationKind: string | null; queueStageKey: string | null },
  station: { id: string; kind: string },
): boolean;
```

Relevance rule (spec: "each tablet filters to events it cares about"): an event is relevant when `ev.stationId === station.id` (my own event), OR `ev.stationKind === station.kind` (a same-kind peer — affects my queue view), OR `ev.queueStageKey` is one of `queueKeysForStationKind(station.kind)` (a bag entered/left a queue I claim from). Null fields never match — fail quiet, not chatty. `queueKeysForStationKind`: BLISTER/HANDPACK_BLISTER/COMBINED → [] (first-op — no inbound queue), SEALING → ["SEALING_QUEUE"], PACKAGING → ["PACKAGING_QUEUE"], BOTTLE_STICKER → ["BOTTLE_STICKER_QUEUE"], BOTTLE_CAP_SEAL → ["BOTTLE_STICKER_QUEUE", "BOTTLE_INDUCTION_QUEUE"] (order-flex: a both-eligible bag parks under the sticker key), BOTTLE_HANDPACK → [].

- [ ] **Step 1: Failing tests**

Create `lib/production/engine/floor-event-relevance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { floorEventRelevantToStation, queueKeysForStationKind } from "./floor-event-relevance";

const SEALING = { id: "st-seal-1", kind: "SEALING" };

describe("floorEventRelevantToStation", () => {
  it("always cares about its own events", () => {
    expect(
      floorEventRelevantToStation(
        { stationId: "st-seal-1", stationKind: null, queueStageKey: null },
        SEALING,
      ),
    ).toBe(true);
  });
  it("cares about same-kind peers", () => {
    expect(
      floorEventRelevantToStation(
        { stationId: "st-seal-2", stationKind: "SEALING", queueStageKey: null },
        SEALING,
      ),
    ).toBe(true);
  });
  it("cares about bags entering a queue it claims from", () => {
    expect(
      floorEventRelevantToStation(
        { stationId: "st-blister-1", stationKind: "BLISTER", queueStageKey: "SEALING_QUEUE" },
        SEALING,
      ),
    ).toBe(true);
  });
  it("ignores unrelated stations and queues", () => {
    expect(
      floorEventRelevantToStation(
        { stationId: "st-pack-1", stationKind: "PACKAGING", queueStageKey: "FINISHED_GOODS_QUEUE" },
        SEALING,
      ),
    ).toBe(false);
  });
  it("nulls never match", () => {
    expect(
      floorEventRelevantToStation(
        { stationId: null, stationKind: null, queueStageKey: null },
        SEALING,
      ),
    ).toBe(false);
  });
});

describe("queueKeysForStationKind", () => {
  it("cap-seal watches both finishing queues (order-flex parking)", () => {
    expect(queueKeysForStationKind("BOTTLE_CAP_SEAL")).toEqual([
      "BOTTLE_STICKER_QUEUE",
      "BOTTLE_INDUCTION_QUEUE",
    ]);
  });
  it("first-op kinds have no inbound queue", () => {
    for (const kind of ["BLISTER", "HANDPACK_BLISTER", "COMBINED", "BOTTLE_HANDPACK"]) {
      expect(queueKeysForStationKind(kind)).toEqual([]);
    }
  });
  it("unknown kinds get an empty list, not a throw", () => {
    expect(queueKeysForStationKind("NOT_A_KIND")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the pure helper** (straight transcription of the rule above; table + three ORs).

- [ ] **Step 4: Return values from `applyBagQueueTransition`**

Every `return;` in the function becomes a typed return. The fast path (`!FLOW_EVENTS.has`) returns `{ stationKind: null, queueStageKey: null }` — NO new queries there. Flow paths return the `stationKind` already fetched and, for WORKING/READY transitions, `transition.destination.queueStageKey`; UNCLAIM/REMOVE/NONE return `queueStageKey: null`. `rebuildBagQueue` ignores the return.

- [ ] **Step 5: Extend the notify payload**

In `lib/projector/index.ts`, the call becomes:

```ts
  const queueInfo = await applyBagQueueTransition(tx, ev, occurredAt);
```

and the payload:

```ts
  const notifyPayload = {
    eventType: ev.eventType,
    workflowBagId: ev.workflowBagId,
    stationId: ev.stationId ?? null,
    stationKind: queueInfo.stationKind,
    queueStageKey: queueInfo.queueStageKey,
    occurredAt: occurredAt.toISOString(),
  };
```

Update `FloorEvent` in `notify-bus.ts`. The admin stream forwards the payload opaquely — no change there; `live-refresh.tsx` ignores unknown fields.

- [ ] **Step 6: Verify + commit** — full suite, typecheck, lint.

```bash
git add lib/projector/bag-queue.ts lib/projector/index.ts lib/projector/notify-bus.ts \
        lib/production/engine/floor-event-relevance.ts lib/production/engine/floor-event-relevance.test.ts \
        lib/production/engine/index.ts
git commit -m "feat(sse): notify payload carries stationKind and queueStageKey; relevance helper"
```

---

### Task 3: Station-token SSE route

**Files:**
- Create: `app/(floor)/floor/api/stream/[token]/route.ts`

**Interfaces:**
- Consumes: `resolveStationByToken` (Task 1), `subscribe`/`FloorEvent` from `@/lib/projector/notify-bus`, `floorEventRelevantToStation` via `@/lib/production/engine` (BOUNDARY: the floor may import only the engine barrel from lib/production — Task 2 exported it there; `station-token.ts` is NOT under the boundary's restricted group? IT IS (`@/lib/production/*`). So `resolveStationByToken` must ALSO be re-exported from the engine barrel — do that in this task and import both from `@/lib/production/engine`).

**Before writing:** read `app/api/floor-board/stream/route.ts` end to end. Mirror its mechanics exactly — `ReadableStream`, `send()` line encoder, hello event, 25s heartbeat ping, `unsub` + `clearInterval` on abort, `runtime = "nodejs"`, `dynamic = "force-dynamic"`. The differences, and ONLY these:

1. Auth: `const station = await resolveStationByToken(params.token)`; return `new Response("Not found", { status: 404 })` when null or `!station.isActive` (do not distinguish the two — no token-probing oracle).
2. Filtering: wrap the subscriber — `if (!floorEventRelevantToStation(ev, { id: station.id, kind: station.kind })) return;` before `send`.
3. Params: Next 15 route handlers get `{ params: Promise<{ token: string }> }` — await it (match the floor page's pattern).

- [ ] **Step 1: Write the route** (no in-repo test possible — no DB, no stream harness; staging smoke covers it; Task 5 adds the items).
- [ ] **Step 2: Add `export { resolveStationByToken, isStationTokenShape } from "@/lib/production/station-token";` to `lib/production/engine/index.ts`** — with a comment that the floor boundary requires barrel access.
- [ ] **Step 3: Verify** — full suite, typecheck, lint (ratchet must hold: the route imports only the barrel), `npm run build` (route compiles).
- [ ] **Step 4: Commit**

```bash
git add "app/(floor)/floor/api/stream/[token]/route.ts" lib/production/engine/index.ts
git commit -m "feat(sse): station-token SSE stream with per-station relevance filtering"
```

---

### Task 4: FloorLiveRefresh client + mount

**Files:**
- Create: `app/(floor)/floor/[token]/floor-live-refresh.tsx`
- Modify: `app/(floor)/floor/[token]/page.tsx` — mount it (one line inside the existing `<main>`, before other children)
- Modify: `app/(floor)/floor/[token]/page.test.ts` — only if the scanner reacts (mount is new behaviour; a pin is legitimate)

**Interfaces:** `<FloorLiveRefresh token={token} />` — renders `null`.

- [ ] **Step 1: Write the component**

Read `app/(admin)/floor-board/live-refresh.tsx` first; this is that pattern with three deltas — parameterized URL, `render null` (no status chrome — Phase 3 ships no visible change), and a longer polling fallback (60s — the floor page is heavier than the board):

```tsx
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

// P3-SSE-1 — invisible live refresher for the floor page. Subscribes to
// this station's token-authed stream and re-runs the server component on
// each relevant event (the server already filtered relevance). Renders
// nothing: Phase 3 ships zero visible change. Falls back to 60s polling
// if SSE dies, and keeps retrying SSE every 60s.
export function FloorLiveRefresh({ token }: { token: string }) {
  const router = useRouter();

  React.useEffect(() => {
    let pendingRefresh: ReturnType<typeof setTimeout> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;
    let closed = false;

    function debouncedRefresh() {
      if (pendingRefresh) clearTimeout(pendingRefresh);
      pendingRefresh = setTimeout(() => router.refresh(), 200);
    }

    function startSSE() {
      es = new EventSource(`/floor/api/stream/${token}`);
      es.addEventListener("floor", () => debouncedRefresh());
      es.onerror = () => {
        if (closed) return;
        es?.close();
        es = null;
        if (!pollInterval) pollInterval = setInterval(debouncedRefresh, 60_000);
        if (!retryTimeout) {
          retryTimeout = setTimeout(() => {
            retryTimeout = null;
            if (closed) return;
            if (pollInterval) {
              clearInterval(pollInterval);
              pollInterval = null;
            }
            startSSE();
          }, 60_000);
        }
      };
    }

    startSSE();
    return () => {
      closed = true;
      if (pendingRefresh) clearTimeout(pendingRefresh);
      if (pollInterval) clearInterval(pollInterval);
      if (retryTimeout) clearTimeout(retryTimeout);
      es?.close();
    };
  }, [router, token]);

  return null;
}
```

- [ ] **Step 2: Mount in `page.tsx`** — import and render `<FloorLiveRefresh token={token} />` as the first child inside the page's outermost returned element (the `token` local already exists from `await params`). One line plus the import.
- [ ] **Step 3: Scanner check** — run `npx vitest run "app/(floor)"`; a `page.test.ts` reaction to the mount is a legitimate behaviour pin — update per convention, list in report.
- [ ] **Step 4: Verify** — full suite, typecheck, lint, `npm run build`.
- [ ] **Step 5: Commit**

```bash
git add "app/(floor)/floor/[token]/floor-live-refresh.tsx" "app/(floor)/floor/[token]/page.tsx"
git commit -m "feat(sse): floor page live-refreshes on relevant station events"
```

---

### Task 5: Version 1.32.0, CHANGELOG, smoke items

**Files:** `package.json`, `CHANGELOG.md`, `docs/superpowers/plans/2026-08-11-production-engine-p1-staging-smoke.md`, `docs/superpowers/plans/2026-08-11-production-engine-p1-outcomes.md`

- [ ] **Step 1: CHANGELOG** — `## [1.32.0] — <date>`: "Phase 3: floor tablets update in real time. Station-token SSE stream with per-station relevance filtering; pg_notify payload carries stationKind and queueStageKey; floor page refreshes automatically (no visible chrome). Polling fallback at 60s if SSE drops."
- [ ] **Step 2: Smoke additions** (Phase 3 section):

```markdown
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
```

- [ ] **Step 3: Outcomes doc** — append a Phase 3 note: realtime shipped; the relevance rule (own / same-kind / claimable-queue); what CI cannot verify (the stream route, EventSource behaviour, notify round-trip).
- [ ] **Step 4: Full verification** — suite, typecheck, lint, build.
- [ ] **Step 5: Commit** — `chore(release): v1.32.0 production engine phase 3`

---

## Exit criteria

- Full suite 0 failures; typecheck/lint/build clean; ratchet ≤ 80.
- Notify payload extended without new fast-path queries; admin stream unaffected.
- SSE route authed by station token, filtered per station, 404-opaque.
- Floor page live-refreshes; zero visible change.
- Smoke checklist covers the stream, fallback, and the LISTEN-connection invariant.

## What Phase 3 does NOT verify (CI)

The stream route end to end, EventSource reconnect behaviour, the notify round-trip, and per-station filtering under real traffic — all staging smoke. The relevance rule and payload construction are pure-tested.

## Deferred

- P4: operator screen rewrite consumes the stream directly (replace refresh-the-world with targeted StationView updates).
- P5: supervisor PIN + panels. P6: data-driven routes; legacy table deletion.
