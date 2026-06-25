// Settings hub links — minRole mirrors each destination page guard.

import {
  roleMeetsNavMin,
  type NavMinRole,
  type UserRole,
} from "@/lib/auth/admin-nav";

export type SettingsHubIcon =
  | "Users"
  | "PackageCheck"
  | "Pill"
  | "Sliders"
  | "Activity"
  | "Gauge"
  | "ShieldCheck"
  | "ClipboardCheck"
  | "Wrench"
  | "QrCode"
  | "Plug"
  | "Webhook"
  | "Receipt"
  | "Scale";

/** Which aggregate count to show beside a link, when available. */
export type SettingsHubCountKey =
  | "users"
  | "products"
  | "tablets"
  | "machinesStations"
  | "packagingMaterials"
  | "qrCards";

export type SettingsHubItemDef = {
  href: string;
  icon: SettingsHubIcon;
  label: string;
  hint: string;
  minRole: NavMinRole;
  countKey?: SettingsHubCountKey;
};

export type SettingsHubSectionDef = {
  heading: string;
  items: SettingsHubItemDef[];
};

export const SETTINGS_HUB_SECTIONS: SettingsHubSectionDef[] = [
  {
    heading: "Team",
    items: [
      {
        href: "/settings/users",
        icon: "Users",
        label: "Users",
        countKey: "users",
        hint: "manage roles and access",
        minRole: "ADMIN",
      },
    ],
  },
  {
    heading: "Production setup",
    items: [
      {
        href: "/products",
        icon: "PackageCheck",
        label: "Products",
        countKey: "products",
        hint: "finished SKUs and bill of materials",
        minRole: "ADMIN",
      },
      {
        href: "/tablet-types",
        icon: "Pill",
        label: "Tablet types",
        countKey: "tablets",
        hint: "raw pill catalog",
        minRole: "ADMIN",
      },
      {
        href: "/machines",
        icon: "Sliders",
        label: "Machines & stations",
        countKey: "machinesStations",
        hint: "machines and floor stations",
        minRole: "ADMIN",
      },
      {
        href: "/settings/materials",
        icon: "PackageCheck",
        label: "Packaging & Materials",
        countKey: "packagingMaterials",
        hint: "blister cards, display boxes, master cases, labels, foil",
        minRole: "ADMIN",
      },
      {
        href: "/product-packaging-requirements",
        icon: "PackageCheck",
        label: "Product requirements",
        hint: "packaging spec per product — which materials and quantities each SKU needs",
        minRole: "ADMIN",
      },
      {
        href: "/settings/blister-standards",
        icon: "Activity",
        label: "Blister roll yield",
        hint: "How many blisters per kg and per full PVC/foil roll — start here",
        minRole: "ADMIN",
      },
    ],
  },
  {
    heading: "Workflow",
    items: [
      {
        href: "/standards",
        icon: "Gauge",
        label: "Standards & targets",
        hint: "OEE, labor rates, due targets, production calendars",
        minRole: "ADMIN",
      },
      {
        href: "/workflow-validation",
        icon: "ShieldCheck",
        label: "Workflow validation",
        hint: "readiness board — verifies all floor workflows are configured",
        minRole: "ADMIN",
      },
      {
        href: "/shift-review",
        icon: "ClipboardCheck",
        label: "Shift review",
        hint: "read-only post-shift blister counter review — flags only, no repair",
        minRole: "ADMIN",
      },
      {
        href: "/settings/missed-bag-backfill",
        icon: "Wrench",
        label: "Missed bag backfill",
        hint: "admin — record a blister bag that was run but never scanned on the floor",
        minRole: "ADMIN",
      },
      {
        href: "/qr-cards",
        icon: "QrCode",
        label: "QR cards",
        countKey: "qrCards",
        hint: "physical scan badges for bags and travelers",
        minRole: "ADMIN",
      },
    ],
  },
  {
    heading: "Integrations",
    items: [
      {
        href: "/settings/integrations/zoho",
        icon: "Plug",
        label: "Zoho Inventory",
        hint: "push finished lots as purchase receives",
        minRole: "ADMIN",
      },
      {
        href: "/settings/integrations/packtrack",
        icon: "Webhook",
        label: "PackTrack",
        hint: "packaging receipt sync from the station scanner",
        minRole: "ADMIN",
      },
      {
        href: "/zoho-production-operations",
        icon: "Webhook",
        label: "Zoho production output",
        hint: "current consolidated production-output queue — operator review and approve",
        minRole: "SESSION",
      },
      {
        href: "/zoho-operations",
        icon: "Webhook",
        label: "Zoho operations (legacy)",
        hint: "legacy atomic-ops history — current finished-lot writes use Zoho production output",
        minRole: "SESSION",
      },
      {
        href: "/settings/legacy-import",
        icon: "Plug",
        label: "Legacy import",
        hint: "pull the legacy DB dump from PythonAnywhere — owner only",
        minRole: "OWNER",
      },
    ],
  },
  {
    heading: "Analytics",
    items: [
      {
        href: "/invoice-allocations",
        icon: "Receipt",
        label: "Invoice allocations",
        hint: "match supplier invoices to received lots for cost accounting",
        minRole: "ADMIN",
      },
      {
        href: "/material-reconciliation",
        icon: "Scale",
        label: "Material reconciliation",
        hint: "compare expected vs actual material consumption per batch",
        minRole: "SESSION",
      },
    ],
  },
];

export type SettingsHubCounts = {
  users: number;
  products: number;
  tablets: number;
  machines: number;
  stations: number;
  packagingMaterials: number;
  qrCardsTotal: number;
  qrCardsIdle: number;
  qrCardsAssigned: number;
  qrCardsRetired: number;
};

function filterItems(
  items: SettingsHubItemDef[],
  role: UserRole,
): SettingsHubItemDef[] {
  return items.filter((item) => roleMeetsNavMin(role, item.minRole));
}

/** Return only settings hub sections/links the signed-in role may see. */
export function filterSettingsHubForRole(role: UserRole): SettingsHubSectionDef[] {
  return SETTINGS_HUB_SECTIONS.map((sec) => ({
    heading: sec.heading,
    items: filterItems(sec.items, role),
  })).filter((sec) => sec.items.length > 0);
}

export function canAccessDangerZone(role: UserRole): boolean {
  return roleMeetsNavMin(role, "OWNER");
}

export function resolveSettingsHubCount(
  item: SettingsHubItemDef,
  counts: SettingsHubCounts,
): number | undefined {
  switch (item.countKey) {
    case "users":
      return counts.users;
    case "products":
      return counts.products;
    case "tablets":
      return counts.tablets;
    case "machinesStations":
      return counts.machines + counts.stations;
    case "packagingMaterials":
      return counts.packagingMaterials;
    case "qrCards":
      return counts.qrCardsTotal;
    default:
      return undefined;
  }
}

export function settingsHubHint(
  item: SettingsHubItemDef,
  counts: SettingsHubCounts,
): string {
  if (item.countKey === "qrCards") {
    return `${counts.qrCardsIdle} idle · ${counts.qrCardsAssigned} assigned · ${counts.qrCardsRetired} retired`;
  }
  if (item.countKey === "machinesStations") {
    return `${counts.machines} machines · ${counts.stations} stations`;
  }
  return item.hint;
}

/** Hrefs visible on the settings hub for a role — used by contract tests. */
export function visibleSettingsHubHrefs(role: UserRole): string[] {
  return filterSettingsHubForRole(role).flatMap((sec) =>
    sec.items.map((item) => item.href),
  );
}
