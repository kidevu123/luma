// Settings hub. Minimal in v1 — surfaces account info, build/version,
// where to find QR card scan URLs, and a sign-out shortcut. Holds the
// place for richer settings (Authentik OIDC config, Zoho push, alert
// thresholds) when those land.

import Link from "next/link";
import {
  Sliders,
  ExternalLink,
  Activity,
  Plug,
  Wallet as IconWallet,
  Sliders as SettingsIcon,
} from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { qrCards, machines, stations } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/components/admin/sign-out-action";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await requireSession();
  const [[cardCounts], [machineCount], [stationCount]] = await Promise.all([
    db
      .select({
        idle: sql<number>`count(*) FILTER (WHERE status='IDLE')::int`,
        assigned: sql<number>`count(*) FILTER (WHERE status='ASSIGNED')::int`,
        retired: sql<number>`count(*) FILTER (WHERE status='RETIRED')::int`,
      })
      .from(qrCards),
    db.select({ n: sql<number>`count(*)::int` }).from(machines),
    db.select({ n: sql<number>`count(*)::int` }).from(stations),
  ]);

  const sha = process.env.BUILD_GIT_SHA ?? "dev";
  const branch = process.env.BUILD_GIT_BRANCH ?? "unknown";
  const shortSha = sha.slice(0, 7);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Account, system info, and links to operational surfaces."
      />

      <div className="grid lg:grid-cols-2 gap-5">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SettingsIcon className="h-4 w-4 text-text-subtle" /> Account
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Email" value={me.email} mono />
            <Row label="Role" value={me.role} />
            <Row label="User ID" value={me.id.slice(0, 8) + "…"} mono />
            <form action={signOutAction} className="pt-2 border-t border-border/60">
              <Button type="submit" variant="secondary" size="sm">
                Sign out
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-text-subtle" /> System
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Version (sha)" value={shortSha} mono />
            <Row label="Branch" value={branch} mono />
            <Row label="Machines" value={String(machineCount?.n ?? 0)} />
            <Row label="Stations" value={String(stationCount?.n ?? 0)} />
            <Row
              label="QR cards"
              value={`${cardCounts?.idle ?? 0} idle · ${cardCounts?.assigned ?? 0} assigned · ${cardCounts?.retired ?? 0} retired`}
            />
            <Button asChild variant="secondary" size="sm">
              <Link href="/api/health" target="_blank" rel="noopener">
                <ExternalLink className="h-3.5 w-3.5" /> Health check
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plug className="h-4 w-4 text-text-subtle" /> Integrations
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Button asChild variant="secondary" size="sm" className="w-full justify-start">
              <Link href="/settings/zoho">
                <Plug className="h-3.5 w-3.5" /> Zoho Inventory
              </Link>
            </Button>
            <p className="text-[11px] text-text-muted leading-relaxed">
              Connect Zoho to push finished lots out as purchase receives.
              Owner-only.
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconWallet className="h-4 w-4 text-text-subtle" /> How to start a floor cycle
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-text-muted space-y-2 leading-relaxed">
            <p>
              Open <Link href="/machines" className="text-brand-700 hover:underline">/machines</Link> on this admin to
              copy a station's floor URL, then paste it into a tablet's
              browser at the workstation. Each station's URL contains
              its scan token — no separate login on the floor side.
            </p>
            <p>
              From the tablet: scan a card → fire stage events as bags
              progress → finalize when packed. The supervisor sees
              everything live on{" "}
              <Link href="/floor-board" className="text-brand-700 hover:underline">
                /floor-board
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-muted text-xs uppercase tracking-wider">
        {label}
      </span>
      <span
        className={`tabular-nums${mono ? " font-mono text-xs" : " font-medium"}`}
      >
        {value}
      </span>
    </div>
  );
}
