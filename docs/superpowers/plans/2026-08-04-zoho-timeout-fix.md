# Zoho Preview/Assembly Timeout Fix (v1.29.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix production incident where Zoho preview calls abort at 10s while the gateway legitimately takes longer; introduce an env-tunable 45s default shared between the assembly service client and the production-output preview client.

**Architecture:** Add `resolveZohoServiceTimeoutMs(env)` to `lib/zoho/assembly-service-client.ts` (the more foundational module — already exported env-var constants); both call sites import it; a colocated test file covers the helper and updates any assertions that encoded the old 10_000 default.

**Tech Stack:** TypeScript strict (noUncheckedIndexedAccess, exactOptionalPropertyTypes), Vitest, Next.js 15 App Router. No new dependencies.

## Global Constraints

- No emoji anywhere in code, tests, changelog, or comments.
- TypeScript strict — `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` must pass.
- Test files are colocated with source in `lib/zoho/`.
- `npm run typecheck && npm run lint` must be clean before commit.
- `npx vitest run lib/zoho` must be clean before commit.
- Version: bump `package.json` from `1.29.4` to `1.29.5`; add CHANGELOG entry (no emoji).
- Commit message: `fix(zoho): preview/assembly client timeout 10s -> env-tunable 45s default (v1.29.5)`
- Do NOT push to remote — controller pushes.

---

### Task 1: Add `resolveZohoServiceTimeoutMs` helper + tests; update both call sites; bump version; CHANGELOG

**Files:**
- Modify: `/Users/sahilkhatri/Projects/Work/luma/lib/zoho/assembly-service-client.ts:169` — replace hardcoded `10_000` with `resolveZohoServiceTimeoutMs(env)`; export the new helper
- Modify: `/Users/sahilkhatri/Projects/Work/luma/lib/zoho/production-output-preview.ts:404` — replace hardcoded `10_000` with `resolveZohoServiceTimeoutMs()`; import helper
- Create: `/Users/sahilkhatri/Projects/Work/luma/lib/zoho/zoho-service-timeout.test.ts` — unit tests for `resolveZohoServiceTimeoutMs`
- Modify: `/Users/sahilkhatri/Projects/Work/luma/lib/zoho/assembly-service-client.test.ts` — update any test that asserts the 10_000 default (currently no such assertion exists, but grep to verify)
- Modify: `/Users/sahilkhatri/Projects/Work/luma/lib/zoho/production-output-preview.test.ts` — same scan/update
- Modify: `/Users/sahilkhatri/Projects/Work/luma/package.json:3` — bump version to `1.29.5`
- Modify: `/Users/sahilkhatri/Projects/Work/luma/CHANGELOG.md` — prepend new entry

**Interfaces:**
- Produces: `resolveZohoServiceTimeoutMs(env?: Record<string, string | undefined>): number` exported from `assembly-service-client.ts`
- Consumed by: `callZohoAssemblyService` in `assembly-service-client.ts` and `callProductionOutputPreview` in `production-output-preview.ts`

- [ ] **Step 1: Write the failing tests for `resolveZohoServiceTimeoutMs`**

Create `/Users/sahilkhatri/Projects/Work/luma/lib/zoho/zoho-service-timeout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveZohoServiceTimeoutMs } from "./assembly-service-client";

describe("resolveZohoServiceTimeoutMs", () => {
  it("returns 45_000 when env var is absent", () => {
    expect(resolveZohoServiceTimeoutMs({})).toBe(45_000);
  });

  it("returns the parsed value when ZOHO_SERVICE_TIMEOUT_MS is a valid integer >= 1000", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "60000" })).toBe(60_000);
  });

  it("returns 45_000 when ZOHO_SERVICE_TIMEOUT_MS is garbage (non-numeric)", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "abc" })).toBe(45_000);
  });

  it("returns 45_000 when ZOHO_SERVICE_TIMEOUT_MS is empty string", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "" })).toBe(45_000);
  });

  it("returns 45_000 when ZOHO_SERVICE_TIMEOUT_MS is below 1000 (sub-minimum clamped to default)", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "500" })).toBe(45_000);
  });

  it("returns 45_000 when ZOHO_SERVICE_TIMEOUT_MS is exactly 999 (below floor)", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "999" })).toBe(45_000);
  });

  it("returns the value when ZOHO_SERVICE_TIMEOUT_MS is exactly 1000 (at floor)", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "1000" })).toBe(1_000);
  });

  it("returns 45_000 when ZOHO_SERVICE_TIMEOUT_MS is Infinity (non-finite)", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "Infinity" })).toBe(45_000);
  });

  it("returns 45_000 when called with no argument (uses process.env default, which won't have the var in test)", () => {
    // This test is valid as long as ZOHO_SERVICE_TIMEOUT_MS is not set in the
    // test runner's process.env. It verifies the signature default works.
    const saved = process.env["ZOHO_SERVICE_TIMEOUT_MS"];
    delete process.env["ZOHO_SERVICE_TIMEOUT_MS"];
    try {
      expect(resolveZohoServiceTimeoutMs()).toBe(45_000);
    } finally {
      if (saved !== undefined) process.env["ZOHO_SERVICE_TIMEOUT_MS"] = saved;
    }
  });
});
```

- [ ] **Step 2: Run the new test file to confirm it fails (function not yet exported)**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npx vitest run lib/zoho/zoho-service-timeout.test.ts
```

Expected: FAIL — `resolveZohoServiceTimeoutMs` is not exported from `./assembly-service-client`.

- [ ] **Step 3: Add `resolveZohoServiceTimeoutMs` to `assembly-service-client.ts` and update the call site**

In `/Users/sahilkhatri/Projects/Work/luma/lib/zoho/assembly-service-client.ts`, after the exported env-var name constants block (after line 21), add:

```ts
// ─── Timeout helper ───────────────────────────────────────────────────────────

/** Preview/assembly calls fan out multiple Zoho API round-trips at the
 *  gateway and routinely exceed 10s. Confirmed 2026-08-04: gateway returned
 *  200 OK moments after the old 10s abort fired. Env-tunable; 45s default. */
export function resolveZohoServiceTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["ZOHO_SERVICE_TIMEOUT_MS"];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1000 ? n : 45_000;
}
```

Then on line 169, change:

```ts
  const timeoutMs = opts.timeoutMs ?? 10_000;
```

to:

```ts
  const timeoutMs = opts.timeoutMs ?? resolveZohoServiceTimeoutMs(env);
```

- [ ] **Step 4: Run the new test file to confirm it passes**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npx vitest run lib/zoho/zoho-service-timeout.test.ts
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Update the call site in `production-output-preview.ts`**

At the top of `/Users/sahilkhatri/Projects/Work/luma/lib/zoho/production-output-preview.ts`, add the import. The existing imports are:

```ts
import { createHash } from "node:crypto";
import { isProductionOutputPreviewEnabled } from "@/lib/zoho/production-output-config";
import { mapProductionOutputPreviewQuantities } from "@/lib/zoho/production-output-preview-quantities";
```

Add a fourth import:

```ts
import { resolveZohoServiceTimeoutMs } from "@/lib/zoho/assembly-service-client";
```

Then on line 404 of that file, change:

```ts
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
```

to:

```ts
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? resolveZohoServiceTimeoutMs(opts.env ?? process.env));
```

- [ ] **Step 6: Scan existing tests for any hardcoded 10_000 timeout assertion**

```bash
grep -n "10_000\|10000" \
  /Users/sahilkhatri/Projects/Work/luma/lib/zoho/assembly-service-client.test.ts \
  /Users/sahilkhatri/Projects/Work/luma/lib/zoho/production-output-preview.test.ts
```

If any matches assert the old 10_000 default: update those assertions to `45_000`. If no matches: proceed.

- [ ] **Step 7: Run the full Zoho suite to confirm no regressions**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npx vitest run lib/zoho
```

Expected: all tests PASS.

- [ ] **Step 8: Run typecheck and lint**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck && npm run lint
```

Expected: no errors.

- [ ] **Step 9: Bump version in `package.json`**

Change line 3 of `/Users/sahilkhatri/Projects/Work/luma/package.json` from:

```json
  "version": "1.29.4",
```

to:

```json
  "version": "1.29.5",
```

- [ ] **Step 10: Prepend CHANGELOG entry**

In `/Users/sahilkhatri/Projects/Work/luma/CHANGELOG.md`, after the `# Changelog` heading and before the `## [1.29.4]` entry, add:

```markdown
## [1.29.5] — 2026-08-04

### Fixed — ZOHO-TIMEOUT-1: preview/assembly client timeout 10s -> env-tunable 45s default
- **Root cause (active):** Both `callZohoAssemblyService` (assembly-service-client.ts:169) and `callProductionOutputPreview` (production-output-preview.ts:404) hardcoded a 10s abort timeout. The Zoho Integration Service gateway fans out multiple Zoho API round-trips internally and routinely takes slightly longer. Confirmed 2026-08-04: gateway logged HTTP 200 OK moments after Luma's client fired AbortController.abort(). Every preview retry therefore recorded blocker PREVIEW_FAILED "Network error: This operation was aborted" and the op remained NEEDS_MAPPING permanently.
- **Fix:** New `resolveZohoServiceTimeoutMs(env)` helper exported from `assembly-service-client.ts`. Both call sites use `opts.timeoutMs ?? resolveZohoServiceTimeoutMs(env)`. Default is 45s; override via `ZOHO_SERVICE_TIMEOUT_MS=<ms>` (must be >= 1000; garbage/absent/sub-1000 falls back to 45000).
- **Tests:** 9 new unit tests in `lib/zoho/zoho-service-timeout.test.ts` covering valid env value, garbage string, empty string, missing, sub-1000, exactly 1000, Infinity, and no-argument invocation.

```

- [ ] **Step 11: Write the report file**

Create `/Users/sahilkhatri/Projects/Work/luma/.superpowers/timeout-fix-report.md`:

```markdown
# Zoho Preview Timeout Fix — v1.29.5

**Status:** Complete

**Commit:** (fill in SHA after commit)

**Test summary:** 9 new tests in `lib/zoho/zoho-service-timeout.test.ts`; full `lib/zoho` suite passes.

**Changes:**
- `lib/zoho/assembly-service-client.ts` — exported `resolveZohoServiceTimeoutMs`; call site line 169 uses it
- `lib/zoho/production-output-preview.ts` — imports and uses `resolveZohoServiceTimeoutMs` at line 404
- `lib/zoho/zoho-service-timeout.test.ts` — new (9 tests)
- `package.json` — 1.29.4 -> 1.29.5
- `CHANGELOG.md` — [1.29.5] entry prepended

**Concerns:** None. The change is purely additive for callers that pass `timeoutMs` explicitly; only the default path changes (10s -> 45s). The `resolveZohoServiceTimeoutMs` helper is pure and trivially testable.

**Report path:** /Users/sahilkhatri/Projects/Work/luma/.superpowers/timeout-fix-report.md
```

- [ ] **Step 12: Commit**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && \
git add \
  lib/zoho/assembly-service-client.ts \
  lib/zoho/production-output-preview.ts \
  lib/zoho/zoho-service-timeout.test.ts \
  package.json \
  CHANGELOG.md \
  .superpowers/timeout-fix-report.md && \
git commit -m "$(cat <<'EOF'
fix(zoho): preview/assembly client timeout 10s -> env-tunable 45s default (v1.29.5)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PvZhnyswfRFNYFbgU8AxXp
EOF
)"
```

- [ ] **Step 13: Verify commit**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && git log --oneline -3
```

Expected: top commit shows the fix message at v1.29.5.
