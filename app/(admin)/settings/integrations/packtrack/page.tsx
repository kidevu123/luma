// PT-4B — PackTrack material-mapping admin page.
//
// Operator pre-flight for the live integration: register the
// PACKTRACK external_systems row, and explicitly map each PackTrack
// material_code to a Luma packaging_materials row. The webhook
// rejects unmapped codes with code=MAPPING_MISSING — never auto-
// creates trusted inventory under a guessed material.

import { db } from "@/lib/db";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import {
  externalSystems,
  externalItemMappings,
  packagingMaterials,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  createPacktrackMappingAction,
  deactivatePacktrackMappingAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function PacktrackMappingPage() {
  await requireAdmin();

  const [system] = await db
    .select({
      id: externalSystems.id,
      code: externalSystems.code,
      name: externalSystems.name,
      isActive: externalSystems.isActive,
    })
    .from(externalSystems)
    .where(eq(externalSystems.code, "PACKTRACK"));

  type Counts = { active: number; deactivated: number };
  const counts = system
    ? ((await db.execute<Counts>(sql`
        SELECT
          (SELECT COUNT(*)::int FROM external_item_mappings
            WHERE external_system_id = ${system.id} AND is_active = true) AS active,
          (SELECT COUNT(*)::int FROM external_item_mappings
            WHERE external_system_id = ${system.id} AND is_active = false) AS deactivated
      `)) as unknown as Counts[])
    : [{ active: 0, deactivated: 0 } as Counts];
  const c = counts[0] ?? ({ active: 0, deactivated: 0 } as Counts);

  const mappings = system
    ? await db
        .select({
          id: externalItemMappings.id,
          externalItemId: externalItemMappings.externalItemId,
          externalItemName: externalItemMappings.externalItemName,
          materialItemId: externalItemMappings.materialItemId,
          mappingType: externalItemMappings.mappingType,
          isActive: externalItemMappings.isActive,
          createdAt: externalItemMappings.createdAt,
          materialSku: packagingMaterials.sku,
          materialName: packagingMaterials.name,
        })
        .from(externalItemMappings)
        .leftJoin(
          packagingMaterials,
          eq(packagingMaterials.id, externalItemMappings.materialItemId),
        )
        .where(eq(externalItemMappings.externalSystemId, system.id))
        .orderBy(desc(externalItemMappings.isActive), asc(externalItemMappings.externalItemId))
    : [];

  const materialOptions = await db
    .select({
      id: packagingMaterials.id,
      sku: packagingMaterials.sku,
      name: packagingMaterials.name,
      kind: packagingMaterials.kind,
    })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.isActive, true))
    .orderBy(asc(packagingMaterials.sku));

  const webhookConfigured = Boolean(process.env.PACKTRACK_INTEGRATION_SECRET);

  return (
    <div className="space-y-5">
      <PageHeader
        title="PackTrack integration"
        description="Map PackTrack material codes to Luma packaging materials. The webhook receiver rejects unmapped codes — operator must map them here before receipts can flow."
      />

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!system ? (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
              <p className="font-semibold">PackTrack external_system row not registered.</p>
              <p className="text-xs mt-1">
                Run on the LXC:
                <code className="block mt-1 font-mono bg-amber-100 px-2 py-1 rounded">
                  docker compose exec app npx tsx scripts/register-packtrack.ts
                </code>
              </p>
            </div>
          ) : (
            <>
              <Row label="External system" value={`${system.name} (${system.code})`} />
              <Row label="Active mappings" value={String(c.active)} />
              <Row label="Deactivated mappings" value={String(c.deactivated)} />
              <Row
                label="Webhook secret"
                value={
                  webhookConfigured
                    ? "PACKTRACK_INTEGRATION_SECRET is set"
                    : "PACKTRACK_INTEGRATION_SECRET is NOT set — webhook returns 503"
                }
              />
            </>
          )}
        </CardContent>
      </Card>

      {system && (
        <Card>
          <CardHeader>
            <CardTitle>Add mapping</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              action={async (fd) => {
                "use server";
                await createPacktrackMappingAction(fd);
              }}
              className="space-y-3 text-sm"
            >
              <Field label="PackTrack material code">
                <input
                  name="externalItemId"
                  required
                  maxLength={120}
                  placeholder="e.g. PVC-123"
                  className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
                />
              </Field>
              <Field label="PackTrack material name (optional)">
                <input
                  name="externalItemName"
                  maxLength={200}
                  placeholder="Free-text label from PackTrack"
                  className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
                />
              </Field>
              <Field label="Luma packaging material">
                <select
                  name="materialItemId"
                  required
                  defaultValue=""
                  className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
                >
                  <option value="" disabled>
                    — Select Luma material —
                  </option>
                  {materialOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.sku} — {m.name} ({m.kind})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Mapping type">
                <select
                  name="mappingType"
                  defaultValue="MATERIAL"
                  className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
                >
                  <option value="MATERIAL">MATERIAL</option>
                  <option value="OTHER">OTHER</option>
                </select>
              </Field>
              <button
                type="submit"
                className="rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-sm font-medium px-4 py-2"
              >
                Add mapping
              </button>
            </form>
          </CardContent>
        </Card>
      )}

      {system && (
        <Card>
          <CardHeader>
            <CardTitle>Existing mappings</CardTitle>
          </CardHeader>
          <CardContent>
            {mappings.length === 0 ? (
              <p className="text-sm text-text-muted">
                No mappings yet. Add one above for each PackTrack material code
                that PackTrack will send receipts for.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-text-muted uppercase">
                    <tr>
                      <th className="text-left p-2">PackTrack code</th>
                      <th className="text-left p-2">PackTrack name</th>
                      <th className="text-left p-2">Luma material</th>
                      <th className="text-left p-2">Type</th>
                      <th className="text-left p-2">Active</th>
                      <th className="text-left p-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappings.map((m) => (
                      <tr key={m.id} className="border-t border-border/40">
                        <td className="p-2 font-mono">{m.externalItemId}</td>
                        <td className="p-2">{m.externalItemName ?? "—"}</td>
                        <td className="p-2">
                          {m.materialSku ? (
                            <>
                              <span className="font-mono">{m.materialSku}</span>
                              <span className="text-text-muted"> · {m.materialName}</span>
                            </>
                          ) : (
                            <span className="text-amber-700">unmapped</span>
                          )}
                        </td>
                        <td className="p-2">{m.mappingType}</td>
                        <td className="p-2">
                          {m.isActive ? (
                            <span className="rounded bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 text-[10px]">
                              active
                            </span>
                          ) : (
                            <span className="rounded bg-slate-100 text-slate-600 border border-slate-200 px-2 py-0.5 text-[10px]">
                              inactive
                            </span>
                          )}
                        </td>
                        <td className="p-2">
                          {m.isActive && (
                            <form
                              action={async (fd) => {
                                "use server";
                                await deactivatePacktrackMappingAction(fd);
                              }}
                            >
                              <input type="hidden" name="mappingId" value={m.id} />
                              <button
                                type="submit"
                                className="text-rose-700 hover:underline text-xs"
                              >
                                Deactivate
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">
        {label}
      </div>
      {children}
    </label>
  );
}
