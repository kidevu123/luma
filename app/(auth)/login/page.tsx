// Login page — mirrors TabletTracker's centered-card pattern on the
// new chrome. "Operations" kicker, Luma wordmark, sign-in form.

import { redirect } from "next/navigation";
import { User as UserIcon } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentUser()) redirect("/dashboard");
  return (
    <div className="min-h-dvh flex items-center justify-center p-6 bg-page">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-subtle mb-3">
            Operations
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-text">
            Luma
          </h1>
          <p className="mt-2 text-sm text-text-muted">Production traceability</p>
        </div>

        <div className="rounded-2xl bg-surface border border-border/70 shadow-sm p-7 space-y-5">
          <div className="text-center space-y-1.5">
            <div className="mx-auto w-12 h-12 rounded-full bg-brand-50 ring-1 ring-inset ring-brand-100 flex items-center justify-center">
              <UserIcon className="w-5 h-5 text-brand-700" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold tracking-tight">Sign in</h2>
            <p className="text-xs text-text-muted">
              Enter your credentials to access the system.
            </p>
          </div>
          <LoginForm oidcEnabled={Boolean(process.env.AUTHENTIK_CLIENT_ID)} />
          <p className="pt-1 text-center text-[11px] text-text-subtle">
            Need help? Contact your system administrator.
          </p>
        </div>
      </div>
    </div>
  );
}
