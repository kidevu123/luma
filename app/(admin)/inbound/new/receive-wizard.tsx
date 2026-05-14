"use client";

import * as React from "react";
import { Plus, Trash2, Save, AlertCircle } from "lucide-react";
import type { TabletType, PurchaseOrder } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createReceiveAndRedirect } from "../actions";

// One-page wizard. We rejected a multi-step flow because every intake
// is essentially one operator's working memory dumped into a form;
// breaking it across pages just doubles the keystrokes. Workflow
// streamline: one screen, sane defaults, autocompute totals as you
// go, save -> server commits the receive + boxes + bags + batches in
// one transaction and redirects to the detail.

type Box = {
  uid: string;
  boxNumber: number;
  tabletTypeId: string;
  batchNumber: string;
  vendorLotNumber: string;
  manufacturedAt: string;
  expiryDate: string;
  bagCount: number;
  pillCountPerBag: number;
};

function blankBox(boxNumber: number, tabletTypeId: string): Box {
  return {
    uid: crypto.randomUUID(),
    boxNumber,
    tabletTypeId,
    batchNumber: "",
    vendorLotNumber: "",
    manufacturedAt: "",
    expiryDate: "",
    bagCount: 4,
    pillCountPerBag: 0,
  };
}

export function ReceiveWizard({
  tabletTypes,
  purchaseOrders,
}: {
  tabletTypes: TabletType[];
  purchaseOrders: PurchaseOrder[];
}) {
  const [poId, setPoId] = React.useState("");
  const [receiveName, setReceiveName] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const defaultTabletType = tabletTypes[0]?.id ?? "";
  const [boxes, setBoxes] = React.useState<Box[]>([blankBox(1, defaultTabletType)]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Auto-suggest a receive name like "PO123-R1" once a PO is picked.
    if (!receiveName && poId) {
      const po = purchaseOrders.find((p) => p.id === poId);
      if (po) setReceiveName(`${po.poNumber}-R1`);
    }
  }, [poId, purchaseOrders, receiveName]);

  function addBox() {
    setBoxes((arr) => [
      ...arr,
      blankBox(arr.length > 0 ? arr[arr.length - 1]!.boxNumber + 1 : 1, defaultTabletType),
    ]);
  }
  function removeBox(uid: string) {
    setBoxes((arr) => arr.filter((b) => b.uid !== uid));
  }
  function patchBox(uid: string, patch: Partial<Box>) {
    setBoxes((arr) => arr.map((b) => (b.uid === uid ? { ...b, ...patch } : b)));
  }

  const totalBags = boxes.reduce((s, b) => s + Number(b.bagCount || 0), 0);
  const totalPills = boxes.reduce(
    (s, b) => s + Number(b.bagCount || 0) * Number(b.pillCountPerBag || 0),
    0,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="New receive"
        description="One screen, one save. Boxes auto-create their batches. Bags auto-generate from box × bag count."
      />

      <div className="grid lg:grid-cols-[1fr_280px] gap-5">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Receive header</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="poId">Purchase order</Label>
                  <Select id="poId" value={poId} onChange={(e) => setPoId(e.target.value)}>
                    <option value="">— none —</option>
                    {purchaseOrders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.poNumber}
                        {p.vendorName ? ` · ${p.vendorName}` : ""}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="receiveName">Receive name</Label>
                  <Input
                    id="receiveName"
                    value={receiveName}
                    onChange={(e) => setReceiveName(e.target.value)}
                    placeholder="PO123-R1"
                    required
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Anything worth remembering — driver, condition, pallet count."
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Boxes</CardTitle>
              <Button size="sm" type="button" onClick={addBox}>
                <Plus className="h-3.5 w-3.5" /> Add box
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {boxes.length === 0 ? (
                <p className="text-sm text-text-muted">No boxes yet. Add one to begin.</p>
              ) : (
                boxes.map((b, i) => (
                  <div
                    key={b.uid}
                    className="rounded-lg border border-border/70 bg-surface-2/30 p-3 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
                        Box #{b.boxNumber}
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() => removeBox(b.uid)}
                        disabled={boxes.length === 1}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="grid sm:grid-cols-3 gap-3">
                      <div className="space-y-1.5">
                        <Label>Tablet type</Label>
                        <Select
                          value={b.tabletTypeId}
                          onChange={(e) => patchBox(b.uid, { tabletTypeId: e.target.value })}
                          required
                        >
                          <option value="">— pick —</option>
                          {tabletTypes.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Batch number</Label>
                        <Input
                          value={b.batchNumber}
                          onChange={(e) => patchBox(b.uid, { batchNumber: e.target.value })}
                          placeholder="e.g. 25-A312"
                          required
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Vendor lot</Label>
                        <Input
                          value={b.vendorLotNumber}
                          onChange={(e) => patchBox(b.uid, { vendorLotNumber: e.target.value })}
                          placeholder="optional"
                        />
                      </div>
                    </div>
                    <div className="grid sm:grid-cols-4 gap-3">
                      <div className="space-y-1.5">
                        <Label>Manufactured</Label>
                        <Input
                          type="date"
                          value={b.manufacturedAt}
                          onChange={(e) => patchBox(b.uid, { manufacturedAt: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Expiry</Label>
                        <Input
                          type="date"
                          value={b.expiryDate}
                          onChange={(e) => patchBox(b.uid, { expiryDate: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Bags in box</Label>
                        <Input
                          type="number"
                          min={1}
                          max={500}
                          value={b.bagCount}
                          onChange={(e) =>
                            patchBox(b.uid, { bagCount: Number(e.target.value) || 0 })
                          }
                          required
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Pills / bag</Label>
                        <Input
                          type="number"
                          min={0}
                          value={b.pillCountPerBag}
                          onChange={(e) =>
                            patchBox(b.uid, { pillCountPerBag: Number(e.target.value) || 0 })
                          }
                          placeholder="e.g. 1000"
                        />
                      </div>
                    </div>
                    <p className="text-[11px] text-text-subtle">
                      {i === 0 && "Box totals derive from bags × pills/bag. "}
                      Subtotal:{" "}
                      <span className="tabular-nums font-medium text-text">
                        {Number(b.bagCount || 0).toLocaleString()} bags ·{" "}
                        {(Number(b.bagCount || 0) * Number(b.pillCountPerBag || 0)).toLocaleString()} pills
                      </span>
                    </p>
                    {receiveName && b.bagCount > 0 && (
                      <p className="text-[10px] text-text-subtle italic">
                        Each bag will be issued an internal receipt
                        number like{" "}
                        <span className="font-mono text-text">
                          {receiveName}-B{b.boxNumber}-1
                        </span>{" "}
                        and a Luma raw-bag QR (BAG-prefix). The vendor's
                        own barcode on the bag sticker stays untouched.
                        Declared pill count = pills/bag.
                      </p>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3 lg:sticky lg:top-6 self-start">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Boxes" value={boxes.length.toString()} />
              <Row label="Bags" value={totalBags.toLocaleString()} />
              <Row label="Pills (estimated)" value={totalPills.toLocaleString()} />
              <Row
                label="New batches"
                value={
                  new Set(
                    boxes
                      .filter((b) => b.batchNumber.trim() !== "")
                      .map((b) => `${b.tabletTypeId}|${b.batchNumber}`),
                  ).size.toString()
                }
              />
              <p className="text-[11px] text-text-subtle">
                New batches are created in <span className="font-mono">QUARANTINE</span>.
                Release them after QA receives the COA.
              </p>
            </CardContent>
          </Card>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button
            size="lg"
            disabled={pending || boxes.length === 0 || !receiveName}
            onClick={async () => {
              setPending(true);
              setError(null);
              const r = await createReceiveAndRedirect({
                poId: poId || null,
                receiveName,
                notes: notes || null,
                boxes: boxes.map((b) => ({
                  boxNumber: b.boxNumber,
                  tabletTypeId: b.tabletTypeId,
                  batchNumber: b.batchNumber,
                  vendorLotNumber: b.vendorLotNumber || null,
                  manufacturedAt: b.manufacturedAt || null,
                  expiryDate: b.expiryDate || null,
                  bagCount: Number(b.bagCount) || 0,
                  pillCountPerBag: Number(b.pillCountPerBag) || null,
                })),
              });
              setPending(false);
              if (r?.error) setError(r.error);
            }}
            className="w-full"
          >
            <Save className="h-4 w-4" /> {pending ? "Saving…" : "Save receive"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-muted text-xs uppercase tracking-wider">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
