// Station / machine standards admin. Drives OEE Performance,
// per-machine ideal cycle, and the bottleneck-vs-standard signal.

import { db } from "@/lib/db";
import { desc, eq } from "drizzle-orm";
import {
  stationStandards,
  stations,
  machines,
  products,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import {
  saveStationStandardAction,
  deleteStationStandardAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function StationStandardsPage() {
  await requireAdmin();
  const [rows, stationOpts, machineOpts, productOpts] = await Promise.all([
    db
      .select({
        id: stationStandards.id,
        stationLabel: stations.label,
        machineName: machines.name,
        productName: products.name,
        idealCycleSeconds: stationStandards.idealCycleSeconds,
        targetUnitsPerHour: stationStandards.targetUnitsPerHour,
        expectedYieldPct: stationStandards.expectedYieldPct,
        outputUnit: stationStandards.outputUnit,
        effectiveFrom: stationStandards.effectiveFrom,
        effectiveTo: stationStandards.effectiveTo,
        isActive: stationStandards.isActive,
      })
      .from(stationStandards)
      .leftJoin(stations, eq(stations.id, stationStandards.stationId))
      .leftJoin(machines, eq(machines.id, stationStandards.machineId))
      .leftJoin(products, eq(products.id, stationStandards.productId))
      .orderBy(desc(stationStandards.effectiveFrom)),
    db.select({ id: stations.id, label: stations.label }).from(stations).orderBy(stations.label),
    db.select({ id: machines.id, name: machines.name }).from(machines).orderBy(machines.name),
    db.select({ id: products.id, name: products.name, sku: products.sku }).from(products).orderBy(products.name),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Station / machine standards"
        description="Ideal cycle and target rate per (station or machine, product). Performance vs. standard refuses to compute until at least one active row matches the running bag."
      />
      <form
        action={async (fd) => {
          "use server";
          await saveStationStandardAction(fd);
        }}
        className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
      >
        <h3 className="md:col-span-4 text-sm font-semibold text-slate-100">
          New standard
        </h3>
        <SelectField name="stationId" label="Station (optional)" options={stationOpts.map((s) => ({ value: s.id, label: s.label }))} />
        <SelectField name="machineId" label="Machine (optional)" options={machineOpts.map((m) => ({ value: m.id, label: m.name }))} />
        <SelectField name="productId" label="Product (optional)" options={productOpts.map((p) => ({ value: p.id, label: `${p.sku} — ${p.name}` }))} />
        <SelectField
          name="outputUnit"
          label="Output unit"
          required
          options={[
            { value: "BAG", label: "BAG" },
            { value: "DISPLAY", label: "DISPLAY" },
            { value: "CASE", label: "CASE" },
            { value: "TABLET", label: "TABLET" },
            { value: "BOTTLE", label: "BOTTLE" },
            { value: "CARD", label: "CARD" },
          ]}
        />
        <Field name="idealCycleSeconds" label="Ideal cycle (sec / unit)" type="number" min={0} step="0.001" />
        <Field name="targetUnitsPerHour" label="Target units/hr" type="number" min={0} step="0.001" />
        <Field name="expectedYieldPct" label="Expected yield %" type="number" min={0} max={100} step="0.01" />
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
        <div className="md:col-span-4 flex justify-end">
          <button
            type="submit"
            className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
          >
            Add standard
          </button>
        </div>
      </form>

      <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="text-left px-3 py-2">Scope</th>
              <th className="text-left px-3 py-2">Product</th>
              <th className="text-right px-3 py-2">Ideal sec/unit</th>
              <th className="text-right px-3 py-2">Target /hr</th>
              <th className="text-right px-3 py-2">Yield %</th>
              <th className="text-left px-3 py-2">Unit</th>
              <th className="text-left px-3 py-2">Effective</th>
              <th className="text-left px-3 py-2">Active</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                  No standards configured. Performance vs. standard and OEE
                  Performance show <span className="text-slate-300">No standard configured</span>.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-100">
                    {r.stationLabel ?? r.machineName ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.productName ?? "any"}</td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {r.idealCycleSeconds ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {r.targetUnitsPerHour ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {r.expectedYieldPct ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.outputUnit}</td>
                  <td className="px-3 py-2 text-slate-300 font-mono text-[11px]">
                    {r.effectiveFrom}
                    {r.effectiveTo ? ` → ${r.effectiveTo}` : " → ∞"}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.isActive ? "yes" : "no"}</td>
                  <td className="px-3 py-2 text-right">
                    <form
                      action={async () => {
                        "use server";
                        await deleteStationStandardAction(r.id);
                      }}
                    >
                      <button type="submit" className="text-[11px] text-rose-300 hover:text-rose-200">
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
        <option value="">— none —</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
