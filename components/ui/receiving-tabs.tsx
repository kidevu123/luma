"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Truck, Inbox, Boxes, ClipboardList } from "lucide-react";
import { cn } from "@/lib/utils";

// NAV-PHASED-1 — Receives is intake-only now. PO reconciliation
// stopped being a tab here; it has its own sidebar entry under
// "Reconciliation & output" because it's a close-out step, not an
// intake step. Receives sub-routes drill into what came in the door;
// PO reconciliation answers "does what came in match what we owe."
const TABS = [
  { href: "/inbound",                     label: "Receives",           icon: Truck },
  { href: "/receiving/raw-bags",          label: "Receive pills",      icon: Inbox },
  { href: "/inbound/packaging-materials", label: "Receive packaging",  icon: Boxes },
  { href: "/packaging-receipts",          label: "Packaging receipts", icon: ClipboardList },
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
