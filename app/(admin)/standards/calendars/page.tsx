// Production calendars admin. Each row drives the OEE Availability
// denominator for the days it covers.

import { db } from "@/lib/db";
import { desc } from "drizzle-orm";
import { productionCalendars } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { saveCalendarAction, deleteCalendarAction } from "../actions";

export const dynamic = "force-dynamic";

const DAYS = [
  { mask: 1, label: "S" },
  { mask: 2, label: "M" },
  { mask: 4, label: "T" },
  { mask: 8, label: "W" },
  { mask: 16, label: "T" },
  { mask: 32, label: "F" },
  { mask: 64, label: "S" },
];

export default async function CalendarsPage() {
  await requireAdmin();
  const rows = await db
    .select()
    .from(productionCalendars)
    .orderBy(desc(productionCalendars.effectiveFrom));
  return (
    <div className="space-y-5">
      <PageHeader
        title="Production calendars"
        description="Shifts and planned production minutes. Drives the OEE Availability denominator."
      />
      <form
        action={async (fd) => {
          "use server";
          await saveCalendarAction(fd);
        }}
        className="rounded-xl border border-border bg-surface p-4 grid grid-cols-1 md:grid-cols-3 gap-3"
      >
        <h3 className="md:col-span-3 text-sm font-semibold text-text-strong">
          New calendar
        </h3>
        <Field name="name" label="Name" required placeholder="Day shift M-F" />
        <Field name="effectiveFrom" label="Effective from" type="date" required />
        <Field name="effectiveTo" label="Effective to (optional)" type="date" />
        <Field name="shiftStart" label="Shift start (HH:MM)" required placeholder="08:00" />
        <Field name="shiftEnd" label="Shift end (HH:MM)" required placeholder="17:00" />
        <Field
          name="plannedBreakMinutes"
          label="Planned break (min)"
          type="number"
          defaultValue="60"
          min={0}
          max={720}
        />
        <Field
          name="daysOfWeekMask"
          label="Days bitmask (Mon–Fri = 62)"
          type="number"
          defaultValue="62"
          min={1}
          max={127}
        />
        <Field name="notes" label="Notes" placeholder="optional" />
        <div className="md:col-span-3 flex justify-end">
          <button
            type="submit"
            className="h-9 px-4 rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
          >
            Add calendar
          </button>
        </div>
      </form>

      <div className="rounded-xl border border-border bg-surface overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-2/50 text-[10px] uppercase tracking-wider text-text-muted">
            <tr>
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Effective</th>
              <th className="text-left px-3 py-2">Shift</th>
              <th className="text-right px-3 py-2">Break</th>
              <th className="text-left px-3 py-2">Days</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-text-muted">
                  No calendars configured. OEE Availability is{" "}
                  <span className="text-text-strong">Insufficient data</span> until at least one effective row exists.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 text-text-strong">{r.name}</td>
                  <td className="px-3 py-2 text-text-strong">
                    {r.effectiveFrom}
                    {r.effectiveTo ? ` → ${r.effectiveTo}` : " → ∞"}
                  </td>
                  <td className="px-3 py-2 text-text-strong font-mono">
                    {r.shiftStart} – {r.shiftEnd}
                  </td>
                  <td className="px-3 py-2 text-text-strong text-right font-mono">
                    {r.plannedBreakMinutes}m
                  </td>
                  <td className="px-3 py-2 text-text-strong">
                    {DAYS.map((d) =>
                      (r.daysOfWeekMask & d.mask) === d.mask ? d.label : "·",
                    ).join(" ")}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <form
                      action={async () => {
                        "use server";
                        await deleteCalendarAction(r.id);
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
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.10em] text-text-muted">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        {...(min != null ? { min } : {})}
        {...(max != null ? { max } : {})}
        className="mt-1 w-full h-9 px-2 rounded-md bg-surface-2 border border-border text-sm text-text-strong placeholder:text-text-subtle focus:border-brand-500 focus:outline-none"
      />
    </label>
  );
}
