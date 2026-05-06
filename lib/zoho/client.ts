// Zoho Inventory client. Handles refresh-on-demand for the access
// token and exposes the two endpoints we actually use:
//   - createPurchaseReceive(): when a finished lot ships to a vendor
//   - testConnection(): used by /settings/zoho to confirm the
//     stored credentials still work
//
// One credential row per company (companies × zoho_credentials is
// 1:1). The runtime stores the most-recent access token + its
// absolute expiry so we don't have to round-trip the refresh
// endpoint on every request.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoCredentials } from "@/lib/db/schema";

const DC_TO_HOSTS: Record<string, { accounts: string; api: string }> = {
  us: {
    accounts: "https://accounts.zoho.com",
    api: "https://www.zohoapis.com/inventory/v1",
  },
  eu: {
    accounts: "https://accounts.zoho.eu",
    api: "https://www.zohoapis.eu/inventory/v1",
  },
  in: {
    accounts: "https://accounts.zoho.in",
    api: "https://www.zohoapis.in/inventory/v1",
  },
  au: {
    accounts: "https://accounts.zoho.com.au",
    api: "https://www.zohoapis.com.au/inventory/v1",
  },
  jp: {
    accounts: "https://accounts.zoho.jp",
    api: "https://www.zohoapis.jp/inventory/v1",
  },
};

type Credential = typeof zohoCredentials.$inferSelect;

export class ZohoNotConfiguredError extends Error {
  constructor() {
    super(
      "Zoho is not configured. Set credentials at /settings/zoho first.",
    );
    this.name = "ZohoNotConfiguredError";
  }
}

export class ZohoApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(
      message ??
        `Zoho API error (${status}): ${typeof body === "string" ? body : JSON.stringify(body).slice(0, 240)}`,
    );
    this.status = status;
    this.body = body;
  }
}

async function loadCreds(companyId: string): Promise<Credential | null> {
  const [row] = await db
    .select()
    .from(zohoCredentials)
    .where(eq(zohoCredentials.companyId, companyId));
  return row ?? null;
}

async function refreshAccessToken(creds: Credential): Promise<string> {
  const hosts = DC_TO_HOSTS[creds.dataCenter] ?? DC_TO_HOSTS.us;
  if (!hosts) throw new Error("Zoho: unknown data center.");
  const url = new URL(`${hosts.accounts}/oauth/v2/token`);
  url.searchParams.set("refresh_token", creds.refreshToken);
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("client_secret", creds.clientSecret);
  url.searchParams.set("grant_type", "refresh_token");
  const r = await fetch(url, { method: "POST" });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!r.ok || j.error || !j.access_token) {
    throw new ZohoApiError(r.status, j, `Zoho refresh failed: ${j.error ?? "unknown"}`);
  }
  const expiresMs = (j.expires_in ?? 3600) * 1000;
  const expiresAt = new Date(Date.now() + expiresMs - 60_000); // 60s safety
  await db
    .update(zohoCredentials)
    .set({
      accessToken: j.access_token,
      accessTokenExpiresAt: expiresAt,
    })
    .where(eq(zohoCredentials.id, creds.id));
  return j.access_token;
}

async function getValidToken(creds: Credential): Promise<string> {
  if (
    creds.accessToken &&
    creds.accessTokenExpiresAt &&
    new Date(creds.accessTokenExpiresAt as unknown as string).getTime() >
      Date.now()
  ) {
    return creds.accessToken;
  }
  return refreshAccessToken(creds);
}

export async function isZohoConfigured(companyId: string): Promise<boolean> {
  const creds = await loadCreds(companyId);
  return !!creds && creds.isActive;
}

/** Verifies the credentials by hitting /organizations. Returns the
 *  organization name on success; throws ZohoApiError on failure. */
export async function testConnection(
  companyId: string,
): Promise<{ organizationName: string; organizationId: string }> {
  const creds = await loadCreds(companyId);
  if (!creds || !creds.isActive) throw new ZohoNotConfiguredError();
  const token = await getValidToken(creds);
  const hosts = DC_TO_HOSTS[creds.dataCenter] ?? DC_TO_HOSTS.us;
  if (!hosts) throw new Error("Zoho: unknown data center.");
  const r = await fetch(`${hosts.api}/organizations/${creds.organizationId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const j = (await r.json()) as {
    organization?: { name?: string; organization_id?: string };
    code?: number;
    message?: string;
  };
  if (!r.ok || !j.organization) {
    throw new ZohoApiError(
      r.status,
      j,
      `Zoho test failed: ${j.message ?? "unknown"}`,
    );
  }
  return {
    organizationName: j.organization.name ?? "—",
    organizationId: j.organization.organization_id ?? creds.organizationId,
  };
}

/** Stub: create a purchase_receive in Zoho Inventory. Real call
 *  shape depends on whether finished lots map to vendor receipts
 *  or transfer-orders in your Zoho setup; we leave the wire format
 *  TODO until the operator picks an entity type in /settings/zoho.
 *  For now: throws "not yet wired" so the UI can show a clean
 *  message instead of a 500. */
export async function createPurchaseReceive(
  companyId: string,
  payload: {
    lotId: string;
    productZohoItemId: string;
    quantity: number;
    receiveNumber: string;
    notes?: string;
  },
): Promise<{ zohoReceiveId: string }> {
  const creds = await loadCreds(companyId);
  if (!creds || !creds.isActive) throw new ZohoNotConfiguredError();
  // Real call would POST to /purchasereceives or similar — pinned
  // until the operator confirms entity mapping in Zoho. Fail loudly
  // so we don't pretend to push.
  throw new Error(
    "Zoho push: entity mapping not yet configured. Open /settings/zoho to pick whether finished lots map to purchase_receives, transfer_orders, or sales_orders.",
  );
}
