"use client";

import * as React from "react";
import { X } from "lucide-react";
import type { PackagingMaterial } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { savePackagingMaterialAction } from "./actions";

const KINDS = [
  ["BLISTER_FOIL", "Blister foil"],
  ["HEAT_SEAL_FILM", "Heat-seal film"],
  ["BOTTLE", "Bottle"],
  ["CAP", "Cap"],
  ["INDUCTION_SEAL", "Induction seal"],
  ["LABEL", "Label"],
  ["DESICCANT", "Desiccant"],
  ["COTTON", "Cotton"],
  ["DISPLAY", "Display"],
  ["CASE", "Case"],
  ["INSERT", "Insert"],
  ["OTHER", "Other"],
] as const;

// triggerIcon: JSX node, not component reference. See product-dialog
// for the Next.js 15 / digest 3173940408 explanation.
export function PackagingDialog({
  row,
  triggerLabel,
  triggerIcon,
}: {
  row?: PackagingMaterial;
  triggerLabel: string;
  triggerIcon?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const isEdit = !!row;

  return (
    <>
      <Button
        type="button"
        variant={isEdit ? "ghost" : "primary"}
        size={isEdit ? "sm" : "md"}
        onClick={() => setOpen(true)}
      >
        {triggerIcon}
        {triggerLabel}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onClick={() => !pending && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-surface shadow-xl border border-border"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
              <h3 className="text-sm font-semibold tracking-tight">
                {isEdit ? "Edit packaging material" : "New packaging material"}
              </h3>
              <button
                type="button"
                aria-label="Close"
                onClick={() => !pending && setOpen(false)}
                className="text-text-subtle hover:text-text"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form
              action={async (form) => {
                setPending(true);
                setError(null);
                const r = await savePackagingMaterialAction(form);
                setPending(false);
                if (r?.error) setError(r.error);
                else setOpen(false);
              }}
              className="p-5 space-y-4"
            >
              {row?.id && <input type="hidden" name="id" value={row.id} />}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sku">SKU</Label>
                  <Input id="sku" name="sku" defaultValue={row?.sku ?? ""} required autoFocus />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="kind">Kind</Label>
                  <Select id="kind" name="kind" defaultValue={row?.kind ?? "BOTTLE"}>
                    {KINDS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" defaultValue={row?.name ?? ""} required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="uom">UoM</Label>
                  <Input id="uom" name="uom" defaultValue={row?.uom ?? "each"} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="parLevel">Par level</Label>
                  <Input
                    id="parLevel"
                    name="parLevel"
                    type="number"
                    min={0}
                    defaultValue={row?.parLevel ?? ""}
                    placeholder="alert below"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="zohoItemId">Zoho item ID</Label>
                <Input id="zohoItemId" name="zohoItemId" defaultValue={row?.zohoItemId ?? ""} placeholder="optional" />
              </div>
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={row?.isActive ?? true}
                  className="h-4 w-4 rounded border-border accent-brand-700"
                />
                Active
              </label>
              {error && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={() => !pending && setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "Saving…" : isEdit ? "Save" : "Create"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
