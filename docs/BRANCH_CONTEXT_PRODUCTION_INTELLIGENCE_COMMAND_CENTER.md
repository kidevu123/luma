# Branch context — `production-intelligence-command-center`

> Full session context for the work on this branch. Written so any future Claude (yours, mine, or someone else's) can pick up without re-reading the entire commit log.
>
> **Last updated:** 2026-05-18
> **Branch:** `production-intelligence-command-center`
> **Base:** `main` (untouched per project guardrails)
> **Commits ahead of `main`:** 153
> **Deploy target:** LXC 122 on Proxmox (`192.168.1.134:3000`), systemd timer `luma-deploy.service` picks up new commits every 60s
> **Status:** All shipped work is live on staging. `main` will not be touched until owner explicitly authorises the merge.

---

## TL;DR

Three contiguous initiatives delivered on this branch:

1. **Production on-ramp polish** — `WORKFLOW-CLEANUP-2` made `/production/start` a guided 4-step workflow instead of a form pile, plus PO line cards and material tabs.
2. **Commercial trace pipeline** — `COMMERCIAL-TRACE-1` through `-7` built the full Zoho invoice → finished-lot → Nexus customer-scope lookup chain. Operators confirm allocations; only confirmed rows become Nexus-visible. Customer-scope responses ALWAYS hide supplier lot / internal receipt / raw bag QR / operator / machine.
3. **Premium UI rebuild** — `LUMA-UI-REBUILD-1` turns 1–2 + v2 swung the design language from "Notion + Linear" to **Operations Atelier** (luxury-industrial: brand-teal dominant against a copper-amber accent, Fraunces display serif, visible engineering grid, signature 3px rail with inner highlight + outer bloom, unified inverse RibbonStrip carrying massive tabular display numerals).

Plus `CLAUDE-SKILLS-1` (8 repo-local Claude Code skills installed).

---

## 1. WORKFLOW-CLEANUP-2 — production on-ramp

**Commits:** `fe8778a` (feat) → `a7c0895` (closeout)

**What changed**

- PO line cards on `/inbound/[poId]` — one card per Zoho line, with allowed-tablet-type chip, qty-ordered vs. qty-received, receipt receipts list.
- Material tabs on packaging / packaging-materials surfaces — kind-filtered.
- `/production/start` rebuilt as a guided 4-step flow:
  1. Scan raw bag (inventory_bag QR)
  2. Pick product (filtered by `product_allowed_tablets`)
  3. Assign an IDLE workflow QR card
  4. Pick an active station
  5. Click Start — fires `CARD_ASSIGNED` through `projectEvent`, same path the floor PWA uses

**Critical files**

- `app/(admin)/inbound/[poId]/po-lines-cards.tsx`
- `app/(admin)/production/start/page.tsx`
- `app/(admin)/production/start/start-production-form.tsx`
- `app/(admin)/production/start/actions.ts`

---

## 2. COMMERCIAL-TRACE 1–7 — Zoho ↔ Luma ↔ Nexus

The full commercial-trace pipeline. Read `docs/COMMERCIAL_TRACEABILITY_PLAN.md` for the design contract.

### CT-1 — vision pivot (`bd2ca15`)

Doc-only: pivoted from a "match every Zoho invoice line to an internal batch automatically" approach to **operator-confirmed allocations**. Engine suggests; operator confirms; Nexus only ever serves confirmed rows.

### CT-2 — schema (`bb4cc13` → `8269016`)

Migrations + Drizzle schema for:

- `zoho_invoices` (id, invoiceNumber, customerId, invoiceDate, …)
- `zoho_invoice_lines` (id, zohoInvoiceId, itemName, sku, zohoItemId, quantity, unit, …)
- `finished_lot_invoice_allocations` (id, invoiceLineId, finishedLotId, shipmentFinishedLotId?, quantityAllocated, unit, confidence, source, status, confirmed, confirmedAt, notes, …)

Verified on staging.

### CT-3 — Zoho invoice dry-run client (`8a747a6` → `5eb17aa`)

Read-only client against the Zoho gateway. Imports invoice rows with their line items, parses item names + SKUs, writes to `zoho_invoices` + `zoho_invoice_lines`. Preview UI surfaces what would be imported before the live run.

### CT-4 — finished-lot allocation suggestion engine (`19f7059` → `0afbc48`)

Pure logic in `lib/commercial-trace/allocate.ts`. Tests: 1585/1585 passing.

**Hard rules (don't relax):**

- Engine **never** emits `HIGH` confidence.
- Engine **never** emits `CONFIRMED` status.
- Engine emits `SUGGESTED` (with `MEDIUM` / `LOW` / `MISSING` confidence) or `NEEDS_REVIEW`.
- Operator confirmation flips `confirmed=true`, `confidence=HIGH`, `confirmedAt`, audits the action.
- Rejection is soft — kept for audit trail (`status=REJECTED`).

### CT-5 — allocation review UI (`85acbca` → `99ec63e`)

`/invoice-allocations` (admin only). Master-detail layout:

- **Queue** (left): filterable list of invoice lines (`?invoice` / `?customer` / `?sku` / `?status` / `?confidence` / `?needs_review` / `?unconfirmed`).
- **Review panel** (right, sticky): selected line's allocations with Confirm / Reject actions. Audit-logged.

### CT-6 — Nexus read-only invoice/batch lookup (`57ea9d9` → `98b5d2a`)

Endpoints under `/api/nexus/`:

- `GET /api/nexus/invoice/[invoiceNumber]` — returns confirmed allocations for the invoice
- `GET /api/nexus/batch/[traceCode]` — returns confirmed allocations for the finished lot

**Customer-scope responses always hide:**

- Supplier lot
- Internal receipt
- Raw bag QR
- Operator
- Machine

…regardless of whether the allocation is confirmed. The visibility filter is non-negotiable.

### CT-7 — mock end-to-end verification (`1f1338e` → `03c4216`)

`scripts/verify-commercial-trace.ts` runs the entire chain end-to-end against a seeded staging DB:

1. Seed mock invoice + line
2. Run engine → SUGGESTED row
3. Confirm via server action → HIGH confidence
4. Hit `/api/nexus/invoice/<num>` → returns confirmed allocation with customer-scope filter applied
5. Hit `/api/nexus/batch/<trace>` → reverse direction works

VERIFY OK on staging.

**Critical files (commercial-trace pipeline):**

- `lib/db/schema.ts` (`zohoInvoices`, `zohoInvoiceLines`, `finishedLotInvoiceAllocations`)
- `lib/commercial-trace/allocate.ts` — pure suggestion engine
- `lib/commercial-trace/import-invoices.ts` — Zoho dry-run + apply
- `app/(admin)/invoice-allocations/page.tsx` — review UI
- `app/(admin)/invoice-allocations/invoice-allocation-actions.tsx` — Confirm / Reject client component
- `app/(admin)/invoice-allocations/actions.ts` — server actions
- `app/api/nexus/invoice/[invoiceNumber]/route.ts`
- `app/api/nexus/batch/[traceCode]/route.ts`
- `scripts/verify-commercial-trace.ts`

---

## 3. CLAUDE-SKILLS-1 — repo-local agent skills

**Commit:** `1bca2d6`

Installed 8 Claude Code skills at `~/.agents/skills/`:

- `frontend-design` — distinctive production-grade frontend design guidance
- `web-design-guidelines` — Vercel's web interface guidelines auditor
- `shadcn` — shadcn primitives helper (not used here; would require `components.json` init)
- + 5 Luma-specific workflow skills

Updated `/update-config` settings to register the skills directory.

---

## 4. LUMA-UI-REBUILD-1 — Operations Atelier

The biggest visual change in the session. Four commits, three distinct phases.

### Turn 1 (`943c381`) — foundation

**Design tokens** in `app/globals.css`:

- Canvas: warm-paper `rgb(248 247 245)` (NOT pure white)
- Surface: white `rgb(255 255 255)` lifted cards
- Surface-2 / -3: cool-neutral wells
- Inverse: deep `rgb(14 18 26)` for the wallboard + sidebar header
- Brand teal scale: 50 / 100 / 200 / 500–900
- Status tones: good / warn / crit / info / muted — 50 / 500 / 700 each
- Hairline borders + shadow stack

**Fonts:** Geist Sans + Geist Mono self-hosted via `next/font/geist` (no Google Fonts runtime).

**Primitive library** at `components/production/luma-ui.tsx`:

| Primitive | Purpose |
|---|---|
| `CommandShell` | Page chrome (max-width rail, density: default / wide / wallboard) |
| `PageHero` | Eyebrow + display title + description + badges + actions |
| `SectionCard` | Canonical lifted panel with 3px tone rail |
| `ActionPanel` | Alert / banner band — earn each one |
| `StatusCard` | Compact summary tile, tone-rail + display number |
| `RecordCard` | Clickable record summary (rail signals selection) |
| `FieldGroup` | Identity / metadata grid with nested wells |
| `DataEmptyState` | Honest, contextual empty moment with action CTA |
| `WorkflowStepper` | Staged-task indicator |
| `StatusBadge` | Tone-tinted chip |
| `MonoCode` | Inline code / ID fragment |
| `RailHeading` | Section header with rail signature |

Back-compat aliases exported so existing pages keep rendering: `ProductionSection`, `ProductionAlertCard`, `ProductionIdentityBlock`, `ProductionEmptyState`.

**Sidebar rebuilt** (`components/admin/sidebar.tsx`):

- 232px wide, inverse brand header band carrying `LUMA / Production Command` + brand-accent pulse dot
- Rail-anchored active route — the signature motif
- Hairline section dividers, section eyebrow labels
- Advanced section collapses (auto-opens when current path matches)
- Footer band: `Floor · Staging` + good-500 status pip

**`/invoice-allocations` rebuilt** — `CommandShell wide` + `PageHero` + `ActionPanel` for the Nexus-safety banner + 5 `StatusCard` summary tiles + master-detail grid with sticky review panel.

### Turn 2 (`901fed6`) — three more pages

- `/receiving/raw-bags` — `CommandShell` + `PageHero` (3-badge cluster: PO count / tablet types / Zoho readiness) + `ActionPanel` toned warn/good by gateway state. Form + actions untouched.
- `/production/start` — `CommandShell` + `PageHero` + `WorkflowStepper` (5 steps: Scan → Pick → Assign → Station → Start) + capacity-toned hero badges.
- `/floor-board` — full dark wallboard rebuild with local `WallSection / WallPanel / WallTile / WallAlert / WallEmpty / StageTile / MachineTile` primitives tuned for `bg-inverse`. `MetricCard / MissingState / ConfidenceBadge / LiveRefresh` preserved (already dark-tuned). Every read query unchanged.

### v2 — Operations Atelier (`f38f1f8`) — bold direction change

User feedback on v1: "everything looks every same and very bland". v2 is the bold swing.

**Aesthetic direction:** luxury-industrial. Watchmaker + Bloomberg terminal + architectural drawing. Brand-teal dominant against a copper-amber accent earned only on the live moment.

**Token changes:**

- `--brand-accent` flipped from cyan-teal `(6 182 178)` → **copper-amber `(217 130 32)`**. The teal/copper pair is the system identity.
- Engineering grid now visible on the canvas: opacity raised to 3.5%, wider mask.
- Body ambient layer adds dual radial brand+accent wash at the top.
- Layered shadows: `--shadow-card` adds top-edge white inset; `--shadow-hero` and `--shadow-ribbon` ship; `--shadow-glow-accent` for the live pip.
- 3px rail: now carries `inset 1px 0 0 rgb(255 255 255 / 0.35)` + `4px 0 16px -6px currentColor` for the inner highlight + outer bloom.

**New surface classes:**

- `.surface-card` — gradient body + top-edge highlight + layered shadow
- `.surface-hero` — gradient + brand+accent dual radial + scoped grid + dramatic shadow
- `.surface-ribbon` — inverse band with brand+accent wash + faint white grid + dramatic shadow

**Display fonts:**

- **Fraunces** loaded via `next/font/google` (self-hosted at build) — modern high-contrast serif. Variable axes used via `font-variation-settings: "opsz" 144, "SOFT" 50, "WONK" 0`.
- Geist Sans stays for body, Geist Mono for code/IDs.
- Two display classes: `.display-num` (hero numerals, tabular, opsz 144) and `.display-title` (hero titles, opsz 96).

**Motion utilities:**

- `.reveal` + `.reveal-1` … `.reveal-6` — staggered page-load `lift-in` cascade
- `.pulse-accent` — soft 2.4s pulse for the live brand pip
- `.lift-on-hover` — clickable cards translate(-1px) + shadow-pop

**New `RibbonStrip` primitive** — the signature KPI band. Unified inverse surface, hairline dividers between segments, **massive Fraunces tabular numerals** (clamp 26→46px), accent pulse only on the live segment.

```ts
<RibbonStrip
  reveal="reveal-2"
  segments={[
    { label: "Finalized today", value: "12", tone: "good", icon: PackageCheck, hint: "+22% vs avg", live: true },
    { label: "Tablets on the floor", value: "8,933,565", tone: "muted", icon: Wallet, hint: "..." },
    // ...
  ]}
/>
```

**Page applications (v2):**

- `/dashboard` — **first impression, full rebuild.** `PageHero` + `RibbonStrip` for the 5 owner numbers + `ActionPanel` for the highest-stakes prediction + `SectionCard` for top finalized flavors + `QuickLink` record cards.
- `/invoice-allocations` — 5-card status grid collapsed into the `RibbonStrip`. Confirmed segment pulses live when > 0.
- `/floor-board` — Fraunces `display-title` at 36–42px, `pulse-accent` on the brand pip. Inherits copper accent automatically.
- `/receiving/raw-bags` + `/production/start` — no source edits; inherit v2 visual upgrades through the primitives.
- Sidebar — brand pip now pulses copper.

### Ribbon overlap fix (`9785709`)

Caught from user screenshot: `8,933,565` was bleeding into the next ribbon segment. Equal-width grid + fixed 58px Fraunces can't fit an 8-digit comma-formatted number in ~220px columns.

Fix in `RibbonSegment`:

- `min-w-0` on segment wrapper (grid track can shrink)
- `clamp(26px, 3.2vw, 46px)` on value font-size (responsive)
- `truncate` + `title` attribute (safety net)
- `shrink-0` on live pip + icons
- `line-clamp-2` on hints

---

## Branch deploy + verify

```bash
# Tail app logs on the LXC
ssh root@192.168.1.190 -t 'pct exec 122 -- bash -c "cd /opt/luma && docker compose logs -f --tail=200 app"'

# Force a deploy now (instead of waiting for the next 60s tick)
ssh root@192.168.1.190 -t 'pct exec 122 -- systemctl start luma-deploy.service'

# Health check from outside
curl -s http://192.168.1.134:3000/api/health | jq
```

The deploy timer override lives at `/etc/systemd/system/luma-deploy.service.d/staging-branch.conf` and tracks `PAYROLL_BRANCH=production-intelligence-command-center`.

---

## Test + verify status

- Unit + integration tests: **1585 / 1585 passing** (last full run after CT-4)
- TypeScript: `tsc --noEmit` clean as of `9785709`
- Production build: clean (all 80+ routes compile). One pre-existing warning: `@opentelemetry/instrumentation` dynamic-require — unrelated to this branch.
- Auth smoke: 50/50 passing
- Commercial-trace end-to-end verification: VERIFY OK at `db5e61c`

---

## Outstanding work — LUMA-UI-REBUILD-1 turn 3

Not yet shipped:

- `/inbound/packaging-materials` chrome rebuild
- `/material-alerts` chrome rebuild
- `/recall` chrome rebuild
- Taste audit pass across all rebuilt pages (`web-design-guidelines` skill)
- Vitest pass on UI changes
- Final report doc

All four remaining pages will inherit the v2 design language automatically once their chrome is swapped to the new primitives.

---

## Hard guardrails (preserved — do NOT relax)

- **Never force-push to `main`.** Until the owner explicitly merges this branch, `main` stays untouched.
- **Never run destructive Postgres operations.** No `docker compose down --volumes`, no `DROP DATABASE`, no migrations that drop user-data columns without an owner-approved data migration plan.
- **Never bypass the vault for credentials.** Plaintext is sealed via `lib/crypto/vault.ts` before writing.
- **Never paste real secrets into chat or commit them.** `ZOHO_INTEGRATION_SECRET`, Postgres password, and gateway URLs live in `/etc/luma/.env` on the LXC, mode 0600.
- **Customer-scope Nexus responses always hide:** supplier lot, internal receipt, raw bag QR, operator, machine — regardless of confirmation state. The visibility filter is non-negotiable.
- **Allocation engine never emits HIGH or CONFIRMED.** Operator confirmation is the only path.
- **No emoji.** Anywhere. Including commit messages.

---

## Design system reference (v2)

### Tone vocabulary (semantic, never decoration)

| Tone | Meaning | Light surface text | Inverse surface text |
|---|---|---|---|
| `good` | running / ready / verified / confirmed | `text-good-700` | `text-emerald-300` |
| `warn` | degraded / partial / needs review | `text-warn-700` | `text-amber-300` |
| `crit` | blocked / conflict / over-allocated | `text-crit-700` | `text-rose-300` |
| `info` | neutral signal / data window | `text-info-700` | `text-cyan-300` |
| `muted` | missing / idle / legacy / waiting | `text-muted-700` | `text-text-inverse/65` |
| `brand` | primary CTA / active nav / live signal | `text-brand-800` | `text-[rgb(var(--brand-accent-bright))]` |

### Display number scale

- `.display-num` — hero numerals (Fraunces, opsz 144, tabular)
- `.display-title` — hero titles (Fraunces, opsz 96)
- `.eyebrow` — uppercase tracking-[0.18em] small caps

### Primitive composition cheatsheet

```tsx
<CommandShell density="wide">
  <PageHero
    eyebrow="Owner home · Today"
    title="Today, at a glance."
    description="Five numbers that matter. One prediction worth acting on."
    badges={[{ label: "0 events 24h", tone: "info", mono: true }]}
  />

  <RibbonStrip segments={[...]} reveal="reveal-2" />

  <ActionPanel tone="warn" icon={AlertTriangle} title="..." body={<>...</>} />

  <SectionCard eyebrow="..." title="..." tone="info" reveal="reveal-3">
    {/* content */}
  </SectionCard>
</CommandShell>
```

---

## Key routes

| Route | Status | Notes |
|---|---|---|
| `/dashboard` | v2 ✅ | Owner home, RibbonStrip + ActionPanel |
| `/invoice-allocations` | v2 ✅ | Operator review of commercial-trace allocations |
| `/floor-board` | v2 ✅ | Dark wallboard, command-center |
| `/receiving/raw-bags` | v1 ✅ (inherits v2) | Single-screen raw-bag intake |
| `/production/start` | v1 ✅ (inherits v2) | Guided 4-step run on-ramp |
| `/inbound/packaging-materials` | unchanged | Queued for turn 3 |
| `/material-alerts` | unchanged | Queued for turn 3 |
| `/recall` | unchanged | Queued for turn 3 |
| `/api/nexus/invoice/[invoiceNumber]` | CT-6 ✅ | Customer-scope filtered |
| `/api/nexus/batch/[traceCode]` | CT-6 ✅ | Customer-scope filtered |

---

## Commit ledger (recent 30 on this branch)

```
9785709 fix(ui): ribbon segment overlap — clamp display value + truncate guard
f38f1f8 feat(ui): LUMA-UI-REBUILD-1 v2 — Operations Atelier design language
901fed6 feat(ui): LUMA-UI-REBUILD-1 turn 2 — receiving/raw-bags + production/start + floor-board
943c381 feat(ui): LUMA-UI-REBUILD-1 turn 1 — command-surface tokens, fonts, primitives, sidebar, invoice-allocations
1bca2d6 chore(claude-skills-1): install 8 repo-local Claude Code skills
03c4216 docs(commercial-trace-7): closeout — mock end-to-end verification VERIFY OK at db5e61c
db5e61c fix(commercial-trace-7): compose endpoint behavior via helpers + DB loaders
214fa32 fix(commercial-trace-7): tsx ESM resolver needs explicit .ts extension
b85cf26 fix(commercial-trace-7): use relative imports for nexus route handlers
1f1338e feat(commercial-trace-7): mock end-to-end commercial trace verification
98b5d2a docs(commercial-trace-6): closeout — Nexus read-only lookup endpoints verified at 57ea9d9
57ea9d9 feat(commercial-trace-6): Nexus read-only invoice/batch lookup endpoints
99ec63e docs(commercial-trace-5): closeout — allocation review UI verified at 85acbca
85acbca feat(commercial-trace-5): allocation review UI
0afbc48 docs(commercial-trace-4): closeout — allocation engine verified at 19f7059
19f7059 feat(commercial-trace-4): finished-lot allocation suggestion engine
5eb17aa docs(commercial-trace-3): closeout — invoice dry-run client + preview verified at 8a747a6
8a747a6 feat(commercial-trace-3): Zoho invoice dry-run client + preview
8269016 docs(commercial-trace-2): closeout — schema verified on staging at bb4cc13
bb4cc13 feat(commercial-trace-2): schema for Zoho invoices, invoice lines, and allocations
a7c0895 docs(workflow-cleanup-2): closeout — PO line cards, material tabs, Start production verified at fe8778a
fe8778a feat(workflow-cleanup-2): PO line cards, material tabs, Start production page
aa58aa5 docs(intake-workflow-1): closeout — PO-driven raw intake verified at 59182fd
59182fd feat(intake-workflow-1): PO-driven one-screen raw bag intake
4b4cdf1 docs(workflow-ux-1): closeout — workflow-first sidebar verified at 39c5140
39c5140 feat(workflow-ux-1): workflow-first sidebar + raw-bag intake placeholder
bd2ca15 docs(commercial-trace-1): vision pivot — Zoho invoice ↔ Luma batch allocation
dd099e1 docs(nexus-0): customer complaint integration plan
0aa4568 docs(zoho-2a): closeout — dry-run scaffolding verified at 7c60dc9
```

Earlier 120+ commits cover the prior Zoho gateway + UI scaffolding work, included in the branch ancestry but pre-dating this session.
