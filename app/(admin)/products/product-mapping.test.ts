import { describe, it, expect } from "vitest";

describe("saveProductAction field extraction", () => {
  it("leaves assembly ID fields undefined when not in FormData", () => {
    const fd = new FormData();
    fd.set("id", "11111111-1111-1111-1111-111111111111");
    fd.set("name", "Test Product");
    fd.set("kind", "BOTTLE");
    fd.set("sku", "SKU-001");
    fd.set("zohoItemId", "ZOHO-123");
    // zohoItemIdUnit / Display / Case deliberately NOT set

    const zohoItemIdUnit    = (fd.get("zohoItemIdUnit") as string | null) || undefined;
    const zohoItemIdDisplay = (fd.get("zohoItemIdDisplay") as string | null) || undefined;
    const zohoItemIdCase    = (fd.get("zohoItemIdCase") as string | null) || undefined;

    expect(zohoItemIdUnit).toBeUndefined();
    expect(zohoItemIdDisplay).toBeUndefined();
    expect(zohoItemIdCase).toBeUndefined();
  });

  it("passes assembly ID fields through when present in FormData", () => {
    const fd = new FormData();
    fd.set("zohoItemIdUnit", "ZOHO-UNIT-456");
    fd.set("zohoItemIdDisplay", "ZOHO-DISP-789");
    fd.set("zohoItemIdCase", "ZOHO-CASE-101");

    const zohoItemIdUnit    = (fd.get("zohoItemIdUnit") as string | null) || undefined;
    const zohoItemIdDisplay = (fd.get("zohoItemIdDisplay") as string | null) || undefined;
    const zohoItemIdCase    = (fd.get("zohoItemIdCase") as string | null) || undefined;

    expect(zohoItemIdUnit).toBe("ZOHO-UNIT-456");
    expect(zohoItemIdDisplay).toBe("ZOHO-DISP-789");
    expect(zohoItemIdCase).toBe("ZOHO-CASE-101");
  });
});
