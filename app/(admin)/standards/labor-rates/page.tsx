// Labor rates admin. Empty by default; cost-per-case stays
// "No labor rate configured" until at least one row exists for
// the role we're costing.

import { db } from "@/lib/db";
import { desc } from "drizzle-orm";
import { laborRates } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { saveLaborRateAction, deleteLaborRateAction } from "../actions";

export const dynamic = "force-dynamic";

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function LaborRatesPage() {
  await requireAdmin();
  const rows = await db
    .select()
    .from(laborRates)
    .orderBy(desc(laborRates.effectiveFrom));
  return (
    <div className="space-y-5">
      <PageHeader
        title="Labor rates"
        description="Hourly rate + burden multiplier per role. Required to compute labor cost per case."
      />
      <form
        action={async (fd) => {
          "use server";
          await saveLaborRateAction(fd);
        }}
        className="rounded-md border border-slate-700/60 bg-slate-900/60 p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
      >
        <h3 className="md:col-span-3 text-sm font-semibold text-slate-100">
          New labor rate
        </h3>
        <Field name="role" label="Role" required placeholder="BLISTER_OPERATOR" />
        <Field
          name="hourlyRateDollars"
          label="Hourly rate ($)"
          type="number"
          step="0.01"
          min={0}
          required
        />
        <Field
          name="burdenMultiplier"
          label="Burden multiplier"
          type="number"
          step="0.001"
          min={0}
          defaultValue="1.300"
          required
        />
        <Field name="effectiveFrom" label="Effective from" type="date" required />
        <Field name="effectiveTo" label="Effective to (optional)" type="date" />
        <Field name="notes" label="Notes" placeholder="optional" />
        <div className="md:col-span-3 flex justify-end">
          <button
            type="submit"
            className="h-9 px-4 rounded-md bg-cyan-500/90 hover:bg-cyan-400 text-slate-950 text-sm font-medium"
          >
            Add rate
          </button>
        </div>
      </form>
      <div className="rounded-md border border-slate-700/60 bg-slate-900/60 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="text-left px-3 py-2">Role</th>
              <th className="text-right px-3 py-2">Hourly</th>
              <th className="text-right px-3 py-2">Burden</th>
              <th className="text-right px-3 py-2">Burdened</th>
              <th className="text-left px-3 py-2">Effective</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No rates configured. Labor cost shows{" "}
                  <span className="text-slate-300">No labor rate configured</span>.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-100 font-mono">{r.role}</td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {formatDollars(r.hourlyRateCents)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {r.burdenMultiplier}x
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300 font-mono">
                    {formatDollars(
                      Math.round(r.hourlyRateCents * Number(r.burdenMultiplier)),
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-300 font-mono text-[11px]">
                    {r.effectiveFrom}
                    {r.effectiveTo ? ` → ${r.effectiveTo}` : " → ∞"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <form
                      action={async () => {
                        "use server";
                        await deleteLaborRateAction(r.id);
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
      <span className="text-[10px] uppercase tracking-[0.10em] text-slate-400">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        {...(min != null ? { min } : {})}
        {...(step ? { step } : {})}
        className="mt-1 w-full h-9 px-2 rounded-md bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
      />
    </label>
  );
}
