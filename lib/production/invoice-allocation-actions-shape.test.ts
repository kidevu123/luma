// COMMERCIAL-TRACE-5 — server-action safety + shape tests.
//
// We don't spin up a real Postgres in tests, so action behavior is
// covered by COMMERCIAL-TRACE-4's pure engine + DB-layer tests plus
// these source-level safety / shape guards on actions.ts and page.tsx.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ACTIONS_PATH = path.join(
  REPO_ROOT,
  "app",
  "(admin)",
  "invoice-allocations",
  "actions.ts",
);
const PAGE_PATH = path.join(
  REPO_ROOT,
  "app",
  "(admin)",
  "invoice-allocations",
  "page.tsx",
);
const CLIENT_PATH = path.join(
  REPO_ROOT,
  "app",
  "(admin)",
  "invoice-allocations",
  "invoice-allocation-actions.tsx",
);

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

/** Strip JS/TS `//` line comments and `/* ... *\/` block comments so
 *  source-shape assertions can target code, not commentary. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("COMMERCIAL-TRACE-5 · server actions", () => {
  const src = read(ACTIONS_PATH);

  it("declares 'use server'", () => {
    expect(src.split("\n", 5).join("\n")).toMatch(/['"]use server['"]/);
  });

  it("requires admin for every exported action", () => {
    const exported = [...src.matchAll(/export async function (\w+)/g)].map(
      (m) => m[1],
    );
    expect(exported).toEqual(
      expect.arrayContaining([
        "generateInvoiceLineAllocationSuggestionsAction",
        "regenerateInvoiceLineAllocationSuggestionsAction",
        "confirmInvoiceAllocationAction",
        "rejectInvoiceAllocationAction",
        "clearUnconfirmedInvoiceAllocationsAction",
      ]),
    );
    for (const fn of exported) {
      // Each exported action body must call requireAdmin().
      const body = src.match(
        new RegExp(`export async function ${fn}[\\s\\S]*?\\n}\\n`),
      );
      expect(body, `expected ${fn} to call requireAdmin`).not.toBeNull();
      expect(body![0]).toMatch(/requireAdmin\(\)/);
    }
  });

  it("never calls Zoho or Nexus from the action layer", () => {
    expect(src).not.toMatch(/fetchZohoInvoices|fetchZohoInvoice/);
    expect(src).not.toMatch(/from\s+["']@\/lib\/integrations\/zoho/);
    // Strip comments before checking for `nexus`/`Nexus` references —
    // the file's header comment legitimately documents that Nexus
    // customer-scope routes (later phases) must filter unconfirmed
    // allocations. We're guarding against code, not commentary.
    const codeOnly = stripComments(src);
    expect(codeOnly).not.toMatch(/nexus/i);
  });

  it("uses confirmAllocationPure (HIGH gate) inside confirmInvoiceAllocationAction", () => {
    const fn = src.match(
      /export async function confirmInvoiceAllocationAction[\s\S]*?\n}\n/,
    );
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/confirmAllocationPure\(/);
  });

  it("reject path rejects already-confirmed rows", () => {
    const fn = src.match(
      /export async function rejectInvoiceAllocationAction[\s\S]*?\n}\n/,
    );
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/Confirmed allocations cannot be rejected/);
  });

  it("clearUnconfirmed never touches confirmed=true rows", () => {
    // The action delegates to clearUnconfirmedSuggestionsForInvoiceLine
    // — the same helper whose SQL is asserted to filter on confirmed=
    // false in the COMMERCIAL-TRACE-4 safety tests.
    expect(src).toMatch(/clearUnconfirmedSuggestionsForInvoiceLine/);
  });

  it("writes one audit row per public action", () => {
    const auditCalls = [
      ...src.matchAll(/writeAudit\(\s*\{[\s\S]*?action:\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(auditCalls).toEqual(
      expect.arrayContaining([
        "invoice_allocation.generate",
        "invoice_allocation.regenerate",
        "invoice_allocation.confirm",
        "invoice_allocation.reject",
        "invoice_allocation.clear_unconfirmed",
      ]),
    );
  });

  it("confirm action only bumps shipment status from UNALLOCATED or SUGGESTED, never demotes", () => {
    const fn = src.match(
      /export async function confirmInvoiceAllocationAction[\s\S]*?\n}\n/,
    );
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/UNALLOCATED/);
    expect(fn![0]).toMatch(/SUGGESTED/);
    // The CONFIRMED / ALLOCATED states are not in the inArray filter.
    const inArrayMatch = fn![0].match(/inArray\(shipmentFinishedLots\.invoiceAllocationStatus,\s*\[([^\]]+)\]/);
    expect(inArrayMatch).not.toBeNull();
    const vals = inArrayMatch![1];
    expect(vals).not.toMatch(/CONFIRMED/);
    // ALLOCATED is the NEW state being set, not in the filter.
    expect(vals).not.toMatch(/"ALLOCATED"/);
  });
});

describe("COMMERCIAL-TRACE-5 · page", () => {
  const src = read(PAGE_PATH);

  it("renders the customer-safety banner", () => {
    expect(src).toMatch(
      /Only confirmed allocations should be used for Nexus invoice\/batch lookup/,
    );
  });

  it("renders five summary cards", () => {
    expect(src).toMatch(/Needs review/);
    expect(src).toMatch(/Suggested/);
    expect(src).toMatch(/Confirmed by operator/);
    expect(src).toMatch(/Rejected/);
    expect(src).toMatch(/Missing data/);
  });

  it("renders the filter form", () => {
    expect(src).toMatch(/name="invoice"/);
    expect(src).toMatch(/name="customer"/);
    expect(src).toMatch(/name="sku"/);
    expect(src).toMatch(/name="status"/);
    expect(src).toMatch(/name="confidence"/);
    expect(src).toMatch(/name="needs_review"/);
    expect(src).toMatch(/name="unconfirmed"/);
  });

  it("provides an honest empty state", () => {
    expect(src).toMatch(
      /No Zoho invoice lines available yet\. Invoice rows arrive via the apply phase/,
    );
  });

  it("calls requireAdmin at the top", () => {
    expect(src).toMatch(/requireAdmin\(\)/);
  });

  it("does not add any customer-facing endpoint or Nexus route", () => {
    expect(src).not.toMatch(/\/api\/nexus|app\/api\/nexus/);
  });

  it("page is server-rendered (dynamic = force-dynamic)", () => {
    expect(src).toMatch(/export const dynamic = "force-dynamic"/);
  });
});

describe("COMMERCIAL-TRACE-5 · client review actions component", () => {
  const src = read(CLIENT_PATH);

  it("declares 'use client'", () => {
    expect(src.split("\n", 3).join("\n")).toMatch(/['"]use client['"]/);
  });

  it("Confirm + Reject buttons only render when not yet confirmed and not rejected", () => {
    // Single conditional gates both buttons.
    expect(src).toMatch(/!row\.confirmed\s*&&\s*row\.status\s*!==\s*"REJECTED"/);
  });

  it("never tries to call Zoho or Nexus from the client", () => {
    expect(src).not.toMatch(/zoho|nexus/i);
  });
});

describe("COMMERCIAL-TRACE-5 · safety guardrails", () => {
  it("no Nexus endpoint, no complaint table added in this phase", () => {
    const actions = read(ACTIONS_PATH);
    const page = read(PAGE_PATH);
    const client = read(CLIENT_PATH);
    for (const s of [actions, page, client]) {
      expect(s).not.toMatch(/nexus_complaints|nexusComplaints/);
      expect(s).not.toMatch(/complaint_webhook/);
    }
    // Code (not comments) in actions + client must contain zero
    // references to nexus. The page may render the user-facing banner
    // copy mentioning "Nexus" — that's the honesty surface.
    expect(stripComments(actions)).not.toMatch(/nexus/i);
    expect(stripComments(client)).not.toMatch(/nexus/i);
  });

  it("/invoice-allocations is in the authenticated smoke list", () => {
    const smoke = fs.readFileSync(
      path.join(REPO_ROOT, "scripts", "smoke-authenticated-routes.ts"),
      "utf8",
    );
    expect(smoke).toMatch(/path:\s*"\/invoice-allocations"/);
  });
});
