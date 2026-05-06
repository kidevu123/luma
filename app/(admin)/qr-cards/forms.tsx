"use client";

import * as React from "react";
import { Plus, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { createQrCardAction, retireQrCardAction } from "./actions";

export function CreateCardForm() {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      action={async (fd) => {
        setPending(true);
        setError(null);
        const r = await createQrCardAction(fd);
        setPending(false);
        if (r?.error) setError(r.error);
        else formRef.current?.reset();
      }}
      className="flex items-end gap-2 flex-wrap"
    >
      <div className="flex-1 min-w-[200px] space-y-1">
        <Label htmlFor="label">New card label</Label>
        <Input
          id="label"
          name="label"
          placeholder="e.g. Card #6"
          required
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending}>
        <Plus className="h-4 w-4" /> {pending ? "Adding…" : "Add card"}
      </Button>
      {error && <p className="text-xs text-red-700 w-full">{error}</p>}
    </form>
  );
}

export function RetireButton({
  id,
  disabled,
}: {
  id: string;
  disabled?: boolean;
}) {
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      type="button"
      disabled={pending || disabled}
      title={disabled ? "Card is mid-bag — finalize first" : "Retire this card"}
      onClick={async () => {
        if (!confirm("Retire this card? It can't accept new scans after.")) return;
        setPending(true);
        await retireQrCardAction(id);
        setPending(false);
      }}
    >
      <Archive className="h-3.5 w-3.5" /> {pending ? "…" : "Retire"}
    </Button>
  );
}
