// Phase H.x0.5 — Zoho item-mapping placeholder page.
//
// Surfaces the foundation that landed in migration 0014:
//   • external_systems       — Zoho registered as a known upstream
//   • external_item_mappings — empty until live sync lands
//   • external_inventory_snapshots — empty until live sync lands
//
// Live sync is a follow-up phase. This page exists so the foundation
// is visible to operators and the empty state explains what's needed
// to turn it on.

import { db } from "@/lib/db";
import { eq, desc, sql } from "drizzle-orm";
import { externalSystems } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function ZohoItemsPage() {
  await requireAdmin();

  const [zohoSystem] = await db
    .select({
      id: externalSystems.id,
      code: externalSystems.code,
      name: externalSystems.name,
      isActive: externalSystems.isActive,
    })
    .from(externalSystems)
    .where(eq(externalSystems.code, "ZOHO"))
    .limit(1);

  type Counts = { mapped: number; unmapped: number; snapshots: number; lastSnapshot: string | null };
  const counts = (await db.execute<Counts>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM external_item_mappings
        WHERE external_system_id = ${zohoSystem?.id ?? null}
          AND mapping_type <> 'UNKNOWN' AND is_active = true) AS mapped,
      (SELECT COUNT(*)::int FROM external_item_mappings
        WHERE external_system_id = ${zohoSystem?.id ?? null}
          AND mapping_type = 'UNKNOWN' AND is_active = true) AS unmapped,
      (SELECT COUNT(*)::int FROM external_inventory_snapshots
        WHERE external_system_id = ${zohoSystem?.id ?? null}) AS snapshots,
      (SELECT MAX(snapshot_at)::text FROM external_inventory_snapshots
        WHERE external_system_id = ${zohoSystem?.id ?? null}) AS "lastSnapshot"
  `)) as unknown as Counts[];
  const c = counts[0] ?? { mapped: 0, unmapped: 0, snapshots: 0, lastSnapshot: null };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Zoho item mapping"
        description="Foundation for syncing Zoho items into Luma. Mapping table and inventory snapshots are in place; live API sync lands in a follow-up phase."
      />

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!zohoSystem ? (
            <p className="text-amber-700">
              Zoho external_system row missing. Run migration 0014 to seed it.
            </p>
          ) : (
            <>
              <Row label="External system" value={`${zohoSystem.name} (${zohoSystem.code})`} />
              <Row label="Mapped items" value={String(c.mapped)} />
              <Row label="Unmapped items" value={String(c.unmapped)} />
              <Row label="Inventory snapshots" value={String(c.snapshots)} />
              <Row label="Last snapshot" value={c.lastSnapshot ?? "Never"} />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What this page will do</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-text-muted leading-relaxed">
          <p>
            Once the Zoho item sync is implemented, this page will list every
            Zoho item we've seen, classify it (raw / packaging / finished
            goods / sellable SKU), and let you map each one to a Luma item.
            Until then:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              The <code>external_item_mappings</code> and
              <code> external_inventory_snapshots</code> tables are ready —
              writes via the helper API stay safe.
            </li>
            <li>
              Production code that asks for a Zoho mapping but finds none
              must surface "Zoho item mapping missing" — never invent one.
            </li>
            <li>
              Luma genealogy stays authoritative. Zoho data enriches setup
              and demand later; it never overrides production truth.
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What's needed to turn it on</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-text-muted leading-relaxed">
          <ol className="list-decimal pl-5 space-y-1">
            <li>Wire the existing per-company OAuth client (lib/zoho/client.ts) to the items endpoint.</li>
            <li>Implement <code>listZohoItems()</code> + <code>listZohoInventorySnapshots()</code> in lib/integrations/zoho/items.ts (currently throws ZohoNotConfiguredError).</li>
            <li>Schedule a periodic sync job that calls <code>upsertExternalItemMapping</code> + <code>recordExternalInventorySnapshot</code> per item.</li>
            <li>Build the mapping UI on this page (search, filter by mapping_type, "Map to Luma item" action).</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-muted text-xs uppercase tracking-wider">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
