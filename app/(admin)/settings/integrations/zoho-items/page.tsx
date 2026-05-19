import { db } from "@/lib/db";
import { eq, desc, sql } from "drizzle-orm";
import { externalSystems, externalItemMappings, zohoSyncRuns } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD, EmptyRow } from "@/components/ui/table";
import { SyncButton } from "./sync-button";

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

  type Counts = { mapped: number; unmapped: number; total: number };
  const countsRaw = (await db.execute<Counts>(sql`
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN mapping_type <> 'UNKNOWN' THEN 1 ELSE 0 END)::int AS mapped,
      SUM(CASE WHEN mapping_type = 'UNKNOWN' THEN 1 ELSE 0 END)::int AS unmapped
    FROM external_item_mappings
    WHERE external_system_id = ${zohoSystem?.id ?? null}::uuid
      AND is_active = true
  `)) as unknown as Counts[];
  const c = countsRaw[0] ?? { mapped: 0, unmapped: 0, total: 0 };

  const [lastRun] = await db
    .select({
      id: zohoSyncRuns.id,
      status: zohoSyncRuns.status,
      finishedAt: zohoSyncRuns.finishedAt,
      dryRun: zohoSyncRuns.dryRun,
      summary: zohoSyncRuns.summary,
      error: zohoSyncRuns.error,
    })
    .from(zohoSyncRuns)
    .where(eq(zohoSyncRuns.syncType, "ITEMS"))
    .orderBy(desc(zohoSyncRuns.startedAt))
    .limit(1);

  type MappingRow = {
    id: string;
    externalItemId: string;
    externalItemName: string | null;
    externalItemCode: string | null;
    mappingType: string;
    isActive: boolean;
    lumaItemId: string | null;
    lumaProductId: string | null;
    materialItemId: string | null;
    lastSyncedAt: string | null;
  };

  const mappings = (await db.execute<MappingRow>(sql`
    SELECT
      id::text,
      external_item_id AS "externalItemId",
      external_item_name AS "externalItemName",
      external_item_code AS "externalItemCode",
      mapping_type AS "mappingType",
      is_active AS "isActive",
      luma_item_id::text AS "lumaItemId",
      luma_product_id::text AS "lumaProductId",
      material_item_id::text AS "materialItemId",
      last_synced_at::text AS "lastSyncedAt"
    FROM external_item_mappings
    WHERE external_system_id = ${zohoSystem?.id ?? null}::uuid
    ORDER BY external_item_name ASC
    LIMIT 200
  `)) as unknown as MappingRow[];

  const lastRunSummary = lastRun?.summary as {
    scanned?: number;
    created?: number;
    updated?: number;
  } | null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Zoho item mapping"
        description="Live sync of Zoho Inventory items into Luma. Items are classified by suggested target type. Operator confirmation is required before linking items to Luma rows."
        actions={
          lastRun ? (
            <StatusPill kind={lastRun.status === "SUCCESS" ? "ok" : lastRun.status === "FAILED" ? "danger" : "warn"}>
              Last sync: {lastRun.status}
            </StatusPill>
          ) : undefined
        }
      />

      {!zohoSystem && (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm text-amber-700">
              Zoho external_system row missing. Run migration 0014 to seed it.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Sync status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <StatRow label="Total items" value={String(c.total)} />
            <StatRow label="Mapped items" value={String(c.mapped)} />
            <StatRow label="Unmapped (UNKNOWN)" value={String(c.unmapped)} />
            {lastRun ? (
              <>
                <StatRow label="Last sync status" value={lastRun.status} />
                <StatRow
                  label="Last sync at"
                  value={lastRun.finishedAt
                    ? new Date(lastRun.finishedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "—"}
                />
                {lastRunSummary?.scanned != null && (
                  <StatRow label="Items scanned" value={String(lastRunSummary.scanned)} />
                )}
                {lastRun.error && (
                  <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 mt-2">
                    {lastRun.error}
                  </p>
                )}
              </>
            ) : (
              <StatRow label="Last sync" value="Never" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sync Zoho items</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-text-muted">
            <p>
              Fetches all items from Zoho Inventory via the gateway, upserts them into{" "}
              <code className="font-mono text-[11px] bg-surface-2 border border-border rounded px-1">
                external_item_mappings
              </code>
              , and writes an audit row. Does not auto-link items to Luma rows — operator
              confirmation is always required.
            </p>
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              Zoho items are commercial records only. Syncing them does not create packaging stock.
              Physical inventory requires PackTrack receipts or manual lot entry.
            </p>
            <SyncButton />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Item mappings ({mappings.length}{mappings.length >= 200 ? "+" : ""})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable>
            <THead>
              <TR>
                <TH>Zoho item name</TH>
                <TH>SKU / code</TH>
                <TH>Suggested target</TH>
                <TH>Linked to Luma</TH>
                <TH>Active</TH>
              </TR>
            </THead>
            <tbody>
              {mappings.length === 0 ? (
                <EmptyRow colSpan={5}>
                  No items synced yet. Click &ldquo;Sync Zoho items&rdquo; to import.
                </EmptyRow>
              ) : (
                mappings.map((m) => {
                  const isLinked = !!(m.lumaItemId ?? m.lumaProductId ?? m.materialItemId);
                  return (
                    <TR key={m.id}>
                      <TD>
                        <span className="font-medium">{m.externalItemName ?? "—"}</span>
                        <div className="text-[10.5px] text-text-muted font-mono">
                          id: {m.externalItemId}
                        </div>
                      </TD>
                      <TD>
                        <span className="font-mono text-[11.5px]">
                          {m.externalItemCode ?? "—"}
                        </span>
                      </TD>
                      <TD>
                        <StatusPill
                          kind={
                            m.mappingType === "PACKAGING_MATERIAL"
                              ? "info"
                              : m.mappingType === "PRODUCT"
                                ? "ok"
                                : m.mappingType === "TABLET_TYPE"
                                  ? "neutral"
                                  : "warn"
                          }
                        >
                          {m.mappingType}
                        </StatusPill>
                      </TD>
                      <TD>
                        {isLinked ? (
                          <span className="text-xs text-emerald-700 font-medium">Linked</span>
                        ) : (
                          <span className="text-xs text-text-subtle italic">Not mapped</span>
                        )}
                      </TD>
                      <TD>
                        <StatusPill kind={m.isActive ? "ok" : "neutral"}>
                          {m.isActive ? "Active" : "Inactive"}
                        </StatusPill>
                      </TD>
                    </TR>
                  );
                })
              )}
            </tbody>
          </DataTable>
          <div className="px-3 py-2 text-[11px] text-text-muted border-t border-border/40">
            Zoho item — commercial record only, not physical inventory. Physical stock requires
            PackTrack receipts or manual lot entry.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-muted text-xs uppercase tracking-wider">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
