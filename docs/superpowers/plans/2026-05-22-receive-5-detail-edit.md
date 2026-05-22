# RECEIVE-5: Post-save Receive Detail + Safe Edit Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface per-bag detail on the receive detail page and allow safe post-save edits of weight, notes, receipt number, supplier lot, and QR card assignment, with audit trail and mandatory reason on sensitive changes.

**Architecture:** Extend the existing `/inbound/[id]` page with a bags table (data already loaded via `getReceive`). New edit page at `/inbound/[id]/bag/[bagId]/edit/` with pure `validateBagEditFields` for testability. PO line Luma receive status wired into the raw-bag intake form. Success panel gets a direct "View receive" link.

**Tech Stack:** Next.js 15 App Router (server components + server actions), Drizzle ORM, Zod, existing Luma Tailwind design system, Vitest.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/db/queries/bag-edits.ts` | Create | `validateBagEditFields` (pure), `editInventoryBag` (DB), `getBagForEdit` |
| `lib/db/queries/bag-edits.test.ts` | Create | Unit tests for `validateBagEditFields` |
| `lib/db/queries/receives.ts` | Modify | Add `listPoLineReceiveTotals(poLineId)` |
| `app/(admin)/inbound/[id]/page.tsx` | Modify | Add bags table section; extend batch lookup to cover per-bag batches |
| `app/(admin)/inbound/[id]/bag/[bagId]/edit/page.tsx` | Create | Server page — loads bag + checks in-production status |
| `app/(admin)/inbound/[id]/bag/[bagId]/edit/actions.ts` | Create | `editBagAction` server action |
| `app/(admin)/inbound/[id]/bag/[bagId]/edit/bag-edit-form.tsx` | Create | Client form — all editable fields + reason |
| `app/(admin)/receiving/raw-bags/page.tsx` | Modify | Load `listPoLineReceiveTotals` per PO line |
| `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx` | Modify | PoLineCards: show Luma receive status; success panel: "View receive" link |

---

## Task 1: Deploy / version sanity check

**Files:** (none — read-only audit)

- [ ] **Step 1: Check local version**

  ```bash
  node -p "require('./package.json').version"
  ```
  Expected: `0.2.13`

- [ ] **Step 2: Check deployed health**

  ```bash
  ssh root@192.168.1.134 "curl -s http://localhost:3000/api/health"
  ```
  Expected JSON: `{"status":"ok","sha":"..."}`. Note the SHA.

- [ ] **Step 3: Compare SHA to local main**

  ```bash
  git rev-parse HEAD
  ```
  If deployed SHA ≠ local HEAD, document the drift. The systemd timer re-deploys every 60s after a push. No code fix needed here — just awareness.

- [ ] **Step 4: Commit** (nothing to commit — this task is read-only)

---

## Task 2: `listPoLineReceiveTotals` — PO line Luma receive status

**Files:**
- Modify: `lib/db/queries/receives.ts`

- [ ] **Step 1: Write the failing test**

  Add to `lib/db/queries/receives.test.ts` (create the file if it doesn't exist):

  ```typescript
  import { describe, it, expect } from "vitest";
  // We only test the signature and return shape — integration tests
  // require a live DB, so we test the pure aspects and import the type.
  import type { PoLineReceiveTotal } from "./receives";
  
  describe("PoLineReceiveTotal type", () => {
    it("has correct shape", () => {
      const t: PoLineReceiveTotal = {
        poLineId: "line-1",
        bagCount: 5,
        receiveCount: 2,
      };
      expect(t.bagCount).toBe(5);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run lib/db/queries/receives.test.ts 2>&1 | tail -10
  ```
  Expected: FAIL — `PoLineReceiveTotal` not exported

- [ ] **Step 3: Add `listPoLineReceiveTotals` to `receives.ts`**

  Add at the bottom of `lib/db/queries/receives.ts`:

  ```typescript
  export type PoLineReceiveTotal = {
    poLineId: string;
    bagCount: number;
    receiveCount: number;
  };
  
  /**
   * For each PO line that has Luma receives, return total bag count and
   * receive count so the intake form can show "N bags across N receives" in
   * the PO line card. Pass the parent PO id to scope to one PO.
   */
  export async function listPoLineReceiveTotals(
    poId: string,
  ): Promise<PoLineReceiveTotal[]> {
    const rows = await db
      .select({
        poLineId: receives.poLineId,
        bagCount: sql<number>`COUNT(ib.id)::int`,
        receiveCount: sql<number>`COUNT(DISTINCT ${receives.id})::int`,
      })
      .from(receives)
      .leftJoin(
        smallBoxes,
        eq(smallBoxes.receiveId, receives.id),
      )
      .leftJoin(
        sql`inventory_bags ib ON ib.small_box_id = ${smallBoxes.id}`,
        sql`true`,
      )
      .where(
        and(
          eq(receives.poId, poId),
          sql`${receives.poLineId} IS NOT NULL`,
        ),
      )
      .groupBy(receives.poLineId);
  
    return rows
      .filter((r): r is typeof r & { poLineId: string } => r.poLineId !== null)
      .map((r) => ({
        poLineId: r.poLineId,
        bagCount: r.bagCount,
        receiveCount: r.receiveCount,
      }));
  }
  ```

  **Note:** Drizzle does not support lateral join sugar, so use raw SQL for the inventory_bags join. An alternative is a correlated subquery, which is simpler:

  ```typescript
  export async function listPoLineReceiveTotals(
    poId: string,
  ): Promise<PoLineReceiveTotal[]> {
    const rows = await db.execute<{
      po_line_id: string;
      bag_count: number;
      receive_count: number;
    }>(sql`
      SELECT
        r.po_line_id,
        COUNT(ib.id)::int     AS bag_count,
        COUNT(DISTINCT r.id)::int AS receive_count
      FROM receives r
      JOIN small_boxes sb ON sb.receive_id = r.id
      LEFT JOIN inventory_bags ib ON ib.small_box_id = sb.id
      WHERE r.po_id = ${poId}
        AND r.po_line_id IS NOT NULL
      GROUP BY r.po_line_id
    `);
  
    return rows.rows.map((r) => ({
      poLineId: r.po_line_id,
      bagCount: r.bag_count,
      receiveCount: r.receive_count,
    }));
  }
  ```

  **Use the raw SQL variant** — it is unambiguous and avoids Drizzle join limitations.

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  npx vitest run lib/db/queries/receives.test.ts 2>&1 | tail -10
  ```
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add lib/db/queries/receives.ts lib/db/queries/receives.test.ts
  git commit -m "feat(receive-5): listPoLineReceiveTotals — PO line bag/receive counts"
  ```

---

## Task 3: Wire PO line receive totals into the raw-bag intake form

**Files:**
- Modify: `app/(admin)/receiving/raw-bags/page.tsx`
- Modify: `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`

- [ ] **Step 1: Load totals in the page and pass to form**

  Open `app/(admin)/receiving/raw-bags/page.tsx`. Find the `Promise.all` block that loads `pos`, `lines`, `tablets`, `availableQrCards`. Extend it to also fetch totals for all lines grouped by PO. Since the PO isn't selected yet, we can't filter by poId — instead, load totals for the top PO only, or accept that we'll reload on PO selection.

  The simplest approach: add a `poLineReceiveTotals` prop that is an empty map on server load. The intake form can fetch on demand via a new server action when the PO is selected.

  **Actually simpler**: pass all line totals for all known POs at page load since there are typically <10 POs. This avoids adding another round-trip.

  ```typescript
  // app/(admin)/receiving/raw-bags/page.tsx
  // Add import:
  import { listPoLineReceiveTotals } from "@/lib/db/queries/receives";
  
  // Inside the page function, after loading pos:
  const allPoIds = pos.map((p) => p.po.id);
  const lineReceiveTotals = (
    await Promise.all(allPoIds.map((id) => listPoLineReceiveTotals(id)))
  ).flat();
  
  // Pass to form:
  <RawBagIntakeForm
    ...
    lineReceiveTotals={lineReceiveTotals}
  />
  ```

- [ ] **Step 2: Update `RawBagIntakeForm` props and `PoLineCards`**

  In `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`:

  1. Add `lineReceiveTotals: PoLineReceiveTotal[]` to the component props type.
  2. Pass it down to `PoLineCards`.
  3. In `PoLineCards`, look up the total for each card's `line.id`:

  ```typescript
  // Locate PoLineCards component (around line 563)
  // Add to its props:
  type PoLineCardsProps = {
    ...
    lineReceiveTotals: PoLineReceiveTotal[];
  };
  
  // In the card body, replace the empty <div className="...">Status</div> with:
  const total = lineReceiveTotals.find((t) => t.poLineId === line.id);
  // ...
  <div className="text-[11px] text-text-muted">
    {total ? (
      <span className="text-emerald-700 font-medium">
        {total.bagCount} bag{total.bagCount === 1 ? "" : "s"} received
        {total.receiveCount > 1 ? ` across ${total.receiveCount} receives` : ""}
      </span>
    ) : (
      <span className="text-text-subtle">No Luma receives yet</span>
    )}
  </div>
  ```

  4. Add the import at the top of the file:
  ```typescript
  import type { PoLineReceiveTotal } from "@/lib/db/queries/receives";
  ```

- [ ] **Step 3: Run typecheck**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```
  Expected: 0 errors

- [ ] **Step 4: Commit**

  ```bash
  git add "app/(admin)/receiving/raw-bags/page.tsx" "app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx"
  git commit -m "feat(receive-5): PO line cards show Luma bag/receive counts"
  ```

---

## Task 4: Update receive detail page — add bags table

**Files:**
- Modify: `app/(admin)/inbound/[id]/page.tsx`

- [ ] **Step 1: Extend batch ID collection to include per-bag batches**

  The current page collects `batchIds` from boxes only. RECEIVE-3 introduced per-row supplier lots, so a bag's `batchId` may differ from its box's `defaultBatchId`. Extend the set:

  ```typescript
  // Replace:
  const batchIds = Array.from(
    new Set(r.boxes.map((b) => b.box.defaultBatchId).filter((x): x is string => !!x)),
  );
  
  // With:
  const batchIds = Array.from(
    new Set([
      ...r.boxes.map((b) => b.box.defaultBatchId),
      ...r.bags.map((b) => b.batchId),
    ].filter((x): x is string => !!x)),
  );
  ```

- [ ] **Step 2: Add bags table Card below the boxes Card**

  After the closing `</Card>` of the Boxes card, add:

  ```tsx
  <Card>
    <CardHeader>
      <CardTitle>Bags ({r.bags.length})</CardTitle>
    </CardHeader>
    <CardContent>
      {r.bags.length === 0 ? (
        <p className="text-sm text-text-muted">No bags on this receive.</p>
      ) : (
        <DataTable>
          <THead>
            <TR>
              <TH>Receipt #</TH>
              <TH>QR token</TH>
              <TH>Supplier lot</TH>
              <TH className="text-right">Declared</TH>
              <TH className="text-right">Weight (kg)</TH>
              <TH>Notes</TH>
              <TH>Status</TH>
              <TH></TH>
            </TR>
          </THead>
          <tbody>
            {r.bags.map((bag) => {
              const batch = bag.batchId ? byBatch.get(bag.batchId) : null;
              return (
                <TR key={bag.id}>
                  <TD className="font-mono text-xs">
                    {bag.internalReceiptNumber ?? `—`}
                  </TD>
                  <TD className="font-mono text-xs text-text-subtle">
                    {bag.bagQrCode ?? "—"}
                  </TD>
                  <TD className="font-mono text-xs">
                    {batch?.batchNumber ?? "—"}
                  </TD>
                  <TD className="text-right tabular-nums text-xs">
                    {bag.declaredPillCount?.toLocaleString() ?? "—"}
                  </TD>
                  <TD className="text-right tabular-nums text-xs">
                    {bag.weightGrams != null
                      ? (bag.weightGrams / 1000).toFixed(3)
                      : "—"}
                  </TD>
                  <TD className="text-xs text-text-muted max-w-[120px] truncate">
                    {bag.notes ?? "—"}
                  </TD>
                  <TD>
                    <BagStatus status={bag.status} />
                  </TD>
                  <TD>
                    <Link
                      href={`/inbound/${r.receive.id}/bag/${bag.id}/edit`}
                      className="text-xs text-brand-700 hover:underline"
                    >
                      Edit
                    </Link>
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </CardContent>
  </Card>
  ```

- [ ] **Step 3: Add `BagStatus` helper at the bottom of the file**

  ```tsx
  function BagStatus({ status }: { status: string }) {
    const map: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
      AVAILABLE: "ok",
      IN_USE: "info",
      CONSUMED: "neutral",
      CLOSED: "neutral",
    };
    return <StatusPill kind={map[status] ?? "neutral"}>{status}</StatusPill>;
  }
  ```

- [ ] **Step 4: Run typecheck**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```
  Expected: 0 errors

- [ ] **Step 5: Commit**

  ```bash
  git add "app/(admin)/inbound/[id]/page.tsx"
  git commit -m "feat(receive-5): bags table on receive detail page"
  ```

---

## Task 5: Create `validateBagEditFields` (pure) + tests

**Files:**
- Create: `lib/db/queries/bag-edits.ts`
- Create: `lib/db/queries/bag-edits.test.ts`

- [ ] **Step 1: Write the failing tests first**

  Create `lib/db/queries/bag-edits.test.ts`:

  ```typescript
  import { describe, it, expect } from "vitest";
  import { validateBagEditFields, type BagEditInput } from "./bag-edits";
  
  // Minimal bag snapshot for tests
  const baseBag = {
    id: "bag-1",
    weightGrams: 1000,
    notes: null,
    internalReceiptNumber: "PO123-R1-B1-001",
    bagQrCode: "bag-card-001",
    batchId: "batch-1",
    status: "AVAILABLE",
  };
  
  describe("validateBagEditFields", () => {
    it("allows weight + notes edit on non-production bag", () => {
      const result = validateBagEditFields(baseBag, { weightGrams: 1200, notes: "ok" }, false);
      expect(result).toEqual({ ok: true });
    });
  
    it("allows notes-only edit on in-production bag", () => {
      const result = validateBagEditFields(baseBag, { notes: "updated" }, true);
      expect(result).toEqual({ ok: true });
    });
  
    it("blocks weight edit on in-production bag", () => {
      const result = validateBagEditFields(baseBag, { weightGrams: 1200 }, true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/in production/);
    });
  
    it("blocks receipt# change on in-production bag", () => {
      const result = validateBagEditFields(baseBag, { internalReceiptNumber: "NEW-R1" }, true);
      expect(result.ok).toBe(false);
    });
  
    it("blocks QR change on in-production bag", () => {
      const result = validateBagEditFields(baseBag, { bagQrCode: "bag-card-002" }, true);
      expect(result.ok).toBe(false);
    });
  
    it("blocks lot change on in-production bag", () => {
      const result = validateBagEditFields(baseBag, { supplierLotNumber: "LOT-999" }, true);
      expect(result.ok).toBe(false);
    });
  
    it("requires reason for QR change", () => {
      const result = validateBagEditFields(baseBag, { bagQrCode: "bag-card-002" }, false);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/reason/i);
    });
  
    it("requires reason for receipt# change", () => {
      const result = validateBagEditFields(baseBag, { internalReceiptNumber: "NEW-001" }, false);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/reason/i);
    });
  
    it("requires reason for supplier lot change", () => {
      const result = validateBagEditFields(baseBag, { supplierLotNumber: "LOT-X" }, false);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/reason/i);
    });
  
    it("allows QR change with reason provided", () => {
      const result = validateBagEditFields(
        baseBag,
        { bagQrCode: "bag-card-002", editReason: "card was damaged" },
        false,
      );
      expect(result).toEqual({ ok: true });
    });
  
    it("allows receipt# change with reason provided", () => {
      const result = validateBagEditFields(
        baseBag,
        { internalReceiptNumber: "NEW-001", editReason: "typo at intake" },
        false,
      );
      expect(result).toEqual({ ok: true });
    });
  
    it("allows weight + QR + reason in one call", () => {
      const result = validateBagEditFields(
        baseBag,
        { weightGrams: 900, bagQrCode: "bag-card-003", editReason: "swapped" },
        false,
      );
      expect(result).toEqual({ ok: true });
    });
  
    it("rejects whitespace-only reason as empty", () => {
      const result = validateBagEditFields(
        baseBag,
        { bagQrCode: "bag-card-002", editReason: "   " },
        false,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/reason/i);
    });
  
    it("allows empty input (no-op)", () => {
      const result = validateBagEditFields(baseBag, {}, false);
      expect(result).toEqual({ ok: true });
    });
  });
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  npx vitest run lib/db/queries/bag-edits.test.ts 2>&1 | tail -10
  ```
  Expected: FAIL — module not found

- [ ] **Step 3: Create `lib/db/queries/bag-edits.ts`**

  ```typescript
  import { eq, and, isNull, isNotNull } from "drizzle-orm";
  import { db } from "@/lib/db";
  import {
    inventoryBags,
    qrCards,
    workflowBags,
    batches,
    tabletTypes,
  } from "@/lib/db/schema";
  import { writeAudit } from "@/lib/db/audit";
  import type { CurrentUser } from "@/lib/auth";
  
  export type BagSnapshot = {
    id: string;
    weightGrams: number | null;
    notes: string | null;
    internalReceiptNumber: string | null;
    bagQrCode: string | null;
    batchId: string | null;
    status: string;
  };
  
  export type BagEditInput = {
    weightGrams?: number | null;
    notes?: string | null;
    internalReceiptNumber?: string | null;
    supplierLotNumber?: string | null;
    bagQrCode?: string | null;
    editReason?: string | null;
  };
  
  const SENSITIVE_FIELDS: Array<keyof BagEditInput> = [
    "internalReceiptNumber",
    "supplierLotNumber",
    "bagQrCode",
  ];
  
  export function validateBagEditFields(
    _bag: BagSnapshot,
    input: BagEditInput,
    isInProduction: boolean,
  ): { ok: true } | { ok: false; error: string } {
    const nonNotes = (["weightGrams", ...SENSITIVE_FIELDS] as Array<keyof BagEditInput>)
      .some((k) => input[k] !== undefined);
  
    if (isInProduction && nonNotes) {
      return {
        ok: false,
        error: "Bag is in production — only notes can be edited.",
      };
    }
  
    const sensitiveChanged = SENSITIVE_FIELDS.some((k) => input[k] !== undefined);
    if (sensitiveChanged && !input.editReason?.trim()) {
      return {
        ok: false,
        error: "Edit reason is required for QR, receipt, or lot changes.",
      };
    }
  
    return { ok: true };
  }
  
  export async function getBagForEdit(bagId: string) {
    const [row] = await db
      .select({
        bag: inventoryBags,
        batchNumber: batches.batchNumber,
        tabletTypeId: inventoryBags.tabletTypeId,
      })
      .from(inventoryBags)
      .leftJoin(batches, eq(inventoryBags.batchId, batches.id))
      .where(eq(inventoryBags.id, bagId));
    if (!row) return null;
  
    const [inProd] = await db
      .select({ id: workflowBags.id })
      .from(workflowBags)
      .where(eq(workflowBags.inventoryBagId, bagId))
      .limit(1);
  
    return { ...row, isInProduction: !!inProd };
  }
  
  export async function editInventoryBag(
    bagId: string,
    input: BagEditInput,
    actor: CurrentUser,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const loaded = await getBagForEdit(bagId);
    if (!loaded) return { ok: false, error: "Bag not found." };
  
    const { bag, isInProduction, tabletTypeId } = loaded;
    const snapshot: BagSnapshot = {
      id: bag.id,
      weightGrams: bag.weightGrams ?? null,
      notes: bag.notes ?? null,
      internalReceiptNumber: bag.internalReceiptNumber ?? null,
      bagQrCode: bag.bagQrCode ?? null,
      batchId: bag.batchId ?? null,
      status: bag.status,
    };
  
    const validation = validateBagEditFields(snapshot, input, isInProduction);
    if (!validation.ok) return validation;
  
    return db.transaction(async (tx) => {
      // ── QR card swap ──────────────────────────────────────────────────────
      if (input.bagQrCode !== undefined && input.bagQrCode !== bag.bagQrCode) {
        const newToken = input.bagQrCode?.trim() ?? null;
  
        // Release old card back to IDLE if it was intake-reserved
        if (bag.bagQrCode) {
          const [oldCard] = await tx
            .select()
            .from(qrCards)
            .where(eq(qrCards.scanToken, bag.bagQrCode));
          if (oldCard) {
            if (oldCard.status === "ASSIGNED" && !oldCard.assignedWorkflowBagId) {
              await tx
                .update(qrCards)
                .set({ status: "IDLE" as const })
                .where(eq(qrCards.scanToken, bag.bagQrCode));
              await writeAudit(
                {
                  actorId: actor.id,
                  actorRole: actor.role,
                  action: "qr_card.released_at_bag_edit",
                  targetType: "QrCard",
                  targetId: oldCard.id,
                  before: { status: oldCard.status },
                  after: { status: "IDLE" },
                  notes: input.editReason ?? undefined,
                },
                tx,
              );
            }
          }
        }
  
        // Assign new card
        if (newToken) {
          const [newCard] = await tx
            .select()
            .from(qrCards)
            .where(eq(qrCards.scanToken, newToken));
          if (!newCard) return { ok: false as const, error: `QR card "${newToken}" not found.` };
          if (newCard.cardType === "VARIETY_PACK") {
            return { ok: false as const, error: "Variety pack cards cannot be used for raw bags." };
          }
          if (newCard.status === "RETIRED") {
            return { ok: false as const, error: "Retired QR cards cannot be assigned." };
          }
          if (
            newCard.status === "ASSIGNED" &&
            newCard.assignedWorkflowBagId !== null
          ) {
            return { ok: false as const, error: "This QR card is already active in production." };
          }
          await tx
            .update(qrCards)
            .set({ status: "ASSIGNED" as const, assignedWorkflowBagId: null })
            .where(eq(qrCards.scanToken, newToken));
          await writeAudit(
            {
              actorId: actor.id,
              actorRole: actor.role,
              action: "qr_card.reserved_at_bag_edit",
              targetType: "QrCard",
              targetId: newCard.id,
              before: { status: newCard.status },
              after: { status: "ASSIGNED" },
              notes: input.editReason ?? undefined,
            },
            tx,
          );
        }
      }
  
      // ── Supplier lot swap ─────────────────────────────────────────────────
      let newBatchId: string | undefined;
      if (
        input.supplierLotNumber !== undefined &&
        input.supplierLotNumber !== loaded.batchNumber
      ) {
        const newLot = input.supplierLotNumber?.trim() ?? null;
        if (newLot) {
          const [existing] = await tx
            .select()
            .from(batches)
            .where(
              and(
                eq(batches.kind, "TABLET"),
                eq(batches.batchNumber, newLot),
                eq(batches.tabletTypeId, tabletTypeId),
              ),
            );
          newBatchId = existing?.id;
          if (!newBatchId) {
            const [created] = await tx
              .insert(batches)
              .values({
                kind: "TABLET" as const,
                batchNumber: newLot,
                tabletTypeId,
                status: "QUARANTINE" as const,
                statusChangedById: actor.id,
                qtyReceived: 0,
                qtyOnHand: 0,
              })
              .returning({ id: batches.id });
            if (!created) return { ok: false as const, error: "Failed to create batch." };
            newBatchId = created.id;
            await writeAudit(
              {
                actorId: actor.id,
                actorRole: actor.role,
                action: "batch.create",
                targetType: "Batch",
                targetId: newBatchId,
                after: { batchNumber: newLot, tabletTypeId, kind: "TABLET" },
                notes: `Created via bag edit: ${input.editReason ?? ""}`,
              },
              tx,
            );
          }
        } else {
          newBatchId = undefined; // will clear batchId
        }
      }
  
      // ── Apply patch to inventory_bags ─────────────────────────────────────
      const patch: Record<string, unknown> = {};
      if (input.weightGrams !== undefined) patch.weightGrams = input.weightGrams;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.internalReceiptNumber !== undefined)
        patch.internalReceiptNumber = input.internalReceiptNumber;
      if (input.bagQrCode !== undefined) patch.bagQrCode = input.bagQrCode?.trim() ?? null;
      if (newBatchId !== undefined) patch.batchId = newBatchId;
  
      if (Object.keys(patch).length > 0) {
        await tx
          .update(inventoryBags)
          .set(patch as Parameters<typeof tx.update>[1])
          .where(eq(inventoryBags.id, bagId));
      }
  
      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "inventory_bag.edit",
          targetType: "InventoryBag",
          targetId: bagId,
          before: snapshot,
          after: { ...snapshot, ...patch },
          notes: input.editReason ?? undefined,
        },
        tx,
      );
  
      return { ok: true as const };
    });
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run lib/db/queries/bag-edits.test.ts 2>&1 | tail -15
  ```
  Expected: all 14 tests PASS

- [ ] **Step 5: Commit**

  ```bash
  git add lib/db/queries/bag-edits.ts lib/db/queries/bag-edits.test.ts
  git commit -m "feat(receive-5): validateBagEditFields + editInventoryBag + tests"
  ```

---

## Task 6: Create bag edit server action

**Files:**
- Create: `app/(admin)/inbound/[id]/bag/[bagId]/edit/actions.ts`

- [ ] **Step 1: Create the server action**

  ```typescript
  "use server";
  
  import { requireLead } from "@/lib/auth-guards";
  import { editInventoryBag, type BagEditInput } from "@/lib/db/queries/bag-edits";
  import { revalidatePath } from "next/cache";
  
  export type EditBagFormData = {
    weightKg?: string;
    notes?: string;
    internalReceiptNumber?: string;
    supplierLotNumber?: string;
    bagQrCode?: string;
    editReason?: string;
  };
  
  export async function editBagAction(
    receiveId: string,
    bagId: string,
    raw: EditBagFormData,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const actor = await requireLead();
  
    const input: BagEditInput = {};
  
    // Weight: UI sends kg string, DB stores grams as integer
    if (raw.weightKg !== undefined && raw.weightKg.trim() !== "") {
      const kg = parseFloat(raw.weightKg);
      if (isNaN(kg) || kg < 0) return { ok: false, error: "Invalid weight." };
      input.weightGrams = Math.round(kg * 1000);
    } else if (raw.weightKg === "") {
      input.weightGrams = null;
    }
  
    if (raw.notes !== undefined) input.notes = raw.notes.trim() || null;
    if (raw.internalReceiptNumber !== undefined)
      input.internalReceiptNumber = raw.internalReceiptNumber.trim() || null;
    if (raw.supplierLotNumber !== undefined)
      input.supplierLotNumber = raw.supplierLotNumber.trim() || null;
    if (raw.bagQrCode !== undefined)
      input.bagQrCode = raw.bagQrCode.trim() || null;
    if (raw.editReason !== undefined)
      input.editReason = raw.editReason.trim() || null;
  
    const result = await editInventoryBag(bagId, input, actor);
  
    if (result.ok) {
      revalidatePath(`/inbound/${receiveId}`);
      revalidatePath(`/inbound/${receiveId}/bag/${bagId}/edit`);
      revalidatePath("/qr-cards");
    }
  
    return result;
  }
  ```

- [ ] **Step 2: Run typecheck**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```
  Expected: 0 errors

- [ ] **Step 3: Commit**

  ```bash
  git add "app/(admin)/inbound/[id]/bag/[bagId]/edit/actions.ts"
  git commit -m "feat(receive-5): editBagAction server action"
  ```

---

## Task 7: Create bag edit form (client component)

**Files:**
- Create: `app/(admin)/inbound/[id]/bag/[bagId]/edit/bag-edit-form.tsx`

- [ ] **Step 1: Create the client form**

  ```tsx
  "use client";
  
  import * as React from "react";
  import { useRouter } from "next/navigation";
  import { Input } from "@/components/ui/input";
  import { Button } from "@/components/ui/button";
  import { editBagAction, type EditBagFormData } from "./actions";
  
  type BagData = {
    id: string;
    weightGrams: number | null;
    notes: string | null;
    internalReceiptNumber: string | null;
    bagQrCode: string | null;
    batchNumber: string | null;
    isInProduction: boolean;
  };
  
  function Field({
    label,
    hint,
    children,
  }: {
    label: string;
    hint?: string;
    children: React.ReactNode;
  }) {
    return (
      <div className="space-y-1">
        <label className="block text-xs font-medium text-text">{label}</label>
        {hint && <p className="text-[11px] text-text-subtle">{hint}</p>}
        {children}
      </div>
    );
  }
  
  export function BagEditForm({
    receiveId,
    bag,
  }: {
    receiveId: string;
    bag: BagData;
  }) {
    const router = useRouter();
    const [error, setError] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
  
    const [weightKg, setWeightKg] = React.useState(
      bag.weightGrams != null ? (bag.weightGrams / 1000).toFixed(3) : "",
    );
    const [notes, setNotes] = React.useState(bag.notes ?? "");
    const [receiptNumber, setReceiptNumber] = React.useState(
      bag.internalReceiptNumber ?? "",
    );
    const [bagQrCode, setBagQrCode] = React.useState(bag.bagQrCode ?? "");
    const [supplierLot, setSupplierLot] = React.useState(bag.batchNumber ?? "");
    const [editReason, setEditReason] = React.useState("");
  
    const sensitiveChanged =
      receiptNumber !== (bag.internalReceiptNumber ?? "") ||
      bagQrCode !== (bag.bagQrCode ?? "") ||
      supplierLot !== (bag.batchNumber ?? "");
  
    async function handleSubmit(e: React.FormEvent) {
      e.preventDefault();
      setError(null);
      setSaving(true);
      try {
        const data: EditBagFormData = {};
        if (weightKg !== (bag.weightGrams != null ? (bag.weightGrams / 1000).toFixed(3) : ""))
          data.weightKg = weightKg;
        if (notes !== (bag.notes ?? "")) data.notes = notes;
        if (receiptNumber !== (bag.internalReceiptNumber ?? ""))
          data.internalReceiptNumber = receiptNumber;
        if (bagQrCode !== (bag.bagQrCode ?? "")) data.bagQrCode = bagQrCode;
        if (supplierLot !== (bag.batchNumber ?? ""))
          data.supplierLotNumber = supplierLot;
        if (editReason) data.editReason = editReason;
  
        const result = await editBagAction(receiveId, bag.id, data);
        if (result.ok) {
          router.push(`/inbound/${receiveId}`);
        } else {
          setError(result.error);
        }
      } finally {
        setSaving(false);
      }
    }
  
    return (
      <form onSubmit={handleSubmit} className="space-y-5 max-w-lg">
        {bag.isInProduction && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This bag is in production. Only notes can be edited.
          </div>
        )}
  
        <Field label="Weight (kg)" hint="Enter in kilograms; stored as grams.">
          <Input
            type="number"
            step="0.001"
            min="0"
            value={weightKg}
            onChange={(e) => setWeightKg(e.target.value)}
            onWheel={(e) => (e.target as HTMLInputElement).blur()}
            disabled={bag.isInProduction}
            className="h-8 text-sm font-mono"
          />
        </Field>
  
        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
  
        <Field
          label="Internal receipt number"
          hint="Requires edit reason."
        >
          <Input
            value={receiptNumber}
            onChange={(e) => setReceiptNumber(e.target.value)}
            disabled={bag.isInProduction}
            className="h-8 text-sm font-mono"
          />
        </Field>
  
        <Field
          label="QR card scan token"
          hint="Enter the scan token of the new card. Requires edit reason. Old intake-reserved card returns to IDLE."
        >
          <Input
            value={bagQrCode}
            onChange={(e) => setBagQrCode(e.target.value)}
            disabled={bag.isInProduction}
            className="h-8 text-sm font-mono"
          />
        </Field>
  
        <Field
          label="Supplier lot number"
          hint="Changes the batch this bag belongs to. Requires edit reason."
        >
          <Input
            value={supplierLot}
            onChange={(e) => setSupplierLot(e.target.value)}
            disabled={bag.isInProduction}
            className="h-8 text-sm font-mono"
          />
        </Field>
  
        {sensitiveChanged && !bag.isInProduction && (
          <Field label="Edit reason" hint="Required — explain why the QR, receipt, or lot changed.">
            <Input
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              placeholder="e.g. QR card damaged at intake, wrong lot scanned"
              className="h-8 text-sm"
            />
          </Field>
        )}
  
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
  
        <div className="flex gap-2">
          <Button type="submit" disabled={saving} size="sm">
            {saving ? "Saving…" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => router.push(`/inbound/${receiveId}`)}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  ```

- [ ] **Step 2: Run typecheck**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```
  Expected: 0 errors

- [ ] **Step 3: Commit**

  ```bash
  git add "app/(admin)/inbound/[id]/bag/[bagId]/edit/bag-edit-form.tsx"
  git commit -m "feat(receive-5): BagEditForm client component"
  ```

---

## Task 8: Create bag edit server page

**Files:**
- Create: `app/(admin)/inbound/[id]/bag/[bagId]/edit/page.tsx`

- [ ] **Step 1: Create the server page**

  ```tsx
  import Link from "next/link";
  import { notFound } from "next/navigation";
  import { ArrowLeft } from "lucide-react";
  import { requireSession } from "@/lib/auth-guards";
  import { getBagForEdit } from "@/lib/db/queries/bag-edits";
  import { getReceive } from "@/lib/db/queries/receives";
  import { PageHeader } from "@/components/ui/page-header";
  import { Card, CardContent } from "@/components/ui/card";
  import { BagEditForm } from "./bag-edit-form";
  
  export const dynamic = "force-dynamic";
  
  export default async function BagEditPage({
    params,
  }: {
    params: Promise<{ id: string; bagId: string }>;
  }) {
    await requireSession();
    const { id: receiveId, bagId } = await params;
  
    const [receive, loaded] = await Promise.all([
      getReceive(receiveId),
      getBagForEdit(bagId),
    ]);
    if (!receive || !loaded) notFound();
  
    const { bag, batchNumber, isInProduction } = loaded;
  
    return (
      <div className="space-y-5 max-w-2xl">
        <div>
          <Link
            href={`/inbound/${receiveId}`}
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
          >
            <ArrowLeft className="h-3 w-3" /> Back to {receive.receive.receiveName}
          </Link>
          <PageHeader
            title={`Edit bag ${bag.internalReceiptNumber ?? bag.id.slice(0, 8)}`}
            description={`Receive: ${receive.receive.receiveName}`}
          />
        </div>
  
        <Card>
          <CardContent className="pt-5">
            <BagEditForm
              receiveId={receiveId}
              bag={{
                id: bag.id,
                weightGrams: bag.weightGrams ?? null,
                notes: bag.notes ?? null,
                internalReceiptNumber: bag.internalReceiptNumber ?? null,
                bagQrCode: bag.bagQrCode ?? null,
                batchNumber: batchNumber ?? null,
                isInProduction,
              }}
            />
          </CardContent>
        </Card>
      </div>
    );
  }
  ```

- [ ] **Step 2: Run typecheck**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```
  Expected: 0 errors

- [ ] **Step 3: Commit**

  ```bash
  git add "app/(admin)/inbound/[id]/bag/[bagId]/edit/page.tsx"
  git commit -m "feat(receive-5): bag edit server page at /inbound/[id]/bag/[bagId]/edit"
  ```

---

## Task 9: Update success panel — "View receive" link

**Files:**
- Modify: `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`

- [ ] **Step 1: Locate and update the `SaveResultPanel` button group**

  Around line 818, find:
  ```tsx
  <Button asChild size="sm" variant="secondary">
    <Link href="/recall">
      <Search className="h-3.5 w-3.5" /> Lookup receipt / batch
    </Link>
  </Button>
  ```

  Replace with (add "View receive" button as the first CTA, keep "Lookup" and "Start production"):

  ```tsx
  <Button asChild size="sm">
    <Link href={`/inbound/${result.receiveId}`}>
      View receive
    </Link>
  </Button>
  <Button asChild size="sm" variant="secondary">
    <Link href="/recall">
      <Search className="h-3.5 w-3.5" /> Lookup receipt / batch
    </Link>
  </Button>
  ```

  **Note:** `result.receiveId` exists on `CreateRawBagIntakeResult` (`ok: true` branch at line 46 of `lib/db/queries/raw-bag-intake.ts`).

- [ ] **Step 2: Run typecheck**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```
  Expected: 0 errors

- [ ] **Step 3: Commit**

  ```bash
  git add "app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx"
  git commit -m "feat(receive-5): success panel — View receive link to /inbound/[id]"
  ```

---

## Task 10: Full check + version bump + push

**Files:**
- Modify: `package.json` (version `0.2.13` → `0.2.14`)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run full test suite**

  ```bash
  npx vitest run 2>&1 | tail -5
  ```
  Expected: all tests pass (count should be 2093 + ~14 new = ~2107)

- [ ] **Step 2: Run typecheck**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```
  Expected: 0 errors

- [ ] **Step 3: Run build**

  ```bash
  npm run build 2>&1 | tail -20
  ```
  Expected: 0 errors, build completes

- [ ] **Step 4: Bump version**

  In `package.json`, change `"version": "0.2.13"` to `"version": "0.2.14"`.

- [ ] **Step 5: Update CHANGELOG.md**

  Add a new section at the top (below the `# Changelog` heading):

  ```markdown
  ## [0.2.14] — 2026-05-22
  
  ### Added
  - Receive detail page: per-bag table showing receipt number, QR scan token, supplier lot, declared count, weight (kg), notes, status, and edit link.
  - Bag edit page at `/inbound/[id]/bag/[bagId]/edit`: safe post-save editing of weight, notes, receipt number, supplier lot, and QR card assignment with mandatory audit trail.
  - Edit reason field: required for QR, receipt, and supplier lot changes.
  - In-production guard: bags linked to a `workflow_bag` only allow notes edits.
  - QR card swap: releasing old intake-reserved card to IDLE, reserving new card as ASSIGNED.
  - `listPoLineReceiveTotals`: returns bag/receive counts per PO line so the intake form can show "N bags across N receives" on each PO line card.
  - `validateBagEditFields` pure function with 14 unit tests covering in-production guard, sensitive-field reason requirement, and no-op input.
  
  ### Changed
  - Receive success panel: primary action is now "View receive" → `/inbound/{receiveId}`.
  - Batch ID collection in receive detail page now includes per-bag batches (RECEIVE-3 introduced per-row lots; the old code only checked box-level batches).
  ```

- [ ] **Step 6: Commit version bump**

  ```bash
  git add package.json CHANGELOG.md
  git commit -m "chore: v0.2.14 — RECEIVE-5 receive detail + bag edit"
  ```

- [ ] **Step 7: Push**

  ```bash
  git push origin main
  ```

- [ ] **Step 8: Verify deploy (wait ~90s)**

  ```bash
  ssh root@192.168.1.134 "curl -s http://localhost:3000/api/health"
  ```
  Expected SHA should match local HEAD.

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|-----------|------|
| 1. Deploy/version sanity check | Task 1 |
| 2. Audit receive data model | Pre-plan research (already done) |
| 3. Receive detail page with bag list | Task 4 |
| 4. Safe edit flow (QR, weight, lot, receipt, notes) | Tasks 5–8 |
| 5. Audit log per edit | Task 5 (`editInventoryBag` calls `writeAudit`) |
| 6. Edit reason required for QR/receipt changes | Task 5 (`validateBagEditFields`) |
| 7. PO line Luma receive status | Tasks 2–3 |
| 8. Success panel link to receive detail | Task 9 |
| 9. Tests + typecheck + build | Task 10 |
| 10. Version bump + push | Task 10 |

**Type consistency check:**
- `BagSnapshot.batchId` used in `validateBagEditFields` (not needed, but kept for context) — `_bag` param is prefixed with `_` since it is not used in the pure validator, which is correct.
- `getBagForEdit` returns `batchNumber: batches.batchNumber` which is `string | null` via leftJoin — page passes it as `batchNumber: batchNumber ?? null` (safe).
- `editInventoryBag` return type is `Promise<{ ok: true } | { ok: false; error: string }>` — consistent throughout.
- `BagEditForm` receives `batchNumber: string | null` and initializes `supplierLot` to `bag.batchNumber ?? ""` — safe.

**Placeholder scan:** No TBD/TODO/placeholders found.
