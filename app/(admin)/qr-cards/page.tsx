// QR card management. The cards are physical badges floor staff
// scan to start a workflow_bag. Each card has a UUID (this is what
// gets encoded into the QR) and a status: IDLE / ASSIGNED / RETIRED.
//
// "Print labels" opens a print-friendly page that renders QR codes
// for every IDLE card so the operator can stick them on the new
// laminate badges.

import Link from "next/link";
import { Printer } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { listQrCards } from "@/lib/db/queries/qr-cards";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CreateCardForm } from "./forms";
import { QrCardsList } from "./qr-cards-list";

export const dynamic = "force-dynamic";

export default async function QrCardsPage() {
  await requireAdmin();
  const rows = await listQrCards();
  const idleRawBagCount = rows.filter(
    (r) => r.card.status === "IDLE" && r.card.cardType === "RAW_BAG",
  ).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="QR cards"
        description="Physical scan badges. Each card carries one workflow bag at a time."
        actions={
          <div className="flex items-center gap-2">
            {idleRawBagCount > 0 && (
              <Button asChild variant="secondary" size="sm">
                <Link href="/qr-cards/labels" target="_blank" rel="noopener">
                  <Printer className="h-4 w-4" /> Print idle raw bag labels ({idleRawBagCount})
                </Link>
              </Button>
            )}
          </div>
        }
      />

      <Card>
        <CardContent className="pt-5 space-y-4">
          <CreateCardForm />
          <QrCardsList rows={rows} />
        </CardContent>
      </Card>
    </div>
  );
}
