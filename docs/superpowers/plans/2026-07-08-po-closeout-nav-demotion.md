# PO Closeout Nav Demotion (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Close out POs" becomes the primary Reconciliation & output nav item; Production Output, PO Reconciliation, Finished Lots, and Zoho Production Output move to a new collapsed **Advanced** section. Config + rendering only; no route deletions; minRoles unchanged.

**Architecture:** Add `collapsed?: boolean` to `AdminNavSectionDef`; append an `Advanced` section (collapsed) in `lib/auth/admin-nav.ts`; render collapsed sections as `<details>` in `components/admin/sidebar.tsx`. Update the NAV-PHASED-1 sidebar tests and add access-policy pins.

**Tech Stack:** nav config + sidebar component, vitest structural tests.

## Global Constraints (from spec)

- No route deletions; bookmarks and cross-links keep working; every drawer panel already links to its specialist page.
- minRoles unchanged everywhere — nothing gets looser or stricter (v1.24.2 access-policy tests must keep passing with updated placement pins).
- Version → **1.27.0**; CHANGELOG `## [1.27.0] — 2026-07-08`; gates green; deploy + verify; no deploy-time mutation.

### Task 1: Tests first (sidebar + access policy)

**Files:** Modify `components/admin/sidebar.test.ts`, `lib/auth/access-policy.test.ts`.

- [ ] SECTION_HEADINGS becomes `["Intake & materials","Run production","Reconciliation & output","Traceability & reporting","Advanced"]`; Reconciliation & output block asserts ONLY `"/po-closeout"` with label `"Close out POs"`; new Advanced block asserts the four moved hrefs; new test: Advanced has `collapsed: true` and sidebar renders `<details` for collapsed sections; moved items keep exact minRoles (`/packaging-output` SESSION, `/po-reconciliation` ADMIN, `/finished-lots` SESSION, `/zoho-production-operations` SESSION).
- [ ] access-policy.test.ts: add pin that `/po-closeout` label is "Close out POs" and demoted pages remain in nav with unchanged minRoles.
- [ ] Run → FAIL (config not changed yet).

### Task 2: Config + rendering

**Files:** Modify `lib/auth/admin-nav.ts`, `components/admin/sidebar.tsx`.

- [ ] `AdminNavSectionDef` gains `collapsed?: boolean`. Reconciliation & output → `[{ href: "/po-closeout", label: "Close out POs", minRole: "ADMIN" }]`. Append `{ heading: "Advanced", collapsed: true, items: [packaging-output, po-reconciliation, finished-lots, zoho-production-operations] }` (labels/minRoles unchanged) after Traceability & reporting.
- [ ] Sidebar: collapsed sections render inside `<details className="group"><summary>` (heading as summary, chevron), open by default when the current path is inside the section (so deep links aren't hidden).
- [ ] All tests PASS; `npx tsc --noEmit`, lint, build green.
- [ ] Commit `feat(nav): Close out POs primary; specialist pages under collapsed Advanced (phase 3)`.

### Task 3: Version, deploy, verify

- [ ] Full gates; `npm version 1.27.0 --no-git-tag-version`; CHANGELOG `## [1.27.0] — 2026-07-08` (Changed — NAV-DEMOTION-1). Push after v1.26.0 verifies; health → 1.27.0; pages respond; invariants unchanged.

## Self-review
- Spec: primary item ✔, Advanced collapsed ✔, no deletions ✔, minRoles pinned ✔, tests ✔. No placeholders; names consistent.
