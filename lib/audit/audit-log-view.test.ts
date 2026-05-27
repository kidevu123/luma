import { describe, it, expect } from "vitest";
import {
  buildAuditLogViewRow,
  formatAuditTargetLabel,
  summarizeGenericAuditDiff,
} from "./audit-log-view";
import type { AuditLogRow } from "@/lib/db/queries/audit-log";

function row(
  partial: Partial<AuditLogRow> & Pick<AuditLogRow, "action">,
): AuditLogRow {
  return {
    id: 1,
    createdAt: new Date("2026-05-27T12:00:00Z"),
    targetType: "InventoryBag",
    targetId: "00000000-0000-0000-0000-000000000001",
    before: null,
    after: null,
    actorRole: "ADMIN",
    actorEmail: "lead@example.com",
    ...partial,
  };
}

describe("AUDIT-LOG-1 · formatAuditTargetLabel", () => {
  it("shortens long target ids", () => {
    expect(
      formatAuditTargetLabel(
        "WorkflowBag",
        "abcdef12-3456-7890-abcd-ef1234567890",
      ),
    ).toMatch(/WorkflowBag · abcdef12…/);
  });
});

describe("AUDIT-LOG-1 · summarizeGenericAuditDiff", () => {
  it("lists changed scalar fields", () => {
    const lines = summarizeGenericAuditDiff(
      { sku: "OLD", qty: 1 },
      { sku: "NEW", qty: 1 },
    );
    expect(lines).toEqual(["sku: OLD → NEW"]);
  });
});

describe("AUDIT-LOG-1 · buildAuditLogViewRow", () => {
  it("formats inventory bag edit with human-readable summary", () => {
    const v = buildAuditLogViewRow(
      row({
        action: "inventory_bag.edit",
        before: { weightGrams: 1000, notes: "a" },
        after: { weightGrams: 1100, notes: "b", reason: "typo" },
      }),
    );
    expect(v.actionLabel).toBe("Bag edited");
    expect(v.summaryLine).toMatch(/Weight/);
    expect(v.detailLines.some((l) => l.includes("Reason"))).toBe(true);
  });

  it("uses generic diff for unknown actions with before/after", () => {
    const v = buildAuditLogViewRow(
      row({
        action: "floor.card_assigned",
        targetType: "WorkflowBag",
        before: null,
        after: { card_id: "abc", station_id: "def" },
      }),
    );
    expect(v.actionLabel).toMatch(/floor.card assigned/i);
    expect(v.hasRawDetails).toBe(true);
  });

  it("shows actor email when present", () => {
    const v = buildAuditLogViewRow(row({ action: "machine.create" }));
    expect(v.actorLabel).toBe("lead@example.com");
  });
});
