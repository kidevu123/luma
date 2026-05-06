// QR card management. The cards are physical badges floor staff
// scan to start a workflow_bag. Each card has a UUID (this is what
// gets encoded into the QR) and a status: IDLE / ASSIGNED / RETIRED.
//
// "Print labels" opens a print-friendly page that renders QR codes
// for every IDLE card so the operator can stick them on the new
// laminate badges.

import Link from "next/link";
import { Plus, Printer, QrCode } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listQrCards } from "@/lib/db/queries/qr-cards";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CreateCardForm, RetireButton } from "./forms";

export const dynamic = "force-dynamic";

export default async function QrCardsPage() {
  await requireAdmin();
  const rows = await listQrCards();
  const idleCount = rows.filter((r) => r.card.status === "IDLE").length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="QR cards"
        description="Physical scan badges. Each card carries one workflow bag at a time."
        actions={
          <div className="flex items-center gap-2">
            {idleCount > 0 && (
              <Button asChild variant="secondary" size="sm">
                <Link href="/qr-cards/labels" target="_blank" rel="noopener">
                  <Printer className="h-4 w-4" /> Print {idleCount} labels
                </Link>
              </Button>
            )}
          </div>
        }
      />

      <Card>
        <CardContent className="pt-5 space-y-4">
          <CreateCardForm />
          {rows.length === 0 ? (
            <p className="text-sm text-text-muted">
              No cards yet. Create one above — its UUID is what the floor
              tablet scans to assign a bag.
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map(({ card, bag, productName }) => (
                <li
                  key={card.id}
                  className="rounded-lg border border-border/70 bg-surface p-3"
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-brand-50 ring-1 ring-inset ring-brand-100">
                        <QrCode className="h-4 w-4 text-brand-700" />
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium truncate">{card.label}</p>
                        <p className="text-[11px] font-mono text-text-subtle truncate">
                          {card.id}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusKindPill status={card.status} />
                      {card.status === "ASSIGNED" && bag && (
                        <span className="text-[11px] text-text-muted">
                          on bag {bag.id.slice(0, 8)}
                          {productName ? ` · ${productName}` : ""}
                        </span>
                      )}
                      {card.status !== "RETIRED" && (
                        <RetireButton id={card.id} disabled={card.status === "ASSIGNED"} />
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusKindPill({ status }: { status: string }) {
  const map: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
    IDLE: "ok",
    ASSIGNED: "info",
    RETIRED: "neutral",
  };
  return <StatusPill kind={map[status] ?? "neutral"}>{status}</StatusPill>;
}
