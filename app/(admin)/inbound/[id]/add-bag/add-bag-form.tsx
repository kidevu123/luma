"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import {
  addBagAction,
  type AddBagFormData,
} from "./actions";
import { DEFAULT_ADD_BAG_REASON } from "@/lib/receive/add-bag";

export type AddBagBoxOption = {
  id: string;
  boxNumber: number;
  tabletName: string | null;
  batchNumber: string | null;
  totalBags: number;
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-text">{label}</label>
      {hint && <p className="text-[11px] text-text-subtle">{hint}</p>}
      {children}
    </div>
  );
}

export function AddBagForm({
  receiveId,
  receiveName,
  poLabel,
  boxes,
}: {
  receiveId: string;
  receiveName: string;
  poLabel: string | null;
  boxes: AddBagBoxOption[];
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const singleBox = boxes.length === 1;
  const [smallBoxId, setSmallBoxId] = React.useState(singleBox ? boxes[0]!.id : "");
  const [declaredPillCount, setDeclaredPillCount] = React.useState("");
  const [weightKg, setWeightKg] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [internalReceiptNumber, setInternalReceiptNumber] = React.useState("");
  const [bagQrCode, setBagQrCode] = React.useState("");
  const [supplierLotNumber, setSupplierLotNumber] = React.useState("");
  const [addReason, setAddReason] = React.useState(DEFAULT_ADD_BAG_REASON);

  const selectedBox = boxes.find((b) => b.id === smallBoxId) ?? boxes[0];

  React.useEffect(() => {
    if (selectedBox?.batchNumber) {
      setSupplierLotNumber(selectedBox.batchNumber);
    }
  }, [smallBoxId, selectedBox?.batchNumber]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const data: AddBagFormData = {
        addReason,
        notes,
        internalReceiptNumber,
        bagQrCode,
        supplierLotNumber,
      };
      if (!singleBox) data.smallBoxId = smallBoxId;
      if (declaredPillCount.trim()) data.declaredPillCount = declaredPillCount;
      if (weightKg.trim()) data.weightKg = weightKg;

      const result = await addBagAction(receiveId, data);
      if (result.ok) {
        router.push(`/inbound/${receiveId}`);
        router.refresh();
      } else {
        setError(result.error);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-lg">
      <div className="rounded-md border border-border/60 bg-surface-2 px-4 py-3 text-sm space-y-1">
        <div className="font-medium">{receiveName}</div>
        {poLabel && <div className="text-text-muted text-xs">{poLabel}</div>}
        <p className="text-xs text-text-muted pt-1">
          Adds a new bag under this receive. Existing bags are not changed.
        </p>
      </div>

      {!singleBox && (
        <Field
          label="Box"
          hint="Required when this receive has more than one box."
        >
          <Select
            value={smallBoxId}
            onChange={(e) => setSmallBoxId(e.target.value)}
            required
            className="h-8 text-sm"
          >
            <option value="">— Select box —</option>
            {boxes.map((box) => (
              <option key={box.id} value={box.id}>
                Box #{box.boxNumber}
                {box.tabletName ? ` · ${box.tabletName}` : ""}
                {box.batchNumber ? ` · lot ${box.batchNumber}` : ""}
                {` · ${box.totalBags} bag${box.totalBags === 1 ? "" : "s"}`}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {singleBox && selectedBox && (
        <Field label="Inherited context">
          <p className="text-sm text-text-muted">
            Box #{selectedBox.boxNumber}
            {selectedBox.tabletName ? ` · ${selectedBox.tabletName}` : ""}
            {selectedBox.batchNumber ? ` · lot ${selectedBox.batchNumber}` : ""}
          </p>
        </Field>
      )}

      <Field
        label="Declared pill count"
        hint="Optional. Updates batch quantity totals when set."
      >
        <Input
          type="number"
          step="1"
          min="0"
          value={declaredPillCount}
          onChange={(e) => setDeclaredPillCount(e.target.value)}
          onWheel={(e) => (e.target as HTMLInputElement).blur()}
          className="h-8 text-sm font-mono"
        />
      </Field>

      <Field label="Weight (kg)">
        <Input
          type="number"
          step="0.001"
          min="0"
          value={weightKg}
          onChange={(e) => setWeightKg(e.target.value)}
          onWheel={(e) => (e.target as HTMLInputElement).blur()}
          className="h-8 text-sm font-mono"
        />
      </Field>

      <Field
        label="Internal receipt number"
        hint="Leave blank to auto-generate from receive name + box + bag number."
      >
        <Input
          value={internalReceiptNumber}
          onChange={(e) => setInternalReceiptNumber(e.target.value)}
          className="h-8 text-sm font-mono"
        />
      </Field>

      <Field
        label="QR card scan token"
        hint="Optional. Leave blank to auto-generate a BAG- QR payload."
      >
        <Input
          value={bagQrCode}
          onChange={(e) => setBagQrCode(e.target.value)}
          className="h-8 text-sm font-mono"
        />
      </Field>

      <Field
        label="Supplier lot number"
        hint="Defaults to the box batch. Change only if this bag differs."
      >
        <Input
          value={supplierLotNumber}
          onChange={(e) => setSupplierLotNumber(e.target.value)}
          className="h-8 text-sm font-mono"
        />
      </Field>

      <Field label="Notes">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </Field>

      <Field
        label="Add reason"
        hint="Required — explains why a bag was added after the original receive."
      >
        <Input
          value={addReason}
          onChange={(e) => setAddReason(e.target.value)}
          required
          className="h-8 text-sm"
        />
      </Field>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={saving} size="sm">
          {saving ? "Adding…" : "Add bag"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => router.push(`/inbound/${receiveId}`)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
