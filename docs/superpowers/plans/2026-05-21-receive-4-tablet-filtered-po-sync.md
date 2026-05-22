# RECEIVE-4: Tablet-Filtered PO Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch raw bag intake PO sync to the tablet-filtered endpoint (`?luma_tablet_only=true`), store the `is_tablet_po` flag locally, and filter the intake dropdown to show only tablet POs.

**Architecture:** Add `tabletOnly?: boolean` to `listInventoryPurchaseOrders()` which appends `?luma_tablet_only=true` to the path. `po-sync.ts` passes `tabletOnly: true`, reads `app_flags.luma.is_tablet_po` from each response, stores it in a new `is_tablet_po` boolean column on `purchase_orders`, and only queues OPEN/RECEIVING tablet POs for detail fetch. The raw bag intake page filters the dropdown by `is_tablet_po = true`. Non-tablet POs already in the DB stay inert (null flag, never shown).

**Tech Stack:** Next.js 15 App Router, Drizzle ORM, Postgres 16, Vitest, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).

---

## File Map

| File | Change |
|------|--------|
| `lib/zoho/inventory-service-client.ts` | Add `ZohoLumaAppFlags` type, `app_flags` to PO types, `extractIsTabletPo` helper, `tabletOnly` option |
| `lib/zoho/inventory-service-client.test.ts` | 3 new tests: tabletOnly URL, no-option URL, extractIsTabletPo |
| `lib/db/schema.ts` | Add `isTabletPo: boolean("is_tablet_po")` to `purchaseOrders` |
| `drizzle/0042_po_is_tablet.sql` | `ALTER TABLE purchase_orders ADD COLUMN is_tablet_po boolean;` |
| `drizzle/meta/_journal.json` | Add entry for migration 0042 |
| `lib/zoho/po-sync.ts` | Use `tabletOnly: true`, read flag, store it, gate detail fetch on `isTabletPo`, add `nonTabletFlagged` to result |
| `lib/zoho/po-sync.test.ts` | 6 new tests: tabletOnly call, flag-true stored, anomaly excluded, anomaly logged, no write endpoints, result shape |
| `app/(admin)/receiving/raw-bags/page.tsx` | Filter dropdown by `isTabletPo = true`, update badge copy |
| `app/(admin)/receiving/raw-bags/sync-po-button.tsx` | Update banner to say "tablet POs" + `nonTabletFlagged` |
| `package.json` | `0.2.9` → `0.2.10` |
| `CHANGELOG.md` | Add `[0.2.10]` entry |

---

## Task 1: Safety Check (no commit)

**Files:** none (read-only audit)

- [ ] **Step 1: Check branch, SHA, version, working tree**

```bash
git log --oneline -3
git status
cat package.json | grep '"version"'
```

Expected output:
```
fc6028e chore: bump to v0.2.9 — RECEIVE-3 per-row supplier lot
On branch luma-live-testing
Your branch is up to date with 'origin/luma-live-testing'.
"version": "0.2.9",
```

- [ ] **Step 2: Verify test suite baseline**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
npm test 2>&1 | tail -5
```

Expected: `Tests 2083 passed`

---

## Task 2: Client — `tabletOnly` option + `app_flags` types + helper

**Files:**
- Modify: `lib/zoho/inventory-service-client.ts`
- Modify: `lib/zoho/inventory-service-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the BOTTOM of `lib/zoho/inventory-service-client.test.ts` (after all existing tests):

```typescript
// ─── tabletOnly option ────────────────────────────────────────────────────────

describe("listInventoryPurchaseOrders — tabletOnly option", () => {
  it("calls /zoho/purchaseorders_inv/list?luma_tablet_only=true when tabletOnly: true", async () => {
    let capturedUrl: string | null = null;

    const captureFetch: typeof fetch = ((url: string, _init?: RequestInit) => {
      capturedUrl = url;
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            data: { purchaseorders: [] },
            meta: SAMPLE_META,
          }),
        text: () => Promise.resolve(""),
      });
    }) as unknown as typeof fetch;

    await listInventoryPurchaseOrders({
      tabletOnly: true,
      env: VALID_ENV,
      fetchImpl: captureFetch,
    });

    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl).toContain("/zoho/purchaseorders_inv/list");
    expect(capturedUrl).toContain("luma_tablet_only=true");
  });

  it("does NOT include luma_tablet_only when tabletOnly is omitted", async () => {
    let capturedUrl: string | null = null;

    const captureFetch: typeof fetch = ((url: string, _init?: RequestInit) => {
      capturedUrl = url;
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            data: { purchaseorders: [] },
            meta: SAMPLE_META,
          }),
        text: () => Promise.resolve(""),
      });
    }) as unknown as typeof fetch;

    await listInventoryPurchaseOrders({ env: VALID_ENV, fetchImpl: captureFetch });

    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl).not.toContain("luma_tablet_only");
  });
});

// ─── extractIsTabletPo helper ─────────────────────────────────────────────────

describe("extractIsTabletPo", () => {
  it("returns true when app_flags.luma.is_tablet_po is true", () => {
    const po = { app_flags: { luma: { is_tablet_po: true } } };
    expect(extractIsTabletPo(po)).toBe(true);
  });

  it("returns false when app_flags is missing", () => {
    expect(extractIsTabletPo({})).toBe(false);
  });

  it("returns false when luma block is missing", () => {
    expect(extractIsTabletPo({ app_flags: {} })).toBe(false);
  });

  it("returns false when is_tablet_po is false", () => {
    expect(extractIsTabletPo({ app_flags: { luma: { is_tablet_po: false } } })).toBe(false);
  });

  it("returns false when is_tablet_po is undefined", () => {
    expect(extractIsTabletPo({ app_flags: { luma: {} } })).toBe(false);
  });
});
```

Also add `extractIsTabletPo` to the import at the top of the test file:
```typescript
import {
  buildInventoryServiceHeaders,
  redactInventoryServiceHeaders,
  listInventoryPurchaseOrders,
  getInventoryPurchaseOrder,
  searchZohoItems,
  listWarehouses,
  extractIsTabletPo,
} from "./inventory-service-client";
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
npm test -- lib/zoho/inventory-service-client.test.ts 2>&1 | tail -20
```

Expected: FAIL — `extractIsTabletPo is not exported` / `tabletOnly not recognized`

- [ ] **Step 3: Implement types + helper + option in client**

In `lib/zoho/inventory-service-client.ts`, make the following changes:

**3a. Add `ZohoLumaAppFlags` type and add `app_flags` to the two PO types.**

Add this new type block right after the existing `ZohoResponseMeta` type (around line 80):

```typescript
/** Normalized Luma-specific flags injected by Zoho Integration Service. */
export type ZohoLumaAppFlags = {
  luma?: {
    is_tablet_po?: boolean;
  };
};
```

Update `ZohoPurchaseOrderSummary` to add `app_flags?`:
```typescript
export type ZohoPurchaseOrderSummary = {
  purchaseorder_id: string;
  purchaseorder_number: string;
  vendor_name: string;
  status: string;
  date: string;
  total: number;
  received_status: string;
  quantity_yet_to_receive: number;
  app_flags?: ZohoLumaAppFlags;
};
```

Update `ZohoPurchaseOrderDetail` to add `app_flags?`:
```typescript
export type ZohoPurchaseOrderDetail = {
  purchaseorder_id: string;
  purchaseorder_number: string;
  vendor_name: string;
  status: string;
  date: string;
  received_status: string;
  line_items: ZohoPoLineItem[];
  app_flags?: ZohoLumaAppFlags;
};
```

**3b. Add `extractIsTabletPo` pure helper.** Add after the `ZohoLumaAppFlags` type:

```typescript
/**
 * Pure: return true iff app_flags.luma.is_tablet_po === true.
 * Treats missing/null/false as not eligible for raw bag intake.
 * Never throws on missing nested keys.
 */
export function extractIsTabletPo(po: { app_flags?: ZohoLumaAppFlags }): boolean {
  return po.app_flags?.luma?.is_tablet_po === true;
}
```

**3c. Add `tabletOnly` option to `listInventoryPurchaseOrders`.** Change the function signature and path construction:

```typescript
export async function listInventoryPurchaseOrders(opts?: {
  tabletOnly?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<InventoryServiceReadResult<ZohoPurchaseOrderSummary[]>> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const path = opts?.tabletOnly === true
    ? "/zoho/purchaseorders_inv/list?luma_tablet_only=true"
    : "/zoho/purchaseorders_inv/list";

  const result = await getInventoryEndpoint({
    path,
    env,
    fetchImpl,
    timeoutMs,
  });
  // ... rest of function unchanged ...
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
npm test -- lib/zoho/inventory-service-client.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Full test suite**

```bash
npm test 2>&1 | tail -5
```

Expected: previously passing 2083 + 7 new = 2090 tests passing.

- [ ] **Step 6: Commit**

```bash
git add lib/zoho/inventory-service-client.ts lib/zoho/inventory-service-client.test.ts
git commit -m "feat(receive-4): tabletOnly option + app_flags types + extractIsTabletPo"
```

---

## Task 3: Schema + Migration — `is_tablet_po` column

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `drizzle/0042_po_is_tablet.sql`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Step 1: Add column to schema**

In `lib/db/schema.ts`, in the `purchaseOrders` pgTable definition (around line 505–523), add `isTabletPo` after `notes`:

Before:
```typescript
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poNumber: text("po_number").notNull(),
    parentPoNumber: text("parent_po_number"),
    vendorName: text("vendor_name"),
    status: poStatusEnum("status").notNull().default("OPEN"),
    zohoPoId: text("zoho_po_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    notes: text("notes"),
  },
```

After (add `isTabletPo` as the last column):
```typescript
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poNumber: text("po_number").notNull(),
    parentPoNumber: text("parent_po_number"),
    vendorName: text("vendor_name"),
    status: poStatusEnum("status").notNull().default("OPEN"),
    zohoPoId: text("zoho_po_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    notes: text("notes"),
    isTabletPo: boolean("is_tablet_po"),
  },
```

- [ ] **Step 2: Create migration SQL**

Create `drizzle/0042_po_is_tablet.sql`:

```sql
-- 0042 — Add is_tablet_po flag to purchase_orders.
--
-- Zoho Integration Service now exposes app_flags.luma.is_tablet_po on the
-- tablet-filtered PO list endpoint (?luma_tablet_only=true). We store the
-- flag so the raw bag intake dropdown can filter locally without re-fetching.
--
-- Existing POs default to null (not yet verified). After a tablet-filtered
-- sync they will be set to true. Non-tablet POs never appear in the dropdown.

ALTER TABLE "purchase_orders" ADD COLUMN "is_tablet_po" boolean;
```

- [ ] **Step 3: Update migration journal**

In `drizzle/meta/_journal.json`, add the new entry to the `entries` array (after the `0041` entry):

```json
{
  "idx": 42,
  "version": "7",
  "when": 1782200000000,
  "tag": "0042_po_is_tablet",
  "breakpoints": true
}
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
npm run typecheck 2>&1 | tail -10
```

Expected: clean (no errors).

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts drizzle/0042_po_is_tablet.sql drizzle/meta/_journal.json
git commit -m "feat(receive-4): add is_tablet_po column to purchase_orders (migration 0042)"
```

---

## Task 4: `po-sync.ts` — tablet-filtered sync + flag storage + anomaly reporting

**Files:**
- Modify: `lib/zoho/po-sync.ts`
- Modify: `lib/zoho/po-sync.test.ts`

- [ ] **Step 1: Write failing tests**

Add to the BOTTOM of `lib/zoho/po-sync.test.ts`:

```typescript
// ─── RECEIVE-4: tablet-filtered sync tests ────────────────────────────────────

describe("tablet-filtered sync — tabletOnly: true", () => {
  it("calls listInventoryPurchaseOrders with tabletOnly: true", async () => {
    mockList.mockResolvedValueOnce({ ok: true, data: [], meta: META });

    await syncPurchaseOrdersFromZoho({ dbOverride: mockDbSelect([]) as unknown as typeof db });

    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ tabletOnly: true }),
    );
  });

  it("stores isTabletPo: true for POs with is_tablet_po flag", async () => {
    const po = {
      ...makeZohoPo(),
      app_flags: { luma: { is_tablet_po: true } },
    };
    mockList.mockResolvedValueOnce({ ok: true, data: [po], meta: META });
    mockGetDetail.mockResolvedValueOnce(makePoDetail("ZPOID-001", []));

    let capturedInsertValues: Record<string, unknown> | null = null;
    const insertSpy = vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        capturedInsertValues = vals;
        return { returning: vi.fn().mockResolvedValue([{ id: "new-uuid" }]) };
      }),
    });

    const mockDb = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      insert: insertSpy,
      update: vi.fn(),
    };

    await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as unknown as typeof db });

    expect(capturedInsertValues).not.toBeNull();
    expect(capturedInsertValues!["isTabletPo"]).toBe(true);
  });

  it("excludes PO with missing app_flags from detail fetch and logs anomaly", async () => {
    const po = makeZohoPo(); // no app_flags
    mockList.mockResolvedValueOnce({ ok: true, data: [po], meta: META });

    const mockDb = mockDbFull([]);

    const result = await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as unknown as typeof db });

    // Detail fetch must NOT happen for non-tablet POs
    expect(mockGetDetail).not.toHaveBeenCalled();
    expect(result.nonTabletFlagged).toBe(1);
    expect(result.errors.some((e) => e.includes("is_tablet_po"))).toBe(true);
  });

  it("excludes PO with is_tablet_po: false from detail fetch and logs anomaly", async () => {
    const po = { ...makeZohoPo(), app_flags: { luma: { is_tablet_po: false } } };
    mockList.mockResolvedValueOnce({ ok: true, data: [po], meta: META });

    const mockDb = mockDbFull([]);

    const result = await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as unknown as typeof db });

    expect(mockGetDetail).not.toHaveBeenCalled();
    expect(result.nonTabletFlagged).toBe(1);
  });

  it("includes nonTabletFlagged: 0 in result when all POs have the flag", async () => {
    const po = { ...makeZohoPo(), app_flags: { luma: { is_tablet_po: true } } };
    mockList.mockResolvedValueOnce({ ok: true, data: [po], meta: META });
    mockGetDetail.mockResolvedValueOnce(makePoDetail("ZPOID-001", []));

    const result = await syncPurchaseOrdersFromZoho({ dbOverride: mockDbFull([]) as unknown as typeof db });

    expect(result.nonTabletFlagged).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("still fetches detail and upserts lines for tablet POs", async () => {
    const po = { ...makeZohoPo(), app_flags: { luma: { is_tablet_po: true } } };
    mockList.mockResolvedValueOnce({ ok: true, data: [po], meta: META });
    mockGetDetail.mockResolvedValueOnce(
      makePoDetail("ZPOID-001", [makeZohoLine()]),
    );

    const mockDb = makeLineSyncDb({
      selectSequence: [[], [], []],
      insertReturns: [{ id: "po-uuid" }, undefined],
    });

    const result = await syncPurchaseOrdersFromZoho({ dbOverride: mockDb as unknown as typeof db });

    expect(mockGetDetail).toHaveBeenCalledTimes(1);
    expect(result.lineUpserted).toBe(1);
    expect(result.detailsFetched).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
npm test -- lib/zoho/po-sync.test.ts 2>&1 | tail -20
```

Expected: FAIL — `nonTabletFlagged` not in result, `tabletOnly` not passed, etc.

- [ ] **Step 3: Implement in `po-sync.ts`**

**3a. Update imports** — add `extractIsTabletPo` to the import from `./inventory-service-client`:

```typescript
import {
  listInventoryPurchaseOrders,
  getInventoryPurchaseOrder,
  extractIsTabletPo,
} from "./inventory-service-client";
import type {
  ZohoPurchaseOrderSummary,
  ZohoPoLineItem,
} from "./inventory-service-client";
```

**3b. Update `PoSyncResult`** — add `nonTabletFlagged`:

```typescript
export type PoSyncResult = {
  fetched: number;
  poUpserted: number;
  lineUpserted: number;
  lineSkipped: number;
  detailsFetched: number;
  nonTabletFlagged: number; // POs returned by filtered endpoint without is_tablet_po=true
  errors: string[];
};
```

**3c. Update `UpsertPoResult`** — add `isTabletPo` so the caller knows to gate detail fetch:

```typescript
type UpsertPoResult = {
  localPoId: string;
  zohoPoId: string;
  effectiveStatus: LocalPoStatus;
  isTabletPo: boolean;
};
```

**3d. Update `syncPurchaseOrdersFromZoho`** — change the list call to use `tabletOnly: true`, pass flag to `upsertPo`, gate `receivablePos` on `isTabletPo`:

In the body of `syncPurchaseOrdersFromZoho`, change:

```typescript
const listResult = await listInventoryPurchaseOrders(listOpts);
```
→
```typescript
const listResult = await listInventoryPurchaseOrders({ ...listOpts, tabletOnly: true });
```

Change the initial counters to include `nonTabletFlagged`:
```typescript
let poUpserted = 0;
let nonTabletFlagged = 0;
```

Change the per-PO loop:
```typescript
for (const zohoPo of zohoPos) {
  const isTabletPo = extractIsTabletPo(zohoPo);
  if (!isTabletPo) {
    nonTabletFlagged++;
    errors.push(
      `Contract anomaly: PO ${zohoPo.purchaseorder_id} returned by tablet-filtered endpoint but is_tablet_po is not true`,
    );
  }
  try {
    const result = await upsertPo(db, zohoPo, isTabletPo, errors);
    poUpserted++;
    if (
      isTabletPo &&
      (result.effectiveStatus === "OPEN" || result.effectiveStatus === "RECEIVING")
    ) {
      receivablePos.push({
        localPoId: result.localPoId,
        zohoPoId: result.zohoPoId,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to upsert PO ${zohoPo.purchaseorder_id}: ${msg}`);
  }
}
```

Update the `return` at the end to include `nonTabletFlagged`:
```typescript
return {
  fetched,
  poUpserted,
  lineUpserted,
  lineSkipped,
  detailsFetched,
  nonTabletFlagged,
  errors,
};
```

**3e. Update `upsertPo`** — accept `isTabletPo` parameter and store it:

Change signature:
```typescript
async function upsertPo(
  db: typeof realDb,
  zohoPo: ZohoPurchaseOrderSummary,
  isTabletPo: boolean,
  errors: string[],
): Promise<UpsertPoResult>
```

In the INSERT branch, add `isTabletPo` to values:
```typescript
const returned = await db
  .insert(purchaseOrders)
  .values({
    poNumber: zohoPo.purchaseorder_number,
    vendorName: zohoPo.vendor_name,
    status: mappedStatus,
    zohoPoId: zohoPo.purchaseorder_id,
    openedAt,
    isTabletPo,
  })
  .returning({ id: purchaseOrders.id });
```

In the UPDATE branch, add `isTabletPo` to the update payload (always update it, since the endpoint may have given us new info):
```typescript
const updatePayload: Partial<typeof purchaseOrders.$inferInsert> = {
  vendorName: zohoPo.vendor_name,
  openedAt,
  isTabletPo,
};
```

Return `isTabletPo` in both INSERT and UPDATE return objects:
```typescript
// INSERT return:
return {
  localPoId: insertedId,
  zohoPoId: zohoPo.purchaseorder_id,
  effectiveStatus: mappedStatus,
  isTabletPo,
};

// UPDATE return:
return {
  localPoId: existingPo.id,
  zohoPoId: zohoPo.purchaseorder_id,
  effectiveStatus,
  isTabletPo,
};
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
npm test -- lib/zoho/po-sync.test.ts 2>&1 | tail -20
```

Expected: all po-sync tests pass.

- [ ] **Step 5: Full test suite**

```bash
npm test 2>&1 | tail -5
```

Expected: 2090 + 6 = 2096 tests passing (adjust if counts differ).

- [ ] **Step 6: Commit**

```bash
git add lib/zoho/po-sync.ts lib/zoho/po-sync.test.ts
git commit -m "feat(receive-4): tablet-filtered sync — tabletOnly, is_tablet_po storage, anomaly reporting"
```

---

## Task 5: Raw Bag Intake Page — Filter Dropdown + Badge

**Files:**
- Modify: `app/(admin)/receiving/raw-bags/page.tsx`

- [ ] **Step 1: Update the page**

In `app/(admin)/receiving/raw-bags/page.tsx`:

**5a. Add `and` to the drizzle imports** (it's not there yet):

```typescript
import { asc, desc, eq, inArray, and } from "drizzle-orm";
```

**5b. Add `isTabletPo` to the selected fields and filter by it:**

Change the `pos` query from:
```typescript
db
  .select({
    id: purchaseOrders.id,
    poNumber: purchaseOrders.poNumber,
    vendorName: purchaseOrders.vendorName,
    status: purchaseOrders.status,
  })
  .from(purchaseOrders)
  .where(inArray(purchaseOrders.status, [...RECEIVABLE_PO_STATUSES]))
  .orderBy(desc(purchaseOrders.openedAt)),
```

To:
```typescript
db
  .select({
    id: purchaseOrders.id,
    poNumber: purchaseOrders.poNumber,
    vendorName: purchaseOrders.vendorName,
    status: purchaseOrders.status,
  })
  .from(purchaseOrders)
  .where(
    and(
      inArray(purchaseOrders.status, [...RECEIVABLE_PO_STATUSES]),
      eq(purchaseOrders.isTabletPo, true),
    ),
  )
  .orderBy(desc(purchaseOrders.openedAt)),
```

**5c. Update badge strip text** — change the first badge from:

```tsx
{pos.length} open/receiving PO{pos.length === 1 ? "" : "s"}
```

To:
```tsx
{pos.length} tablet PO{pos.length === 1 ? "" : "s"}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
npm run typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/(admin)/receiving/raw-bags/page.tsx
git commit -m "feat(receive-4): filter raw bag intake dropdown to is_tablet_po=true only"
```

---

## Task 6: Sync Banner — Tablet-Filtered Reporting

**Files:**
- Modify: `app/(admin)/receiving/raw-bags/sync-po-button.tsx`

- [ ] **Step 1: Update the banner text**

In `sync-po-button.tsx`, change the result display from:

```tsx
{lastResult && (
  <p className="text-[10px] text-text-muted">
    {lastResult.fetched} POs · {lastResult.detailsFetched} details · {lastResult.lineUpserted} lines synced
    {lastResult.lineSkipped > 0 && (
      <span className="ml-1">· {lastResult.lineSkipped} skipped</span>
    )}
    {lastResult.errors.length > 0 && (
      <span className="text-warn-700 ml-1">· {lastResult.errors.length} error{lastResult.errors.length !== 1 ? "s" : ""}</span>
    )}
  </p>
)}
```

To:
```tsx
{lastResult && (
  <p className="text-[10px] text-text-muted">
    Synced {lastResult.fetched} tablet PO{lastResult.fetched === 1 ? "" : "s"} · {lastResult.detailsFetched} detail{lastResult.detailsFetched === 1 ? "" : "s"} · {lastResult.lineUpserted} line{lastResult.lineUpserted === 1 ? "" : "s"}
    {lastResult.lineSkipped > 0 && (
      <span className="ml-1">· {lastResult.lineSkipped} line{lastResult.lineSkipped === 1 ? "" : "s"} skipped</span>
    )}
    {lastResult.nonTabletFlagged > 0 && (
      <span className="text-warn-700 ml-1">· {lastResult.nonTabletFlagged} anomaly flag{lastResult.nonTabletFlagged === 1 ? "" : "s"}</span>
    )}
    {lastResult.errors.length > 0 && (
      <span className="text-warn-700 ml-1">· {lastResult.errors.length} error{lastResult.errors.length !== 1 ? "s" : ""}</span>
    )}
  </p>
)}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
npm run typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/(admin)/receiving/raw-bags/sync-po-button.tsx
git commit -m "feat(receive-4): sync banner shows tablet-filtered counts + anomaly flag"
```

---

## Task 7: Checks, Version Bump, Push, Deploy Verify

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run typecheck**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
npm run typecheck 2>&1 | tail -5
```

Expected: `Found 0 errors.` or clean exit.

- [ ] **Step 2: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests passing. Note the exact count.

- [ ] **Step 3: Run build**

```bash
npm run build 2>&1 | tail -15
```

Expected: build succeeds, no TypeScript errors.

- [ ] **Step 4: Bump version in `package.json`**

Change `"version": "0.2.9"` → `"version": "0.2.10"`.

- [ ] **Step 5: Update `CHANGELOG.md`**

Add at the top (after `# Changelog`):

```markdown
## [0.2.10] — 2026-05-21

### Changed
- Raw bag intake PO sync now uses tablet-filtered endpoint (`?luma_tablet_only=true`). Only tablet POs are synced, stored, and shown in the intake dropdown.
- Sync banner reports "Synced N tablet POs · N details · N lines" with anomaly flag count if any POs returned without `is_tablet_po = true`.
- Intake dropdown badge updated to "N tablet POs".

### Added
- `is_tablet_po` column on `purchase_orders` (migration 0042, additive nullable). Set to `true` for all POs returned by the tablet-filtered endpoint; old POs remain null and are excluded from raw bag intake.
- `extractIsTabletPo()` pure helper in `inventory-service-client.ts` — reads `app_flags.luma.is_tablet_po`.
- `nonTabletFlagged` counter in `PoSyncResult` — counts contract anomalies (POs from filtered endpoint without the flag set).
- `tabletOnly: boolean` option on `listInventoryPurchaseOrders()` in Zoho inventory client.
- 13 new unit tests for tabletOnly URL, extractIsTabletPo, tablet-filtered po-sync behavior (total: 2096).
```

- [ ] **Step 6: Commit version + changelog**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump to v0.2.10 — RECEIVE-4 tablet-filtered PO sync"
```

- [ ] **Step 7: Push to origin**

```bash
git push origin luma-live-testing
```

Expected: push succeeds, `luma-live-testing -> luma-live-testing`.

- [ ] **Step 8: Report final state**

Run:
```bash
git log --oneline -8
```

Report the 7 commits from this feature plus one baseline, and confirm:
- Typecheck: clean
- Tests: all passing (count before → after)
- Build: successful
- Push: succeeded
- No direct Zoho calls added
- No raw Zoho custom-field parsing
- No Zoho write behavior changed
- `dry_run=false` not set
- No Authentik changes
- No secrets printed or committed

---

## Self-Review

**Spec coverage check:**

| Spec Task | Plan Task |
|-----------|-----------|
| T1: Safety check | Task 1 |
| T2: Change PO list call to `?luma_tablet_only=true` | Task 2 (client tabletOnly option) + Task 4 (po-sync passes it) |
| T3: Trust `app_flags.luma.is_tablet_po`, no raw custom fields | Task 2 (types + helper) + Task 4 (gating logic) |
| T4: `is_tablet_po` stored locally | Task 3 (migration) + Task 4 (upsertPo stores it) |
| T5: Dropdown shows only tablet POs, honest badge | Task 5 |
| T6: Line item behavior intact, anomaly on non-tablet detail | Task 4 (gating receivablePos on isTabletPo) |
| T7: Sync banner tablet-filtered counts | Task 6 |
| T8: 11 tests (all spec points covered) | Task 2 (7 tests) + Task 4 (6 tests) = 13 total |
| T9: Checks, version bump, push, deploy verify | Task 7 |
| T10: Final report | Task 7 Step 8 |

**Placeholder scan:** No TBDs, no "implement later", all steps have exact code.

**Type consistency:**
- `extractIsTabletPo` defined in Task 2, used in Task 4 ✓
- `nonTabletFlagged` added to `PoSyncResult` in Task 4, referenced in Task 6 ✓
- `isTabletPo` in `UpsertPoResult` added and used in Task 4 ✓
- `purchaseOrders.isTabletPo` added in Task 3, used in Task 5 ✓
- `and` imported in Task 5 ✓

**Guardrails verified:**
- No direct Zoho calls — all traffic through Zoho Integration Service via `listInventoryPurchaseOrders` ✓
- No raw Zoho custom fields parsed — only `app_flags.luma.is_tablet_po` (normalized by service) ✓
- No Zoho write behavior — read-only endpoints only ✓
- No `dry_run=false` ✓
- No Authentik changes ✓
- No merge to main ✓
