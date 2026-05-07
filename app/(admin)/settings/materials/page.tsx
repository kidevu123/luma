// Phase H.x5 — material item master list. Lets the admin create
// the master records for every packaging material the floor will
// later consume (display boxes, cases, bottles, caps, labels,
// induction seals, PVC rolls, foil rolls). Empty by default.

import { db } from "@/lib/db";
import { eq, desc, sql } from "drizzle-orm";
import { packagingMaterials } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import {
  saveMaterialItemAction,
  toggleMaterialItemActiveAction,
} from "./actions";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  DISPLAY: "Display box",
  CASE: "Master case",
  LABEL: "Label",
  BOTTLE: "Bottle",
  CAP: "Cap",
  INDUCTION_SEAL: "Induction seal",
  INSERT: "Insert",
  SHRINK_BAND: "Shrink band",
  PVC_ROLL: "PVC roll",
  FOIL_ROLL: "Foil roll",
  OTHER: "Other",
};

export default async function MaterialsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; q?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const kindFilter = sp.kind && sp.kind !== "ALL" ? sp.kind : null;
  const q = sp.q?.trim().toLowerCase() ?? "";
  const rows = await db
    .select()
    .from(packagingMaterials)
    .where(
      kindFilter
        ? eq(packagingMaterials.kind, kindFilter as never)
        : sql`true`,
    )
    .orderBy(desc(packagingMaterials.createdAt));
  const filtered = q
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.sku.toLowerCase().includes(q),
      )
    : rows;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Materials"
        description={`${rows.length} item${rows.length === 1 ? "" : "s"} in the master list. Inactive items are hidden from new BOM and receiving forms.`}
      />

      {/* Filter bar */}
      <form
        method="get"
        className="rounded-md border border-slate-700/60 bg-slate-900/60 p-3 flex flex-wrap items-end gap-2"
      >
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">Kind</span>
          <select
            name="kind"
            defaultValue={kindFilter ?? "ALL"}
            className="mt-1 h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
          >
            <option value="ALL">All</option>
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block flex-1 min-w-[200px]">
          <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">Search</span>
          <input
            type="text"
            name="q"
            placeholder="name or sku"
            defaultValue={q}
            className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          className="h-9 px-3 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm"
        >
          Filter
        </button>
      </form>

      {/* Create form */}
      <form
        action={async (fd) => {
          "use server";
          await saveMaterialItemAction(fd);
        }}
        className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
      >
        <h3 className="md:col-span-3 text-sm font-semibold text-slate-100">New material</h3>
        <Field name="sku" label="SKU / code" required placeholder="DISP-A-12" />
        <Field name="name" label="Name" required placeholder="Display box — A pack" />
        <SelectField
          name="kind"
          label="Kind"
          required
          options={Object.entries(KIND_LABELS).map(([v, l]) => ({ value: v, label: l }))}
        />
        <Field name="uom" label="Unit of measure" required defaultValue="each" placeholder="each / kg / roll" />
        <Field name="parLevel" label="Par level (optional)" type="number" min={0} />
        <label className="flex items-end gap-2">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked
            className="h-4 w-4 accent-cyan-500"
          />
          <span className="text-sm text-slate-300">Active</span>
        </label>
        <div className="md:col-span-3 flex justify-end">
          <button
            type="submit"
            className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
          >
            Add material
          </button>
        </div>
      </form>

      {/* List */}
      <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="text-left px-3 py-2">SKU</th>
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Kind</th>
              <th className="text-left px-3 py-2">UoM</th>
              <th className="text-right px-3 py-2">Par</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  {rows.length === 0
                    ? "No materials configured yet. Create the first one above."
                    : "No items match the current filter."}
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.id} className="border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-100 font-mono">{r.sku}</td>
                  <td className="px-3 py-2 text-slate-200">{r.name}</td>
                  <td className="px-3 py-2 text-slate-300">{KIND_LABELS[r.kind] ?? r.kind}</td>
                  <td className="px-3 py-2 text-slate-300 font-mono">{r.uom}</td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {r.parLevel ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {r.isActive ? (
                      <span className="text-emerald-300 text-[11px]">active</span>
                    ) : (
                      <span className="text-slate-500 text-[11px]">inactive</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <form
                      action={async () => {
                        "use server";
                        await toggleMaterialItemActiveAction(r.id, !r.isActive);
                      }}
                    >
                      <button
                        type="submit"
                        className="text-[11px] text-slate-400 hover:text-cyan-300"
                      >
                        {r.isActive ? "deactivate" : "activate"}
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
  defaultValue,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">{label}</span>
      <select
        name={name}
        required={required}
        defaultValue={defaultValue ?? ""}
        className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
      >
        {!defaultValue && <option value="">— select —</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
