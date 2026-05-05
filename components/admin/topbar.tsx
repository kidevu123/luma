"use client";

import * as React from "react";
import { LogOut } from "lucide-react";
import { signOutAction } from "./sign-out-action";

export function Topbar({ email, role }: { email: string; role: string }) {
  return (
    <header className="h-14 border-b border-border/70 bg-surface/95 flex items-center justify-between px-4 lg:px-6">
      <div className="text-sm font-medium tracking-tight">Production traceability</div>
      <div className="flex items-center gap-3">
        <div className="hidden sm:flex flex-col items-end leading-tight">
          <span className="text-xs text-text">{email}</span>
          <span className="text-[10px] uppercase tracking-wider text-text-subtle">
            {role}
          </span>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            className="inline-flex h-9 items-center gap-1.5 px-2.5 rounded-md text-xs text-text-muted hover:bg-surface-2 hover:text-text"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
