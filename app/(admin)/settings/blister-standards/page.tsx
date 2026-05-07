// Phase H.x5 — blister material standards. Configure PVC + foil
// consumption per (product, role). The metric API + Phase C
// projector hook read these to compute expected roll usage.

import { db } from "@/lib/db";
import { eq, asc, desc, sql } from "drizzle-orm";
import {
  blisterMaterialStandards,
  packagingMaterials,
  products,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import {
  saveBlisterStandardAction,
  deleteBlisterStandardAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function BlisterStandardsPage() {
  await requireAdmin();
  const [rows, productList, rollMaterials] = await Promise.all([
    db
      .select({
        id: blisterMaterialStandards.id,
        productName: products.name,
        productSku: products.sku,
        materialName: packagingMaterials.name,
        materialKind: packagingMaterials.kind,
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Blister material standards"
        description="PVC + foil consumption rates per product. Roll usage cannot be projected until standards are configured."
      />

      {rollMaterials.length === 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-200">
          <strong>No PVC / foil roll materials configured.</strong> Create
          a material with kind <code>PVC_ROLL</code> or <code>FOIL_ROLL</code>{" "}
          at <code>/settings/materials</code> first.
        </div>
      ) : (
        <form
          action={async (fd) => {
            "use server";
            await saveBlisterStandardAction(fd);
          }}
          className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
        >
          <h3 className="md:col-span-3 text-sm font-semibold text-slate-100">New standard</h3>
          <SelectField
            name="productId"
            label="Product (optional — leave blank for default)"
            options={productList.map((p) => ({ value: p.id, label: `${p.sku} — ${p.name}` }))}
          />
          <SelectField
            name="packagingMaterialId"
            label="Roll material"
            required
            options={rollMaterials.map((m) => ({
              value: m.id,
              label: `${m.sku} — ${m.name} (${m.kind})`,
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
            label="Grams per blister (preferred)"
            type="number"
            min={0}
            step="0.0001"
          />
          <Field
            name="expectedBlistersPerKg"
            label="Blisters per kg (alternate)"
            type="number"
            min={0}
            step="0.001"
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
              className="h-4 w-4 accent-cyan-500"
            />
            <span className="text-sm text-slate-300">Active</span>
          </label>
          <Field name="notes" label="Notes" placeholder="optional" />
          <div className="md:col-span-3 flex justify-end">
            <button
              type="submit"
              className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
            >
              Add standard
            </button>
          </div>
        </form>
      )}

      <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="text-left px-3 py-2">Product</th>
              <th className="text-left px-3 py-2">Material</th>
              <th className="text-left px-3 py-2">Role</th>
              <th className="text-right px-3 py-2">g/blister</th>
              <th className="text-right px-3 py-2">blisters/kg</th>
              <th className="text-right px-3 py-2">Setup waste</th>
              <th className="text-right px-3 py-2">Changeover</th>
              <th className="text-left px-3 py-2">Effective</th>
              <th className="text-left px-3 py-2">Active</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-slate-500">
                  No blister material standards configured. Roll usage cannot be
                  projected until at least one row exists.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-300">
                    {r.productName ?? <span className="text-slate-500">any</span>}
                    {r.productSku && (
                      <div className="text-[10px] text-slate-500 font-mono">{r.productSku}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.materialName ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-300">{r.materialRole}</td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {r.expectedGramsPerBlister ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {r.expectedBlistersPerKg ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {r.setupWasteGrams}g
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {r.changeoverWasteGrams}g
                  </td>
                  <td className="px-3 py-2 text-slate-300 font-mono text-[11px]">
                    {r.effectiveFrom}
                    {r.effectiveTo ? ` → ${r.effectiveTo}` : " → ∞"}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.isActive ? "yes" : "no"}</td>
                  <td className="px-3 py-2 text-right">
                    <form
                      action={async () => {
                        "use server";
                        await deleteBlisterStandardAction(r.id);
                      }}
                    >
                      <button
                        type="submit"
                        className="text-[11px] text-rose-300 hover:text-rose-200"
                      >
                        delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
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
