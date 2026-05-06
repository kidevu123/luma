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
  Boxes,
  PackageCheck,
  Pill,
  ArrowRight,
} from "lucide-react";
import { products as productsTable, tabletTypes, packagingMaterials } from "@/lib/db/schema";
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
  const [[cardCounts], [machineCount], [stationCount], [productCount], [tabletCount], [packagingCount]] =
    await Promise.all([
      db
        .select({
          idle: sql<number>`count(*) FILTER (WHERE status='IDLE')::int`,
          assigned: sql<number>`count(*) FILTER (WHERE status='ASSIGNED')::int`,
          retired: sql<number>`count(*) FILTER (WHERE status='RETIRED')::int`,
        })
        .from(qrCards),
      db.select({ n: sql<number>`count(*)::int` }).from(machines),
      db.select({ n: sql<number>`count(*)::int` }).from(stations),
      db.select({ n: sql<number>`count(*)::int` }).from(productsTable),
      db.select({ n: sql<number>`count(*)::int` }).from(tabletTypes),
      db.select({ n: sql<number>`count(*)::int` }).from(packagingMaterials),
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

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SettingsIcon className="h-4 w-4 text-text-subtle" /> Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <ConfigLink
              href="/products"
              icon={Boxes}
              label="Products"
              count={productCount?.n ?? 0}
              hint="finished SKUs + BOM"
            />
            <ConfigLink
              href="/tablet-types"
              icon={Pill}
              label="Tablet types"
              count={tabletCount?.n ?? 0}
              hint="raw pill catalog"
            />
            <ConfigLink
              href="/machines"
              icon={Sliders}
              label="Machines & stations"
              count={(machineCount?.n ?? 0) + (stationCount?.n ?? 0)}
              hint={`${machineCount?.n ?? 0} machines · ${stationCount?.n ?? 0} stations`}
            />
            <ConfigLink
              href="/packaging"
              icon={PackageCheck}
              label="Packaging materials"
              count={packagingCount?.n ?? 0}
              hint="bottles, caps, labels…"
            />
            <ConfigLink
              href="/qr-cards"
              icon={SettingsIcon}
              label="QR cards"
              count={
                (cardCounts?.idle ?? 0) +
                (cardCounts?.assigned ?? 0) +
                (cardCounts?.retired ?? 0)
              }
              hint="laminated production tokens"
            />
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

        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-700">
              <Plug className="h-4 w-4" /> Danger zone
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Button asChild variant="secondary" size="sm" className="w-full justify-start">
              <Link href="/settings/danger-zone">
                Database snapshots + reset
              </Link>
            </Button>
            <p className="text-[11px] text-text-muted leading-relaxed">
              Take a pg_dump snapshot, download it, or wipe production
              data with a typed-phrase confirmation. Owner-only.
            </p>
          </CardContent>
        </Card>

        <Card>
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

function ConfigLink({
  href,
  icon: Icon,
  label,
  count,
  hint,
}: {
  href: string;
  icon: typeof Activity;
  label: string;
  count: number;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-lg border border-border/70 bg-surface p-3 hover:border-brand-300 hover:shadow-sm transition-all"
    >
      <span className="h-9 w-9 rounded-md bg-brand-50 flex items-center justify-center ring-1 ring-inset ring-brand-100 shrink-0">
        <Icon className="h-4 w-4 text-brand-700" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium tracking-tight">{label}</p>
          <ArrowRight className="h-3.5 w-3.5 text-text-subtle group-hover:text-brand-700 transition-colors" />
        </div>
        <p className="text-[11px] text-text-muted">
          <span className="font-semibold text-text">{count}</span> · {hint}
        </p>
      </div>
    </Link>
  );
}
