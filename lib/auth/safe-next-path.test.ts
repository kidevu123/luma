// SSO-NEXT-1 — this helper is the only thing standing between a crafted
// ?next= and an off-site redirect. Test the attacks explicitly.

import { describe, it, expect } from "vitest";
import { safeNextPath } from "./safe-next-path";

describe("safeNextPath — accepts genuine deep links", () => {
  it("keeps a plain path", () => {
    expect(safeNextPath("/po-closeout/abc")).toBe("/po-closeout/abc");
  });
  it("preserves query strings and hashes (closeout deep links carry tabs)", () => {
    expect(safeNextPath("/po-closeout/abc?tab=zoho&empty=1")).toBe("/po-closeout/abc?tab=zoho&empty=1");
    expect(safeNextPath("/workflow-submissions?bag=x#row")).toBe("/workflow-submissions?bag=x#row");
  });
  it("keeps the bare root", () => {
    expect(safeNextPath("/")).toBe("/");
  });
});

describe("safeNextPath — rejects everything that could leave the site", () => {
  const fallback = "/dashboard";
  it("absolute URLs", () => {
    expect(safeNextPath("https://evil.example/x")).toBe(fallback);
    expect(safeNextPath("http://evil.example")).toBe(fallback);
  });
  it("protocol-relative URLs (the classic //host bypass)", () => {
    expect(safeNextPath("//evil.example/x")).toBe(fallback);
    expect(safeNextPath("///evil.example")).toBe(fallback);
  });
  it("backslash variants (WHATWG treats \\ as / for special schemes)", () => {
    expect(safeNextPath("/\\evil.example")).toBe(fallback);
    expect(safeNextPath("\\\\evil.example")).toBe(fallback);
  });
  it("non-path schemes", () => {
    expect(safeNextPath("javascript:alert(1)")).toBe(fallback);
    expect(safeNextPath("data:text/html,x")).toBe(fallback);
  });
  it("relative paths without a leading slash", () => {
    expect(safeNextPath("dashboard")).toBe(fallback);
    expect(safeNextPath("../etc")).toBe(fallback);
  });
  it("control characters (header/redirect smuggling)", () => {
    expect(safeNextPath("/ok\nSet-Cookie: a=b")).toBe(fallback);
    expect(safeNextPath("/ok\r\nx")).toBe(fallback);
    expect(safeNextPath("/ok\u0000bad")).toBe(fallback);
  });
  it("surrounding whitespace is trimmed, not treated as an attack", () => {
    expect(safeNextPath("  /po-closeout/abc  ")).toBe("/po-closeout/abc");
  });
  it("empty, whitespace, missing, and absurdly long values", () => {
    expect(safeNextPath("")).toBe(fallback);
    expect(safeNextPath("   ")).toBe(fallback);
    expect(safeNextPath(null)).toBe(fallback);
    expect(safeNextPath(undefined)).toBe(fallback);
    expect(safeNextPath(`/${"a".repeat(2000)}`)).toBe(fallback);
  });
  it("never returns the login page itself (no redirect loop)", () => {
    expect(safeNextPath("/login")).toBe(fallback);
    expect(safeNextPath("/login?next=/x")).toBe(fallback);
  });
  it("honors an explicit fallback", () => {
    expect(safeNextPath("https://evil.example", "/floor-board")).toBe("/floor-board");
  });
});

describe("safeNextPath — the accepted values are genuinely same-origin", () => {
  it("every accepted value resolves back to the app origin", () => {
    const base = "https://luma.example";
    for (const candidate of ["/po-closeout/abc?tab=zoho", "/", "/finished-lots/new?bagId=1"]) {
      expect(new URL(safeNextPath(candidate), base).origin).toBe(base);
    }
  });
  it("every rejected value would NOT have (proving the guard earns its keep)", () => {
    const base = "https://luma.example";
    for (const attack of ["//evil.example/x", "/\\evil.example", "https://evil.example"]) {
      expect(new URL(safeNextPath(attack), base).origin).toBe(base);
    }
  });
});
