"use client";

// CLOSEOUT-DRAWER-1 — client table body for the PO Closeout detail page.
// Same columns as before; each row now expands into the bag drawer
// (verify-in-place + act-in-place). Row data is computed server-side by the
// existing loaders and passed down serialized.

import * as React from "react";
import Link from "next/link";
import { Check, X, Minus, ChevronDown, ChevronRight } from "lucide-react";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { RowStatusBadge } from "../status-badge";
import { BagProductionSummaryInline } from "@/components/admin/bag-production-summary-inline";
import type { BagProductionSummary } from "@/lib/production/bag-production-summary";
import type { PoCloseoutRow } from "@/lib/db/queries/po-closeout";
import { BagDrawer } from "./bag-drawer";

const ZOHO_LABEL: Record<string, string> = {
  COMMITTED: "Committed",
  QUEUED: "Queued",
  READY_TO_QUEUE: "Ready to queue",
  NOT_READY: "Not ready",
  FAILED: "Failed",
  NOT_APPLICABLE: "Not required",
  UNCLEAR: "Unclear",
};

function rowLink(row: PoCloseoutRow): { href: string; label: string } | null {
  switch (row.action) {
    case "REPAIR_QR_RESERVATION":
      return row.receiveId ? { href: `/inbound/${row.receiveId}`, label: "Open receive" } : null;
    case "START_OR_FINALIZE_WORKFLOW":
      return { href: "/workflow-submissions", label: "Open workflows" };
    case "CORRECT_STARTING_BALANCE":
    case "RECORD_REMAINING_OR_CLOSE_PARTIAL":
      return { href: "/partial-bags", label: "Partial Bag Workbench" };
    case "AUTO_ISSUE_FINISHED_LOT":
      return { href: "/packaging-output", label: "Production output" };
    case "AUTO_RELEASE_FINISHED_LOT":
    case "REVIEW_QC_HOLD":
      return row.finishedLotId
        ? { href: `/finished-lots/${row.finishedLotId}`, label: "Open lot" }
        : { href: "/finished-lots", label: "Finished lots" };
    case "QUEUE_OR_RETRY_ZOHO":
      return { href: "/zoho-production-operations", label: "Zoho output" };
    case "FIX_PRODUCT_SETUP":
      return { href: "/workflow-submissions", label: "Review" };
    default:
      return row.receiveId ? { href: `/inbound/${row.receiveId}`, label: "Open receive" } : null;
  }
}

function Tick({ ok, label }: { ok: boolean | null; label: string }) {
  const Icon = ok === null ? Minus : ok ? Check : X;
  const cls = ok === null ? "text-text-subtle" : ok ? "text-green-600" : "text-amber-600";
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] ${cls}`} title={label}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}

export type CloseoutRowClient = PoCloseoutRow & {
  productionSummary: BagProductionSummary | null;
};

export function CloseoutRows({
  rows,
  poId,
}: {
  rows: CloseoutRowClient[];
  poId: string;
}) {
  const [openBagId, setOpenBagId] = React.useState<string | null>(null);

  return (
    <DataTable>
      <THead>
        <TR>
          <TH>Bag / receipt</TH>
          <TH>Flavor</TH>
          <TH>Production</TH>
          <TH>Status</TH>
          <TH>What&apos;s next</TH>
          <TH>Checklist</TH>
          <TH>{" "}</TH>
        </TR>
      </THead>
      <tbody>
        {rows.length === 0 ? (
          <TR>
            <TD className="text-sm text-text-muted">No bags in this filter.</TD>
          </TR>
        ) : (
          rows.map((row) => {
            const link = rowLink(row);
            const isOpen = openBagId === row.inventoryBagId;
            return (
              <React.Fragment key={row.inventoryBagId}>
                <TR>
                  <TD>
                    <button
                      type="button"
                      onClick={() => setOpenBagId(isOpen ? null : row.inventoryBagId)}
                      className="flex items-start gap-1 text-left"
                      aria-expanded={isOpen}
                    >
                      {isOpen ? (
                        <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-700" aria-hidden />
                      ) : (
                        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-subtle" aria-hidden />
                      )}
                      <span>
                        <span className="block font-mono text-xs font-semibold">
                          {row.receiptNumber ?? "—"}
                        </span>
                        <span className="block text-[10px] text-text-subtle">
                          Bag {row.bagNumber ?? "?"} · {row.bagQrCode ?? "no QR"}
                        </span>
                      </span>
                    </button>
                  </TD>
                  <TD className="text-xs">{row.tabletName ?? "—"}</TD>
                  <TD>
                    {row.productionSummary ? (
                      <BagProductionSummaryInline summary={row.productionSummary} variant="row" />
                    ) : (
                      <span className="text-xs text-text-muted">—</span>
                    )}
                  </TD>
                  <TD><RowStatusBadge status={row.status} /></TD>
                  <TD>
                    <div className="text-xs font-medium text-text-strong">{row.actionLabel}</div>
                    <div className="text-[10px] text-text-muted">{row.reason}</div>
                  </TD>
                  <TD>
                    <div className="flex flex-col gap-0.5">
                      <Tick ok={row.checklist.received} label="Received" />
                      <Tick ok={row.checklist.floorFinalizedOrExcluded} label="Finalized" />
                      <Tick ok={row.checklist.finishedLotIssued} label="Lot issued" />
                      <Tick ok={row.checklist.finishedLotReleasedOrHeld} label="Released/held" />
                      <Tick
                        ok={row.checklist.zohoQueuedOrCommittedOrNa}
                        label={`Zoho: ${ZOHO_LABEL[row.zoho] ?? row.zoho}`}
                      />
                    </div>
                  </TD>
                  <TD className="text-right">
                    {link ? (
                      <Link
                        href={link.href}
                        className="text-xs font-medium text-brand-700 hover:underline whitespace-nowrap"
                      >
                        {link.label}
                      </Link>
                    ) : null}
                  </TD>
                </TR>
                {isOpen ? (
                  <tr>
                    <td colSpan={7} className="p-0">
                      <BagDrawer
                        inventoryBagId={row.inventoryBagId}
                        poId={poId}
                        reason={row.reason}
                        row={{
                          status: row.status,
                          action: row.action,
                          zoho: row.zoho,
                          workflowBagId: row.workflowBagId,
                          finishedLotId: row.finishedLotId,
                          lotStatus: row.lotStatus,
                          receiveId: row.receiveId,
                        }}
                      />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })
        )}
      </tbody>
    </DataTable>
  );
}
