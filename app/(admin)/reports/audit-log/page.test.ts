import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");
const filtersSrc = readFileSync(join(__dirname, "audit-log-filters.tsx"), "utf8");
const sidebarSrc = readFileSync(
  join(__dirname, "../../../../components/admin/sidebar.tsx"),
  "utf8",
);
// NAV-PHASED-1 — labels moved to lib/auth/admin-nav.ts; sidebar.tsx
// now only carries href→icon.
const adminNavSrc = readFileSync(
  join(__dirname, "../../../../lib/auth/admin-nav.ts"),
  "utf8",
);

describe("AUDIT-LOG-1 · audit log page", () => {
  it("requires lead role for supervisor access", () => {
    expect(pageSrc).toMatch(/requireLead/);
  });

  it("loads recent audit rows with a hard limit", () => {
    expect(pageSrc).toMatch(/listRecentAuditLogs/);
    expect(pageSrc).toMatch(/ROW_LIMIT\s*=\s*100/);
  });

  it("uses audit log view helpers for summaries", () => {
    expect(pageSrc).toMatch(/buildAuditLogViewRows/);
  });

  it("renders compact table with details expansion", () => {
    expect(pageSrc).toMatch(/<details>/);
    expect(pageSrc).toMatch(/Summary/);
    expect(pageSrc).not.toMatch(/JSON\.stringify\(rows\)/);
  });

  it("supports search param filters via client filter form", () => {
    expect(pageSrc).toMatch(/searchParams/);
    expect(pageSrc).toMatch(/actionContains/);
    expect(pageSrc).toMatch(/targetType/);
    expect(pageSrc).toMatch(/actorEmailContains/);
    expect(filtersSrc).toMatch(/\/reports\/audit-log/);
  });
});

describe("AUDIT-LOG-1 · sidebar nav", () => {
  it("links Audit log under Reports section", () => {
    expect(sidebarSrc).toMatch(/\/reports\/audit-log/);
    expect(adminNavSrc).toMatch(/label:\s*"Audit log"/);
  });
});
