# FLOOR-START-3: Floor Station Start-Flow Correctness + Receive List Clarity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the floor production-start workflow (correct first-op station eligibility, server-side guards, downstream station UX) and add a product/flavor column to the receives list.

**Architecture:** Three orthogonal fixes: (1) `first-op-product.ts` helper gets BOTTLE_HANDPACK added; `scanCardAction` gets a server-side guard rejecting fresh-bag starts at downstream stations; the admin action gets the same guard. (2) Floor station page and `ScanCardForm` get a downstream-station message and updated copy. (3) `listReceives` query gets a tablet-type subquery and the inbound page gets a new column.

**Tech Stack:** Next.js 15 App Router, Drizzle ORM, TypeScript strict, Vitest, Tailwind v3.

**Current state at task start:** branch=main, version=0.2.28, 2228 tests pass, build clean.

---

## File Map

| File | Change |
|---|---|
| `lib/production/first-op-product.ts` | Add BOTTLE_HANDPACK to FIRST_OP_STATION_KINDS |
| `lib/production/first-op-product.test.ts` | Add BOTTLE_HANDPACK tests; update non-first-op describe block |
| `app/(floor)/floor/[token]/actions.ts` | Add FRESH_BAG_STATION_KINDS constant + guard in fresh-scan path |
| `app/(admin)/production/start/actions.ts` | Import FIRST_OP_STATION_KINDS; add station-kind guard |
| `app/(admin)/production/start/page.tsx` | Filter station dropdown to first-op only; update description |
| `app/(floor)/floor/[token]/page.tsx` | Use FIRST_OP_STATION_KINDS for canStartFreshBag; update no-bag copy |
| `app/(floor)/floor/[token]/scan-card-form.tsx` | Downstream station message; update placeholder + optgroup label |
| `lib/db/queries/receives.ts` | Add tabletTypes subquery to listReceives |
| `app/(admin)/inbound/page.tsx` | Add Tablet type column |
| `package.json` | Bump patch version |
| `CHANGELOG.md` | Document changes |

---

## Task 1: Safety check + audit (read-only)

**Files:** none

- [ ] **Step 1: Run safety check**

```bash
git status && git log --oneline -3 && grep '"version"' package.json
```

Expected: branch=main, clean, version=0.2.28, most recent commit = FLOOR-START-2 camera scanning.

- [ ] **Step 2: Check tests pass**

```bash
npm test -- --reporter=dot 2>&1 | tail -5
```

Expected: 2228 passing.

- [ ] **Step 3: Verify deployed version**

```bash
curl -s http://192.168.1.134:3000/ 2>/dev/null | grep -o 'v[0-9]*\.[0-9]*\.[0-9]*' | head -1 || echo "not reachable"
```

Expected: v0.2.27 or v0.2.28 (deploy timer may not have run yet).

- [ ] **Step 4: Report audit findings**

Based on code review (already done for planning), report:

**What `/admin/production/start` does:**
- Admin supervisor scans a raw bag receipt # or BAG-uuid token.
- Picks station from ALL active stations (gap: downstream stations shown).
- Product auto-resolved by tablet type + station kind.
- Fires CARD_ASSIGNED + PRODUCT_MAPPED events, creating the workflow bag.
- `startProductionForRawBagAction` checks: bag AVAILABLE, no open session, has bagQrCode, station active — but does NOT check station kind (gap).

**What `/floor/[token]` does:**
- Floor tablet page for operators. Station identified by URL scan token.
- Shows `ScanCardForm` when no bag is active. Dropdown shows RAW_BAG idle cards at first-op stations, eligible pickups at downstream stations.
- `canStartFreshBag` correctly blocks downstream stations from showing idle card UI.
- `scanCardAction` server action handles card scans. On fresh-scan path calls `checkFirstOpProductSelection` which returns `ok: true, productId: null` for non-first-op stations with IDLE card — **no server-side rejection of fresh starts at downstream stations** (gap).

**Mismatches found:**
1. `FIRST_OP_STATION_KINDS` = {BLISTER, HANDPACK_BLISTER, COMBINED} — missing BOTTLE_HANDPACK even though UI's `canStartFreshBag` includes it and `STATION_KIND_TO_PRODUCT_KINDS` maps it to BOTTLE/VARIETY.
2. `scanCardAction` allows fresh-bag starts at SEALING/PACKAGING server-side (guard only in UI).
3. Admin `startProductionForRawBagAction` allows any active station — no first-op check.
4. Admin station dropdown shows all stations — no first-op filter.
5. Floor downstream station shows no explanatory message when no fresh bag / pickup available.
6. Dropdown placeholder "Select an eligible bag QR…" — spec wants "Select a received bag QR…".
7. Receives list has no product/flavor/tablet type column.

Do not commit at this step.

---

## Task 2: Fix `FIRST_OP_STATION_KINDS` — add BOTTLE_HANDPACK

**Files:**
- Modify: `lib/production/first-op-product.ts`
- Modify: `lib/production/first-op-product.test.ts`

- [ ] **Step 1: Write failing test for BOTTLE_HANDPACK in FIRST_OP_STATION_KINDS**

In `lib/production/first-op-product.test.ts`, add inside the `"first-op product selection — registry sanity"` describe block (after the last `it()`):

```typescript
  it("BOTTLE_HANDPACK is a first-op station kind", () => {
    expect(FIRST_OP_STATION_KINDS.has("BOTTLE_HANDPACK")).toBe(true);
  });

  it("BOTTLE_HANDPACK is NOT a downstream-only kind", () => {
    expect(FIRST_OP_STATION_KINDS.has("SEALING")).toBe(false);
    expect(FIRST_OP_STATION_KINDS.has("BOTTLE_CAP_SEAL")).toBe(false);
    expect(FIRST_OP_STATION_KINDS.has("BOTTLE_STICKER")).toBe(false);
    expect(FIRST_OP_STATION_KINDS.has("PACKAGING")).toBe(false);
  });
```

Also add a new describe block at the bottom of the file:

```typescript
describe("first-op product selection — BOTTLE_HANDPACK station", () => {
  it("requires productId for IDLE card at BOTTLE_HANDPACK", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BOTTLE_HANDPACK",
      cardStatus: "IDLE",
      pickedProductId: null,
      product: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Pick a product/);
  });

  it("accepts BOTTLE product at BOTTLE_HANDPACK", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BOTTLE_HANDPACK",
      cardStatus: "IDLE",
      pickedProductId: ACTIVE_BOTTLE.id,
      product: ACTIVE_BOTTLE,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.productId).toBe(ACTIVE_BOTTLE.id);
  });

  it("accepts VARIETY product at BOTTLE_HANDPACK", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BOTTLE_HANDPACK",
      cardStatus: "IDLE",
      pickedProductId: ACTIVE_VARIETY.id,
      product: ACTIVE_VARIETY,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.productId).toBe(ACTIVE_VARIETY.id);
  });

  it("rejects CARD product at BOTTLE_HANDPACK (wrong kind)", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BOTTLE_HANDPACK",
      cardStatus: "IDLE",
      pickedProductId: ACTIVE_CARD.id,
      product: ACTIVE_CARD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cannot start at a BOTTLE_HANDPACK station/);
  });

  it("does NOT require product for ASSIGNED card at BOTTLE_HANDPACK (pickup path)", () => {
    const r = checkFirstOpProductSelection({
      stationKind: "BOTTLE_HANDPACK",
      cardStatus: "ASSIGNED",
      pickedProductId: null,
      product: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.productId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/production/first-op-product.test.ts 2>&1 | tail -20
```

Expected: FAIL — "BOTTLE_HANDPACK is a first-op station kind" fails because BOTTLE_HANDPACK not in set yet.

- [ ] **Step 3: Add BOTTLE_HANDPACK to FIRST_OP_STATION_KINDS**

In `lib/production/first-op-product.ts`, change line 17-21:

```typescript
export const FIRST_OP_STATION_KINDS: ReadonlySet<string> = new Set([
  "BLISTER",
  "HANDPACK_BLISTER",
  "BOTTLE_HANDPACK",
  "COMBINED",
]);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/production/first-op-product.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
npm test -- --reporter=dot 2>&1 | tail -5
```

Expected: all 2228+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/production/first-op-product.ts lib/production/first-op-product.test.ts
git commit -m "fix(first-op): add BOTTLE_HANDPACK to FIRST_OP_STATION_KINDS

Bottle hand-pack is a first-operation station — fresh bag scans there
must record a BOTTLE/VARIETY product, same as BLISTER. The set was
missing BOTTLE_HANDPACK, causing product selection to be silently
skipped for bottle-route fresh starts.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Server-side fresh-bag guard in `scanCardAction` + admin action

**Files:**
- Modify: `app/(floor)/floor/[token]/actions.ts`
- Modify: `app/(admin)/production/start/actions.ts`

- [ ] **Step 1: Add FRESH_BAG_STATION_KINDS constant and guard in actions.ts**

In `app/(floor)/floor/[token]/actions.ts`, add near the top with the other constants (after line 37, before the `resolveStation` function):

```typescript
// Stations that can START a fresh bag (IDLE or intake-reserved ASSIGNED).
// Downstream stations (SEALING, PACKAGING, etc.) must only pick up bags
// that have already been released to them by a prior station.
const FRESH_BAG_STATION_KINDS: ReadonlySet<string> = new Set([
  "BLISTER",
  "HANDPACK_BLISTER",
  "BOTTLE_HANDPACK",
  "COMBINED",
]);
```

Then in the `scanCardAction` function, in the fresh-scan branch (the `if (card.status === "IDLE" || ...)` block, currently around line 166), add a guard immediately after computing `isFreshStart` (after line 189):

```typescript
      if (isFreshStart && !FRESH_BAG_STATION_KINDS.has(station.kind)) {
        throw new Error(
          "This station does not start fresh bags. Scan a bag that has already been released to this station.",
        );
      }
```

Also in the partial-bag resume path (the `if (!isPartialBagResume(...))` else branch, around line 296+), add the same guard right before the `checkFirstOpProductSelection` call:

```typescript
          if (!FRESH_BAG_STATION_KINDS.has(station.kind)) {
            throw new Error(
              "This station does not start fresh bags. Scan a bag that has already been released to this station.",
            );
          }
```

- [ ] **Step 2: Add station-kind guard in admin action**

In `app/(admin)/production/start/actions.ts`, add import at top:

```typescript
import { FIRST_OP_STATION_KINDS } from "@/lib/production/first-op-product";
```

Then after the existing station active check (after line ~141: `if (!station.isActive) { return { ok: false, error: ... }; }`), add:

```typescript
  if (!FIRST_OP_STATION_KINDS.has(station.kind)) {
    return {
      ok: false,
      error: `Station "${station.label}" (${station.kind}) cannot start fresh bags. Select a first-operation station (blister, bottle handpack, or combined).`,
    };
  }
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Run full tests**

```bash
npm test -- --reporter=dot 2>&1 | tail -5
```

Expected: all tests pass (2228+).

- [ ] **Step 5: Commit**

```bash
git add "app/(floor)/floor/[token]/actions.ts" "app/(admin)/production/start/actions.ts"
git commit -m "fix(floor): server-side guard — reject fresh-bag starts at downstream stations

scanCardAction now rejects IDLE/intake-reserved card scans at SEALING,
PACKAGING, BOTTLE_CAP_SEAL, BOTTLE_STICKER, and any other non-first-op
station. Previously the guard was UI-only (canStartFreshBag in page.tsx);
a hand-crafted POST could bypass it. Admin startProductionForRawBagAction
gets the same check: only BLISTER/HANDPACK_BLISTER/BOTTLE_HANDPACK/COMBINED
can start a fresh bag.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Admin start-production — filter station dropdown + update copy

**Files:**
- Modify: `app/(admin)/production/start/page.tsx`

- [ ] **Step 1: Update page.tsx to filter stations + update description**

In `app/(admin)/production/start/page.tsx`, add the import for `FIRST_OP_STATION_KINDS` and `inArray`:

At the top, the file imports from `drizzle-orm`:
```typescript
import { asc, eq, inArray } from "drizzle-orm";
```

And add import for the constant:
```typescript
import { FIRST_OP_STATION_KINDS } from "@/lib/production/first-op-product";
```

Then change the `activeStations` query to filter by station kind:
```typescript
    db
      .select({ id: stations.id, label: stations.label, kind: stations.kind })
      .from(stations)
      .where(
        and(
          eq(stations.isActive, true),
          inArray(stations.kind, [...FIRST_OP_STATION_KINDS] as ("BLISTER" | "HANDPACK_BLISTER" | "BOTTLE_HANDPACK" | "COMBINED")[]),
        ),
      )
      .orderBy(asc(stations.label)),
```

Also import `and` from drizzle-orm if not already imported.

Update the `PageHeader` description prop to clarify admin-fallback purpose:
```tsx
description="Supervisor fallback path. For day-to-day production, operators scan bag QRs at the floor station. Use this page if a bag couldn't start from the floor — e.g., scanner issue or misconfigured station. Scans the raw bag, selects a first-operation station, confirms the product, and fires CARD_ASSIGNED."
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Run full tests**

```bash
npm test -- --reporter=dot 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add "app/(admin)/production/start/page.tsx"
git commit -m "fix(admin): filter start-production stations to first-op only

Admin Start Production is a supervisor fallback path. The station
dropdown now shows only BLISTER/HANDPACK_BLISTER/BOTTLE_HANDPACK/
COMBINED stations — downstream stations cannot start fresh bags and
were confusing to show. Updated description copy to clarify this page
is not the day-to-day operator path.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Floor station UX — downstream message + copy

**Files:**
- Modify: `app/(floor)/floor/[token]/page.tsx`
- Modify: `app/(floor)/floor/[token]/scan-card-form.tsx`

- [ ] **Step 1: Update `canStartFreshBag` in page.tsx to use imported constant**

In `app/(floor)/floor/[token]/page.tsx`, `FIRST_OP_STATION_KINDS` is already imported from `@/lib/production/first-op-product` (line 31). Change the `canStartFreshBag` computation (currently lines 90-92) from the hardcoded set to:

```typescript
  const canStartFreshBag = FIRST_OP_STATION_KINDS.has(station.station.kind);
```

This removes the duplicate hardcoded set and makes `canStartFreshBag` consistent with `FIRST_OP_STATION_KINDS` now that BOTTLE_HANDPACK is included.

- [ ] **Step 2: Update no-bag copy in page.tsx to be station-aware**

In `page.tsx`, find the "No bag at this station" paragraph (currently around line 272):
```tsx
<p className="text-sm text-text-muted mb-3">
  No bag at this station. Scan a bag QR or select one below.
</p>
```

Change it to:
```tsx
<p className="text-sm text-text-muted mb-3">
  {canStartFreshBag
    ? "No bag at this station. Scan a received bag QR or select one below."
    : "No bag at this station. This station accepts bags released from a prior stage."}
</p>
```

- [ ] **Step 3: Add downstream station hint in scan-card-form.tsx**

In `app/(floor)/floor/[token]/scan-card-form.tsx`, add a note below the scan input row (after the `{scanError && ...}` block and before the dropdown section) when the station is downstream and has no pickups:

```tsx
{!canStartFreshBag && !hasPickups && (
  <p className="text-xs text-text-muted rounded-lg border border-border/70 bg-surface px-3 py-2">
    This station only accepts bags already routed here. Scan the bag QR when it arrives at this station.
  </p>
)}
```

- [ ] **Step 4: Update idle card dropdown placeholder and optgroup label**

In `scan-card-form.tsx`, change the `<option value="" disabled>` placeholder:

```tsx
<option value="" disabled>
  Select a received bag QR…
</option>
```

Change the idle cards optgroup label:

```tsx
<optgroup label={hasPickups ? "Received bags — start new" : "Received bags"}>
```

(Was: `{hasPickups ? "Start a new bag" : "Eligible bag QRs"}`)

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 6: Run full tests**

```bash
npm test -- --reporter=dot 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add "app/(floor)/floor/[token]/page.tsx" "app/(floor)/floor/[token]/scan-card-form.tsx"
git commit -m "feat(floor): downstream station message + copy cleanup

- canStartFreshBag now uses imported FIRST_OP_STATION_KINDS (no more
  hardcoded duplicate set) — BOTTLE_HANDPACK included automatically.
- No-bag copy is now station-aware: downstream stations say 'accepts
  bags released from a prior stage' instead of 'select one below'.
- ScanCardForm shows an inline hint at downstream stations when no
  eligible pickups exist: 'scan the bag QR when it arrives'.
- Idle card dropdown: placeholder updated to 'Select a received bag
  QR…'; optgroup label updated to 'Received bags' / 'Received bags —
  start new'.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Receives list — add tablet type column

**Files:**
- Modify: `lib/db/queries/receives.ts`
- Modify: `app/(admin)/inbound/page.tsx`

- [ ] **Step 1: Update `listReceives` to include tablet type subquery**

In `lib/db/queries/receives.ts`, change the `listReceives` function. The current query does not include tablet type. Add a `tabletTypes` SQL subquery field:

```typescript
export async function listReceives() {
  return db
    .select({
      receive: receives,
      poNumber: purchaseOrders.poNumber,
      vendor: purchaseOrders.vendorName,
      bagCount: sql<number>`(
        SELECT COUNT(*)::int FROM inventory_bags ib
        JOIN small_boxes sb ON sb.id = ib.small_box_id
        WHERE sb.receive_id = ${receives.id}
      )`,
      tabletTypes: sql<string | null>`(
        SELECT STRING_AGG(DISTINCT tt.name, ', ' ORDER BY tt.name)
        FROM small_boxes sb
        JOIN tablet_types tt ON tt.id = sb.default_tablet_type_id
        WHERE sb.receive_id = ${receives.id}
      )`,
    })
    .from(receives)
    .leftJoin(purchaseOrders, eq(receives.poId, purchaseOrders.id))
    .orderBy(desc(receives.receivedAt));
}
```

The `STRING_AGG` subquery returns comma-separated distinct tablet type names for the receive (e.g. "MIT B Orange Citrus" for a single-type receive, or "MIT B Chocolate Brown, MIT B Orange Citrus" for a multi-type receive). Returns null for receives with no small boxes yet.

- [ ] **Step 2: Run tests to verify query type changes don't break existing tests**

```bash
npm test -- --reporter=dot 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 3: Add Tablet type column to inbound page**

In `app/(admin)/inbound/page.tsx`, update the `THead` row to add a new `<TH>`:

```tsx
<TR>
  <TH>Receive</TH>
  <TH>PO</TH>
  <TH>Vendor</TH>
  <TH>Tablet type</TH>
  <TH>Received</TH>
  <TH className="text-right">Bags</TH>
  <TH>Status</TH>
</TR>
```

Update the `rows.map(...)` to use the new `tabletTypes` field. The destructure currently is:
```tsx
{rows.map(({ receive, poNumber, vendor, bagCount }) => (
```
Change to:
```tsx
{rows.map(({ receive, poNumber, vendor, bagCount, tabletTypes }) => (
```

And add the new cell after the Vendor cell:
```tsx
<TD className="text-muted text-xs">{tabletTypes ?? "—"}</TD>
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | tail -5
```

Expected: no errors. The `tabletTypes` field is `string | null` from `sql<string | null>`.

- [ ] **Step 5: Run full tests**

```bash
npm test -- --reporter=dot 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/db/queries/receives.ts "app/(admin)/inbound/page.tsx"
git commit -m "feat(inbound): add Tablet type column to receives list

Multiple receives for the same PO now show distinct tablet type names
so operators can tell them apart (e.g. 'MIT B Orange Citrus' vs 'MIT B
Green Apple'). Uses STRING_AGG(DISTINCT ...) over small_boxes →
tablet_types. Multi-type receives show comma-separated names.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Machine/station cleanup note

**Files:**
- Modify: `CHANGELOG.md` (add a Notes section)

- [ ] **Step 1: Add planning note to CHANGELOG**

After writing the [0.2.29] section in the CHANGELOG (in the next task), add a "## Planned" section above the version entries:

```markdown
<!-- FUTURE: Machine vs station model cleanup
  Machines are physical equipment with output/cycle characteristics.
  Stations are floor scan locations / URLs.
  Hand-pack stations probably should be stations, not machines, unless
  they need machine-like output config. There is visible duplication on
  the Machines & stations admin page. This needs a future cleanup task.
-->
```

Place this as an HTML comment at the top of CHANGELOG.md (after the `# Changelog` heading).

This is a planning note only — no code changes.

- [ ] **Step 2: No commit for this step; fold it into the versioning commit in Task 8.**

---

## Task 8: Final checks, version bump, CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run full typecheck**

```bash
npm run typecheck 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 2: Run full test suite**

```bash
npm test -- --reporter=dot 2>&1 | tail -5
```

Expected: all tests pass (2230+).

- [ ] **Step 3: Run build**

```bash
npm run build 2>&1 | tail -10
```

Expected: compiled successfully.

- [ ] **Step 4: Bump version in package.json**

Change `"version": "0.2.28"` to `"version": "0.2.29"`.

- [ ] **Step 5: Update CHANGELOG.md**

Add `[0.2.29]` section at the top:

```markdown
## [0.2.29] — 2026-05-22

### Fixed
- FLOOR-START-3: Added `BOTTLE_HANDPACK` to `FIRST_OP_STATION_KINDS`. Bottle hand-pack is a first-operation station — fresh bag scans now require product selection there.
- `scanCardAction` server-side guard: rejects fresh-bag starts at downstream stations (SEALING, PACKAGING, BOTTLE_CAP_SEAL, BOTTLE_STICKER). Previously only the floor UI enforced this; a hand-crafted POST could bypass it.
- Admin `startProductionForRawBagAction` now rejects non-first-op stations with a clear error message.
- Admin Start Production station dropdown now filters to first-op stations only (BLISTER, HANDPACK_BLISTER, BOTTLE_HANDPACK, COMBINED).

### Added
- Floor station page now shows a context-aware message for downstream stations ("accepts bags released from a prior stage") and an inline hint when no eligible pickups exist.
- Idle card dropdown placeholder updated to "Select a received bag QR…"; optgroup updated to "Received bags".
- Receives list: new Tablet type column shows distinct tablet type names for each receive (e.g. "MIT B Orange Citrus"), making multiple receives for the same PO distinguishable.

### Notes
- Machine vs station model cleanup is a future task (see CHANGELOG comment).
```

- [ ] **Step 6: Commit and push**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: v0.2.29 — FLOOR-START-3 versioning

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push origin main
```

---

## Task 9: Final report

**Files:** none

- [ ] **Step 1: Verify push**

```bash
git log --oneline -7
```

Expected: 4 new commits since FLOOR-START-2 + the version commit.

- [ ] **Step 2: Produce final report**

Return the following:

- branch/SHA before (ebf1649, v0.2.28) and after (new SHA, v0.2.29)
- Files changed (10 files)
- What `/admin/production/start` does now (only first-op stations; labeled as supervisor fallback)
- What `/floor/[token]` does now (downstream message; FIRST_OP_STATION_KINDS-based canStartFreshBag)
- Whether floor station scanning is now the primary operator workflow
- First-op station eligibility verdict (server-side guard + BOTTLE_HANDPACK added)
- Downstream station protection verdict (both UI and server reject fresh starts)
- Receives table product/flavor column verdict
- Machine/station cleanup note status
- Tests/typecheck/build results
- Pushed status
- Deployed footer version/SHA if available
- Next recommended workflow test
