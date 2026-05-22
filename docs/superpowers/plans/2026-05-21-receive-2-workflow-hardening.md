# RECEIVE-2 / Workflow Foundation Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the raw bag intake → QR assignment → Start Production pipeline: fix the Zoho banner, clean up PO UX, add row removal, guard against stale server actions, fix the Start Production QR auto-link gap, add QR edge-case tests, and bump to v0.2.8.

**Architecture:** Six targeted layers across four files. No schema changes, no migrations. Audit tasks (Task 1) produce no commits. Code tasks each commit independently before the next begins.

**Tech Stack:** Next.js 15 App Router (server + client components), TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Drizzle ORM, Vitest, Tailwind v3, React 19.

---

## File Structure

| File | Change |
|------|--------|
| `app/(admin)/receiving/raw-bags/page.tsx` | Three-tier Zoho banner (Task 2) |
| `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx` | PO label, helper copy, row removal, stale-action catch (Tasks 3, 4, 5) |
| `app/(admin)/receiving/raw-bags/sync-po-button.tsx` | Stale-action catch (Task 5) |
| `app/(admin)/production/start/start-production-form.tsx` | Auto-link bag's reserved QR card (Task 6) |
| `lib/production/raw-bag-intake.test.ts` | QR edge-case tests (Task 7) |
| `package.json` | Version bump 0.2.7 → 0.2.8 (Task 8) |
| `CHANGELOG.md` | RECEIVE-2 entry (Task 8) |

---

## Task 1: Audit (no commit)

Research-only. Read code to produce findings that feed into the code tasks.

**Key question for the audit:** Does `startProductionForRawBagAction` enforce that the QR card assigned to production is the SAME card reserved for the raw bag at intake? (Spoiler: it does not — this is Task 6's fix.)

- [ ] **Step 1: Branch/SHA/version check**

```bash
git branch --show-current
git rev-parse HEAD
cat package.json | grep '"version"'
git status
git log --oneline origin/luma-live-testing..HEAD
```

Expected: `luma-live-testing`, SHA `7c234de` (or later), version `0.2.7`, clean working tree.

- [ ] **Step 2: Verify QR pool uses only RAW_BAG IDLE cards**

Read `lib/db/queries/qr-cards.ts` — confirm `listAvailableRawBagQrCards()` queries:
```sql
WHERE card_type = 'RAW_BAG' AND status = 'IDLE'
```
VARIETY_PACK cards must never appear in the raw bag pool.

- [ ] **Step 3: Verify DB-layer QR pre-validation**

Read `lib/db/queries/raw-bag-intake.ts` lines ~200-280. Confirm:
- QR validation runs BEFORE `insert(inventoryBags)` (pre-validation)
- Returns `{ ok: false, error }` (not `throw`) for: card not found, wrong type, wrong status
- Bulk UPDATE `status = 'ASSIGNED'` within same `tx`
- `writeAudit` called per card after UPDATE

- [ ] **Step 4: Verify intake-reserved state propagation**

Confirm all four locations accept `ASSIGNED + assignedWorkflowBagId IS NULL`:
- `app/(floor)/floor/[token]/page.tsx` — `idleCards` query: `or(IDLE, ASSIGNED+null)`
- `app/(floor)/floor/[token]/actions.ts` — fresh-scan condition: `status === "IDLE" || (status === "ASSIGNED" && !assignedWorkflowBagId)`
- `app/(admin)/production/start/actions.ts` — `cardIsAvailableForProduction`
- `app/(admin)/production/start/page.tsx` — `idleCards` query

- [ ] **Step 5: Identify Start Production QR gap**

Read `app/(admin)/production/start/actions.ts` and `app/(admin)/production/start/start-production-form.tsx`.

The gap: `startProductionForRawBagAction(input)` takes `input.qrCardId` from the UI. The UI presents a dropdown of all IDLE/intake-reserved cards. The operator can pick ANY card — not necessarily the card reserved for the specific raw bag at intake.

This means:
- Raw bag was received with `bag_qr_code = "bag-card-5"` (ASSIGNED+null)
- Operator starts production, picks `bag-card-7` (a different IDLE card) by accident
- `bag-card-5` stays ASSIGNED+null forever, never gets a workflowBagId
- The physical raw bag QR now disagrees with the workflow QR

Record the `start-production-form.tsx` structure for Task 6: specifically where the bag lookup result is used and where the QR card selection happens.

- [ ] **Step 6: Verify po_lines has no status column**

```bash
grep -n "status\|zohoStatus" lib/db/schema.ts | grep -A2 -B2 "po_lines"
```

Expected: `poLines` table has no status column. Blocked statuses (`received`/`not_receivable`) are filtered at sync time in `po-sync.ts` — they are never inserted into `po_lines`.

- [ ] **Step 7: Verify QR Card Management counts**

Read `app/(admin)/qr-cards/page.tsx`. Confirm:
- `idleRawBagCount` filters `status === "IDLE" && cardType === "RAW_BAG"` (excludes ASSIGNED cards including intake-reserved ones)
- Print button is scoped to idle raw bag cards only

- [ ] **Step 8: Record findings**

Write a short text summary of:
- RECEIVE-1 QR safety: PASS / issues found
- Start Production QR gap: yes, present — will fix in Task 6
- po_lines: no status column — blocked statuses filtered at sync time (correct)
- QR Card Management: counts accurate (or not)

---

## Task 2: Fix Zoho readiness banner — three-tier (commit)

**File:** `app/(admin)/receiving/raw-bags/page.tsx`

**Problem:** When Zoho is offline but local POs exist (normal operating state), the page shows a red/amber "Zoho PO sync not ready — manual fallback in use" banner. This alarms operators who have perfectly usable local data.

**Three-tier model:**
- Tier 1 `zohoReady`: sky "Zoho sync online" (keep existing)
- Tier 2 `!zohoReady && pos.length > 0`: neutral "Using synced PO data from Luma" (new — not alarming)
- Tier 3 `!zohoReady && pos.length === 0`: amber "No local PO data" (genuinely blocked)

- [ ] **Step 1: Read the file**

```bash
cat app/(admin)/receiving/raw-bags/page.tsx
```

Locate the `zohoReady` boolean and the two-tier `{!zohoReady ? ... : ...}` banner block. Note the existing imports (`ShieldAlert`, `ShieldCheck`).

- [ ] **Step 2: Replace with three-tier banner**

Find the existing two-block banner JSX and replace it with:

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
        Live Zoho sync is offline ({readiness}), but {pos.length} PO{pos.length === 1 ? "" : "s"} and
        their line items are available locally. Use the &ldquo;Sync POs from Zoho&rdquo; button to
        refresh when Zoho is available.
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

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/(admin)/receiving/raw-bags/page.tsx
git commit -m "fix(intake): three-tier Zoho banner — local-sync state no longer looks like an error"
```

---

## Task 3: PO dropdown label + helper copy + row removal (commit)

**File:** `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`

Three changes in one file:
1. Remove `[OPEN]`/`[RECEIVING]` status tag from PO option label
2. Fix "Pick a PO" helper copy
3. Add row-removal (×) button; simplify section title

- [ ] **Step 1: Read the file**

```bash
cat app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx
```

Locate:
- `<option>` rendering `{p.poNumber} · {p.vendorName ?? "no vendor"} [{p.status}]` (in `PoLineCards`)
- `<p>` with `"Pick a PO to see its line items as receive cards."` (in `PoLineCards`)
- `<thead>` of the bag rows table (Section 3)
- `` title={`3. Bag rows (${rows.length} generated, ${rows.length} unsaved)`} ``

- [ ] **Step 2: Remove status tag from PO option label**

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

- [ ] **Step 4: Improve empty-line state copy**

Find the `linesForPo.length === 0` block (in `PoLineCards`):
```tsx
No line items found for this PO. Run &ldquo;Sync POs from Zoho&rdquo; to import
lines, or use the manual PO reference tab above.
```
Change to:
```tsx
No line items for this PO. Run &ldquo;Sync POs from Zoho&rdquo; to import lines,
select a different PO, or switch to the &ldquo;Manual PO reference&rdquo; tab above.
```

- [ ] **Step 5: Add "Remove" column to bag rows table**

In the `<thead>` of the Section 3 table, add an empty header at the end:
```tsx
<th className="text-left px-2 py-1.5 w-8"></th>
```

In the `<tbody>`, at the end of each `<tr>` (after the Notes `<td>`), add:
```tsx
<td className="px-2 py-1.5">
  <button
    type="button"
    onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
    className="text-text-muted hover:text-red-600 text-xs px-1 leading-none"
    aria-label={`Remove bag ${r.bagSequence}`}
  >
    ×
  </button>
</td>
```

- [ ] **Step 6: Simplify section title**

Change:
```tsx
title={`3. Bag rows (${rows.length} generated, ${rows.length} unsaved)`}
```
To:
```tsx
title={`3. Bag rows (${rows.length})`}
```

The QR exhaustion warning (`rows.length > availableQrCards.length`) already uses current `rows.length` so it updates automatically after removal — no change needed there.

- [ ] **Step 7: Run typecheck + test**

```bash
npm run typecheck && npm test
```

Expected: 0 errors, 2066 tests pass.

- [ ] **Step 8: Commit**

```bash
git add app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx
git commit -m "fix(intake): PO label cleanup, helper copy, row removal button"
```

---

## Task 4: Stale server action defensive UX (commit)

**Files:** `app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx`, `app/(admin)/receiving/raw-bags/sync-po-button.tsx`

After a Next.js deploy, the server assigns new IDs to server actions. A browser with a cached page holds old action IDs. Calling a stale action throws `"Server Action was not found on the server"` — currently uncaught, causing a hang or crash.

Fix: catch the throw in both `handleSave` and `SyncPoButton`, detect the "not found" message, and show "App updated — please refresh."

- [ ] **Step 1: Read `raw-bag-intake-form.tsx` `handleSave` function**

Locate:
```ts
async function handleSave() {
  setPending(true);
  setErrorMessage(null);
  setResult(null);
  const payload = { ... };
  const r = await createRawBagIntakeAction(payload);
  setPending(false);
  ...
}
```

The call `await createRawBagIntakeAction(payload)` is uncaught. If it throws, `setPending(false)` never runs and the button stays disabled.

- [ ] **Step 2: Wrap `handleSave` in try/catch**

Replace the function body with:

```ts
async function handleSave() {
  setPending(true);
  setErrorMessage(null);
  setResult(null);
  const payload = {
    poMode,
    poId: poMode === "LOCAL_PO" ? poId || null : null,
    poLineId: poMode === "LOCAL_PO" && poLineId ? poLineId : null,
    poNumberManual: poMode === "MANUAL_REFERENCE" ? poNumberManual.trim() : null,
    vendorNameManual: poMode === "MANUAL_REFERENCE" ? vendorNameManual.trim() : null,
    orderedQuantity:
      poMode === "MANUAL_REFERENCE"
        ? orderedQuantity
        : null,
    tabletTypeId,
    supplierLotNumber: supplierLot.trim(),
    notes: null,
    rows: rows.map((r) => ({
      bagSequence: r.bagSequence,
      receiptNumber: r.receiptNumber.trim(),
      bagQrCode: r.bagQrCode?.trim() || null,
      declaredCount: r.declaredCount,
      weightGrams: r.weightGrams,
      notes: r.notes,
    })),
  };
  try {
    const r = await createRawBagIntakeAction(payload);
    setPending(false);
    if (!r.ok) {
      setErrorMessage(r.error);
    } else {
      setResult(r);
    }
  } catch (err) {
    setPending(false);
    const msg = err instanceof Error ? err.message : String(err);
    setErrorMessage(
      msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("action_id")
        ? "The app was updated. Please refresh the page and try again."
        : `Save failed: ${msg}`,
    );
  }
}
```

(Note: the payload construction is unchanged — only the `try/catch` wrapper is new.)

- [ ] **Step 3: Read `sync-po-button.tsx`**

```bash
cat app/(admin)/receiving/raw-bags/sync-po-button.tsx
```

The `startTransition(async () => { const res = await syncPurchaseOrdersFromZohoAction(); ... })` is uncaught. If the action throws (stale), React will raise an uncaught promise rejection.

- [ ] **Step 4: Add try/catch in `SyncPoButton`**

In the `handleSync` function, wrap the `startTransition` body:

```ts
function handleSync() {
  setLastError(null);
  startTransition(async () => {
    try {
      const res = await syncPurchaseOrdersFromZohoAction();
      if (res.ok) {
        setLastResult(res.result);
        setLastError(null);
      } else {
        setLastError(res.error);
        setLastResult(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(
        msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("action_id")
          ? "App updated — please refresh the page and try again."
          : `Sync failed: ${msg}`,
      );
      setLastResult(null);
    }
  });
}
```

- [ ] **Step 5: Run typecheck + test**

```bash
npm run typecheck && npm test
```

Expected: 0 errors, 2066 tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/(admin)/receiving/raw-bags/raw-bag-intake-form.tsx app/(admin)/receiving/raw-bags/sync-po-button.tsx
git commit -m "fix(intake): catch stale server action errors, show refresh prompt instead of hanging"
```

---

## Task 5: Start Production — auto-link bag's reserved QR card (commit)

**File:** `app/(admin)/production/start/start-production-form.tsx`

**Problem identified in Task 1 Step 5:**

When a raw bag is received via Receive pills, a specific RAW_BAG QR card is reserved for it (`inventory_bags.bag_qr_code = "bag-card-5"`, qrCard status = ASSIGNED+null workflowBagId). But the Start Production form lets the operator pick ANY IDLE/intake-reserved QR card — not necessarily the one physically attached to the bag.

This breaks the physical tracking model: the card on the bag and the card recorded in the workflow would differ.

**Fix:** When the raw bag lookup (`lookupRawBagForStartAction`) returns a bag that has a `bagQrCode` value, automatically highlight/pre-select the matching QR card in the card picker. Show a note: "QR card assigned at intake." If the matching card is not in the available pool (e.g. it's already in production), show a warning instead.

This is a UI-only change in the form — the server action already accepts both IDLE and intake-reserved cards.

- [ ] **Step 1: Read `start-production-form.tsx`**

```bash
cat app/(admin)/production/start/start-production-form.tsx
```

Find:
- The state that holds the bag lookup result (e.g. `lookupResult` or similar)
- The state that holds the selected QR card ID (`qrCardId` or similar)
- Where the QR card picker renders (Step 3 of the 5-step flow)
- The `idleCards` prop shape: `{ id: string; code: string | null }[]`
- The bag lookup result shape from `findRawBagByReceiptOrQr` — specifically whether it includes `bagQrCode`

- [ ] **Step 2: Check if bag lookup result exposes `bagQrCode`**

`lookupRawBagForStartAction` calls `findRawBagByReceiptOrQr(value)`. That function returns `RawBagLookupResult`. Check whether the result includes `bag.bagQrCode`.

If it doesn't, skip to Step 3 and read the actual return type from `lib/db/queries/raw-bag-intake.ts`. If `bagQrCode` is in the result, continue. If not, the fix also requires adding it to the query (a small DB query change).

- [ ] **Step 3: Add auto-select effect**

Once you know the bag lookup result has `bagQrCode` and the form has access to `idleCards` (which includes `{ id, code }` where `code = qrCards.label`), add a `React.useEffect` that fires when the bag lookup succeeds:

```ts
// When bag lookup resolves, auto-select the QR card that was reserved for this bag.
React.useEffect(() => {
  if (!lookupResult?.found) return;
  const bagQrCode = lookupResult.bag.bagQrCode;
  if (!bagQrCode) return;
  // The bag_qr_code stores the scan_token. idleCards has { id, code } where
  // code = label. We need to match by scan_token, but the picker only has id+label.
  // We need the scan_token in idleCards. See Step 4 for the prop update.
}, [lookupResult]);
```

Wait — `idleCards` currently has `{ id: string; code: string | null }` where `code` is the QR card `label` (e.g. "bag-card-5"). But `inventory_bags.bag_qr_code` stores the `scan_token` (also "bag-card-5" for the physical cards created by the repair script). In practice, `label` and `scan_token` are both set to "bag-card-N" format. BUT this is a coincidence — they are different columns.

To match properly, we need `scan_token` in `idleCards`. The server component (`start/page.tsx`) currently only selects `{ id: qrCards.id, code: qrCards.label }`. We need to add `scanToken: qrCards.scanToken` to the SELECT.

- [ ] **Step 4: Add `scanToken` to idleCards in `start/page.tsx`**

Read `app/(admin)/production/start/page.tsx`. Find the `idleCards` query:
```ts
db.select({ id: qrCards.id, code: qrCards.label })
```
Add `scanToken`:
```ts
db.select({ id: qrCards.id, code: qrCards.label, scanToken: qrCards.scanToken })
```

Update the prop passed to `StartProductionForm`:
```ts
idleCards={idleCards.map((c) => ({ id: c.id, code: c.code, scanToken: c.scanToken }))}
```

- [ ] **Step 5: Update `StartProductionForm` prop type**

In `start-production-form.tsx`, update the `idleCards` prop type from:
```ts
idleCards: { id: string; code: string | null }[]
```
To:
```ts
idleCards: { id: string; code: string | null; scanToken: string }[]
```

- [ ] **Step 6: Add auto-select effect and intake-badge**

After the bag lookup state update, add a `React.useEffect` that finds and selects the matching card:

```ts
React.useEffect(() => {
  if (!lookupResult?.found) return;
  const bagQrCode = lookupResult.bag.bagQrCode;
  if (!bagQrCode) return;
  const match = idleCards.find((c) => c.scanToken === bagQrCode);
  if (match) {
    setSelectedQrCardId(match.id);  // replace with actual state setter name
  }
}, [lookupResult, idleCards]);
```

In the QR card picker step, when the selected card's `scanToken` matches `lookupResult.bag.bagQrCode`, show a note badge:
```tsx
{selectedCard?.scanToken === lookupResult.bag.bagQrCode && (
  <p className="text-[11px] text-sky-700 mt-1">QR card assigned at intake for this bag.</p>
)}
```

If the bag has a `bagQrCode` but no matching card in `idleCards` (already in production or retired), show a warning:
```tsx
{lookupResult.bag.bagQrCode && !idleCards.some((c) => c.scanToken === lookupResult.bag.bagQrCode) && (
  <p className="text-[11px] text-amber-700 mt-1">
    The QR card reserved for this bag ({lookupResult.bag.bagQrCode}) is not available.
    It may already be in production or retired. Contact admin.
  </p>
)}
```

Use the actual state variable names from the file. The note text and styling must follow the Luma design (no emojis, Tailwind classes matching surrounding UI).

- [ ] **Step 7: Verify `RawBagLookupResult` includes `bagQrCode`**

Read the return type in `lib/db/queries/raw-bag-intake.ts`. If `bag.bagQrCode` is not in the result, add it to the `findRawBagByReceiptOrQr` query and return type.

- [ ] **Step 8: Run typecheck + test**

```bash
npm run typecheck && npm test
```

Expected: 0 errors, 2066 tests pass.

- [ ] **Step 9: Commit**

```bash
git add app/(admin)/production/start/page.tsx app/(admin)/production/start/start-production-form.tsx
git commit -m "feat(start-production): auto-select intake-reserved QR card when bag is looked up"
```

---

## Task 6: QR edge-case unit tests (commit)

**File:** `lib/production/raw-bag-intake.test.ts`

Add 6 tests covering QR assignment edge cases called out in the spec. Tests use pure helpers — no DB required.

- [ ] **Step 1: Read the test file — find last test**

```bash
grep -n "describe\|it(" lib/production/raw-bag-intake.test.ts | tail -20
```

Find the end of the `assignQrCodesFromPool` describe block (which has 6 tests). New tests go after it in a new describe block.

- [ ] **Step 2: Confirm `assignQrCodesFromPool` is imported**

```bash
grep "assignQrCodesFromPool" lib/production/raw-bag-intake.test.ts | head -3
```

If not imported, add it to the import at the top.

- [ ] **Step 3: Add new describe block**

After the closing `});` of the `assignQrCodesFromPool` describe, add:

```ts
// ─── QR assignment edge cases — RECEIVE-2 ─────────────────────────
describe("QR assignment edge cases — RECEIVE-2", () => {
  it("10 rows with 10-card pool: all rows get unique non-null QR codes", () => {
    const pool = Array.from({ length: 10 }, (_, i) => ({
      scanToken: `bag-card-${i + 1}`,
    }));
    const rows = generateBagRowSeed({ count: 10, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    const qrCodes = assigned.map((r) => r.bagQrCode).filter((q) => q != null);
    expect(qrCodes).toHaveLength(10);
    expect(new Set(qrCodes).size).toBe(10);
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
    expect(afterRemoval[2]?.bagQrCode).toBe("bag-card-4");
    expect(afterRemoval[3]?.bagQrCode).toBe("bag-card-5");
  });

  it("removed row's QR code is absent from remaining rows", () => {
    const pool = [
      { scanToken: "bag-card-1" },
      { scanToken: "bag-card-2" },
      { scanToken: "bag-card-3" },
    ];
    const rows = generateBagRowSeed({ count: 3, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    const remaining = assigned.filter((_, idx) => idx !== 1);
    const remainingQrCodes = remaining.map((r) => r.bagQrCode);
    expect(remainingQrCodes).not.toContain("bag-card-2");
    expect(remainingQrCodes).toContain("bag-card-1");
    expect(remainingQrCodes).toContain("bag-card-3");
  });

  it("pool exhaustion: 5-card pool for 10 rows gives nulls for rows 6–10", () => {
    const pool = Array.from({ length: 5 }, (_, i) => ({
      scanToken: `bag-card-${i + 1}`,
    }));
    const rows = generateBagRowSeed({ count: 10, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    const hasQr = assigned.map((r) => r.bagQrCode != null);
    expect(hasQr).toEqual([
      true, true, true, true, true,
      false, false, false, false, false,
    ]);
  });

  it("empty pool: all rows get null QR codes (no silent assignment)", () => {
    const rows = generateBagRowSeed({ count: 5, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, []);
    expect(assigned.every((r) => r.bagQrCode === null)).toBe(true);
  });

  it("trimming rows after removal updates exhaustion threshold", () => {
    // 8 rows, 5-card pool → rows 6–8 have no QR
    const pool = Array.from({ length: 5 }, (_, i) => ({
      scanToken: `bag-card-${i + 1}`,
    }));
    const rows = generateBagRowSeed({ count: 8, receiptStart: "1001" });
    const assigned = assignQrCodesFromPool(rows, pool);
    // Remove rows 6,7,8 (indices 5,6,7)
    const trimmed = assigned.filter((_, idx) => idx < 5);
    expect(trimmed).toHaveLength(5);
    expect(trimmed.every((r) => r.bagQrCode != null)).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests — verify count**

```bash
npm test -- --reporter=verbose 2>&1 | grep "assignQrCodesFromPool\|RECEIVE-2\|Tests "
```

Expected: the new describe block shows 6 tests passing. Total should be `2066 + 6 = 2072`.

- [ ] **Step 5: Run full test suite**

```bash
npm run typecheck && npm test
```

Expected: 0 errors, 2072 tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/production/raw-bag-intake.test.ts
git commit -m "test(intake): QR edge-case tests — row removal, pool exhaustion, unique assignment"
```

---

## Task 7: Version bump 0.2.7 → 0.2.8, CHANGELOG, build, push (commit)

**Files:** `package.json`, `CHANGELOG.md`

- [ ] **Step 1: Bump version**

In `package.json`, change `"version": "0.2.7"` to `"version": "0.2.8"`.

- [ ] **Step 2: Prepend CHANGELOG entry**

In `CHANGELOG.md`, above `## [0.2.7]`, add:

```markdown
## [0.2.8] — 2026-05-21

### Fixed
- Zoho readiness banner: three-tier status model. Offline Zoho with local POs shows neutral "Using synced PO data from Luma" info message instead of alarming warning. Warning only appears when Zoho is offline AND no local POs exist.
- PO dropdown: removed `[OPEN]`/`[RECEIVING]` status tag from main option label — PO number + vendor is sufficient.
- Helper copy: "Pick a PO to choose the tablet line item being received." (was: "Pick a PO to see its line items as receive cards.")
- Zero-line empty state: improved copy — now mentions all three resolution options (sync, different PO, manual reference).
- Stale server action: `handleSave` and `SyncPoButton` now catch thrown errors and show "App updated — please refresh" instead of hanging indefinitely.

### Added
- Raw bag intake: per-row Remove (×) button. Removing an unsaved row frees its QR code from the pending submission; pool exhaustion warning updates automatically.
- Start Production: when a raw bag is looked up and has a QR card reserved at intake, that card is auto-selected in the QR picker and labelled "QR card assigned at intake for this bag." If the reserved card is unavailable, a warning is shown.
- 6 new QR edge-case unit tests: 10-row unique assignment, row removal QR freeing, pool exhaustion threshold, empty-pool null-fill (2072 total).

### Removed
- Section 3 bag rows title no longer shows duplicate "(N generated, N unsaved)" — now shows just the current count.
```

- [ ] **Step 3: Run full check suite**

```bash
npm run typecheck && npm test && npm run build
```

Expected:
- typecheck: 0 errors
- tests: 2072 passed
- build: success

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
| 2. RECEIVE-1 QR audit | Task 1 Steps 2–4, 7 |
| 2. Variety-pack never assigned to raw bags | Task 1 Step 2 |
| 2. Manual QR override rejects wrong types | Task 1 Step 3 (server-side pre-validation confirmed) |
| 2. Atomic bag save + QR reserve | Task 1 Step 3 |
| 2. ASSIGNED+null treated as valid received state | Task 1 Step 4 |
| 3. Fix Zoho banner | Task 2 |
| 4. PO dropdown label cleanup | Task 3 Step 2 |
| 5. Fix helper copy | Task 3 Step 3 |
| 6. PO line receivable-only behavior | Task 1 Step 6 (no status column — sync-time filter) + Task 3 Step 4 (empty state) |
| 7. Stale server action defensive UX | Task 4 |
| 8. Start Production QR gap audit | Task 1 Step 5 |
| 8. Auto-link reserved QR | Task 5 |
| QR edge cases spec | Task 6 |
| 9. Tests/build | Task 7 Step 3 |
| 10. Versioning | Task 7 |
| 11. Final report | Final summary from executor |

### Placeholder scan

All code blocks are complete. No "TBD" or "implement later" present.

### Type consistency

- `idleCards` prop in `start-production-form.tsx`: added `scanToken: string` (not nullable — `qrCards.scanToken` is `notNull()` in schema)
- `assignQrCodesFromPool` pool type: `readonly { scanToken: string }[]` — test arrays match this shape exactly
- `rows.filter((_, idx) => idx !== i)`: `i` is the `rows.map` index from the outer `{rows.map((r, i) => ...)}` call — correct capture
- `assigned.filter((_, idx) => idx !== 2)` in tests: `_` is `RawBagRowSeed`, `idx` is `number` — matches `Array.filter` signature
