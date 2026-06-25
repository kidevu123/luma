# Duplication reduction closeout — 2026-06-25

**Status:** Duplication reduction phase **D complete**. **Stop line** — do not continue dedup refactors from this track without a separate brief.

**Latest phase commit:** `10a23d9` (`v1.5.23`)  
**Policy:** `VERSIONING.md` — docs-only changes do not bump `package.json`.

---

## Phase summary (D-1 → D-3)

| Phase | Version | Commit theme | Outcome |
|-------|---------|--------------|---------|
| **D-1** | v1.5.20–v1.5.21 | Presentational + type dedup | Byte-identical `OpStatusChip` → shared `ZohoOpStatusChip`; canonical `CommitSource` in `zoho-commit-notes.ts` with re-export guard |
| **D-2** | v1.5.22 | Test helper dedup | Shared `lib/test/source-scan.ts`; migrated Zoho guard tests |
| **D-3** | v1.5.23 | BOM dispatcher audit | Contract tests prove consolidated vs admin dispatchers are **intentionally non-equivalent**; no production merge |

See `CHANGELOG.md` for per-release detail.

---

## What duplication was removed

| Change | Approx. savings | Risk |
|--------|-----------------|------|
| Local `OpStatusChip` in `zoho-queue-card.tsx` → `ZohoOpStatusChip` import | ~18 lines | Low |
| Parallel `CommitSource` / `ProductionOutputCommitSource` type defs → single canonical type + re-export | ~4 lines | Low (type-only) |
| Repeated `execSync` grep / `cat` harness in guard tests → `lib/test/source-scan.ts` | ~52 lines boilerplate (net + helper/tests) | Low (test-only) |

**Gate snapshot at closeout:** typecheck / typecheck:scripts / eslint / vitest **4631** / build — pass at `10a23d9`.

---

## What duplication was intentionally left alone

- **Full BOM dispatcher merge** — near-copy logic, different semantics (see below).
- **BOM pilot-tail routing** — shared `isChocoDriftSku` / `isFixRelaxSku` / `isSweetTripSku` branches duplicated at tail of both dispatchers; left inline pending domain sign-off.
- **Non-equivalent StatusChip variants** — production-output preview, production-ops page, genealogy, raw-bag panel use different status domains than `ZohoOpStatusChip`.
- **`loadRawBagReceiveContext` vs `loadBagFinishReceiveContext`** — overlapping joins but different eligibility / verify semantics.
- **Ad-hoc `readFileSync` in contract tests** — ~80 files; migrate opportunistically via `readRepoSource` only when touching a test.
- **Duplicate Zoho live-write paths** — shared commit modules exist by design; no casual consolidation of commit/state-machine logic.
- **Stale/dead routes** — no confirmed issue in this phase; periodic audit only.

---

## Why full BOM dispatcher merge is deferred

D-3 contracts (`lib/zoho/bom-dispatcher-behavior.contract.test.ts`) prove three **intentional** divergences between `sourceAllocationBuildOptsForProduct` (consolidated/cron enqueue) and `buildAdminPreviewSourceAllocationOpts` (admin preview):

1. **Nullable `productId`** — consolidated skips Luma derivation when null; admin always derives from a string `productId`.
2. **Generic fallback** — consolidated returns `{ ok: true, opts: { resolveBatches } }` for unknown SKUs when derivation is skipped or fails without a pilot match; admin returns derivation blockers instead.
3. **Return shape** — admin adds `source` (`"luma" \| "pilot"`) and `warnings`; consolidated does not.

Merging into one helper without explicit mode flags and product decisions would change consolidated cron behavior (e.g. null `productId` + unknown SKU currently succeeds with generic opts).

**Optional follow-up (tiny scope only):** extract shared pilot-tail helper (~15 lines) — not the full dispatcher.

---

## Remaining duplication

| Area | Status | Risk | Recommendation |
|------|--------|------|----------------|
| Exact duplicate `OpStatusChip` | **Fixed** | Low | Done (v1.5.20) |
| Source-scan / no-importer test helper duplication | **Fixed** | Low | Done (v1.5.22) |
| `CommitSource` type duplication | **Fixed** | Low | Done (v1.5.21); guard in `commit-source-dedup.test.ts` |
| BOM dispatcher duplication | **Audited / contract-pinned** | Medium / high | **Do not fully merge** |
| BOM pilot-tail duplication | Remains | Low / medium | Optional tiny refactor only (pilot routing extract) |
| Other StatusChip variants | Not equivalent | Medium | Defer unless doing UI design cleanup |
| Raw-bag / bag-finish context loader overlap | Remains | High | Do not touch now |
| Ad-hoc `readFileSync` tests | Remains in some places | Low | Migrate opportunistically only |
| Stale / dead routes / endpoints | No confirmed issue | Low / unknown | Periodic audit only |
| Duplicate Zoho live-write logic | Behavior-sensitive by design | Medium / high | No casual consolidation |

---

## Rule for future dedup work

**Do not merge behavior-sensitive Zoho paths unless equivalence is contract-proven first.**

Before any refactor touching commit, preview, payload, or dispatcher logic:

1. Map call sites and runtime paths (cron vs admin vs commit).
2. Classify differences as intentional vs accidental.
3. Add or extend contract/scenario tests pinning current behavior.
4. Only merge when tests prove equivalence — or when product explicitly accepts a behavior change.

---

## Related docs

- Prior cleanup track: `docs/CLEANUP_CLOSEOUT_2026-06-25.md`
- BOM dispatcher contracts: `lib/zoho/bom-dispatcher-behavior.contract.test.ts`
- Source-scan helper: `lib/test/source-scan.ts`

**No D-4 implementation planned from this closeout.**
