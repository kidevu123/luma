"use client";

import * as React from "react";
import { LogIn, AlertCircle } from "lucide-react";
import { loginAction } from "./actions";

export function LoginForm() {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  return (
    <form
      action={async (form) => {
        setPending(true);
        setError(null);
        const r = await loginAction(form);
        setPending(false);
        if (r?.error) setError(r.error);
      }}
      className="space-y-4"
    >
      <div className="space-y-1.5">
        <label htmlFor="email" className="block text-xs font-medium text-text-muted">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          className="block w-full h-10 px-3 rounded-md bg-surface border border-border text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand-700/40 focus:border-brand-700"
          placeholder="you@company.com"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-xs font-medium text-text-muted">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="block w-full h-10 px-3 rounded-md bg-surface border border-border text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand-700/40 focus:border-brand-700"
          placeholder="••••••••"
        />
      </div>
      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full h-10 inline-flex items-center justify-center gap-2 rounded-md bg-brand-700 text-white text-sm font-medium shadow-sm hover:bg-brand-800 disabled:opacity-60 transition-colors"
      >
        <LogIn className="w-4 h-4" aria-hidden />
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
