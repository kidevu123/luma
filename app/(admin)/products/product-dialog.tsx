"use client";

import * as React from "react";
import { X } from "lucide-react";
import type { Product } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { saveProductAction } from "./actions";

type Row = (Product & { allowedCount?: number }) | undefined;

// Note: triggerIcon must be a JSX node (not a component reference).
// Next.js 15 disallows passing function values as props from server
// components to client components — see digest 3173940408. The page
// renders <ProductDialog triggerIcon={<Plus className="h-4 w-4" />} />
// and we render {triggerIcon} directly.
export function ProductDialog({
  row,
  triggerLabel,
  triggerIcon,
}: {
  row?: Row;
  triggerLabel: string;
  triggerIcon?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [kind, setKind] = React.useState<Product["kind"]>(row?.kind ?? "CARD");
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
            className="w-full max-w-lg rounded-2xl bg-surface shadow-xl border border-border"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
              <h3 className="text-sm font-semibold tracking-tight">
                {isEdit ? "Edit product" : "New product"}
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
                const r = await saveProductAction(form);
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
                  <Select
                    id="kind"
                    name="kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as Product["kind"])}
                  >
                    <option value="CARD">Card (blister)</option>
                    <option value="BOTTLE">Bottle</option>
                    <option value="VARIETY">Variety pack</option>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" defaultValue={row?.name ?? ""} required />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="tabletsPerUnit">tabs / unit</Label>
                  <Input
                    id="tabletsPerUnit"
                    name="tabletsPerUnit"
                    type="number"
                    min={0}
                    defaultValue={row?.tabletsPerUnit ?? ""}
                    placeholder={kind === "BOTTLE" ? "60" : "30"}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="unitsPerDisplay">units / display</Label>
                  <Input
                    id="unitsPerDisplay"
                    name="unitsPerDisplay"
                    type="number"
                    min={0}
                    defaultValue={row?.unitsPerDisplay ?? ""}
                    placeholder="12"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="displaysPerCase">displays / case</Label>
                  <Input
                    id="displaysPerCase"
                    name="displaysPerCase"
                    type="number"
                    min={0}
                    defaultValue={row?.displaysPerCase ?? ""}
                    placeholder="6"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="defaultShelfLifeDays">Shelf life (days)</Label>
                  <Input
                    id="defaultShelfLifeDays"
                    name="defaultShelfLifeDays"
                    type="number"
                    min={0}
                    defaultValue={row?.defaultShelfLifeDays ?? ""}
                    placeholder="730"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="zohoItemId">Zoho item ID</Label>
                  <Input
                    id="zohoItemId"
                    name="zohoItemId"
                    defaultValue={row?.zohoItemId ?? ""}
                    placeholder="optional"
                  />
                </div>
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
