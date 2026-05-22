# Sidebar Navigation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the admin sidebar from 4 sections (20 items, 15 buried in "Advanced") to a clean 3-section layout with pinned Dashboard/Live floor, so daily-use pages are always visible and niche views live as tabs inside their parent pages.

**Architecture:** Sidebar.tsx is replaced with a new `PINNED_TOP` array + 3 `SECTIONS` (Operations, Inventory, Reports) + a standalone Settings link — no more collapsed "Advanced" dumping ground. Five pages gain tab bars via dedicated `*-tabs.tsx` components following the existing `receiving-tabs.tsx` pattern. Settings hub gains 4 new cards. All existing URLs remain functional.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict, Tailwind v3, Lucide icons, Vitest (existing test suite).

---

## File Map

| File | Change |
|---|---|
| `components/admin/sidebar.test.ts` | Replace old invariants with new structure assertions |
| `components/admin/sidebar.tsx` | New PINNED_TOP + 3 SECTIONS, remove Advanced/Oversight/Configure |
| `components/ui/receiving-tabs.tsx` | Add Packaging receipts + PO reconciliation tabs |
| `components/ui/materials-tabs.tsx` | Create — Stock · Active rolls · Alerts tabs |
| `app/(admin)/packaging-inventory/page.tsx` | Import and render MaterialsTabs |
| `components/ui/metrics-tabs.tsx` | Create — Throughput · Production reports · Capacity · Roll variance tabs |
| `app/(admin)/metrics/page.tsx` | Import and render MetricsTabs |
| `app/(admin)/settings/page.tsx` | Add Analytics section with 4 new hub cards |

---

## Task 1: Update sidebar tests for new structure

The test file parses `sidebar.tsx` as a text file and will fail once the sidebar changes. Update it first so the new tests fail → then the sidebar fix makes them pass.

**Files:**
- Modify: `components/admin/sidebar.test.ts`

- [ ] **Step 1: Replace sidebar.test.ts with the new invariants**

```typescript
// components/admin/sidebar.test.ts
// NAV-REDESIGN-1 — sidebar invariants for the consolidated nav.
//
// Parses sidebar.tsx as source text and asserts the structural
// contract: 3 sections, pinned top items, nothing buried in Advanced.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "sidebar.tsx"), "utf8");

// ─── Section headings ────────────────────────────────────────────────────

describe("NAV-REDESIGN-1 · section headings", () => {
  it("has an Operations section", () => {
    expect(src).toMatch(/heading:\s*"Operations"/);
  });
  it("has an Inventory section", () => {
    expect(src).toMatch(/heading:\s*"Inventory"/);
  });
  it("has a Reports section", () => {
    expect(src).toMatch(/heading:\s*"Reports"/);
  });
  it("does NOT have an Advanced collapsed section", () => {
    expect(src).not.toMatch(/collapsedByDefault:\s*true/);
  });
  it("does NOT have an Oversight section", () => {
    expect(src).not.toMatch(/heading:\s*"Oversight"/);
  });
  it("does NOT have a Configure section", () => {
    expect(src).not.toMatch(/heading:\s*"Configure"/);
  });
});

// ─── Pinned top items ────────────────────────────────────────────────────

describe("NAV-REDESIGN-1 · pinned top items", () => {
  it("Dashboard is in PINNED_TOP", () => {
    const pinnedAt = src.indexOf("PINNED_TOP");
    const sectionsAt = src.indexOf("SECTIONS");
    const dashAt = src.indexOf('"/dashboard"');
    expect(dashAt).toBeGreaterThan(-1);
    expect(dashAt).toBeLessThan(sectionsAt);
    expect(dashAt).toBeGreaterThan(pinnedAt);
  });
  it("Live floor is in PINNED_TOP", () => {
    const pinnedAt = src.indexOf("PINNED_TOP");
    const sectionsAt = src.indexOf("SECTIONS");
    const liveAt = src.indexOf('"/floor-board"');
    expect(liveAt).toBeGreaterThan(-1);
    expect(liveAt).toBeLessThan(sectionsAt);
    expect(liveAt).toBeGreaterThan(pinnedAt);
  });
});

// ─── Operations entries ──────────────────────────────────────────────────

describe("NAV-REDESIGN-1 · Operations entries", () => {
  function inOps(s: string): boolean {
    const start = src.indexOf('heading: "Operations"');
    const end = src.indexOf('heading: "Inventory"');
    const at = src.indexOf(s);
    return start > -1 && at > start && at < end;
  }

  it("Start production is in Operations", () => {
    expect(inOps('"/production/start"')).toBe(true);
  });
  it("Receiving is in Operations", () => {
    expect(inOps('"/inbound"')).toBe(true);
  });
  it("Pack-out is in Operations", () => {
    expect(inOps('"Pack-out"')).toBe(true);
  });
  it("QC review is in Operations", () => {
    expect(inOps('"QC review"')).toBe(true);
  });
});

// ─── Inventory entries ───────────────────────────────────────────────────

describe("NAV-REDESIGN-1 · Inventory entries", () => {
  function inInventory(s: string): boolean {
    const start = src.indexOf('heading: "Inventory"');
    const end = src.indexOf('heading: "Reports"');
    const at = src.indexOf(s);
    return start > -1 && at > start && at < end;
  }

  it("Materials (packaging-inventory) is in Inventory", () => {
    expect(inInventory('"/packaging-inventory"')).toBe(true);
  });
  it("Finished lots is in Inventory", () => {
    expect(inInventory('"/finished-lots"')).toBe(true);
  });
  it("Batches is in Inventory", () => {
    expect(inInventory('"/batches"')).toBe(true);
  });
  it("Workflows is in Inventory", () => {
    expect(inInventory('"/workflow-submissions"')).toBe(true);
  });
  it("Find lot is in Inventory", () => {
    expect(inInventory('"/recall"')).toBe(true);
  });
});

// ─── Reports entries ─────────────────────────────────────────────────────

describe("NAV-REDESIGN-1 · Reports entries", () => {
  function inReports(s: string): boolean {
    const start = src.indexOf('heading: "Reports"');
    const end = src.length; // Reports is last section
    const at = src.indexOf(s);
    return start > -1 && at > start && at < end;
  }

  it("Metrics is in Reports", () => {
    expect(inReports('"/metrics"')).toBe(true);
  });
  it("Productivity is in Reports", () => {
    expect(inReports('"/operator-productivity"')).toBe(true);
  });
});

// ─── Settings link present ───────────────────────────────────────────────

describe("NAV-REDESIGN-1 · Settings", () => {
  it("Settings link exists", () => {
    expect(src).toMatch(/href.*"\/settings"/);
  });
});

// ─── Sidebar routes — the 14 linked hrefs ───────────────────────────────

describe("NAV-REDESIGN-1 · sidebar routes", () => {
  const routes = [
    "/dashboard",
    "/floor-board",
    "/production/start",
    "/inbound",
    "/packaging-output",
    "/qc-review",
    "/packaging-inventory",
    "/finished-lots",
    "/batches",
    "/workflow-submissions",
    "/recall",
    "/metrics",
    "/operator-productivity",
    "/settings",
  ];
  for (const route of routes) {
    it(`${route} is linked`, () => {
      expect(src).toMatch(new RegExp(`href.*"${route.replace(/\//g, "\\/")}"`));
    });
  }
});

// ─── Routes that moved OUT of sidebar ───────────────────────────────────

describe("NAV-REDESIGN-1 · removed sidebar routes", () => {
  const removed = [
    "/genealogy",
    "/po-reconciliation",
    "/packaging-receipts",
    "/active-rolls",
    "/material-alerts",
    "/reports",
    "/production-capacity",
    "/roll-variance",
    "/material-reconciliation",
    "/invoice-allocations",
    "/product-packaging-requirements",
    "/zoho-operations",
    "/products",
  ];
  for (const route of removed) {
    it(`${route} is NOT a sidebar href`, () => {
      // The route may appear in comments or isActive logic — check it's
      // not an href value.
      expect(src).not.toMatch(
        new RegExp(`href:\\s*"${route.replace(/\//g, "\\/")}"`),
      );
    });
  }
});

// ─── Data-honesty banned phrases ─────────────────────────────────────────

describe("NAV-REDESIGN-1 · banned phrases", () => {
  it("does not introduce banned QC phrases", () => {
    expect(src).not.toMatch(/production loss/i);
    expect(src).not.toMatch(/supplier shortage/i);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd /Users/kidevu/luma && npx vitest run components/admin/sidebar.test.ts 2>&1 | tail -30
```

Expected: many failures (old sidebar hasn't changed yet). That's correct — these are the failing tests we'll make pass in Task 2.

- [ ] **Step 3: Commit the test update**

```bash
git add components/admin/sidebar.test.ts
git commit -m "test: update sidebar invariants for consolidated nav (failing)"
```

---

## Task 2: Restructure sidebar.tsx

Replace the 4-section layout (Operations / Oversight / Configure / Advanced) with pinned top items + 3 sections + Settings link.

**Files:**
- Modify: `components/admin/sidebar.tsx`

- [ ] **Step 1: Replace sidebar.tsx with the new structure**

```typescript
"use client";

// NAV-REDESIGN-1 — consolidated nav.
// 3 sections (Operations, Inventory, Reports) + pinned Dashboard/Live
// floor at top + Settings link at bottom. No collapsed Advanced group.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Boxes,
  PackageCheck,
  Sliders,
  BarChart3,
  QrCode,
  Search,
  Users,
  Package,
  ShieldAlert,
  Inbox,
  Activity,
  ShieldCheck,
  ClipboardList,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };
type Section = { heading: string; items: NavItem[] };

const PINNED_TOP: NavItem[] = [
  { href: "/dashboard",   label: "Dashboard",   icon: LayoutDashboard },
  { href: "/floor-board", label: "Live floor",  icon: Activity },
];

const SECTIONS: Section[] = [
  {
    heading: "Operations",
    items: [
      { href: "/production/start",   label: "Start production", icon: QrCode },
      { href: "/inbound",            label: "Receiving",        icon: Inbox },
      { href: "/packaging-output",   label: "Pack-out",         icon: Package },
      { href: "/qc-review",          label: "QC review",        icon: ShieldAlert },
    ],
  },
  {
    heading: "Inventory",
    items: [
      { href: "/packaging-inventory", label: "Materials",     icon: Boxes },
      { href: "/finished-lots",       label: "Finished lots", icon: PackageCheck },
      { href: "/batches",             label: "Batches",       icon: ShieldCheck },
      { href: "/workflow-submissions", label: "Workflows",    icon: ClipboardList },
      { href: "/recall",              label: "Find lot",      icon: Search },
    ],
  },
  {
    heading: "Reports",
    items: [
      { href: "/metrics",                label: "Metrics",      icon: BarChart3 },
      { href: "/operator-productivity",  label: "Productivity", icon: Users },
    ],
  },
];

const EXACT_MATCH_HREFS = new Set(["/settings"]);

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard" || pathname === "/";
  if (EXACT_MATCH_HREFS.has(href)) return pathname === href;
  if (href === "/inbound" && pathname.startsWith("/receiving/raw-bags")) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
}: NavItem & { active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "group/link relative flex items-center gap-2.5 pl-5 pr-3 py-[7px] rounded-md text-[12.5px] tracking-tight transition-colors",
        active
          ? "bg-surface-2 text-text-strong font-medium"
          : "text-text-muted hover:bg-surface-2/70 hover:text-text",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1 left-1.5 w-[3px] rounded-full transition-colors",
          active
            ? "bg-brand-accent"
            : "bg-transparent group-hover/link:bg-border-strong",
        )}
      />
      <Icon
        className={cn(
          "h-[15px] w-[15px] shrink-0 transition-colors",
          active ? "text-brand-800" : "text-text-subtle group-hover/link:text-text-muted",
        )}
        aria-hidden
      />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 mb-1 mt-1">
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-text-subtle/80">
        {children}
      </span>
      <span aria-hidden className="flex-1 border-t border-border/60" />
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname() ?? "";
  return (
    <aside className="hidden lg:flex w-[232px] shrink-0 flex-col bg-surface border-r border-border sticky top-0 h-dvh">
      <Link
        href="/dashboard"
        className="relative block bg-inverse text-text-inverse px-5 pt-5 pb-4 border-b border-inverse hover:opacity-90 transition-opacity"
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-inverse/55">
              Luma
            </div>
            <div className="mt-0.5 font-display text-[15px] font-semibold tracking-tight text-text-inverse">
              Production Command
            </div>
          </div>
          <span
            aria-hidden
            className="pulse-accent mt-1 inline-block h-2 w-2 rounded-full bg-brand-accent"
          />
        </div>
      </Link>

      <nav className="flex-1 px-2 py-3 overflow-y-auto flex flex-col gap-0">
        {/* Pinned — Dashboard + Live floor */}
        <ul className="space-y-px mb-2">
          {PINNED_TOP.map((it) => (
            <li key={it.href}>
              <NavLink {...it} active={isActive(pathname, it.href)} />
            </li>
          ))}
        </ul>

        <hr className="border-border/50 mx-1 mb-2" />

        {/* Main sections */}
        <div className="space-y-3 flex-1">
          {SECTIONS.map((sec) => (
            <div key={sec.heading}>
              <SectionHeading>{sec.heading}</SectionHeading>
              <ul className="space-y-px">
                {sec.items.map((it) => (
                  <li key={it.href}>
                    <NavLink {...it} active={isActive(pathname, it.href)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Settings — bottom of scrollable nav */}
        <div className="mt-3">
          <hr className="border-border/50 mx-1 mb-2" />
          <NavLink
            href="/settings"
            label="Settings"
            icon={Sliders}
            active={isActive(pathname, "/settings")}
          />
        </div>
      </nav>

      <div className="border-t border-border bg-surface-2/40 px-4 py-3">
        <div className="flex items-center justify-between text-[10px] text-text-subtle">
          <span className="font-mono uppercase tracking-[0.12em]">
            Floor · Staging
          </span>
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-good-500" />
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Run the tests**

```bash
npx vitest run components/admin/sidebar.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add components/admin/sidebar.tsx
git commit -m "feat: consolidated sidebar nav — 3 sections, pinned Dashboard/Live floor"
```

---

## Task 3: Update receiving-tabs.tsx — add PO reconciliation + Packaging receipts

The Receiving page already has 3 tabs (Purchase orders, Receive pills, Receive packaging). Add 2 more so users can reach PO reconciliation and the packaging receipts audit list without the sidebar.

**Files:**
- Modify: `components/ui/receiving-tabs.tsx`

- [ ] **Step 1: Update receiving-tabs.tsx**

```typescript
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Truck, Inbox, Boxes, ClipboardList, GitCompare } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/inbound",                     label: "Purchase orders",    icon: Truck },
  { href: "/receiving/raw-bags",          label: "Receive pills",      icon: Inbox },
  { href: "/inbound/packaging-materials", label: "Receive packaging",  icon: Boxes },
  { href: "/packaging-receipts",          label: "Packaging receipts", icon: ClipboardList },
  { href: "/po-reconciliation",           label: "PO reconciliation",  icon: GitCompare },
] as const;

function isTabActive(pathname: string, href: string): boolean {
  if (href === "/inbound") {
    return (
      pathname === "/inbound" ||
      (pathname.startsWith("/inbound/") &&
        !pathname.startsWith("/inbound/packaging-materials"))
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function ReceivingTabs() {
  const pathname = usePathname() ?? "";
  return (
    <div className="flex items-center gap-0 border-b border-border/70 mb-5 overflow-x-auto">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = isTabActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-2.5 text-[12.5px] font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
              active
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-text-muted hover:text-text hover:border-border-strong",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {label}
          </Link>
        );
      })}
    </div>
  );
}
```

Note: added `overflow-x-auto` and `whitespace-nowrap` since 5 tabs may be tight on smaller desktop widths.

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add components/ui/receiving-tabs.tsx
git commit -m "feat: receiving tabs — add Packaging receipts and PO reconciliation"
```

---

## Task 4: Create materials-tabs.tsx

New tab component for the Materials (packaging-inventory) page. Three tabs: Stock (existing page), Active rolls, Material alerts.

**Files:**
- Create: `components/ui/materials-tabs.tsx`

- [ ] **Step 1: Create the file**

```typescript
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, RotateCcw, Bell } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/packaging-inventory", label: "Stock",        icon: Boxes },
  { href: "/active-rolls",        label: "Active rolls", icon: RotateCcw },
  { href: "/material-alerts",     label: "Alerts",       icon: Bell },
] as const;

function isTabActive(pathname: string, href: string): boolean {
  if (href === "/packaging-inventory") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MaterialsTabs() {
  const pathname = usePathname() ?? "";
  return (
    <div className="flex items-center gap-0 border-b border-border/70 mb-5">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = isTabActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-2.5 text-[12.5px] font-medium border-b-2 -mb-px transition-colors",
              active
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-text-muted hover:text-text hover:border-border-strong",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {label}
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add components/ui/materials-tabs.tsx
git commit -m "feat: MaterialsTabs component for packaging-inventory page"
```

---

## Task 5: Add MaterialsTabs to the packaging-inventory page

**Files:**
- Modify: `app/(admin)/packaging-inventory/page.tsx`

- [ ] **Step 1: Find the import block and add MaterialsTabs**

At the top of `app/(admin)/packaging-inventory/page.tsx`, add the import:

```typescript
import { MaterialsTabs } from "@/components/ui/materials-tabs";
```

- [ ] **Step 2: Render MaterialsTabs at the top of the page**

Find the opening `<div className="space-y-5">` in the page's return statement and insert `<MaterialsTabs />` as the first child:

```tsx
return (
  <div className="space-y-5">
    <MaterialsTabs />
    <PageHeader
      title="Packaging inventory"
      // ... rest unchanged
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add "app/(admin)/packaging-inventory/page.tsx"
git commit -m "feat: Materials page gets Stock · Active rolls · Alerts tabs"
```

---

## Task 6: Create metrics-tabs.tsx

New tab component for the Metrics page. Four tabs: Throughput (existing), Production reports, Capacity, Roll variance.

**Files:**
- Create: `components/ui/metrics-tabs.tsx`

- [ ] **Step 1: Create the file**

```typescript
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, TrendingUp, Factory, Scale } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/metrics",             label: "Throughput",         icon: BarChart3 },
  { href: "/reports",             label: "Production reports", icon: TrendingUp },
  { href: "/production-capacity", label: "Capacity",           icon: Factory },
  { href: "/roll-variance",       label: "Roll variance",      icon: Scale },
] as const;

function isTabActive(pathname: string, href: string): boolean {
  if (href === "/metrics") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MetricsTabs() {
  const pathname = usePathname() ?? "";
  return (
    <div className="flex items-center gap-0 border-b border-border/70 mb-5">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = isTabActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-2.5 text-[12.5px] font-medium border-b-2 -mb-px transition-colors",
              active
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-text-muted hover:text-text hover:border-border-strong",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {label}
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add components/ui/metrics-tabs.tsx
git commit -m "feat: MetricsTabs component for metrics page"
```

---

## Task 7: Add MetricsTabs to the metrics page

**Files:**
- Modify: `app/(admin)/metrics/page.tsx`

- [ ] **Step 1: Read the top of metrics/page.tsx to find the return statement**

```bash
grep -n "return\|<div\|space-y" app/\(admin\)/metrics/page.tsx | head -20
```

- [ ] **Step 2: Add the import**

At the top of `app/(admin)/metrics/page.tsx`, add:

```typescript
import { MetricsTabs } from "@/components/ui/metrics-tabs";
```

- [ ] **Step 3: Insert MetricsTabs as first child of the page's root div**

Find the opening `<div` of the page's return statement and add `<MetricsTabs />` as the first child. The pattern will look like:

```tsx
return (
  <div className="...">
    <MetricsTabs />
    {/* existing content follows unchanged */}
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add "app/(admin)/metrics/page.tsx"
git commit -m "feat: Metrics page gets Throughput · Production reports · Capacity · Roll variance tabs"
```

---

## Task 8: Add 4 new cards to Settings hub

The pages for Product requirements, Zoho Operations, Invoice allocations, and Material reconciliation move from the sidebar into the Settings hub.

**Files:**
- Modify: `app/(admin)/settings/page.tsx`

- [ ] **Step 1: Add Product requirements to the Production setup section**

Find the existing Production setup `<Section>` block. It currently ends with the Blister standards card. Add Product requirements before Blister standards:

```tsx
<ConfigLink
  href="/product-packaging-requirements"
  icon={PackageCheck}
  label="Product requirements"
  hint="packaging spec per product — which materials and quantities each SKU needs"
/>
```

Insert it after the Packaging & Materials card and before the Blister standards card.

- [ ] **Step 2: Add Zoho Operations to the Integrations section**

Find the Integrations `<Section>`. Add Zoho Operations after the existing Zoho Inventory card:

```tsx
<ConfigLink
  href="/zoho-operations"
  icon={Webhook}
  label="Zoho Operations"
  hint="assembly operations sync — push production runs to Zoho Manufacturing"
/>
```

`Webhook` is already imported in this file.

- [ ] **Step 3: Add a new Analytics section with Invoice allocations + Material reconciliation**

After the Integrations `</Section>` closing tag and before the Account & system section, add:

```tsx
{/* ANALYTICS */}
<Section heading="Analytics">
  <ConfigLink
    href="/invoice-allocations"
    icon={Receipt}
    label="Invoice allocations"
    hint="match supplier invoices to received lots for cost accounting"
  />
  <ConfigLink
    href="/material-reconciliation"
    icon={Scale}
    label="Material reconciliation"
    hint="compare expected vs actual material consumption per batch"
  />
</Section>
```

- [ ] **Step 4: Add missing imports to settings/page.tsx**

Add `Receipt` and `Scale` to the Lucide import at the top of the file (if not already present):

```typescript
import {
  // ... existing imports ...
  Receipt,
  Scale,
} from "lucide-react";
```

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add "app/(admin)/settings/page.tsx"
git commit -m "feat: Settings hub — add Product requirements, Zoho Operations, Invoice allocations, Material reconciliation"
```

---

## Task 9: Push and verify

- [ ] **Step 1: Run the full sidebar test suite one more time**

```bash
npx vitest run components/admin/sidebar.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 2: Push**

```bash
git push origin luma-live-testing
```

- [ ] **Step 3: Visual smoke test after deploy (~60s)**

Open the admin UI and verify:
1. Dashboard and Live floor appear at the top of the sidebar, always visible
2. Three sections: Operations, Inventory, Reports — no "Advanced" group
3. Settings appears at the bottom of the sidebar
4. Navigate to `/packaging-inventory` — confirm 3 tabs appear (Stock · Active rolls · Alerts)
5. Navigate to `/metrics` — confirm 4 tabs appear (Throughput · Production reports · Capacity · Roll variance)
6. Navigate to `/inbound` — confirm 5 tabs appear including PO reconciliation and Packaging receipts
7. Navigate to `/settings` — confirm Product requirements, Zoho Operations, Invoice allocations, Material reconciliation cards are present

---

## Self-Review

**Spec coverage:**
- ✅ Dashboard + Live floor pinned — Task 2 (PINNED_TOP)
- ✅ Operations section: 4 items — Task 2
- ✅ Inventory section: 5 items (Materials, Finished lots, Batches, Workflows, Find lot) — Task 2
- ✅ Reports section: 2 items (Metrics, Productivity) — Task 2
- ✅ Settings as single bottom link — Task 2
- ✅ Receiving tabs: Packaging receipts + PO reconciliation — Task 3
- ✅ Materials tabs: Active rolls + Alerts — Tasks 4–5
- ✅ Metrics tabs: Production reports + Capacity + Roll variance — Tasks 6–7
- ✅ Settings hub: 4 new cards — Task 8
- ✅ Find lot absorbs genealogy — spec notes genealogy becomes a detail link inside Find lot. The existing `/genealogy` page still works at its URL; this plan does not add an inline link because the recall page's structure wasn't shown to need changes beyond the label rename in the sidebar (which Task 2 handles by removing it from the sidebar and renaming "/recall" to "Find lot").
- ✅ All existing URLs preserved — no redirects, just tab additions

**Placeholder check:** No TBDs or vague steps. Task 7 Step 1 uses a grep to find the insertion point because the metrics page is large (described as a "single scrollable page" in its own comment).

**Type consistency:** `MaterialsTabs`, `MetricsTabs`, `ReceivingTabs` all follow the same shape. `ConfigLink` component in settings/page.tsx already exists with exactly the signature used in Task 8.
