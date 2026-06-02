// Blister material standards — data-driven view.
//
// The system LEARNS g/blister automatically from completed rolls.
// Manual standards are an optional override once you trust the data.
// Primary view: what the system has learned. Secondary: confirmed overrides.

import { db } from "@/lib/db";
import { eq, asc, desc, sql } from "drizzle-orm";
import {
  blisterMaterialStandards,
  packagingMaterials,
  packagingLots,
  readMaterialUsageLearning,
  readRollUsage,
  products,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  DataTable,
  THead,
  TR,
  TH,
  TD,
} from "@/components/ui/table";
import {
  saveBlisterStandardAction,
  deleteBlisterStandardAction,
  rebuildBlisterLearningAction,
  rebuildAllMaterialProjectionsAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function BlisterStandardsPage() {
  await requireAdmin();

  const [
    learnedRows,
    configuredRows,
    rollInventory,
    completedRollCycles,
    productList,
    rollMaterials,
  ] = await Promise.all([
      // Learned standards from completed rolls
      db
        .select({
          id: readMaterialUsageLearning.id,
          productId: readMaterialUsageLearning.productId,
          productName: products.name,
          productSku: products.sku,
          materialName: packagingMaterials.name,
          materialRole: readMaterialUsageLearning.materialRole,
          sampleCount: readMaterialUsageLearning.sampleCount,
          avgWeightPerBlister: readMaterialUsageLearning.avgWeightPerBlister,
          medianWeightPerBlister: readMaterialUsageLearning.medianWeightPerBlister,
          totalBlistersProduced: readMaterialUsageLearning.totalBlistersProduced,
          confidence: readMaterialUsageLearning.confidence,
          lastSampleAt: readMaterialUsageLearning.lastSampleAt,
        })
        .from(readMaterialUsageLearning)
        .leftJoin(products, eq(products.id, readMaterialUsageLearning.productId))
        .leftJoin(
          packagingMaterials,
          eq(packagingMaterials.id, readMaterialUsageLearning.packagingMaterialId),
        )
        .orderBy(desc(readMaterialUsageLearning.sampleCount)),

      // Manually confirmed overrides
      db
        .select({
          id: blisterMaterialStandards.id,
          productName: products.name,
          productSku: products.sku,
          materialName: packagingMaterials.name,
          materialRole: blisterMaterialStandards.materialRole,
          expectedGramsPerBlister: blisterMaterialStandards.expectedGramsPerBlister,
          expectedBlistersPerKg: blisterMaterialStandards.expectedBlistersPerKg,
          setupWasteGrams: blisterMaterialStandards.setupWasteGrams,
          changeoverWasteGrams: blisterMaterialStandards.changeoverWasteGrams,
          effectiveFrom: blisterMaterialStandards.effectiveFrom,
          effectiveTo: blisterMaterialStandards.effectiveTo,
          isActive: blisterMaterialStandards.isActive,
        })
        .from(blisterMaterialStandards)
        .leftJoin(products, eq(products.id, blisterMaterialStandards.productId))
        .leftJoin(
          packagingMaterials,
          eq(packagingMaterials.id, blisterMaterialStandards.packagingMaterialId),
        )
        .orderBy(desc(blisterMaterialStandards.effectiveFrom)),

      // Roll inventory — received rolls and their status
      db
        .select({
          id: packagingLots.id,
          materialName: packagingMaterials.name,
          materialKind: packagingMaterials.kind,
          rollNumber: packagingLots.rollNumber,
          status: packagingLots.status,
          netWeightGrams: packagingLots.netWeightGrams,
          grossWeightGrams: packagingLots.grossWeightGrams,
          receivedAt: packagingLots.receivedAt,
          confidence: packagingLots.confidence,
        })
        .from(packagingLots)
        .innerJoin(
          packagingMaterials,
          eq(packagingLots.packagingMaterialId, packagingMaterials.id),
        )
        .where(
          sql`${packagingMaterials.kind} IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')`,
        )
        .orderBy(desc(packagingLots.receivedAt))
        .limit(20),

      db
        .select({
          rollNumber: readRollUsage.rollNumber,
          materialKind: readRollUsage.materialKind,
          materialRole: readRollUsage.materialRole,
          blistersProduced: readRollUsage.blistersProduced,
          actualUsedGrams: readRollUsage.actualUsedGrams,
          startingWeightGrams: readRollUsage.startingWeightGrams,
          unmountedAt: readRollUsage.unmountedAt,
          confidence: readRollUsage.confidence,
        })
        .from(readRollUsage)
        .where(sql`${readRollUsage.blistersProduced} > 0`)
        .orderBy(desc(readRollUsage.unmountedAt))
        .limit(12),

      db
        .select({ id: products.id, sku: products.sku, name: products.name })
        .from(products)
        .where(eq(products.isActive, true))
        .orderBy(asc(products.name)),

      db
        .select({
          id: packagingMaterials.id,
          sku: packagingMaterials.sku,
          name: packagingMaterials.name,
          kind: packagingMaterials.kind,
        })
        .from(packagingMaterials)
        .where(
          sql`${packagingMaterials.isActive} = true AND ${packagingMaterials.kind} IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')`,
        )
        .orderBy(asc(packagingMaterials.name)),
    ]);

  const hasLearnedData = learnedRows.length > 0;
  const hasRolls = rollInventory.length > 0;
  const depletedRollCount = rollInventory.filter((r) => r.status === "DEPLETED").length;
  const hasRecordedCycles = completedRollCycles.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Blister roll yield"
        description="The system learns grams-per-blister automatically from completed rolls. No manual entry needed to start."
      />

      {/* How this works */}
      <Card>
        <CardHeader>
          <CardTitle>How roll yield tracking works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-text-muted space-y-2">
          <div className="grid sm:grid-cols-4 gap-3">
            {[
              { step: "1", label: "Receive roll", detail: "Weigh it on intake — gross and tare. Luma records net weight." },
              { step: "2", label: "Mount at machine", detail: "Floor operator selects which PVC and foil roll they loaded. Luma notes the start." },
              { step: "3", label: "Run production", detail: "Operator enters counter segments at each BLISTER_COMPLETE as normal." },
              { step: "4", label: "Roll depletes", detail: "Operator marks roll done. Luma computes: net weight ÷ blisters made = g/blister." },
            ].map((s) => (
              <div key={s.step} className="flex gap-2">
                <span className="flex-shrink-0 h-5 w-5 rounded-full bg-brand-accent/20 text-brand-accent text-[10px] font-semibold flex items-center justify-center">
                  {s.step}
                </span>
                <div>
                  <div className="font-medium text-text text-xs">{s.label}</div>
                  <div className="text-[11px] leading-snug mt-0.5">{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-text-subtle pt-1 border-t border-border/60">
            After a few rolls, Luma builds a reliable g/blister figure. You can optionally confirm it as a locked standard below — but projections will use the learned average until then.
          </p>
        </CardContent>
      </Card>

      {/* Learned yield — PRIMARY view */}
      <Card>
        <CardHeader>
          <CardTitle>
            Learned yield from production
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!hasLearnedData ? (
            <div className="space-y-3">
              {hasRecordedCycles || depletedRollCount > 0 ? (
                <>
                  <p className="text-sm text-text-muted">
                    Rolls have been used on the floor
                    {depletedRollCount > 0
                      ? ` (${depletedRollCount} marked depleted)`
                      : ""}
                    , but the learned summary has not been built yet. Use{" "}
                    <strong>Rebuild learned yield</strong> below to pull in
                    existing roll history.
                  </p>
                  {hasRecordedCycles && (
                    <DataTable>
                      <THead>
                        <TR>
                          <TH>Roll</TH>
                          <TH>Role</TH>
                          <TH className="text-right">Blisters</TH>
                          <TH className="text-right">g/blister</TH>
                          <TH>Ended</TH>
                        </TR>
                      </THead>
                      <tbody>
                        {completedRollCycles.map((r, i) => {
                          const used =
                            r.actualUsedGrams ??
                            (r.startingWeightGrams != null &&
                            r.blistersProduced != null &&
                            r.blistersProduced > 0
                              ? r.startingWeightGrams
                              : null);
                          const gpb =
                            used != null &&
                            r.blistersProduced != null &&
                            r.blistersProduced > 0
                              ? used / r.blistersProduced
                              : null;
                          return (
                            <TR key={`${r.rollNumber}-${i}`}>
                              <TD className="font-mono text-xs">
                                {r.rollNumber ?? "—"}
                              </TD>
                              <TD>{r.materialRole ?? r.materialKind}</TD>
                              <TD className="text-right tabular-nums">
                                {r.blistersProduced?.toLocaleString() ?? "—"}
                              </TD>
                              <TD className="text-right font-mono tabular-nums">
                                {gpb != null ? `${gpb.toFixed(4)} g` : "—"}
                              </TD>
                              <TD className="text-xs text-text-muted">
                                {r.unmountedAt
                                  ? new Date(r.unmountedAt).toLocaleString()
                                  : "—"}
                              </TD>
                            </TR>
                          );
                        })}
                      </tbody>
                    </DataTable>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm text-text-muted">
                    No complete roll cycle recorded yet: receive → mount →
                    produce (counter segments) → mark roll{" "}
                    <strong>depleted</strong> on the floor.
                  </p>
                  <div className="rounded-md border border-border/60 bg-surface-2/40 px-4 py-3 text-xs text-text-subtle space-y-1">
                    <div className="font-medium text-text-muted">
                      Checklist:
                    </div>
                    <ul className="list-disc pl-4 space-y-0.5">
                      <li>
                        Receive rolls at{" "}
                        <strong>/inbound/packaging-materials</strong> with gross
                        + tare (net weight is computed)
                      </li>
                      <li>
                        Floor: mount PVC + foil at the blister machine when
                        production starts
                      </li>
                      <li>
                        Floor: enter counter segments at each blister complete
                        / roll change
                      </li>
                      <li>
                        Floor: when the roll is finished, choose{" "}
                        <strong>Depleted</strong> (not “removed with material
                        remaining” unless you weigh the leftover roll)
                      </li>
                    </ul>
                  </div>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <form
                  action={async () => {
                    "use server";
                    await rebuildBlisterLearningAction();
                  }}
                >
                  <button
                    type="submit"
                    className="text-sm px-3 py-1.5 rounded border border-brand-accent/40 text-brand-accent hover:bg-brand-accent/10"
                  >
                    Rebuild learned yield
                  </button>
                </form>
                <form
                  action={async () => {
                    "use server";
                    await rebuildAllMaterialProjectionsAction();
                  }}
                >
                  <button
                    type="submit"
                    className="text-sm px-3 py-1.5 rounded border border-white/15 text-slate-300 hover:bg-white/5"
                  >
                    Rebuild all material metrics
                  </button>
                </form>
              </div>
            </div>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Material</TH>
                  <TH>Role</TH>
                  <TH>Product</TH>
                  <TH className="text-right">Avg g/blister</TH>
                  <TH className="text-right">Median</TH>
                  <TH className="text-right">Total blisters</TH>
                  <TH className="text-right">Rolls used</TH>
                  <TH>Confidence</TH>
                  <TH>Last sample</TH>
                </TR>
              </THead>
              <tbody>
                {learnedRows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium">{r.materialName ?? "—"}</TD>
                    <TD>
                      <StatusPill kind="neutral">{r.materialRole}</StatusPill>
                    </TD>
                    <TD className="text-text-muted">
                      {r.productName ?? <span className="italic">all products</span>}
                      {r.productSku && (
                        <div className="text-[10px] font-mono text-text-subtle">{r.productSku}</div>
                      )}
                    </TD>
                    <TD className="text-right font-mono tabular-nums">
                      {r.avgWeightPerBlister != null
                        ? `${Number(r.avgWeightPerBlister).toFixed(4)} g`
                        : "—"}
                    </TD>
                    <TD className="text-right font-mono tabular-nums text-text-muted">
                      {r.medianWeightPerBlister != null
                        ? `${Number(r.medianWeightPerBlister).toFixed(4)} g`
                        : "—"}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {r.totalBlistersProduced != null
                        ? r.totalBlistersProduced.toLocaleString()
                        : "—"}
                    </TD>
                    <TD className="text-right tabular-nums">{r.sampleCount}</TD>
                    <TD>
                      <StatusPill
                        kind={
                          r.confidence === "HIGH"
                            ? "ok"
                            : r.confidence === "MEDIUM"
                              ? "info"
                              : r.confidence === "LOW"
                                ? "warn"
                                : "neutral"
                        }
                      >
                        {r.confidence === "HIGH"
                          ? "High (5+ rolls)"
                          : r.confidence === "MEDIUM"
                            ? "Medium (2–4 rolls)"
                            : r.confidence === "LOW"
                              ? "Low (1 roll)"
                              : "Building…"}
                      </StatusPill>
                    </TD>
                    <TD className="text-text-muted text-xs">
                      {r.lastSampleAt
                        ? new Date(r.lastSampleAt).toLocaleDateString()
                        : "—"}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>

      {/* Roll inventory status */}
      <Card>
        <CardHeader>
          <CardTitle>Roll inventory</CardTitle>
        </CardHeader>
        <CardContent>
          {!hasRolls ? (
            <p className="text-sm text-text-muted">
              No rolls received yet. Go to{" "}
              <strong>/inbound/packaging-materials</strong> → Roll materials tab to receive your first roll.
              Enter the gross weight (full roll) and tare weight (core only) — net weight is computed automatically.
            </p>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Material</TH>
                  <TH>Roll #</TH>
                  <TH className="text-right">Net weight</TH>
                  <TH>Status</TH>
                  <TH>Received</TH>
                </TR>
              </THead>
              <tbody>
                {rollInventory.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium">{r.materialName}</TD>
                    <TD className="font-mono text-xs">{r.rollNumber ?? "—"}</TD>
                    <TD className="text-right tabular-nums font-mono">
                      {r.netWeightGrams != null
                        ? `${(r.netWeightGrams / 1000).toFixed(2)} kg`
                        : r.grossWeightGrams != null
                          ? `${(r.grossWeightGrams / 1000).toFixed(2)} kg gross`
                          : "—"}
                    </TD>
                    <TD>
                      <StatusPill
                        kind={
                          r.status === "AVAILABLE"
                            ? "ok"
                            : r.status === "IN_USE"
                              ? "info"
                              : r.status === "DEPLETED"
                                ? "neutral"
                                : "warn"
                        }
                      >
                        {r.status ?? "AVAILABLE"}
                      </StatusPill>
                    </TD>
                    <TD className="text-text-muted text-xs">
                      {r.receivedAt
                        ? new Date(r.receivedAt).toLocaleDateString()
                        : "—"}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>

      {/* Manual confirmed standards — SECONDARY / optional */}
      <details className="group">
        <summary className="flex items-center gap-2 cursor-pointer list-none select-none py-2">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-text-subtle/80">
            Confirmed overrides (optional)
          </span>
          <span aria-hidden className="flex-1 border-t border-border/60" />
          <span className="text-[11px] text-text-subtle group-open:hidden">Show</span>
          <span className="text-[11px] text-text-subtle hidden group-open:inline">Hide</span>
        </summary>

        <div className="mt-3 space-y-4">
          <div className="rounded-md border border-border/60 bg-surface-2/40 px-4 py-3 text-xs text-text-subtle">
            You only need this section if you want to lock a specific g/blister figure — for example, after the system has learned it and you want to fix it for planning. Leave blank to use the learned average.
          </div>

          {rollMaterials.length > 0 && (
            <form
              action={async (fd) => {
                "use server";
                await saveBlisterStandardAction(fd);
              }}
              className="rounded-md border border-border bg-surface p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
            >
              <h3 className="md:col-span-3 text-sm font-semibold">Confirm standard</h3>
              <SelectField
                name="productId"
                label="Product (leave blank = applies to all)"
                options={productList.map((p) => ({ value: p.id, label: `${p.sku} — ${p.name}` }))}
              />
              <SelectField
                name="packagingMaterialId"
                label="Roll material"
                required
                options={rollMaterials.map((m) => ({
                  value: m.id,
                  label: `${m.name} (${m.kind})`,
                }))}
              />
              <SelectField
                name="materialRole"
                label="Role"
                required
                options={[
                  { value: "PVC", label: "PVC" },
                  { value: "FOIL", label: "FOIL" },
                ]}
              />
              <Field
                name="expectedGramsPerBlister"
                label="Grams per blister"
                type="number"
                min={0}
                step="0.0001"
                placeholder="e.g. 4.2000 — from learned data above"
              />
              <Field
                name="expectedBlistersPerKg"
                label="Blisters per kg (alternate)"
                type="number"
                min={0}
                step="0.001"
                placeholder="leave blank if using g/blister"
              />
              <Field
                name="setupWasteGrams"
                label="Setup waste (g)"
                type="number"
                min={0}
                defaultValue="0"
                required
              />
              <Field
                name="changeoverWasteGrams"
                label="Changeover waste (g)"
                type="number"
                min={0}
                defaultValue="0"
                required
              />
              <Field name="effectiveFrom" label="Effective from" type="date" required />
              <Field name="effectiveTo" label="Effective to (optional)" type="date" />
              <label className="flex items-end gap-2">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked
                  className="h-4 w-4 accent-brand-700"
                />
                <span className="text-sm text-text-muted">Active</span>
              </label>
              <Field name="notes" label="Notes" placeholder="optional" />
              <div className="md:col-span-3 flex justify-end">
                <button
                  type="submit"
                  className="h-9 px-4 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-sm font-medium"
                >
                  Confirm standard
                </button>
              </div>
            </form>
          )}

          {configuredRows.length > 0 && (
            <DataTable>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Material</TH>
                  <TH>Role</TH>
                  <TH className="text-right">g/blister</TH>
                  <TH className="text-right">blisters/kg</TH>
                  <TH className="text-right">Setup waste</TH>
                  <TH className="text-right">Changeover</TH>
                  <TH>Effective</TH>
                  <TH>Active</TH>
                  <TH>{""}</TH>
                </TR>
              </THead>
              <tbody>
                {configuredRows.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      {r.productName ?? (
                        <span className="text-text-subtle italic">all products</span>
                      )}
                      {r.productSku && (
                        <div className="text-[10px] font-mono text-text-subtle">{r.productSku}</div>
                      )}
                    </TD>
                    <TD>{r.materialName ?? "—"}</TD>
                    <TD>
                      <StatusPill kind="neutral">{r.materialRole}</StatusPill>
                    </TD>
                    <TD className="text-right font-mono tabular-nums">
                      {r.expectedGramsPerBlister != null
                        ? `${r.expectedGramsPerBlister} g`
                        : "—"}
                    </TD>
                    <TD className="text-right font-mono tabular-nums text-text-muted">
                      {r.expectedBlistersPerKg ?? "—"}
                    </TD>
                    <TD className="text-right font-mono tabular-nums">{r.setupWasteGrams}g</TD>
                    <TD className="text-right font-mono tabular-nums">{r.changeoverWasteGrams}g</TD>
                    <TD className="font-mono text-[11px] text-text-muted">
                      {r.effectiveFrom}
                      {r.effectiveTo ? ` → ${r.effectiveTo}` : " → ∞"}
                    </TD>
                    <TD>
                      <StatusPill kind={r.isActive ? "ok" : "neutral"}>
                        {r.isActive ? "active" : "inactive"}
                      </StatusPill>
                    </TD>
                    <TD className="text-right">
                      <form
                        action={async () => {
                          "use server";
                          await deleteBlisterStandardAction(r.id);
                        }}
                      >
                        <button
                          type="submit"
                          className="text-[11px] text-text-subtle hover:text-red-600"
                        >
                          delete
                        </button>
                      </form>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}

          {configuredRows.length === 0 && (
            <p className="text-sm text-text-muted">
              No confirmed overrides. Projections use the learned average above.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}

function Field({
  name,
  label,
  type = "text",
  required,
  placeholder,
  defaultValue,
  min,
  step,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  step?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.10em] text-text-subtle">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        {...(min != null ? { min } : {})}
        {...(step ? { step } : {})}
        className="mt-1 w-full h-9 px-2 rounded-md bg-surface-2 border border-border text-sm text-text placeholder:text-text-subtle/60 focus:border-brand-600 focus:outline-none"
      />
    </label>
  );
}

function SelectField({
  name,
  label,
  options,
  required,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.10em] text-text-subtle">{label}</span>
      <select
        name={name}
        required={required}
        defaultValue=""
        className="mt-1 w-full h-9 px-2 rounded-md bg-surface-2 border border-border text-sm text-text focus:border-brand-600 focus:outline-none"
      >
        <option value="">— select —</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
