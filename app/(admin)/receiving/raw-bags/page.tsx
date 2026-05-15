// WORKFLOW-UX-1 — Raw-bag intake placeholder.
//
// The single-screen intake workflow itself (product picker + supplier
// lot + bag count + QR codes + receipt numbers, all on one screen)
// lands in INTAKE-UX-1. This page exists so the "Receive raw pills"
// sidebar item has a stable destination and the route shows up in
// the auth smoke list. The body explains the next step and links to
// the existing /inbound list so operators are never stuck.

import Link from "next/link";
import { ArrowRight, Inbox } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  ProductionAlertCard,
  ProductionSection,
} from "@/components/production/ui";

export const dynamic = "force-dynamic";

export default async function ReceiveRawBagsPage() {
  await requireAdmin();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Receive raw pills"
        description="Single-screen intake workflow for raw-pill bags coming off the truck. Captures product, supplier lot, bag count, QR codes, and receipt numbers in one pass."
      />

      <ProductionSection
        title="Workflow coming next"
        subtitle="INTAKE-UX-1 will replace this placeholder with the live intake form."
        tone="INFO"
      >
        <ProductionAlertCard
          tone="INFO"
          title="Raw bag intake workflow coming next"
          body="Enter product, supplier lot, bag count, QR codes, and receipt numbers on one screen. Until that ships, raw-pill PO + box + bag receiving still flows through the existing POs & receiving page."
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/inbound"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            <Inbox className="h-4 w-4" />
            Go to POs &amp; receiving
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </ProductionSection>

      <Card>
        <CardHeader>
          <CardTitle>What this screen will do</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-text-muted leading-relaxed space-y-2">
          <ul className="list-disc pl-5 space-y-1">
            <li>Pick the product / tablet type the bag is for.</li>
            <li>Enter the supplier lot number from the bag label.</li>
            <li>Enter the bag count + per-bag pill count.</li>
            <li>Scan or paste each bag's QR code; Luma issues the internal receipt numbers.</li>
            <li>Save — one click writes the receive + small_boxes + inventory_bags rows.</li>
          </ul>
          <p className="pt-2">
            Until then, use the legacy receive wizard from the <Link href="/inbound" className="underline">POs &amp; receiving</Link> page.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
