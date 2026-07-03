// Admin sidebar nav — hrefs, labels, and minimum role per item.
//
// minRole mirrors the guard on each destination page:
//   SESSION — requireSession() (STAFF+)
//   LEAD    — requireLead() (LEAD, MANAGER, ADMIN, OWNER)
//   ADMIN   — requireAdmin() (ADMIN, OWNER)

import type { CurrentUser } from "@/lib/auth";

export type UserRole = CurrentUser["role"];

/** Minimum role required to see a nav link (and access the page). */
export type NavMinRole = "SESSION" | "LEAD" | "ADMIN" | "OWNER";

export type AdminNavItemDef = {
  href: string;
  label: string;
  minRole: NavMinRole;
};

export type AdminNavSectionDef = {
  heading: string;
  items: AdminNavItemDef[];
};

const ROLE_RANK: Record<UserRole, number> = {
  STAFF: 0,
  LEAD: 1,
  MANAGER: 2,
  ADMIN: 3,
  OWNER: 4,
};

const MIN_ROLE_RANK: Record<NavMinRole, number> = {
  SESSION: ROLE_RANK.STAFF,
  LEAD: ROLE_RANK.LEAD,
  ADMIN: ROLE_RANK.ADMIN,
  OWNER: ROLE_RANK.OWNER,
};

export function roleMeetsNavMin(role: UserRole, minRole: NavMinRole): boolean {
  return ROLE_RANK[role] >= MIN_ROLE_RANK[minRole];
}

export const ADMIN_NAV_PINNED: AdminNavItemDef[] = [
  { href: "/dashboard", label: "Dashboard", minRole: "SESSION" },
  { href: "/floor-board", label: "Live floor", minRole: "SESSION" },
];

export const ADMIN_NAV_SECTIONS: AdminNavSectionDef[] = [
  {
    heading: "Intake & materials",
    items: [
      { href: "/inbound", label: "Receiving", minRole: "SESSION" },
      { href: "/packaging-inventory", label: "Materials", minRole: "ADMIN" },
      { href: "/batches", label: "Input lots", minRole: "SESSION" },
    ],
  },
  {
    heading: "Run production",
    items: [
      { href: "/workflow-submissions", label: "Workflows", minRole: "SESSION" },
      { href: "/partial-bags", label: "Partial Bag Workbench", minRole: "ADMIN" },
      { href: "/qc-review", label: "QC review", minRole: "ADMIN" },
      { href: "/shift-review", label: "Shift review", minRole: "ADMIN" },
    ],
  },
  {
    heading: "Reconciliation & output",
    items: [
      { href: "/packaging-output", label: "Production output", minRole: "SESSION" },
      { href: "/po-closeout", label: "PO closeout", minRole: "ADMIN" },
      { href: "/po-reconciliation", label: "PO reconciliation", minRole: "ADMIN" },
      { href: "/finished-lots", label: "Finished lots", minRole: "SESSION" },
      {
        href: "/zoho-production-operations",
        label: "Zoho production output",
        minRole: "SESSION",
      },
    ],
  },
  {
    heading: "Traceability & reporting",
    items: [
      { href: "/recall", label: "Traceability lookup", minRole: "SESSION" },
      { href: "/metrics", label: "Metrics", minRole: "SESSION" },
      { href: "/operator-productivity", label: "Productivity", minRole: "SESSION" },
      { href: "/reports/audit-log", label: "Audit log", minRole: "LEAD" },
    ],
  },
];

export const ADMIN_NAV_SETTINGS: AdminNavItemDef = {
  href: "/settings",
  label: "Settings",
  minRole: "SESSION",
};

export type FilteredAdminNav = {
  pinned: AdminNavItemDef[];
  sections: AdminNavSectionDef[];
  settings: AdminNavItemDef | null;
};

function filterItems(
  items: AdminNavItemDef[],
  role: UserRole,
): AdminNavItemDef[] {
  return items.filter((item) => roleMeetsNavMin(role, item.minRole));
}

/** Return only nav entries the signed-in role may see. Empty sections are dropped. */
export function filterAdminNavForRole(role: UserRole): FilteredAdminNav {
  const pinned = filterItems(ADMIN_NAV_PINNED, role);
  const sections = ADMIN_NAV_SECTIONS.map((sec) => ({
    heading: sec.heading,
    items: filterItems(sec.items, role),
  })).filter((sec) => sec.items.length > 0);
  const settings = roleMeetsNavMin(role, ADMIN_NAV_SETTINGS.minRole)
    ? ADMIN_NAV_SETTINGS
    : null;
  return { pinned, sections, settings };
}

/** Nav hrefs visible to a role — used by contract tests. */
export function visibleAdminNavHrefs(role: UserRole): string[] {
  const nav = filterAdminNavForRole(role);
  return [
    ...nav.pinned.map((i) => i.href),
    ...nav.sections.flatMap((s) => s.items.map((i) => i.href)),
    ...(nav.settings ? [nav.settings.href] : []),
  ];
}
