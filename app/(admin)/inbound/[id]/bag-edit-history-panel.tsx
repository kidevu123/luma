import type { BagEditHistory } from "@/lib/receive/bag-edit-history";
import { bagEditCountLabel } from "@/lib/receive/bag-edit-history";
import { StatusPill } from "@/components/ui/page-header";

export function BagEditHistoryPanel({ histories }: { histories: BagEditHistory[] }) {
  const withEdits = histories.filter((h) => h.entries.length > 0);
  if (histories.length === 0) return null;

  return (
    <div className="mt-5 pt-4 border-t border-border/60 space-y-3">
      <div>
        <h4 className="text-xs font-semibold text-text uppercase tracking-wider">
          Edit history
        </h4>
        <p className="text-[11px] text-text-subtle mt-0.5 leading-relaxed">
          Post-intake changes from the audit log. Bag edits are primary; QR card
          release/reserve rows appear when a bag edit changed the scan token.
        </p>
      </div>

      <ul className="space-y-2">
        {histories.map((history) => {
          const count = history.entries.length;
          const label = bagEditCountLabel(count);
          const title = `Bag ${history.bagNumber}${
            history.receiptLabel ? ` · ${history.receiptLabel}` : ""
          }`;

          if (count === 0) {
            return (
              <li
                key={history.bagId}
                className="flex items-center justify-between rounded-md border border-border/50 bg-surface/40 px-3 py-2 text-xs"
              >
                <span className="font-medium">{title}</span>
                <span className="text-text-subtle">{label}</span>
              </li>
            );
          }

          return (
            <li
              key={history.bagId}
              id={`bag-history-${history.bagId}`}
              className="rounded-md border border-border/70 bg-surface overflow-hidden scroll-mt-4"
            >
              <details className="group">
                <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer list-none text-xs hover:bg-surface-2/60">
                  <span className="font-medium min-w-0 truncate">{title}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <StatusPill kind="info">{label}</StatusPill>
                    <span className="text-text-subtle group-open:hidden">View</span>
                    <span className="text-text-subtle hidden group-open:inline">
                      Hide
                    </span>
                  </span>
                </summary>
                <div className="border-t border-border/60 px-3 py-2 space-y-2 bg-surface-2/30">
                  {history.entries.map((entry) => (
                    <div
                      key={entry.id}
                      className="text-[11px] leading-relaxed border-b border-border/40 last:border-0 pb-2 last:pb-0"
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-text-muted">
                        <time
                          dateTime={entry.createdAt.toISOString()}
                          className="tabular-nums"
                        >
                          {entry.createdAt.toLocaleString()}
                        </time>
                        <span>·</span>
                        <span>{entry.actorLabel}</span>
                        <span>·</span>
                        <span className="font-medium text-text">
                          {entry.actionLabel}
                        </span>
                        {entry.kind === "qr" && (
                          <StatusPill kind="neutral">QR</StatusPill>
                        )}
                      </div>
                      <ul className="mt-1 space-y-0.5 text-text pl-0 list-none">
                        {entry.summaryLines.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </details>
            </li>
          );
        })}
      </ul>

      {withEdits.length === 0 && histories.length > 0 && (
        <p className="text-xs text-text-subtle">
          No post-intake edits recorded for bags on this receive yet.
        </p>
      )}
    </div>
  );
}
