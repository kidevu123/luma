# RECEIVE-3 / Per-Row Supplier Lot Number

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators override the supplier lot number per bag row at intake, so a single receive session can span multiple supplier lots without data loss.

**Architecture:** No DB migration. The existing `batches` table already supports multiple batches with different `batchNumber` values — the intake logic currently creates one batch per intake session. This plan extends it to create one batch per _unique supplier lot number_ among the rows, then assigns each bag's `batchId` to its lot's batch. The form adds an editable "Supplier lot #" column seeded from the setup-level lot.

**Tech Stack:** Next.js 15 App Router, TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Drizzle ORM, Zod, Vitest.

---

## Safety Check (pre-work, no commit)

Before any code:

```bash
cd /Users/sahilkhatri/Projects/Work/luma
git branch --show-current      # expect: luma-live-testing
git rev-parse --short HEAD     # expect: 6dfcf71
grep '"version"' package.json  # expect: 0.2.8
git status --short             # expect: clean (untracked docs/superpowers ok)
git log --oneline HEAD..origin/luma-live-testing  # expect: empty (in sync)
```

Deployed container version (via Proxmox):
```bash
ssh root@192.168.1.190 'pct exec 122 -- curl -sf http://localhost:3000/api/health'
# expect: {"status":"ok","db":"ok","sha":"6dfcf71..."}
```

---

## Data Persistence Findings

**Where supplier lot lives now:**
- `batches.batch_number` (TEXT NOT NULL, unique index on `(kind, batch_number)`)
- `batches.vendor_lot_number` (TEXT, redundant copy)
- `inventory_bags.batch_id` (FK → `batches.id`) — the only bag→lot link

**There is no `supplier_lot_number` column on `inventory_bags`.** Per-row lots are achieved by assigning each bag to a different batch row.

**No migration required.**

---

## File Structure

| File | Change |
|------|--------|
| `lib/production/raw-bag-intake.ts` | Add `supplierLotNumber: string` to `RawBagRowSeed`; update `generateBagRowSeed`; add `supplierLotNumber` to Zod row schema; update `preflightRawBagIntake` mapping (Task 2) |
| `lib/db/queries/raw-bag-intake.ts` | Replace single-batch creation with per-unique-lot multi-batch loop; use `batchIdByLot` map per row (Task 3) |
| `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx` | Add per-row Supplier lot # column, seed from setup lot, include in save payload (Task 4) |
| `lib/production/raw-bag-intake.test.ts` | New describe block with 8 tests for per-row lot behavior (Task 5) |
| `package.json` | Version bump 0.2.8 → 0.2.9 (Task 6) |
| `CHANGELOG.md` | RECEIVE-3 entry (Task 6) |

---

## Task 2: `RawBagRowSeed` + `generateBagRowSeed` + Zod schema (commit)

**Files:**
- Modify: `lib/production/raw-bag-intake.ts`
- Test: `lib/production/raw-bag-intake.test.ts`

### Background

`RawBagRowSeed` (line 14–21 of `lib/production/raw-bag-intake.ts`) currently has:
```typescript
export type RawBagRowSeed = {
  bagSequence: number;
  receiptNumber: string;
  bagQrCode: string | null;
  declaredCount: number | null;
  weightGrams: number | null;
  notes: string | null;
};
```

`generateBagRowSeed` (line 54) signature currently:
```typescript
export function generateBagRowSeed(input: {
  count: number;
  receiptStart: string;
  receiptPrefix?: string | null;
  declaredCount?: number | null;
  declaredTotal?: number | null;
  weightGrams?: number | null;
}): RawBagRowSeed[]
```

`rawBagIntakeInputSchema.rows` (line ~330) currently has:
```typescript
z.object({
  bagSequence: z.number().int().positive(),
  receiptNumber: z.string().trim().min(1).max(120),
  bagQrCode: z.string().trim().max(120).nullable().optional(),
  declaredCount: z.number().int().positive().nullable().optional(),
  weightGrams: z.number().int().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
})
```

`preflightRawBagIntake` maps `input.rows` to `RawBagRowSeed[]` (line ~375):
```typescript
const rowSeeds: RawBagRowSeed[] = input.rows.map((r) => ({
  bagSequence: r.bagSequence,
  receiptNumber: r.receiptNumber,
  bagQrCode: r.bagQrCode ?? null,
  declaredCount: r.declaredCount ?? null,
  weightGrams: r.weightGrams ?? null,
  notes: r.notes ?? null,
}));
```

- [ ] **Step 1: Write the failing tests**

Add a new describe block at the bottom of `lib/production/raw-bag-intake.test.ts` (after the last `});`):

```typescript
// ─── RECEIVE-3: per-row supplier lot seeding ──────────────────────────
describe("generateBagRowSeed — supplierLotNumber seeding", () => {
  it("seeds all rows with the provided supplierLotNumber", () => {
    const rows = generateBagRowSeed({
      count: 3,
      receiptStart: "1001",
      supplierLotNumber: "LOT-ABC-2026",
    });
    expect(rows.every((r) => r.supplierLotNumber === "LOT-ABC-2026")).toBe(true);
  });

  it("seeds empty string when supplierLotNumber is not provided", () => {
    const rows = generateBagRowSeed({ count: 2, receiptStart: "1001" });
    expect(rows.every((r) => r.supplierLotNumber === "")).toBe(true);
  });

  it("assignQrCodesFromPool preserves supplierLotNumber through spread", () => {
    const pool = [{ scanToken: "bag-card-1" }, { scanToken: "bag-card-2" }];
    const rows = generateBagRowSeed({
      count: 2,
      receiptStart: "1001",
      supplierLotNumber: "LOT-XYZ",
    });
    const assigned = assignQrCodesFromPool(rows, pool);
    expect(assigned[0]?.supplierLotNumber).toBe("LOT-XYZ");
    expect(assigned[1]?.supplierLotNumber).toBe("LOT-XYZ");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm test -- lib/production/raw-bag-intake.test.ts 2>&1 | grep -E "FAIL|✗|supplierLot" | head -10
```

Expected: 3 failures mentioning `supplierLotNumber` not existing.

- [ ] **Step 3: Add `supplierLotNumber` to `RawBagRowSeed`**

In `lib/production/raw-bag-intake.ts`, find:
```typescript
export type RawBagRowSeed = {
  bagSequence: number;
  receiptNumber: string;
  bagQrCode: string | null;
  declaredCount: number | null;
  weightGrams: number | null;
  notes: string | null;
};
```

Replace with:
```typescript
export type RawBagRowSeed = {
  bagSequence: number;
  receiptNumber: string;
  bagQrCode: string | null;
  declaredCount: number | null;
  weightGrams: number | null;
  supplierLotNumber: string;
  notes: string | null;
};
```

- [ ] **Step 4: Add `supplierLotNumber` parameter to `generateBagRowSeed`**

Find `generateBagRowSeed`'s input object type. Add `supplierLotNumber?: string | null` to it.

Find the return expression inside the function — it creates objects like:
```typescript
{
  bagSequence: start + i,
  receiptNumber: `${prefix}${String(number + i).padStart(padding, "0")}`,
  bagQrCode: null,
  declaredCount: counts[i] ?? null,
  weightGrams: input.weightGrams ?? null,
  notes: null,
}
```

Add `supplierLotNumber: input.supplierLotNumber?.trim() ?? "",` to each row object.

The complete updated function signature input type:
```typescript
input: {
  count: number;
  receiptStart: string;
  receiptPrefix?: string | null;
  declaredCount?: number | null;
  declaredTotal?: number | null;
  weightGrams?: number | null;
  supplierLotNumber?: string | null;
}
```

- [ ] **Step 5: Add `supplierLotNumber` to `rawBagIntakeInputSchema` rows**

In `rawBagIntakeInputSchema`, find the `rows` array object definition and add:
```typescript
supplierLotNumber: z.string().trim().min(1).max(80),
```

after `receiptNumber`. The full row object becomes:
```typescript
z.object({
  bagSequence: z.number().int().positive(),
  receiptNumber: z.string().trim().min(1).max(120),
  supplierLotNumber: z.string().trim().min(1).max(80),
  bagQrCode: z.string().trim().max(120).nullable().optional(),
  declaredCount: z.number().int().positive().nullable().optional(),
  weightGrams: z.number().int().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
})
```

- [ ] **Step 6: Update `preflightRawBagIntake` mapping**

Find the `rowSeeds` mapping in `preflightRawBagIntake`:
```typescript
const rowSeeds: RawBagRowSeed[] = input.rows.map((r) => ({
  bagSequence: r.bagSequence,
  receiptNumber: r.receiptNumber,
  bagQrCode: r.bagQrCode ?? null,
  declaredCount: r.declaredCount ?? null,
  weightGrams: r.weightGrams ?? null,
  notes: r.notes ?? null,
}));
```

Add `supplierLotNumber: r.supplierLotNumber,`:
```typescript
const rowSeeds: RawBagRowSeed[] = input.rows.map((r) => ({
  bagSequence: r.bagSequence,
  receiptNumber: r.receiptNumber,
  bagQrCode: r.bagQrCode ?? null,
  declaredCount: r.declaredCount ?? null,
  weightGrams: r.weightGrams ?? null,
  supplierLotNumber: r.supplierLotNumber,
  notes: r.notes ?? null,
}));
```

- [ ] **Step 7: Run typecheck + tests**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck && npm test -- lib/production/raw-bag-intake.test.ts 2>&1 | tail -10
```

Expected: 0 typecheck errors. The 3 new tests pass. Existing 78 tests still pass (total 81 in file).

- [ ] **Step 8: Commit**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
git add lib/production/raw-bag-intake.ts lib/production/raw-bag-intake.test.ts
git commit -m "feat(intake): add supplierLotNumber to RawBagRowSeed + Zod row schema"
```

---

## Task 3: `createRawBagIntakeAtomic` — per-lot multi-batch support (commit)

**Files:**
- Modify: `lib/db/queries/raw-bag-intake.ts`

### Background

Currently (lines ~267–323), `createRawBagIntakeAtomic` does ONE batch upsert using `input.supplierLotNumber` for all bags:

```typescript
const [existingBatch] = await tx
  .select().from(batches)
  .where(and(
    eq(batches.kind, "TABLET"),
    eq(batches.batchNumber, input.supplierLotNumber),
    eq(batches.tabletTypeId, input.tabletTypeId),
  )).limit(1);
let batchId: string;
const totalDeclared = input.rows.reduce((sum, r) => sum + (r.declaredCount ?? 0), 0);
if (existingBatch) {
  batchId = existingBatch.id;
  await tx.update(batches).set({ ... }).where(eq(batches.id, batchId));
} else {
  const [batch] = await tx.insert(batches).values({ ... }).returning();
  batchId = batch.id;
  // audit log
}
```

Then in `bagRows`:
```typescript
const bagRows = input.rows.map((r) => ({
  ...
  batchId,   // same for all rows
  ...
}));
```

And `smallBoxes`:
```typescript
const [box] = await tx.insert(smallBoxes).values({
  receiveId: receiveRow.id,
  boxNumber: 1,
  defaultBatchId: batchId,
  ...
}).returning();
```

**The change:** Replace the single batch block with a loop over unique lot numbers, building a `batchIdByLot: Map<string, string>`, then use `batchIdByLot.get(r.supplierLotNumber)!` per row.

- [ ] **Step 1: Read the current batch upsert block**

```bash
grep -n "existingBatch\|batchId\|upsert batch\|supplierLotNumber\|defaultBatchId" /Users/sahilkhatri/Projects/Work/luma/lib/db/queries/raw-bag-intake.ts | head -25
```

Confirm the line numbers of the block to replace.

- [ ] **Step 2: Replace single-batch block with multi-lot loop**

Find and replace the entire block from `// ── Upsert batch by...` through the closing `}` of the `else` branch (where `batchId` is set and audit log written). The `let batchId: string;` declaration will also be removed.

Replace with:

```typescript
    // ── One batch per unique supplier lot.  Rows within the same lot
    // share a batch; rows with different lots get separate batches.
    // This lets a single intake session span multiple supplier lots.
    const uniqueLots = [...new Set(input.rows.map((r) => r.supplierLotNumber))];
    const batchIdByLot = new Map<string, string>();

    for (const lot of uniqueLots) {
      const lotRows = input.rows.filter((r) => r.supplierLotNumber === lot);
      const lotDeclared = lotRows.reduce(
        (sum, r) => sum + (r.declaredCount ?? 0),
        0,
      );

      const [existingBatch] = await tx
        .select()
        .from(batches)
        .where(
          and(
            eq(batches.kind, "TABLET"),
            eq(batches.batchNumber, lot),
            eq(batches.tabletTypeId, input.tabletTypeId),
          ),
        )
        .limit(1);

      if (existingBatch) {
        await tx
          .update(batches)
          .set({
            qtyReceived: existingBatch.qtyReceived + lotDeclared,
            qtyOnHand: existingBatch.qtyOnHand + lotDeclared,
          })
          .where(eq(batches.id, existingBatch.id));
        batchIdByLot.set(lot, existingBatch.id);
      } else {
        const [newBatch] = await tx
          .insert(batches)
          .values(
            compact({
              kind: "TABLET" as const,
              batchNumber: lot,
              tabletTypeId: input.tabletTypeId,
              vendorName: resolvedVendor ?? null,
              vendorLotNumber: lot,
              qtyReceived: lotDeclared,
              qtyOnHand: lotDeclared,
              status: "QUARANTINE" as const,
              statusChangedById: actor.id,
            }),
          )
          .returning();
        if (!newBatch) throw new Error(`intake: batch insert empty for lot ${lot}`);
        batchIdByLot.set(lot, newBatch.id);
        await writeAudit(
          {
            actorId: actor.id,
            actorRole: actor.role,
            action: "batch.create",
            targetType: "Batch",
            targetId: newBatch.id,
            after: newBatch,
          },
          tx,
        );
      }
    }

    // defaultBatchId for the box = batch for the setup-level lot (input.supplierLotNumber).
    // Falls back to the first unique lot if no row uses the setup lot exactly.
    const defaultBatchId =
      batchIdByLot.get(input.supplierLotNumber) ??
      batchIdByLot.values().next().value;
    if (!defaultBatchId) throw new Error("intake: no batch resolved");
```

- [ ] **Step 3: Update `smallBoxes` insert to use `defaultBatchId`**

Find the `smallBoxes` insert:
```typescript
const [box] = await tx
  .insert(smallBoxes)
  .values({
    receiveId: receiveRow.id,
    boxNumber: 1,
    defaultBatchId: batchId,
    defaultTabletTypeId: input.tabletTypeId,
    totalBags: input.rows.length,
  })
  .returning();
```

Change `defaultBatchId: batchId` to `defaultBatchId: defaultBatchId`. No other change.

- [ ] **Step 4: Update `bagRows` map to use per-row batch**

Find the `bagRows` map:
```typescript
const bagRows = input.rows.map((r) => ({
  smallBoxId: box.id,
  bagNumber: r.bagSequence,
  tabletTypeId: input.tabletTypeId,
  batchId,
  ...
}));
```

Change `batchId,` to:
```typescript
batchId: batchIdByLot.get(r.supplierLotNumber) ?? defaultBatchId,
```

- [ ] **Step 5: Fix the `declaredPerBag` reference (if present)**

The old code had `const declaredPerBag = input.rows[0]?.declaredCount ?? 0;` before the batch block. If this variable is unused after the change (check with typecheck), remove it. If it's used elsewhere in the function, leave it.

Check:
```bash
grep -n "declaredPerBag" /Users/sahilkhatri/Projects/Work/luma/lib/db/queries/raw-bag-intake.ts
```

If it appears only in the old batch block → it was removed in Step 2 already (it's part of the block). If it appears elsewhere, keep it.

- [ ] **Step 6: Run typecheck**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck
```

Expected: 0 errors.

Note: `noUncheckedIndexedAccess` means `batchIdByLot.values().next().value` returns `string | undefined`. The `if (!defaultBatchId) throw` guard above handles this — TypeScript should narrow correctly after the guard.

If TypeScript complains about `batchIdByLot.values().next().value` being `string | undefined`, assert it:
```typescript
const firstBatchId = batchIdByLot.values().next().value as string | undefined;
const defaultBatchId =
  batchIdByLot.get(input.supplierLotNumber) ?? firstBatchId;
if (!defaultBatchId) throw new Error("intake: no batch resolved");
```

- [ ] **Step 7: Run tests**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm test
```

Expected: 2075+ tests pass (2072 existing + 3 new from Task 2).

- [ ] **Step 8: Commit**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
git add lib/db/queries/raw-bag-intake.ts
git commit -m "feat(intake): per-lot multi-batch — each unique supplier lot creates its own batch"
```

---

## Task 4: Intake form — per-row Supplier lot # column (commit)

**Files:**
- Modify: `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`

### Background

The form's `rows` state is typed `RawBagRowSeed[]`. Since `RawBagRowSeed` now includes `supplierLotNumber: string`, the state already carries it. Changes needed:

1. **`handleGenerateRows`**: Pass `supplierLotNumber: supplierLot.trim()` to `generateBagRowSeed` so generated rows are seeded.
2. **Table**: Add a "Supplier lot #" column between "Receipt #" and "Declared".
3. **Per-row input**: Show a text input for each row's `supplierLotNumber`. When the row value differs from the setup `supplierLot` state, show a subtle amber dot (·) prefix on the input, or border color change.
4. **`handleSave` payload**: Include `supplierLotNumber: r.supplierLotNumber.trim()` in each row.

Current column order in `<thead>` (from code):
```
Bag | QR code | Receipt # | Declared | Weight (kg) | Notes | (remove)
```

New order:
```
Bag | QR code | Receipt # | Declared | Weight (kg) | Supplier lot # | Notes | (remove)
```

- [ ] **Step 1: Read the file to understand exact structure**

```bash
grep -n "handleGenerateRows\|handleSave\|supplierLot\|Receipt\|thead\|tbody" \
  "/Users/sahilkhatri/Projects/Work/luma/app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx" | head -30
```

Confirm:
- Line of `handleGenerateRows` function
- Line of `generateBagRowSeed({` call inside it
- Line where `rows.map` is in `handleSave`
- Lines of the `<thead>` row and the `<tbody>` row template

- [ ] **Step 2: Update `handleGenerateRows` to seed `supplierLotNumber`**

Find `generateBagRowSeed({` call in `handleGenerateRows`. It currently looks like:
```typescript
const seed = generateBagRowSeed({
  count: safeCount,
  receiptStart: receiptStart.trim(),
  receiptPrefix: receiptPrefix.trim() || null,
  declaredTotal: declared,
});
```

Add `supplierLotNumber: supplierLot.trim(),`:
```typescript
const seed = generateBagRowSeed({
  count: safeCount,
  receiptStart: receiptStart.trim(),
  receiptPrefix: receiptPrefix.trim() || null,
  declaredTotal: declared,
  supplierLotNumber: supplierLot.trim(),
});
```

- [ ] **Step 3: Add `supplierLotNumber` column header to `<thead>`**

In `<thead>`, after the "Weight (kg)" `<th>` and before the "Notes" `<th>`, add:
```tsx
<th className="text-left px-2 py-1.5">Supplier lot #</th>
```

- [ ] **Step 4: Add per-row `supplierLotNumber` input to `<tbody>`**

In `<tbody>`, in the `rows.map((r, i) => ...)` block, after the "Weight (kg)" `<td>` and before the "Notes" `<td>`, add:

```tsx
<td className="px-2 py-1.5">
  <div className="relative">
    <input
      type="text"
      value={r.supplierLotNumber}
      onChange={(e) =>
        setRows((prev) =>
          prev.map((row, idx) =>
            idx === i
              ? { ...row, supplierLotNumber: e.target.value }
              : row,
          ),
        )
      }
      className={`w-full rounded border px-2 py-1 text-xs font-mono
        focus:outline-none focus:ring-1 focus:ring-blue-400
        ${r.supplierLotNumber !== supplierLot.trim() && r.supplierLotNumber.trim().length > 0
          ? "border-amber-400 bg-amber-50/40"
          : "border-border bg-transparent"}`}
      placeholder="e.g. LOT-2026-A"
      aria-label={`Supplier lot for bag ${r.bagSequence}`}
    />
  </div>
</td>
```

This shows an amber border when the row's lot differs from the setup lot (non-empty override). No separate "custom" badge — the amber border is sufficient visual noise.

- [ ] **Step 5: Update `handleSave` payload**

In `handleSave`, find the `rows.map((r) => ({...}))` section. Add `supplierLotNumber: r.supplierLotNumber.trim(),`:

```typescript
rows: rows.map((r) => ({
  bagSequence: r.bagSequence,
  receiptNumber: r.receiptNumber.trim(),
  supplierLotNumber: r.supplierLotNumber.trim(),
  bagQrCode: r.bagQrCode?.trim() || null,
  declaredCount: r.declaredCount,
  weightGrams: r.weightGrams,
  notes: r.notes,
})),
```

- [ ] **Step 6: Run typecheck + tests**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck && npm test
```

Expected: 0 errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
git add "app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx"
git commit -m "feat(intake): per-row supplier lot # column — editable, seeded from setup lot, amber on override"
```

---

## Task 5: Tests for per-row supplier lot behavior (commit)

**Files:**
- Modify: `lib/production/raw-bag-intake.test.ts`

### Background

Current test file structure:
- `describe("splitReceiptStart")` — 6 tests
- `describe("generateBagRowSeed")` — 13 tests  
- `describe("distributeDeclaredTotal")` — 5 tests
- `describe("assignQrCodesFromPool")` — 6 tests
- `describe("kg/grams round-trip conversion")` — 2 tests
- `describe("QR assignment edge cases — RECEIVE-2")` — 6 tests
- `describe("generateBagRowSeed — supplierLotNumber seeding")` — 3 tests (added in Task 2)

Running total: **2072 + 3 = 2075** (Task 2 added 3 tests).

New describe block adds 8 more: **2075 + 8 = 2083**.

- [ ] **Step 1: Find the end of the test file**

```bash
tail -10 /Users/sahilkhatri/Projects/Work/luma/lib/production/raw-bag-intake.test.ts
```

Note the last `});` line.

- [ ] **Step 2: Confirm imports include `rawBagIntakeInputSchema` and `preflightRawBagIntake`**

```bash
grep "rawBagIntakeInputSchema\|preflightRawBagIntake" /Users/sahilkhatri/Projects/Work/luma/lib/production/raw-bag-intake.test.ts | head -5
```

If not imported, add them to the import at the top of the file.

- [ ] **Step 3: Add the new describe block**

Append after the last `});`:

```typescript
// ─── RECEIVE-3: supplier lot validation + regression ─────────────────
describe("RECEIVE-3 — per-row supplier lot + regression checks", () => {
  const makeValidPayload = (overrides?: Partial<{ supplierLotNumber: string; rowLots: string[] }>) => ({
    poMode: "MANUAL_REFERENCE" as const,
    poId: null,
    poLineId: null,
    poNumberManual: "PO-999",
    vendorNameManual: "Test Vendor",
    orderedQuantity: 100,
    tabletTypeId: "00000000-0000-0000-0000-000000000001",
    supplierLotNumber: overrides?.supplierLotNumber ?? "LOT-DEFAULT",
    rows: (overrides?.rowLots ?? ["LOT-DEFAULT", "LOT-DEFAULT", "LOT-DEFAULT"]).map(
      (lot, i) => ({
        bagSequence: i + 1,
        receiptNumber: `R-${String(i + 1).padStart(3, "0")}`,
        supplierLotNumber: lot,
        declaredCount: 100,
        weightGrams: 1000,
      }),
    ),
  });

  it("Zod schema: row with supplierLotNumber accepted", () => {
    const result = rawBagIntakeInputSchema.safeParse(makeValidPayload());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rows[0]?.supplierLotNumber).toBe("LOT-DEFAULT");
    }
  });

  it("Zod schema: blank row supplierLotNumber rejected", () => {
    const payload = makeValidPayload({ rowLots: ["LOT-OK", "  ", "LOT-OK"] });
    const result = rawBagIntakeInputSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("Zod schema: missing row supplierLotNumber rejected", () => {
    const payload = makeValidPayload();
    // strip supplierLotNumber from one row
    const rows = payload.rows.map((r, i) =>
      i === 1 ? { ...r, supplierLotNumber: undefined } : r,
    );
    const result = rawBagIntakeInputSchema.safeParse({ ...payload, rows });
    expect(result.success).toBe(false);
  });

  it("each row can have a different supplierLotNumber without affecting others", () => {
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001", supplierLotNumber: "LOT-A" });
    // mutate only the second row
    const updated = rows.map((r, i) =>
      i === 1 ? { ...r, supplierLotNumber: "LOT-B" } : r,
    );
    expect(updated[0]?.supplierLotNumber).toBe("LOT-A");
    expect(updated[1]?.supplierLotNumber).toBe("LOT-B");
    expect(updated[2]?.supplierLotNumber).toBe("LOT-A");
  });

  it("preflightRawBagIntake maps row supplierLotNumber into RawBagRowSeed", () => {
    const payload = makeValidPayload({ rowLots: ["LOT-A", "LOT-B", "LOT-A"] });
    const result = preflightRawBagIntake(payload);
    expect(result.ok).toBe(true);
  });

  it("QR auto-assignment: only RAW_BAG IDLE cards — assignQrCodesFromPool uses scan_token, not card type", () => {
    // The pool passed to assignQrCodesFromPool is already filtered to RAW_BAG IDLE
    // (listAvailableRawBagQrCards in the page). This test verifies the helper
    // assigns in order without mixing in extra tokens.
    const pool = [{ scanToken: "bag-card-1" }, { scanToken: "bag-card-2" }];
    const rows = generateBagRowSeed({ count: 2, receiptStart: "1001", supplierLotNumber: "LOT-A" });
    const assigned = assignQrCodesFromPool(rows, pool);
    expect(assigned[0]?.bagQrCode).toBe("bag-card-1");
    expect(assigned[1]?.bagQrCode).toBe("bag-card-2");
    expect(assigned.every((r) => r.supplierLotNumber === "LOT-A")).toBe(true);
  });

  it("kg/grams conversion: 1.5 kg → 1500 grams (regression)", () => {
    const kg = 1.5;
    const grams = Math.round(kg * 1000);
    expect(grams).toBe(1500);
    expect(Math.round(grams / 1000 * 1000)).toBe(1500);
  });

  it("distributeDeclaredTotal: distributes 10 pills across 3 bags (regression)", () => {
    const result = distributeDeclaredTotal(10, 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(4); // remainder in first bag
    expect(result[1]).toBe(3);
    expect(result[2]).toBe(3);
    expect(result.reduce((s, v) => s + v, 0)).toBe(10);
  });
});
```

- [ ] **Step 4: Run tests — verify count**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm test -- lib/production/raw-bag-intake.test.ts 2>&1 | tail -5
```

Expected: 86 tests in this file (78 original + 3 from Task 2 + 5 for `describe("generateBagRowSeed — supplierLotNumber seeding")` — wait, Task 2 added that describe. Let me recount: 78 original + 3 (Task 2 describe) + 8 (this task) = 89 in file). Total test suite should be 2072 + 3 + 8 = 2083.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck && npm test
```

Expected: 0 errors, 2083 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
git add lib/production/raw-bag-intake.test.ts
git commit -m "test(intake): RECEIVE-3 per-row supplier lot + QR/kg/distribution regressions"
```

---

## Task 6: Version bump 0.2.8 → 0.2.9, CHANGELOG, build, push (commit)

**Files:** `package.json`, `CHANGELOG.md`

- [ ] **Step 1: Bump version**

In `package.json`, change `"version": "0.2.8"` to `"version": "0.2.9"`.

- [ ] **Step 2: Prepend CHANGELOG entry**

In `CHANGELOG.md`, insert above `## [0.2.8]`:

```markdown
## [0.2.9] — 2026-05-21

### Added
- Raw bag intake: per-row Supplier lot # column. Each generated bag row is seeded with the setup-level lot and can be individually overridden. Rows with a custom lot show an amber border. Most bags share the default lot; operators change only the rows that differ.
- Multi-lot batch support: when rows have different supplier lot numbers, `createRawBagIntakeAtomic` creates one `batches` row per unique lot (find-or-create) and assigns each bag to its lot's batch. No schema migration — uses the existing `batches` table design.
- Blank or missing per-row supplier lot now returns a clean Zod validation error before any DB work.
- 8 new tests: Zod row validation, per-row lot independence, preflight mapping, QR/kg/distribution regressions (2083 total).

### Changed
- `RawBagRowSeed` type gains `supplierLotNumber: string`.
- `generateBagRowSeed` accepts optional `supplierLotNumber` seed parameter.
- `rawBagIntakeInputSchema` rows now include required `supplierLotNumber` per row.

```

- [ ] **Step 3: Run full check suite**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck && npm test && npm run build
```

Expected:
- typecheck: 0 errors
- tests: 2083 passed
- build: exits 0

- [ ] **Step 4: Commit + push**

```bash
cd /Users/sahilkhatri/Projects/Work/luma
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 0.2.9 + RECEIVE-3 changelog"
git push origin luma-live-testing
```

- [ ] **Step 5: Verify deploy**

After push, the deploy timer (runs every 60s) detects the new HEAD on `luma-live-testing` and rebuilds. Check within ~5 minutes:

```bash
ssh root@192.168.1.190 'pct exec 122 -- curl -sf http://localhost:3000/api/health'
# Expect: sha matches the new HEAD after push
```

If the container hasn't rebuilt after 5 minutes:

```bash
ssh root@192.168.1.190 'pct exec 122 -- docker exec luma-app-1 cat /app/package.json' | grep version
# If still 0.2.8: the deploy timer may not have fired yet — wait another minute
# Do NOT manually trigger a rebuild unless the user asks
```

---

## Self-Review

### Spec coverage

| Spec task | Plan task |
|-----------|-----------|
| 1. Repo/deploy safety check | Pre-work section |
| 2. Add per-row supplier lot editing | Tasks 2, 3, 4 |
| 2. Rows seeded from setup lot | Task 4 Step 2 |
| 2. Allow per-row override | Task 4 Step 4 |
| 2. Save row-specific lot | Task 3 Steps 2–4 |
| 2. Keep setup field as default seed | Task 4 Step 2 (setup lot still required) |
| 3. Blank row lot → validation error | Task 2 Step 5 (Zod min 1) + Task 5 Step 3 |
| 3. Preserve QR validation | No changes to QR validation path |
| 3. Preserve declared count distribution | `generateBagRowSeed` only adds a field, no logic change |
| 3. Preserve kg→grams storage | No changes to weight handling |
| 4. Data persistence audit | Pre-work research section |
| 4. Prefer existing bag-level field | Finding: none exists; no migration; use multi-batch approach |
| 5. No backfill of existing records | No backfill in any task |
| 6. Tests: rows inherit setup lot | Task 5 Step 3 (`makeValidPayload`) + Task 2 Step 1 test 1 |
| 6. Tests: changing one row doesn't change others | Task 5 Step 3 ("each row can have a different...") |
| 6. Tests: blank blocks save | Task 5 Step 3 ("blank row supplierLotNumber rejected") |
| 6. Tests: QR only RAW_BAG IDLE | Task 5 Step 3 ("QR auto-assignment") |
| 6. Tests: variety-pack not used | Existing tests cover this (no regression) |
| 6. Tests: kg conversion regression | Task 5 Step 3 ("kg/grams conversion") |
| 6. Tests: declared total distribution | Task 5 Step 3 ("distributeDeclaredTotal") |
| 7. Copy cleanup (if touching nearby) | The helper copy was already fixed in RECEIVE-2 — "Pick a PO to choose the tablet line item being received." is already deployed. No change needed. |
| 8. Version bump | Task 6 Step 1 |
| 9. typecheck + test + build | Task 6 Step 3 |
| 10. Push + deploy verify | Task 6 Step 4–5 |
| 11. Final report | Post-execution summary from executor |

### Placeholder scan

No TBDs, no "implement later", no "add validation". All code blocks are complete.

### Type consistency

- `RawBagRowSeed.supplierLotNumber: string` — non-optional, consistent across Task 2 type def, Task 4 form state (`RawBagRowSeed[]`), and Task 5 test helper.
- `generateBagRowSeed` parameter `supplierLotNumber?: string | null` — optional with `?? ""` fallback, consistent with Task 2 implementation and Task 5 tests passing `supplierLotNumber: "LOT-A"`.
- `rawBagIntakeInputSchema.rows[].supplierLotNumber: z.string().trim().min(1).max(80)` — required, consistent with `input.rows[i].supplierLotNumber` usage in Task 3 `createRawBagIntakeAtomic`.
- `batchIdByLot.get(r.supplierLotNumber) ?? defaultBatchId` — `defaultBatchId` is `string` after the `throw` guard, so `??` fallback is `string`, satisfying strict types.
