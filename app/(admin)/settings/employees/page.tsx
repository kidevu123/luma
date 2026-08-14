// P5-SUPERVISOR Task 2 — admin employees surface (minimal).
//
// This is the FIRST admin-side employees editor. Grepping app/(admin)
// beforehand turned up only operator-productivity reading the table,
// so the plan calls for "a minimal one under the admin layout's
// existing conventions." Minimum surface is exactly what the plan
// requires: set a supervisor PIN, toggle is_supervisor. Full
// employees CRUD (edit name, hire date, status transitions) is out
// of scope for P5 and would sprawl this surface into HR territory.

import { asc, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { employees } from "@/lib/db/schema";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD, EmptyRow } from "@/components/ui/table";
import { EmployeeSupervisorRow } from "./employee-supervisor-row";

export const dynamic = "force-dynamic";

export const metadata = { title: "Employees" };

export default async function EmployeesSupervisorsPage() {
  await requireAdmin();

  // ACTIVE employees ordered by name — the ones an admin might
  // conceivably mark as a supervisor. Terminated employees can't
  // unlock (openSupervisorSession refuses non-ACTIVE) so listing them
  // here would only be noise.
  const rows = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      preferredName: employees.preferredName,
      employeeCode: employees.employeeCode,
      isSupervisor: employees.isSupervisor,
      // Whether a hash is set — never returned to the client, only the
      // boolean is-set fact so the row-actions button can label the
      // input "Replace PIN" instead of "Set PIN". No hash material,
      // no truncated prefix, nothing recoverable.
      hasPin: employees.supervisorPinHash,
      status: employees.status,
    })
    .from(employees)
    .where(sqlWhereActive)
    .orderBy(asc(employees.fullName));

  const active = rows.filter((r) => r.status === "ACTIVE");
  const supervisorCount = active.filter((r) => r.isSupervisor).length;
  const pinCount = active.filter((r) => r.hasPin != null).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employees & supervisors"
        description="Set who can unlock a station in supervisor mode. Only ACTIVE employees with a PIN and the supervisor flag can open a supervisor session on the floor."
      />

      <div className="rounded-xl border border-border/70 bg-surface-2/30 px-4 py-3 text-[12px] text-text-muted grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle mb-0.5">
            Active employees
          </div>
          <div className="font-mono text-text-strong">{active.length}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle mb-0.5">
            Marked supervisors
          </div>
          <div className="font-mono text-text-strong">{supervisorCount}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle mb-0.5">
            PIN set
          </div>
          <div className="font-mono text-text-strong">{pinCount}</div>
        </div>
      </div>

      <DataTable>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH>Employee code</TH>
            <TH>Supervisor</TH>
            <TH>PIN</TH>
            <TH className="text-right">Actions</TH>
          </TR>
        </THead>
        <tbody>
          {active.length === 0 ? (
            <EmptyRow colSpan={5}>No active employees found.</EmptyRow>
          ) : (
            active.map((e) => {
              const display = e.preferredName?.trim() || e.fullName;
              return (
                <TR key={e.id}>
                  <TD>
                    <div>
                      <span className="text-[13px] font-medium text-text-strong">
                        {display}
                      </span>
                      {e.preferredName?.trim() ? (
                        <span className="block font-mono text-[11px] text-text-muted">
                          {e.fullName}
                        </span>
                      ) : null}
                    </div>
                  </TD>
                  <TD>
                    <span className="font-mono text-[12px] text-text-muted">
                      {e.employeeCode ?? "—"}
                    </span>
                  </TD>
                  <TD>
                    {e.isSupervisor ? (
                      <span className="inline-flex items-center h-5 px-2 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 text-[11px] font-medium">
                        Yes
                      </span>
                    ) : (
                      <span className="inline-flex items-center h-5 px-2 rounded-md border border-border bg-surface-2 text-text-muted text-[11px] font-medium">
                        No
                      </span>
                    )}
                  </TD>
                  <TD>
                    {e.hasPin != null ? (
                      <span className="inline-flex items-center h-5 px-2 rounded-md border border-sky-200 bg-sky-50 text-sky-700 text-[11px] font-medium">
                        Set
                      </span>
                    ) : (
                      <span className="inline-flex items-center h-5 px-2 rounded-md border border-border bg-surface-2 text-text-muted text-[11px] font-medium">
                        Not set
                      </span>
                    )}
                  </TD>
                  <TD className="text-right">
                    <EmployeeSupervisorRow
                      employee={{
                        id: e.id,
                        fullName: display,
                        isSupervisor: e.isSupervisor,
                        hasPin: e.hasPin != null,
                      }}
                    />
                  </TD>
                </TR>
              );
            })
          )}
        </tbody>
      </DataTable>

      <div className="rounded-xl border border-border/70 bg-surface-2/30 px-4 py-3 text-[12px] text-text-subtle space-y-1">
        <p className="font-medium text-text-muted">Supervisor unlock rules</p>
        <ul className="space-y-0.5 list-disc list-inside">
          <li>Only <span className="font-medium text-text-muted">ACTIVE</span> employees may hold a supervisor PIN.</li>
          <li>Marking Supervisor requires a PIN to already be set — otherwise the toggle is refused.</li>
          <li>PINs are hashed with argon2id and never displayed. Replacing a PIN overwrites the hash.</li>
          <li>Unlocking a station opens a 15-minute session. Explicit lock or expiry both close it.</li>
        </ul>
      </div>
    </div>
  );
}

const sqlWhereActive = sql`status = 'ACTIVE'`;
