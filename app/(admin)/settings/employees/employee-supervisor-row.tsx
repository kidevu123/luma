"use client";

// P5-SUPERVISOR Task 2 — per-row PIN-set + supervisor-toggle controls.
//
// Deliberately minimal. The PIN input is type="password" so shoulder
// surfers see dots, and autoComplete="new-password" so the browser's
// autofill can't leak an unrelated stored password into this field.
// The value is sent straight to the server action and never held in
// component state after submit succeeds — resetting the ref clears it
// from the DOM as soon as the transition completes.

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  setEmployeeSupervisorPinAction,
  toggleEmployeeIsSupervisorAction,
} from "./actions";

type Props = {
  employee: {
    id: string;
    fullName: string;
    isSupervisor: boolean;
    hasPin: boolean;
  };
};

export function EmployeeSupervisorRow({ employee }: Props) {
  const [pinPending, startPinTransition] = useTransition();
  const [togglePending, startToggleTransition] = useTransition();
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSuccess, setPinSuccess] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function handlePinSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPinError(null);
    setPinSuccess(false);
    const fd = new FormData(e.currentTarget);
    fd.set("employeeId", employee.id);
    startPinTransition(async () => {
      const result = await setEmployeeSupervisorPinAction(fd);
      if ("error" in result) {
        setPinError(result.error);
        return;
      }
      setPinSuccess(true);
      // Clear the DOM value straight away — see component header.
      formRef.current?.reset();
    });
  }

  function handleToggle() {
    setToggleError(null);
    const fd = new FormData();
    fd.set("employeeId", employee.id);
    fd.set("isSupervisor", employee.isSupervisor ? "false" : "true");
    startToggleTransition(async () => {
      const result = await toggleEmployeeIsSupervisorAction(fd);
      if ("error" in result) setToggleError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2 items-end min-w-[280px]">
      <div className="flex items-center gap-1.5 flex-wrap justify-end">
        <Button
          size="sm"
          variant={employee.isSupervisor ? "secondary" : "ghost"}
          onClick={handleToggle}
          disabled={togglePending}
          className="h-7 text-[12px]"
        >
          {togglePending
            ? "…"
            : employee.isSupervisor
              ? "Unmark supervisor"
              : "Mark supervisor"}
        </Button>
      </div>
      {toggleError && (
        <p className="text-[11px] text-red-600 text-right">{toggleError}</p>
      )}

      <form
        ref={formRef}
        onSubmit={handlePinSubmit}
        className="flex items-center gap-1.5 flex-wrap justify-end"
      >
        <Input
          name="pin"
          type="password"
          placeholder={employee.hasPin ? "Replace PIN (4-12 digits)" : "Set PIN (4-12 digits)"}
          inputMode="numeric"
          pattern="[0-9]*"
          minLength={4}
          maxLength={12}
          required
          autoComplete="new-password"
          className="h-7 w-48 text-[12px]"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={pinPending}
          className="h-7 text-[12px]"
        >
          {pinPending ? "…" : employee.hasPin ? "Replace" : "Set PIN"}
        </Button>
      </form>
      {pinError && (
        <p className="text-[11px] text-red-600 text-right">{pinError}</p>
      )}
      {pinSuccess && (
        <p className="text-[11px] text-emerald-600 text-right">
          Supervisor PIN updated.
        </p>
      )}
    </div>
  );
}
