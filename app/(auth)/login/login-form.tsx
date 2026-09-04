"use client";

import * as React from "react";
import { LogIn, AlertCircle } from "lucide-react";
import { loginAction } from "./actions";

export function LoginForm({
  oidcEnabled,
  next,
}: {
  oidcEnabled?: boolean;
  next: string;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(!oidcEnabled);
  const emailInputRef = React.useRef<HTMLInputElement>(null);
  const PASSWORD_FORM_ID = "login-password-form";

  // The password form only mounts once showPassword flips true, so the
  // email input isn't in the DOM yet at click time — focus it in an effect
  // keyed on showPassword instead of inline in the onClick handler.
  React.useEffect(() => {
    if (showPassword) emailInputRef.current?.focus();
  }, [showPassword]);

  return (
    <div className="space-y-4">
      {oidcEnabled && (
        <a
          href={`/api/auth/sso?next=${encodeURIComponent(next)}`}
          className="flex items-center justify-center gap-2 w-full h-10 rounded-md bg-brand-700 text-white text-sm font-medium hover:bg-brand-800 transition-colors"
        >
          Sign in
        </a>
      )}
      {oidcEnabled && !showPassword && (
        <button
          type="button"
          onClick={() => setShowPassword(true)}
          aria-expanded={showPassword}
          aria-controls={PASSWORD_FORM_ID}
          className="w-full text-center text-[11px] text-text-subtle underline decoration-dotted hover:text-text-muted"
        >
          Sign in with password instead
        </button>
      )}
      {oidcEnabled && showPassword && (
        <div className="flex items-center gap-3">
          <hr className="flex-1 border-border" />
          <span className="text-[11px] text-text-subtle">or sign in with email</span>
          <hr className="flex-1 border-border" />
        </div>
      )}
      {showPassword && (
        <form
          id={PASSWORD_FORM_ID}
          action={async (form) => {
            setPending(true);
            setError(null);
            const r = await loginAction(form);
            setPending(false);
            if (r?.error) setError(r.error);
          }}
          className="space-y-4"
        >
          <input type="hidden" name="next" value={next} />
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-xs font-medium text-text-muted">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              ref={emailInputRef}
              autoComplete="email"
              required
              autoFocus={!oidcEnabled}
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
              placeholder=""
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
            className={`w-full h-10 inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium disabled:opacity-60 transition-colors ${
              oidcEnabled
                ? "border border-border bg-surface text-text-muted hover:bg-surface/80"
                : "bg-brand-700 text-white shadow-sm hover:bg-brand-800"
            }`}
          >
            <LogIn className="w-4 h-4" aria-hidden />
            {pending ? "Signing in…" : "Sign in with email"}
          </button>
        </form>
      )}
    </div>
  );
}
