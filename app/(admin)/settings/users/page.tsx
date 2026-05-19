import { requireAdmin } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { asc } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD, EmptyRow } from "@/components/ui/table";
import { AddUserForm } from "./add-user-form";
import { UserRowActions } from "./user-row-actions";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  LEAD: "Lead",
  STAFF: "Staff",
};

const ROLE_STYLE: Record<string, string> = {
  OWNER: "border-purple-200 bg-purple-50 text-purple-700",
  ADMIN: "border-red-200 bg-red-50 text-red-700",
  MANAGER: "border-sky-200 bg-sky-50 text-sky-700",
  LEAD: "border-amber-200 bg-amber-50 text-amber-700",
  STAFF: "border-border bg-surface-2 text-text-muted",
};

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export default async function UsersPage() {
  const me = await requireAdmin();

  const allUsers = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      disabledAt: users.disabledAt,
      mustChangePassword: users.mustChangePassword,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.createdAt));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Manage who can access Luma and what they can do. Roles control which pages and actions each user can reach."
      />

      <div className="rounded-xl border border-border/70 bg-surface-2/30 px-4 py-3 text-[12px] text-text-muted grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle mb-0.5">Total users</div>
          <div className="font-mono text-text-strong">{allUsers.length}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle mb-0.5">Active</div>
          <div className="font-mono text-text-strong">{allUsers.filter((u) => !u.disabledAt).length}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle mb-0.5">Disabled</div>
          <div className="font-mono text-text-strong">{allUsers.filter((u) => u.disabledAt).length}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-subtle mb-0.5">Pending password change</div>
          <div className="font-mono text-text-strong">{allUsers.filter((u) => u.mustChangePassword && !u.disabledAt).length}</div>
        </div>
      </div>

      <DataTable>
        <THead>
          <TR>
            <TH>Email</TH>
            <TH>Role</TH>
            <TH>Last login</TH>
            <TH>Status</TH>
            <TH className="text-right">Actions</TH>
          </TR>
        </THead>
        <tbody>
          {allUsers.length === 0 ? (
            <EmptyRow colSpan={5}>No users found.</EmptyRow>
          ) : (
            allUsers.map((u) => (
              <TR key={u.id}>
                <TD>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-text">{u.email}</span>
                    {u.id === me.id && (
                      <span className="text-[10px] text-text-subtle px-1 py-0.5 rounded border border-border bg-surface-2">you</span>
                    )}
                    {u.mustChangePassword && !u.disabledAt && (
                      <span className="text-[10px] text-amber-600">pw reset pending</span>
                    )}
                  </div>
                </TD>
                <TD>
                  <span
                    className={`inline-flex items-center h-5 px-2 rounded-md border text-[11px] font-medium ${ROLE_STYLE[u.role] ?? ROLE_STYLE["STAFF"]}`}
                  >
                    {ROLE_LABEL[u.role] ?? u.role}
                  </span>
                </TD>
                <TD>
                  <span className="text-[12px] text-text-muted">{formatDate(u.lastLoginAt)}</span>
                </TD>
                <TD>
                  {u.disabledAt ? (
                    <span className="inline-flex items-center h-5 px-2 rounded-md border border-red-200 bg-red-50 text-red-700 text-[11px] font-medium">
                      Disabled
                    </span>
                  ) : (
                    <span className="inline-flex items-center h-5 px-2 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 text-[11px] font-medium">
                      Active
                    </span>
                  )}
                </TD>
                <TD className="text-right">
                  <UserRowActions
                    user={u}
                    currentUserId={me.id}
                    currentUserRole={me.role}
                  />
                </TD>
              </TR>
            ))
          )}
        </tbody>
      </DataTable>

      <div className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text-strong mb-1">Add user</h2>
        <p className="text-xs text-text-subtle mb-4">
          Creates a local password account. The user will be prompted to change their password on first login.
        </p>
        <AddUserForm />
      </div>

      <div className="rounded-xl border border-border/70 bg-surface-2/30 px-4 py-3 text-[12px] text-text-subtle space-y-1">
        <p className="font-medium text-text-muted">Role permissions</p>
        <ul className="space-y-0.5 list-disc list-inside">
          <li><span className="font-medium text-text-muted">Owner</span> — full access, can manage other owners</li>
          <li><span className="font-medium text-text-muted">Admin</span> — full access, can manage all non-owner users</li>
          <li><span className="font-medium text-text-muted">Manager</span> — floor access + management reports</li>
          <li><span className="font-medium text-text-muted">Lead</span> — floor access, can start production and receive inventory</li>
          <li><span className="font-medium text-text-muted">Staff</span> — floor access only</li>
        </ul>
      </div>
    </div>
  );
}
