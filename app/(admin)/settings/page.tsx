import Link from "next/link";
import {
  Users,
  Sliders,
  ExternalLink,
  Activity,
  Plug,
  PackageCheck,
  Pill,
  ArrowRight,
  ShieldCheck,
  Gauge,
  QrCode,
  AlertTriangle,
  Webhook,
  Receipt,
  Scale,
  ClipboardCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  products as productsTable,
  tabletTypes,
  packagingMaterials,
  users,
  qrCards,
  machines,
  stations,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/components/admin/sign-out-action";
import { getBuildFooterParts } from "@/lib/build-metadata";
import {
  canAccessDangerZone,
  filterSettingsHubForRole,
  resolveSettingsHubCount,
  settingsHubHint,
  type SettingsHubCounts,
  type SettingsHubIcon,
  type SettingsHubItemDef,
} from "@/lib/auth/settings-hub";

export const dynamic = "force-dynamic";

const SETTINGS_ICONS: Record<SettingsHubIcon, LucideIcon> = {
  Users,
  PackageCheck,
  Pill,
  Sliders,
  Activity,
  Gauge,
  ShieldCheck,
  ClipboardCheck,
  Wrench,
  QrCode,
  Plug,
  Webhook,
  Receipt,
  Scale,
};

export default async function SettingsPage() {
  const me = await requireSession();
  const hubSections = filterSettingsHubForRole(me.role);
  const showDangerZone = canAccessDangerZone(me.role);

  const [
    [cardCounts],
    [machineCount],
    [stationCount],
    [productCount],
    [tabletCount],
    [packagingCount],
    [userCount],
  ] = await Promise.all([
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
    db.select({ n: sql<number>`count(*)::int` }).from(users),
  ]);

  const counts: SettingsHubCounts = {
    users: userCount?.n ?? 0,
    products: productCount?.n ?? 0,
    tablets: tabletCount?.n ?? 0,
    machines: machineCount?.n ?? 0,
    stations: stationCount?.n ?? 0,
    packagingMaterials: packagingCount?.n ?? 0,
    qrCardsTotal:
      (cardCounts?.idle ?? 0) +
      (cardCounts?.assigned ?? 0) +
      (cardCounts?.retired ?? 0),
    qrCardsIdle: cardCounts?.idle ?? 0,
    qrCardsAssigned: cardCounts?.assigned ?? 0,
    qrCardsRetired: cardCounts?.retired ?? 0,
  };

  const build = getBuildFooterParts();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Team, production setup, integrations, and system configuration."
      />

      {hubSections.map((section) => (
        <Section key={section.heading} heading={section.heading}>
          {section.items.map((item) => (
            <ConfigLink
              key={item.href}
              item={item}
              counts={counts}
            />
          ))}
        </Section>
      ))}

      {hubSections.length === 0 ? (
        <p className="text-sm text-text-muted">
          No configuration areas are available for your role. Account details
          are below.
        </p>
      ) : null}

      <Section heading="Account & system">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="rounded-lg border border-border/70 bg-surface p-4 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              Account
            </p>
            <InfoRow label="Email" value={me.email} mono />
            <InfoRow label="Role" value={me.role} />
            <InfoRow label="User ID" value={me.id.slice(0, 8) + "…"} mono />
            <form action={signOutAction} className="pt-2 border-t border-border/60">
              <Button type="submit" variant="secondary" size="sm">
                Sign out
              </Button>
            </form>
          </div>

          <div className="rounded-lg border border-border/70 bg-surface p-4 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
              System
            </p>
            <InfoRow label="Release" value={`v${build.version}`} mono />
            <InfoRow label="Git SHA" value={build.shortSha} mono />
            <InfoRow label="Branch" value={build.branch ?? "unknown"} mono />
            <InfoRow label="Machines" value={String(counts.machines)} />
            <InfoRow label="Stations" value={String(counts.stations)} />
            <div className="flex items-center gap-2 pt-2 border-t border-border/60">
              <Button asChild variant="secondary" size="sm">
                <Link href="/api/health" target="_blank" rel="noopener">
                  <ExternalLink className="h-3.5 w-3.5" /> Health check
                </Link>
              </Button>
              {showDangerZone ? (
                <Button asChild variant="secondary" size="sm">
                  <Link
                    href="/settings/danger-zone"
                    className="text-red-600 hover:text-red-700"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" /> Danger zone
                  </Link>
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-subtle/80">
          {heading}
        </span>
        <span aria-hidden className="flex-1 border-t border-border/60" />
      </div>
      {children}
    </div>
  );
}

function ConfigLink({
  item,
  counts,
}: {
  item: SettingsHubItemDef;
  counts: SettingsHubCounts;
}) {
  const Icon = SETTINGS_ICONS[item.icon];
  const count = resolveSettingsHubCount(item, counts);
  const hint = settingsHubHint(item, counts);

  return (
    <Link
      href={item.href}
      className="group flex items-center gap-3 rounded-lg border border-border/70 bg-surface px-4 py-3 hover:border-brand-300 hover:bg-surface-2/50 transition-all"
    >
      <span className="h-8 w-8 rounded-md bg-brand-50 flex items-center justify-center ring-1 ring-inset ring-brand-100 shrink-0">
        <Icon className="h-4 w-4 text-brand-700" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-medium tracking-tight">{item.label}</p>
          {count !== undefined ? (
            <span className="text-xs tabular-nums text-text-subtle font-mono">
              {count}
            </span>
          ) : null}
        </div>
        <p className="text-[11px] text-text-muted truncate">{hint}</p>
      </div>
      <ArrowRight className="h-3.5 w-3.5 text-text-subtle/50 group-hover:text-brand-700 transition-colors shrink-0" />
    </Link>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-text-muted text-xs uppercase tracking-wider">{label}</span>
      <span className={`tabular-nums${mono ? " font-mono text-xs" : " font-medium"}`}>
        {value}
      </span>
    </div>
  );
}
