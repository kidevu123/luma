"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { editBagAction, type EditBagFormData } from "./actions";

export type BagFormData = {
  id: string;
  weightGrams: number | null;
  declaredPillCount: number | null;
  notes: string | null;
  internalReceiptNumber: string | null;
  bagQrCode: string | null;
  batchNumber: string | null;
  isInProduction: boolean;
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

export function BagEditForm({
  receiveId,
  bag,
}: {
  receiveId: string;
  bag: BagFormData;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const origWeightKg =
    bag.weightGrams != null ? (bag.weightGrams / 1000).toFixed(3) : "";

  const origDeclaredPills =
    bag.declaredPillCount != null ? String(bag.declaredPillCount) : "";

  const [weightKg, setWeightKg] = React.useState(origWeightKg);
  const [declaredPillCount, setDeclaredPillCount] = React.useState(origDeclaredPills);
  const [notes, setNotes] = React.useState(bag.notes ?? "");
  const [receiptNumber, setReceiptNumber] = React.useState(
    bag.internalReceiptNumber ?? "",
  );
  const [bagQrCode, setBagQrCode] = React.useState(bag.bagQrCode ?? "");
  const [supplierLot, setSupplierLot] = React.useState(bag.batchNumber ?? "");
  const [editReason, setEditReason] = React.useState("");

  const sensitiveChanged =
    receiptNumber !== (bag.internalReceiptNumber ?? "") ||
    bagQrCode !== (bag.bagQrCode ?? "") ||
    supplierLot !== (bag.batchNumber ?? "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const data: EditBagFormData = {};
      if (weightKg !== origWeightKg) data.weightKg = weightKg;
      if (declaredPillCount !== origDeclaredPills)
        data.declaredPillCount = declaredPillCount;
      if (notes !== (bag.notes ?? "")) data.notes = notes;
      if (receiptNumber !== (bag.internalReceiptNumber ?? ""))
        data.internalReceiptNumber = receiptNumber;
      if (bagQrCode !== (bag.bagQrCode ?? "")) data.bagQrCode = bagQrCode;
      if (supplierLot !== (bag.batchNumber ?? ""))
        data.supplierLotNumber = supplierLot;
      if (editReason) data.editReason = editReason;

      const result = await editBagAction(receiveId, bag.id, data);
      if (result.ok) {
        router.push(`/inbound/${receiveId}`);
      } else {
        setError(result.error);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-lg">
      {bag.isInProduction && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This bag is in production. Only notes can be edited.
        </div>
      )}

      <Field label="Weight (kg)" hint="Enter in kilograms; stored as grams.">
        <Input
          type="number"
          step="0.001"
          min="0"
          value={weightKg}
          onChange={(e) => setWeightKg(e.target.value)}
          onWheel={(e) => (e.target as HTMLInputElement).blur()}
          disabled={bag.isInProduction}
          className="h-8 text-sm font-mono"
        />
      </Field>

      <Field
        label="Declared pill count"
        hint="Intake declaration at receive. Does not change the live working pill count."
      >
        <Input
          type="number"
          step="1"
          min="0"
          value={declaredPillCount}
          onChange={(e) => setDeclaredPillCount(e.target.value)}
          onWheel={(e) => (e.target as HTMLInputElement).blur()}
          disabled={bag.isInProduction}
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

      <Field label="Internal receipt number" hint="Requires edit reason.">
        <Input
          value={receiptNumber}
          onChange={(e) => setReceiptNumber(e.target.value)}
          disabled={bag.isInProduction}
          className="h-8 text-sm font-mono"
        />
      </Field>

      <Field
        label="QR card scan token"
        hint="Enter the scan token of the new card. Requires edit reason. Old intake-reserved card returns to IDLE."
      >
        <Input
          value={bagQrCode}
          onChange={(e) => setBagQrCode(e.target.value)}
          disabled={bag.isInProduction}
          className="h-8 text-sm font-mono"
        />
      </Field>

      <Field
        label="Supplier lot number"
        hint="Changes the batch this bag belongs to. Requires edit reason."
      >
        <Input
          value={supplierLot}
          onChange={(e) => setSupplierLot(e.target.value)}
          disabled={bag.isInProduction}
          className="h-8 text-sm font-mono"
        />
      </Field>

      {sensitiveChanged && !bag.isInProduction && (
        <Field
          label="Edit reason"
          hint="Required — explain why the QR, receipt, or lot changed."
        >
          <Input
            value={editReason}
            onChange={(e) => setEditReason(e.target.value)}
            placeholder="e.g. QR card damaged at intake, wrong lot scanned"
            className="h-8 text-sm"
          />
        </Field>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={saving} size="sm">
          {saving ? "Saving…" : "Save changes"}
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
