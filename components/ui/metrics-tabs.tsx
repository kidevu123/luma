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
