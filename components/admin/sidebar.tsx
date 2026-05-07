"use client";

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
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };

// Master-data items (products / tablet-types / machines / packaging)
// were promoted into Settings — config of any kind belongs there.
// Sidebar stays focused on day-to-day operations + a single
// Settings entry that fans out to everything configurable.
const SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/floor-board", label: "Live floor", icon: Activity },
    ],
  },
  {
    heading: "Operations",
    items: [
      { href: "/inbound", label: "POs & receiving", icon: Truck },
      { href: "/inbound/packaging-materials", label: "Receive packaging", icon: Boxes },
      { href: "/batches", label: "Batches", icon: ShieldCheck },
      { href: "/finished-lots", label: "Finished lots", icon: PackageCheck },
      { href: "/qr-cards", label: "QR cards", icon: QrCode },
      { href: "/recall", label: "Recall lookup", icon: Search },
      { href: "/reports", label: "Reports", icon: BarChart3 },
      { href: "/metrics", label: "Metrics", icon: TrendingUp },
    ],
  },
  {
    heading: "Production intelligence",
    items: [
      { href: "/genealogy", label: "Bag genealogy", icon: History },
      { href: "/material-reconciliation", label: "Material recon", icon: Scale },
      { href: "/operator-productivity", label: "Operator productivity", icon: Users },
      { href: "/packaging-output", label: "Packaging output", icon: Package },
      { href: "/standards", label: "Standards & targets", icon: Gauge },
    ],
  },
  {
    heading: "Materials",
    items: [
      { href: "/packaging-inventory", label: "Packaging inventory", icon: Boxes },
      { href: "/active-rolls", label: "Active rolls", icon: Activity },
      { href: "/roll-variance", label: "Roll variance", icon: Scale },
      { href: "/material-alerts", label: "Material alerts", icon: TrendingUp },
      { href: "/po-reconciliation", label: "PO reconciliation", icon: Truck },
    ],
  },
  {
    heading: "System",
    items: [{ href: "/settings", label: "Settings", icon: Sliders }],
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
        {SECTIONS.map((sec) => (
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
        ))}
      </nav>
    </aside>
  );
}
