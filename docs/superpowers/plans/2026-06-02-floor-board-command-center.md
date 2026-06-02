# Floor Board Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/floor-board` as a layered command center (Act Now + map + pulse + drawer + modes) without duplicate metric blocks.

**Architecture:** Server page loads existing bundles; new `buildActNowPanel` pure function; client layout reads `?mode=`; Act Now sidebar fixed beside widget grid.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind, existing `metrics.ts` + `getFloorManagerSnapshot`.

**Spec:** `docs/superpowers/specs/2026-06-02-floor-board-command-center-design.md`

---

### Task 1: Act Now types and builder

**Files:**
- Create: `lib/floor-command/act-now.ts`
- Modify: `lib/floor-command/types.ts`

- [ ] Add `ActNowItem`, `ActNowSeverity` types
- [ ] Implement `buildActNowPanel(...)` from snapshot + attention + intelligence
- [ ] Unit-free; manual verify with floor-board data

### Task 2: Act Now sidebar UI

**Files:**
- Create: `app/(admin)/floor-board/_components/act-now-panel.tsx`

- [ ] Render prioritized list with severity borders
- [ ] Empty state: "Nothing flagged — floor clear"

### Task 3: Owner pulse strip

**Files:**
- Create: `app/(admin)/floor-board/_components/owner-pulse-strip.tsx`

- [ ] Show WIP, pause $, runway, shift output
- [ ] Links to `/dashboard` and `/metrics`

### Task 4: Floor command client layout

**Files:**
- Modify: `app/(admin)/floor-board/_components/floor-command-client.tsx`
- Modify: `app/(admin)/floor-board/page.tsx`

- [ ] Accept `mode` + `actNowItems`
- [ ] Grid + Act Now sidebar (hidden in TV mode)
- [ ] Manager drawer open when `mode=manager`
- [ ] TV: large type, minimal chrome

### Task 5: Verify and deploy

- [ ] `npm run build`
- [ ] Commit + push
