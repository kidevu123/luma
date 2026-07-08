// ACCESS-POLICY-1 — Reconciliation & Output access policy.
//
// Locks the intended policy after the seri@haute.com incident (active OIDC
// account was provisioned MANAGER during the local->OIDC migration while the
// disabled predecessor held ADMIN, silently losing PO Closeout /
// Reconciliation access):
//   OWNER  — everything.
//   ADMIN  — all reconciliation/output admin pages.
//   MANAGER/LEAD/STAFF — never the ADMIN-gated ones.
// Nav visibility and route guards must agree, and role checks must use the
// exact production enum strings (user_role: OWNER/ADMIN/MANAGER/LEAD/STAFF).

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ADMIN_NAV_SECTIONS,
  roleMeetsNavMin,
} from "@/lib/auth/admin-nav";

const repo = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

const allNavItems = ADMIN_NAV_SECTIONS.flatMap((s) => s.items);
const navByHref = new Map(allNavItems.map((i) => [i.href, i]));

const RECON_OUTPUT_PAGES = [
  { href: "/po-closeout", page: "app/(admin)/po-closeout/page.tsx", guard: "requireAdmin" },
  { href: "/po-reconciliation", page: "app/(admin)/po-reconciliation/page.tsx", guard: "requireAdmin" },
  { href: "/packaging-output", page: "app/(admin)/packaging-output/page.tsx", guard: "requireSession" },
  { href: "/finished-lots", page: "app/(admin)/finished-lots/page.tsx", guard: "requireSession" },
  { href: "/zoho-production-operations", page: "app/(admin)/zoho-production-operations/page.tsx", guard: "requireSession" },
] as const;

describe("ACCESS-POLICY-1 · production role strings", () => {
  it("role checks use the exact uppercase production enum values", () => {
    const guardsSrc = repo("lib/auth-guards.ts");
    expect(guardsSrc).toMatch(/requireRole\("OWNER", "ADMIN"\)/);
    expect(guardsSrc).toMatch(/requireRole\("OWNER", "ADMIN", "MANAGER", "LEAD"\)/);
    expect(guardsSrc).toMatch(/requireRole\("OWNER"\)/);
    // No lowercase role literals anywhere in the guard module.
    expect(guardsSrc).not.toMatch(/"admin"|"owner"|"manager"|"lead"|"staff"/);
  });
});

describe("ACCESS-POLICY-1 · admin can reach every Reconciliation & Output page", () => {
  for (const { href, page, guard } of RECON_OUTPUT_PAGES) {
    it(`${href}: nav visible to ADMIN and OWNER, page guard is ${guard}`, () => {
      const item = navByHref.get(href);
      expect(item, `nav entry for ${href}`).toBeDefined();
      expect(roleMeetsNavMin("ADMIN", item!.minRole)).toBe(true);
      expect(roleMeetsNavMin("OWNER", item!.minRole)).toBe(true);
      // Route guard admits ADMIN: requireAdmin = OWNER|ADMIN;
      // requireSession = any signed-in role.
      expect(repo(page)).toMatch(new RegExp(`await ${guard}\\(\\)`));
    });
  }

  it("PO Closeout detail page also admits ADMIN", () => {
    expect(repo("app/(admin)/po-closeout/[poId]/page.tsx")).toMatch(
      /await requireAdmin\(\)/,
    );
  });
});

describe("ACCESS-POLICY-1 · nav visibility matches route guards", () => {
  it("ADMIN-guarded pages have minRole ADMIN in nav (never looser than the route)", () => {
    for (const { href, guard } of RECON_OUTPUT_PAGES) {
      const item = navByHref.get(href)!;
      if (guard === "requireAdmin") {
        expect(item.minRole, href).toBe("ADMIN");
      } else {
        // Session-guarded pages may be visible to all signed-in roles.
        expect(roleMeetsNavMin("STAFF", item.minRole), href).toBe(true);
      }
    }
  });
});

describe("ACCESS-POLICY-1 · lower roles do not gain admin access", () => {
  it("MANAGER / LEAD / STAFF never see the ADMIN-gated reconciliation links", () => {
    for (const role of ["MANAGER", "LEAD", "STAFF"] as const) {
      expect(roleMeetsNavMin(role, "ADMIN")).toBe(false);
    }
  });

  it("OWNER-only stays OWNER-only", () => {
    expect(roleMeetsNavMin("ADMIN", "OWNER")).toBe(false);
    expect(roleMeetsNavMin("OWNER", "OWNER")).toBe(true);
  });

  it("requireAdmin does not admit MANAGER or LEAD", () => {
    const guardsSrc = repo("lib/auth-guards.ts");
    expect(guardsSrc).toMatch(
      /export async function requireAdmin[\s\S]{0,80}requireRole\("OWNER", "ADMIN"\)/,
    );
  });
});

describe("ACCESS-POLICY-1 · stale-session semantics are known and documented", () => {
  it("session role comes from the signed cookie (role changes need re-login)", () => {
    const authSrc = repo("lib/auth.ts");
    expect(authSrc).toMatch(/role: payload\.role/);
    // 8h max age bounds how long a stale role can persist.
    expect(authSrc).toMatch(/COOKIE_MAX_AGE = 60 \* 60 \* 8/);
  });
});
