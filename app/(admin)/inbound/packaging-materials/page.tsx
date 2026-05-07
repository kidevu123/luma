// Phase H.x6 — receiving UI for packaging materials and rolls.
// Two side-by-side forms: count-based (display boxes / cases /
// bottles / caps / labels / inserts) and roll-based (PVC / foil).

import { db } from "@/lib/db";
import { eq, asc, desc, sql } from "drizzle-orm";
import { packagingMaterials, packagingLots } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import {
  receivePackagingMaterialAction,
  receiveRollAction,
} from "./actions";

export const dynamic = "force-dynamic";

const COUNT_KINDS = [
  "DISPLAY",
  "CASE",
  "LABEL",
  "BOTTLE",
  "CAP",
  "INDUCTION_SEAL",
  "INSERT",
  "SHRINK_BAND",
  "OTHER",
];

export default async function ReceivePackagingPage() {
  await requireAdmin();
  const [countMaterials, rollMaterials, recentLots] = await Promise.all([
    db
      .select({
        id: packagingMaterials.id,
        sku: packagingMaterials.sku,
        name: packagingMaterials.name,
        kind: packagingMaterials.kind,
        uom: packagingMaterials.uom,
      })
      .from(packagingMaterials)
      .where(
        sql`${packagingMaterials.isActive} = true AND ${packagingMaterials.kind} IN (
          'DISPLAY','CASE','LABEL','BOTTLE','CAP','INDUCTION_SEAL','INSERT','SHRINK_BAND','OTHER',
          'HEAT_SEAL_FILM','DESICCANT','COTTON'
        )`,
      )
      .orderBy(asc(packagingMaterials.name)),
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
    db
      .select({
        id: packagingLots.id,
        rollNumber: packagingLots.rollNumber,
        qtyReceived: packagingLots.qtyReceived,
        netWeightGrams: packagingLots.netWeightGrams,
        receivedAt: packagingLots.receivedAt,
        status: packagingLots.status,
        confidence: packagingLots.confidence,
        materialName: packagingMaterials.name,
        materialKind: packagingMaterials.kind,
      })
      .from(packagingLots)
      .leftJoin(
        packagingMaterials,
        eq(packagingMaterials.id, packagingLots.packagingMaterialId),
      )
      .orderBy(desc(packagingLots.receivedAt))
      .limit(20),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Receive packaging materials"
        description="Create inventory lots for count-based packaging or PVC/foil rolls. Each receive fires a MATERIAL_RECEIVED inventory event so the read models pick it up on next rebuild."
      />

      {countMaterials.length === 0 && rollMaterials.length === 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-200">
          <strong>No active material items.</strong> Create materials at{" "}
          <code>/settings/materials</code> first.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Mode 1 — count-based */}
        <section className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 space-y-3">
          <h2 className="text-[11px] uppercase tracking-[0.10em] text-cyan-300 font-semibold">
            Count-based material
          </h2>
          {countMaterials.length === 0 ? (
            <p className="text-sm text-slate-400">
              No count-based materials configured.
            </p>
          ) : (
            <form
              action={async (fd) => {
                "use server";
                await receivePackagingMaterialAction(fd);
              }}
              className="grid grid-cols-1 sm:grid-cols-2 gap-3"
            >
              <SelectField
                name="packagingMaterialId"
                label="Material"
                required
                options={countMaterials.map((m) => ({
                  value: m.id,
                  label: `${m.sku} — ${m.name} (${m.kind} · ${m.uom})`,
                }))}
              />
              <Field
                name="qtyReceived"
                label="Quantity"
                type="number"
                min={1}
                required
              />
              <Field name="uom" label="Unit" defaultValue="each" required />
              <Field
                name="lotNumber"
                label="Lot # (optional, auto if blank)"
                placeholder="auto"
              />
              <Field name="supplier" label="Supplier (optional)" />
              <Field name="receiptNumber" label="Receipt # (optional)" />
              <Field
                name="location"
                label="Location (optional)"
                placeholder="warehouse / aisle / bin"
              />
              <Field name="notes" label="Notes (optional)" />
              <div className="sm:col-span-2 flex justify-end">
                <button
                  type="submit"
                  className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
                >
                  Receive
                </button>
              </div>
            </form>
          )}
        </section>

        {/* Mode 2 — PVC / foil roll */}
        <section className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 space-y-3">
          <h2 className="text-[11px] uppercase tracking-[0.10em] text-cyan-300 font-semibold">
            PVC / foil roll
          </h2>
          {rollMaterials.length === 0 ? (
            <p className="text-sm text-slate-400">
              No active PVC/foil materials. Create one at{" "}
              <code>/settings/materials</code>.
            </p>
          ) : (
            <form
              action={async (fd) => {
                "use server";
                await receiveRollAction(fd);
              }}
              className="grid grid-cols-1 sm:grid-cols-2 gap-3"
            >
              <SelectField
                name="packagingMaterialId"
                label="Roll material"
                required
                options={rollMaterials.map((m) => ({
                  value: m.id,
                  label: `${m.sku} — ${m.name} (${m.kind})`,
                }))}
              />
              <Field
                name="rollNumber"
                label="Roll number"
                required
                placeholder="e.g. PVC-23-A-04"
              />
              <Field
                name="grossWeightGrams"
                label="Gross weight (g)"
                type="number"
                min={0}
              />
              <Field
                name="tareWeightGrams"
                label="Tare weight (g, optional)"
                type="number"
                min={0}
              />
              <Field
                name="netWeightGrams"
                label="Net weight (g, if no tare)"
                type="number"
                min={0}
              />
              <SelectField
                name="weightUnit"
                label="Unit"
                required
                options={[
                  { value: "g", label: "grams" },
                  { value: "kg", label: "kg" },
                  { value: "lb", label: "lb" },
                ]}
              />
              <Field
                name="widthMm"
                label="Width (mm, optional)"
                type="number"
                min={0}
              />
              <Field
                name="thicknessMicrons"
                label="Thickness (μm, optional)"
                type="number"
                min={0}
              />
              <Field
                name="materialSpec"
                label="Material spec (optional)"
                placeholder="PVC clear 250μ"
              />
              <Field
                name="coreWeightGrams"
                label="Core weight (g, optional)"
                type="number"
                min={0}
              />
              <Field name="supplier" label="Supplier (optional)" />
              <Field name="receiptNumber" label="Receipt # (optional)" />
              <Field name="lotNumber" label="Lot # (optional)" />
              <Field name="location" label="Location (optional)" />
              <Field name="notes" label="Notes (optional)" />
              <div className="sm:col-span-2 flex justify-end">
                <button
                  type="submit"
                  className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
                >
                  Receive roll
                </button>
              </div>
              <p className="sm:col-span-2 text-[10px] text-slate-500">
                Net weight = gross − tare. If you only know the net weight,
                enter it directly — the lot is tagged confidence MEDIUM.
              </p>
            </form>
          )}
        </section>
      </div>

      {/* Recent lots */}
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.10em] text-slate-300 font-semibold mb-2">
          Recent lots
        </h2>
        <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="text-left px-3 py-2">Received</th>
                <th className="text-left px-3 py-2">Material</th>
                <th className="text-left px-3 py-2">Kind</th>
                <th className="text-left px-3 py-2">Roll #</th>
                <th className="text-right px-3 py-2">Qty</th>
                <th className="text-right px-3 py-2">Net g</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Conf.</th>
              </tr>
            </thead>
            <tbody>
              {recentLots.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                    No lots received yet.
                  </td>
                </tr>
              ) : (
                recentLots.map((l) => (
                  <tr key={l.id} className="border-t border-slate-800">
                    <td className="px-3 py-2 text-slate-300 font-mono text-[11px]">
                      {l.receivedAt instanceof Date
                        ? l.receivedAt.toISOString().slice(0, 16).replace("T", " ")
                        : String(l.receivedAt).slice(0, 16)}
                    </td>
                    <td className="px-3 py-2 text-slate-200">{l.materialName ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-300">{l.materialKind ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-300 font-mono">
                      {l.rollNumber ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 font-mono">
                      {l.qtyReceived}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 font-mono">
                      {l.netWeightGrams ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-slate-300">{l.status}</td>
                    <td className="px-3 py-2 text-slate-300 font-mono text-[11px]">
                      {l.confidence ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
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
  max,
  step,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
  step?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        {...(min != null ? { min } : {})}
        {...(max != null ? { max } : {})}
        {...(step ? { step } : {})}
        className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
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
      <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">{label}</span>
      <select
        name={name}
        required={required}
        defaultValue=""
        className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
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
