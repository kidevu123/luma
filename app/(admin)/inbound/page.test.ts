import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("RECEIVE-NAV-1 · inbound/page.tsx CTA routing", () => {
  it("links to /receiving/raw-bags (Receive pills)", () => {
    expect(src).toMatch(/href="\/receiving\/raw-bags"/);
  });

  it("links to /inbound/packaging-materials (Receive packaging)", () => {
    expect(src).toMatch(/href="\/inbound\/packaging-materials"/);
  });

  it("does not promote /inbound/new as a primary action", () => {
    // /inbound/new must not appear in a <Button> or primary CTA context.
    // The page may reference it in comments but must not link to it.
    expect(src).not.toMatch(/href="\/inbound\/new"/);
  });

  it("uses Inbox icon for Receive pills button", () => {
    expect(src).toMatch(/Inbox/);
  });

  it("uses Boxes icon for Receive packaging button", () => {
    expect(src).toMatch(/Boxes/);
  });

  it("EmptyState also links to /receiving/raw-bags", () => {
    // Both the header actions and the empty-state action must use the new routes.
    const matches = [...src.matchAll(/href="\/receiving\/raw-bags"/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("EmptyState also links to /inbound/packaging-materials", () => {
    const matches = [...src.matchAll(/href="\/inbound\/packaging-materials"/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
