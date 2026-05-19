"use client";

import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { updateRoleAction, disableUserAction, enableUserAction, resetPasswordAction } from "./actions";
import { ChevronDown, ChevronUp } from "lucide-react";

type Role = "OWNER" | "ADMIN" | "MANAGER" | "LEAD" | "STAFF";

type UserRow = {
  id: string;
  email: string;
  role: Role;
  disabledAt: Date | null;
};

export function UserRowActions({
  user,
  currentUserId,
  currentUserRole,
}: {
  user: UserRow;
  currentUserId: string;
  currentUserRole: Role;
}) {
  const [rolePending, startRoleTransition] = useTransition();
  const [togglePending, startToggleTransition] = useTransition();
  const [resetPending, startResetTransition] = useTransition();

  const [selectedRole, setSelectedRole] = useState<Role>(user.role);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState(false);
  const [showResetForm, setShowResetForm] = useState(false);

  const isSelf = user.id === currentUserId;
  const isOwner = user.role === "OWNER";
  // Non-owner admins can't modify owner accounts
  const canModify = !isSelf && !(isOwner && currentUserRole !== "OWNER");
  const canAssignRoles = canModify;

  function handleRoleSave() {
    setRoleError(null);
    const fd = new FormData();
    fd.set("userId", user.id);
    fd.set("role", selectedRole);
    startRoleTransition(async () => {
      const result = await updateRoleAction(fd);
      if ("error" in result) setRoleError(result.error);
    });
  }

  function handleToggle() {
    setToggleError(null);
    const fd = new FormData();
    fd.set("userId", user.id);
    startToggleTransition(async () => {
      const action = user.disabledAt ? enableUserAction : disableUserAction;
      const result = await action(fd);
      if ("error" in result) setToggleError(result.error);
    });
  }

  function handleResetSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setResetError(null);
    setResetSuccess(false);
    const fd = new FormData(e.currentTarget);
    fd.set("userId", user.id);
    startResetTransition(async () => {
      const result = await resetPasswordAction(fd);
      if ("error" in result) {
        setResetError(result.error);
      } else {
        setResetSuccess(true);
        setShowResetForm(false);
        (e.target as HTMLFormElement).reset();
      }
    });
  }

  if (isSelf) {
    return <span className="text-[11px] text-text-subtle">—</span>;
  }

  return (
    <div className="flex flex-col gap-2 items-end min-w-[260px]">
      {/* Role change */}
      <div className="flex items-center gap-1.5">
        <Select
          value={selectedRole}
          onChange={(e) => setSelectedRole(e.target.value as Role)}
          disabled={!canAssignRoles || rolePending}
          className="h-7 w-28 text-[12px]"
        >
          {currentUserRole === "OWNER" && <option value="OWNER">Owner</option>}
          <option value="ADMIN">Admin</option>
          <option value="MANAGER">Manager</option>
          <option value="LEAD">Lead</option>
          <option value="STAFF">Staff</option>
        </Select>
        {canAssignRoles && selectedRole !== user.role && (
          <Button
            size="sm"
            variant="secondary"
            onClick={handleRoleSave}
            disabled={rolePending}
            className="h-7 text-[12px]"
          >
            {rolePending ? "…" : "Save"}
          </Button>
        )}
      </div>

      {roleError && <p className="text-[11px] text-red-600 text-right">{roleError}</p>}

      {/* Disable / enable + reset password */}
      {canModify && (
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          <Button
            size="sm"
            variant={user.disabledAt ? "secondary" : "ghost"}
            onClick={handleToggle}
            disabled={togglePending}
            className={`h-7 text-[12px] ${!user.disabledAt ? "text-red-600 hover:bg-red-50" : ""}`}
          >
            {togglePending ? "…" : user.disabledAt ? "Enable" : "Disable"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setShowResetForm((v) => !v); setResetError(null); setResetSuccess(false); }}
            className="h-7 text-[12px] text-text-subtle"
          >
            Reset password
            {showResetForm ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        </div>
      )}

      {toggleError && <p className="text-[11px] text-red-600 text-right">{toggleError}</p>}

      {/* Reset password inline form */}
      {showResetForm && (
        <form onSubmit={handleResetSubmit} className="flex items-center gap-1.5 flex-wrap justify-end">
          <Input
            name="newPassword"
            type="password"
            placeholder="New password (8+ chars)"
            required
            className="h-7 w-44 text-[12px]"
            autoComplete="new-password"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={resetPending}
            className="h-7 text-[12px]"
          >
            {resetPending ? "…" : "Set"}
          </Button>
        </form>
      )}

      {resetError && <p className="text-[11px] text-red-600 text-right">{resetError}</p>}
      {resetSuccess && <p className="text-[11px] text-emerald-600 text-right">Password updated.</p>}
    </div>
  );
}
