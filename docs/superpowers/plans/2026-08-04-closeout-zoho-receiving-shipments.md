# Closeout Zoho Truth + Closeout UX + Bag Drawer Fix + Receiving Shipments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PO closeout list reflect Zoho's PO status (Zoho terminal = Closed), fix the closeout detail header/sort/filter, fix the contradictory bag drawer for finalized-awaiting-lot bags, and group the Receives page by real shipment records.

**Architecture:** All verdict logic stays in the existing pure classifier modules (`lib/production/*`) with loaders in `lib/db/queries/*` feeding them; UI pages render verdicts and reuse existing server actions. One additive migration adds raw Zoho status columns to `purchase_orders`. No new mutation endpoints for the drawer (standing rule); the receiving flow gains one shipment create/select action.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Drizzle + Postgres 16, vitest, Tailwind v3.

**Spec:** `docs/superpowers/specs/2026-08-04-closeout-zoho-receiving-shipments-design.md`

## Global Constraints

- Branch: `sandbox/ux-closeout-receiving` — every commit auto-deploys to CT 123 `luma-sandbox` (192.168.1.215) within ~60s.
- Migrations: additive only. Inspect `drizzle/meta/_journal.json` first; last entry is `0068_rba_sessions_allow_negative_ending_balance` (idx 67). Mirror every column in `lib/db/schema.ts`.
- Money/qty integers; times timestamptz; soft-delete only; every mutation writes `audit_log` via `writeAudit`.
- No emoji anywhere (UI uses Lucide icons + chips + text).
- Zoho only via `zoho-integration-service` gateway. `syncPurchaseOrdersFromZoho` is read-only toward Zoho. Never add a Zoho write path.
- Data honesty: never imply missing = zero or synced = confirmed. Raw Zoho status is stored verbatim; absence of `zoho_status` changes no behavior.
- Tests are colocated `*.test.ts` (vitest, `describe`/`it`/`expect`). Run a single file with `npx vitest run <path>`.
- Never push with typecheck (`npm run typecheck`) or lint (`npm run lint`) failing.
- The drawer/guided mode must never grow its own mutation endpoints — reuse specialist actions (`repairAutoIssueFinishedLotAction`, etc.).

---

### Task 1: Migration — `purchase_orders.zoho_status` + `zoho_status_synced_at`

**Files:**
- Modify: `lib/db/schema.ts:540-559` (purchaseOrders table)
- Create: `drizzle/0069_po_zoho_status.sql` (via `npm run db:generate`)

**Interfaces:**
- Produces: `purchaseOrders.zohoStatus` (text, nullable), `purchaseOrders.zohoStatusSyncedAt` (timestamptz, nullable) — consumed by Tasks 2, 4, 5, 6.

- [ ] **Step 1: Add columns to schema**

In `lib/db/schema.ts`, inside the `purchaseOrders` table, after `zohoPoId: text("zoho_po_id"),` add:

```ts
    /** Raw Zoho PO status verbatim (e.g. "issued", "closed", "billed",
     *  "cancelled"). Stored unmapped for data honesty; null = never synced.
     *  The mapped local enum in `status` keeps its own semantics. */
    zohoStatus: text("zoho_status"),
    zohoStatusSyncedAt: timestamp("zoho_status_synced_at", { withTimezone: true }),
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0069_*.sql` containing ONLY two `ALTER TABLE "purchase_orders" ADD COLUMN ...` statements and a new journal entry (idx 68). If drizzle-kit generates anything beyond the two ADD COLUMNs, stop and hand-trim per the additive-only rule.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add lib/db/schema.ts drizzle/
git commit -m "feat(schema): additive purchase_orders.zoho_status + zoho_status_synced_at"
```

---

### Task 2: PO sync stores raw Zoho status; maps closed/billed to CLOSED

**Files:**
- Modify: `lib/zoho/po-sync.ts:66-75` (`mapZohoStatus`) and `:196-284` (`upsertPo`)
- Test: `lib/zoho/po-sync.test.ts`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: every synced PO row gets `zohoStatus` (verbatim) + `zohoStatusSyncedAt` on both insert and update, regardless of the terminal-status guard. `mapZohoStatus("closed") === "CLOSED"`, `mapZohoStatus("billed") === "CLOSED"`.

- [ ] **Step 1: Write the failing tests**

In `lib/zoho/po-sync.test.ts`, add (match the file's existing mock-db pattern — it already tests `syncPurchaseOrdersFromZoho` with injected `dbOverride`/`fetchImpl`; extend the existing helpers rather than inventing new ones):

```ts
describe("mapZohoStatus closed/billed", () => {
  // mapZohoStatus is not exported; test through upsert behavior:
  // a Zoho PO with status "closed" upserts local status CLOSED.
});

describe("raw zoho_status persistence", () => {
  it("stores raw status + synced-at on insert", async () => {
    // Arrange the existing fake list response with one PO, status "closed".
    // Assert the inserted values include:
    //   status: "CLOSED", zohoStatus: "closed", zohoStatusSyncedAt: <Date>
  });

  it("stores raw status + synced-at on update even when local status is terminal", async () => {
    // Existing local row status RECEIVED (terminal), Zoho now says "closed".
    // Assert update payload: no `status` change (guard holds), but
    //   zohoStatus: "closed" and zohoStatusSyncedAt set.
  });
});
```

Write these as real assertions against the file's existing fake-db capture (the test file already captures insert/update payloads — follow its established pattern exactly).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/zoho/po-sync.test.ts`
Expected: new tests FAIL (zohoStatus undefined in payloads; "closed" maps to OPEN).

- [ ] **Step 3: Implement**

In `mapZohoStatus` add before the default:

```ts
    case "closed":             return "CLOSED";
    case "billed":             return "CLOSED";
```

In `upsertPo`:
- Insert branch — add to `.values({...})`:

```ts
        zohoStatus: zohoPo.status,
        zohoStatusSyncedAt: new Date(),
```

- Update branch — add to `updatePayload` (OUTSIDE the `if (!isTerminal)` guard, so terminal rows still record what Zoho says):

```ts
    const updatePayload: Partial<typeof purchaseOrders.$inferInsert> = {
      vendorName: zohoPo.vendor_name,
      openedAt,
      isTabletPo,
      zohoStatus: zohoPo.status,
      zohoStatusSyncedAt: new Date(),
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/zoho/po-sync.test.ts`
Expected: PASS (all pre-existing tests too).

- [ ] **Step 5: Commit**

```bash
git add lib/zoho/po-sync.ts lib/zoho/po-sync.test.ts
git commit -m "feat(zoho): po-sync stores raw zoho_status; maps closed/billed to CLOSED"
```

---

### Task 3: Pure classifier — Zoho terminal forces the Closed bucket

**Files:**
- Modify: `lib/production/po-closeout.ts:351-381`
- Test: `lib/production/po-closeout.test.ts`

**Interfaces:**
- Produces: `isZohoTerminalStatus(raw: string | null | undefined): boolean` (exported) and `PoCloseoutIndexRollup` gains required field `zohoTerminal: boolean`. `classifyPoCloseoutIndexBucket` returns `"CLOSED"` whenever `zohoTerminal` is true. Consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Append to `lib/production/po-closeout.test.ts`:

```ts
describe("isZohoTerminalStatus", () => {
  it("is true for closed/billed/cancelled, case-insensitive", () => {
    expect(isZohoTerminalStatus("closed")).toBe(true);
    expect(isZohoTerminalStatus("Billed")).toBe(true);
    expect(isZohoTerminalStatus("CANCELLED")).toBe(true);
  });
  it("is false for open-ish, unknown, and missing values", () => {
    expect(isZohoTerminalStatus("issued")).toBe(false);
    expect(isZohoTerminalStatus("partially_received")).toBe(false);
    expect(isZohoTerminalStatus("")).toBe(false);
    expect(isZohoTerminalStatus(null)).toBe(false);
    expect(isZohoTerminalStatus(undefined)).toBe(false);
  });
});

describe("classifyPoCloseoutIndexBucket with zohoTerminal", () => {
  const base = { poStatus: "OPEN", receivedBagCount: 5, doneBagCount: 0, zohoBlockerCount: 3 };
  it("Zoho terminal forces CLOSED regardless of open work and blockers", () => {
    expect(classifyPoCloseoutIndexBucket({ ...base, zohoTerminal: true })).toBe("CLOSED");
  });
  it("never-synced PO keeps existing conservative behavior", () => {
    expect(classifyPoCloseoutIndexBucket({ ...base, zohoTerminal: false })).toBe("ACTIVE");
    expect(
      classifyPoCloseoutIndexBucket({
        poStatus: "RECEIVED", receivedBagCount: 2, doneBagCount: 2,
        zohoBlockerCount: 0, zohoTerminal: false,
      }),
    ).toBe("CLOSED");
  });
});
```

Import `isZohoTerminalStatus` in the test file's import block. Also add `zohoTerminal: false` to every existing `classifyPoCloseoutIndexBucket` test input in this file (the field is required).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/po-closeout.test.ts`
Expected: FAIL (`isZohoTerminalStatus` not exported).

- [ ] **Step 3: Implement**

In `lib/production/po-closeout.ts`, above `classifyPoCloseoutIndexBucket`:

```ts
/** Zoho PO statuses that mean the PO is finished on Zoho's side. Raw values
 *  as Zoho sends them; compared case-insensitively. Absence (null) is NOT
 *  terminal — a never-synced PO keeps the conservative local logic. */
const ZOHO_TERMINAL_STATUSES = new Set(["closed", "billed", "cancelled"]);

export function isZohoTerminalStatus(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return ZOHO_TERMINAL_STATUSES.has(raw.trim().toLowerCase());
}
```

Extend the rollup type and classifier:

```ts
export type PoCloseoutIndexRollup = {
  poStatus: string;
  receivedBagCount: number;
  doneBagCount: number;
  zohoBlockerCount: number;
  /** True when purchase_orders.zoho_status is a Zoho terminal state.
   *  Zoho is the source of truth for closeout: terminal → CLOSED. */
  zohoTerminal: boolean;
};

export function classifyPoCloseoutIndexBucket(
  input: PoCloseoutIndexRollup,
): PoCloseoutIndexBucket {
  if (input.zohoTerminal) return "CLOSED";
  if (input.poStatus === "CANCELLED") return "CLOSED";
  if (!CLOSED_ELIGIBLE_PO_STATUSES.has(input.poStatus)) return "ACTIVE";
  if (input.receivedBagCount === 0) return "ACTIVE";
  if (input.doneBagCount < input.receivedBagCount) return "ACTIVE";
  if (input.zohoBlockerCount > 0) return "ACTIVE";
  return "CLOSED";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/production/po-closeout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/production/po-closeout.ts lib/production/po-closeout.test.ts
git commit -m "feat(closeout): zoho terminal status forces Closed bucket (pure classifier)"
```

---

### Task 4: Index rollup query + list UI (Zoho origin chip)

**Files:**
- Modify: `lib/db/queries/po-closeout.ts:456-572` (`CloseoutPoIndexRow`, `listCloseoutPoIndexRollups`)
- Modify: `app/(admin)/po-closeout/page.tsx`

**Interfaces:**
- Consumes: Task 3 (`isZohoTerminalStatus`, `zohoTerminal` field).
- Produces: `CloseoutPoIndexRow` gains `zohoStatus: string | null` and `closedByZohoOverride: boolean` (bucket CLOSED because of Zoho while Luma work remains open).

- [ ] **Step 1: Extend the query**

In `listCloseoutPoIndexRollups`: add `po.zoho_status` to the final SELECT (`po.zoho_status,` after `po.status,`) and to the `Row` type (`zoho_status: string | null;`). Import `isZohoTerminalStatus` from `@/lib/production/po-closeout`. In the mapping:

```ts
  return rows.map((r) => {
    const zohoTerminal = isZohoTerminalStatus(r.zoho_status);
    const bucket = classifyPoCloseoutIndexBucket({
      poStatus: r.status,
      receivedBagCount: Number(r.bag_count ?? 0),
      doneBagCount: Number(r.done_bag_count ?? 0),
      zohoBlockerCount: Number(r.zoho_blocker_count ?? 0),
      zohoTerminal,
    });
    const openBagCount = Math.max(0, Number(r.bag_count ?? 0) - Number(r.done_bag_count ?? 0));
    return {
      id: r.id,
      poNumber: r.po_number,
      vendorName: r.vendor_name,
      status: r.status,
      zohoStatus: r.zoho_status,
      receiveCount: Number(r.receive_count ?? 0),
      bagCount: Number(r.bag_count ?? 0),
      doneBagCount: Number(r.done_bag_count ?? 0),
      openBagCount,
      zohoBlockerCount: Number(r.zoho_blocker_count ?? 0),
      bucket,
      closedByZohoOverride:
        zohoTerminal && (openBagCount > 0 || Number(r.zoho_blocker_count ?? 0) > 0),
    };
  });
```

Add both new fields to `CloseoutPoIndexRow`.

- [ ] **Step 2: List UI chip**

In `app/(admin)/po-closeout/page.tsx`, in the Closeout cell (`<TD>` with the Closed/Active `StatusPill`), render an origin marker for Zoho-driven closes:

```tsx
                <TD>
                  <div className="flex items-center gap-1.5">
                    <StatusPill kind={p.bucket === "CLOSED" ? "ok" : "warn"}>
                      {p.bucket === "CLOSED" ? "Closed" : "Active"}
                    </StatusPill>
                    {p.closedByZohoOverride ? (
                      <span
                        className="inline-flex items-center h-5 px-1.5 rounded border border-sky-300/50 bg-sky-50/80 text-[10px] font-medium text-sky-700"
                        title="Closed because the PO is closed in Zoho; some Luma work was never completed. Open the closeout for details."
                      >
                        Zoho
                      </span>
                    ) : null}
                  </div>
                </TD>
```

Update the page `description` prop to: `"One place to see, per PO, which bags are done and which still need a Luma action. A PO closed in Zoho counts as Closed; the Zoho chip marks closes where Luma work was left open."`

- [ ] **Step 3: Typecheck + full classifier tests**

Run: `npm run typecheck && npx vitest run lib/production/po-closeout.test.ts`
Expected: clean/PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/db/queries/po-closeout.ts "app/(admin)/po-closeout/page.tsx"
git commit -m "feat(closeout): index reads zoho_status; Zoho origin chip on Closed rows"
```

---

### Task 5: Detail page — row suppression + "Closed in Zoho" banner

**Files:**
- Modify: `lib/production/po-closeout.ts:57-105` (input type) and `:329-348` (step 5)
- Modify: `lib/db/queries/po-closeout.ts:110-147` (PO select) and `:357-384` (input assembly), summary type `:56-83`
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx`
- Test: `lib/production/po-closeout.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `PoCloseoutRowInput.poZohoClosed?: boolean`; `PoCloseoutSummary` gains `zohoStatus: string | null`, `closedInZoho: boolean`, `outputsNeverPushed: number`.

- [ ] **Step 1: Write the failing tests**

Using the file's existing `doneRow`-style fixtures, add:

```ts
describe("classifyPoCloseoutRow on a Zoho-closed PO", () => {
  it("READY_TO_QUEUE is suppressed to DONE with an explicit never-pushed reason", () => {
    const v = classifyPoCloseoutRow({ ...releasedReadyToQueueRow, poZohoClosed: true });
    expect(v.status).toBe("DONE");
    expect(v.action).toBe("NONE");
    expect(v.reason).toBe("Closed in Zoho — output was never pushed to Zoho");
  });
  it("NOT_READY and FAILED are suppressed the same way", () => {
    for (const zoho of ["NOT_READY", "FAILED"] as const) {
      const v = classifyPoCloseoutRow({ ...releasedReadyToQueueRow, zoho, poZohoClosed: true });
      expect(v.status).toBe("DONE");
      expect(v.reason).toBe("Closed in Zoho — output was never pushed to Zoho");
    }
  });
  it("does not change pre-release steps (a bag still on the floor stays visible)", () => {
    const v = classifyPoCloseoutRow({ ...inProgressRow, poZohoClosed: true });
    expect(v.status).toBe("NEEDS_REVIEW");
  });
  it("without poZohoClosed nothing changes", () => {
    const v = classifyPoCloseoutRow(releasedReadyToQueueRow);
    expect(v.status).toBe("READY_FOR_ACTION");
  });
});
```

Build `releasedReadyToQueueRow` (released lot, `zoho: "READY_TO_QUEUE"`) and `inProgressRow` (workflow not finalized) from the existing fixtures in the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/po-closeout.test.ts`
Expected: FAIL (suppression not implemented; `poZohoClosed` unknown — typecheck error is the failure here).

- [ ] **Step 3: Implement classifier**

Add to `PoCloseoutRowInput`:

```ts
  /** True when the PO's raw Zoho status is terminal (closed/billed/cancelled).
   *  Pending Zoho output then stops counting as open work (suppress + flag —
   *  the page banner reports how many outputs were never pushed). */
  poZohoClosed?: boolean;
```

In step 5 of `classifyPoCloseoutRow`, before the `switch (input.zoho)`:

```ts
  if (input.poZohoClosed) {
    switch (input.zoho) {
      case "READY_TO_QUEUE":
      case "NOT_READY":
      case "FAILED":
        return done("Closed in Zoho — output was never pushed to Zoho");
      case "QUEUED":
        return done("Closed in Zoho — queued output will not be committed");
      default:
        break; // COMMITTED / NOT_APPLICABLE / UNCLEAR fall through unchanged
    }
  }
```

- [ ] **Step 4: Loader + summary**

In `loadPoCloseout`: select `zohoStatus: purchaseOrders.zohoStatus` in the PO lookup; compute `const closedInZoho = isZohoTerminalStatus(po.zohoStatus);` (import already present after Task 4). Pass `...(closedInZoho ? { poZohoClosed: true } : {})` into each `PoCloseoutRowInput` (spread form keeps `exactOptionalPropertyTypes` happy). Before classification, compute:

```ts
  const outputsNeverPushed = closedInZoho
    ? rowsInputs.filter((i) => i.hasFinishedLot && i.zoho !== "COMMITTED" && i.zoho !== "NOT_APPLICABLE").length
    : 0;
```

(If the loop builds inputs inline, count with a mutable counter inside the loop instead — same predicate.) Add `zohoStatus: po.zohoStatus ?? null`, `closedInZoho`, `outputsNeverPushed` to the returned summary and to `PoCloseoutSummary`. Add the same fields to the zero-bag early return (`zohoStatus`, `closedInZoho` computed the same way, `outputsNeverPushed: 0`).

- [ ] **Step 5: Banner in the detail page**

In `app/(admin)/po-closeout/[poId]/page.tsx`, after the `<PageHeader>` block (below the "Data as of" line), add:

```tsx
      {summary.closedInZoho ? (
        <div className="rounded-lg border border-sky-300/50 bg-sky-50/60 px-4 py-2.5 text-[12px] text-sky-900">
          <span className="font-semibold">Closed in Zoho</span>
          {" — this PO is "}
          <span className="font-mono">{summary.zohoStatus}</span>
          {" on Zoho's side, so it counts as Closed here."}
          {summary.outputsNeverPushed > 0
            ? ` ${summary.outputsNeverPushed} output${summary.outputsNeverPushed === 1 ? " was" : "s were"} never pushed to Zoho; auto-commit skips this PO.`
            : null}
        </div>
      ) : null}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run lib/production/po-closeout.test.ts && npm run typecheck`
Expected: PASS/clean.

- [ ] **Step 7: Commit**

```bash
git add lib/production/po-closeout.ts lib/production/po-closeout.test.ts lib/db/queries/po-closeout.ts "app/(admin)/po-closeout/[poId]/page.tsx"
git commit -m "feat(closeout): suppress+flag pending Zoho output on Zoho-closed POs"
```

---

### Task 6: Auto-commit sweep skips ops on Zoho-closed POs

**Files:**
- Modify: `lib/zoho/auto-commit-sweep.ts`
- Test: `lib/zoho/auto-commit-sweep.test.ts`

**Interfaces:**
- Consumes: Task 1 column; Task 3 `isZohoTerminalStatus`.
- Produces: new `SweepOutcome` value `"skipped_po_zoho_closed"`; new injectable dependency `loadZohoClosedPoOpIds?: (opIds: string[]) => Promise<Set<string>>`.

- [ ] **Step 1: Write the failing test**

In `lib/zoho/auto-commit-sweep.test.ts`, following the file's existing injected-deps pattern (`loadProductionOutputEligible`, `commitProductionOutput` fakes):

```ts
it("skips production-output ops whose PO is closed in Zoho, with outcome skipped_po_zoho_closed", async () => {
  const summary = await runAutoCommitSweep({
    // gates open, as the existing "commits eligible ops" test does
    loadRawBagEligible: async () => [],
    loadProductionOutputEligible: async () => [{ id: "op-1" }, { id: "op-2" }],
    loadZohoClosedPoOpIds: async (ids) => new Set(ids.filter((i) => i === "op-1")),
    commitProductionOutput: commitSpy, // must be called ONLY for op-2
    // ...same env/productionOutputCallable plumbing the neighboring tests use
  });
  expect(summary.totals.skipped_po_zoho_closed).toBe(1);
  const skipped = summary.rows.find((r) => r.opId === "op-1");
  expect(skipped?.outcome).toBe("skipped_po_zoho_closed");
  expect(skipped?.detail).toBe("PO is closed in Zoho — output intentionally not pushed");
  expect(commitSpy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/zoho/auto-commit-sweep.test.ts`
Expected: FAIL (unknown dependency/outcome).

- [ ] **Step 3: Implement**

- Add `"skipped_po_zoho_closed"` to `SweepOutcome` and to the totals initialization (find where `totals` is zero-initialized per outcome and add the key).
- Add to `AutoCommitSweepDependencies`:

```ts
  /** Returns the subset of production-output op ids whose PO is in a Zoho
   *  terminal state (closed/billed/cancelled). Those ops are skipped —
   *  pushing output to a closed Zoho PO fails on Zoho's side. */
  loadZohoClosedPoOpIds?: (opIds: string[]) => Promise<Set<string>>;
```

- Default implementation (module scope, near the default eligibility loaders), joining op → finished_lot → workflow_bag → inventory_bag → small_box → receive → purchase_order:

```ts
async function defaultLoadZohoClosedPoOpIds(opIds: string[]): Promise<Set<string>> {
  if (opIds.length === 0) return new Set();
  const rows = await db.execute<{ id: string }>(sql`
    SELECT op.id
    FROM zoho_production_output_ops op
    JOIN finished_lots fl ON fl.id = op.finished_lot_id
    JOIN workflow_bags wb ON wb.id = fl.workflow_bag_id
    JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    JOIN small_boxes sb ON sb.id = ib.small_box_id
    JOIN receives r ON r.id = sb.receive_id
    JOIN purchase_orders po ON po.id = r.po_id
    WHERE op.id IN ${opIds}
      AND LOWER(TRIM(po.zoho_status)) IN ('closed', 'billed', 'cancelled')
  `);
  return new Set(Array.from(rows).map((r) => r.id));
}
```

(Use the same drizzle `sql`/`inArray` idiom the file already uses for its default loaders — if `IN ${opIds}` needs `sql.join`/`inArray`, mirror the existing eligibility query style.)

- In the production-output section of `runAutoCommitSweep`, after loading eligible ops and before committing, partition:

```ts
  const zohoClosedOpIds = await (deps.loadZohoClosedPoOpIds ?? defaultLoadZohoClosedPoOpIds)(
    productionOutputEligible.map((o) => o.id),
  );
```

and for each op, before calling the commit fn:

```ts
    if (zohoClosedOpIds.has(op.id)) {
      record({
        surface: "production_output",
        opId: op.id,
        outcome: "skipped_po_zoho_closed",
        detail: "PO is closed in Zoho — output intentionally not pushed",
      });
      continue;
    }
```

(`record` = however the loop currently appends `SweepRowResult`s and bumps totals — reuse it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/zoho/auto-commit-sweep.test.ts`
Expected: PASS including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add lib/zoho/auto-commit-sweep.ts lib/zoho/auto-commit-sweep.test.ts
git commit -m "feat(zoho): auto-commit sweep skips ops on Zoho-closed POs (suppress+flag)"
```

---

### Task 7: Hourly sync timer + "Refresh from Zoho" on the closeout list

**Files:**
- Modify: `deploy/luma-zoho-po-sync.timer`
- Create: `app/(admin)/po-closeout/refresh-zoho-button.tsx`
- Modify: `app/(admin)/po-closeout/page.tsx`

**Interfaces:**
- Consumes: existing `syncPurchaseOrdersFromZohoAction` from `app/(admin)/receiving/raw-bags/actions.ts` (admin-gated server action wrapping the read-only gateway sync) — verify its guard is `requireAdmin`/`requireLead` before reuse; it is NOT a new endpoint.

- [ ] **Step 1: Timer to hourly**

Replace the `[Timer]` section of `deploy/luma-zoho-po-sync.timer` with:

```ini
[Timer]
# Hourly at :59 on the LXC host clock (America/New_York; see
# deploy/README-zoho-po-sync.md). Keeps the closeout page's Zoho
# status at most an hour stale; the UI also has a manual refresh.
OnCalendar=*-*-* *:59:00
Persistent=true
AccuracySec=1min
Unit=luma-zoho-po-sync.service
```

Update the `[Unit] Description=` line to `Hourly Luma Zoho purchase-order sync`. Note in the commit body: the timer unit is installed on prod LXC 122 manually at rollout (`cp deploy/luma-zoho-po-sync.timer /etc/systemd/system/ && systemctl daemon-reload && systemctl restart luma-zoho-po-sync.timer`); the sandbox keeps its Zoho timers disabled.

- [ ] **Step 2: Refresh button component**

Create `app/(admin)/po-closeout/refresh-zoho-button.tsx` modeled directly on `app/(admin)/receiving/raw-bags/sync-po-button.tsx` (same `useTransition` + error handling, single in-flight guard via `disabled={isPending}`), with the label `Refresh from Zoho` and the compact result line reduced to `Synced N POs · M errors`. Import and call the SAME `syncPurchaseOrdersFromZohoAction`:

```tsx
import { syncPurchaseOrdersFromZohoAction } from "../receiving/raw-bags/actions";
```

After a successful sync call `router.refresh()` (`useRouter` from `next/navigation`) so the rollup re-queries.

- [ ] **Step 3: Mount it**

In `app/(admin)/po-closeout/page.tsx`, pass it via `PageHeader`'s `actions` prop:

```tsx
      <PageHeader
        title="PO closeout"
        description="..."
        actions={<RefreshZohoButton />}
      />
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add deploy/luma-zoho-po-sync.timer "app/(admin)/po-closeout/refresh-zoho-button.tsx" "app/(admin)/po-closeout/page.tsx"
git commit -m "feat(closeout): hourly zoho-po-sync timer + manual Refresh from Zoho button"
```

---

### Task 8: Header fix — "PO PO-00206" becomes "PO-00206"

**Files:**
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx:190`

- [ ] **Step 1: Fix the title**

```tsx
          title={`${summary.poNumber} — closeout`}
```

(`poNumber` already carries the "PO-" prefix from Zoho.)

- [ ] **Step 2: Check the structural test**

Run: `npx vitest run "app/(admin)/po-closeout/po-closeout-structural.test.ts"`
Expected: PASS (if it asserts the old title string, update the assertion to the new template).

- [ ] **Step 3: Commit**

```bash
git add "app/(admin)/po-closeout/[poId]/page.tsx" "app/(admin)/po-closeout/po-closeout-structural.test.ts"
git commit -m "fix(closeout): drop duplicated PO prefix in detail header"
```

---

### Task 9: Pure sort/filter helpers for closeout rows

**Files:**
- Create: `lib/production/closeout-row-sort.ts`
- Test: `lib/production/closeout-row-sort.test.ts`

**Interfaces:**
- Produces (consumed by Task 10):

```ts
export type CloseoutSortKey = "receipt" | "tablet" | "started" | "completed";
export type CloseoutSortDir = "asc" | "desc";
export type SortableCloseoutRow = {
  receiptNumber: string | null;
  tabletName: string | null;
  startedAt: Date | null;
  finalizedAt: Date | null;
};
export function sortCloseoutRows<T extends SortableCloseoutRow>(rows: T[], key: CloseoutSortKey, dir: CloseoutSortDir): T[];
export function listDistinctTablets(rows: Array<{ tabletName: string | null }>): string[];
export function filterRowsByTablet<T extends { tabletName: string | null }>(rows: T[], tablet: string | null): T[];
```

- [ ] **Step 1: Write the failing tests**

Create `lib/production/closeout-row-sort.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sortCloseoutRows, listDistinctTablets, filterRowsByTablet } from "./closeout-row-sort";

const rows = [
  { receiptNumber: "R-2", tabletName: "Spearmint", startedAt: new Date("2026-06-02"), finalizedAt: null },
  { receiptNumber: "R-1", tabletName: "BlueRaz", startedAt: new Date("2026-06-03"), finalizedAt: new Date("2026-06-04") },
  { receiptNumber: null, tabletName: null, startedAt: null, finalizedAt: null },
];

describe("sortCloseoutRows", () => {
  it("sorts by receipt asc with nulls last, stable", () => {
    const out = sortCloseoutRows(rows, "receipt", "asc");
    expect(out.map((r) => r.receiptNumber)).toEqual(["R-1", "R-2", null]);
  });
  it("sorts by started desc with nulls last", () => {
    const out = sortCloseoutRows(rows, "started", "desc");
    expect(out.map((r) => r.receiptNumber)).toEqual(["R-1", "R-2", null]);
  });
  it("sorts by completed asc: dated rows first, null completions last", () => {
    const out = sortCloseoutRows(rows, "completed", "asc");
    expect(out[0]!.receiptNumber).toBe("R-1");
  });
  it("does not mutate the input array", () => {
    const copy = [...rows];
    sortCloseoutRows(rows, "tablet", "asc");
    expect(rows).toEqual(copy);
  });
});

describe("tablet filter", () => {
  it("lists distinct tablets alphabetically, skipping null", () => {
    expect(listDistinctTablets(rows)).toEqual(["BlueRaz", "Spearmint"]);
  });
  it("filters by exact tablet name; null filter returns all", () => {
    expect(filterRowsByTablet(rows, "BlueRaz")).toHaveLength(1);
    expect(filterRowsByTablet(rows, null)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/closeout-row-sort.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// CLOSEOUT-SORT-1 — pure sort/filter helpers for the PO closeout bag table.
// Nulls always sort last regardless of direction; sorting is stable and
// non-mutating so the page can apply it to server-loaded rows.

export type CloseoutSortKey = "receipt" | "tablet" | "started" | "completed";
export type CloseoutSortDir = "asc" | "desc";

export type SortableCloseoutRow = {
  receiptNumber: string | null;
  tabletName: string | null;
  startedAt: Date | null;
  finalizedAt: Date | null;
};

function compareNullable<V>(
  a: V | null,
  b: V | null,
  cmp: (x: V, y: V) => number,
  dir: CloseoutSortDir,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // nulls last in both directions
  if (b == null) return -1;
  const c = cmp(a, b);
  return dir === "asc" ? c : -c;
}

export function sortCloseoutRows<T extends SortableCloseoutRow>(
  rows: T[],
  key: CloseoutSortKey,
  dir: CloseoutSortDir,
): T[] {
  const out = [...rows];
  const byString = (x: string, y: string) => x.localeCompare(y);
  const byDate = (x: Date, y: Date) => x.getTime() - y.getTime();
  out.sort((a, b) => {
    switch (key) {
      case "receipt": return compareNullable(a.receiptNumber, b.receiptNumber, byString, dir);
      case "tablet": return compareNullable(a.tabletName, b.tabletName, byString, dir);
      case "started": return compareNullable(a.startedAt, b.startedAt, byDate, dir);
      case "completed": return compareNullable(a.finalizedAt, b.finalizedAt, byDate, dir);
    }
  });
  return out;
}

export function listDistinctTablets(rows: Array<{ tabletName: string | null }>): string[] {
  return [...new Set(rows.map((r) => r.tabletName).filter((t): t is string => t != null))].sort(
    (a, b) => a.localeCompare(b),
  );
}

export function filterRowsByTablet<T extends { tabletName: string | null }>(
  rows: T[],
  tablet: string | null,
): T[] {
  if (tablet == null || tablet === "") return rows;
  return rows.filter((r) => r.tabletName === tablet);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/production/closeout-row-sort.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/production/closeout-row-sort.ts lib/production/closeout-row-sort.test.ts
git commit -m "feat(closeout): pure sort/filter helpers for the bag table"
```

---

### Task 10: Wire sort + tablet filter into the detail page

**Files:**
- Modify: `lib/db/queries/po-closeout.ts:41-54` (`PoCloseoutRow`) and `:387-401` (row push)
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx`

**Interfaces:**
- Consumes: Task 9 helpers.
- Produces: `PoCloseoutRow` gains `startedAt: Date | null` and `finalizedAt: Date | null` (the loader already selects `workflowBags.startedAt`/`finalizedAt` at lines 170-180).

- [ ] **Step 1: Expose the dates**

In `PoCloseoutRow` add `startedAt: Date | null; finalizedAt: Date | null;`. In the `rows.push({...})` block add `startedAt: wf?.startedAt ?? null, finalizedAt: wf?.finalizedAt ?? null,`.

- [ ] **Step 2: Read search params and apply**

In the detail page: extend the `searchParams` type with `sort?: string; dir?: string; tablet?: string`, then after the `shown` filter chain:

```ts
  const sortKey = (["receipt", "tablet", "started", "completed"] as const).find((k) => k === rawSort) ?? "receipt";
  const sortDir: CloseoutSortDir = rawDir === "desc" ? "desc" : "asc";
  const tablet = rawTablet && rawTablet.length > 0 ? rawTablet : null;
  const tablets = listDistinctTablets(summary.rows);
  const visible = sortCloseoutRows(filterRowsByTablet(shown, tablet), sortKey, sortDir);
```

Pass `visible` (not `shown`) to `<CloseoutRows>`. All existing filter links must preserve the new params and vice versa — build a small helper in the page:

```ts
  const qs = (over: Partial<Record<"filter" | "show" | "sort" | "dir" | "tablet", string>>) => {
    const p = new URLSearchParams({ filter, show, sort: sortKey, dir: sortDir, ...(tablet ? { tablet } : {}), ...over });
    return `/po-closeout/${poId}?${p.toString()}`;
  };
```

and switch the existing `FILTERS`/`SHOW_FILTERS` link `href`s to `qs({ filter: f.key })` / `qs({ show: f.key })`.

- [ ] **Step 3: Sort + tablet chip rows**

Below the production-data filter row add two link rows in the same chip idiom as `SHOW_FILTERS` (small `rounded-full border` links):

- Sort row: label `Sort:` then four links — `Bag/receipt`, `Tablet`, `Date started`, `Date completed` — each `href={qs({ sort: key, dir: sortKey === key && sortDir === "asc" ? "desc" : "asc" })}`; the active one shows `↑`/`↓` — NO, no arrows via emoji/unicode ambiguity: render the Lucide `ArrowUp`/`ArrowDown` icon (h-3 w-3) beside the active label instead.
- Tablet row (render only when `tablets.length > 1`): `All tablets` link (`qs({ tablet: "" })`) plus one chip per name (`qs({ tablet: name })`), active chip styled like active SHOW filter.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx vitest run "app/(admin)/po-closeout/po-closeout-structural.test.ts"`
Expected: clean/PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/queries/po-closeout.ts "app/(admin)/po-closeout/[poId]/page.tsx"
git commit -m "feat(closeout): bag table sort (receipt/tablet/started/completed) + tablet filter"
```

---

### Task 11: Classifier — finalized + no open allocation + derivable balances = "Issue finished lot"

**Files:**
- Modify: `lib/production/po-closeout.ts:22-33` (action union), `:91-98` (autoIssue input), `:285-303` (step 3)
- Modify: `lib/db/queries/po-closeout.ts:324-343` (autoIssue assembly)
- Test: `lib/production/po-closeout.test.ts`

**Interfaces:**
- Consumes: `assertAutoLotRepairAllowed` from `lib/production/auto-lot-backlog-eligibility.ts` (already exported; permits `MISSING_ALLOCATION_SESSION` when consumed qty > 0 and ending balance is derivable).
- Produces: new `PoCloseoutAction` member `"ISSUE_FINISHED_LOT"`; `PoCloseoutRowInput.autoIssue` gains `code: string` and `repairIssueReady: boolean`. Consumed by Task 12.

- [ ] **Step 1: Write the failing tests**

```ts
describe("finalized awaiting lot, no open allocation session", () => {
  const finalizedNoLot: PoCloseoutRowInput = {
    // ...existing finalized-no-lot fixture from this file, with:
    autoIssue: {
      autoIssuable: false,
      action: "REPAIR_ALLOCATION",
      code: "MISSING_ALLOCATION_SESSION",
      repairIssueReady: true,
      label: "Missing allocation session",
      nextStep: "Repair allocation",
    },
    rebaseAvailable: false,
  };

  it("derivable balances → READY_FOR_ACTION Issue finished lot (bug 352283)", () => {
    const v = classifyPoCloseoutRow(finalizedNoLot);
    expect(v.status).toBe("READY_FOR_ACTION");
    expect(v.action).toBe("ISSUE_FINISHED_LOT");
    expect(v.actionLabel).toBe("Issue finished lot");
  });

  it("underivable balances → NEEDS_REVIEW manual, NOT the partial path", () => {
    const v = classifyPoCloseoutRow({
      ...finalizedNoLot,
      autoIssue: { ...finalizedNoLot.autoIssue!, repairIssueReady: false },
    });
    expect(v.status).toBe("NEEDS_REVIEW");
    expect(v.action).toBe("REVIEW_MANUALLY");
  });

  it("open session missing starting balance keeps the partial path", () => {
    const v = classifyPoCloseoutRow({
      ...finalizedNoLot,
      autoIssue: {
        ...finalizedNoLot.autoIssue!,
        code: "MISSING_STARTING_BALANCE",
        repairIssueReady: false,
      },
    });
    expect(v.action).toBe("RECORD_REMAINING_OR_CLOSE_PARTIAL");
  });
});
```

Also add `code` + `repairIssueReady` to every existing fixture in the file that sets `autoIssue` (the fields are required on the autoIssue object; use `code: "READY_TO_AUTO_ISSUE", repairIssueReady: true` for auto-issuable fixtures and `code: "MANUAL_REVIEW_REQUIRED", repairIssueReady: false` for review fixtures unless the test says otherwise).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/po-closeout.test.ts`
Expected: FAIL (type errors on `code`/`repairIssueReady`; action missing).

- [ ] **Step 3: Implement classifier**

- Add `| "ISSUE_FINISHED_LOT"` to `PoCloseoutAction` (after `"AUTO_ISSUE_FINISHED_LOT"`).
- Extend the `autoIssue` member of `PoCloseoutRowInput`:

```ts
  autoIssue:
    | {
        autoIssuable: boolean;
        action: "AUTO_ISSUE_NOW" | "REPAIR_ALLOCATION" | "FIX_PRODUCT_SETUP" | "REVIEW_MANUALLY" | "NONE";
        /** Raw AutoLotBacklogBlockerCode from the evaluator. */
        code: string;
        /** assertAutoLotRepairAllowed(evaluation).ok — the existing
         *  repair-issue service can complete this bag in one call. */
        repairIssueReady: boolean;
        label: string;
        nextStep: string;
      }
    | null;
```

- Replace the `REPAIR_ALLOCATION` branch in step 3:

```ts
    if (ai?.action === "REPAIR_ALLOCATION") {
      if (ai.code === "MISSING_ALLOCATION_SESSION") {
        // No open allocation session exists. The partial-resolution panel has
        // nothing to resolve — the truthful next step is issuing the lot via
        // the existing repair-issue service (which records the allocation as
        // part of the issue), or manual review when balances are underivable.
        if (ai.repairIssueReady) {
          return verdict(
            "READY_FOR_ACTION",
            "Finalized — awaiting lot; balances derivable from production output",
            "ISSUE_FINISHED_LOT",
            "Issue finished lot",
          );
        }
        return verdict(
          "NEEDS_REVIEW",
          "Finalized — no allocation session and balances cannot be derived",
          "REVIEW_MANUALLY",
          "Review manually",
        );
      }
      if (input.rebaseAvailable) {
        return verdict("READY_FOR_ACTION", "Split/partial bag: starting balance can be corrected", "CORRECT_STARTING_BALANCE", "Correct starting balance");
      }
      return verdict("NEEDS_REVIEW", ai.nextStep || "Split/partial bag needs a remaining balance", "RECORD_REMAINING_OR_CLOSE_PARTIAL", "Record remaining / close partial");
    }
```

- [ ] **Step 4: Loader wiring**

In `lib/db/queries/po-closeout.ts`, import `assertAutoLotRepairAllowed` from `@/lib/production/auto-lot-backlog-eligibility` and extend the assembly at lines 330-335:

```ts
          autoIssue = {
            autoIssuable: backlog.evaluation.autoIssuable,
            action: backlog.evaluation.action,
            code: backlog.evaluation.code,
            repairIssueReady: assertAutoLotRepairAllowed(backlog.evaluation).ok,
            label: backlog.evaluation.label,
            nextStep: backlog.evaluation.nextStep,
          };
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run lib/production/po-closeout.test.ts && npm run typecheck`
Expected: PASS/clean. Typecheck will flag every other consumer of the action union that must now handle `ISSUE_FINISHED_LOT` — that is Task 12; if the compiler forces it now, do Task 12's mappings in the same commit.

- [ ] **Step 6: Commit**

```bash
git add lib/production/po-closeout.ts lib/production/po-closeout.test.ts lib/db/queries/po-closeout.ts
git commit -m "fix(closeout): finalized bags without open allocation get Issue finished lot, not the partial path"
```

---

### Task 12: Drawer / guided / link mappings for the new action

**Files:**
- Modify: `lib/production/bag-closeout-actions.ts:38-74`
- Modify: `lib/production/guided-closeout.ts:40-59`
- Modify: `app/(admin)/po-closeout/_drawer/closeout-rows.tsx:28-51, 81-88`
- Test: `lib/production/bag-closeout-actions.test.ts`

**Interfaces:**
- Consumes: Task 11 (`ISSUE_FINISHED_LOT`).
- Produces: `deriveApplicableBagActions` maps `ISSUE_FINISHED_LOT` → `ISSUE_LOT` (the existing `LotActions mode="ISSUE"` panel already calls `repairAutoIssueFinishedLotAction`, which handles the allocation repair inside the transaction — no new endpoint). `RECORD_REMAINING_OR_CLOSE_PARTIAL` only opens the partial panel when an allocation session is actually open.

- [ ] **Step 1: Write the failing tests**

In `lib/production/bag-closeout-actions.test.ts` (follow the existing call shape):

```ts
it("ISSUE_FINISHED_LOT maps to the issue-lot panel", () => {
  const actions = deriveApplicableBagActions({
    rowStatus: "READY_FOR_ACTION",
    rowAction: "ISSUE_FINISHED_LOT",
    zoho: "NOT_APPLICABLE",
    hasWorkflow: true,
    hasFinishedLot: false,
    lotStatus: null,
    allocationOpen: false,
  });
  expect(actions).toContain("ISSUE_LOT");
  expect(actions).not.toContain("RESOLVE_PARTIAL");
});

it("RECORD_REMAINING_OR_CLOSE_PARTIAL without an open session shows no partial panel", () => {
  const actions = deriveApplicableBagActions({
    rowStatus: "NEEDS_REVIEW",
    rowAction: "RECORD_REMAINING_OR_CLOSE_PARTIAL",
    zoho: "NOT_APPLICABLE",
    hasWorkflow: true,
    hasFinishedLot: false,
    lotStatus: null,
    allocationOpen: false,
  });
  expect(actions).not.toContain("RESOLVE_PARTIAL");
});

it("RECORD_REMAINING_OR_CLOSE_PARTIAL with an open session keeps the partial panel", () => {
  const actions = deriveApplicableBagActions({
    rowStatus: "NEEDS_REVIEW",
    rowAction: "RECORD_REMAINING_OR_CLOSE_PARTIAL",
    zoho: "NOT_APPLICABLE",
    hasWorkflow: true,
    hasFinishedLot: false,
    lotStatus: null,
    allocationOpen: true,
  });
  expect(actions).toContain("RESOLVE_PARTIAL");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/bag-closeout-actions.test.ts`
Expected: first and second FAIL.

- [ ] **Step 3: Implement the gate**

In `deriveApplicableBagActions`'s switch:

```ts
    case "AUTO_ISSUE_FINISHED_LOT":
    case "ISSUE_FINISHED_LOT":
      actions.push("ISSUE_LOT");
      break;
    case "CORRECT_STARTING_BALANCE":
      actions.push("RESOLVE_PARTIAL");
      break;
    case "RECORD_REMAINING_OR_CLOSE_PARTIAL":
      // The partial panel resolves an OPEN allocation session; without one
      // it has nothing to act on (renders a contradictory dead-end).
      if (input.allocationOpen) actions.push("RESOLVE_PARTIAL");
      break;
```

(The later `allocationOpen && !hasFinishedLot` fallback block stays as-is.)

- [ ] **Step 4: Guided phase + row link + column header**

- `lib/production/guided-closeout.ts` `phaseForAction`: add `case "ISSUE_FINISHED_LOT":` alongside `AUTO_ISSUE_FINISHED_LOT` (returns `"LOT"`).
- `closeout-rows.tsx` `rowLink`: add

```ts
    case "ISSUE_FINISHED_LOT":
      return { href: "/packaging-output", label: "Production output" };
```

- `closeout-rows.tsx` header row: change the empty last `<TH>{" "}</TH>` — no; the mislabeled column is the LINK column rendered per-row (it currently shows "Partial Bag Workbench" as link text). Change the last header cell `<TH>{" "}</TH>` to `<TH>Go to</TH>` so the column reads as navigation, and leave per-row labels as the destination names (`Production output`, `Partial Bag Workbench`, `Open lot`, ...). With Task 11, bags without an open session no longer link to the workbench at all.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run lib/production/bag-closeout-actions.test.ts lib/production/guided-closeout.test.ts && npm run typecheck`
(Adjust the guided test filename if it differs — run `npx vitest run lib/production` if unsure.)
Expected: PASS/clean.

- [ ] **Step 6: Commit**

```bash
git add lib/production/bag-closeout-actions.ts lib/production/bag-closeout-actions.test.ts lib/production/guided-closeout.ts "app/(admin)/po-closeout/_drawer/closeout-rows.tsx"
git commit -m "fix(closeout): drawer/guided/link agree on Issue finished lot; partial panel needs an open session"
```

---

### Task 13: Shipment queries + create action

**Files:**
- Create: `lib/db/queries/shipments.ts`
- Modify: `app/(admin)/receiving/raw-bags/actions.ts`

**Interfaces:**
- Consumes: existing `shipments` table (`lib/db/schema.ts:579-602`) — no schema change.
- Produces:

```ts
export type PoShipmentOption = {
  id: string;
  carrier: string | null;
  trackingNumber: string | null;
  receiveCount: number;
  firstReceivedAt: Date | null;
  label: string; // "Shipment 1 — FedEx 7712... (2 receives)" style
};
export async function listShipmentsForPo(poId: string): Promise<PoShipmentOption[]>;
export async function createShipmentForPo(args: { poId: string; carrier?: string | null; trackingNumber?: string | null }, actor: CurrentUser): Promise<{ id: string }>;
// server action (same file as the other intake actions):
export async function createShipmentAction(input: { poId: string; carrier?: string; trackingNumber?: string }): Promise<{ ok: true; shipmentId: string } | { ok: false; error: string }>;
```

- [ ] **Step 1: Implement `lib/db/queries/shipments.ts`**

```ts
// SHIPMENT-INTAKE-1 — shipment records for tablet receiving. A shipment
// groups the per-flavor receives of one physical delivery. Legacy receives
// (shipment_id null) are untouched; the UI shows them as "Earlier receives".

import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { shipments } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";

export type PoShipmentOption = {
  id: string;
  carrier: string | null;
  trackingNumber: string | null;
  receiveCount: number;
  firstReceivedAt: Date | null;
  label: string;
};

export async function listShipmentsForPo(poId: string): Promise<PoShipmentOption[]> {
  const rows = await db
    .select({
      id: shipments.id,
      carrier: shipments.carrier,
      trackingNumber: shipments.trackingNumber,
      receiveCount: sql<number>`(
        SELECT COUNT(*)::int FROM receives r WHERE r.shipment_id = ${shipments.id}
      )`,
      firstReceivedAt: sql<Date | null>`(
        SELECT MIN(r.received_at) FROM receives r WHERE r.shipment_id = ${shipments.id}
      )`,
    })
    .from(shipments)
    .where(eq(shipments.poId, poId))
    .orderBy(asc(sql`(SELECT MIN(r.received_at) FROM receives r WHERE r.shipment_id = ${shipments.id})`), asc(shipments.id));

  return rows.map((r, i) => ({
    ...r,
    firstReceivedAt: r.firstReceivedAt ? new Date(r.firstReceivedAt) : null,
    label: buildShipmentLabel({ index: i, carrier: r.carrier, trackingNumber: r.trackingNumber, receiveCount: r.receiveCount }),
  }));
}

/** Pure; exported for tests. "Shipment 2 — FedEx 771234 (3 receives)". */
export function buildShipmentLabel(args: {
  index: number;
  carrier: string | null;
  trackingNumber: string | null;
  receiveCount: number;
}): string {
  const base = `Shipment ${args.index + 1}`;
  const meta = [args.carrier, args.trackingNumber].filter(Boolean).join(" ");
  const receives = `${args.receiveCount} ${args.receiveCount === 1 ? "receive" : "receives"}`;
  return meta ? `${base} — ${meta} (${receives})` : `${base} (${receives})`;
}

export async function createShipmentForPo(
  args: { poId: string; carrier?: string | null; trackingNumber?: string | null },
  actor: CurrentUser,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(shipments)
    .values({
      poId: args.poId,
      carrier: args.carrier?.trim() || null,
      trackingNumber: args.trackingNumber?.trim() || null,
    })
    .returning({ id: shipments.id });
  if (!row) throw new Error("createShipmentForPo: insert empty");
  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "shipment.create",
    targetType: "Shipment",
    targetId: row.id,
    after: { po_id: args.poId, carrier: args.carrier ?? null, tracking_number: args.trackingNumber ?? null },
  });
  return row;
}
```

- [ ] **Step 2: Label unit test**

Create `lib/db/queries/shipments.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildShipmentLabel } from "./shipments";

describe("buildShipmentLabel", () => {
  it("bare shipment", () => {
    expect(buildShipmentLabel({ index: 0, carrier: null, trackingNumber: null, receiveCount: 1 }))
      .toBe("Shipment 1 (1 receive)");
  });
  it("with carrier + tracking", () => {
    expect(buildShipmentLabel({ index: 1, carrier: "FedEx", trackingNumber: "771234", receiveCount: 3 }))
      .toBe("Shipment 2 — FedEx 771234 (3 receives)");
  });
});
```

Run: `npx vitest run lib/db/queries/shipments.test.ts` — expected PASS.

- [ ] **Step 3: Server action**

In `app/(admin)/receiving/raw-bags/actions.ts` (alongside `createRawBagIntakeAction`, same guard tier):

```ts
export async function createShipmentAction(input: {
  poId: string;
  carrier?: string;
  trackingNumber?: string;
}): Promise<{ ok: true; shipmentId: string } | { ok: false; error: string }> {
  try {
    const actor = await requireLead();
    const parsed = z
      .object({
        poId: z.string().uuid(),
        carrier: z.string().max(120).optional(),
        trackingNumber: z.string().max(120).optional(),
      })
      .safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid shipment input." };
    const { id } = await createShipmentForPo(parsed.data, actor);
    revalidatePath("/receiving/raw-bags");
    revalidatePath("/inbound");
    return { ok: true, shipmentId: id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listShipmentsForPoAction(
  poId: string,
): Promise<{ ok: true; shipments: PoShipmentOption[] } | { ok: false; error: string }> {
  try {
    await requireLead();
    const parsed = z.string().uuid().safeParse(poId);
    if (!parsed.success) return { ok: false, error: "Invalid PO id." };
    return { ok: true, shipments: await listShipmentsForPo(parsed.data) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

Add the imports (`z` from "zod", `createShipmentForPo`, `listShipmentsForPo`, `type PoShipmentOption` from `@/lib/db/queries/shipments`).

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add lib/db/queries/shipments.ts lib/db/queries/shipments.test.ts "app/(admin)/receiving/raw-bags/actions.ts"
git commit -m "feat(receiving): shipment list/create queries + lead-gated actions"
```

---

### Task 14: Intake flow — attach receives to a shipment

**Files:**
- Modify: `lib/db/queries/raw-bag-intake.ts` (`createRawBagIntakeAtomic` input schema + receive insert)
- Modify: `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`

**Interfaces:**
- Consumes: Task 13 actions.
- Produces: intake submissions carry `shipmentId` through to `receives.shipment_id`.

- [ ] **Step 1: Thread shipmentId through the atomic intake**

In `lib/db/queries/raw-bag-intake.ts`, find `createRawBagIntakeAtomic`'s zod input schema (it validates `raw: unknown`). Add:

```ts
  shipmentId: z.string().uuid().nullable().optional(),
```

and pass it to the receive insert (`shipmentId: parsed.shipmentId ?? null` on the `receives` insert values — the column exists; if the module delegates to `createReceiveWithBoxes` in `lib/db/queries/receives.ts`, that function already accepts `shipmentId`). Follow the module's existing null-handling idiom (`compact({...})`).

Guard: if the schema validates `poId` and a `shipmentId` is provided, verify inside the transaction that the shipment's `po_id` matches the receive's `po_id`; on mismatch throw `new Error("Shipment belongs to a different PO")` (fail closed, consistent with the module's other integrity checks).

- [ ] **Step 2: Form — shipment selector**

In `raw-bag-intake-form.tsx`, after the PO select (find the existing PO `<select>`/combobox state — the form already tracks a selected PO id), add a "Shipment" section rendered only when a PO is selected:

- On PO change, call `listShipmentsForPoAction(poId)` (via `useTransition`, same idiom as the form's other lazy loads) and store `shipments` state.
- Radio-style choice: `New shipment` (default) or one entry per existing shipment (`option.label`).
- When `New shipment` is selected show two optional inputs, `Carrier` and `Tracking number`, in the form's existing input style.
- On submit, BEFORE calling `createRawBagIntakeAction`: if `New shipment`, call `createShipmentAction({ poId, carrier, trackingNumber })` and use the returned `shipmentId`; else use the selected shipment id. Include `shipmentId` in the intake payload. If shipment creation fails, surface the error in the form's existing error area and abort the submit.
- Copy (floor language, luma-workflow-ux): section label `Shipment`, helper text `Which delivery did these boxes arrive on? Reuse the shipment if you are receiving more flavors from the same delivery.`

- [ ] **Step 3: Verify existing intake tests**

Run: `npx vitest run "app/(admin)/receiving/raw-bags/page.test.ts" && npm run typecheck`
Expected: PASS/clean (update the page test only if it asserts the intake payload shape).

- [ ] **Step 4: Commit**

```bash
git add lib/db/queries/raw-bag-intake.ts "app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx"
git commit -m "feat(receiving): intake attaches receives to a new or existing shipment"
```

---

### Task 15: Receives page grouped PO → shipment

**Files:**
- Modify: `lib/db/queries/receives.ts:22-43` (`listReceives`)
- Modify: `lib/production/receives-grouping.ts`
- Modify: `app/(admin)/inbound/page.tsx`
- Test: `lib/production/receives-grouping.test.ts`

**Interfaces:**
- Consumes: `receives.shipmentId` + Task 13 label helper style.
- Produces:

```ts
export type ShipmentReceiveGroup<T extends GroupableReceive> = {
  key: string;               // shipmentId or "__no_shipment__"
  isLegacy: boolean;         // true for the null-shipment group
  carrier: string | null;
  trackingNumber: string | null;
  receives: T[];
  totalBags: number;
  latestReceivedAt: Date | null;
};
export function groupPoReceivesByShipment<T extends GroupableReceive & { shipmentId: string | null; shipmentCarrier: string | null; shipmentTracking: string | null }>(receives: T[]): ShipmentReceiveGroup<T>[];
```

- [ ] **Step 1: Write the failing tests**

Append to `lib/production/receives-grouping.test.ts` (reuse its row-builder helpers):

```ts
describe("groupPoReceivesByShipment", () => {
  it("groups receives under their shipment, newest shipment first", () => {
    // three receives: two on shipment S1, one on shipment S2 (newer)
    // expect [S2 group, S1 group]; S1 group has 2 receives, bags summed
  });
  it("null-shipment receives collapse into one legacy group, sorted last", () => {
    // expect group.key === "__no_shipment__", isLegacy true, placed after real shipments
  });
  it("preserves the generic row type (receiveName still accessible)", () => {
    // type-level: pass rows with extra fields, read them back off group.receives[0]
  });
});
```

Make the assertions concrete with the helper rows (bag counts 2/3/4 etc. — exact numbers asserted).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/receives-grouping.test.ts`
Expected: FAIL (function missing).

- [ ] **Step 3: Implement**

Add to `lib/production/receives-grouping.ts` (reusing `toDate`/`byReceivedAtDesc`):

```ts
const NO_SHIPMENT_KEY = "__no_shipment__";

export type ShipmentReceiveGroup<T> = {
  key: string;
  isLegacy: boolean;
  carrier: string | null;
  trackingNumber: string | null;
  receives: T[];
  totalBags: number;
  latestReceivedAt: Date | null;
};

/** SHIPMENT-INTAKE-1 — second grouping tier inside one PO group. Legacy
 *  receives (no shipment_id) collapse into a single "Earlier receives"
 *  group that always sorts last; no synthetic shipment is fabricated. */
export function groupPoReceivesByShipment<
  T extends GroupableReceive & {
    shipmentId: string | null;
    shipmentCarrier: string | null;
    shipmentTracking: string | null;
  },
>(rows: T[]): ShipmentReceiveGroup<T>[] {
  const groups = new Map<string, ShipmentReceiveGroup<T>>();
  for (const row of rows) {
    const key = row.shipmentId ?? NO_SHIPMENT_KEY;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        isLegacy: key === NO_SHIPMENT_KEY,
        carrier: row.shipmentCarrier,
        trackingNumber: row.shipmentTracking,
        receives: [],
        totalBags: 0,
        latestReceivedAt: null,
      };
      groups.set(key, g);
    }
    g.receives.push(row);
    g.totalBags += row.bagCount ?? 0;
    const received = toDate(row.receive.receivedAt);
    if (received != null && (g.latestReceivedAt == null || received > g.latestReceivedAt)) {
      g.latestReceivedAt = received;
    }
  }
  const result = Array.from(groups.values());
  for (const g of result) {
    g.receives.sort((a, b) => byReceivedAtDesc(toDate(a.receive.receivedAt), toDate(b.receive.receivedAt)));
  }
  result.sort((a, b) => {
    if (a.isLegacy !== b.isLegacy) return a.isLegacy ? 1 : -1;
    return byReceivedAtDesc(a.latestReceivedAt, b.latestReceivedAt);
  });
  return result;
}
```

- [ ] **Step 4: Query + page**

- `listReceives` in `lib/db/queries/receives.ts`: add a `leftJoin(shipments, eq(receives.shipmentId, shipments.id))` and select `shipmentId: receives.shipmentId, shipmentCarrier: shipments.carrier, shipmentTracking: shipments.trackingNumber`.
- `app/(admin)/inbound/page.tsx` `PoReceiveGroupCard`: replace the single `<DataTable>` with a mapped render of `groupPoReceivesByShipment(group.receives)`. Each shipment group renders a native `<details>` (default `open` only for the first/newest group) whose `<summary>` shows: shipment title (`Shipment` + carrier/tracking when present, or `Earlier receives` for the legacy group), `N flavors · M bags`, and latest received date; the body is the existing receives `<DataTable>` unchanged. Flavor count = distinct values across the group's `tabletTypes` strings (split on ", ", dedupe). Keep the existing per-receive rows exactly as they are.
- Update the page description to: `"History of all tablet and packaging receives, grouped by delivery. Each shipment contains the per-flavor receives that arrived together."`

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run lib/production/receives-grouping.test.ts && npm run typecheck && npm run lint`
Expected: PASS/clean.

- [ ] **Step 6: Commit**

```bash
git add lib/db/queries/receives.ts lib/production/receives-grouping.ts lib/production/receives-grouping.test.ts "app/(admin)/inbound/page.tsx"
git commit -m "feat(receiving): Receives page grouped PO -> shipment; legacy receives under Earlier receives"
```

---

### Task 16: Version bump + full closeout

**Files:**
- Modify: `package.json` (version), `CHANGELOG.md`

- [ ] **Step 1: Bump version**

Set `package.json` version to `1.29.0` (MINOR: new functionality, per VERSIONING.md). Add a CHANGELOG entry in the file's existing format covering: Zoho-as-truth closeout status (+ raw zoho_status columns, hourly sync, refresh button, suppress+flag), closeout header/sort/filter, bag drawer Issue-finished-lot fix, receiving by shipment.

- [ ] **Step 2: Full verification (luma-test-build-deploy shape)**

Run, in order, and paste outputs into the task report:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Expected: all clean/green. Fix anything that fails before committing.

- [ ] **Step 3: Commit + push**

```bash
git add package.json CHANGELOG.md
git commit -m "feat: closeout Zoho truth, closeout UX, drawer fix, receiving shipments (v1.29.0)"
git push
```

---

### Task 17: Sandbox verification (CT 123, prod data copy)

No file changes — evidence gathering on `luma-sandbox` (192.168.1.215). The branch auto-deploys ~60s after push; the container runs migrations on deploy.

- [ ] **Step 1: Confirm deploy + migration**

```bash
ssh root@192.168.1.190 'pct exec 123 -- bash -c "cd /opt/luma && git log --oneline -1 && docker exec luma-db-1 psql -U postgres -d luma -tc \"SELECT column_name FROM information_schema.columns WHERE table_name='"'"'purchase_orders'"'"' AND column_name LIKE '"'"'zoho_status%'"'"'\""'
```

Expected: HEAD = the pushed commit; both new columns listed. (If psql user `postgres` fails, retry with `-U luma`.)

- [ ] **Step 2: Diagnose the stale-status root cause on real data**

Trigger a sync from the sandbox UI ("Refresh from Zoho" on /po-closeout — read-only toward Zoho via the gateway), then:

```sql
SELECT zoho_status, COUNT(*), COUNT(*) FILTER (WHERE status = 'OPEN') AS mapped_open
FROM purchase_orders WHERE zoho_status IS NOT NULL GROUP BY zoho_status;
```

Expected: the POs the user sees as "closed in Zoho" now carry a terminal raw status. Confirm the terminal set `{closed, billed, cancelled}` matches reality — if Zoho returns other terminal spellings, extend `ZOHO_TERMINAL_STATUSES` (Task 3) and its test in a follow-up commit.

- [ ] **Step 3: Acceptance checks in the sandbox UI**

- /po-closeout: Active count drops from 86 to only genuinely-open POs; Zoho-closed POs sit in Closed with the `Zoho` chip where Luma work was left open.
- A Zoho-closed PO's detail shows the "Closed in Zoho — N outputs were never pushed" banner; suppressed rows read "Closed in Zoho — output was never pushed to Zoho".
- PO-00206 detail: header reads `PO-00206 — closeout`; sort by date started/completed and tablet filter chips work across its 55 bags.
- Bag receipt `352283` (PO-00206): row action is `Issue finished lot`, the drawer shows the working issue button (no partial panel, no dead workbench link), and clicking it issues the lot (sandbox DB — safe; Zoho untouched).
- /inbound: PO-00206 renders one shipment-or-legacy group ("Earlier receives" — its receives predate shipments) instead of five peer rows; a NEW test intake (any PO, 2 flavors, same new shipment) renders as one shipment group with 2 receives.
- Auto-commit skip: `docker exec luma-app-1` is NOT used — instead run the sweep logic via a targeted SQL check that no `zoho_production_output_ops` rows on Zoho-closed POs are in a committable state transition after the deploy window (their status must be unchanged). (The sandbox's Zoho cron timers are disabled; the skip logic is unit-tested in Task 6 — this is a belt-and-suspenders data check.)

- [ ] **Step 4: Report**

Summarize evidence (counts before/after, screenshots if run interactively) in the final task report for user review before any merge to `main`.
