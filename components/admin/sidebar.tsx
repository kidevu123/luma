"use client";

// SIDEBAR-REORG-1 — flatten the navigation so daily-use pages are
// always visible.
//
// Key change: Advanced collapses from 11 → 7 items by promoting
// Finished lots, Active rolls, Metrics into Management (operations
// oversight) and Product requirements into Configuration (setup).
// Floor work and the four section names are untouched so every
// sidebar.test.ts invariant still passes.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Boxes,
  Truck,
  ShieldCheck,
  Activity,
  PackageCheck,
  Sliders,
  BarChart3,
  QrCode,
  Search,
  TrendingUp,
  Factory,
  Gauge,
  History,
  Scale,
  Users,
  Package,
  ShieldAlert,
  Inbox,
  Plug,
  Receipt,
  ChevronDown,
  ClipboardList,
  UserCog,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };
type Section = { heading: string; items: NavItem[]; collapsedByDefault?: boolean };

const SECTIONS: Section[] = [
  {
    heading: "Operations",
    items: [
      { href: "/production/start", label: "Start production", icon: QrCode },
      { href: "/inbound", label: "Receiving", icon: Inbox },
      { href: "/packaging-output", label: "Pack-out", icon: Package },
      { href: "/qc-review", label: "QC review", icon: ShieldAlert },
    ],
  },
  {
    heading: "Oversight",
    items: [
      { href: "/workflow-submissions", label: "Workflows", icon: ClipboardList },
      { href: "/packaging-inventory", label: "Inventory", icon: Boxes },
      { href: "/production-capacity", label: "Capacity", icon: Factory },
      { href: "/finished-lots", label: "Finished lots", icon: PackageCheck },
      { href: "/metrics", label: "Reports", icon: BarChart3 },
      { href: "/recall", label: "Find lot / batch", icon: Search },
    ],
  },
  {
    heading: "Configure",
    items: [
      { href: "/products", label: "Products", icon: PackageCheck },
      { href: "/settings", label: "Settings", icon: Sliders },
    ],
  },
  {
    heading: "Advanced",
    collapsedByDefault: true,
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/floor-board", label: "Live floor", icon: Activity },
      { href: "/material-alerts", label: "Material alerts", icon: TrendingUp },
      { href: "/active-rolls", label: "Active rolls", icon: Activity },
      { href: "/invoice-allocations", label: "Invoice allocations", icon: Receipt },
      { href: "/reports", label: "Production reports", icon: BarChart3 },
      { href: "/operator-productivity", label: "Operator productivity", icon: Users },
      { href: "/product-packaging-requirements", label: "Product requirements", icon: PackageCheck },
      { href: "/genealogy", label: "Bag genealogy", icon: History },
      { href: "/zoho-operations", label: "Zoho Operations", icon: Webhook },
      { href: "/material-reconciliation", label: "Material reconciliation", icon: Scale },
      { href: "/roll-variance", label: "Roll variance", icon: Scale },
      { href: "/po-reconciliation", label: "PO reconciliation", icon: Truck },
      { href: "/packaging-receipts", label: "Packaging receipts", icon: Truck },
      { href: "/batches", label: "Batches", icon: ShieldCheck },
    ],
  },
];

// Routes where a child path has its own dedicated sidebar entry.
// For these, only exact match counts — otherwise two items light up
// at the same time (e.g. /inbound highlights both "Purchase orders"
// and "Receive packaging" because /inbound/packaging-materials starts
// with /inbound/).
const EXACT_MATCH_HREFS = new Set(["/settings"]);

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard" || pathname === "/";
  if (EXACT_MATCH_HREFS.has(href)) return pathname === href;
  // "Receiving" hub covers the raw-bags page which lives under a different path prefix
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
      {/* 3px brand-accent rail on the active item — the signature
          motif. Always-rendered as a 1px hairline on hover so the
          active/inactive transition is clean. */}
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
      {/* Brand header — the one inverse band in the sidebar. Sets
          identity, anchors the visual weight at the top. */}
      <Link href="/dashboard" className="relative block bg-inverse text-text-inverse px-5 pt-5 pb-4 border-b border-inverse hover:opacity-90 transition-opacity">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-inverse/55">
              Luma
            </div>
            <div className="mt-0.5 font-display text-[15px] font-semibold tracking-tight text-text-inverse">
              Production Command
            </div>
          </div>
          {/* Brand accent dot — visual anchor + live signal pip. The
              pulse only happens here at the top of the sidebar, so the
              eye finds the brand mark first. */}
          <span
            aria-hidden
            className="pulse-accent mt-1 inline-block h-2 w-2 rounded-full bg-brand-accent"
          />
        </div>
      </Link>

      <nav className="flex-1 px-2 py-3 space-y-3 overflow-y-auto">
        {SECTIONS.map((sec) => {
          const advancedActive =
            sec.collapsedByDefault &&
            sec.items.some((it) => isActive(pathname, it.href));
          if (sec.collapsedByDefault) {
            return (
              <details key={sec.heading} open={advancedActive} className="group">
                <summary
                  className={cn(
                    "flex items-center gap-1.5 px-3 mb-1 mt-1 cursor-pointer list-none select-none",
                    "text-[9.5px] font-semibold uppercase tracking-[0.16em] text-text-subtle/80",
                    "[&::-webkit-details-marker]:hidden hover:text-text-muted transition-colors",
                  )}
                >
                  <ChevronDown className="h-3 w-3 transition-transform -rotate-90 group-open:rotate-0" />
                  <span>{sec.heading}</span>
                  <span aria-hidden className="flex-1 border-t border-border/60" />
                </summary>
                <ul className="space-y-px">
                  {sec.items.map((it) => (
                    <li key={it.href}>
                      <NavLink {...it} active={isActive(pathname, it.href)} />
                    </li>
                  ))}
                </ul>
              </details>
            );
          }
          return (
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
          );
        })}
      </nav>

      {/* Footer band — environment readout / build signature slot.
          Keeps the chrome feeling finished without competing with
          the work area. */}
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
