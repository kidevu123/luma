"use client";

import { useTransition, useRef, useState } from "react";
import { Input, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createUserAction } from "./actions";

export function AddUserForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await createUserAction(fd);
      if ("error" in result) {
        setError(result.error);
      } else {
        setSuccess(true);
        formRef.current?.reset();
      }
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="add-name">Name</Label>
          <Input
            id="add-name"
            name="name"
            type="text"
            placeholder="Real person name"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="add-email">Email</Label>
          <Input
            id="add-email"
            name="email"
            type="email"
            placeholder="user@example.com"
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="add-password">Initial password</Label>
          <Input
            id="add-password"
            name="password"
            type="password"
            placeholder="Min. 8 characters"
            required
            autoComplete="new-password"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="add-role">Role</Label>
          <Select id="add-role" name="role" defaultValue="STAFF">
            <option value="STAFF">Staff</option>
            <option value="LEAD">Lead</option>
            <option value="MANAGER">Manager</option>
            <option value="ADMIN">Admin</option>
          </Select>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-600">{error}</p>
      )}
      {success && (
        <p className="text-xs text-emerald-600">User created. They can log in with the email and password you set.</p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Creating…" : "Create user"}
        </Button>
        <p className="text-xs text-text-subtle">
          User will be prompted to change their password on first login.
        </p>
      </div>
    </form>
  );
}
