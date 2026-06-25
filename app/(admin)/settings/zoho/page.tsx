// Zoho Inventory credentials. Owner-only — credentials are
// effectively a master key for the company's Zoho org. The Test
// connection button probes the integration gateway (/health + /status);
// stored OAuth fields remain for warehouse defaults and legacy reference.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireOwner } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { zohoCredentials, companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ZohoCredentialForm } from "./form";

export const dynamic = "force-dynamic";

export default async function ZohoSettingsPage() {
  await requireOwner();
  // Single-tenant v1 — first row is the operating company.
  const [company] = await db.select({ id: companies.id }).from(companies).limit(1);
  if (!company) {
    return (
      <p className="text-sm text-text-muted">No company configured.</p>
    );
  }
  const [existing] = await db
    .select()
    .from(zohoCredentials)
    .where(eq(zohoCredentials.companyId, company.id));

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Settings
        </Link>
        <PageHeader
          title="Zoho Inventory"
          description="Credentials for pushing finished lots out to Zoho. Owner-only."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
        </CardHeader>
        <CardContent>
          <ZohoCredentialForm
            initial={
              existing
                ? {
                    organizationId: existing.organizationId,
                    clientId: existing.clientId,
                    dataCenter: existing.dataCenter,
                    warehouseId: existing.warehouseId,
                    isActive: existing.isActive,
                    hasSecret: true,
                    hasRefreshToken: true,
                  }
                : null
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How to get these</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-text-muted space-y-2 leading-relaxed">
          <ol className="list-decimal pl-5 space-y-1">
            <li>
              In Zoho, go to{" "}
              <span className="font-mono text-xs">
                accounts.zoho.com → API → Self-Client
              </span>{" "}
              and create a self-client. Note the Client ID and Client Secret.
            </li>
            <li>
              Generate a code with scope{" "}
              <span className="font-mono text-xs">
                ZohoInventory.fullaccess.all
              </span>
              .
            </li>
            <li>
              Exchange the code for a refresh token (one-time POST to{" "}
              <span className="font-mono text-xs">/oauth/v2/token</span>).
            </li>
            <li>Paste the refresh token + client id + secret here.</li>
          </ol>
          <p className="pt-2">
            Data center matters — pick the region that matches your Zoho
            account (most US users are <span className="font-mono text-xs">us</span>).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
