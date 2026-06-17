"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Eye, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  previewZohoProductionOutputAction,
  type ProductionOutputPreviewActionResult,
} from "./zoho-production-output-preview-actions";
import {
  approveZohoProductionOutputAction,
  queueZohoProductionOutputAction,
  voidZohoProductionOutputAction,
  type ApproveZohoProductionOutputResult,
  type QueueZohoProductionOutputResult,
  type VoidZohoProductionOutputResult,
} from "./zoho-production-output-gate-actions";
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
  const [gatePending, startGateTransition] = React.useTransition();
  const [result, setResult] =
    React.useState<ProductionOutputPreviewActionResult | null>(null);
  const [gateResult, setGateResult] = React.useState<
    | ApproveZohoProductionOutputResult
    | QueueZohoProductionOutputResult
    | VoidZohoProductionOutputResult
    | null
  >(null);
  const [voidReason, setVoidReason] = React.useState("");

  const isApproved = persistedPreview?.status === "APPROVED";
  const isQueued = persistedPreview?.status === "QUEUED";
  const isTerminalCommitState =
    persistedPreview?.status === "COMMITTING" ||
    persistedPreview?.status === "COMMITTED" ||
    persistedPreview?.status === "FAILED";
  const canQueue =
    isApproved &&
    persistedPreview.queueEligible === true &&
    !gatePending;
  const canApprove =
    persistedPreview?.status === "PREVIEWED" &&
    persistedPreview.approvalEligible;
  const canVoid =
    persistedPreview != null &&
    persistedPreview.status !== "VOIDED" &&
    !gatePending;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setResult(null);
    setGateResult(null);
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

  function handleApprove() {
    if (!persistedPreview) return;
    setGateResult(null);
    startGateTransition(async () => {
      const response = await approveZohoProductionOutputAction({
        finishedLotId,
        opId: persistedPreview.id,
      });
      setGateResult(response);
    });
  }

  function handleQueue() {
    if (!persistedPreview) return;
    const confirmed = window.confirm(
      "Queue for future Zoho commit?\n\nThis will not write to Zoho yet. It only marks this approved request as queued for a future commit worker.",
    );
    if (!confirmed) return;
    setGateResult(null);
    startGateTransition(async () => {
      const response = await queueZohoProductionOutputAction({
        finishedLotId,
        opId: persistedPreview.id,
      });
      setGateResult(response);
    });
  }

  function handleVoid(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!persistedPreview) return;
    setGateResult(null);
    startGateTransition(async () => {
      const response = await voidZohoProductionOutputAction({
        finishedLotId,
        opId: persistedPreview.id,
        reason: voidReason,
      });
      setGateResult(response);
      if (response.ok) setVoidReason("");
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

        {/* WAREHOUSE-CAPABILITY-v1.4.0 — banner reflects the
            capability resolved during the most recent preview
            attempt. Pre-preview, no banner is shown; the persisted
            metadata block carries the historical capability state
            for any existing PREVIEWED/DRAFT row. */}
        {persistedPreview?.warehouseOmitted && (
          <div
            className="rounded-md border border-info-300/60 bg-info-50 px-3 py-2 text-xs text-info-800"
            data-testid="warehouse-omitted-banner"
          >
            This Zoho org does not use warehouses; warehouse will be omitted.
          </div>
        )}
        {persistedPreview &&
          persistedPreview.warehouseRequired === false &&
          !persistedPreview.warehouseOmitted &&
          persistedPreview.zohoWarehouseId && (
            <div
              className="rounded-md border border-info-300/60 bg-info-50 px-3 py-2 text-xs text-info-800"
              data-testid="warehouse-optional-resolved-banner"
            >
              This Zoho org does not require a warehouse, but a default is
              set ({persistedPreview.zohoWarehouseId}). Clear the warehouse
              field on the form to omit.
            </div>
          )}

        {isApproved && (
          <div className="rounded-md border border-good-300/60 bg-good-50 px-3 py-2 text-xs text-good-800">
            <p className="font-semibold">Approved for future Zoho commit</p>
            <p className="mt-1">
              No Zoho write performed. Mapping and quantities are frozen until
              this operation is voided.
            </p>
          </div>
        )}

        {isQueued && (
          <div className="rounded-md border border-info-300/60 bg-info-50 px-3 py-2 text-xs text-info-800">
            <p className="font-semibold">Queued for future Zoho commit</p>
            <p className="mt-1">
              No Zoho write has been performed yet. Waiting for a future commit
              worker.
            </p>
            {persistedPreview.commitIdempotencyKey && (
              <p className="mt-2 font-mono text-[10px] opacity-90">
                Commit idempotency key: {persistedPreview.commitIdempotencyKey}
              </p>
            )}
            {persistedPreview.commitRequestedAt && (
              <p className="mt-1 text-[11px] opacity-90">
                Queued at {formatDateTime(persistedPreview.commitRequestedAt)}
              </p>
            )}
          </div>
        )}

        {isTerminalCommitState && persistedPreview && (
          <TerminalCommitStateNotice
            status={persistedPreview.status}
            metadata={persistedPreview}
          />
        )}

        {persistedPreview && (
          <PersistedPreviewMetadata metadata={persistedPreview} />
        )}

        {isApproved && (
          <FutureCommitReadiness
            metadata={persistedPreview}
            canQueue={canQueue}
            onQueue={handleQueue}
            queuePending={gatePending}
          />
        )}

        {persistedPreview && (
          <div className="space-y-3 rounded-md border border-border bg-surface-2/40 px-3 py-2 text-xs">
            <p className="font-semibold text-text">Approval and void</p>
            {persistedPreview.status === "PREVIEWED" &&
              !persistedPreview.approvalEligible &&
              persistedPreview.approvalBlockers.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-warn-800">
                  {persistedPreview.approvalBlockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={!canApprove || gatePending}
                onClick={handleApprove}
              >
                <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                {gatePending ? "Saving…" : "Approve for future commit"}
              </Button>
              {!canApprove && persistedPreview.status === "PREVIEWED" && (
                <span className="text-[11px] text-text-muted">
                  Approval blocked until preview data is reviewable.
                </span>
              )}
            </div>
            <form className="space-y-2" onSubmit={handleVoid}>
              <label className="block space-y-1 text-text-muted" htmlFor="void_reason">
                <span>Void reason (required)</span>
                <textarea
                  id="void_reason"
                  name="void_reason"
                  required
                  maxLength={500}
                  rows={2}
                  value={voidReason}
                  onChange={(event) => setVoidReason(event.target.value)}
                  disabled={!canVoid}
                  className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-text"
                  placeholder="Wrong PO line, mapping change, etc."
                />
              </label>
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                disabled={!canVoid || voidReason.trim().length === 0}
              >
                Void operation
              </Button>
            </form>
            {gateResult && <GateResult result={gateResult} />}
          </div>
        )}

        {isApproved || isQueued ? (
          <p className="text-xs text-text-muted">
            Void the operation to change mapping or run a new preview.
          </p>
        ) : (
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
        )}

        {result && <PreviewResult result={result} />}
      </CardContent>
    </Card>
  );
}

function GateResult({
  result,
}: {
  result:
    | ApproveZohoProductionOutputResult
    | QueueZohoProductionOutputResult
    | VoidZohoProductionOutputResult;
}) {
  const className = result.ok
    ? "border-good-300/60 bg-good-50 text-good-800"
    : "border-danger-300/60 bg-danger-50 text-danger-800";
  let successMessage = "Operation voided. You can run a new preview.";
  if (result.ok && "metadata" in result) {
    successMessage =
      result.metadata.status === "QUEUED"
        ? "Queued for future Zoho commit — no Zoho write has been performed yet."
        : `Approved — frozen hash ${result.metadata.approvedRequestHash ?? result.metadata.requestHash}.`;
  }
  return (
    <div className={`rounded-md border px-2 py-1.5 text-xs ${className}`}>
      {result.ok ? successMessage : result.message}
    </div>
  );
}

function TerminalCommitStateNotice({
  status,
  metadata,
}: {
  status: string;
  metadata: ZohoProductionOutputPreviewMetadata;
}) {
  const copy =
    status === "COMMITTED"
      ? "Marked committed (mock/live commit processing is not exposed in the UI yet)."
      : status === "COMMITTING"
        ? "Commit in progress. No operator action is available in this release."
        : "Commit failed. Review audit history; no retry control is shown here yet.";
  return (
    <div className="rounded-md border border-border bg-surface-2/40 px-3 py-2 text-xs text-text-muted">
      <p className="font-semibold text-text">{status}</p>
      <p className="mt-1">{copy}</p>
      {metadata.externalReferenceId && (
        <p className="mt-2 font-mono text-[10px] text-text">
          External reference: {metadata.externalReferenceId}
        </p>
      )}
      {metadata.commitError && (
        <p className="mt-1 text-danger-800">{metadata.commitError}</p>
      )}
    </div>
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
        <StatusChip status={metadata.status} />
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
        <SummaryRow
          label="warehouse"
          value={
            metadata.warehouseOmitted
              ? "(omitted — org has no warehouses)"
              : metadata.zohoWarehouseId
          }
        />
        <SummaryRow label="unit item" value={metadata.zohoCompositeItemId} />
        <SummaryRow
          label="warehouse_required"
          value={
            metadata.warehouseRequired == null
              ? null
              : metadata.warehouseRequired
                ? "true"
                : "false"
          }
        />
        <SummaryRow
          label="capability source"
          value={metadata.capabilitySource}
        />
        {metadata.capabilityGatewayRequestId && (
          <SummaryRow
            label="capability request"
            value={metadata.capabilityGatewayRequestId}
          />
        )}
        {metadata.approvedAt && (
          <SummaryRow
            label="approved at"
            value={formatDateTime(metadata.approvedAt)}
          />
        )}
        {metadata.approvedRequestHash && (
          <SummaryRow
            label="approved hash"
            value={metadata.approvedRequestHash}
          />
        )}
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

function FutureCommitReadiness({
  metadata,
  canQueue,
  onQueue,
  queuePending,
}: {
  metadata: ZohoProductionOutputPreviewMetadata | null;
  canQueue: boolean;
  onQueue: () => void;
  queuePending: boolean;
}) {
  const readiness = metadata?.commitReadiness;
  const blockers =
    readiness?.ready === false
      ? readiness.blockers
      : metadata?.queueBlockers?.length
        ? metadata.queueBlockers.map((message) => ({
            code: "QUEUE_BLOCKED",
            message,
          }))
        : [];
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-2/40 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-text">Future commit readiness</p>
        {readiness?.ready ? (
          <span className="rounded border border-good-300 bg-good-50 px-2 py-0.5 font-mono text-[10px] text-good-800">
            READY
          </span>
        ) : (
          <span className="rounded border border-warn-300 bg-warn-50 px-2 py-0.5 font-mono text-[10px] text-warn-800">
            BLOCKED
          </span>
        )}
      </div>
      <p className="text-text-muted">
        Approved — no Zoho write yet. Queueing only records intent for a future
        worker; it does not call Zoho.
      </p>
      {metadata?.approvedRequestHash && (
        <div className="rounded border border-border/70 bg-surface px-2 py-1">
          <span className="text-text-muted">Approved request hash </span>
          <span className="font-mono text-[10px] text-text">
            {metadata.approvedRequestHash}
          </span>
        </div>
      )}
      {readiness?.ready ? (
        <div className="space-y-2">
          <p className="rounded border border-good-300/60 bg-good-50 px-2 py-1.5 text-good-800">
            Ready for future commit.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={!canQueue || queuePending}
              onClick={onQueue}
            >
              {queuePending ? "Queueing…" : "Queue for future Zoho commit"}
            </Button>
            {!canQueue && metadata?.queueBlockers?.length ? (
              <span className="text-[11px] text-text-muted">
                Queue blocked — resolve blockers below.
              </span>
            ) : null}
          </div>
          <p className="text-[11px] text-text-muted">
            This will not write to Zoho yet. It only marks this approved request
            as queued for a future commit worker.
          </p>
        </div>
      ) : (
        <ul className="list-disc space-y-1 rounded border border-warn-300/60 bg-warn-50 px-4 py-2 text-warn-800">
          {(blockers.length
            ? blockers
            : [
                {
                  code: "CONFIG_MISSING",
                  message:
                    "Commit readiness could not be checked for this snapshot.",
                },
              ]
          ).map((blocker) => (
            <li key={`${blocker.code}:${blocker.message}`}>
              <span className="font-mono">{blocker.code}</span>:{" "}
              {blocker.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "APPROVED"
      ? "border-good-300 bg-good-50 text-good-800"
      : status === "QUEUED"
        ? "border-info-300 bg-info-50 text-info-800"
        : status === "VOIDED"
          ? "border-border bg-surface text-text-muted"
          : status === "PREVIEWED"
            ? "border-info-300 bg-info-50 text-info-800"
            : status === "COMMITTED"
              ? "border-good-300 bg-good-50 text-good-800"
              : status === "FAILED"
                ? "border-danger-300 bg-danger-50 text-danger-800"
                : "border-warn-300 bg-warn-50 text-warn-800";
  return (
    <span
      className={`rounded border px-2 py-0.5 font-mono text-[10px] ${tone}`}
    >
      {status}
    </span>
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
