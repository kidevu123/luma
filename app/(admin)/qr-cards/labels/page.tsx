// Printable QR card labels. One QR per IDLE card. Encodes the
// card's UUID — when the floor tablet's camera scans it, the
// scan-card form on /floor/<station-token> reads the UUID and
// fires scanCardAction.

import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listQrCards } from "@/lib/db/queries/qr-cards";
import { Button } from "@/components/ui/button";
import * as QRCode from "qrcode";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

async function renderQrSvg(value: string): Promise<string> {
  // SVG renders sharp at print resolution.
  return QRCode.toString(value, {
    type: "svg",
    margin: 1,
    width: 200,
    errorCorrectionLevel: "M",
  });
}

export default async function QrLabelsPage() {
  await requireAdmin();
  const all = await listQrCards();
  const idle = all.filter((r) => r.card.status === "IDLE" && r.card.cardType === "RAW_BAG");
  const svgs = await Promise.all(idle.map((r) => renderQrSvg(r.card.id)));

  return (
    <div className="space-y-5 print:space-y-0">
      {/* CSS gates: chrome + sidebar are hidden when printing so the
          page collapses to a clean 3-up grid of QRs. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @media print {
              @page { margin: 0.4in; }
              aside, header, .no-print { display: none !important; }
              body { background: #fff !important; }
              main, .print-root { padding: 0 !important; }
            }
          `,
        }}
      />

      <div className="no-print flex items-center justify-between gap-3 flex-wrap">
        <div>
          <Link
            href="/qr-cards"
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-1"
          >
            <ArrowLeft className="h-3 w-3" /> All cards
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            Print {idle.length} card label{idle.length === 1 ? "" : "s"}
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            One QR per idle RAW_BAG card. Each encodes the card's UUID — that's what
            the floor tablet scans.
          </p>
        </div>
        <PrintButton />
      </div>

      {idle.length === 0 ? (
        <p className="text-sm text-text-muted no-print">
          No IDLE cards to print. Create some on the QR cards page.
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 print-root">
          {idle.map((r, i) => (
            <div
              key={r.card.id}
              className="rounded-lg border border-dashed border-border bg-surface p-3 flex flex-col items-center gap-1.5 print:break-inside-avoid"
            >
              <div
                dangerouslySetInnerHTML={{ __html: svgs[i] ?? "" }}
                className="w-full max-w-[160px]"
              />
              <p className="text-sm font-semibold text-center">{r.card.label}</p>
              <p className="text-[9px] font-mono text-text-subtle text-center break-all">
                {r.card.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
