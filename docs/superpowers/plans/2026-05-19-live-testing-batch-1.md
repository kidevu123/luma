# Live Testing Stabilization — Batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first safe batch of live-testing stabilization fixes: versioning, PO filter, machine label, QR cards navigation, and visual cleanup for genealogy/material burn.

**Architecture:** All changes are pure UI or server-query changes — no schema migrations, no workflow logic alterations. Each task is independent; they can be committed separately.

**Tech Stack:** Next.js 15 App Router · TypeScript strict · Drizzle ORM · Tailwind v3 · shadcn primitives

---

## Repo Audit Findings (2026-05-19)

### Architecture
- Next.js 15 App Router + TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- PostgreSQL 16 via Drizzle ORM + drizzle-kit migrations (8 migrations, 0000–0007)
- Event-sourced production workflow (`workflow_events` append-only source of truth)
- Read models: `read_station_live`, `read_bag_metrics`, `read_daily_throughput`, `read_material_burn`
- pg-boss background projectors refresh read models on `pg_notify`

### Deployment
- **Systemd timer** on LXC 122 (`192.168.1.134`), fires every 60 seconds
- Service: `git fetch` → `git reset --hard origin/main` → `docker compose up -d --build` (only when HEAD changed or container SHA drifts)
- **Migrations auto-run** on container startup via `tsx scripts/migrate.ts` (idempotent, uses drizzle-orm migrator)
- Seed script (`tsx scripts/seed.ts`) also runs on startup, idempotent
- No CI/CD pipeline; deployment is fully pull-based from main branch

### Database connection
- `DATABASE_URL` env var constructed in `docker-compose.yml` as `postgres://luma:${POSTGRES_PASSWORD}@db:5432/luma`
- Available at runtime via `process.env.DATABASE_URL`
- Local dev fallback: `postgres://luma:luma@localhost:5432/luma`

### Versioning (current state)
- `package.json`: `"version": "0.1.0"` — not displayed in UI
- Admin footer: `v.{7-char git SHA} · {build-date}` (from `BUILD_GIT_SHA` / `BUILD_AT` env vars)
- Settings page: shows SHA + branch
- No CHANGELOG.md exists
- Build captures git SHA from `git rev-parse HEAD` during Docker build
- `package.json` is copied to the run stage, so it is readable at runtime

### PO Status Values
```typescript
pgEnum("po_status", ["DRAFT","OPEN","RECEIVING","RECEIVED","CLOSED","CANCELLED"])
// default: "OPEN"
```
The receive-wizard query fetches ALL POs with no status filter. Fix: exclude CLOSED and CANCELLED.
DRAFT: pending user clarification — probably also exclude (noted in fix).

### Machines & Stations
- `machines.cardsPerTurn` integer field, column label in UI: "Cards / turn"
- Machine kinds: BLISTER, SEALING, PACKAGING, BOTTLE_HANDPACK, BOTTLE_CAP_SEAL, BOTTLE_STICKER, COMBINED
- "Cards / turn" is misleading for all non-BLISTER kinds
- Fix: rename column header to "Units / cycle"

### QR Cards
- 3 statuses: IDLE, ASSIGNED, RETIRED
- "Print X labels" button shows count of IDLE cards only (correct, but unexplained)
- UI is a flat scrolling list with no search/filter/grouping
- No stat strip showing breakdown
- Fix: add stat strip, search, and status tabs

### Genealogy (Finished Lots detail)
- In `/finished-lots/[id]/page.tsx` as a card section
- Shows a basic table of input batches — functional but sparse
- Fix: visual improvements only, no logic changes

### Material Burn (Reports page)
- Section "Material burn (30 days)" in `/reports/page.tsx`
- Basic 4-column table — functional but sparse
- Fix: visual improvements only, no logic changes

### Standards & Targets
- **NO PAGE EXISTS** with this name in the codebase
- Sidebar nav: Dashboard, Live floor, POs & receiving, Batches, Finished lots, QR cards, Recall lookup, Reports, Metrics, Settings
- Likely user is referring to either:
  - The **Products detail page** (`/products/[id]`) which shows spec values (tabs/unit, units/display, displays/case) — production "standards"
  - The **Machines page** (`/machines`) which shows machine capacity
- **ACTION REQUIRED**: Clarify with user before implementing

### Product → Tablet Type relationship
- `product_allowed_tablets` M:M join table links products to tablet types
- `isPrimary` flag on the join
- Products detail page (`/products/[id]`) has a BomEditor that shows both allowed tablets and packaging material specs
- Relationship IS visible but requires navigating to product detail

---

## Files to Modify

| File | Change |
|------|--------|
| `package.json` | Bump `0.1.0` → `0.2.0` |
| `CHANGELOG.md` | Create new file |
| `components/admin/footer.tsx` | Add semver version read from package.json |
| `app/(admin)/inbound/new/page.tsx` | Filter POs: exclude CLOSED and CANCELLED |
| `app/(admin)/machines/page.tsx` | Rename "Cards / turn" → "Units / cycle" |
| `app/(admin)/qr-cards/qr-cards-list.tsx` | **Create** client component with stats + search + filter |
| `app/(admin)/qr-cards/page.tsx` | Use new QrCardsList component |
| `app/(admin)/finished-lots/[id]/page.tsx` | Genealogy section visual improvement |
| `app/(admin)/reports/page.tsx` | Material burn section visual improvement |

---

## Task 1: Version Bump

**Files:**
- Modify: `package.json`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Bump version in package.json**

Change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 2: Create CHANGELOG.md**

```markdown
# Changelog

## [0.2.0] — 2026-05-19

### Fixed
- PO dropdown in raw bag intake now filters out CLOSED and CANCELLED purchase orders.
- Machines & stations page: renamed "Cards / turn" column to "Units / cycle" for accuracy across all machine kinds.

### Improved
- QR cards management: added status breakdown stats, search input, and status filter tabs.
- Finished lots genealogy section: improved table layout and readability.
- Reports page: material burn section visual improvements.
- Admin footer: now shows semver version alongside git SHA.

## [0.1.0] — 2026-05-18

Initial live-testing release.
```

- [ ] **Step 3: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 0.2.0, add CHANGELOG"
```

---

## Task 2: Show Semver Version in Footer

**Files:**
- Modify: `components/admin/footer.tsx`

- [ ] **Step 1: Modify footer to read package.json version**

Read package.json at module scope using `fs.readFileSync`. Since this is a server component and `package.json` is present in the run stage at `/app/package.json`, this is reliable.

```typescript
import { readFileSync } from "fs";
import path from "path";
import { Heart } from "lucide-react";

function getPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

export function AdminFooter() {
  const sha = process.env.BUILD_GIT_SHA ?? "dev";
  const branch = process.env.BUILD_GIT_BRANCH ?? "main";
  const shortSha = sha.slice(0, 7);
  const buildAt = process.env.BUILD_AT;
  const version = getPackageVersion();

  return (
    <footer className="border-t border-border/60 bg-surface/40">
      <div className="max-w-screen-2xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[11px] text-text-subtle inline-flex items-center gap-1">
          Made with{" "}
          <Heart className="h-3 w-3 fill-rose-500 text-rose-500" aria-label="love" />{" "}
          by your Haute tech team
        </span>
        <span className="text-[10px] font-mono text-text-subtle/80 tabular-nums">
          v{version} · {shortSha}
          {branch !== "main" && branch !== "unknown" ? ` · ${branch}` : ""}
          {buildAt ? ` · ${buildAt.slice(0, 10)}` : ""}
        </span>
      </div>
    </footer>
  );
}
```

- [ ] **Step 2: Verify build does not break**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/admin/footer.tsx
git commit -m "feat: show semver version in admin footer"
```

---

## Task 3: Filter PO Dropdown

**Files:**
- Modify: `app/(admin)/inbound/new/page.tsx`

- [ ] **Step 1: Update query to exclude CLOSED and CANCELLED POs**

Current code at line 13:
```typescript
db.select().from(purchaseOrders).orderBy(asc(purchaseOrders.poNumber)),
```

New code:
```typescript
db
  .select()
  .from(purchaseOrders)
  .where(notInArray(purchaseOrders.status, ["CLOSED", "CANCELLED"]))
  .orderBy(asc(purchaseOrders.poNumber)),
```

Also add `notInArray` to imports from `drizzle-orm`.

Note on DRAFT: POs in DRAFT status are included (not filtered out) until the user confirms whether draft POs should be receivable. Document this decision in a code comment.

- [ ] **Step 2: Verify typecheck**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add app/(admin)/inbound/new/page.tsx
git commit -m "fix: filter CLOSED/CANCELLED POs from raw bag intake dropdown"
```

---

## Task 4: Fix Machine Column Label

**Files:**
- Modify: `app/(admin)/machines/page.tsx`

- [ ] **Step 1: Rename column header**

Change line 38:
```tsx
<TH className="text-right">Cards / turn</TH>
```
to:
```tsx
<TH className="text-right">Units / cycle</TH>
```

- [ ] **Step 2: Verify typecheck**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add app/(admin)/machines/page.tsx
git commit -m "fix(machines): rename 'Cards / turn' column to 'Units / cycle'"
```

---

## Task 5: QR Cards — Stats Strip + Search + Filter

**Files:**
- Create: `app/(admin)/qr-cards/qr-cards-list.tsx`
- Modify: `app/(admin)/qr-cards/page.tsx`

- [ ] **Step 1: Create QrCardsList client component**

Create `/Users/sahilkhatri/Projects/Work/luma/app/(admin)/qr-cards/qr-cards-list.tsx`:

```tsx
"use client";

import * as React from "react";
import { QrCode, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/page-header";
import { RetireButton } from "./forms";

type QrCardRow = {
  card: { id: string; label: string; status: string; retiredAt: Date | null; notes: string | null };
  bag: { id: string } | null;
  productName: string | null;
};

type StatusFilter = "all" | "IDLE" | "ASSIGNED" | "RETIRED";

const STATUS_KIND: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
  IDLE: "ok",
  ASSIGNED: "info",
  RETIRED: "neutral",
};

export function QrCardsList({ rows }: { rows: QrCardRow[] }) {
  const [q, setQ] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");

  const idleCount = rows.filter((r) => r.card.status === "IDLE").length;
  const assignedCount = rows.filter((r) => r.card.status === "ASSIGNED").length;
  const retiredCount = rows.filter((r) => r.card.status === "RETIRED").length;

  const filtered = rows.filter((r) => {
    const qLower = q.toLowerCase();
    const matchesQ =
      !q ||
      r.card.label.toLowerCase().includes(qLower) ||
      r.card.id.toLowerCase().includes(qLower) ||
      (r.productName?.toLowerCase().includes(qLower) ?? false);
    const matchesStatus = statusFilter === "all" || r.card.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  const tabs: { label: string; value: StatusFilter; count: number }[] = [
    { label: "All", value: "all", count: rows.length },
    { label: "Idle", value: "IDLE", count: idleCount },
    { label: "Assigned", value: "ASSIGNED", count: assignedCount },
    { label: "Retired", value: "RETIRED", count: retiredCount },
  ];

  return (
    <div className="space-y-4">
      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Idle" count={idleCount} hint="available to assign" tone="ok" />
        <StatTile label="Assigned" count={assignedCount} hint="carrying a bag" tone="info" />
        <StatTile label="Retired" count={retiredCount} hint="decommissioned" tone="neutral" />
      </div>

      {/* Search + filter tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-subtle pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search label or UUID…"
            className="pl-8 h-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setStatusFilter(tab.value)}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                statusFilter === tab.value
                  ? "bg-brand-700 text-white font-semibold"
                  : "text-text-muted hover:bg-surface-2"
              }`}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <p className="text-sm text-text-muted py-4 text-center">
          {q || statusFilter !== "all" ? "No cards match your filter." : "No cards yet."}
        </p>
      ) : (
        <ul className="space-y-2">
          {filtered.map(({ card, bag, productName }) => (
            <li
              key={card.id}
              className="rounded-lg border border-border/70 bg-surface p-3"
            >
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-brand-50 ring-1 ring-inset ring-brand-100 shrink-0">
                    <QrCode className="h-4 w-4 text-brand-700" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium truncate">{card.label}</p>
                    <p className="text-[11px] font-mono text-text-subtle truncate">{card.id}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusPill kind={STATUS_KIND[card.status] ?? "neutral"}>{card.status}</StatusPill>
                  {card.status === "ASSIGNED" && bag && (
                    <span className="text-[11px] text-text-muted">
                      bag {bag.id.slice(0, 8)}
                      {productName ? ` · ${productName}` : ""}
                    </span>
                  )}
                  {card.status !== "RETIRED" && (
                    <RetireButton id={card.id} disabled={card.status === "ASSIGNED"} />
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {filtered.length > 0 && filtered.length < rows.length && (
        <p className="text-[11px] text-text-subtle text-center">
          Showing {filtered.length} of {rows.length} cards
        </p>
      )}
    </div>
  );
}

function StatTile({
  label,
  count,
  hint,
  tone,
}: {
  label: string;
  count: number;
  hint: string;
  tone: "ok" | "info" | "neutral";
}) {
  const colors = {
    ok: "bg-emerald-50 border-emerald-200 text-emerald-800",
    info: "bg-blue-50 border-blue-200 text-blue-800",
    neutral: "bg-surface border-border/70 text-text-muted",
  };
  return (
    <div className={`rounded-lg border p-3 ${colors[tone]}`}>
      <div className="text-[10px] uppercase tracking-wider font-semibold opacity-70">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{count}</div>
      <div className="text-[10px] opacity-60">{hint}</div>
    </div>
  );
}
```

- [ ] **Step 2: Update QR cards page to use the new component**

In `app/(admin)/qr-cards/page.tsx`, replace the list rendering with `<QrCardsList rows={rows} />`.

- [ ] **Step 3: Verify typecheck**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add app/(admin)/qr-cards/qr-cards-list.tsx app/(admin)/qr-cards/page.tsx
git commit -m "feat(qr-cards): add stats strip, search, and status filter tabs"
```

---

## Task 6: Genealogy Visual Improvement

**Files:**
- Modify: `app/(admin)/finished-lots/[id]/page.tsx`

- [ ] **Step 1: Improve genealogy section layout**

Add a visual enhancement to the Genealogy card: show batch kind pills with clearer colors, add a subtotal row for qty consumed, and improve the empty-state message.

- [ ] **Step 2: Verify typecheck**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add app/(admin)/finished-lots/\[id\]/page.tsx
git commit -m "feat(genealogy): improve readability of input batches section"
```

---

## Task 7: Material Burn Visual Improvement

**Files:**
- Modify: `app/(admin)/reports/page.tsx`

- [ ] **Step 1: Improve material burn section**

Add total consumed row at the bottom, improve spacing, and show UoM more prominently next to quantities.

- [ ] **Step 2: Verify typecheck**

```bash
cd /Users/sahilkhatri/Projects/Work/luma && npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add app/(admin)/reports/page.tsx
git commit -m "feat(reports): improve material burn table readability"
```

---

## Rollback Instructions

All changes are UI-only. To roll back:
```bash
git revert HEAD~N  # where N is the number of commits to revert
# or simply revert individual commits
```

Since migrations do NOT run with any of these changes, there is no database rollback needed.

The systemd deploy service will pick up a revert commit within 60 seconds of `git push`.

## Deployment

Changes deploy automatically within ~60 seconds after `git push origin main`. The systemd timer on LXC 122 detects the new HEAD SHA and rebuilds the Docker image.

To trigger immediately from the server:
```bash
ssh root@192.168.1.190
lxc exec 122 -- systemctl start luma-deploy.service
```

## Items NOT Implemented (Require Further Discussion)

1. **Standards & Targets page** — No page found with this name. Need user to confirm which page they're referring to.
2. **Product selection timing** — Requires audit of workflow event sequence before changing.
3. **Bulk product family creation** — Needs design discussion.
4. **Tablet type schema/category changes** — Requires schema migration.
5. **Machine/station relationship schema changes** — Requires schema migration.
6. **Bag genealogy/material reconciliation deep changes** — Would require projector logic changes.
