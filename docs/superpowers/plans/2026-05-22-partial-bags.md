# PARTIAL-1: Available Partial Bags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Available Partial Bags" admin page showing raw bags that have been partially consumed and are available for another production run, with a Start Production link.

**Architecture:** Derive "partial bag" from existing `rawBagAllocationSessions` ledger — no new DB column or status needed. `inventory_bags.status = AVAILABLE` + has ≥1 closed allocation session = partial bag. Pure helpers in `lib/production/partial-bags.ts`, server-component page at `/partial-bags`.

**Tech Stack:** Next.js 15 App Router, Drizzle ORM, TypeScript strict, Tailwind v3, Vitest

---

### Task A: Pure helpers + DB query — lib/production/partial-bags.ts

**Files:**
- Create: `lib/production/partial-bags.ts`

**Background:** `inventory_bags.status` values: AVAILABLE | IN_USE | EMPTIED | QUARANTINED | VOID. A partial bag is AVAILABLE and has ≥1 non-OPEN allocation session. Sessions table: `rawBagAllocationSessions` (schema.ts:2157) with columns: `inventoryBagId`, `allocationStatus` (OPEN|CLOSED|RETURNED_TO_STOCK|DEPLETED|VOIDED), `startingBalanceQty`, `consumedQty`, `endingBalanceQty`, `openedAt`, `closedAt`, `productId`.

**Full file to implement:**

```typescript
// PARTIAL-1 — Available partial raw-bag helpers + query.
//
// "Available partial bag" = inventory_bags.status=AVAILABLE AND has ≥1
// closed/returned allocation session. No new DB status needed — derived
// from existing rawBagAllocationSessions ledger.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches,
  inventoryBags,
  products,
  rawBagAllocationSessions,
  smallBoxes,
  tabletTypes,
} from "@/lib/db/schema";

// ─── Types ──────────────────────────────────────────────────────────

export interface PartialBagSession {
  allocationStatus: string;
  endingBalanceQty: number | null;
  closedAt: Date | null;
}

export interface AvailablePartialBagRow {
  bagId: string;
  bagNumber: number;
  bagQrCode: string | null;
  internalReceiptNumber: string | null;
  tabletTypeName: string | null;
  supplierLot: string | null;
  receiveId: string | null;
  declaredPillCount: number | null;
  pillCount: number | null;
  remainingEstimate: number | null;
  lastConsumedQty: number | null;
  lastUsedProductName: string | null;
  lastUsedAt: Date | null;
  lastSessionStatus: string | null;
}

// ─── Pure helpers ───────────────────────────────────────────────────

/** True if sessions contain ≥1 CLOSED or RETURNED_TO_STOCK record.
 *  A fresh bag (no sessions) returns false. */
export function isAvailablePartialBag(sessions: readonly PartialBagSession[]): boolean {
  return sessions.some(
    (s) =>
      s.allocationStatus === "CLOSED" || s.allocationStatus === "RETURNED_TO_STOCK",
  );
}

/** True if any session is currently OPEN (belt-and-suspenders guard). */
export function hasOpenAllocationSession(
  sessions: readonly { allocationStatus: string }[],
): boolean {
  return sessions.some((s) => s.allocationStatus === "OPEN");
}

/** Remaining qty from the most-recent CLOSED/RETURNED_TO_STOCK session
 *  that recorded an endingBalanceQty. Falls back to null. */
export function deriveRemainingEstimate(sessions: readonly PartialBagSession[]): number | null {
  const relevant = sessions
    .filter(
      (s) =>
        (s.allocationStatus === "CLOSED" || s.allocationStatus === "RETURNED_TO_STOCK") &&
        s.endingBalanceQty != null,
    )
    .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  return relevant[0]?.endingBalanceQty ?? null;
}

// ─── DB query ───────────────────────────────────────────────────────

/** Load all AVAILABLE raw bags that have been through ≥1 production run.
 *  Returns rows sorted by last-used date desc (most recently used first). */
export async function loadAvailablePartialBags(): Promise<AvailablePartialBagRow[]> {
  // Step 1: All AVAILABLE bags with context
  const bagRows = await db
    .select({
      id: inventoryBags.id,
      bagNumber: inventoryBags.bagNumber,
      bagQrCode: inventoryBags.bagQrCode,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      declaredPillCount: inventoryBags.declaredPillCount,
      pillCount: inventoryBags.pillCount,
      smallBoxId: inventoryBags.smallBoxId,
      tabletTypeName: tabletTypes.name,
      batchNumber: batches.batchNumber,
      receiveId: smallBoxes.receiveId,
    })
    .from(inventoryBags)
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(batches, eq(batches.id, inventoryBags.batchId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .where(eq(inventoryBags.status, "AVAILABLE"))
    .orderBy(asc(inventoryBags.bagNumber));

  if (bagRows.length === 0) return [];

  const bagIds = bagRows.map((b) => b.id);

  // Step 2: All sessions for these bags (ordered oldest-first so JS picks last)
  const sessionRows = await db
    .select({
      inventoryBagId: rawBagAllocationSessions.inventoryBagId,
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      consumedQty: rawBagAllocationSessions.consumedQty,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      openedAt: rawBagAllocationSessions.openedAt,
      closedAt: rawBagAllocationSessions.closedAt,
      productName: products.name,
    })
    .from(rawBagAllocationSessions)
    .leftJoin(products, eq(products.id, rawBagAllocationSessions.productId))
    .where(inArray(rawBagAllocationSessions.inventoryBagId, bagIds))
    .orderBy(asc(rawBagAllocationSessions.openedAt));

  // Step 3: Group sessions by bag, filter to partial bags, build output
  const sessionsByBag = new Map<string, typeof sessionRows>();
  for (const s of sessionRows) {
    const bagId = s.inventoryBagId;
    if (!bagId) continue;
    const list = sessionsByBag.get(bagId) ?? [];
    list.push(s);
    sessionsByBag.set(bagId, list);
  }

  const result: AvailablePartialBagRow[] = [];

  for (const bag of bagRows) {
    const sessions = sessionsByBag.get(bag.id) ?? [];
    if (!isAvailablePartialBag(sessions)) continue; // fresh bag, not partial

    // Last closed/returned session (sessions are oldest-first, so last = most recent)
    const lastClosed = [...sessions]
      .reverse()
      .find(
        (s) =>
          s.allocationStatus === "CLOSED" || s.allocationStatus === "RETURNED_TO_STOCK",
      );

    const remainingEstimate = deriveRemainingEstimate(sessions);

    result.push({
      bagId: bag.id,
      bagNumber: bag.bagNumber,
      bagQrCode: bag.bagQrCode,
      internalReceiptNumber: bag.internalReceiptNumber,
      tabletTypeName: bag.tabletTypeName ?? null,
      supplierLot: bag.batchNumber ?? null,
      receiveId: bag.receiveId ?? null,
      declaredPillCount: bag.declaredPillCount,
      pillCount: bag.pillCount,
      remainingEstimate,
      lastConsumedQty: lastClosed?.consumedQty ?? null,
      lastUsedProductName: lastClosed?.productName ?? null,
      lastUsedAt: lastClosed?.closedAt ?? null,
      lastSessionStatus: lastClosed?.allocationStatus ?? null,
    });
  }

  // Sort: most recently used first
  result.sort((a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0));

  return result;
}
```

### Task B: Unit tests — lib/production/partial-bags.test.ts

**Files:**
- Create: `lib/production/partial-bags.test.ts`

**Full file to implement:**

```typescript
import { describe, expect, it } from "vitest";
import {
  deriveRemainingEstimate,
  hasOpenAllocationSession,
  isAvailablePartialBag,
} from "./partial-bags";

const closed = (endingBalanceQty: number | null, closedAt?: Date) => ({
  allocationStatus: "CLOSED" as const,
  endingBalanceQty,
  closedAt: closedAt ?? new Date("2026-01-01"),
});
const returned = (endingBalanceQty: number | null) => ({
  allocationStatus: "RETURNED_TO_STOCK" as const,
  endingBalanceQty,
  closedAt: new Date("2026-01-02"),
});
const open = () => ({ allocationStatus: "OPEN" as const, endingBalanceQty: null, closedAt: null });
const depleted = () => ({ allocationStatus: "DEPLETED" as const, endingBalanceQty: 0, closedAt: new Date("2026-01-01") });

describe("isAvailablePartialBag", () => {
  it("returns false for fresh bag with no sessions", () => {
    expect(isAvailablePartialBag([])).toBe(false);
  });
  it("returns false when only session is OPEN", () => {
    expect(isAvailablePartialBag([open()])).toBe(false);
  });
  it("returns false when only session is DEPLETED", () => {
    expect(isAvailablePartialBag([depleted()])).toBe(false);
  });
  it("returns true when has CLOSED session", () => {
    expect(isAvailablePartialBag([closed(50)])).toBe(true);
  });
  it("returns true when has RETURNED_TO_STOCK session", () => {
    expect(isAvailablePartialBag([returned(100)])).toBe(true);
  });
  it("returns true when has CLOSED session with endingBalanceQty null (unknown remaining)", () => {
    expect(isAvailablePartialBag([closed(null)])).toBe(true);
  });
});

describe("hasOpenAllocationSession", () => {
  it("returns false for empty sessions", () => {
    expect(hasOpenAllocationSession([])).toBe(false);
  });
  it("returns false when all sessions are closed", () => {
    expect(hasOpenAllocationSession([closed(20), depleted()])).toBe(false);
  });
  it("returns true when any session is OPEN", () => {
    expect(hasOpenAllocationSession([closed(20), open()])).toBe(true);
  });
});

describe("deriveRemainingEstimate", () => {
  it("returns null for empty sessions", () => {
    expect(deriveRemainingEstimate([])).toBeNull();
  });
  it("returns null when only OPEN sessions", () => {
    expect(deriveRemainingEstimate([open()])).toBeNull();
  });
  it("returns endingBalanceQty from CLOSED session", () => {
    expect(deriveRemainingEstimate([closed(75)])).toBe(75);
  });
  it("returns null when endingBalanceQty is null on CLOSED session", () => {
    expect(deriveRemainingEstimate([closed(null)])).toBeNull();
  });
  it("returns most-recent CLOSED session qty when multiple sessions", () => {
    const older = closed(100, new Date("2026-01-01"));
    const newer = closed(40, new Date("2026-01-10"));
    expect(deriveRemainingEstimate([older, newer])).toBe(40);
  });
  it("prefers CLOSED over RETURNED_TO_STOCK if CLOSED is more recent", () => {
    const ret = returned(80);
    const clos = closed(30, new Date("2026-01-15"));
    expect(deriveRemainingEstimate([ret, clos])).toBe(30);
  });
});
```

### Task C: Admin page — app/(admin)/partial-bags/page.tsx

**Files:**
- Create: `app/(admin)/partial-bags/page.tsx`

**Background:** Use `requireAdmin()` or `requireLead()` from `@/lib/auth-guards`. The `PageHeader` component is at `@/components/ui/page-header`. Card, CardContent, CardHeader, CardTitle are at `@/components/ui`. `Link` is from `next/link`. The `loadAvailablePartialBags()` function returns `AvailablePartialBagRow[]`. Receipt number is `internalReceiptNumber`. Dates should show `.toLocaleDateString("en-CA")` (YYYY-MM-DD). Links: `/inbound/{receiveId}` for receive detail, `/production/start` for start production (no preselect needed). Use `export const dynamic = "force-dynamic"`.

**Pattern reference:** Follow the same compact table pattern as `app/(admin)/active-rolls/page.tsx` — table inside `<Card>` with `text-xs` cells and `text-text-muted` headings.

**Full page to implement:**

```tsx
// PARTIAL-1 — Available Partial Bags visibility page.

import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { loadAvailablePartialBags } from "@/lib/production/partial-bags";

export const dynamic = "force-dynamic";

export default async function PartialBagsPage() {
  await requireAdmin();
  const rows = await loadAvailablePartialBags();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Available Partial Bags"
        description="Raw bags that have been partially consumed in a production run and are ready for reuse. QR cards remain assigned to the physical bag until it is depleted."
      />

      <Card>
        <CardHeader>
          <CardTitle>
            {rows.length === 0 ? "No partial bags" : `${rows.length} bag${rows.length === 1 ? "" : "s"} available`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-text-muted py-4 text-center">
              All raw bags are either fresh (unused), in progress, or depleted.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-muted uppercase text-[10px] tracking-wide border-b border-border">
                    <th className="text-left py-2 pr-3">QR token</th>
                    <th className="text-left py-2 pr-3">Tablet type</th>
                    <th className="text-left py-2 pr-3">Supplier lot</th>
                    <th className="text-left py-2 pr-3">Receipt #</th>
                    <th className="text-right py-2 pr-3">Declared</th>
                    <th className="text-right py-2 pr-3">Remaining</th>
                    <th className="text-left py-2 pr-3">Last product</th>
                    <th className="text-left py-2 pr-3">Last used</th>
                    <th className="text-left py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {rows.map((row) => (
                    <tr key={row.bagId} className="hover:bg-surface-2 transition-colors">
                      <td className="py-2 pr-3 font-mono text-[11px] text-text-strong">
                        {row.bagQrCode ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-text">
                        {row.tabletTypeName ?? "—"}
                      </td>
                      <td className="py-2 pr-3 font-mono text-[11px]">
                        {row.supplierLot ?? "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {row.receiveId ? (
                          <Link
                            href={`/inbound/${row.receiveId}`}
                            className="text-brand-600 hover:underline font-mono text-[11px]"
                          >
                            {row.internalReceiptNumber ?? row.receiveId.slice(0, 8)}
                          </Link>
                        ) : (
                          <span className="text-text-muted">{row.internalReceiptNumber ?? "—"}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.declaredPillCount != null ? row.declaredPillCount.toLocaleString() : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.remainingEstimate != null ? (
                          <span className={row.remainingEstimate < 100 ? "text-amber-600 font-medium" : ""}>
                            {row.remainingEstimate.toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-text-subtle italic">unknown</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-text-muted">
                        {row.lastUsedProductName ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-text-muted">
                        {row.lastUsedAt
                          ? row.lastUsedAt.toLocaleDateString("en-CA")
                          : "—"}
                      </td>
                      <td className="py-2">
                        <Link
                          href="/production/start"
                          className="inline-flex items-center px-2 py-1 rounded border border-brand-300 bg-brand-50 text-brand-700 text-[11px] font-medium hover:bg-brand-100 transition-colors"
                        >
                          Start run
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

### Task D: Sidebar link + sidebar test update

**Files:**
- Modify: `components/admin/sidebar.tsx`
- Modify: `components/admin/sidebar.test.ts`

**Sidebar change:** Add `Archive` to the lucide-react import list. Add entry to Operations section (after Start production):

```typescript
// In import list, add: Archive,
// In Operations items array, add after { href: "/production/start", ... }:
{ href: "/partial-bags", label: "Available Partial Bags", icon: Archive },
```

**Sidebar test change:** In the `currentRoutes` array, add `"/partial-bags"`:

```typescript
const currentRoutes = [
  // ... existing routes ...
  "/partial-bags",
  // ... rest ...
];
```

Also verify the test suite passes with `npm test -- --run components/admin/sidebar.test.ts`.

### Task E: Start Production OPEN session guard

**Files:**
- Modify: `app/(admin)/production/start/actions.ts`

**Change:** After the `bag.status !== 'AVAILABLE'` check (around line 83), add:

```typescript
import { rawBagAllocationSessions } from "@/lib/db/schema";
// (already imported probably; check and add if not)

// After status check, before QR check:
const [openSession] = await db
  .select({ id: rawBagAllocationSessions.id })
  .from(rawBagAllocationSessions)
  .where(
    and(
      eq(rawBagAllocationSessions.inventoryBagId, bag.id),
      eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
    ),
  )
  .limit(1);
if (openSession) {
  return {
    ok: false,
    error:
      "This bag has an open allocation session in progress. Close the floor session before starting a new production run.",
  };
}
```

Note: `and` must be imported from `drizzle-orm` if not already present.

### Task F: Typecheck + test + build + v0.2.23 + push

- Run `npm run typecheck` — must pass with 0 errors
- Run `npm test` — all tests must pass (expect ~2200+ with new partial-bags tests)
- Run `npm run build` — must complete with 0 errors
- Bump `package.json` version: `"0.2.22"` → `"0.2.23"`
- Add CHANGELOG entry at top (after `# Changelog`):

```markdown
## [0.2.23] — 2026-05-22

### Added
- Available Partial Bags page (`/partial-bags`): shows AVAILABLE raw bags that have been through ≥1 production run, with remaining estimate, last used product/date, and a Start run link. No new DB status — derived from `rawBagAllocationSessions` ledger.
- `loadAvailablePartialBags()` DB query + `isAvailablePartialBag`, `hasOpenAllocationSession`, `deriveRemainingEstimate` pure helpers in `lib/production/partial-bags.ts`. 15+ unit tests.
- "Available Partial Bags" link added to Operations section of sidebar.

### Changed
- Start Production now blocks a bag if it has an OPEN allocation session (belt-and-suspenders guard; AVAILABLE status already blocks IN_USE bags, but this provides a clear error message for any edge case).
```

- Commit: `git commit -m "feat(partial-bags): v0.2.23 — Available Partial Bags page + lifecycle helpers"`
- Push: `git push`

---
