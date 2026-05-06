"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import type { TabletType, PackagingMaterial } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createBatchAction } from "./actions";

export function CreateBatchDialog({
  tabletTypes,
  materials,
}: {
  tabletTypes: TabletType[];
  materials: PackagingMaterial[];
}) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [kind, setKind] = React.useState<"TABLET" | "PACKAGING">("TABLET");

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New batch
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
              <h3 className="text-sm font-semibold tracking-tight">New batch</h3>
              <button
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
                try {
                  const r = await createBatchAction(form);
                  if (r?.error) setError(r.error);
                  else setOpen(false);
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : "Save failed.",
                  );
                } finally {
                  setPending(false);
                }
              }}
              className="p-5 space-y-4"
            >
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="kind">Kind</Label>
                  <Select
                    id="kind"
                    name="kind"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as "TABLET" | "PACKAGING")}
                  >
                    <option value="TABLET">Tablet</option>
                    <option value="PACKAGING">Packaging</option>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="batchNumber">Batch number</Label>
                  <Input id="batchNumber" name="batchNumber" required autoFocus />
                </div>
              </div>

              {kind === "TABLET" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="tabletTypeId">Tablet type</Label>
                  <Select id="tabletTypeId" name="tabletTypeId" required>
                    <option value="">— pick —</option>
                    {tabletTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="packagingMaterialId">Packaging material</Label>
                  <Select id="packagingMaterialId" name="packagingMaterialId" required>
                    <option value="">— pick —</option>
                    {materials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vendorName">Vendor</Label>
                  <Input id="vendorName" name="vendorName" placeholder="optional" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vendorLotNumber">Vendor lot #</Label>
                  <Input id="vendorLotNumber" name="vendorLotNumber" placeholder="optional" />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="manufacturedAt">Manufactured</Label>
                  <Input id="manufacturedAt" name="manufacturedAt" type="date" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="expiryDate">Expiry</Label>
                  <Input id="expiryDate" name="expiryDate" type="date" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qtyReceived">Qty received</Label>
                  <Input id="qtyReceived" name="qtyReceived" type="number" min={0} defaultValue={0} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" name="notes" rows={2} placeholder="optional" />
              </div>

              <p className="text-[11px] text-text-subtle">
                New batches are created in <span className="font-mono">QUARANTINE</span>.
                A manager releases them once the COA is on file.
              </p>

              {error && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                  {error}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={() => !pending && setOpen(false)} type="button">
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Create batch"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
