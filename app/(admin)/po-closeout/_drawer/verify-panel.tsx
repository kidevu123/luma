// CLOSEOUT-DRAWER-1 — read-only verification panel: everything an admin
// needs to check a bag without leaving the closeout page. Pure
// presentational; data comes from BagCloseoutDetail (live on every open).

import type { BagCloseoutDetail } from "@/lib/db/queries/bag-closeout-detail";
import { BagProductionSummaryInline } from "@/components/admin/bag-production-summary-inline";
import { formatDateTimeEst } from "@/lib/ui/luma-display";

function n(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString();
}

export function VerifyPanel({ detail }: { detail: BagCloseoutDetail }) {
  const { summary, timeline, crossCheck, zohoReadiness, adminActions } = detail;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-3">
        {summary ? (
          <BagProductionSummaryInline summary={summary} variant="panel" />
        ) : (
          <p className="text-[11px] text-text-muted">
            No production summary available for this bag.
          </p>
        )}

        {crossCheck ? (
          <div className="rounded border border-border bg-surface-2/50 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
              PO line cross-check — {crossCheck.tabletName}
            </p>
            <div className="mt-1 grid grid-cols-4 gap-2 text-center text-[11px] tabular-nums">
              {[
                ["Ordered", crossCheck.qtyOrdered],
                ["Received", crossCheck.qtyReceived],
                ["Consumed", crossCheck.rawConsumed],
                ["Finished units", crossCheck.finishedUnits],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <p className="text-[9.5px] uppercase tracking-wide text-text-subtle">{label}</p>
                  <p className="font-mono text-text-strong">{n(Number(value))}</p>
                </div>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-text-muted">
              Whole PO line for this flavor — not just this bag.
            </p>
          </div>
        ) : null}

        <div className="rounded border border-border bg-surface-2/50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
            Zoho readiness
          </p>
          {zohoReadiness.op ? (
            <p className="mt-1 text-[11px]">
              Active op: <span className="font-mono text-[10px]">{zohoReadiness.op.id.slice(0, 8)}</span>{" "}
              — <span className="font-medium">{zohoReadiness.op.status}</span>
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-text-muted">No active Zoho op for this bag&apos;s lot.</p>
          )}
          {zohoReadiness.setup ? (
            zohoReadiness.setup.missingFields.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-[10.5px] text-warn-700">
                {zohoReadiness.setup.missingFields.map((f) => (
                  <li key={f.code}>{f.label}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[10.5px] text-good-700">
                Product setup complete{zohoReadiness.setup.zohoReady ? " — Zoho item IDs present." : "."}
              </p>
            )
          ) : (
            <p className="mt-1 text-[10.5px] text-text-muted">No product mapped — setup unknown.</p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="rounded border border-border bg-surface-2/50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
            Timeline {timeline ? `(${timeline.events.length} events)` : ""}
          </p>
          {timeline && timeline.events.length > 0 ? (
            <ol className="mt-1 max-h-56 space-y-1 overflow-y-auto">
              {timeline.events.map((e) => (
                <li key={e.eventId} className="flex flex-wrap items-baseline gap-1.5 text-[10.5px]">
                  <span className="font-mono text-[9.5px] text-text-subtle">
                    {formatDateTimeEst(e.occurredAt as unknown as string)}
                  </span>
                  <span className="rounded border border-border bg-surface px-1 text-[9px] uppercase tracking-wide text-text-muted">
                    {e.eventType}
                  </span>
                  {e.stationLabel ? (
                    <span className="text-text-muted">{e.stationLabel}</span>
                  ) : null}
                  {e.employeeName ? (
                    <span className="text-text-subtle">· {e.employeeName}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-[10.5px] text-text-muted">
              No production run recorded for this bag.
            </p>
          )}
        </div>

        <div className="rounded border border-border bg-surface-2/50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
            Admin actions ({adminActions.length})
          </p>
          {adminActions.length > 0 ? (
            <ol className="mt-1 max-h-40 space-y-1 overflow-y-auto">
              {adminActions.map((a, i) => (
                <li key={`${a.action}-${i}`} className="text-[10.5px]">
                  <span className="font-mono text-[9.5px] text-text-subtle">
                    {formatDateTimeEst(a.createdAt as unknown as string)}
                  </span>{" "}
                  <span className="font-medium">{a.action}</span>
                  {a.actorEmail ? (
                    <span className="text-text-muted"> · {a.actorEmail}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-[10.5px] text-text-muted">
              No closeout-related admin actions recorded for this bag.
            </p>
          )}
        </div>

        <p className="text-[9.5px] text-text-subtle">
          Data as of {formatDateTimeEst(detail.evaluatedAt as unknown as string)} — reloaded on every open and after every action.
        </p>
      </div>
    </div>
  );
}
