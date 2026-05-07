// Phase H.x3.5 — Raw-item unit-weight standards admin page.
//
// Lets the admin enter expected grams-per-tablet for each raw item.
// Empty by default. The PO reconciliation page surfaces "Unit weight
// standard missing" until an entry exists.

import { db } from "@/lib/db";
import { eq, asc, desc } from "drizzle-orm";
import { rawItemWeightStandards, tabletTypes } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { saveRawItemWeightAction, deactivateRawItemWeightAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function RawItemWeightsPage() {
  await requireAdmin();
  const tabletTypeList = await db
    .select({ id: tabletTypes.id, name: tabletTypes.name, sku: tabletTypes.sku })
    .from(tabletTypes)
    .where(eq(tabletTypes.isActive, true))
    .orderBy(asc(tabletTypes.name));

  const standards = await db
    .select({
      id: rawItemWeightStandards.id,
      tabletTypeId: rawItemWeightStandards.tabletTypeId,
      name: tabletTypes.name,
      sku: tabletTypes.sku,
      standardUnitWeight: rawItemWeightStandards.standardUnitWeight,
      weightUnit: rawItemWeightStandards.weightUnit,
      sampleSource: rawItemWeightStandards.sampleSource,
      effectiveFrom: rawItemWeightStandards.effectiveFrom,
      effectiveTo: rawItemWeightStandards.effectiveTo,
      isActive: rawItemWeightStandards.isActive,
      confidence: rawItemWeightStandards.confidence,
      notes: rawItemWeightStandards.notes,
    })
    .from(rawItemWeightStandards)
    .innerJoin(tabletTypes, eq(tabletTypes.id, rawItemWeightStandards.tabletTypeId))
    .orderBy(desc(rawItemWeightStandards.isActive), desc(rawItemWeightStandards.effectiveFrom));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Raw-item unit weights"
        description="Expected weight per tablet/unit. Used by PO reconciliation to compute an internal estimated count from received weight. Empty by default — PO report surfaces 'Unit weight standard missing' until set."
      />

      <Card>
        <CardHeader>
          <CardTitle>Add or replace standard</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            action={async (fd) => {
              "use server";
              await saveRawItemWeightAction(fd);
            }}
            className="grid sm:grid-cols-2 gap-3"
          >
            <label className="text-sm">
              <div className="text-[11px] uppercase text-text-muted mb-0.5">Raw item</div>
              <select
                name="tabletTypeId"
                required
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
              >
                <option value="">— Select raw item —</option>
                {tabletTypeList.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.sku ?? "no sku"})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <div className="text-[11px] uppercase text-text-muted mb-0.5">Unit weight (grams)</div>
              <input
                type="number"
                step="0.000001"
                min="0.000001"
                required
                name="standardUnitWeight"
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm tabular-nums"
              />
            </label>
            <label className="text-sm">
              <div className="text-[11px] uppercase text-text-muted mb-0.5">Sample source</div>
              <input
                type="text"
                name="sampleSource"
                placeholder='e.g. "weighed sample 100 from PO 1023"'
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-sm">
              <div className="text-[11px] uppercase text-text-muted mb-0.5">Confidence</div>
              <select
                name="confidence"
                defaultValue="MEDIUM"
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
              >
                <option value="HIGH">HIGH (≥5 verified samples)</option>
                <option value="MEDIUM">MEDIUM (2–4 samples or vendor spec)</option>
                <option value="LOW">LOW (single sample / vendor declaration)</option>
              </select>
            </label>
            <label className="text-sm">
              <div className="text-[11px] uppercase text-text-muted mb-0.5">Effective from</div>
              <input
                type="date"
                required
                name="effectiveFrom"
                defaultValue={new Date().toISOString().slice(0, 10)}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-sm sm:col-span-2">
              <div className="text-[11px] uppercase text-text-muted mb-0.5">Notes (optional)</div>
              <input
                type="text"
                name="notes"
                maxLength={500}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-1.5 text-sm"
              />
            </label>
            <div className="sm:col-span-2 flex gap-2 pt-2">
              <Button type="submit" size="sm">
                Save standard
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configured standards</CardTitle>
        </CardHeader>
        <CardContent>
          {standards.length === 0 ? (
            <p className="text-sm text-text-muted">
              No unit-weight standards configured. PO reconciliation will surface
              "Unit weight standard missing" until at least one is set.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-text-muted text-xs uppercase">
                  <tr>
                    <th className="text-left p-2">Raw item</th>
                    <th className="text-right p-2">Unit weight</th>
                    <th className="text-left p-2">Source</th>
                    <th className="text-left p-2">Confidence</th>
                    <th className="text-left p-2">Effective from</th>
                    <th className="text-left p-2">Status</th>
                    <th className="text-left p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {standards.map((s) => (
                    <tr key={s.id} className="border-t border-border/40">
                      <td className="p-2">
                        {s.name} <span className="text-text-muted text-xs font-mono">({s.sku ?? "no sku"})</span>
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {Number(s.standardUnitWeight)} {s.weightUnit}
                      </td>
                      <td className="p-2">{s.sampleSource ?? "—"}</td>
                      <td className="p-2">{s.confidence}</td>
                      <td className="p-2">{s.effectiveFrom}</td>
                      <td className="p-2">{s.isActive ? "Active" : "Inactive"}</td>
                      <td className="p-2">
                        {s.isActive ? (
                          <form
                            action={async (fd) => {
                              "use server";
                              await deactivateRawItemWeightAction(fd);
                            }}
                          >
                            <input type="hidden" name="id" value={s.id} />
                            <Button type="submit" variant="ghost" size="sm">
                              Deactivate
                            </Button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
