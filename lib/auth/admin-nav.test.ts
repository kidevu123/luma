import { describe, expect, it } from "vitest";
import {
  filterAdminNavForRole,
  roleMeetsNavMin,
  visibleAdminNavHrefs,
} from "@/lib/auth/admin-nav";

describe("roleMeetsNavMin", () => {
  it("SESSION is open to every authenticated role", () => {
    for (const role of ["STAFF", "LEAD", "MANAGER", "ADMIN", "OWNER"] as const) {
      expect(roleMeetsNavMin(role, "SESSION")).toBe(true);
    }
  });

  it("LEAD excludes STAFF", () => {
    expect(roleMeetsNavMin("STAFF", "LEAD")).toBe(false);
    expect(roleMeetsNavMin("LEAD", "LEAD")).toBe(true);
    expect(roleMeetsNavMin("MANAGER", "LEAD")).toBe(true);
  });

  it("ADMIN excludes LEAD and MANAGER", () => {
    expect(roleMeetsNavMin("LEAD", "ADMIN")).toBe(false);
    expect(roleMeetsNavMin("MANAGER", "ADMIN")).toBe(false);
    expect(roleMeetsNavMin("ADMIN", "ADMIN")).toBe(true);
    expect(roleMeetsNavMin("OWNER", "ADMIN")).toBe(true);
  });
});

describe("filterAdminNavForRole", () => {
  it("STAFF sees session-level pages only", () => {
    const hrefs = visibleAdminNavHrefs("STAFF");
    expect(hrefs).toContain("/dashboard");
    expect(hrefs).toContain("/inbound");
    expect(hrefs).toContain("/workflow-submissions");
    expect(hrefs).not.toContain("/packaging-inventory");
    expect(hrefs).not.toContain("/partial-bags");
    expect(hrefs).not.toContain("/qc-review");
    expect(hrefs).not.toContain("/po-reconciliation");
    expect(hrefs).not.toContain("/reports/audit-log");
  });

  it("LEAD gains audit log but not admin-only pages", () => {
    const hrefs = visibleAdminNavHrefs("LEAD");
    expect(hrefs).toContain("/reports/audit-log");
    expect(hrefs).not.toContain("/packaging-inventory");
    expect(hrefs).not.toContain("/partial-bags");
  });

  it("ADMIN sees admin-gated sidebar entries", () => {
    const hrefs = visibleAdminNavHrefs("ADMIN");
    expect(hrefs).toContain("/packaging-inventory");
    expect(hrefs).toContain("/partial-bags");
    expect(hrefs).toContain("/qc-review");
    expect(hrefs).toContain("/shift-review");
    expect(hrefs).toContain("/po-reconciliation");
  });

  it("keeps sections that still have at least one visible item for STAFF", () => {
    const nav = filterAdminNavForRole("STAFF");
    const headings = nav.sections.map((s) => s.heading);
    expect(headings).toContain("Run production");
    expect(headings).toContain("Intake & materials");
    const runProd = nav.sections.find((s) => s.heading === "Run production");
    expect(runProd?.items.map((i) => i.href)).toEqual(["/workflow-submissions"]);
  });
});
