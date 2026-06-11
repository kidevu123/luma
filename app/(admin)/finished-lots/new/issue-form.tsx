"use client";

import { formatDateTimeEst, toDateInputValue } from "@/lib/ui/luma-display";

import * as React from "react";
import { Save, AlertCircle } from "lucide-react";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createFinishedLotAndRedirect, issueFinishedLotWithAllocationAndRedirect } from "../actions";
import {
  computeEndingBalanceFromConsumption,
  computeExpectedTabletConsumptionFromProduct,
} from "@/lib/production/expected-tablet-consumption";

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

type AllocationHint = {
  sessionId: string;
  startingBalanceQty: number | null;
  receiptNumber: string | null;
  inventoryBagId: string;
  productSku: string | null;
};

export function IssueLotForm({
  products,
  finalizedBags,
  allocationHints,
  initialBagId,
}: {
  products: Product[];
  finalizedBags: FinalizedBag[];
  allocationHints: Record<string, AllocationHint>;
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
  const [consumedQty, setConsumedQty] = React.useState<number | null>(null);
  const [endingBalanceQty, setEndingBalanceQty] = React.useState<number | null>(null);
  const [repairNotes, setRepairNotes] = React.useState("");
  const [repairStartingBalanceQty, setRepairStartingBalanceQty] = React.useState<
    number | null
  >(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [autoExpiryTouched, setAutoExpiryTouched] = React.useState(false);
  const lastAppliedBagLotRef = React.useRef<string | null>(
    initialBag?.receiptNumber ?? null,
  );
  const selectedBag = bagId ? finalizedBags.find((x) => x.id === bagId) : null;
  const allocationHint = bagId ? allocationHints[bagId] ?? null : null;
  const selectedProduct = products.find((x) => x.id === productId);
  const expectedResult = computeExpectedTabletConsumptionFromProduct(
    selectedProduct?.tabletsPerUnit,
    units,
  );
  const expectedTablets = expectedResult.ok ? expectedResult.expectedConsumed : null;
  const consumptionVariance =
    expectedTablets != null && consumedQty != null
      ? consumedQty - expectedTablets
      : null;
  const isRepairPath = Boolean(selectedBag && !allocationHint);
  const needsRepairStartingBalance =
    isRepairPath && allocationHint == null && repairStartingBalanceQty == null;

  React.useEffect(() => {
    if (!selectedProduct || units <= 0) {
      setConsumedQty(null);
      setEndingBalanceQty(null);
      return;
    }
    const expected = computeExpectedTabletConsumptionFromProduct(
      selectedProduct.tabletsPerUnit,
      units,
    );
    if (!expected.ok) {
      setConsumedQty(null);
      setEndingBalanceQty(null);
      return;
    }
    setConsumedQty(expected.expectedConsumed);
    const start = allocationHint?.startingBalanceQty ?? repairStartingBalanceQty;
    const ending = computeEndingBalanceFromConsumption(
      start,
      expected.expectedConsumed,
    );
    setEndingBalanceQty(ending);
  }, [
    units,
    selectedProduct,
    allocationHint?.startingBalanceQty,
    repairStartingBalanceQty,
  ]);

  React.useEffect(() => {
    const start = allocationHint?.startingBalanceQty ?? repairStartingBalanceQty;
    if (start == null || consumedQty == null) return;
    setEndingBalanceQty(Math.max(0, start - consumedQty));
  }, [consumedQty, allocationHint?.startingBalanceQty, repairStartingBalanceQty]);

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
    setRepairNotes("");
    setRepairStartingBalanceQty(null);
  }, [bagId, finalizedBags]);

  React.useEffect(() => {
    if (autoExpiryTouched) return;
    const p = products.find((x) => x.id === productId);
    if (p?.defaultShelfLifeDays && producedOn) {
      const d = new Date(producedOn);
      d.setDate(d.getDate() + p.defaultShelfLifeDays);
      setExpiryDate(d.toISOString().slice(0, 10));
    }
  }, [productId, producedOn, autoExpiryTouched, products]);

  React.useEffect(() => {
    if (lotNumber) return;
    const p = products.find((x) => x.id === productId);
    if (p?.sku && producedOn) {
      const yymmdd = producedOn.replace(/-/g, "").slice(2);
      setLotNumber(`${p.sku}-${yymmdd}`);
    }
  }, [productId, producedOn, lotNumber, products]);

  const submitLabel = !bagId
    ? "Issue lot"
    : isRepairPath
      ? "Repair allocation and issue lot"
      : "Issue lot and close allocation";

  const canSubmit =
    !pending &&
    Boolean(productId) &&
    Boolean(lotNumber) &&
    Boolean(expiryDate) &&
    (!bagId ||
      (consumedQty != null &&
        consumedQty > 0 &&
        endingBalanceQty != null &&
        endingBalanceQty >= 0 &&
        expectedResult.ok &&
        (!isRepairPath || repairNotes.trim().length >= 8)));

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
                When set, tablet consumption is derived from output counts and product structure.
              </p>
            </div>
            {selectedBag && allocationHint ? (
              <div className="rounded-lg border border-brand-200 bg-brand-50/40 px-3 py-2 text-xs text-brand-900 space-y-1">
                <div className="font-semibold">Raw bag allocation (open)</div>
                <div className="grid gap-1 sm:grid-cols-2">
                  <span>Receipt: {allocationHint.receiptNumber ?? "—"}</span>
                  <span>
                    Starting balance:{" "}
                    {allocationHint.startingBalanceQty?.toLocaleString() ?? "—"} tablets
                  </span>
                </div>
                {expectedTablets != null ? (
                  <p className="text-brand-800/90">
                    Luma calculated expected tablet consumption from finished units and
                    product setup: {expectedTablets.toLocaleString()} tablets
                    {selectedProduct?.tabletsPerUnit
                      ? ` (${selectedProduct.tabletsPerUnit} × ${units} units)`
                      : null}
                    . Confirm only if this run used a different physical quantity.
                  </p>
                ) : null}
              </div>
            ) : selectedBag ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-2">
                <div className="font-semibold">Repair missing source allocation</div>
                <p>
                  Repair required because this run predates automatic allocation sessions.
                  Confirm the source receipt, then close the ledger using Luma&apos;s calculated
                  tablet consumption.
                </p>
                <p>Receipt: {selectedBag.receiptNumber ?? "—"}</p>
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
              {!expectedResult.ok && selectedProduct && units > 0 ? (
                <p className="text-xs text-amber-800">
                  {expectedResult.blocker === "MISSING_TABLETS_PER_UNIT" ? (
                    <>
                      Product tablets-per-unit is missing.{" "}
                      <Link
                        href={`/products/${selectedProduct.id}`}
                        className="underline font-medium"
                      >
                        Configure product structure
                      </Link>{" "}
                      before issuing this lot.
                    </>
                  ) : (
                    expectedResult.message
                  )}
                </p>
              ) : null}
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
            {bagId && expectedResult.ok ? (
              <div className="rounded-lg border border-border/80 bg-surface-2/40 p-3 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {isRepairPath ? "Repair allocation closeout" : "Close allocation"}
                </div>
                {isRepairPath ? (
                  <div className="space-y-3">
                    {needsRepairStartingBalance ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="repairStartingBalanceQty">Starting balance (tablets)</Label>
                        <Input
                          id="repairStartingBalanceQty"
                          type="number"
                          min={1}
                          value={repairStartingBalanceQty ?? ""}
                          onChange={(e) =>
                            setRepairStartingBalanceQty(
                              e.target.value === "" ? null : Number(e.target.value) || null,
                            )
                          }
                          required
                        />
                        <p className="text-[11px] text-text-subtle">
                          Starting balance missing — enter the physical bag count so Luma can
                          close the ledger.
                        </p>
                      </div>
                    ) : null}
                    <div className="space-y-1.5">
                      <Label htmlFor="repairNotes">Repair notes</Label>
                      <Textarea
                        id="repairNotes"
                        rows={2}
                        value={repairNotes}
                        onChange={(e) => setRepairNotes(e.target.value)}
                        placeholder="Why is allocation being repaired? Include receipt and any verified counts."
                        required
                      />
                    </div>
                  </div>
                ) : null}
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="consumedQty">Tablets consumed</Label>
                    <Input
                      id="consumedQty"
                      type="number"
                      min={1}
                      value={consumedQty ?? ""}
                      onChange={(e) =>
                        setConsumedQty(
                          e.target.value === "" ? null : Number(e.target.value) || null,
                        )
                      }
                      required
                    />
                    <p className="text-[11px] text-text-subtle">
                      Calculated from {selectedProduct?.tabletsPerUnit ?? "—"} tabs/unit ×{" "}
                      {units.toLocaleString()} units. Adjust only with a note if physical use
                      differed.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="endingBalanceQty">Ending balance</Label>
                    <Input
                      id="endingBalanceQty"
                      type="number"
                      min={0}
                      value={endingBalanceQty ?? ""}
                      onChange={(e) =>
                        setEndingBalanceQty(
                          e.target.value === "" ? null : Number(e.target.value) || null,
                        )
                      }
                      required
                    />
                  </div>
                </div>
                {consumptionVariance != null && consumptionVariance !== 0 ? (
                  <p className="text-xs text-amber-800">
                    Variance vs expected: {consumptionVariance > 0 ? "+" : ""}
                    {consumptionVariance.toLocaleString()} tablets — add a note explaining
                    the adjustment.
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="QA observations, hold reasons, variance explanations."
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
            {bagId && consumedQty != null ? (
              <>
                <Row label="Consumed" value={consumedQty.toLocaleString()} />
                <Row
                  label="Ending bal."
                  value={
                    endingBalanceQty != null ? endingBalanceQty.toLocaleString() : "—"
                  }
                />
              </>
            ) : null}
            <p className="text-[11px] text-text-subtle pt-2 border-t border-border/60">
              {bagId
                ? isRepairPath
                  ? "Repairs the missing allocation ledger, issues the lot, and closes allocation."
                  : "Issues the lot and closes raw-bag allocation in one step."
                : "Manual lot — no workflow bag linkage."}{" "}
              Status starts as <span className="font-mono">PENDING_QC</span>.
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
          disabled={!canSubmit}
          onClick={async () => {
            setPending(true);
            setError(null);
            const payload = {
              productId,
              workflowBagId: bagId || null,
              finishedLotNumber: lotNumber,
              producedOn,
              expiryDate,
              unitsProduced: units,
              displaysProduced: displays || null,
              casesProduced: cases || null,
              notes: notes || null,
            };
            const r = bagId
              ? await issueFinishedLotWithAllocationAndRedirect({
                  ...payload,
                  workflowBagId: bagId,
                  consumedQty: consumedQty!,
                  endingBalanceQty: endingBalanceQty!,
                  repairMissingAllocation: isRepairPath,
                  repairNotes: isRepairPath ? repairNotes : null,
                  repairStartingBalanceQty: isRepairPath
                    ? repairStartingBalanceQty
                    : null,
                })
              : await createFinishedLotAndRedirect(payload);
            setPending(false);
            if (r?.error) setError(r.error);
          }}
          className="w-full"
        >
          <Save className="h-4 w-4" /> {pending ? "Saving…" : submitLabel}
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
