"use client";

import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import {
  updateRoleAction,
  disableUserAction,
  enableUserAction,
  resetPasswordAction,
  updateUserProfileAction,
  deleteUserAction,
} from "./actions";
import { ChevronDown, ChevronUp } from "lucide-react";

type Role = "OWNER" | "ADMIN" | "MANAGER" | "LEAD" | "STAFF";

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  disabled: boolean;
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
  // P3-USERS — edit (name/email) + delete flows.
  const [showEditForm, setShowEditForm] = useState(false);
  const [editName, setEditName] = useState(user.name ?? "");
  const [editEmail, setEditEmail] = useState(user.email);
  const [editError, setEditError] = useState<string | null>(null);
  const [editPending, startEditTransition] = useTransition();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, startDeleteTransition] = useTransition();

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
      const action = user.disabled ? enableUserAction : disableUserAction;
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

      {/* Disable / enable + edit + reset password + delete */}
      {canModify && (
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setShowEditForm((v) => !v);
              setEditError(null);
            }}
            className="h-7 text-[12px] text-text-subtle"
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant={user.disabled ? "secondary" : "ghost"}
            onClick={handleToggle}
            disabled={togglePending}
            className={`h-7 text-[12px] ${!user.disabled ? "text-red-600 hover:bg-red-50" : ""}`}
          >
            {togglePending ? "…" : user.disabled ? "Enable" : "Disable"}
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setShowDeleteConfirm((v) => !v);
              setDeleteError(null);
            }}
            className="h-7 text-[12px] text-red-600 hover:bg-red-50"
          >
            Delete
          </Button>
        </div>
      )}

      {/* P3-USERS — edit name/email */}
      {showEditForm && canModify && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setEditError(null);
            const fd = new FormData();
            fd.set("userId", user.id);
            fd.set("name", editName);
            fd.set("email", editEmail);
            startEditTransition(async () => {
              const result = await updateUserProfileAction(fd);
              if ("error" in result) setEditError(result.error);
              else setShowEditForm(false);
            });
          }}
          className="flex items-center gap-1.5 flex-wrap justify-end"
        >
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Name"
            className="h-7 w-36 text-[12px]"
          />
          <Input
            value={editEmail}
            onChange={(e) => setEditEmail(e.target.value)}
            placeholder="Email"
            type="email"
            required
            className="h-7 w-48 text-[12px]"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={editPending}
            className="h-7 text-[12px]"
          >
            {editPending ? "…" : "Save"}
          </Button>
        </form>
      )}
      {editError && <p className="text-[11px] text-red-600 text-right">{editError}</p>}

      {/* P3-USERS — delete confirmation explaining resource handling */}
      {showDeleteConfirm && canModify && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 max-w-[320px] text-left space-y-1.5">
          <p className="text-[11.5px] text-red-800 leading-snug">
            Delete <span className="font-semibold">{user.name?.trim() || user.email}</span>?
            Their workflows, logs, and history are kept and will show as
            owned by <span className="font-semibold">Deleted user</span>.
            This cannot be undone.
          </p>
          <div className="flex gap-1.5 justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowDeleteConfirm(false)}
              className="h-7 text-[12px]"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={deletePending}
              onClick={() => {
                setDeleteError(null);
                const fd = new FormData();
                fd.set("userId", user.id);
                startDeleteTransition(async () => {
                  const result = await deleteUserAction(fd);
                  if ("error" in result) setDeleteError(result.error);
                  else setShowDeleteConfirm(false);
                });
              }}
              className="h-7 text-[12px] text-red-700"
            >
              {deletePending ? "Deleting…" : "Confirm delete"}
            </Button>
          </div>
          {deleteError && (
            <p className="text-[11px] text-red-700 text-right">{deleteError}</p>
          )}
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
