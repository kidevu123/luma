// ZOHO-2A — customers.ts unit tests. Fetch is fully mocked.

import { describe, expect, it } from "vitest";
import {
  deriveCustomerCodeSuggestion,
  deriveZohoCustomerLumaTarget,
  fetchZohoCustomersDryRun,
  normalizeZohoCustomer,
  ZOHO_CUSTOMERS_LIST_PATH,
} from "@/lib/integrations/zoho/customers";

const baseEnv = {
  ZOHO_INTEGRATION_URL: "http://192.168.1.205:8000",
  ZOHO_INTEGRATION_SECRET: "s3cr3t",
  ZOHO_BRAND: "haute_brands",
};

const customerFixture = {
  contact_id: "ZC-2001",
  contact_name: "Acme Wholesale",
  company_name: "Acme Wholesale Inc.",
  email: "ordering@acme.example",
  phone: "+1-555-0142",
  status: "active",
  cf_customer_code: "acme-wholesale-east",
  billing_address: {
    attention: "AP",
    address: "1 Wholesale Way",
    city: "Boulder",
    state: "CO",
    zip: "80301",
    country: "USA",
  },
  shipping_address: {
    address: "2 Logistics Lane",
    city: "Denver",
    state: "CO",
    zip: "80201",
    country: "USA",
  },
};

describe("ZOHO-2A customers · normalizeZohoCustomer", () => {
  it("normalizes a complete contact row", () => {
    const c = normalizeZohoCustomer(customerFixture);
    expect(c).not.toBeNull();
    expect(c!.zohoCustomerId).toBe("ZC-2001");
    expect(c!.customerName).toBe("Acme Wholesale");
    expect(c!.email).toBe("ordering@acme.example");
    expect(c!.phone).toBe("+1-555-0142");
    expect(c!.active).toBe(true);
    expect(c!.billingAddress?.city).toBe("Boulder");
    expect(c!.shippingAddress?.zip).toBe("80201");
  });

  it("returns null when contact_id is missing", () => {
    expect(normalizeZohoCustomer({ contact_name: "no id" })).toBeNull();
  });

  it("falls back to company_name when contact_name absent", () => {
    const c = normalizeZohoCustomer({
      contact_id: "ZC-3",
      company_name: "Beta LLC",
    });
    expect(c!.customerName).toBe("Beta LLC");
  });

  it("captures inactive status", () => {
    const c = normalizeZohoCustomer({
      contact_id: "ZC-9",
      contact_name: "Gone",
      status: "inactive",
    });
    expect(c!.active).toBe(false);
  });

  it("addresses become null when not provided", () => {
    const c = normalizeZohoCustomer({ contact_id: "ZC-1", contact_name: "x" });
    expect(c!.billingAddress).toBeNull();
    expect(c!.shippingAddress).toBeNull();
  });
});

describe("ZOHO-2A customers · deriveCustomerCodeSuggestion", () => {
  it("prefers cf_customer_code (uppercased, sanitised)", () => {
    expect(deriveCustomerCodeSuggestion({ cf_customer_code: "acme east" })).toBe("ACME-EAST");
  });

  it("falls back to customer_code", () => {
    expect(deriveCustomerCodeSuggestion({ customer_code: "beta-llc" })).toBe("BETA-LLC");
  });

  it("falls back to contact_number", () => {
    expect(deriveCustomerCodeSuggestion({ contact_number: "C-0042" })).toBe("C-0042");
  });

  it("derives from company_name when no code fields", () => {
    expect(
      deriveCustomerCodeSuggestion({ company_name: "Big Box Mart, Inc." }),
    ).toBe("BIG-BOX-MART-INC");
  });

  it("returns null when both code fields and name are absent", () => {
    expect(deriveCustomerCodeSuggestion({})).toBeNull();
  });

  it("clamps to 32 chars", () => {
    const long = "X".repeat(80);
    const r = deriveCustomerCodeSuggestion({ cf_customer_code: long });
    expect(r?.length).toBeLessThanOrEqual(32);
  });
});

describe("ZOHO-2A customers · deriveZohoCustomerLumaTarget", () => {
  it("CUSTOMER when code suggestion + named", () => {
    const c = normalizeZohoCustomer(customerFixture)!;
    expect(deriveZohoCustomerLumaTarget(c)).toBe("CUSTOMER");
  });

  it("UNKNOWN when no code suggestion", () => {
    const c = normalizeZohoCustomer({ contact_id: "ZC-5" })!;
    expect(deriveZohoCustomerLumaTarget(c)).toBe("UNKNOWN");
  });
});

describe("ZOHO-2A customers · fetchZohoCustomersDryRun (mocked)", () => {
  it("NOT_CONFIGURED with empty env", async () => {
    const r = await fetchZohoCustomersDryRun({ env: {} });
    expect(r.kind).toBe("NOT_CONFIGURED");
  });

  it("OK with one valid contact", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ contacts: [customerFixture] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await fetchZohoCustomersDryRun({ env: baseEnv, fetchImpl });
    expect(r.kind).toBe("OK");
    if (r.kind === "OK") {
      expect(r.customers.length).toBe(1);
      expect(r.customers[0]?.zohoCustomerId).toBe("ZC-2001");
      expect(r.customers[0]?.customerCodeSuggestion).toBe("ACME-WHOLESALE-EAST");
    }
  });

  it("sends X-Internal-Token + X-Brand", async () => {
    let captured: Headers | null = null;
    let capturedUrl = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      captured = new Headers(init.headers as HeadersInit);
      return new Response(JSON.stringify({ contacts: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchZohoCustomersDryRun({ env: baseEnv, fetchImpl });
    expect(captured!.get("x-internal-token")).toBe("s3cr3t");
    expect(captured!.get("x-brand")).toBe("haute_brands");
    expect(capturedUrl).toContain(ZOHO_CUSTOMERS_LIST_PATH);
  });

  it("UNAUTHORIZED on 401", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const r = await fetchZohoCustomersDryRun({ env: baseEnv, fetchImpl });
    expect(r.kind).toBe("UNAUTHORIZED");
  });

  it("ERROR on HTTP 500", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await fetchZohoCustomersDryRun({ env: baseEnv, fetchImpl });
    expect(r.kind).toBe("ERROR");
  });

  it("UNREACHABLE on ECONNREFUSED", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await fetchZohoCustomersDryRun({ env: baseEnv, fetchImpl });
    expect(r.kind).toBe("UNREACHABLE");
  });
});
