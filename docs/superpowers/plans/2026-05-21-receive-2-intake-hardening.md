# RECEIVE-2: Raw Bag Intake Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit and harden the raw bag intake path after RECEIVE-1 (QR auto-assignment), fix the misleading Zoho readiness banner, clean up PO dropdown UX, add row removal with QR pool restoration, and add QR edge-case tests.

**Architecture:** Three targeted layers — `page.tsx` (Zoho banner three-tier logic), `raw-bag-intake-form.tsx` (PO label/copy cleanup + row removal button), `lib/production/raw-bag-intake.test.ts` (QR edge-case tests). No schema changes, no new migrations. Audit tasks produce no commits; code tasks each commit independently.

**Tech Stack:** Next.js 15 App Router (server + client components), TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Drizzle ORM, Vitest, Tailwind v3.

---

## File Structure

Files changed in this plan:

| File | Change |
|------|--------|
| `app/(admin)/receiving/raw-bags/page.tsx` | Three-tier Zoho banner (Task 3) |
| `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx` | PO label, helper copy, row removal (Tasks 4, 5, 6) |
| `lib/production/raw-bag-intake.test.ts` | QR edge-case tests (Task 7) |
| `package.json` | Version bump (Task 8) |
| `CHANGELOG.md` | RECEIVE-2 entry (Task 8) |

---

## Task 1: Deployment + E2E Audit (no commit)

This is a research task. No code changes. Produces a report confirming or identifying issues.

**Files to check (read-only):**
- `app/(admin)/receiving/raw-bags/page.tsx`
- `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`
- `lib/db/queries/raw-bag-intake.ts`
- `lib/db/queries/qr-cards.ts`
- `app/(floor)/floor/[token]/page.tsx`
- `app/(floor)/floor/[token]/actions.ts`
- `app/(admin)/production/start/actions.ts`
- `app/(admin)/qr-cards/page.tsx`

- [ ] **Step 1: Branch/SHA/version check**

```bash
git branch --show-current
git rev-parse HEAD
cat package.json | grep '"version"'
git status
git log --oneline origin/luma-live-testing..HEAD
```

Expected: branch `luma-live-testing`, clean working tree, 0 commits ahead (all pushed in RECEIVE-1).

- [ ] **Step 2: Audit QR pool uses only RAW_BAG IDLE cards**

In `lib/db/queries/qr-cards.ts`, confirm `listAvailableRawBagQrCards()` queries:
```sql
WHERE cardType = 'RAW_BAG' AND status = 'IDLE'
```
— VARIETY_PACK cards must not appear in this pool.

- [ ] **Step 3: Audit DB-layer QR validation**

In `lib/db/queries/raw-bag-intake.ts`, find the pre-validation block (before `insert(inventoryBags)`). Confirm:
- Validation `return { ok: false }` (not `throw`) for: card not found, wrong cardType, wrong status
- Bulk UPDATE `status = 'ASSIGNED'` within the same transaction
- `writeAudit` called per card after UPDATE

- [ ] **Step 4: Audit intake-reserved state propagation**

Confirm all three locations accept `status = 'ASSIGNED' AND assignedWorkflowBagId IS NULL`:
- `app/(floor)/floor/[token]/page.tsx` — `idleCards` query uses `or(IDLE, ASSIGNED+null)`
- `app/(floor)/floor/[token]/actions.ts` — fresh-scan condition
- `app/(admin)/production/start/actions.ts` — `cardIsAvailableForProduction`
- `app/(admin)/production/start/page.tsx` — `idleCards` query

- [ ] **Step 5: Audit QR Card Management page**

In `app/(admin)/qr-cards/page.tsx`, confirm:
- `idleRawBagCount` filters `status === "IDLE" && cardType === "RAW_BAG"` (excludes ASSIGNED cards)
- Print button is scoped to idle raw bag cards only

- [ ] **Step 6: Audit po_lines status handling**

In `lib/db/schema.ts`, confirm `poLines` table has no `status` column (filtering happens at sync time in `po-sync.ts`).

In `lib/zoho/po-sync.ts`, confirm `upsertLines` skips `received`/`not_receivable`/unknown Zoho statuses.

- [ ] **Step 7: Write audit findings**

Produce a short text summary noting: what works correctly, what issues were found (if any). The issues feed into the subsequent code tasks. This step has no commit.

---

## Task 2: Read `QrCardsList` to understand summary tiles (no commit)

Before fixing QR management accuracy we need to know what the summary tiles show.

**Files:**
- `app/(admin)/qr-cards/qr-cards-list.tsx`

- [ ] **Step 1: Read the file**

```bash
cat app/(admin)/qr-cards/qr-cards-list.tsx
```

Confirm that the raw/variety summary tiles count `status === "IDLE"` separately from `status === "ASSIGNED"`. Confirm intake-reserved cards (ASSIGNED+null workflowBagId) are NOT counted as idle.

No code changes — record whether this is already correct or needs fixing in Task 3.

---

## Task 3: Fix Zoho readiness banner (commit)

**File:** `app/(admin)/receiving/raw-bags/page.tsx`

Current problem: when Zoho is offline but local POs exist (the normal operating state), the page shows a red/amber "Zoho PO sync not ready — manual fallback in use" banner. This alarms operators who have perfectly usable local data.

Three-tier model:
- **Tier 1** `zohoReady && pos.length > 0`: sky "Zoho sync online" (existing, keep)
- **Tier 2** `!zohoReady && pos.length > 0`: neutral "Using synced PO data" (new — not alarming)
- **Tier 3** `!zohoReady && pos.length === 0`: amber "No local PO data" (genuinely blocked)

- [ ] **Step 1: Read the file**

```bash
cat app/(admin)/receiving/raw-bags/page.tsx
```

Locate the `zohoReady` boolean and the `!zohoReady` / `zohoReady` conditional blocks.

- [ ] **Step 2: Add `hasLocalPos` and implement three-tier banner**

Replace the two-tier `{!zohoReady ? ... : ...}` block with three-tier logic. The `Information` icon from lucide-react is not imported — use `ShieldCheck` (already imported) for tier 2.

Full replacement for the banner section (after the badge strip `</div>`):

```tsx
{/* Zoho readiness banner — three-tier */}
{zohoReady ? (
  <div className="rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-3 text-[12px] text-sky-800 flex items-start gap-2.5">
    <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
    <div>
      <p className="font-semibold">Zoho PO sync online</p>
      <p className="mt-0.5">
        Live PO lookup is available. The picker will surface the freshest PO list. Manual PO entry stays available as a fallback.
      </p>
    </div>
  </div>
) : pos.length > 0 ? (
  <div className="rounded-xl border border-border bg-surface/60 px-4 py-3 text-[12px] text-text-muted flex items-start gap-2.5">
    <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
    <div>
      <p className="font-semibold text-text">Using synced PO data from Luma</p>
      <p className="mt-0.5">
        Live Zoho sync is offline ({readiness}), but {pos.length} PO{pos.length === 1 ? "" : "s"} and their
        line items are available locally. Use the &ldquo;Sync POs from Zoho&rdquo; button to refresh when Zoho is available.
      </p>
    </div>
  </div>
) : (
  <div className="rounded-xl border border-warn-200 bg-warn-50/60 px-4 py-3 text-[12px] text-warn-800 flex items-start gap-2.5">
    <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
    <div>
      <p className="font-semibold">No local PO data — use manual PO reference</p>
      <p className="mt-0.5">
        Live Zoho sync is offline ({readiness}) and no POs have been synced yet.
        Use the manual PO reference tab in the form below, or sync POs from Zoho when available.
      </p>
    </div>
  </div>
)}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: clean (0 errors).

- [ ] **Step 4: Commit**

```bash
git add app/(admin)/receiving/raw-bags/page.tsx
git commit -m "fix(intake): three-tier Zoho banner — local-sync mode no longer shows as error"
```

---

## Task 4: PO dropdown label + helper copy cleanup (commit)

**File:** `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`

Two small text changes in `PoLineCards`.

- [ ] **Step 1: Read the file**

Find `PoLineCards` function. Locate:
1. The `<option>` that renders `{p.poNumber} · {p.vendorName ?? "no vendor"} [{p.status}]`
2. The `<p>` that reads `"Pick a PO to see its line items as receive cards."`

- [ ] **Step 2: Fix PO option label — remove status tag**

Change:
```tsx
{p.poNumber} · {p.vendorName ?? "no vendor"} [{p.status}]
```
To:
```tsx
{p.poNumber} · {p.vendorName ?? "no vendor"}
```

- [ ] **Step 3: Fix helper copy**

Change:
```tsx
<p className="text-sm text-text-muted">
  Pick a PO to see its line items as receive cards.
</p>
```
To:
```tsx
<p className="text-sm text-text-muted">
  Pick a PO to choose the tablet line item being received.
</p>
```

- [ ] **Step 4: Run typecheck + test**

```bash
npm run typecheck && npm test
```

Expected: 0 errors, 2066 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx
git commit -m "fix(intake): remove PO status tag from dropdown label, update helper copy"
```

---

## Task 5: Row removal with QR pool awareness (commit)

**File:** `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`

Add a "Remove" button (×) on each bag row so operators can delete individual rows before saving. When a row is removed, its QR code is freed — not reserved. The QR pool exhaustion warning (already present) will update automatically because it checks `rows.length > availableQrCards.length`.

Also update the section title: currently shows duplicate counts ("N generated, N unsaved"). After row removal the counts would diverge. Simplify to just show current count.

- [ ] **Step 1: Read the file**

Locate:
1. The `<table>` in Section 3 — `<thead>` and `<tbody>`
2. The section title: `` title={`3. Bag rows (${rows.length} generated, ${rows.length} unsaved)`} ``
3. The save `<Button>`: `disabled={pending || rows.length === 0 || !supplierLot.trim()}`

- [ ] **Step 2: Add "Remove" column header**

In `<thead>`, add a new `<th>` at the end:

```tsx
<th className="text-left px-2 py-1.5 w-8"></th>
```

(Empty header — the column just holds remove buttons.)

- [ ] **Step 3: Add "Remove" button cell to each row**

In `<tbody>`, at the end of each `<tr>` (after the Notes `<td>`), add:

```tsx
<td className="px-2 py-1.5">
  <button
    type="button"
    onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
    className="text-text-muted hover:text-red-600 text-xs px-1"
    aria-label={`Remove bag ${r.bagSequence}`}
  >
    ×
  </button>
</td>
```

- [ ] **Step 4: Simplify section title**

Change:
```tsx
title={`3. Bag rows (${rows.length} generated, ${rows.length} unsaved)`}
```
To:
```tsx
title={`3. Bag rows (${rows.length})`}
```

- [ ] **Step 5: Verify QR exhaustion warning still works**

The warning `{rows.length > availableQrCards.length ? ...}` is already correct — it tracks current `rows.length`, not original generated count. No change needed.

Verify the warning reads correctly at edge cases:
- 10 rows, 10 pool cards → no warning (correct)
- 10 rows, 8 pool cards → "Only 8 idle QR cards available; 2 bags need manual QR entry."
- After removing 2 rows → 8 rows, 8 pool cards → no warning (correct — warning disappears)

- [ ] **Step 6: Run typecheck + test**

```bash
npm run typecheck && npm test
```

Expected: 0 errors, 2066 tests pass (UI code only, no new test yet — added in Task 6).

- [ ] **Step 7: Commit**

```bash
git add app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx
git commit -m "feat(intake): add remove-row button; simplify bag rows section title"
```

---

## Task 6: Zero-line empty state improvement (commit)

**File:** `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`

Current empty state when a PO has no lines: "No line items found for this PO. Run 'Sync POs from Zoho' to import lines, or use the manual PO reference tab above."

Improve it to be more actionable:
1. If `pos.length > 0` (POs exist) but the selected PO has no lines: show the existing message.
2. The message should also tell the operator they can switch to a different PO.

Note: `po_lines` has no status column — there are no "received"/"not_receivable" lines in the DB (they're skipped at sync time). The empty state means Zoho sync hasn't fetched lines for this PO yet, or the PO has no tablet lines.

- [ ] **Step 1: Read the file**

Find the `linesForPo.length === 0` conditional block in `PoLineCards`:

```tsx
{linesForPo.length === 0 ? (
  <div className="rounded-md border border-dashed ...">
    No line items found for this PO. Run &ldquo;Sync POs from Zoho&rdquo; to import
    lines, or use the manual PO reference tab above.
  </div>
) : (
```

- [ ] **Step 2: Improve empty state copy**

Change the empty state message to:

```tsx
{linesForPo.length === 0 ? (
  <div className="rounded-md border border-dashed border-border/60 bg-surface/40 px-4 py-6 text-center text-sm text-text-muted">
    No line items found for this PO.{" "}
    Run &ldquo;Sync POs from Zoho&rdquo; to import lines from Zoho, pick a different PO, or use the{" "}
    <button
      type="button"
      className="underline hover:text-text"
      onClick={() => {/* handled by parent — use the tab button */}}
    >
      manual PO reference
    </button>{" "}
    tab if this PO isn&apos;t in the local list.
  </div>
) : (
```

Wait — the `PoLineCards` component doesn't have access to `setPoMode`. We can't inline a tab-switch button. Simplify to static copy only:

```tsx
{linesForPo.length === 0 ? (
  <div className="rounded-md border border-dashed border-border/60 bg-surface/40 px-4 py-6 text-center text-sm text-text-muted">
    No line items for this PO. Run &ldquo;Sync POs from Zoho&rdquo; to import lines, select a different PO,
    or switch to the &ldquo;Manual PO reference&rdquo; tab above.
  </div>
) : (
```

- [ ] **Step 3: Run typecheck + test**

```bash
npm run typecheck && npm test
```

Expected: 0 errors, 2066 tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx
git commit -m "fix(intake): improve zero-line empty state copy in PO line picker"
```

---

## Task 7: QR edge-case tests (commit)

**File:** `lib/production/raw-bag-intake.test.ts`

Add tests documenting and protecting the QR edge cases called out in the spec. Tests are pure unit tests on `assignQrCodesFromPool` and `generateBagRowSeed`.

Note: server-side validation tests (VARIETY_PACK rejection, ASSIGNED rejection, transaction safety) require a live DB and are not feasible as unit tests — they're covered by the existing server-side validation code and the `validateQrCardUsableForRawBag` helper tests.

- [ ] **Step 1: Read the test file**

```bash
grep -n "describe\|it(" lib/production/raw-bag-intake.test.ts | head -50
```

Find the end of the `assignQrCodesFromPool` describe block. New tests go after it.

- [ ] **Step 2: Write the failing tests**

Add a new `describe("QR assignment edge cases — RECEIVE-2", ...)` block after the existing `assignQrCodesFromPool` describe:

```ts
describe("QR assignment edge cases — RECEIVE-2", () => {
  it("10 rows with 10-card pool: all rows get unique non-null QR codes", () => {
    const pool = Array.from({ length: 10 }, (_, i) => ({
      scanToken: `bag-card-${i + 1}`,
    }));
    const rows = generateBagRowSeed({ count: 10, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    const qrCodes = assigned.map((r) => r.bagQrCode).filter((q) => q != null);
    expect(qrCodes).toHaveLength(10);
    expect(new Set(qrCodes).size).toBe(10); // all unique
  });

  it("removing a row does not affect remaining rows' QR codes", () => {
    const pool = Array.from({ length: 5 }, (_, i) => ({
      scanToken: `bag-card-${i + 1}`,
    }));
    const rows = generateBagRowSeed({ count: 5, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    // Simulate removing row at index 2 (bag-card-3)
    const afterRemoval = assigned.filter((_, idx) => idx !== 2);
    expect(afterRemoval).toHaveLength(4);
    expect(afterRemoval[0]?.bagQrCode).toBe("bag-card-1");
    expect(afterRemoval[1]?.bagQrCode).toBe("bag-card-2");
    // index 2 removed
    expect(afterRemoval[2]?.bagQrCode).toBe("bag-card-4");
    expect(afterRemoval[3]?.bagQrCode).toBe("bag-card-5");
  });

  it("removed row's QR code is absent from the remaining rows", () => {
    const pool = [
      { scanToken: "bag-card-1" },
      { scanToken: "bag-card-2" },
      { scanToken: "bag-card-3" },
    ];
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    // Remove the middle row (bag-card-2)
    const remaining = assigned.filter((_, idx) => idx !== 1);
    const remainingQrCodes = remaining.map((r) => r.bagQrCode);
    expect(remainingQrCodes).not.toContain("bag-card-2");
    expect(remainingQrCodes).toContain("bag-card-1");
    expect(remainingQrCodes).toContain("bag-card-3");
  });

  it("QR exhaustion: 5-card pool for 10 rows gives nulls for rows 6-10", () => {
    const pool = Array.from({ length: 5 }, (_, i) => ({
      scanToken: `bag-card-${i + 1}`,
    }));
    const rows = generateBagRowSeed({ count: 10, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    const hasQr = assigned.map((r) => r.bagQrCode != null);
    expect(hasQr).toEqual([true, true, true, true, true, false, false, false, false, false]);
  });

  it("empty pool: all rows get null QR codes (no silent assignment)", () => {
    const rows = generateBagRowSeed({ count: 5, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, []);
    expect(assigned.every((r) => r.bagQrCode === null)).toBe(true);
  });

  it("row count after removal is correct — pool exhaustion warning threshold changes", () => {
    // 8 rows, 5-card pool → pool exhausted by 3
    const pool = Array.from({ length: 5 }, (_, i) => ({ scanToken: `bag-card-${i + 1}` }));
    const rows = generateBagRowSeed({ count: 8, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    expect(assigned.length).toBe(8);
    // Rows 6,7,8 have no QR (indices 5,6,7)
    expect(assigned[5]?.bagQrCode).toBeNull();
    // After removing rows 6,7,8 → 5 rows remain → no exhaustion
    const trimmed = assigned.filter((_, idx) => idx < 5);
    expect(trimmed.length).toBe(5);
    expect(trimmed.every((r) => r.bagQrCode != null)).toBe(true);
  });
});
```

- [ ] **Step 3: Add import for `assignQrCodesFromPool` (already imported)**

Confirm `assignQrCodesFromPool` is already in the test file's import. If not, add it.

- [ ] **Step 4: Run tests — confirm all pass**

```bash
npm test
```

Expected: `2066 + 6 = 2072` tests pass.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/production/raw-bag-intake.test.ts
git commit -m "test(intake): QR edge-case tests — row removal, pool exhaustion, unique assignment"
```

---

## Task 8: Version bump + CHANGELOG + final build (commit)

**Files:** `package.json`, `CHANGELOG.md`

- [ ] **Step 1: Bump version in `package.json`**

Read current version:
```bash
cat package.json | grep '"version"'
```

It should be `"0.2.7"`. Change to `"0.2.8"`.

- [ ] **Step 2: Update `CHANGELOG.md`**

Prepend a new `## [0.2.8]` section above `## [0.2.7]`:

```markdown
## [0.2.8] — 2026-05-21

### Fixed
- Zoho readiness banner: three-tier status model. When Zoho sync is offline but local POs exist (normal operating state), the banner now shows neutral "Using synced PO data from Luma" instead of an alarming warning. Only shows an amber warning when Zoho is offline AND no local POs exist.
- PO dropdown option label: removed `[OPEN]`/`[RECEIVING]` status tag from main label text. PO number and vendor are sufficient context for the receive flow.
- Zero-line empty state: improved copy in PO line picker when a PO has no line items — now mentions all three options (sync, pick different PO, manual reference).

### Added
- Raw bag intake: per-row remove button (×). Removing an unsaved row frees its QR code from the pending submission. QR pool exhaustion warning updates automatically.
- Section 3 title simplified to show current row count only (removed redundant "N generated, N unsaved" when both counts were always equal).
- 6 new QR edge-case tests: 10-row unique assignment, row-removal QR freeing, pool exhaustion threshold, empty-pool null-fill (2072 tests total).

### Improved
- Helper copy in PO picker: "Pick a PO to choose the tablet line item being received." (was: "Pick a PO to see its line items as receive cards.")
```

- [ ] **Step 3: Run full check suite**

```bash
npm run typecheck && npm test && npm run build
```

Expected:
- typecheck: 0 errors
- tests: 2072 passed
- build: success (no red output)

- [ ] **Step 4: Commit + push**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 0.2.8 + RECEIVE-2 changelog"
git push origin luma-live-testing
```

---

## Self-Review

### Spec coverage

| Spec task | Plan task |
|-----------|-----------|
| 1. Branch/deploy safety check | Task 1 Step 1 |
| 2. E2E audit | Task 1 Steps 2–6 |
| 3. Fix Zoho banner | Task 3 |
| 4. PO status label cleanup | Task 4 Step 2 |
| 5. Helper copy fix | Task 4 Step 3 |
| 6. Validate PO line behavior | Task 1 Step 6, Task 6 (empty state) |
| 7a. 10 bags → 10 unique QR codes | Task 7 test 1 |
| 7b. manual override rejects VARIETY_PACK | Verified server-side in Task 1 Step 3 (no new unit test possible without DB) |
| 7c. manual override rejects WORKFLOW_TRAVELER/UNKNOWN | Same — server-side only |
| 7d. manual override rejects ASSIGNED | Same — server-side only |
| 7e. save fails gracefully if QR claimed between generate and save | Task 1 Step 3 confirms pre-validation returns `ok:false` |
| 7f. QR exhaustion warning | Task 7 tests 4+6; visual confirmed in Task 5 |
| 7g. removing a row returns QR to pool | Task 5 (feature) + Task 7 tests 2+3 |
| 7h. saved receive keeps QR assigned | Task 1 Step 3 confirms ASSIGNED bulk-update in transaction |
| 8. Variety QR separation | Task 1 Step 2 |
| 9. QR card management accuracy | Task 2 |
| 10. Tests/build | Task 8 Step 3 |
| 11. Versioning | Task 8 |
| 12. Final report | Summary produced by executor |

### Placeholder scan

No TBDs or "implement later" placeholders found. All code blocks are complete.

### Type consistency

- `rows.filter((_, idx) => idx !== i)` — correct, `idx` is the `Array.filter` index parameter (not the `i` from the outer `rows.map`)
- `assigned.filter((_, idx) => idx !== 2)` in tests — `_` typed as `RawBagRowSeed`, `idx` as `number`, matches `Array.filter` signature
- `Array.from({ length: 10 }, (_, i) => ({ scanToken: ... }))` — correct shape for `readonly { scanToken: string }[]` pool param
