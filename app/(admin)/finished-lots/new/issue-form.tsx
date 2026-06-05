"use client";

import { formatDateTimeEst, toDateInputValue } from "@/lib/ui/luma-display";

import * as React from "react";
import { Save, AlertCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createFinishedLotAndRedirect } from "../actions";

type Product = {
  id: string;
  name: string;
  sku: string;
  tabletsPerUnit: number | null;
  defaultShelfLifeDays: number | null;
};

type FinalizedBag = {
  id: string;
  finalizedAt: Date | string | null;
  productId: string | null;
  productName: string | null;
  receiptNumber: string | null;
  masterCases: number | null;
  displaysMade: number | null;
  looseCards: number | null;
  unitsYielded: number | null;
};

// Single-screen issue flow. Pick a bag (or skip), pick a product
// (auto-suggested from the bag), enter the lot number + counts, save.
// Expiry auto-derives from product.defaultShelfLifeDays + producedOn
// the first time the operator picks a product, then becomes manual.

export function IssueLotForm({
  products,
  finalizedBags,
  initialBagId,
}: {
  products: Product[];
  finalizedBags: FinalizedBag[];
  initialBagId?: string | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const initialBag = initialBagId
    ? finalizedBags.find((bag) => bag.id === initialBagId)
    : null;

  const [bagId, setBagId] = React.useState(initialBag?.id ?? "");
  const [productId, setProductId] = React.useState(initialBag?.productId ?? "");
  const [lotNumber, setLotNumber] = React.useState(initialBag?.receiptNumber ?? "");
  const [producedOn, setProducedOn] = React.useState(
    toDateInputValue(initialBag?.finalizedAt) ?? today,
  );
  const [expiryDate, setExpiryDate] = React.useState("");
  const [units, setUnits] = React.useState(initialBag?.unitsYielded ?? 0);
  const [displays, setDisplays] = React.useState(initialBag?.displaysMade ?? 0);
  const [cases, setCases] = React.useState(initialBag?.masterCases ?? 0);
  const [notes, setNotes] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [autoExpiryTouched, setAutoExpiryTouched] = React.useState(false);
  const lastAppliedBagLotRef = React.useRef<string | null>(
    initialBag?.receiptNumber ?? null,
  );
  const selectedBag = bagId ? finalizedBags.find((x) => x.id === bagId) : null;

  // When the bag changes, snap the lot form to the row the admin clicked.
  // The receipt number is the finished-lot number used by the automated path.
  React.useEffect(() => {
    if (!bagId) {
      lastAppliedBagLotRef.current = null;
      return;
    }
    const b = finalizedBags.find((x) => x.id === bagId);
    if (!b) return;
    if (b.productId) setProductId(b.productId);
    const produced = toDateInputValue(b.finalizedAt);
    if (produced) setProducedOn(produced);
    setUnits(b.unitsYielded ?? 0);
    setDisplays(b.displaysMade ?? 0);
    setCases(b.masterCases ?? 0);
    if (
      b.receiptNumber &&
      (!lotNumber || lotNumber === lastAppliedBagLotRef.current)
    ) {
      setLotNumber(b.receiptNumber);
      lastAppliedBagLotRef.current = b.receiptNumber;
    }
    setAutoExpiryTouched(false);
  }, [bagId, finalizedBags]);

  // Auto-expiry: when product or producedOn changes, recompute expiry
  // from defaultShelfLifeDays — but only if the operator hasn't typed
  // a manual value (autoExpiryTouched flag).
  React.useEffect(() => {
    if (autoExpiryTouched) return;
    const p = products.find((x) => x.id === productId);
    if (p?.defaultShelfLifeDays && producedOn) {
      const d = new Date(producedOn);
      d.setDate(d.getDate() + p.defaultShelfLifeDays);
      setExpiryDate(d.toISOString().slice(0, 10));
    }
  }, [productId, producedOn, autoExpiryTouched, products]);

  // Auto-suggest a lot number once a product is picked. Format
  // matches Haute's existing convention: SKU-YYMMDD.
  React.useEffect(() => {
    if (lotNumber) return;
    const p = products.find((x) => x.id === productId);
    if (p?.sku && producedOn) {
      const yymmdd = producedOn.replace(/-/g, "").slice(2);
      setLotNumber(`${p.sku}-${yymmdd}`);
    }
  }, [productId, producedOn, lotNumber, products]);

  return (
    <div className="grid lg:grid-cols-[1fr_280px] gap-5">
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle>Source</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="bagId">Workflow bag (optional)</Label>
              <Select id="bagId" value={bagId} onChange={(e) => setBagId(e.target.value)}>
                <option value="">— skip / manual lot —</option>
                {finalizedBags.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.receiptNumber ? `${b.receiptNumber} · ` : ""}
                    {b.productName ?? "no product"} ·{" "}
                    {b.unitsYielded != null ? `${b.unitsYielded.toLocaleString()} units · ` : ""}
                    {b.finalizedAt ? formatDateTimeEst(b.finalizedAt) : "—"}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] text-text-subtle">
                When set, input batches auto-derive from the bag's consumption events.
              </p>
            </div>
            {selectedBag ? (
              <div className="rounded-lg border border-brand-200 bg-brand-50/50 px-3 py-2 text-xs text-brand-900">
                <div className="font-semibold">Prefilled from selected bag</div>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  <span>Receipt: {selectedBag.receiptNumber ?? "—"}</span>
                  <span>Product: {selectedBag.productName ?? "—"}</span>
                  <span>Cases: {(selectedBag.masterCases ?? 0).toLocaleString()}</span>
                  <span>Displays: {(selectedBag.displaysMade ?? 0).toLocaleString()}</span>
                  <span>Loose: {(selectedBag.looseCards ?? 0).toLocaleString()}</span>
                  <span>Units: {(selectedBag.unitsYielded ?? 0).toLocaleString()}</span>
                </div>
              </div>
            ) : initialBagId ? (
              <div className="rounded-lg border border-warn-300 bg-warn-50 px-3 py-2 text-xs text-warn-800">
                The bag from the review link is no longer awaiting lot issue. Pick another
                bag or create a manual lot.
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="productId">Product</Label>
              <Select
                id="productId"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                required
              >
                <option value="">— pick —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Lot details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lotNumber">Lot number</Label>
                <Input
                  id="lotNumber"
                  value={lotNumber}
                  onChange={(e) => setLotNumber(e.target.value)}
                  placeholder="e.g. ABC-251205"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="producedOn">Produced on</Label>
                <Input
                  id="producedOn"
                  type="date"
                  value={producedOn}
                  onChange={(e) => setProducedOn(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="expiryDate">Expiry</Label>
              <Input
                id="expiryDate"
                type="date"
                value={expiryDate}
                onChange={(e) => {
                  setExpiryDate(e.target.value);
                  setAutoExpiryTouched(true);
                }}
                required
              />
              <p className="text-[11px] text-text-subtle">
                Auto-suggested from product shelf life until you edit it.
              </p>
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Units</Label>
                <Input
                  type="number"
                  min={0}
                  value={units}
                  onChange={(e) => setUnits(Number(e.target.value) || 0)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Displays</Label>
                <Input
                  type="number"
                  min={0}
                  value={displays}
                  onChange={(e) => setDisplays(Number(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Cases</Label>
                <Input
                  type="number"
                  min={0}
                  value={cases}
                  onChange={(e) => setCases(Number(e.target.value) || 0)}
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
                placeholder="QA observations, hold reasons, anything operations should remember."
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3 lg:sticky lg:top-6 self-start">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Lot" value={lotNumber || "—"} mono />
            <Row label="Units" value={units.toLocaleString()} />
            <Row label="Displays" value={displays.toLocaleString()} />
            <Row label="Cases" value={cases.toLocaleString()} />
            <Row
              label="Source"
              value={
                selectedBag
                  ? (selectedBag.receiptNumber ?? `bag ${selectedBag.id.slice(0, 8)}`)
                  : "manual"
              }
            />
            <p className="text-[11px] text-text-subtle pt-2 border-t border-border/60">
              Lot is created in <span className="font-mono">PENDING_QC</span>. Release
              after QA signs off — releasing without QA is the audit trail's job to flag.
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
          disabled={pending || !productId || !lotNumber || !expiryDate}
          onClick={async () => {
            setPending(true);
            setError(null);
            const r = await createFinishedLotAndRedirect({
              productId,
              workflowBagId: bagId || null,
              finishedLotNumber: lotNumber,
              producedOn,
              expiryDate,
              unitsProduced: units,
              displaysProduced: displays || null,
              casesProduced: cases || null,
              notes: notes || null,
            });
            setPending(false);
            if (r?.error) setError(r.error);
          }}
          className="w-full"
        >
          <Save className="h-4 w-4" /> {pending ? "Saving…" : "Issue lot"}
        </Button>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-muted text-xs uppercase tracking-wider">{label}</span>
      <span className={`font-semibold tabular-nums${mono ? " font-mono text-xs" : ""}`}>
        {value}
      </span>
    </div>
  );
}
