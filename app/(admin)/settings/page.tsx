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
  Cpu,
  UserCog,
  Webhook,
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

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await requireSession();

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

  const sha = process.env.BUILD_GIT_SHA ?? "dev";
  const branch = process.env.BUILD_GIT_BRANCH ?? "unknown";

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Team, production setup, integrations, and system configuration."
      />

      {/* TEAM */}
      <Section heading="Team">
        <ConfigLink
          href="/settings/users"
          icon={Users}
          label="Users"
          count={userCount?.n ?? 0}
          hint="manage roles and access"
        />
      </Section>

      {/* PRODUCTION SETUP */}
      <Section heading="Production setup">
        <ConfigLink
          href="/products"
          icon={PackageCheck}
          label="Products"
          count={productCount?.n ?? 0}
          hint="finished SKUs and bill of materials"
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
          href="/settings/materials"
          icon={PackageCheck}
          label="Packaging & Materials"
          count={packagingCount?.n ?? 0}
          hint="blister cards, display boxes, master cases, labels, foil"
        />
        <ConfigLink
          href="/settings/blister-standards"
          icon={Activity}
          label="Blister standards"
          hint="PVC and foil consumption rates per blister"
        />
      </Section>

      {/* WORKFLOW */}
      <Section heading="Workflow">
        <ConfigLink
          href="/standards"
          icon={Gauge}
          label="Standards & targets"
          hint="OEE, labor rates, due targets, production calendars"
        />
        <ConfigLink
          href="/workflow-validation"
          icon={ShieldCheck}
          label="Workflow validation"
          hint="readiness board — verifies all floor workflows are configured"
        />
        <ConfigLink
          href="/qr-cards"
          icon={QrCode}
          label="QR cards"
          count={(cardCounts?.idle ?? 0) + (cardCounts?.assigned ?? 0) + (cardCounts?.retired ?? 0)}
          hint={`${cardCounts?.idle ?? 0} idle · ${cardCounts?.assigned ?? 0} assigned · ${cardCounts?.retired ?? 0} retired`}
        />
      </Section>

      {/* INTEGRATIONS */}
      <Section heading="Integrations">
        <ConfigLink
          href="/settings/integrations/zoho"
          icon={Plug}
          label="Zoho Inventory"
          hint="push finished lots as purchase receives — owner only"
        />
        <ConfigLink
          href="/settings/integrations/packtrack"
          icon={Webhook}
          label="PackTrack"
          hint="packaging receipt sync from the station scanner"
        />
        <ConfigLink
          href="/settings/legacy-import"
          icon={Plug}
          label="Legacy import"
          hint="pull the legacy DB dump from PythonAnywhere — owner only"
        />
      </Section>

      {/* ACCOUNT & SYSTEM */}
      <Section heading="Account & system">
        <div className="grid sm:grid-cols-2 gap-4">
          {/* Account */}
          <div className="rounded-lg border border-border/70 bg-surface p-4 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Account</p>
            <InfoRow label="Email" value={me.email} mono />
            <InfoRow label="Role" value={me.role} />
            <InfoRow label="User ID" value={me.id.slice(0, 8) + "…"} mono />
            <form action={signOutAction} className="pt-2 border-t border-border/60">
              <Button type="submit" variant="secondary" size="sm">
                Sign out
              </Button>
            </form>
          </div>

          {/* System */}
          <div className="rounded-lg border border-border/70 bg-surface p-4 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">System</p>
            <InfoRow label="Version" value={sha.slice(0, 7)} mono />
            <InfoRow label="Branch" value={branch} mono />
            <InfoRow label="Machines" value={String(machineCount?.n ?? 0)} />
            <InfoRow label="Stations" value={String(stationCount?.n ?? 0)} />
            <div className="flex items-center gap-2 pt-2 border-t border-border/60">
              <Button asChild variant="secondary" size="sm">
                <Link href="/api/health" target="_blank" rel="noopener">
                  <ExternalLink className="h-3.5 w-3.5" /> Health check
                </Link>
              </Button>
              <Button asChild variant="secondary" size="sm">
                <Link href="/settings/danger-zone" className="text-red-600 hover:text-red-700">
                  <AlertTriangle className="h-3.5 w-3.5" /> Danger zone
                </Link>
              </Button>
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
  href,
  icon: Icon,
  label,
  count,
  hint,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  count?: number;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-lg border border-border/70 bg-surface px-4 py-3 hover:border-brand-300 hover:bg-surface-2/50 transition-all"
    >
      <span className="h-8 w-8 rounded-md bg-brand-50 flex items-center justify-center ring-1 ring-inset ring-brand-100 shrink-0">
        <Icon className="h-4 w-4 text-brand-700" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-medium tracking-tight">{label}</p>
          {count !== undefined && (
            <span className="text-xs tabular-nums text-text-subtle font-mono">{count}</span>
          )}
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
