// Operations overview. Pulls live counts from base tables now; will
// switch to read models once the projector is wired in Phase 4.

import Link from "next/link";
import { ArrowRight, Boxes, ShieldCheck, PackageCheck, Activity } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import {
  batches,
  finishedLots,
  inventoryBags,
  workflowBags,
  qrCards,
  packagingMaterials,
} from "@/lib/db/schema";

export const dynamic = "force-dynamic";

async function counts() {
  const [
    batchesByStatus,
    activeLots,
    bagsAvailable,
    workflowOpen,
    cardsIdle,
    cardsAssigned,
    materialCount,
  ] = await Promise.all([
    db
      .select({ status: batches.status, n: sql<number>`count(*)::int` })
      .from(batches)
      .groupBy(batches.status),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(finishedLots)
      .where(sql`status IN ('PENDING_QC','RELEASED')`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(inventoryBags)
      .where(sql`status = 'AVAILABLE'`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowBags)
      .where(sql`finalized_at IS NULL`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(qrCards)
      .where(sql`status = 'IDLE'`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(qrCards)
      .where(sql`status = 'ASSIGNED'`),
    db.select({ n: sql<number>`count(*)::int` }).from(packagingMaterials),
  ]);
  return {
    batchesByStatus,
    activeLots: activeLots[0]?.n ?? 0,
    bagsAvailable: bagsAvailable[0]?.n ?? 0,
    workflowOpen: workflowOpen[0]?.n ?? 0,
    cardsIdle: cardsIdle[0]?.n ?? 0,
    cardsAssigned: cardsAssigned[0]?.n ?? 0,
    materialCount: materialCount[0]?.n ?? 0,
  };
}

export default async function DashboardPage() {
  const c = await counts();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Single pane on production state. Numbers update on every page load."
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <Tile
          icon={Activity}
          label="Bags in flight"
          value={c.workflowOpen.toString()}
          hint={`${c.cardsAssigned} cards assigned · ${c.cardsIdle} idle`}
          href="/floor-board"
        />
        <Tile
          icon={ShieldCheck}
          label="Batches RELEASED"
          value={String(
            c.batchesByStatus.find((b) => b.status === "RELEASED")?.n ?? 0,
          )}
          hint={`${c.batchesByStatus.find((b) => b.status === "QUARANTINE")?.n ?? 0} in quarantine`}
          href="/batches"
        />
        <Tile
          icon={Boxes}
          label="Bags available"
          value={c.bagsAvailable.toString()}
          hint="raw tablet inventory"
          href="/inbound"
        />
        <Tile
          icon={PackageCheck}
          label="Packaging materials"
          value={c.materialCount.toString()}
          hint="SKUs tracked"
          href="/packaging"
        />
      </div>

      <div className="rounded-xl border border-border/70 bg-surface p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Bootstrap status</h2>
          <span className="text-[10px] uppercase tracking-wider text-text-subtle">
            Phase 1 — auth + shell live
          </span>
        </div>
        <ul className="space-y-1.5 text-xs text-text-muted">
          <li>• Schema: 26 tables across 6 bounded contexts (master / inbound / batches / production / output / read models).</li>
          <li>• Auth: signed-cookie session + argon2id. Authentik OIDC swap-in is the next hop.</li>
          <li>• Observability: Prometheus on 192.168.1.134:9464 (scraped by LXC 112).</li>
          <li>• Deploy: systemd timer pulls main every 60s.</li>
        </ul>
      </div>
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  href,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border border-border/70 bg-surface p-4 hover:shadow-sm transition-shadow"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="h-8 w-8 rounded-md bg-brand-50 flex items-center justify-center ring-1 ring-inset ring-brand-100">
          <Icon className="h-4 w-4 text-brand-700" aria-hidden />
        </div>
        <ArrowRight className="h-3.5 w-3.5 text-text-subtle group-hover:text-text-muted" />
      </div>
      <div className="text-2xl font-semibold tabular-nums tracking-tight">
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wider text-text-subtle mt-0.5">
        {label}
      </div>
      <div className="text-[11px] text-text-muted mt-1.5">{hint}</div>
    </Link>
  );
}
