"use client";

// WORKFLOW-UX-1 — workflow-first sidebar.
//
// The sidebar groups operator actions by the floor jobs they map to
// rather than by the DB tables behind them. The four sections are:
//
//   FLOOR WORK     — per-shift operator entrypoints
//   MANAGEMENT     — supervisor-level oversight + reports
//   CONFIGURATION  — products / standards / integrations / settings
//   ADVANCED       — DB-table-style routes, collapsed by default so the
//                    primary nav stays floor-language. Every existing
//                    route stays reachable; nothing is deleted.
//
// Labels follow the floor's words ("Lookup receipt / batch" not
// "Recall lookup", "Packaging / pack-out" not "Packaging output").
// DB-table labels (Bag genealogy / Finished lots / QR cards / Material
// reconciliation) only appear under ADVANCED.

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
  Gauge,
  History,
  Scale,
  Users,
  Package,
  ShieldAlert,
  Inbox,
  Plug,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };
type Section = { heading: string; items: NavItem[]; collapsedByDefault?: boolean };

const SECTIONS: Section[] = [
  {
    heading: "Floor work",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/floor-board", label: "Live floor", icon: Activity },
      { href: "/receiving/raw-bags", label: "Receive raw pills", icon: Inbox },
      { href: "/inbound/packaging-materials", label: "Receive packaging", icon: Boxes },
      { href: "/production/start", label: "Start production", icon: QrCode },
      { href: "/packaging-output", label: "Packaging / pack-out", icon: Package },
      { href: "/qc-review", label: "QC review", icon: ShieldAlert },
      { href: "/recall", label: "Lookup receipt / batch", icon: Search },
    ],
  },
  {
    heading: "Management",
    items: [
      { href: "/packaging-inventory", label: "Inventory", icon: Boxes },
      { href: "/inbound", label: "POs & receiving", icon: Truck },
      { href: "/material-alerts", label: "Material alerts", icon: TrendingUp },
      { href: "/reports", label: "Production reports", icon: BarChart3 },
      { href: "/operator-productivity", label: "Operator productivity", icon: Users },
    ],
  },
  {
    heading: "Configuration",
    items: [
      { href: "/products", label: "Products & packaging rules", icon: PackageCheck },
      { href: "/standards", label: "Standards & targets", icon: Gauge },
      { href: "/settings/integrations/zoho", label: "Integrations", icon: Plug },
      { href: "/workflow-validation", label: "Workflow validation", icon: ShieldCheck },
      { href: "/settings", label: "Settings", icon: Sliders },
    ],
  },
  {
    heading: "Advanced",
    collapsedByDefault: true,
    items: [
      { href: "/qr-cards", label: "QR card management", icon: QrCode },
      { href: "/genealogy", label: "Bag genealogy", icon: History },
      { href: "/finished-lots", label: "Finished lots", icon: PackageCheck },
      { href: "/material-reconciliation", label: "Material reconciliation", icon: Scale },
      { href: "/roll-variance", label: "Roll variance", icon: Scale },
      { href: "/po-reconciliation", label: "PO reconciliation", icon: Truck },
      { href: "/product-packaging-requirements", label: "Product requirements", icon: PackageCheck },
      { href: "/active-rolls", label: "Active rolls", icon: Activity },
      { href: "/metrics", label: "Metrics", icon: TrendingUp },
      { href: "/packaging-receipts", label: "Packaging receipts", icon: Truck },
      { href: "/batches", label: "Batches", icon: ShieldCheck },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard" || pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname() ?? "";
  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col bg-surface border-r border-border/70 sticky top-0 h-dvh">
      <div className="px-5 pt-5 pb-4 border-b border-border/60">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/luma-logo.png"
          alt="Luma"
          className="h-9 w-auto block"
        />
      </div>
      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto">
        {SECTIONS.map((sec) => {
          // ADVANCED stays collapsed by default; auto-opens when the
          // current path is one of its items so deep-linked users don't
          // see "no nav highlight." Other sections render flat.
          const advancedActive =
            sec.collapsedByDefault &&
            sec.items.some((it) => isActive(pathname, it.href));
          if (sec.collapsedByDefault) {
            return (
              <details
                key={sec.heading}
                open={advancedActive}
                className="group"
              >
                <summary
                  className={cn(
                    "px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-subtle/80",
                    "flex items-center gap-1 cursor-pointer list-none select-none",
                    "[&::-webkit-details-marker]:hidden",
                  )}
                >
                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
                  {sec.heading}
                </summary>
                <ul className="space-y-0.5">
                  {sec.items.map(({ href, label, icon: Icon }) => {
                    const active = isActive(pathname, href);
                    return (
                      <li key={href}>
                        <Link
                          href={href}
                          className={cn(
                            "flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] tracking-tight transition-colors",
                            active
                              ? "bg-brand-50 text-brand-800 font-medium"
                              : "text-text-muted hover:bg-surface-2 hover:text-text",
                          )}
                        >
                          <Icon className="h-[16px] w-[16px] shrink-0" aria-hidden />
                          {label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </details>
            );
          }
          return (
            <div key={sec.heading}>
              <div className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-subtle/80">
                {sec.heading}
              </div>
              <ul className="space-y-0.5">
                {sec.items.map(({ href, label, icon: Icon }) => {
                  const active = isActive(pathname, href);
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        className={cn(
                          "flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] tracking-tight transition-colors",
                          active
                            ? "bg-brand-50 text-brand-800 font-medium"
                            : "text-text-muted hover:bg-surface-2 hover:text-text",
                        )}
                      >
                        <Icon className="h-[16px] w-[16px] shrink-0" aria-hidden />
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
