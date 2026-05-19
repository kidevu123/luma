"use client";

// PT-7D — client-side filter + render of read_material_recommendations.
//
// All rows are fetched server-side by the page. This component only
// applies in-memory filters and renders. Acknowledge / dismiss POST
// to the server actions defined in ./actions.ts.

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import {
  acknowledgeMaterialRecommendationAction,
  dismissMaterialRecommendationAction,
  sendMaterialRecommendationToPackTrackAction,
} from "./actions";
import {
  filterRecommendations,
  type RecommendationRow,
  type RecommendationStatusFilter,
} from "@/lib/production/material-recommendations-filter";
import type {
  ShortageConfidence,
  ShortageSeverity,
} from "@/lib/production/packtrack-shortage";

const SEVERITIES: ShortageSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "WATCH"];
const CONFIDENCES: ShortageConfidence[] = [
  "HIGH",
  "MEDIUM",
  "LOW",
  "MISSING",
];

const SEVERITY_STYLE: Record<ShortageSeverity, string> = {
  CRITICAL: "bg-red-100 text-red-900 border-red-400",
  HIGH: "bg-orange-100 text-orange-900 border-orange-400",
  MEDIUM: "bg-amber-100 text-amber-900 border-amber-400",
  WATCH: "bg-slate-100 text-slate-700 border-slate-300",
};

function formatQty(value: number | null, unit?: string | null): string {
  if (value == null) return "Missing";
  const formatted =
    Math.abs(value) >= 1000
      ? Math.round(value).toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatDate(value: Date | string | null): string {
  if (value == null) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

type ActionStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

/** Pure helper: derive the reason a send button must be disabled for a
 *  given row + config. Returns null when the row is ready to send.
 *  Exported alongside the panel so the action-test can grep its
 *  behavior without having to mount React. */
export function deriveSendBlockReason(
  row: RecommendationRow,
  packtrackConfigured: boolean,
): string | null {
  if (!packtrackConfigured) return "PackTrack handoff not configured";
  if (row.dismissedAt != null) return "Dismissed";
  if (row.acknowledgedAt == null) return "Not acknowledged";
  if (!row.sendableToPackTrack) return "Not sendable";
  if (row.confidence === "MISSING") return "Missing configuration";
  if (
    row.recommendedOrderQuantity == null ||
    row.recommendedOrderQuantity <= 0
  ) {
    return "No recommended quantity";
  }
  return null;
}

function ActionButtons({
  row,
  packtrackConfigured,
}: {
  row: RecommendationRow;
  packtrackConfigured: boolean;
}) {
  const [ackStatus, setAckStatus] = React.useState<ActionStatus>({
    kind: "idle",
  });
  const [dismissOpen, setDismissOpen] = React.useState(false);
  const [dismissReason, setDismissReason] = React.useState("");
  const [dismissNotes, setDismissNotes] = React.useState("");
  const [dismissStatus, setDismissStatus] = React.useState<ActionStatus>({
    kind: "idle",
  });
  const [sendStatus, setSendStatus] = React.useState<ActionStatus>({
    kind: "idle",
  });

  const alreadyAcked = row.acknowledgedAt != null;
  const alreadyDismissed = row.dismissedAt != null;
  const alreadySent = row.sentAt != null;
  const sendBlockReason = deriveSendBlockReason(row, packtrackConfigured);

  async function onAck() {
    setAckStatus({ kind: "pending" });
    const fd = new FormData();
    fd.set("recommendationId", row.id);
    const r = await acknowledgeMaterialRecommendationAction(fd);
    if (r.error) setAckStatus({ kind: "error", message: r.error });
    else setAckStatus({ kind: "ok" });
  }

  async function onDismiss() {
    setDismissStatus({ kind: "pending" });
    const fd = new FormData();
    fd.set("recommendationId", row.id);
    if (dismissReason.trim()) fd.set("reason", dismissReason.trim());
    if (dismissNotes.trim()) fd.set("notes", dismissNotes.trim());
    const r = await dismissMaterialRecommendationAction(fd);
    if (r.error) setDismissStatus({ kind: "error", message: r.error });
    else {
      setDismissStatus({ kind: "ok" });
      setDismissOpen(false);
    }
  }

  async function onSend() {
    setSendStatus({ kind: "pending" });
    const fd = new FormData();
    fd.set("recommendationId", row.id);
    const r = await sendMaterialRecommendationToPackTrackAction(fd);
    if ("error" in r) setSendStatus({ kind: "error", message: r.error });
    else setSendStatus({ kind: "ok" });
  }

  return (
    <div className="flex flex-col gap-1 items-end">
      <div className="flex gap-1">
        {!alreadyAcked && !alreadyDismissed && (
          <button
            type="button"
            onClick={onAck}
            disabled={ackStatus.kind === "pending"}
            className="rounded border border-emerald-400 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
          >
            {ackStatus.kind === "pending" ? "…" : "Acknowledge"}
          </button>
        )}
        {!alreadyDismissed && (
          <button
            type="button"
            onClick={() => setDismissOpen((v) => !v)}
            className="rounded border border-slate-400 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
          >
            Dismiss
          </button>
        )}
        {sendBlockReason == null && !alreadySent && (
          <button
            type="button"
            onClick={onSend}
            disabled={sendStatus.kind === "pending"}
            title="Sending creates a recommendation in PackTrack for owner approval. Luma does not create a PO."
            className="rounded border border-indigo-500 bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-900 hover:bg-indigo-100 disabled:opacity-50"
          >
            {sendStatus.kind === "pending" ? "…" : "Send to PackTrack"}
          </button>
        )}
        {sendBlockReason != null && !alreadySent && (
          <span
            title="Sending creates a recommendation in PackTrack for owner approval. Luma does not create a PO."
            className="inline-flex items-center rounded border border-slate-300 bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500"
          >
            Send blocked: {sendBlockReason}
          </span>
        )}
        {alreadySent && (
          <span className="inline-flex items-center rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-900">
            Sent to PackTrack
          </span>
        )}
      </div>
      {sendStatus.kind === "error" && (
        <p className="text-[10px] text-red-700">{sendStatus.message}</p>
      )}
      {sendStatus.kind === "ok" && (
        <p className="text-[10px] text-emerald-700">
          Sent. Refresh to see the recorded timestamp.
        </p>
      )}
      {ackStatus.kind === "error" && (
        <p className="text-[10px] text-red-700">{ackStatus.message}</p>
      )}
      {ackStatus.kind === "ok" && !alreadyAcked && (
        <p className="text-[10px] text-emerald-700">
          Acknowledged. Refresh to see in filters.
        </p>
      )}
      {dismissOpen && (
        <div className="w-64 rounded border border-border bg-white p-2 text-xs shadow">
          <p className="font-semibold mb-1">Dismiss recommendation</p>
          <p className="text-[10px] text-text-muted mb-2">
            Not sent to PackTrack. Row stays in audit history.
          </p>
          <input
            type="text"
            placeholder="Reason (optional)"
            value={dismissReason}
            onChange={(e) => setDismissReason(e.target.value)}
            className="w-full mb-1 rounded border border-border px-2 py-1 text-[11px]"
            maxLength={120}
          />
          <textarea
            placeholder="Notes (optional)"
            value={dismissNotes}
            onChange={(e) => setDismissNotes(e.target.value)}
            className="w-full mb-2 rounded border border-border px-2 py-1 text-[11px]"
            rows={2}
            maxLength={500}
          />
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={() => setDismissOpen(false)}
              className="rounded border border-border bg-page px-2 py-1 text-[11px] text-text-muted hover:bg-surface"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onDismiss}
              disabled={dismissStatus.kind === "pending"}
              className="rounded border border-border bg-surface-2 px-2 py-1 text-[11px] font-semibold text-text-strong hover:bg-surface-2/80 transition-colors disabled:opacity-50"
            >
              {dismissStatus.kind === "pending" ? "…" : "Confirm dismiss"}
            </button>
          </div>
          {dismissStatus.kind === "error" && (
            <p className="text-[10px] text-red-700 mt-1">
              {dismissStatus.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: ShortageSeverity }) {
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-semibold uppercase tracking-wider ${SEVERITY_STYLE[severity]}`}
    >
      {severity}
    </span>
  );
}

function SendableBadge({ sendable }: { sendable: boolean }) {
  return sendable ? (
    <span className="inline-flex items-center h-5 px-1.5 rounded-sm border border-emerald-400 bg-emerald-50 text-emerald-900 text-[10px] font-semibold uppercase tracking-wider">
      Sendable
    </span>
  ) : (
    <span className="inline-flex items-center h-5 px-1.5 rounded-sm border border-slate-300 bg-slate-50 text-slate-700 text-[10px] font-semibold uppercase tracking-wider">
      Not sendable
    </span>
  );
}

export function ShortageRecommendationsPanel({
  rows,
  packtrackConfigured,
}: {
  rows: RecommendationRow[];
  packtrackConfigured: boolean;
}) {
  const [statusFilter, setStatusFilter] =
    React.useState<RecommendationStatusFilter>("ACTIVE");
  const [severityFilter, setSeverityFilter] = React.useState<
    ShortageSeverity[]
  >([]);
  const [confidenceFilter, setConfidenceFilter] = React.useState<
    ShortageConfidence[]
  >([]);
  const [sendableOnly, setSendableOnly] = React.useState(false);
  const [missingConfigOnly, setMissingConfigOnly] = React.useState(false);
  const [productFilter, setProductFilter] = React.useState<string>("");
  const [materialFilter, setMaterialFilter] = React.useState<string>("");

  const productOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.productId && r.productName) seen.set(r.productId, r.productName);
    }
    return Array.from(seen.entries()).sort((a, b) =>
      a[1].localeCompare(b[1]),
    );
  }, [rows]);

  const materialOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.materialId, r.materialName);
    return Array.from(seen.entries()).sort((a, b) =>
      a[1].localeCompare(b[1]),
    );
  }, [rows]);

  const filtered = React.useMemo(() => {
    const f: Parameters<typeof filterRecommendations>[1] = {
      status: statusFilter,
      sendableOnly,
      missingConfigOnly,
    };
    if (severityFilter.length > 0) f.severity = severityFilter;
    if (confidenceFilter.length > 0) f.confidence = confidenceFilter;
    if (productFilter) {
      f.productId =
        productFilter === "MATERIAL_WIDE" ? "MATERIAL_WIDE" : productFilter;
    }
    if (materialFilter) f.materialId = materialFilter;
    return filterRecommendations(rows, f);
  }, [
    rows,
    statusFilter,
    severityFilter,
    confidenceFilter,
    sendableOnly,
    missingConfigOnly,
    productFilter,
    materialFilter,
  ]);

  function toggle<T>(
    list: T[],
    setter: (v: T[]) => void,
    value: T,
  ): () => void {
    return () => {
      if (list.includes(value)) setter(list.filter((v) => v !== value));
      else setter([...list, value]);
    };
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          PackTrack shortage recommendations ({filtered.length})
        </CardTitle>
        <p className="text-[11px] text-text-muted mt-1">
          Recommendation only. Sending creates a recommendation in
          PackTrack for owner approval. Luma does not create a PO.
          {packtrackConfigured ? null : (
            <span className="ml-1 inline-flex items-center rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900">
              PackTrack handoff not configured
            </span>
          )}
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 mb-4 text-[11px]">
          <div className="flex items-center gap-1">
            <span className="text-text-muted">Status:</span>
            {(
              [
                "ACTIVE",
                "ACKNOWLEDGED",
                "DISMISSED",
                "ALL",
              ] as RecommendationStatusFilter[]
            ).map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded-sm border px-1.5 py-0.5 ${
                  statusFilter === s
                    ? "bg-brand-700 text-white border-brand-700"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                }`}
              >
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <span className="text-text-muted">Severity:</span>
            {SEVERITIES.map((sv) => (
              <button
                type="button"
                key={sv}
                onClick={toggle(severityFilter, setSeverityFilter, sv)}
                className={`rounded-sm border px-1.5 py-0.5 ${
                  severityFilter.includes(sv)
                    ? "bg-brand-700 text-white border-brand-700"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                }`}
              >
                {sv}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <span className="text-text-muted">Confidence:</span>
            {CONFIDENCES.map((c) => (
              <button
                type="button"
                key={c}
                onClick={toggle(confidenceFilter, setConfidenceFilter, c)}
                className={`rounded-sm border px-1.5 py-0.5 ${
                  confidenceFilter.includes(c)
                    ? "bg-brand-700 text-white border-brand-700"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                }`}
              >
                {c}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={sendableOnly}
              onChange={(e) => setSendableOnly(e.target.checked)}
            />
            Sendable only
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={missingConfigOnly}
              onChange={(e) => setMissingConfigOnly(e.target.checked)}
            />
            Missing config only
          </label>

          {productOptions.length > 0 && (
            <label className="flex items-center gap-1">
              <span className="text-text-muted">Product:</span>
              <select
                value={productFilter}
                onChange={(e) => setProductFilter(e.target.value)}
                className="rounded border border-border bg-white px-1 py-0.5"
              >
                <option value="">(any)</option>
                <option value="MATERIAL_WIDE">Material-wide only</option>
                {productOptions.map(([pid, pname]) => (
                  <option key={pid} value={pid}>
                    {pname}
                  </option>
                ))}
              </select>
            </label>
          )}
          {materialOptions.length > 0 && (
            <label className="flex items-center gap-1">
              <span className="text-text-muted">Material:</span>
              <select
                value={materialFilter}
                onChange={(e) => setMaterialFilter(e.target.value)}
                className="rounded border border-border bg-white px-1 py-0.5"
              >
                <option value="">(any)</option>
                {materialOptions.map(([mid, mname]) => (
                  <option key={mid} value={mid}>
                    {mname}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {filtered.length === 0 ? (
          <p className="text-sm text-text-muted py-8 text-center">
            {rows.length === 0
              ? "No shortage recommendations yet. Run material recommendation rebuild."
              : "No recommendations match the current filters."}
          </p>
        ) : (
          <ul className="space-y-3">
            {filtered.map((r) => (
              <li
                key={r.id}
                className="rounded border border-border bg-surface p-3 text-sm"
              >
                <div className="flex justify-between items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap gap-1 items-center mb-1">
                      <SeverityBadge severity={r.severity} />
                      <ConfidenceBadge confidence={r.confidence} />
                      <SendableBadge sendable={r.sendableToPackTrack} />
                      {r.compatibilityRole && (
                        <span className="inline-flex items-center h-5 px-1.5 rounded-sm border border-blue-400 bg-blue-50 text-blue-900 text-[10px] font-semibold uppercase tracking-wider">
                          Required: {r.compatibilityRole}
                        </span>
                      )}
                      {r.missingInputs.length > 0 && (
                        <span className="inline-flex items-center h-5 px-1.5 rounded-sm border border-slate-300 bg-slate-100 text-slate-700 text-[10px] font-semibold uppercase tracking-wider">
                          Missing configuration
                        </span>
                      )}
                      {r.acknowledgedAt && (
                        <span className="inline-flex items-center h-5 px-1.5 rounded-sm border border-emerald-300 bg-emerald-50 text-emerald-900 text-[10px] font-semibold uppercase tracking-wider">
                          Acknowledged
                        </span>
                      )}
                      {r.dismissedAt && (
                        <span className="inline-flex items-center h-5 px-1.5 rounded-sm border border-slate-300 bg-slate-100 text-slate-500 text-[10px] font-semibold uppercase tracking-wider">
                          Dismissed
                        </span>
                      )}
                    </div>
                    <div className="font-semibold">
                      {r.materialName}{" "}
                      <span className="text-text-muted font-normal">
                        ({r.materialCode || "no code"})
                      </span>
                    </div>
                    {r.productId && (
                      <div className="text-[11px] text-text-muted">
                        For {r.productName} ({r.productSku ?? "no SKU"})
                      </div>
                    )}
                    {!r.productId && (
                      <div className="text-[11px] text-text-muted">
                        Material-wide (shared across products)
                      </div>
                    )}
                    <p className="mt-1 text-[12px]">{r.reason}</p>
                  </div>
                  <ActionButtons
                    row={r}
                    packtrackConfigured={packtrackConfigured}
                  />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3 text-[11px]">
                  <div>
                    <div className="text-text-muted">On hand</div>
                    <div className="tabular-nums">
                      {formatQty(r.currentOnHand)}
                    </div>
                  </div>
                  <div>
                    <div className="text-text-muted">Accepted</div>
                    <div className="tabular-nums">
                      {formatQty(r.acceptedInventory)}
                    </div>
                  </div>
                  <div>
                    <div className="text-text-muted">Projected demand</div>
                    <div className="tabular-nums">
                      {formatQty(r.projectedDemand)}
                    </div>
                  </div>
                  <div>
                    <div className="text-text-muted">Shortage</div>
                    <div className="tabular-nums text-amber-800 font-semibold">
                      {formatQty(r.projectedShortageQuantity)}
                    </div>
                  </div>
                  <div>
                    <div className="text-text-muted">Recommend order</div>
                    <div className="tabular-nums font-semibold">
                      {formatQty(r.recommendedOrderQuantity)}
                    </div>
                  </div>
                  <div>
                    <div className="text-text-muted">Needed by</div>
                    <div>{r.neededByDate ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-text-muted">Generated</div>
                    <div>{formatDate(r.generatedAt)}</div>
                  </div>
                  <div>
                    <div className="text-text-muted">Expires</div>
                    <div>{formatDate(r.expiresAt)}</div>
                  </div>
                  <div>
                    <div className="text-text-muted">Supplier hint</div>
                    <div>{r.recommendedSupplierHint ?? "—"}</div>
                  </div>
                </div>

                {r.sourceSignals.length > 0 && (
                  <details className="mt-2 text-[11px]">
                    <summary className="cursor-pointer text-text-muted hover:text-text">
                      Source signals ({r.sourceSignals.length})
                    </summary>
                    <ul className="mt-1 ml-4 list-disc">
                      {r.sourceSignals.map((s, i) => (
                        <li key={i}>
                          <span className="font-semibold">{s.label}:</span>{" "}
                          {s.value == null ? "Missing" : String(s.value)}{" "}
                          <span className="text-text-muted">({s.confidence})</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {(r.missingInputs.length > 0 || r.warnings.length > 0) && (
                  <div className="mt-2 text-[11px] space-y-1">
                    {r.missingInputs.length > 0 && (
                      <p className="text-amber-800">
                        <span className="font-semibold">
                          Manual review required:
                        </span>{" "}
                        missing {r.missingInputs.join(", ")}
                      </p>
                    )}
                    {r.warnings.map((w, i) => (
                      <p key={i} className="text-slate-700">
                        {w}
                      </p>
                    ))}
                  </div>
                )}

                <p className="mt-2 text-[10px] text-text-muted italic">
                  Recommendation only — Luma has not ordered anything. Not
                  sent to PackTrack yet.
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
