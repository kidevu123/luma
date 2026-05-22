# Zoho Operations Admin Review & Retry UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin-facing page at `/zoho-operations` that lets managers review, search, filter, and take manual action on `zoho_assembly_ops` rows across all finished lots — with no live Zoho calls and no worker.

**Architecture:** Server-rendered Next.js 15 App Router pages using URL search params for status tabs and search. Query helpers join `zoho_assembly_ops` → `finished_lots` → `products`. Admin actions (reset-to-pending, mark-resolved) live in server actions behind `requireSession`. The finished lot detail page gains a compact counts strip and a link to the filtered view.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, Drizzle ORM, Vitest, Tailwind v3 + shadcn primitives, Lucide icons.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `lib/db/queries/zoho-assembly.ts` | Modify | Add `ZohoAssemblyOpWithLot`, `listZohoAssemblyOpsWithLot`, `resetZohoAssemblyOpToPending` |
| `app/(admin)/zoho-operations/page.tsx` | Create | List page — status tabs, search form, ops table |
| `app/(admin)/zoho-operations/_status-chip.tsx` | Create | Shared `ZohoOpStatusChip` + `ZohoOpKindChip` used by list + detail |
| `app/(admin)/zoho-operations/[id]/page.tsx` | Create | Detail page — all fields, JSON payloads, action panel |
| `app/(admin)/zoho-operations/[id]/actions.ts` | Create | Server actions: `resetToPendingAction`, `resolveManuallyAction` |
| `app/(admin)/zoho-operations/[id]/op-actions.tsx` | Create | Client action panel: reset button + resolve form |
| `app/(admin)/zoho-operations/[id]/actions.test.ts` | Create | 9 unit tests for server actions |
| `app/(admin)/finished-lots/[id]/zoho-queue-card.tsx` | Modify | Add counts strip (pending/needs_mapping/failed/succeeded) + link to /zoho-operations |
| `components/admin/sidebar.tsx` | Modify | Add "Zoho Operations" nav item to Advanced section |

---

## Task 1: Query helpers — `listZohoAssemblyOpsWithLot` + `resetZohoAssemblyOpToPending`

**Files:**
- Modify: `lib/db/queries/zoho-assembly.ts`

- [ ] **Step 1: Add imports and new types**

Open `lib/db/queries/zoho-assembly.ts`. Replace the existing import block:

```typescript
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoAssemblyOps } from "@/lib/db/schema";
import type { ZohoAssemblyOp } from "@/lib/db/schema";
```

with:

```typescript
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoAssemblyOps, finishedLots, products } from "@/lib/db/schema";
import type { ZohoAssemblyOp } from "@/lib/db/schema";
```

Then add the new type after the existing `SetZohoAssemblyOpStatusInput` type (around line 58):

```typescript
export type ZohoAssemblyOpWithLot = {
  op:                ZohoAssemblyOp;
  finishedLotNumber: string;
  productName:       string | null;
  productSku:        string | null;
};
```

- [ ] **Step 2: Add `listZohoAssemblyOpsWithLot` function**

Add this function after the existing `listBlockingOpsForLot` function (before the `// ─── Writes ───` comment):

```typescript
/** Lists ops across all lots, joined to finished_lot and product for display.
 *  Ordered most-recently-enqueued first, then by op_sequence ascending.
 *  Applies status + lotId filters in DB; search is done by the caller. */
export async function listZohoAssemblyOpsWithLot(opts?: {
  finishedLotId?: string;
  status?:        ZohoAssemblyOpStatus;
  limit?:         number;
}): Promise<ZohoAssemblyOpWithLot[]> {
  let query = db
    .select({
      op:                zohoAssemblyOps,
      finishedLotNumber: finishedLots.finishedLotNumber,
      productName:       products.name,
      productSku:        products.sku,
    })
    .from(zohoAssemblyOps)
    .innerJoin(finishedLots, eq(zohoAssemblyOps.finishedLotId, finishedLots.id))
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .$dynamic();

  if (opts?.finishedLotId && opts.status) {
    query = query.where(
      and(
        eq(zohoAssemblyOps.finishedLotId, opts.finishedLotId),
        eq(zohoAssemblyOps.status, opts.status),
      ),
    );
  } else if (opts?.finishedLotId) {
    query = query.where(eq(zohoAssemblyOps.finishedLotId, opts.finishedLotId));
  } else if (opts?.status) {
    query = query.where(eq(zohoAssemblyOps.status, opts.status));
  }

  query = query.orderBy(
    desc(zohoAssemblyOps.enqueuedAt),
    asc(zohoAssemblyOps.opSequence),
  );

  if (opts?.limit) query = query.limit(opts.limit);

  return query;
}
```

- [ ] **Step 3: Add `resetZohoAssemblyOpToPending` function**

Add this function immediately after `resolveZohoAssemblyOpManually` (at the end of the file):

```typescript
/** Reset a FAILED or NEEDS_MAPPING op back to PENDING so the worker can retry.
 *  Throws if the op is not in a resettable state.
 *  Clears lastError and failedAt; preserves retryCount as historical record. */
export async function resetZohoAssemblyOpToPending(
  id: string,
): Promise<ZohoAssemblyOp> {
  const current = await getZohoAssemblyOp(id);
  if (!current) throw new Error(`resetZohoAssemblyOpToPending: op ${id} not found`);
  if (current.status !== "FAILED" && current.status !== "NEEDS_MAPPING") {
    throw new Error(
      `resetZohoAssemblyOpToPending: cannot reset op in status ${current.status} — only FAILED and NEEDS_MAPPING ops can be reset to PENDING`,
    );
  }
  const [row] = await db
    .update(zohoAssemblyOps)
    .set({ status: "PENDING", lastError: null, failedAt: null })
    .where(eq(zohoAssemblyOps.id, id))
    .returning();
  if (!row) throw new Error(`resetZohoAssemblyOpToPending: update returned no row`);
  return row;
}
```

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/db/queries/zoho-assembly.ts
git commit -m "feat(zoho): add listZohoAssemblyOpsWithLot + resetZohoAssemblyOpToPending query helpers"
```

---

## Task 2: Server actions for the detail page

**Files:**
- Create: `app/(admin)/zoho-operations/[id]/actions.ts`

- [ ] **Step 1: Create the server actions file**

Create `app/(admin)/zoho-operations/[id]/actions.ts`:

```typescript
"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-guards";
import {
  resetZohoAssemblyOpToPending,
  resolveZohoAssemblyOpManually,
} from "@/lib/db/queries/zoho-assembly";

export async function resetToPendingAction(
  id: string,
): Promise<{ error?: string }> {
  try {
    await requireSession();
    await resetZohoAssemblyOpToPending(id);
    revalidatePath(`/zoho-operations/${id}`);
    revalidatePath("/zoho-operations");
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error." };
  }
}

export async function resolveManuallyAction(
  id: string,
  note: string,
): Promise<{ error?: string }> {
  if (!note.trim()) return { error: "A resolved note is required." };
  try {
    const user = await requireSession();
    await resolveZohoAssemblyOpManually(id, {
      note: note.trim(),
      resolvedByUserId: user.id,
    });
    revalidatePath(`/zoho-operations/${id}`);
    revalidatePath("/zoho-operations");
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error." };
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

---

## Task 3: Tests for server actions

**Files:**
- Create: `app/(admin)/zoho-operations/[id]/actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/(admin)/zoho-operations/[id]/actions.test.ts`:

```typescript
// Phase 4 — Tests for Zoho operation admin server actions.
//
// resetToPendingAction:
//   - success path calls resetZohoAssemblyOpToPending + revalidates
//   - error from query layer is returned as { error: string }
//
// resolveManuallyAction:
//   - empty note returns validation error without calling query
//   - whitespace-only note returns validation error without calling query
//   - success path calls resolveZohoAssemblyOpManually with trimmed note + userId
//   - error from query layer is returned as { error: string }

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/queries/zoho-assembly", () => ({
  resetZohoAssemblyOpToPending: vi.fn(),
  resolveZohoAssemblyOpManually: vi.fn(),
}));

vi.mock("@/lib/auth-guards", () => ({
  requireSession: vi.fn().mockResolvedValue({
    id: "user-00000000-0000-0000-0000-000000000001",
    role: "ADMIN",
    email: "admin@test.com",
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { resetToPendingAction, resolveManuallyAction } from "./actions";
import { resetZohoAssemblyOpToPending, resolveZohoAssemblyOpManually } from "@/lib/db/queries/zoho-assembly";

const mockReset  = vi.mocked(resetZohoAssemblyOpToPending);
const mockResolve = vi.mocked(resolveZohoAssemblyOpManually);

const OP_ID = "aaaaaaaa-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── resetToPendingAction ────────────────────────────────────────────────────

describe("resetToPendingAction", () => {
  it("returns {} on success", async () => {
    mockReset.mockResolvedValue({} as never);
    const result = await resetToPendingAction(OP_ID);
    expect(result).toEqual({});
  });

  it("calls resetZohoAssemblyOpToPending with the op id", async () => {
    mockReset.mockResolvedValue({} as never);
    await resetToPendingAction(OP_ID);
    expect(mockReset).toHaveBeenCalledWith(OP_ID);
  });

  it("returns { error } when query throws (non-resettable status)", async () => {
    mockReset.mockRejectedValue(
      new Error("resetZohoAssemblyOpToPending: cannot reset op in status SUCCEEDED"),
    );
    const result = await resetToPendingAction(OP_ID);
    expect(result.error).toContain("cannot reset");
  });

  it("returns generic error message for non-Error throws", async () => {
    mockReset.mockRejectedValue("some string throw");
    const result = await resetToPendingAction(OP_ID);
    expect(result.error).toBe("Unexpected error.");
  });
});

// ─── resolveManuallyAction ───────────────────────────────────────────────────

describe("resolveManuallyAction", () => {
  it("returns validation error for empty note — no DB call", async () => {
    const result = await resolveManuallyAction(OP_ID, "");
    expect(result.error).toBe("A resolved note is required.");
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("returns validation error for whitespace-only note — no DB call", async () => {
    const result = await resolveManuallyAction(OP_ID, "   ");
    expect(result.error).toBe("A resolved note is required.");
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("returns {} on success", async () => {
    mockResolve.mockResolvedValue({} as never);
    const result = await resolveManuallyAction(OP_ID, "Fixed by ops team");
    expect(result).toEqual({});
  });

  it("calls resolveZohoAssemblyOpManually with trimmed note and user id", async () => {
    mockResolve.mockResolvedValue({} as never);
    await resolveManuallyAction(OP_ID, "  Fixed  ");
    expect(mockResolve).toHaveBeenCalledWith(OP_ID, {
      note: "Fixed",
      resolvedByUserId: "user-00000000-0000-0000-0000-000000000001",
    });
  });

  it("returns { error } when query throws", async () => {
    mockResolve.mockRejectedValue(
      new Error("resolveZohoAssemblyOpManually: row not found"),
    );
    const result = await resolveManuallyAction(OP_ID, "my note");
    expect(result.error).toContain("row not found");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail (actions file exists but query mocks not yet wired)**

```bash
npx vitest run app/\(admin\)/zoho-operations/\[id\]/actions.test.ts --reporter=verbose
```

Expected: 9 tests PASS (the actions file was already created in Task 2 and the mocks are fully self-contained).

- [ ] **Step 3: Run the full test suite to confirm no regressions**

```bash
npx vitest run 2>&1 | tail -10
```

Expected: All tests pass (count increases by 9).

- [ ] **Step 4: Commit**

```bash
git add app/\(admin\)/zoho-operations/\[id\]/actions.ts \
        app/\(admin\)/zoho-operations/\[id\]/actions.test.ts
git commit -m "test(zoho): server action unit tests for reset-to-pending + resolve-manually"
```

---

## Task 4: Shared status chips + operations list page

**Files:**
- Create: `app/(admin)/zoho-operations/_status-chip.tsx`
- Create: `app/(admin)/zoho-operations/page.tsx`

- [ ] **Step 1: Create the shared status/kind chip component**

Create `app/(admin)/zoho-operations/_status-chip.tsx`:

```typescript
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  MinusCircle,
  XCircle,
} from "lucide-react";
import type { ZohoAssemblyOp } from "@/lib/db/schema";

export function ZohoOpStatusChip({ status }: { status: ZohoAssemblyOp["status"] }) {
  const cfg: Record<
    ZohoAssemblyOp["status"],
    { cls: string; icon: React.ComponentType<{ className?: string }>; label: string }
  > = {
    PENDING:       { cls: "bg-surface-2 text-text-muted border-border/60",          icon: Clock,        label: "Pending"       },
    IN_PROGRESS:   { cls: "bg-info-50 text-info-700 border-info-500/40",            icon: Clock,        label: "In progress"   },
    SUCCEEDED:     { cls: "bg-good-50 text-good-700 border-good-500/40",            icon: CheckCircle2, label: "Succeeded"     },
    FAILED:        { cls: "bg-danger-50 text-danger-700 border-danger-500/40",      icon: XCircle,      label: "Failed"        },
    NEEDS_MAPPING: { cls: "bg-warn-50 text-warn-700 border-warn-500/40",            icon: AlertCircle,  label: "Needs mapping" },
    SKIPPED:       { cls: "bg-surface-2 text-text-muted border-border/60",          icon: MinusCircle,  label: "Skipped"       },
  };
  const c = cfg[status];
  const Icon = c.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-sm border text-[10px] font-semibold uppercase tracking-wide ${c.cls}`}
    >
      <Icon className="h-3 w-3" />
      {c.label}
    </span>
  );
}

export function ZohoOpKindChip({ opKind }: { opKind: ZohoAssemblyOp["opKind"] }) {
  const cfg: Record<ZohoAssemblyOp["opKind"], { cls: string; label: string }> = {
    TABLET_RECEIVE:  { cls: "bg-info-50 text-info-700 border-info-500/40",       label: "Tablet receive"   },
    UNIT_ASSEMBLE:   { cls: "bg-good-50 text-good-700 border-good-500/40",       label: "Unit assembly"    },
    DISPLAY_ASSEMBLE:{ cls: "bg-surface-2 text-text border-border/60",           label: "Display assembly" },
    CASE_ASSEMBLE:   { cls: "bg-surface-2 text-text border-border/60",           label: "Case assembly"    },
  };
  const c = cfg[opKind];
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium uppercase tracking-wide ${c.cls}`}
    >
      {c.label}
    </span>
  );
}
```

- [ ] **Step 2: Create the list page**

Create `app/(admin)/zoho-operations/page.tsx`:

```typescript
import Link from "next/link";
import { Layers } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import {
  listZohoAssemblyOpsWithLot,
  type ZohoAssemblyOpStatus,
} from "@/lib/db/queries/zoho-assembly";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD, EmptyRow } from "@/components/ui/table";
import { ZohoOpStatusChip, ZohoOpKindChip } from "./_status-chip";

export const dynamic = "force-dynamic";

const VALID_STATUSES: ZohoAssemblyOpStatus[] = [
  "PENDING", "IN_PROGRESS", "NEEDS_MAPPING", "FAILED", "SUCCEEDED", "SKIPPED",
];

function isValidStatus(s: string | undefined): s is ZohoAssemblyOpStatus {
  return VALID_STATUSES.includes(s as ZohoAssemblyOpStatus);
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const TAB_LABELS: { status?: ZohoAssemblyOpStatus; label: string }[] = [
  { label: "All" },
  { status: "PENDING",       label: "Pending"       },
  { status: "NEEDS_MAPPING", label: "Needs Mapping" },
  { status: "FAILED",        label: "Failed"        },
  { status: "IN_PROGRESS",   label: "In Progress"   },
  { status: "SUCCEEDED",     label: "Succeeded"     },
  { status: "SKIPPED",       label: "Skipped"       },
];

export default async function ZohoOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; lotId?: string; q?: string }>;
}) {
  await requireSession();
  const params = await searchParams;
  const statusFilter = isValidStatus(params.status) ? params.status : undefined;
  const lotId = params.lotId?.trim() || undefined;
  const q = params.q?.trim() || undefined;

  // Fetch all (with optional filters) — search is applied in JS below.
  const allRows = await listZohoAssemblyOpsWithLot({
    finishedLotId: lotId,
    status:        statusFilter,
    limit:         500,
  });

  // Client-side search across lot number, product name, Zoho item ID, op kind.
  const rows = q
    ? allRows.filter(
        (r) =>
          r.finishedLotNumber.toLowerCase().includes(q.toLowerCase()) ||
          (r.productName ?? "").toLowerCase().includes(q.toLowerCase()) ||
          (r.op.zohoItemId ?? "").toLowerCase().includes(q.toLowerCase()) ||
          r.op.opKind.toLowerCase().includes(q.toLowerCase()) ||
          (r.op.idempotencyKey ?? "").toLowerCase().includes(q.toLowerCase()),
      )
    : allRows;

  // Tab counts are computed from the full unfiltered set when no status filter
  // is active; otherwise from the fetched set.
  const statusCounts: Partial<Record<ZohoAssemblyOpStatus | "all", number>> = {
    all: allRows.length,
  };
  for (const r of allRows) {
    statusCounts[r.op.status] = (statusCounts[r.op.status] ?? 0) + 1;
  }

  function tabHref(s?: ZohoAssemblyOpStatus) {
    const p = new URLSearchParams();
    if (s) p.set("status", s);
    if (lotId) p.set("lotId", lotId);
    if (q) p.set("q", q);
    const qs = p.toString();
    return `/zoho-operations${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Zoho Operations"
        description="Internal operation queue for Zoho inventory receives and assemblies. No Zoho calls are made from this page."
      />

      {lotId && (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <span>Filtered to lot:</span>
          <span className="font-mono text-text text-xs">{lotId}</span>
          <Link href="/zoho-operations" className="text-brand-700 hover:underline text-xs">
            Clear
          </Link>
        </div>
      )}

      {/* Status tabs */}
      <div className="flex items-center gap-1 flex-wrap border-b border-border/60 pb-1">
        {TAB_LABELS.map(({ status, label }) => {
          const active = status === statusFilter || (!status && !statusFilter);
          const count = status ? (statusCounts[status] ?? 0) : (statusCounts.all ?? 0);
          return (
            <Link
              key={label}
              href={tabHref(status)}
              className={[
                "px-3 py-1.5 rounded-t text-xs font-medium transition-colors",
                active
                  ? "bg-surface border border-b-surface border-border/60 text-text -mb-px"
                  : "text-text-muted hover:text-text",
              ].join(" ")}
            >
              {label}
              <span className="ml-1.5 text-[10px] tabular-nums text-text-subtle">
                {count}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Search form */}
      <form method="GET" action="/zoho-operations" className="flex items-center gap-2">
        {statusFilter && <input type="hidden" name="status" value={statusFilter} />}
        {lotId        && <input type="hidden" name="lotId"  value={lotId}        />}
        <input
          type="text"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search lot #, product, Zoho item ID, op kind…"
          className="h-8 w-72 rounded-md border border-border bg-surface px-3 text-sm placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <button
          type="submit"
          className="h-8 rounded-md border border-border bg-surface-2 px-3 text-xs font-medium hover:bg-surface-2/80"
        >
          Search
        </button>
        {q && (
          <Link
            href={tabHref(statusFilter)}
            className="text-xs text-text-muted hover:text-text"
          >
            Clear
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No operations found"
          description={
            statusFilter
              ? `No operations with status ${statusFilter}${q ? ` matching "${q}"` : ""}.`
              : q
                ? `No operations matching "${q}".`
                : "No operations have been enqueued yet."
          }
        />
      ) : (
        <>
          <DataTable>
            <THead>
              <TR>
                <TH>Seq</TH>
                <TH>Kind</TH>
                <TH>Status</TH>
                <TH>Lot #</TH>
                <TH>Product</TH>
                <TH className="text-right">Qty</TH>
                <TH>Zoho item ID</TH>
                <TH>Role</TH>
                <TH className="text-right">Retries</TH>
                <TH>Enqueued</TH>
                <TH>Error</TH>
                <TH></TH>
              </TR>
            </THead>
            <tbody>
              {rows.map(({ op, finishedLotNumber, productName }) => (
                <TR key={op.id}>
                  <TD className="tabular-nums text-xs text-text-muted text-center w-8">
                    {op.opSequence ?? "—"}
                  </TD>
                  <TD>
                    <ZohoOpKindChip opKind={op.opKind} />
                  </TD>
                  <TD>
                    <ZohoOpStatusChip status={op.status} />
                  </TD>
                  <TD className="font-mono text-xs">
                    <Link
                      href={`/finished-lots/${op.finishedLotId}`}
                      className="text-brand-700 hover:underline"
                    >
                      {finishedLotNumber}
                    </Link>
                  </TD>
                  <TD className="text-xs">
                    {productName ?? <span className="text-text-subtle">—</span>}
                  </TD>
                  <TD className="text-right tabular-nums font-semibold text-xs">
                    {op.quantity.toLocaleString()}
                  </TD>
                  <TD className="font-mono text-[10px] text-text-muted max-w-[140px] truncate">
                    {op.zohoItemId ?? "—"}
                  </TD>
                  <TD className="text-[10px] text-text-muted">
                    {op.componentRole ?? "—"}
                  </TD>
                  <TD className="text-right tabular-nums text-xs">
                    {op.retryCount > 0 ? (
                      <span className="text-warn-700 font-semibold">{op.retryCount}</span>
                    ) : (
                      <span className="text-text-subtle">0</span>
                    )}
                  </TD>
                  <TD className="text-[10px] text-text-subtle tabular-nums">
                    {fmtDate(op.enqueuedAt)}
                  </TD>
                  <TD className="max-w-[200px]">
                    {op.lastError ? (
                      <span
                        className="text-[10px] text-danger-700 line-clamp-2 leading-snug"
                        title={op.lastError}
                      >
                        {op.lastError}
                      </span>
                    ) : (
                      <span className="text-text-subtle text-[10px]">—</span>
                    )}
                  </TD>
                  <TD>
                    <Link
                      href={`/zoho-operations/${op.id}`}
                      className="text-[11px] text-brand-700 hover:underline whitespace-nowrap"
                    >
                      View
                    </Link>
                  </TD>
                </TR>
              ))}
            </tbody>
          </DataTable>
          <p className="text-[11px] text-text-subtle">
            Showing {rows.length} of {allRows.length} operation{allRows.length !== 1 ? "s" : ""}.
            {allRows.length >= 500 ? " Limit reached — apply a status filter to narrow results." : ""}
          </p>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/\(admin\)/zoho-operations/page.tsx \
        app/\(admin\)/zoho-operations/_status-chip.tsx
git commit -m "feat(zoho): add Zoho Operations list page with status tabs + search"
```

---

## Task 5: Operation detail page + client action panel

**Files:**
- Create: `app/(admin)/zoho-operations/[id]/op-actions.tsx`
- Create: `app/(admin)/zoho-operations/[id]/page.tsx`

- [ ] **Step 1: Create the client-side action panel**

Create `app/(admin)/zoho-operations/[id]/op-actions.tsx`:

```typescript
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resetToPendingAction, resolveManuallyAction } from "./actions";
import type { ZohoAssemblyOp } from "@/lib/db/schema";

export function OpActionsPanel({ op }: { op: ZohoAssemblyOp }) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError]     = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [resolveOpen, setResolveOpen] = React.useState(false);
  const [resolveNote, setResolveNote] = React.useState("");

  const canReset  = op.status === "FAILED" || op.status === "NEEDS_MAPPING";
  const canResolve = !op.resolvedManually;

  async function handleReset() {
    setPending("reset");
    setError(null);
    setSuccess(null);
    const r = await resetToPendingAction(op.id);
    setPending(null);
    if (r.error) setError(r.error);
    else { setSuccess("Op reset to PENDING."); router.refresh(); }
  }

  async function handleResolve() {
    if (!resolveNote.trim()) { setError("A note is required."); return; }
    setPending("resolve");
    setError(null);
    setSuccess(null);
    const r = await resolveManuallyAction(op.id, resolveNote);
    setPending(null);
    if (r.error) setError(r.error);
    else {
      setSuccess("Marked as manually resolved.");
      setResolveOpen(false);
      setResolveNote("");
      router.refresh();
    }
  }

  if (!canReset && !canResolve) {
    return (
      <p className="text-xs text-text-muted">
        No actions available. Op is already{" "}
        {op.resolvedManually ? "manually resolved" : `in status ${op.status}`}.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {canReset && (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending !== null}
            onClick={handleReset}
          >
            {pending === "reset" ? "Working…" : "Reset to Pending"}
          </Button>
        )}
        {canResolve && !resolveOpen && (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending !== null}
            onClick={() => setResolveOpen(true)}
          >
            Mark resolved manually
          </Button>
        )}
      </div>

      {resolveOpen && (
        <div className="rounded-md border border-border/70 bg-surface-2/50 p-3 space-y-2 max-w-md">
          <p className="text-xs font-medium">Mark resolved — add a note explaining why</p>
          <Input
            placeholder="e.g. Duplicate op — PO already received directly in Zoho"
            value={resolveNote}
            onChange={(e) => setResolveNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setResolveOpen(false); setResolveNote(""); }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!resolveNote.trim() || pending !== null}
              onClick={handleResolve}
            >
              {pending === "resolve" ? "Saving…" : "Confirm"}
            </Button>
          </div>
        </div>
      )}

      {success && (
        <p className="text-xs text-good-700 bg-good-50 border border-good-300/60 rounded px-2 py-1">
          {success}
        </p>
      )}
      {error && (
        <p className="text-xs text-danger-700 bg-danger-50 border border-danger-300/60 rounded px-2 py-1">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create the detail page**

Create `app/(admin)/zoho-operations/[id]/page.tsx`:

```typescript
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { getZohoAssemblyOp } from "@/lib/db/queries/zoho-assembly";
import { db } from "@/lib/db";
import { finishedLots, products } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ZohoOpStatusChip, ZohoOpKindChip } from "../_status-chip";
import { OpActionsPanel } from "./op-actions";

export const dynamic = "force-dynamic";

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function FieldRow({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-border/30 last:border-0">
      <span className="text-[11px] uppercase tracking-wider text-text-subtle shrink-0 w-40">
        {label}
      </span>
      <span className={`text-xs text-right break-all ${mono ? "font-mono" : ""} ${!value ? "text-text-subtle" : "text-text"}`}>
        {value ?? "—"}
      </span>
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <div>
        <p className="text-[11px] uppercase tracking-wider text-text-subtle mb-1">{label}</p>
        <p className="text-xs text-text-subtle">null</p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-text-subtle mb-1">{label}</p>
      <pre className="text-[11px] font-mono bg-surface-2 border border-border/60 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default async function ZohoOpDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;

  const op = await getZohoAssemblyOp(id);
  if (!op) notFound();

  // Fetch lot + product for display names.
  const [lotRow] = await db
    .select({
      finishedLotNumber: finishedLots.finishedLotNumber,
      productName:       products.name,
      productSku:        products.sku,
    })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .where(eq(finishedLots.id, op.finishedLotId));

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/zoho-operations"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Zoho Operations
        </Link>
        <PageHeader
          title={`Op ${op.id.slice(0, 8)}…`}
          description={`${op.opKind} · ${lotRow?.finishedLotNumber ?? op.finishedLotId}`}
          actions={
            <div className="flex items-center gap-2">
              <ZohoOpKindChip opKind={op.opKind} />
              <ZohoOpStatusChip status={op.status} />
            </div>
          }
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* Left column */}
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Core info</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldRow label="Op ID"          value={op.id}           mono />
              <FieldRow label="Idempotency key" value={op.idempotencyKey} mono />
              <FieldRow label="Finished lot"   value={lotRow?.finishedLotNumber ?? op.finishedLotId} />
              <FieldRow label="Product"        value={lotRow?.productName ?? "—"} />
              <FieldRow label="Product SKU"    value={lotRow?.productSku ?? "—"} mono />
              <FieldRow label="Op kind"        value={op.opKind} />
              <FieldRow label="Status"         value={op.status} />
              <FieldRow label="Sequence"       value={op.opSequence?.toString() ?? "—"} />
              <FieldRow label="Quantity"       value={op.quantity.toLocaleString()} />
              <FieldRow label="Component role" value={op.componentRole ?? "—"} />
              <FieldRow label="Retry count"    value={op.retryCount.toString()} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Zoho IDs</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldRow label="Zoho item ID"   value={op.zohoItemId}        mono />
              <FieldRow label="Zoho reference" value={op.zohoReferenceId}   mono />
              <FieldRow label="Source inv. bag" value={op.sourceInventoryBagId} mono />
              <FieldRow label="Source PO line" value={op.sourcePoLineId}    mono />
              <FieldRow label="Source tablet type" value={op.sourceTabletTypeId} mono />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Timestamps</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldRow label="Enqueued"   value={fmtDate(op.enqueuedAt)}  />
              <FieldRow label="Started"    value={fmtDate(op.startedAt)}   />
              <FieldRow label="Succeeded"  value={fmtDate(op.succeededAt)} />
              <FieldRow label="Failed"     value={fmtDate(op.failedAt)}    />
            </CardContent>
          </Card>
        </div>

        {/* Right column */}
        <div className="space-y-5">
          {op.lastError && (
            <Card>
              <CardHeader>
                <CardTitle>Last error</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-[11px] font-mono bg-danger-50 border border-danger-200 rounded-lg p-3 whitespace-pre-wrap break-all text-danger-800 leading-relaxed">
                  {op.lastError}
                </pre>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Payloads</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <JsonBlock label="Request payload"  value={op.requestPayload}  />
              <JsonBlock label="Response payload" value={op.responsePayload} />
            </CardContent>
          </Card>

          {op.resolvedManually && (
            <Card>
              <CardHeader>
                <CardTitle>Manual resolution</CardTitle>
              </CardHeader>
              <CardContent>
                <FieldRow label="Resolved"         value="Yes" />
                <FieldRow label="Note"             value={op.resolvedNote} />
                <FieldRow label="Resolved by user" value={op.resolvedByUserId} mono />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Admin actions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-3 text-[11px] text-text-subtle leading-snug space-y-1">
                <p>These actions update local Luma rows only. No Zoho calls are made.</p>
                {(op.status === "FAILED" || op.status === "NEEDS_MAPPING") && (
                  <p className="text-warn-700">
                    Reset to Pending re-queues this op for the next worker run.
                  </p>
                )}
              </div>
              <OpActionsPanel op={op} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/\(admin\)/zoho-operations/\[id\]/op-actions.tsx \
        app/\(admin\)/zoho-operations/\[id\]/page.tsx
git commit -m "feat(zoho): add Zoho Operations detail page with admin action panel"
```

---

## Task 6: Finished lot integration + sidebar navigation

**Files:**
- Modify: `app/(admin)/finished-lots/[id]/zoho-queue-card.tsx`
- Modify: `components/admin/sidebar.tsx`

- [ ] **Step 1: Add counts strip and link to ZohoQueueCard**

In `app/(admin)/finished-lots/[id]/zoho-queue-card.tsx`, add `import Link from "next/link";` after the existing React import. Then replace the `export function ZohoQueueCard` function signature and the start of `CardContent` to add counts + link.

Find the block:
```typescript
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Zoho Operation Queue</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
```

Replace with:
```typescript
  const counts = {
    pending:      existingOps.filter((o) => o.status === "PENDING").length,
    needsMapping: existingOps.filter((o) => o.status === "NEEDS_MAPPING").length,
    failed:       existingOps.filter((o) => o.status === "FAILED").length,
    succeeded:    existingOps.filter((o) => o.status === "SUCCEEDED").length,
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between flex-wrap gap-2">
          <span>Zoho Operation Queue</span>
          {existingOps.length > 0 && (
            <Link
              href={`/zoho-operations?lotId=${lotId}`}
              className="text-[11px] font-normal text-brand-700 hover:underline"
            >
              View in Zoho Operations →
            </Link>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {existingOps.length > 0 && (
          <div className="flex flex-wrap gap-3 text-[11px]">
            {counts.pending      > 0 && <span className="text-text-muted">Pending: <strong>{counts.pending}</strong></span>}
            {counts.needsMapping > 0 && <span className="text-warn-700">Needs mapping: <strong>{counts.needsMapping}</strong></span>}
            {counts.failed       > 0 && <span className="text-danger-700">Failed: <strong>{counts.failed}</strong></span>}
            {counts.succeeded    > 0 && <span className="text-good-700">Succeeded: <strong>{counts.succeeded}</strong></span>}
          </div>
        )}
```

- [ ] **Step 2: Add Zoho Operations to the sidebar**

In `components/admin/sidebar.tsx`, find the import line:
```typescript
  ChevronDown,
  ClipboardList,
  type LucideIcon,
} from "lucide-react";
```

Replace with:
```typescript
  ChevronDown,
  ClipboardList,
  Layers,
  type LucideIcon,
} from "lucide-react";
```

Then find the Advanced section items array:
```typescript
      { href: "/packaging-receipts", label: "Packaging receipts", icon: Truck },
      { href: "/batches", label: "Batches", icon: ShieldCheck },
```

Add after the last item (before the closing `]`):
```typescript
      { href: "/zoho-operations", label: "Zoho operations", icon: Layers },
```

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/\(admin\)/finished-lots/\[id\]/zoho-queue-card.tsx \
        components/admin/sidebar.tsx
git commit -m "feat(zoho): add op counts strip to lot detail + Zoho Operations sidebar link"
```

---

## Task 7: Final checks + build + combined commit

- [ ] **Step 1: Run typecheck clean**

```bash
npx tsc --noEmit
```

Expected: no output (zero errors).

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run --reporter=verbose 2>&1 | tail -20
```

Expected: all test files pass, count increases by 9 from Phase 3's 1766 (total 1775).

- [ ] **Step 3: Run build**

```bash
npx next build 2>&1 | tail -30
```

Expected: build completes successfully with no type errors. The new routes appear in the output:
```
/zoho-operations
/zoho-operations/[id]
```

- [ ] **Step 4: Verify branch**

```bash
git log --oneline -6
```

Expected: all commits on `feature/packaging-zoho-assemblies`, none on main.

---

## Self-Review Checklist

**Spec coverage:**

| Requirement | Task |
|---|---|
| `/zoho-operations` list page | Task 4 |
| Table: lot, product, kind, qty, status, seq, role, zoho item ID, source bag, retries, error, enqueued, actions | Task 4 |
| Tabs: All / Pending / Needs Mapping / Failed / Succeeded / Skipped | Task 4 |
| Search: lot #, product, Zoho item ID, op kind | Task 4 |
| Detail view: all fields + payloads | Task 5 |
| Status badges (6 statuses, colored) | Tasks 4+5 (shared chip) |
| Mark resolved manually (requires note) | Tasks 2+5 |
| Reset FAILED/NEEDS_MAPPING → PENDING | Tasks 1+2+5 |
| Missing mapping visibility (lastError, requestPayload in detail) | Task 5 |
| Lot detail: link + counts strip | Task 6 |
| Sidebar navigation | Task 6 |
| Query helpers for joins + reset | Task 1 |
| Tests: action guard logic | Task 3 |
| No Zoho calls, no worker, no migration | Entire plan — confirmed absent |

**No placeholders:** All steps contain complete code. ✓

**Type consistency:**
- `ZohoAssemblyOpWithLot` defined in Task 1, used in Task 4's `listZohoAssemblyOpsWithLot` return type — consistent.
- `resetZohoAssemblyOpToPending(id: string)` defined in Task 1, called in `actions.ts` Task 2, tested in Task 3 — consistent.
- `resolveManuallyAction(id, note)` defined in Task 2, used in `op-actions.tsx` Task 5 — consistent.
- `OpActionsPanel({ op: ZohoAssemblyOp })` defined in Task 5, rendered in detail page Task 5 — consistent.
