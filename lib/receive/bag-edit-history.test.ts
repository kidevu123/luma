import { describe, it, expect } from "vitest";
import {
  bagEditCountLabel,
  formatAuditActionLabel,
  groupBagEditHistories,
  summarizeAuditRow,
} from "./bag-edit-history";
import type { AuditLogRow } from "@/lib/db/queries/audit-log";

function bagAudit(
  overrides: Partial<AuditLogRow> & { targetId: string },
): AuditLogRow {
  return {
    id: 1,
    createdAt: new Date("2026-05-27T12:00:00Z"),
    action: "inventory_bag.edit",
    targetType: "InventoryBag",
    before: null,
    after: null,
    actorRole: "LEAD",
    actorEmail: "lead@example.com",
    ...overrides,
  };
}

describe("summarizeAuditRow", () => {
  it("summarizes weight change in kg", () => {
    const lines = summarizeAuditRow({
      action: "inventory_bag.edit",
      before: { weightGrams: 1000 },
      after: { weightGrams: 1234, reason: "re-weighed" },
    });
    expect(lines.some((l) => l.includes("1.000 kg") && l.includes("1.234 kg"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("re-weighed"))).toBe(true);
  });

  it("summarizes QR token change", () => {
    const lines = summarizeAuditRow({
      action: "inventory_bag.edit",
      before: { bagQrCode: "bag-card-001" },
      after: { bagQrCode: "bag-card-002", reason: "damaged label" },
    });
    expect(lines.some((l) => l.includes("bag-card-001"))).toBe(true);
    expect(lines.some((l) => l.includes("bag-card-002"))).toBe(true);
  });

  it("summarizes qr_card.reserved_at_bag_edit", () => {
    const lines = summarizeAuditRow({
      action: "qr_card.reserved_at_bag_edit",
      before: { status: "IDLE", scanToken: "bag-card-002" },
      after: { status: "ASSIGNED", reason: "damaged label" },
    });
    expect(lines.some((l) => l.includes("bag-card-002"))).toBe(true);
    expect(lines.some((l) => l.includes("IDLE"))).toBe(true);
  });
});

describe("groupBagEditHistories", () => {
  it("groups bag audits per bag and attaches QR rows by scan token", () => {
    const bagId = "bag-aaa";
    const histories = groupBagEditHistories({
      bags: [
        {
          id: bagId,
          bagNumber: 1,
          internalReceiptNumber: "RCP-1",
          bagQrCode: "bag-card-002",
        },
      ],
      bagAudits: [
        bagAudit({
          id: 10,
          targetId: bagId,
          before: { bagQrCode: "bag-card-001" },
          after: { bagQrCode: "bag-card-002", reason: "swap" },
        }),
      ],
      qrAudits: [
        {
          id: 11,
          createdAt: new Date("2026-05-27T12:00:01Z"),
          action: "qr_card.reserved_at_bag_edit",
          targetType: "QrCard",
          targetId: "card-uuid",
          before: { status: "IDLE", scanToken: "bag-card-002" },
          after: { status: "ASSIGNED", reason: "swap" },
          actorRole: "LEAD",
          actorEmail: "lead@example.com",
        },
      ],
    });

    expect(histories).toHaveLength(1);
    expect(histories[0]?.entries.length).toBe(2);
    expect(histories[0]?.entries.some((e) => e.kind === "bag")).toBe(true);
    expect(histories[0]?.entries.some((e) => e.kind === "qr")).toBe(true);
  });

  it("returns empty entries when no audits", () => {
    const histories = groupBagEditHistories({
      bags: [{ id: "b1", bagNumber: 1, internalReceiptNumber: null, bagQrCode: null }],
      bagAudits: [],
      qrAudits: [],
    });
    expect(histories[0]?.entries).toHaveLength(0);
    expect(bagEditCountLabel(0)).toBe("No edits");
  });
});

describe("formatAuditActionLabel", () => {
  it("maps known actions to readable labels", () => {
    expect(formatAuditActionLabel("inventory_bag.edit")).toBe("Bag edited");
    expect(formatAuditActionLabel("qr_card.released_at_bag_edit")).toBe(
      "QR card released",
    );
  });
});
