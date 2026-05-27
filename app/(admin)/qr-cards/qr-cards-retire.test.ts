import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const formsSrc = readFileSync(join(__dirname, "forms.tsx"), "utf8");
const listSrc = readFileSync(join(__dirname, "qr-cards-list.tsx"), "utf8");
const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");

describe("QR-CARDS-RETIRE-1 · Retire UI wiring", () => {
  it("RetireButton calls retireQrCardAction with the card id", () => {
    expect(formsSrc).toMatch(/retireQrCardAction\(id\)/);
    expect(formsSrc).toMatch(/from "\.\/actions"/);
  });

  it("refreshes the page after a successful retire", () => {
    expect(formsSrc).toMatch(/useRouter/);
    expect(formsSrc).toMatch(/router\.refresh\(\)/);
  });

  it("shows inline error text on failure", () => {
    expect(formsSrc).toMatch(/setError\(r\.error\)/);
    expect(formsSrc).toMatch(/text-red-700/);
    expect(formsSrc).not.toMatch(/title=\{\s*error/);
  });

  it("list disables retire only for mid-production cards", () => {
    expect(listSrc).toMatch(/isQrCardMidProduction\(card\)/);
    expect(listSrc).not.toMatch(/disabled=\{card\.status === "ASSIGNED"\}/);
  });

  it("server action revalidates /qr-cards", () => {
    expect(actionsSrc).toMatch(/revalidatePath\("\/qr-cards"\)/);
  });
});
