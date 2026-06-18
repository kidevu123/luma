import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  canAccessDangerZone,
  filterSettingsHubForRole,
  visibleSettingsHubHrefs,
} from "@/lib/auth/settings-hub";

const pageSrc = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("BUG-UI-FIX-BATCH-1 · settings system info", () => {
  it("shows package semver as Release, not as git SHA", () => {
    expect(pageSrc).toMatch(/getBuildFooterParts/);
    expect(pageSrc).toMatch(/label="Release".*v\$\{build\.version\}/s);
    expect(pageSrc).toMatch(/label="Git SHA"/);
  });
});

describe("settings hub · role-filtered links", () => {
  it("page filters hub sections by signed-in role", () => {
    expect(pageSrc).toMatch(/filterSettingsHubForRole\(me\.role\)/);
    expect(pageSrc).not.toMatch(/href="\/settings\/users"/);
  });

  it("MANAGER sees session-level analytics but not admin setup", () => {
    const hrefs = visibleSettingsHubHrefs("MANAGER");
    expect(hrefs).toContain("/material-reconciliation");
    expect(hrefs).toContain("/zoho-operations");
    expect(hrefs).not.toContain("/settings/users");
    expect(hrefs).not.toContain("/products");
    expect(hrefs).not.toContain("/shift-review");
    expect(hrefs).not.toContain("/settings/legacy-import");
  });

  it("STAFF sees the same session-level settings as MANAGER", () => {
    expect(visibleSettingsHubHrefs("STAFF")).toEqual(
      visibleSettingsHubHrefs("MANAGER"),
    );
  });

  it("ADMIN sees production setup and workflow links", () => {
    const hrefs = visibleSettingsHubHrefs("ADMIN");
    expect(hrefs).toContain("/products");
    expect(hrefs).toContain("/settings/users");
    expect(hrefs).toContain("/shift-review");
    expect(hrefs).not.toContain("/settings/legacy-import");
  });

  it("OWNER sees legacy import and danger zone gate passes", () => {
    const hrefs = visibleSettingsHubHrefs("OWNER");
    expect(hrefs).toContain("/settings/legacy-import");
    expect(canAccessDangerZone("OWNER")).toBe(true);
    expect(canAccessDangerZone("ADMIN")).toBe(false);
  });

  it("drops empty sections for non-admin roles", () => {
    const sections = filterSettingsHubForRole("MANAGER");
    expect(sections.map((s) => s.heading)).not.toContain("Team");
    expect(sections.map((s) => s.heading)).not.toContain("Production setup");
  });
});
