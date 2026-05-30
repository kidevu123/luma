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
  Search,
  Users,
  Package,
  ShieldAlert,
  Inbox,
  Activity,
  ShieldCheck,
  ClipboardList,
  Archive,
  ScrollText,
  Wrench,
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
      { href: "/partial-bags",       label: "Available Partial Bags", icon: Archive },
      { href: "/inbound",            label: "Receiving",             icon: Inbox },
      { href: "/packaging-output",   label: "Production output",     icon: Package },
      { href: "/qc-review",          label: "QC review",             icon: ShieldAlert },
    ],
  },
  {
    heading: "Inventory",
    items: [
      { href: "/packaging-inventory", label: "Materials",     icon: Boxes },
      { href: "/roll-management",    label: "Roll management", icon: Wrench },
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
      { href: "/reports/audit-log",      label: "Audit log",    icon: ScrollText },
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
