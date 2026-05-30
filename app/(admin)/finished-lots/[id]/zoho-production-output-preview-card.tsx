"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Eye, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  previewZohoProductionOutputAction,
  type ProductionOutputPreviewActionResult,
} from "./zoho-production-output-preview-actions";
import type { ZohoProductionOutputPreviewMetadata } from "@/lib/db/queries/zoho-production-output";

export function ZohoProductionOutputPreviewCard({
  finishedLotId,
  defaultWarehouseId,
  persistedPreview,
}: {
  finishedLotId: string;
  defaultWarehouseId: string;
  persistedPreview: ZohoProductionOutputPreviewMetadata | null;
}) {
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] =
    React.useState<ProductionOutputPreviewActionResult | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setResult(null);
    startTransition(async () => {
      const response = await previewZohoProductionOutputAction({
        finishedLotId,
        purchaseorderId: String(formData.get("purchaseorder_id") ?? ""),
        purchaseorderLineItemId: String(
          formData.get("purchaseorder_line_item_id") ?? "",
        ),
        warehouseId: String(formData.get("warehouse_id") ?? ""),
        notes: String(formData.get("notes") ?? ""),
      });
      setResult(response);
    });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-text-subtle" />
          Zoho production output preview
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-info-300/60 bg-info-50 px-3 py-2 text-xs text-info-800">
          Preview only — no Zoho write performed. This checks the exact PO line,
          warehouse, and item mapping before live production-output writes
          exist.
        </div>

        {persistedPreview && (
          <PersistedPreviewMetadata metadata={persistedPreview} />
        )}

        <form className="grid gap-3 md:grid-cols-2" onSubmit={handleSubmit}>
          <Field label="Zoho purchaseorder_id" htmlFor="purchaseorder_id">
            <input
              id="purchaseorder_id"
              name="purchaseorder_id"
              required
              maxLength={120}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="Zoho PO ID"
            />
          </Field>
          <Field
            label="Zoho purchaseorder_line_item_id"
            htmlFor="purchaseorder_line_item_id"
          >
            <input
              id="purchaseorder_line_item_id"
              name="purchaseorder_line_item_id"
              required
              maxLength={120}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="Zoho PO line item ID"
            />
          </Field>
          <Field label="Warehouse ID" htmlFor="warehouse_id">
            <input
              id="warehouse_id"
              name="warehouse_id"
              defaultValue={defaultWarehouseId}
              maxLength={120}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="Required if no env default"
            />
          </Field>
          <Field label="Notes" htmlFor="notes">
            <textarea
              id="notes"
              name="notes"
              maxLength={1000}
              rows={2}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
              placeholder="Optional"
            />
          </Field>
          <div className="md:col-span-2 flex items-center gap-3">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Previewing…" : "Run Zoho preview"}
            </Button>
            <span className="text-[11px] text-text-muted">
              Sends one dry-run request only when submitted.
            </span>
          </div>
        </form>

        {result && <PreviewResult result={result} />}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label
      className="space-y-1 text-xs font-medium text-text-muted"
      htmlFor={htmlFor}
    >
      <span>{label}</span>
      {children}
    </label>
  );
}

function PreviewResult({
  result,
}: {
  result: ProductionOutputPreviewActionResult;
}) {
  const statusClass = result.ok
    ? "border-good-300/60 bg-good-50 text-good-800"
    : result.kind === "PAYLOAD_BLOCKED" || result.kind === "SERVICE_ERROR"
      ? "border-warn-300/60 bg-warn-50 text-warn-800"
      : "border-danger-300/60 bg-danger-50 text-danger-800";
  const Icon = result.ok
    ? CheckCircle2
    : result.kind === "SERVICE_ERROR"
      ? AlertTriangle
      : XCircle;

  return (
    <div
      className={`space-y-3 rounded-md border px-3 py-2 text-xs ${statusClass}`}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="space-y-1">
          <p className="font-semibold">
            {result.ok
              ? `Preview returned HTTP ${result.httpStatus}.`
              : result.message}
          </p>
          {result.idempotencyKey && (
            <p className="font-mono text-[10px] opacity-80">
              Idempotency-Key: {result.idempotencyKey}
            </p>
          )}
          {result.idempotencyReplay != null && (
            <p className="font-mono text-[10px] opacity-80">
              Idempotency replay: {String(result.idempotencyReplay)}
            </p>
          )}
          {result.persistedPreview && (
            <p className="font-mono text-[10px] opacity-80">
              Stored snapshot: {result.persistedPreview.status} ·{" "}
              {result.persistedPreview.requestHash}
            </p>
          )}
        </div>
      </div>

      {"payload" in result && result.payload && (
        <JsonBlock
          title="Request summary sent to preview"
          value={result.payload}
        />
      )}

      {!result.ok && result.blockers && result.blockers.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {result.blockers.map((blocker) => (
            <li key={`${blocker.field}:${blocker.message}`}>
              <span className="font-mono">{blocker.field}</span>:{" "}
              {blocker.message}
            </li>
          ))}
        </ul>
      )}

      {"body" in result && result.body != null && (
        <ResponseSummary body={result.body} />
      )}
    </div>
  );
}

function PersistedPreviewMetadata({
  metadata,
}: {
  metadata: ZohoProductionOutputPreviewMetadata;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-2/40 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-text">Persisted preview snapshot</p>
        <span className="rounded border border-border bg-surface px-2 py-0.5 font-mono text-[10px] text-text-muted">
          {metadata.status}
        </span>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        <SummaryRow
          label="last preview"
          value={formatDateTime(metadata.previewedAt)}
        />
        <SummaryRow label="HTTP status" value={metadata.previewHttpStatus} />
        <SummaryRow label="metrics state" value={metadata.metricsState} />
        <SummaryRow label="genealogy state" value={metadata.genealogyState} />
        <SummaryRow label="PO" value={metadata.zohoPurchaseorderId} />
        <SummaryRow
          label="PO line"
          value={metadata.zohoPurchaseorderLineItemId}
        />
        <SummaryRow label="warehouse" value={metadata.zohoWarehouseId} />
        <SummaryRow label="unit item" value={metadata.zohoCompositeItemId} />
      </div>
      <div className="rounded border border-border/70 bg-surface px-2 py-1">
        <span className="text-text-muted">Request hash </span>
        <span className="font-mono text-[10px] text-text">
          {metadata.requestHash}
        </span>
      </div>
    </div>
  );
}

function ResponseSummary({ body }: { body: unknown }) {
  const record = asRecord(body);
  const meta = asRecord(record?.["meta"]);
  const preflight = record?.["preflight"];
  const steps = record?.["steps"];
  const warnings = record?.["warnings"];
  const requestId = meta?.["request_id"];
  const idempotencyReplay =
    record?.["idempotency_replayed"] ?? record?.["idempotency_replay"];

  return (
    <div className="space-y-2">
      {record && (
        <div className="grid gap-1 sm:grid-cols-2">
          <SummaryRow label="preview" value={record["preview"]} />
          <SummaryRow label="request_id" value={requestId} />
          <SummaryRow label="idempotency replay" value={idempotencyReplay} />
          <SummaryRow
            label="warnings"
            value={Array.isArray(warnings) ? warnings.length : undefined}
          />
        </div>
      )}
      {preflight != null && <JsonBlock title="Preflight" value={preflight} />}
      {steps != null && <JsonBlock title="Planned steps" value={steps} />}
      {warnings != null && <JsonBlock title="Warnings" value={warnings} />}
      <JsonBlock title="Raw response" value={body} />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded bg-white/45 px-2 py-1">
      <span className="uppercase tracking-wide opacity-70">{label}</span>
      <span className="font-mono text-[10px]">{formatScalar(value)}</span>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="rounded border border-current/15 bg-white/45 p-2">
      <summary className="cursor-pointer font-semibold">{title}</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatScalar(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function formatDateTime(value: Date | string | null): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}
