# Handoff — Luma `production-intelligence-command-center`

> **You are the next AI picking up this branch.** Read this top to bottom before touching anything. The deep reference is `docs/BRANCH_CONTEXT_PRODUCTION_INTELLIGENCE_COMMAND_CENTER.md`. The project-level brief is `CLAUDE.md` at the repo root. Both are still authoritative.
>
> **Today is 2026-05-18.** The session that produced this handoff ended mid-flight on `LUMA-UI-REBUILD-1` turn 2.5 (v2 design language shipped, ribbon-overlap fix shipped, turn 3 not started).

---

## First 5 minutes — catch up

1. Read this file end-to-end.
2. Read `docs/BRANCH_CONTEXT_PRODUCTION_INTELLIGENCE_COMMAND_CENTER.md` for the deep dive on what landed.
3. Skim `CLAUDE.md` for the project-wide guardrails.
4. Run:

   ```bash
   cd /Users/kidevu/luma
   git log --oneline -10
   git status --short
   ```

   You should see a clean tree (nothing dirty) and the latest commit should be `9785709 fix(ui): ribbon segment overlap — clamp display value + truncate guard`.
5. **Don't touch `main`.** It hasn't been touched and won't be until the owner explicitly authorises the merge.

---

## Where we are right now

**Branch:** `production-intelligence-command-center` — 153 commits ahead of `main`
**Latest commit:** `9785709` (ribbon fix)
**Build/typecheck:** clean as of `9785709`
**Tests:** 1585/1585 passing (last full run was after CT-4)
**Deploy:** LXC 122 (`192.168.1.134:3000`), `luma-deploy.service` picks up new commits every 60s. Latest deploy should already be live.

### What landed this session

| Initiative | Status |
|---|---|
| `WORKFLOW-CLEANUP-2` — production on-ramp | ✅ shipped |
| `COMMERCIAL-TRACE-2` schema | ✅ shipped |
| `COMMERCIAL-TRACE-3` Zoho invoice dry-run | ✅ shipped |
| `COMMERCIAL-TRACE-4` allocation engine (1585 tests) | ✅ shipped |
| `COMMERCIAL-TRACE-5` `/invoice-allocations` review UI | ✅ shipped |
| `COMMERCIAL-TRACE-6` Nexus customer-scope endpoints | ✅ shipped |
| `COMMERCIAL-TRACE-7` mock end-to-end verification | ✅ VERIFY OK |
| `CLAUDE-SKILLS-1` 8 repo-local skills | ✅ shipped |
| `LUMA-UI-REBUILD-1` Turn 1 (tokens + primitives + sidebar + /invoice-allocations) | ✅ shipped |
| `LUMA-UI-REBUILD-1` Turn 2 (raw-bags + start + floor-board) | ✅ shipped |
| `LUMA-UI-REBUILD-1` v2 — Operations Atelier (the bold pivot) | ✅ shipped |
| Ribbon overlap fix | ✅ shipped |
| `LUMA-UI-REBUILD-1` Turn 3 (packaging-materials + material-alerts + recall) | ⏳ **not started** |

---

## Pick up here — the immediate next step

The user explicitly asked for **`LUMA-UI-REBUILD-1` Turn 3**. Three pages remain on the original 8-page brief plus closeout work:

### Turn 3 — proposed sequencing

| Step | Work | Approach |
|---|---|---|
| 1 | `/inbound/packaging-materials` | Rebuild chrome on `CommandShell` + `PageHero` + `SectionCard`. Keep all data loading + actions. Use `RibbonStrip` if there's a 3+ status summary that fits. |
| 2 | `/material-alerts` | Same approach. This page is likely to have status counts that fit `RibbonStrip` (alerting/critical/info/resolved). |
| 3 | `/recall` | Lookup-by-receipt/batch surface. Hero + search-form `SectionCard` + result `RecordCard` list. Empty state matters — use `DataEmptyState`. |
| 4 | Taste audit | Run `web-design-guidelines` skill across all rebuilt pages. Capture any accessibility / layout findings. |
| 5 | Tests + verify | `npx tsc --noEmit && npx next build`. Take screenshots of each rebuilt page on LXC 122. |
| 6 | Docs + closeout | Update `docs/BRANCH_CONTEXT_PRODUCTION_INTELLIGENCE_COMMAND_CENTER.md`. Write `docs/luma-ui-rebuild-1-closeout.md`. |
| 7 | Commit + push | One commit per page is fine, or one bundled commit. The user's preference seems to be "logical units" — turns 1 and 2 were bundled. |

**Start with step 1.** Don't try all of turn 3 in one shot before checking in.

### Before you write any code

Read each of the three target pages to understand the data flow:

```bash
wc -l "app/(admin)/inbound/packaging-materials/page.tsx" \
      "app/(admin)/material-alerts/page.tsx" \
      "app/(admin)/recall/page.tsx"
```

The pattern that worked for turns 1–2: **only the chrome changes.** Every read query, every server action, every client component contract stays identical. The diff is purely visual swap to the new primitives.

---

## User context — calibrate tone here

The user is **nabeelvira@gmail.com**, the owner. They run a small manufacturing/distribution business. Luma is their production-floor command surface.

### Communication style

- **Terse.** They write in lowercase, often one-line responses ("go", "start", "ok go for it", "2").
- **Direct feedback.** When something doesn't land they say so — "everything looks every same and very bland", "tell me you are impressed by this?!"
- **Visual-first.** They send screenshots, not bug reports. Read the screenshot carefully — if there's a visible bug, call it out yourself before they do.
- **Skill-aware.** They explicitly invoked `frontend-design`, asked about `emil-design-eng`, told you to "call all the skills needed". When in doubt, name the skill you're applying.

### What they reward

- **Honest self-critique.** When I delivered a competent-but-bland v1, they pushed back. I admitted v1 was "Notion + Linear had a baby" and proposed v2. They liked that.
- **Bold direction, then ship.** They authorise autonomous work but they want the AI to commit to an aesthetic and execute.
- **Flagging your own bugs.** I called out the ribbon overlap from their screenshot before they had to. Continue that.

### What they don't reward

- **Optimistic summaries.** Don't say "this is great" about your own output. Show the diff and let them judge.
- **Generic AI aesthetics.** Inter on white, purple gradients, "tasteful" minimalism without identity — they explicitly rejected this in v1.
- **Bundled scope dumps.** They like turn-based sequencing. Three turns of 3 pages each beats one mega-turn.

### Recent verbatim feedback

- > "i am not sure what you have changed but everything looks every same and very blend"  *(after looking at `/dashboard` — which was OUT of scope in turns 1-2; the response that landed: own the miss and propose v2)*
- > "tell me you are impressed by this!!??"  *(challenging me on `/invoice-allocations` v1 — the right response was "no, I'm not", followed by the v2 pitch)*
- > "ok go for it please call all the skills needed for this"  *(authorising v2)*
- > "1" / "2" / "go" / "start"  *(decisive one-line authorisations — they trust you to execute once you've made the trade-offs explicit)*

---

## Active design language — Operations Atelier

The aesthetic direction shipped in v2 (`f38f1f8`). **Do not drift from this.** If you find yourself reaching for `text-slate-*` on a light surface or hardcoding a hex, stop.

### Identity

- **Brand-teal dominant** against a **copper-amber accent** (`--brand-accent: 217 130 32`). The teal/copper pair is the system identity — watchmaker / Bloomberg / architectural drawing.
- **Fraunces** for display numerals and hero titles (loaded via `next/font/google`, self-hosted at build).
- **Geist Sans** for body, **Geist Mono** for code/IDs.
- **Engineering grid** is actually visible on the canvas (`body::before`). Don't remove it.
- **Ambient brand+accent radial wash** at the top of the viewport (`body::after`). Don't remove.

### Tone vocabulary (semantic — never decoration)

| Tone | Meaning |
|---|---|
| `good` | running / ready / verified / confirmed |
| `warn` | degraded / partial / needs review |
| `crit` | blocked / conflict / over-allocated |
| `info` | neutral signal / data window |
| `muted` | missing / idle / legacy / waiting |
| `brand` | primary CTA / active nav / live signal — earn it |

### Signature moves

1. **3px rail** on the left edge of every section card / hero / panel — with inner highlight + outer bloom in the rail's own tone color
2. **`.surface-hero`** — dual radial brand+accent backdrop + scoped grid + layered shadow on hero bands
3. **`RibbonStrip`** — unified inverse band carrying massive Fraunces tabular numerals; one per page maximum, at the top of the data layer
4. **`.pulse-accent`** — soft pulse on the live brand pip (one per page; earn it)
5. **`.reveal` + `.reveal-1`…`.reveal-6`** — staggered lift-in cascade on page load

### Primitive cheatsheet

```tsx
import {
  CommandShell, PageHero, RibbonStrip, ActionPanel,
  SectionCard, StatusCard, RecordCard, FieldGroup,
  DataEmptyState, WorkflowStepper, StatusBadge,
  MonoCode, RailHeading,
  type Tone, type HeroBadge, type RibbonSegmentData, type FieldRow, type StepperStep,
} from "@/components/production/luma-ui";

<CommandShell density="wide">
  <PageHero
    eyebrow="Section · Sub-section"
    title="Page title goes here."
    description="One-line description."
    badges={[{ label: "0 items", tone: "info", mono: true }]}
  />

  <RibbonStrip
    reveal="reveal-2"
    segments={[
      { label: "Confirmed", value: "12", tone: "good", icon: CheckCircle2, live: true, hint: "..." },
      { label: "Pending",   value: "0",  tone: "info", icon: Sparkles,     hint: "..." },
    ]}
  />

  <ActionPanel
    tone="warn"
    icon={AlertTriangle}
    title="The thing the user needs to know"
    body={<>Body copy with optional <strong>emphasis</strong>.</>}
  />

  <SectionCard eyebrow="..." title="..." tone="info" reveal="reveal-3">
    {/* content */}
  </SectionCard>

  <DataEmptyState
    icon={Inbox}
    title="No items yet"
    body="What needs to happen to make items appear."
    action={<Link href="...">Do the thing →</Link>}
  />
</CommandShell>
```

**Back-compat aliases** for legacy pages: `ProductionSection`, `ProductionAlertCard`, `ProductionIdentityBlock`, `ProductionEmptyState` — these all map to the v2 primitives.

---

## Hard guardrails — do NOT relax

These are from `CLAUDE.md` plus this-session-specific.

- **Never force-push to `main`.** Branch stays untouched until owner authorises merge.
- **Never run destructive Postgres ops.** No `docker compose down --volumes`, no `DROP DATABASE`, no column drops without owner-approved data migration plan.
- **Customer-scope Nexus responses always hide:** supplier lot, internal receipt, raw bag QR, operator, machine. Regardless of allocation confirmation state. The visibility filter is non-negotiable.
- **Allocation engine never emits `HIGH` or `CONFIRMED`.** Operator confirmation is the only path. If you touch `lib/commercial-trace/allocate.ts`, keep this invariant.
- **No emoji. Anywhere.** Including commit messages and UI copy.
- **Money is integer cents.** Always. `formatMoney(cents)` is the only place cents become dollars for display.
- **Times are `timestamptz`.** Display respects `company.timezone`.
- **Server actions are the API.** Validate input with Zod, authz at the action layer via `requireAdmin()` / `requireOwner()`.
- **Every mutation writes an audit row** via `writeAudit()` in `lib/db/audit`.

### Session-specific landmines

- **`--brand-accent` is copper-amber `(217 130 32)` by design.** Don't revert to cyan. The teal/copper pair IS the identity.
- **Fraunces is loaded via `next/font/google`.** Don't swap it for a generic font; don't introduce a CDN dependency.
- **The engineering grid + ambient radials are intentional.** Don't remove `body::before` / `body::after` in `app/globals.css`.
- **`/floor-board` uses local dark-surface primitives** (`WallSection`, `WallTile`, etc.). The light-canvas primitives in `luma-ui.tsx` don't read against `bg-inverse`. Don't try to unify them.
- **`MetricCard` / `MissingState` / `ConfidenceBadge` are dark-tuned** (`bg-slate-900/60`). They work on the floor-board but would clash on a light canvas. If you build a new light-canvas KPI tile, use `StatusCard` or build a new primitive — don't reuse `MetricCard` there.
- **The ribbon clamp** at `clamp(26px, 3.2vw, 46px)` is the fix for the segment-overlap bug. Don't bump it to a fixed font size without testing 8-digit comma-formatted values at narrow viewport widths.

---

## Open questions / decisions awaiting input

These are things the AI shouldn't decide unilaterally.

1. **Turn 3 page priority.** I proposed `packaging-materials → material-alerts → recall` but the user hasn't confirmed an order. Ask if you're unsure.
2. **Final closeout doc location.** `docs/luma-ui-rebuild-1-closeout.md` matches the existing per-phase closeout convention. Confirm before writing.
3. **Merge to `main`.** Owner has explicitly held this branch off main. Don't propose the merge — they will.

---

## Verify before claiming a phase is done

Don't say "shipped" until you've done all four:

1. `npx tsc --noEmit` exits 0 in `/Users/kidevu/luma`
2. `npx next build` exits 0 (one warning about `@opentelemetry/instrumentation` dynamic-require is pre-existing — ignore it)
3. Commit pushed to `production-intelligence-command-center`
4. (Optional but earns trust) Verify the deploy actually landed on LXC 122:

   ```bash
   ssh root@192.168.1.190 -t 'pct exec 122 -- bash -c "cd /opt/luma && cat .git-sha 2>/dev/null"'
   curl -s http://192.168.1.134:3000/api/health | jq
   ```

   The deploy script silent-fail-then-skip trap is real (see `~/.claude/projects/.../memory/deploy-silent-fail-trap.md`). `/api/health` green doesn't mean your commit is deployed — confirm the SHA matches.

---

## References

- **Project brief:** `CLAUDE.md` (repo root) — always-loaded by Claude Code
- **Deep branch context:** `docs/BRANCH_CONTEXT_PRODUCTION_INTELLIGENCE_COMMAND_CENTER.md`
- **Spec (authoritative design contract):** `docs/spec.md`
- **Per-phase closeouts:** `docs/commercial-trace-{2..7}-closeout.md`, `docs/workflow-cleanup-2-closeout.md`, etc.
- **Memory:** `/Users/kidevu/.claude/projects/-Users-kidevu-Documents-payroll-rebuild/memory/MEMORY.md` (loaded automatically each session) — includes IP addresses, deploy-trap notes, drizzle migration gotchas

---

## If you only do one thing

Pick up `LUMA-UI-REBUILD-1` Turn 3 starting with `/inbound/packaging-materials`. Read the existing page, swap chrome to the new primitives, leave data loading and actions untouched, typecheck, build, commit, push. Then ask the user before moving to page 2.

That's the whole job.
