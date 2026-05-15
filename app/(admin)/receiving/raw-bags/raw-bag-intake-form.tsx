"use client";

// INTAKE-WORKFLOW-1 — one-screen raw-bag intake form.

import * as React from "react";
import {
  Inbox,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Search,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  ProductionAlertCard,
  ProductionSection,
} from "@/components/production/ui";
import {
  computeReceivedTotal,
  computeVariance,
  derivePoVerificationStatus,
  generateBagRowSeed,
  type RawBagRowSeed,
  type VarianceVerdict,
  verificationStatusLabel,
} from "@/lib/production/raw-bag-intake";
import type { ZohoReadiness } from "@/lib/integrations/zoho/gateway";
import {
  createRawBagIntakeAction,
  lookupRawBagAction,
} from "./actions";

type PO = { id: string; poNumber: string; vendorName: string | null; status: string };
type PoLine = {
  id: string;
  poId: string;
  tabletTypeId: string | null;
  qtyOrdered: number;
  zohoLineItemId: string | null;
};
type TabletType = { id: string; sku: string | null; name: string };

type PoMode = "LOCAL_PO" | "MANUAL_REFERENCE";

export function RawBagIntakeForm({
  purchaseOrders,
  poLines,
  tabletTypes,
  zohoReadiness,
}: {
  purchaseOrders: PO[];
  poLines: PoLine[];
  tabletTypes: TabletType[];
  zohoReadiness: ZohoReadiness;
}) {
  const [poMode, setPoMode] = React.useState<PoMode>(
    purchaseOrders.length > 0 ? "LOCAL_PO" : "MANUAL_REFERENCE",
  );
  const [poId, setPoId] = React.useState<string>("");
  const [poLineId, setPoLineId] = React.useState<string>("");
  const [poNumberManual, setPoNumberManual] = React.useState("");
  const [vendorNameManual, setVendorNameManual] = React.useState("");
  const [orderedQuantityManual, setOrderedQuantityManual] = React.useState<string>("");
  const [tabletTypeId, setTabletTypeId] = React.useState<string>(
    tabletTypes[0]?.id ?? "",
  );

  const [supplierLot, setSupplierLot] = React.useState("");
  const [numberOfBags, setNumberOfBags] = React.useState<string>("10");
  const [declaredPerBag, setDeclaredPerBag] = React.useState<string>("");
  const [weightPerBag, setWeightPerBag] = React.useState<string>("");
  const [receiptStart, setReceiptStart] = React.useState<string>("");
  const [receiptPrefix, setReceiptPrefix] = React.useState<string>("");

  const [rows, setRows] = React.useState<RawBagRowSeed[]>([]);
  const [pending, setPending] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  type Result = Awaited<ReturnType<typeof createRawBagIntakeAction>>;
  const [result, setResult] = React.useState<Result | null>(null);

  const selectedPo = React.useMemo(
    () => purchaseOrders.find((p) => p.id === poId) ?? null,
    [purchaseOrders, poId],
  );
  const availableLines = React.useMemo(
    () => poLines.filter((l) => l.poId === poId),
    [poLines, poId],
  );
  const selectedPoLine = React.useMemo(
    () => availableLines.find((l) => l.id === poLineId) ?? null,
    [availableLines, poLineId],
  );

  // Auto-select tablet type from PO line when one is picked.
  React.useEffect(() => {
    if (selectedPoLine?.tabletTypeId) {
      setTabletTypeId(selectedPoLine.tabletTypeId);
    }
  }, [selectedPoLine]);

  const orderedQuantity = React.useMemo<number | null>(() => {
    if (poMode === "LOCAL_PO") {
      return selectedPoLine?.qtyOrdered ?? null;
    }
    const n = Number.parseInt(orderedQuantityManual, 10);
    return Number.isFinite(n) ? n : null;
  }, [poMode, selectedPoLine, orderedQuantityManual]);

  const verificationStatus = derivePoVerificationStatus({
    localPoFound: poMode === "LOCAL_PO" && selectedPo != null,
    zohoCachedPoFound: false, // ZOHO-3 will flip this once cached invoices land
    productMappingResolved: tabletTypeId.length > 0,
    manualOverride: poMode === "MANUAL_REFERENCE",
  });

  const variance: VarianceVerdict = React.useMemo(
    () => computeVariance({ rows, orderedQuantity }),
    [rows, orderedQuantity],
  );

  function handleGenerateRows() {
    const count = Number.parseInt(numberOfBags, 10);
    const declared = declaredPerBag ? Number.parseInt(declaredPerBag, 10) : null;
    const weight = weightPerBag ? Number.parseInt(weightPerBag, 10) : null;
    const seed = generateBagRowSeed({
      count: Number.isFinite(count) ? count : 0,
      receiptStart: receiptStart.trim(),
      receiptPrefix: receiptPrefix.trim() || null,
      declaredCount: declared,
      weightGrams: weight,
    });
    setRows(seed);
    setErrorMessage(null);
  }

  function patchRow(index: number, patch: Partial<RawBagRowSeed>) {
    setRows((prev) => {
      const next = [...prev];
      const cur = next[index];
      if (!cur) return prev;
      next[index] = { ...cur, ...patch };
      return next;
    });
  }

  async function handleSave() {
    setPending(true);
    setErrorMessage(null);
    setResult(null);
    const payload = {
      poMode,
      poId: poMode === "LOCAL_PO" ? poId || null : null,
      poLineId: poMode === "LOCAL_PO" && poLineId ? poLineId : null,
      poNumberManual: poMode === "MANUAL_REFERENCE" ? poNumberManual.trim() : null,
      vendorNameManual: poMode === "MANUAL_REFERENCE" ? vendorNameManual.trim() : null,
      orderedQuantity:
        poMode === "MANUAL_REFERENCE"
          ? orderedQuantity
          : null,
      tabletTypeId,
      supplierLotNumber: supplierLot.trim(),
      notes: null,
      rows: rows.map((r) => ({
        bagSequence: r.bagSequence,
        receiptNumber: r.receiptNumber.trim(),
        bagQrCode: r.bagQrCode?.trim() || null,
        declaredCount: r.declaredCount,
        weightGrams: r.weightGrams,
        notes: r.notes,
      })),
    };
    const r = await createRawBagIntakeAction(payload);
    setPending(false);
    if (!r.ok) {
      setErrorMessage(r.error);
    } else {
      setResult(r);
    }
  }

  const receivedTotal = computeReceivedTotal(rows);

  if (result?.ok) {
    return <SaveResultPanel result={result} />;
  }

  return (
    <div className="space-y-5">
      {/* SECTION 1 — PO / VENDOR CONTEXT */}
      <ProductionSection
        title="1. PO / vendor context"
        subtitle={verificationStatusLabel(verificationStatus)}
        tone={
          verificationStatus === "VERIFIED_LOCAL" || verificationStatus === "VERIFIED_ZOHO"
            ? "GOOD"
            : verificationStatus === "MANUAL_REFERENCE"
              ? "WARN"
              : "CRITICAL"
        }
      >
        <div className="flex gap-2 mb-3 text-sm">
          <button
            type="button"
            onClick={() => setPoMode("LOCAL_PO")}
            className={`px-3 py-1.5 rounded border ${poMode === "LOCAL_PO" ? "bg-brand-50 border-brand-300 text-brand-800" : "border-border text-text-muted hover:bg-surface-2"}`}
          >
            Pick from local POs ({purchaseOrders.length})
          </button>
          <button
            type="button"
            onClick={() => setPoMode("MANUAL_REFERENCE")}
            className={`px-3 py-1.5 rounded border ${poMode === "MANUAL_REFERENCE" ? "bg-brand-50 border-brand-300 text-brand-800" : "border-border text-text-muted hover:bg-surface-2"}`}
          >
            Manual PO reference
          </button>
        </div>

        {poMode === "LOCAL_PO" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="poId">Purchase order</Label>
              <Select id="poId" value={poId} onChange={(e) => setPoId(e.target.value)}>
                <option value="">— Select PO —</option>
                {purchaseOrders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.poNumber} — {p.vendorName ?? "no vendor"}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="poLineId">PO line / ordered item</Label>
              <Select
                id="poLineId"
                value={poLineId}
                onChange={(e) => setPoLineId(e.target.value)}
                disabled={!poId}
              >
                <option value="">— Select PO line —</option>
                {availableLines.map((l) => {
                  const tt = tabletTypes.find((t) => t.id === l.tabletTypeId);
                  return (
                    <option key={l.id} value={l.id}>
                      {tt?.name ?? "(unknown product)"} — qty {l.qtyOrdered.toLocaleString()}
                    </option>
                  );
                })}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Vendor</Label>
              <div className="text-sm font-mono px-2 py-1.5 rounded border border-border bg-surface">
                {selectedPo?.vendorName ?? "—"}
              </div>
            </div>
            <div className="space-y-1">
              <Label>Ordered quantity</Label>
              <div className="text-sm font-mono px-2 py-1.5 rounded border border-border bg-surface">
                {selectedPoLine?.qtyOrdered != null
                  ? selectedPoLine.qtyOrdered.toLocaleString()
                  : "—"}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="poNumberManual">PO number *</Label>
              <Input
                id="poNumberManual"
                value={poNumberManual}
                onChange={(e) => setPoNumberManual(e.target.value)}
                placeholder="e.g. QA-PO-1234"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="vendorNameManual">Vendor *</Label>
              <Input
                id="vendorNameManual"
                value={vendorNameManual}
                onChange={(e) => setVendorNameManual(e.target.value)}
                placeholder="e.g. Vendor X"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="orderedQuantityManual">Ordered quantity (optional)</Label>
              <Input
                id="orderedQuantityManual"
                type="number"
                min={0}
                value={orderedQuantityManual}
                onChange={(e) => setOrderedQuantityManual(e.target.value)}
                placeholder="e.g. 200000"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tabletTypeIdManual">Product (tablet type) *</Label>
              <Select
                id="tabletTypeIdManual"
                value={tabletTypeId}
                onChange={(e) => setTabletTypeId(e.target.value)}
              >
                <option value="">— Select product —</option>
                {tabletTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} {t.sku ? `(${t.sku})` : ""}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        )}
      </ProductionSection>

      {/* SECTION 2 — SUPPLIER LOT SETUP */}
      <ProductionSection
        title="2. Supplier lot setup"
        subtitle="Captures the manufacturer-printed lot number + bag count + per-bag declared count."
        tone="INFO"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label htmlFor="supplierLot">Supplier lot number *</Label>
            <Input
              id="supplierLot"
              value={supplierLot}
              onChange={(e) => setSupplierLot(e.target.value)}
              placeholder="e.g. 1243"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="numberOfBags">Number of bags *</Label>
            <Input
              id="numberOfBags"
              type="number"
              min={1}
              value={numberOfBags}
              onChange={(e) => setNumberOfBags(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="declaredPerBag">Declared count per bag *</Label>
            <Input
              id="declaredPerBag"
              type="number"
              min={1}
              value={declaredPerBag}
              onChange={(e) => setDeclaredPerBag(e.target.value)}
              placeholder="e.g. 20000"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="weightPerBag">Default weight per bag (grams)</Label>
            <Input
              id="weightPerBag"
              type="number"
              min={0}
              value={weightPerBag}
              onChange={(e) => setWeightPerBag(e.target.value)}
              placeholder="optional"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="receiptPrefix">Receipt prefix (optional)</Label>
            <Input
              id="receiptPrefix"
              value={receiptPrefix}
              onChange={(e) => setReceiptPrefix(e.target.value)}
              placeholder="e.g. QA-R"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="receiptStart">Receipt number start *</Label>
            <Input
              id="receiptStart"
              value={receiptStart}
              onChange={(e) => setReceiptStart(e.target.value)}
              placeholder="e.g. 1001 or QA-R1001"
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button type="button" size="sm" onClick={handleGenerateRows}>
            <Inbox className="h-3.5 w-3.5" /> Generate bag rows
          </Button>
        </div>
      </ProductionSection>

      {/* SECTION 3 — BAG ROWS */}
      {rows.length > 0 ? (
        <ProductionSection
          title={`3. Bag rows (${rows.length} generated, ${rows.length} unsaved)`}
          subtitle="Edit any field. Receipt numbers can be overridden. Every row needs a QR before save."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-text-muted bg-surface-2">
                <tr>
                  <th className="text-left px-2 py-1.5">Bag</th>
                  <th className="text-left px-2 py-1.5">QR code</th>
                  <th className="text-left px-2 py-1.5">Receipt #</th>
                  <th className="text-right px-2 py-1.5">Declared</th>
                  <th className="text-right px-2 py-1.5">Weight (g)</th>
                  <th className="text-left px-2 py-1.5">Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.bagSequence} className="border-t border-border/40">
                    <td className="px-2 py-1.5 font-mono text-xs">{r.bagSequence}</td>
                    <td className="px-2 py-1.5">
                      <Input
                        value={r.bagQrCode ?? ""}
                        onChange={(e) => patchRow(i, { bagQrCode: e.target.value })}
                        placeholder="Scan or type QR"
                        className="font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        value={r.receiptNumber}
                        onChange={(e) => patchRow(i, { receiptNumber: e.target.value })}
                        className="font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        type="number"
                        min={1}
                        value={r.declaredCount ?? ""}
                        onChange={(e) =>
                          patchRow(i, {
                            declaredCount: e.target.value
                              ? Number.parseInt(e.target.value, 10)
                              : null,
                          })
                        }
                        className="text-right tabular-nums text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        type="number"
                        min={0}
                        value={r.weightGrams ?? ""}
                        onChange={(e) =>
                          patchRow(i, {
                            weightGrams: e.target.value
                              ? Number.parseInt(e.target.value, 10)
                              : null,
                          })
                        }
                        className="text-right tabular-nums text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        value={r.notes ?? ""}
                        onChange={(e) => patchRow(i, { notes: e.target.value })}
                        className="text-xs"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Variance summary */}
          <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
            <div>
              <span className="text-text-muted">Received total:</span>{" "}
              <span className="font-mono tabular-nums">{receivedTotal.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-text-muted">Ordered:</span>{" "}
              <span className="font-mono tabular-nums">
                {orderedQuantity != null ? orderedQuantity.toLocaleString() : "—"}
              </span>
            </div>
            <div>
              <span className="text-text-muted">Variance:</span>{" "}
              <span
                className={`font-mono tabular-nums ${variance.status === "EXACT" ? "text-emerald-700" : variance.status === "PARTIAL" ? "text-amber-700" : variance.status === "OVER" ? "text-red-700" : "text-text-muted"}`}
              >
                {variance.variance != null ? variance.variance.toLocaleString() : "—"}{" "}
                ({variance.status})
              </span>
            </div>
          </div>

          {variance.status === "PARTIAL" ? (
            <div className="mt-3">
              <ProductionAlertCard
                tone="WARN"
                title="Partial receipt"
                body={`Received ${variance.receivedQuantity.toLocaleString()} of ${variance.orderedQuantity?.toLocaleString()} ordered.`}
              />
            </div>
          ) : null}
          {variance.status === "OVER" ? (
            <div className="mt-3">
              <ProductionAlertCard
                tone="WARN"
                title="Over-receipt"
                body={`Received ${variance.receivedQuantity.toLocaleString()} vs ${variance.orderedQuantity?.toLocaleString()} ordered. Confirm with the supervisor before save.`}
              />
            </div>
          ) : null}

          {errorMessage ? (
            <div className="mt-3 text-sm text-red-700 inline-flex items-center gap-1.5">
              <AlertCircle className="h-4 w-4" /> {errorMessage}
            </div>
          ) : null}

          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={pending || rows.length === 0 || !supplierLot.trim()}
              onClick={handleSave}
            >
              {pending ? "Saving…" : `Save ${rows.length} bags`}
            </Button>
          </div>
        </ProductionSection>
      ) : null}

      <LookupCard />
    </div>
  );
}

function LookupCard() {
  const [value, setValue] = React.useState("");
  const [pending, setPending] = React.useState(false);
  type LookupResult = Awaited<ReturnType<typeof lookupRawBagAction>>;
  const [result, setResult] = React.useState<LookupResult | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick lookup — receipt or bag QR</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. 1004 or BAG-uuid"
            className="font-mono"
          />
          <Button
            type="button"
            size="sm"
            disabled={pending || value.trim().length === 0}
            onClick={async () => {
              setPending(true);
              setResult(null);
              const r = await lookupRawBagAction(value.trim());
              setPending(false);
              setResult(r);
            }}
          >
            <Search className="h-3.5 w-3.5" /> {pending ? "Searching…" : "Look up"}
          </Button>
        </div>
        {result?.found ? (
          <div className="space-y-1 font-mono text-xs">
            <div>
              <span className="text-text-muted">PO:</span> {result.po.poNumber ?? "—"} ·{" "}
              <span className="text-text-muted">Vendor:</span> {result.po.vendorName ?? "—"}
            </div>
            <div>
              <span className="text-text-muted">Product:</span> {result.product.tabletTypeName}
            </div>
            <div>
              <span className="text-text-muted">Supplier lot:</span> {result.supplierLot.batchNumber || "—"}
            </div>
            <div>
              <span className="text-text-muted">Bag:</span> {result.bag.bagSequence} of —{" "}
              <span className="text-text-muted">receipt:</span> {result.bag.internalReceiptNumber ?? "—"} ·{" "}
              <span className="text-text-muted">qr:</span> {result.bag.bagQrCode ?? "—"}
            </div>
            <div>
              <span className="text-text-muted">Declared:</span>{" "}
              {result.bag.declaredCount?.toLocaleString() ?? "—"}
            </div>
            {result.warnings.length > 0 ? (
              <div className="text-amber-700">⚠ {result.warnings.join(" · ")}</div>
            ) : null}
          </div>
        ) : result && !result.found ? (
          <div className="text-text-muted">{result.warnings.join(" · ")}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SaveResultPanel({
  result,
}: {
  result: Extract<Awaited<ReturnType<typeof createRawBagIntakeAction>>, { ok: true }>;
}) {
  return (
    <ProductionSection
      title="Receive saved"
      subtitle={`${result.bagCount} bag${result.bagCount === 1 ? "" : "s"} created · receive ${result.receiveName}`}
      tone="GOOD"
    >
      <div className="space-y-1 text-sm">
        <Row label="PO number" value={result.poNumber} />
        <Row label="Vendor" value={result.vendorName ?? "—"} />
        <Row label="Product" value={result.tabletTypeName} />
        <Row label="Supplier lot" value={result.supplierLotNumber} />
        <Row
          label="Receipt range"
          value={
            result.receiptRange
              ? `${result.receiptRange.first} → ${result.receiptRange.last}`
              : "—"
          }
        />
        <Row
          label="Bags created"
          value={`${result.bagCount} (${result.qrCount} with QR)`}
        />
        <Row
          label="Ordered"
          value={
            result.orderedQuantity != null
              ? result.orderedQuantity.toLocaleString()
              : "—"
          }
        />
        <Row label="Received" value={result.receivedQuantity.toLocaleString()} />
        <Row
          label="Variance"
          value={
            result.variance == null
              ? "—"
              : result.variance === 0
                ? "0 (EXACT)"
                : `${result.variance.toLocaleString()} (${result.variance > 0 ? "OVER" : "PARTIAL"})`
          }
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="secondary">
          <Link href="/recall">
            <Search className="h-3.5 w-3.5" /> Lookup receipt / batch
          </Link>
        </Button>
        <Button asChild size="sm" variant="secondary">
          <Link href="/qr-cards">
            <ArrowRight className="h-3.5 w-3.5" /> Start production
          </Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/receiving/raw-bags">
            <Inbox className="h-3.5 w-3.5" /> Receive another batch
          </Link>
        </Button>
      </div>
    </ProductionSection>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/30 last:border-b-0 py-1">
      <span className="text-text-muted text-xs uppercase tracking-wide">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

// Unused — keeps the icon imports honest with eslint
void CheckCircle2;
void AlertTriangle;
