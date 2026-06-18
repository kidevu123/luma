"use client";

// NAV-PHASED-1 — process-phased sidebar, filtered by signed-in role.

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
  ClipboardCheck,
  Archive,
  ScrollText,
  CloudUpload,
  GitCompare,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  filterAdminNavForRole,
  type AdminNavItemDef,
  type UserRole,
} from "@/lib/auth/admin-nav";

const ICON_BY_HREF: Record<string, LucideIcon> = {
  "/dashboard": LayoutDashboard,
  "/floor-board": Activity,
  "/inbound": Inbox,
  "/packaging-inventory": Boxes,
  "/batches": ShieldCheck,
  "/workflow-submissions": ClipboardList,
  "/partial-bags": Archive,
  "/qc-review": ShieldAlert,
  "/shift-review": ClipboardCheck,
  "/packaging-output": Package,
  "/po-reconciliation": GitCompare,
  "/finished-lots": PackageCheck,
  "/zoho-production-operations": CloudUpload,
  "/recall": Search,
  "/metrics": BarChart3,
  "/operator-productivity": Users,
  "/reports/audit-log": ScrollText,
  "/settings": Sliders,
};

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
  active,
}: AdminNavItemDef & { active: boolean }) {
  const Icon = ICON_BY_HREF[href] ?? Package;
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

export function Sidebar({ role }: { role: UserRole }) {
  const pathname = usePathname() ?? "";
  const { pinned, sections, settings } = filterAdminNavForRole(role);

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
        <ul className="space-y-px mb-2">
          {pinned.map((it) => (
            <li key={it.href}>
              <NavLink {...it} active={isActive(pathname, it.href)} />
            </li>
          ))}
        </ul>

        {sections.length > 0 ? <hr className="border-border/50 mx-1 mb-2" /> : null}

        <div className="space-y-3 flex-1">
          {sections.map((sec) => (
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

        {settings ? (
          <div className="mt-3">
            <hr className="border-border/50 mx-1 mb-2" />
            <NavLink {...settings} active={isActive(pathname, settings.href)} />
          </div>
        ) : null}
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
