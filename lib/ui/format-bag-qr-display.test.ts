import { describe, expect, it } from "vitest";
import { formatBagQrForDisplay } from "./format-bag-qr-display";

describe("formatBagQrForDisplay", () => {
  it("labels BAG- placeholder honestly", () => {
    const r = formatBagQrForDisplay("BAG-11111111-1111-1111-1111-111111111111");
    expect(r.primary).toMatch(/placeholder/i);
    expect(r.isPlaceholder).toBe(true);
    expect(r.secondary).toContain("BAG-");
  });

  it("shows physical floor card token as primary", () => {
    const r = formatBagQrForDisplay("bag-card-117");
    expect(r.primary).toBe("bag-card-117");
    expect(r.isPlaceholder).toBe(false);
  });

  it("shows Missing for empty", () => {
    expect(formatBagQrForDisplay(null).primary).toBe("Missing");
  });
});
