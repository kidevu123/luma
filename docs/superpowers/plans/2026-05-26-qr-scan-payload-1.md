# QR-SCAN-PAYLOAD-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the QR label payload mismatch — labels encode `qrCards.id` but lookup queries by `qrCards.scanToken` — so physical bag QR codes resolve correctly at floor stations via both camera and USB/Bluetooth scanners.

**Architecture:** Two-part fix: (1) change the QR label generation to encode `scanToken` (the intended lookup key), (2) add a backward-compatible `or(scanToken, id)` dual-lookup in `lookupCardByTokenAction` so labels printed before this fix still resolve. Also update the floor station footer to show full version+SHA+branch metadata. No schema changes, no migrations.

**Tech Stack:** TypeScript strict, Next.js 15 App Router (Server Components), Drizzle ORM, Vitest source-text tests.

---

## Pre-work

- Branch: `main`, HEAD `9125e44`, version `0.2.48`.
- Working tree: clean.
- Tests baseline: 2426/2426 ✅

## File Map

| Action | Path | Change |
|--------|------|--------|
| Modify | `app/(floor)/floor/[token]/scan-card-form.test.ts` | Add `or` to drizzle mock; add source-text tests |
| Modify | `app/(floor)/floor/[token]/actions.ts` | Add `or` import; change WHERE in `lookupCardByTokenAction` |
| Modify | `app/(admin)/qr-cards/labels/page.tsx` | Encode `scanToken` instead of `id` in QR SVG + visible text |
| Modify | `app/(floor)/floor/[token]/page.tsx` | Update footer to show `v{version} · {sha} · {branch}` |
| Modify | `package.json` | 0.2.48 → 0.2.49 |
| Modify | `CHANGELOG.md` | Prepend [0.2.49] entry |

---

## Task 1: Write failing tests + update drizzle mock

**Files:**
- Modify: `app/(floor)/floor/[token]/scan-card-form.test.ts`

Background: The test file mocks `drizzle-orm` and currently includes `eq` and `inArray`. After Task 2, `lookupCardByTokenAction` will call `or()` from drizzle-orm. If `or` is not in the mock, the action throws "or is not a function". Add it now so existing tests don't break when the implementation changes.

The test file uses `readFileSync` and `resolve` from node:fs/node:path (already imported) plus a `here` variable (`dirname(fileURLToPath(import.meta.url))`). Source-text tests read the actual `.ts`/`.tsx` source files and assert on their text content.

- [ ] **Step 1: Read the current test file**

Read the file fully to understand existing mock shape before editing:
```bash
cat "app/(floor)/floor/[token]/scan-card-form.test.ts"
```

- [ ] **Step 2: Add `or` to the drizzle-orm mock**

Find the existing mock:
```typescript
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));
```

Replace it with:
```typescript
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...args: unknown[]) => ({ or: args }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));
```

- [ ] **Step 3: Add the source-text describe block at the end of the file**

Append this block after the last existing describe block. The `here` variable and `readFileSync`/`resolve` imports already exist in the file.

```typescript
// ── QR-SCAN-PAYLOAD-1 · source invariants ────────────────────────────────────
//
// These structural tests guard against re-introducing the id/scanToken mismatch.
// They read source files as text — no DB, no mocks — and verify the correct
// fields are referenced. They fail if the implementation regresses.

describe("QR-SCAN-PAYLOAD-1 · lookupCardByTokenAction dual lookup", () => {
  const actionsSrc = readFileSync(resolve(here, "actions.ts"), "utf8");

  it("uses or() to wrap the WHERE clause — not a bare scanToken eq", () => {
    // The old single-field where: .where(eq(qrCards.scanToken, ...))
    // The new dual-field where: .where(or(eq(qrCards.scanToken, ...), eq(qrCards.id, ...)))
    expect(actionsSrc).toMatch(/\.where\s*\(\s*or\s*\(/);
  });

  it("includes eq(qrCards.scanToken, ...) inside the or() clause", () => {
    expect(actionsSrc).toMatch(/eq\s*\(\s*qrCards\.scanToken\s*,\s*token\s*\)/);
  });

  it("includes eq(qrCards.id, ...) as the legacy fallback inside or()", () => {
    expect(actionsSrc).toMatch(/eq\s*\(\s*qrCards\.id\s*,\s*token\s*\)/);
  });

  it("includes a TODO comment about removing the id fallback", () => {
    expect(actionsSrc).toMatch(/TODO.*id.*fallback|TODO.*legacy.*label/i);
  });
});

describe("QR-SCAN-PAYLOAD-1 · QR label payload", () => {
  const labelsPath = resolve(
    here,
    "../../../(admin)/qr-cards/labels/page.tsx",
  );
  const labelsSrc = readFileSync(labelsPath, "utf8");

  it("renderQrSvg receives r.card.scanToken — not r.card.id", () => {
    expect(labelsSrc).toMatch(/renderQrSvg\s*\(\s*r\.card\.scanToken\s*\)/);
  });

  it("no call to renderQrSvg with r.card.id remains", () => {
    expect(labelsSrc).not.toMatch(/renderQrSvg\s*\(\s*r\.card\.id\s*\)/);
  });
});
```

- [ ] **Step 4: Run the new tests — verify they FAIL**

```bash
npx vitest run "app/(floor)/floor/\[token\]/scan-card-form.test.ts" 2>&1 | tail -20
```

Expected: the source-text tests fail (actions.ts still lacks `or`, labels still encode `id`). The existing `lookupCardByTokenAction` functional tests should still PASS because `or` in the mock is not yet exercised.

- [ ] **Step 5: Commit the test file**

```bash
git add "app/(floor)/floor/[token]/scan-card-form.test.ts"
git commit -m "$(cat <<'EOF'
test(floor): add QR-SCAN-PAYLOAD-1 source-text guards + or() mock

Guards against re-introducing the id/scanToken mismatch.
Fails until lookupCardByTokenAction and label page are fixed.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Fix `lookupCardByTokenAction` — dual lookup

**Files:**
- Modify: `app/(floor)/floor/[token]/actions.ts`

Background: `lookupCardByTokenAction` is at approximately line 1042. The relevant import is on line 5:
```typescript
import { eq, and, sql, desc, asc } from "drizzle-orm";
```
The WHERE clause at approximately line 1062–1063:
```typescript
    .leftJoin(inventoryBags, eq(inventoryBags.bagQrCode, qrCards.scanToken))
    .where(eq(qrCards.scanToken, scanToken.trim()))
    .limit(1);
```

Do NOT change the `leftJoin` — `inventoryBags.bagQrCode` correctly references `qrCards.scanToken`, not the lookup token.

- [ ] **Step 1: Add `or` to the drizzle-orm import**

Find:
```typescript
import { eq, and, sql, desc, asc } from "drizzle-orm";
```

Replace with:
```typescript
import { eq, and, or, sql, desc, asc } from "drizzle-orm";
```

- [ ] **Step 2: Extract `token` variable and update the WHERE clause**

Inside `lookupCardByTokenAction`, after the guard block:
```typescript
  const scanToken = formData.get("scanToken");
  if (typeof scanToken !== "string" || !scanToken.trim()) {
    return { error: "No scan token provided." };
  }

  const [card] = await db
    .select({
      id: qrCards.id,
      cardType: qrCards.cardType,
      status: qrCards.status,
      assignedWorkflowBagId: qrCards.assignedWorkflowBagId,
      tabletTypeId: inventoryBags.tabletTypeId,
    })
    .from(qrCards)
    .leftJoin(inventoryBags, eq(inventoryBags.bagQrCode, qrCards.scanToken))
    .where(eq(qrCards.scanToken, scanToken.trim()))
    .limit(1);
```

Replace from the guard block downward (through `.limit(1)`) with:
```typescript
  const scanToken = formData.get("scanToken");
  if (typeof scanToken !== "string" || !scanToken.trim()) {
    return { error: "No scan token provided." };
  }

  const token = scanToken.trim();
  const [card] = await db
    .select({
      id: qrCards.id,
      cardType: qrCards.cardType,
      status: qrCards.status,
      assignedWorkflowBagId: qrCards.assignedWorkflowBagId,
      tabletTypeId: inventoryBags.tabletTypeId,
    })
    .from(qrCards)
    .leftJoin(inventoryBags, eq(inventoryBags.bagQrCode, qrCards.scanToken))
    // QR-SCAN-PAYLOAD-1: new labels encode scanToken; legacy labels printed before
    // this fix encode qrCards.id. Support both until old labels are retired/reprinted.
    // TODO: remove the eq(qrCards.id, token) fallback once legacy labels are gone.
    .where(or(eq(qrCards.scanToken, token), eq(qrCards.id, token)))
    .limit(1);
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "npm notice"
```

Expected: no output / exit 0.

- [ ] **Step 4: Run the full test suite**

```bash
npx vitest run "app/(floor)/floor/\[token\]/scan-card-form.test.ts" 2>&1 | tail -15
```

Expected:
- The 3 source-text tests under "lookupCardByTokenAction dual lookup" now PASS.
- The "QR label payload" source-text tests still FAIL (labels page not changed yet).
- All existing `lookupCardByTokenAction` functional tests PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/(floor)/floor/[token]/actions.ts"
git commit -m "$(cat <<'EOF'
fix(floor): dual scanToken/id lookup in lookupCardByTokenAction (QR-SCAN-PAYLOAD-1)

Legacy QR labels encode qrCards.id; new labels will encode scanToken.
or() accepts both until old labels are retired. leftJoin on scanToken unchanged.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Fix QR label generation — encode `scanToken` not `id`

**Files:**
- Modify: `app/(admin)/qr-cards/labels/page.tsx`

Background: The labels page is at `app/(admin)/qr-cards/labels/page.tsx`. Key lines:
- Line 4 (comment): mentions "card's UUID"
- Line 30: `const svgs = await Promise.all(idle.map((r) => renderQrSvg(r.card.id)));`
- Line 63 (comment): "Each encodes the card's UUID"
- Line 84: visible label text `{r.card.label}` — this is the human name, keep as-is.
- Line 85: visible mono text `{r.card.id}` — shown below the QR; change to `{r.card.scanToken}`.

The `scanToken` field is available on `r.card` because `listQrCards()` returns full qrCards rows. Verify by grepping `listQrCards` in `lib/db/queries/qr-cards.ts` — it selects all columns.

- [ ] **Step 1: Verify `scanToken` is available in the query result**

```bash
grep -n "scanToken\|listQrCards\|select" lib/db/queries/qr-cards.ts | head -20
```

Expected: `listQrCards` selects `scanToken` (or selects all columns via `.select()` with no field list).

- [ ] **Step 2: Update the QR SVG rendering to use `scanToken`**

Find line 30:
```typescript
  const svgs = await Promise.all(idle.map((r) => renderQrSvg(r.card.id)));
```

Replace with:
```typescript
  // QR-SCAN-PAYLOAD-1: encode scanToken, not id — floor scan lookup matches by scanToken.
  const svgs = await Promise.all(idle.map((r) => renderQrSvg(r.card.scanToken)));
```

- [ ] **Step 3: Update the visible mono text below each QR**

Find (inside the `.map((r, i) => ...)` JSX):
```typescript
              <p className="text-[9px] font-mono text-text-subtle text-center break-all">
                {r.card.id}
              </p>
```

Replace with:
```typescript
              <p className="text-[9px] font-mono text-text-subtle text-center break-all">
                {r.card.scanToken}
              </p>
```

- [ ] **Step 4: Update the page description paragraph**

Find:
```typescript
          <p className="text-xs text-text-muted mt-0.5">
            One QR per idle RAW_BAG card. Each encodes the card's UUID — that's what
            the floor tablet scans.
          </p>
```

Replace with:
```typescript
          <p className="text-xs text-text-muted mt-0.5">
            One QR per idle RAW_BAG card. Each encodes the card's scan token — that's what
            the floor tablet scans.
          </p>
```

- [ ] **Step 5: Update the file header comment**

Find:
```typescript
// Printable QR card labels. One QR per IDLE card. Encodes the
// card's UUID — when the floor tablet's camera scans it, the
// scan-card form on /floor/<station-token> reads the UUID and
// fires scanCardAction.
```

Replace with:
```typescript
// Printable QR card labels. One QR per IDLE card. Encodes the
// card's scanToken — when the floor tablet's camera scans it, the
// scan-card form on /floor/<station-token> looks up the card by
// scanToken and fires scanCardAction.
```

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "npm notice"
```

Expected: no output / exit 0.

- [ ] **Step 7: Run tests — all source-text tests should now pass**

```bash
npx vitest run "app/(floor)/floor/\[token\]/scan-card-form.test.ts" 2>&1 | tail -15
```

Expected: all tests pass including the two QR label source-text tests.

- [ ] **Step 8: Run full test suite**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: 2430 passed (2426 + 4 new QR-SCAN-PAYLOAD-1 tests), 0 failures. (Count may be 2430 or 2431 depending on how many source-text tests were added — exact count is the baseline + new tests.)

- [ ] **Step 9: Commit**

```bash
git add "app/(admin)/qr-cards/labels/page.tsx"
git commit -m "$(cat <<'EOF'
fix(qr-labels): encode scanToken instead of id in printed QR labels (QR-SCAN-PAYLOAD-1)

Physical bag labels now embed the scan_token column value so floor lookup
succeeds. The visible mono text below the QR also updated to show scanToken.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Floor station footer — add version + branch metadata

**Files:**
- Modify: `app/(floor)/floor/[token]/page.tsx`

Background: Line 474–476 shows:
```typescript
      <p className="text-center text-[10px] text-text-subtle">
        Luma · {process.env.BUILD_GIT_SHA?.slice(0, 7) ?? "dev"}
      </p>
```

The admin footer (`components/admin/footer.tsx`) shows `v{version} · {sha} · {branch}` using `readFileSync` on `package.json`. Replicate the same metadata in the floor station footer. The floor station page is a Server Component, so `readFileSync` works.

- [ ] **Step 1: Add `readFileSync` and `path` imports to the floor station page**

The page currently starts with `import { notFound }` (line 10). Add node imports after the last existing import block, before `export const dynamic`:

Find:
```typescript
import { SealHandpackForm } from "./seal-handpack-form";

export const dynamic = "force-dynamic";
```

Replace with:
```typescript
import { SealHandpackForm } from "./seal-handpack-form";
import { readFileSync } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

function getPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}
```

- [ ] **Step 2: Update the footer `<p>` tag**

Find:
```typescript
      <p className="text-center text-[10px] text-text-subtle">
        Luma · {process.env.BUILD_GIT_SHA?.slice(0, 7) ?? "dev"}
      </p>
```

Replace with:
```typescript
      <p className="text-center text-[10px] font-mono text-text-subtle">
        Luma · v{getPackageVersion()} · {process.env.BUILD_GIT_SHA?.slice(0, 7) ?? "local"}
        {process.env.BUILD_GIT_BRANCH ? ` · ${process.env.BUILD_GIT_BRANCH}` : ""}
      </p>
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "npm notice"
```

Expected: no output / exit 0.

- [ ] **Step 4: Commit**

```bash
git add "app/(floor)/floor/[token]/page.tsx"
git commit -m "$(cat <<'EOF'
feat(floor): show version + SHA + branch in station footer

Matches admin footer metadata format. Helps operators and supervisors
confirm which deployed version is running on floor tablets.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Version bump + CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version in `package.json`**

Change `"version": "0.2.48"` → `"version": "0.2.49"`.

- [ ] **Step 2: Prepend CHANGELOG entry**

Add this block at the very top of `CHANGELOG.md`, before the existing `## [0.2.48]` entry:

```markdown
## [0.2.49] — 2026-05-26

### Fixed
- **QR label payload mismatch (QR-SCAN-PAYLOAD-1):** Printed bag QR labels were encoding `qrCards.id` (the UUID primary key), but `lookupCardByTokenAction` was matching by `qrCards.scanToken` (a separate column). Every physical scan — camera or USB/Bluetooth barcode scanner — silently returned "Bag QR not found." New labels now encode `qrCards.scanToken`, the correct lookup key. The floor scan lookup now also accepts `qrCards.id` as a backward-compatible fallback so labels printed before this fix continue to resolve (TODO: remove the id fallback once all legacy labels are retired/reprinted).
- **Floor station footer version metadata:** The station page footer now shows `v{version} · {sha} · {branch}`, matching the admin UI. Operators and supervisors can confirm which deployed version is running on floor tablets.

### Tests added (QR-SCAN-PAYLOAD-1)
- Source-text guard: `lookupCardByTokenAction` uses `or()` wrapping both `scanToken` and `id` clauses.
- Source-text guard: QR label page calls `renderQrSvg(r.card.scanToken)` — not `r.card.id`.

```

- [ ] **Step 3: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore: bump to v0.2.49 — QR-SCAN-PAYLOAD-1 physical bag QR scan fix

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final checks + push

- [ ] **Step 1: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "npm notice"
```

Expected: exit 0, no output.

- [ ] **Step 2: Full test run**

```bash
npx vitest run 2>&1 | tail -8
```

Expected: all tests pass (2426 baseline + 4 new source-text tests = ~2430). No failures.

- [ ] **Step 3: Build**

```bash
npx next build 2>&1 | tail -15
```

Expected: exit 0.

- [ ] **Step 4: Push**

```bash
git push origin main
```

- [ ] **Step 5: Report git log**

```bash
git log --oneline -8
```

- [ ] **Step 6: Confirm floor/Zoho/camera untouched**

```bash
git diff 9125e44 HEAD -- "lib/zoho" "app/(floor)/floor/[token]/camera-scanner.tsx" "lib/floor/camera-diagnostics.ts" | wc -l
```

Expected: 0 (nothing in Zoho or camera scanner changed).

- [ ] **Step 7: Health check (after ~60s deploy)**

```bash
curl -s http://192.168.1.134:3000/api/health | grep -E "sha|version"
```

Expected: SHA matches HEAD.

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|---|---|
| Confirm QR label encodes `id` (current bad state) | Pre-work investigation |
| Fix labels to encode `scanToken` | Task 3 |
| Dual lookup: `scanToken` OR `id` in `lookupCardByTokenAction` | Task 2 |
| TODO comment for id fallback removal | Task 2 |
| `leftJoin` on `qrCards.scanToken` unchanged | Task 2 — explicitly noted |
| Validation (type/status) unchanged and not bypassed | Task 2 — code after lookup identical |
| Test: lookup by scanToken works | Task 1 + existing functional tests |
| Test: lookup by id works (structural guard) | Task 1 source-text test |
| Test: unknown token fails | Existing test, still passes |
| Test: retired/VARIETY_PACK validation intact | Existing tests, still pass |
| Test: label page uses `scanToken` (structural guard) | Task 1 source-text test |
| Station footer version metadata | Task 4 |
| Version bump + CHANGELOG | Task 5 |
| typecheck + vitest + build | Task 6 |
| Push to main | Task 6 |
| No Zoho/Authentik/migrations touched | All tasks — confirmed scope |

**Placeholder scan:** None. All code blocks are complete.

**Type consistency:**
- `token` variable used in Task 2 is `string` (after guard passes, trimmed).
- `or`, `eq` from drizzle-orm: both accept column references and string literals correctly.
- `getPackageVersion()` returns `string` (with `"?"` fallback) — used in template literal in JSX.
- `r.card.scanToken` in Task 3: `scanToken` is `text("scan_token").notNull()` in schema → `string` → correct type for `renderQrSvg(value: string)`.
