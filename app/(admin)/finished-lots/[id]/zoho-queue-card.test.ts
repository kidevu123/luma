import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "zoho-queue-card.tsx"), "utf8");

describe("zoho-queue-card · ZohoOpStatusChip reuse (D-1)", () => {
  it("imports the shared ZohoOpStatusChip instead of a local duplicate", () => {
    expect(src).toMatch(
      /from "@\/app\/\(admin\)\/zoho-operations\/_status-chip"/,
    );
    expect(src).toContain("ZohoOpStatusChip");
    expect(src).not.toMatch(/function OpStatusChip\(/);
  });
});
