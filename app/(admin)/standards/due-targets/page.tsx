// Due-target admin. Empty by default; on-time + schedule-gap KPIs
// stay "No target configured" until at least one row exists.

import { db } from "@/lib/db";
import { desc, eq } from "drizzle-orm";
import { dueTargets, products } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import {
  saveDueTargetAction,
  markDueTargetCompleteAction,
  deleteDueTargetAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function DueTargetsPage() {
  await requireAdmin();
  const [rows, productOpts] = await Promise.all([
    db
      .select({
        id: dueTargets.id,
        referenceKind: dueTargets.referenceKind,
        referenceId: dueTargets.referenceId,
        productName: products.name,
        targetQuantity: dueTargets.targetQuantity,
        targetUnit: dueTargets.targetUnit,
        dueAt: dueTargets.dueAt,
        priority: dueTargets.priority,
        completedAt: dueTargets.completedAt,
      })
      .from(dueTargets)
      .leftJoin(products, eq(products.id, dueTargets.productId))
      .orderBy(desc(dueTargets.dueAt)),
    db
      .select({ id: products.id, name: products.name, sku: products.sku })
      .from(products)
      .orderBy(products.name),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Due targets"
        description="Order/batch due dates with target quantity. Drives on-time completion and schedule-gap KPIs."
      />
      <form
        action={async (fd) => {
          "use server";
          await saveDueTargetAction(fd);
        }}
        className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
      >
        <h3 className="md:col-span-3 text-sm font-semibold text-slate-100">New target</h3>
        <Field name="referenceKind" label="Reference kind" required placeholder="PO" />
        <Field name="referenceId" label="Reference ID" required placeholder="PO-2026-0042" />
        <SelectField
          name="productId"
          label="Product (optional)"
          options={productOpts.map((p) => ({ value: p.id, label: `${p.sku} — ${p.name}` }))}
        />
        <Field name="targetQuantity" label="Target quantity" type="number" min={1} required />
        <SelectField
          name="targetUnit"
          label="Target unit"
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
        <Field name="dueAt" label="Due at" type="datetime-local" required />
        <Field name="priority" label="Priority (1=highest)" type="number" min={1} max={100} defaultValue="50" />
        <Field name="notes" label="Notes" placeholder="optional" />
        <div className="md:col-span-3 flex justify-end">
          <button
            type="submit"
            className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
          >
            Add target
          </button>
        </div>
      </form>

      <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="text-left px-3 py-2">Reference</th>
              <th className="text-left px-3 py-2">Product</th>
              <th className="text-right px-3 py-2">Qty</th>
              <th className="text-left px-3 py-2">Unit</th>
              <th className="text-left px-3 py-2">Due</th>
              <th className="text-right px-3 py-2">Priority</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                  No targets configured. Schedule gap and on-time completion show{" "}
                  <span className="text-slate-300">No target configured</span>.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-100">
                    <div className="font-mono text-[11px] text-slate-400">{r.referenceKind}</div>
                    <div>{r.referenceId}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.productName ?? "any"}</td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {r.targetQuantity.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.targetUnit}</td>
                  <td className="px-3 py-2 text-slate-300 font-mono text-[11px]">
                    {r.dueAt instanceof Date
                      ? r.dueAt.toISOString().replace("T", " ").slice(0, 16)
                      : String(r.dueAt)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">{r.priority}</td>
                  <td className="px-3 py-2 text-slate-300">
                    {r.completedAt ? (
                      <span className="text-emerald-300">completed</span>
                    ) : (
                      <span className="text-amber-300">open</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!r.completedAt && (
                      <form
                        action={async () => {
                          "use server";
                          await markDueTargetCompleteAction(r.id);
                        }}
                        className="inline-block mr-3"
                      >
                        <button type="submit" className="text-[11px] text-emerald-300 hover:text-emerald-200">
                          mark complete
                        </button>
                      </form>
                    )}
                    <form
                      action={async () => {
                        "use server";
                        await deleteDueTargetAction(r.id);
                      }}
                      className="inline-block"
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
