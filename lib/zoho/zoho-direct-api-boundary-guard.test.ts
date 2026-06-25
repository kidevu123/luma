// Z-2 — forbid reintroducing direct Zoho OAuth/API calls in Luma runtime code.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { grepRepo, readRepoSource, REPO_ROOT } from "@/lib/test/source-scan";

function runtimeHits(pattern: string): string[] {
  return grepRepo(pattern, { includes: ["*.ts", "*.tsx"] }).filter((line) => {
    if (line.includes(".test.ts:") || line.includes(".test.tsx:")) return false;
    if (line.includes("node_modules/") || line.includes(".next/")) return false;
    return true;
  });
}

describe("Z-2 · direct Zoho API boundary guards", () => {
  it("runtime code does not reference zohoapis.com (except credential-form UI labels)", () => {
    const hits = runtimeHits("zohoapis\\.com").filter(
      (line) => !line.startsWith("app/(admin)/settings/zoho/form.tsx:"),
    );
    expect(
      hits,
      `Direct zohoapis.com reference found in runtime code:\n${hits.join("\n")}`,
    ).toEqual([]);
  });

  it("runtime code does not use Zoho-oauthtoken", () => {
    const hits = runtimeHits("Zoho-oauthtoken");
    expect(
      hits,
      `Zoho-oauthtoken header found in runtime code:\n${hits.join("\n")}`,
    ).toEqual([]);
  });

  it("legacy lib/zoho/client.ts is removed", () => {
    expect(existsSync(resolve(REPO_ROOT, "lib/zoho/client.ts"))).toBe(false);
  });

  it("settings Zoho test action probes the integration-service gateway", () => {
    const src = readRepoSource("app/(admin)/settings/zoho/actions.ts");
    expect(src).toMatch(/checkZohoGatewayHealth/);
    expect(src).toMatch(/fetchZohoBrandStatus/);
    expect(src).toMatch(/deriveZohoReadiness/);
    expect(src).not.toMatch(/@\/lib\/zoho\/client/);
    expect(src).not.toMatch(/\btestConnection\b/);
  });

  it("no app/runtime module imports lib/zoho/client", () => {
    const hits = runtimeHits('@/lib/zoho/client').filter(
      (line) => !line.startsWith("lib/zoho/zoho-direct-api-boundary-guard.test.ts:"),
    );
    expect(
      hits,
      `Unexpected lib/zoho/client import:\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
