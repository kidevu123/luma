import { describe, expect, it } from "vitest";
import {
  evaluateInventoryBagReadiness,
  evaluateQrCardReadiness,
  evaluateRawBagIntakeDraftReadiness,
  evaluateWorkflowBagReadiness,
  floorReadinessAdminLabel,
  floorReadinessDetailLines,
  floorReadinessOperatorMessage,
  isBagQrPlaceholder,
  type InventoryBagReadinessInput,
  type QrCardReadinessInput,
} from "./floor-readiness";

const readyBag = (): InventoryBagReadinessInput => ({
  internalReceiptNumber: "PO1-1-B1-1",
  tabletTypeId: "tablet-1",
  bagQrCode: "bag-card-100",
  hasReceiveContext: true,
  receivePoId: "po-1",
  qrCard: {
    cardType: "RAW_BAG",
    status: "ASSIGNED",
    assignedWorkflowBagId: null,
    scanToken: "bag-card-100",
  },
});

const readyCard = (): QrCardReadinessInput => ({
  cardType: "RAW_BAG",
  status: "ASSIGNED",
  assignedWorkflowBagId: null,
  scanToken: "bag-card-100",
});

describe("evaluateInventoryBagReadiness", () => {
  it("returns READY_FOR_FLOOR when receipt, tablet, physical QR, and receive context exist", () => {
    const r = evaluateInventoryBagReadiness(readyBag());
    expect(r.level).toBe("READY_FOR_FLOOR");
    expect(r.codes).toEqual([]);
  });

  it("QR-RESERVE-REPAIR-1: bag has a QR token but the card is IDLE → RESERVATION_LOST (not the generic 'receive and reserve')", () => {
    const r = evaluateInventoryBagReadiness({
      ...readyBag(),
      qrCard: {
        cardType: "RAW_BAG",
        status: "IDLE", // bag-card-199 scenario: reservation lost
        assignedWorkflowBagId: null,
        scanToken: "bag-card-199",
      },
    });
    expect(r.level).toBe("BLOCKED");
    expect(r.codes).toContain("BLOCKED_QR_RESERVATION_LOST");
    expect(r.codes).not.toContain("BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED");
    // Precise, actionable admin copy — NOT "Receive and reserve … on the Receive Pills page".
    expect(r.adminAction).toMatch(/idle .*reservation lost.*re-reserve/i);
    expect(r.adminAction).not.toMatch(/Receive Pills/i);
    // The reason line is specific.
    const lines = floorReadinessDetailLines(r);
    expect(lines.blocked.join(" ")).toMatch(/idle .*reservation lost/i);
  });

  it("a correctly reserved (ASSIGNED) QR on the same bag is READY", () => {
    const r = evaluateInventoryBagReadiness(readyBag());
    expect(r.level).toBe("READY_FOR_FLOOR");
  });

  it("v1.21.0: IN_USE bag + idle QR is a production-state review, NOT a re-reservable lost reservation", () => {
    const r = evaluateInventoryBagReadiness({
      ...readyBag(),
      bagStatus: "IN_USE",
      qrCard: { cardType: "RAW_BAG", status: "IDLE", assignedWorkflowBagId: null, scanToken: "bag-card-121" },
    });
    expect(r.codes).toContain("WARNING_QR_IDLE_IN_PRODUCTION");
    // Must NOT offer intake re-reservation for a production bag, and must NOT
    // imply it is a re-reservable lost reservation.
    expect(r.codes).not.toContain("BLOCKED_QR_RESERVATION_LOST");
    expect(r.adminAction).toMatch(/past intake|finished history|not a re-reservable/i);
    expect(r.adminAction).not.toMatch(/re-reserve it here/i);
  });

  it("v1.21.0: EMPTIED/DEPLETED bag + idle QR is 'no reservation needed', not a lost reservation", () => {
    for (const s of ["EMPTIED", "DEPLETED"]) {
      const r = evaluateInventoryBagReadiness({
        ...readyBag(),
        bagStatus: s,
        qrCard: { cardType: "RAW_BAG", status: "IDLE", assignedWorkflowBagId: null, scanToken: "bag-card-107" },
      });
      expect(r.codes).toContain("WARNING_QR_IDLE_BAG_DEPLETED");
      expect(r.codes).not.toContain("BLOCKED_QR_RESERVATION_LOST");
    }
  });

  it("v1.21.0: AVAILABLE (and unspecified) bag + idle QR keeps the re-reservable RESERVATION_LOST code", () => {
    const idleCard = { cardType: "RAW_BAG", status: "IDLE", assignedWorkflowBagId: null, scanToken: "bag-card-199" } as const;
    expect(
      evaluateInventoryBagReadiness({ ...readyBag(), bagStatus: "AVAILABLE", qrCard: { ...idleCard } }).codes,
    ).toContain("BLOCKED_QR_RESERVATION_LOST");
    // Back-compat: no bagStatus supplied → treated as floor-eligible.
    expect(
      evaluateInventoryBagReadiness({ ...readyBag(), qrCard: { ...idleCard } }).codes,
    ).toContain("BLOCKED_QR_RESERVATION_LOST");
  });

  it("a QR active in another workflow warns (review before floor), not a generic block", () => {
    const r = evaluateInventoryBagReadiness({
      ...readyBag(),
      qrCard: {
        cardType: "RAW_BAG",
        status: "ASSIGNED",
        assignedWorkflowBagId: "wf-other",
        scanToken: "bag-card-100",
      },
    });
    expect(r.codes).toContain("WARNING_ALREADY_ASSIGNED_OR_ACTIVE");
  });

  it("the floor-scan path (evaluateQrCardReadiness of an IDLE card) keeps the generic NOT_ASSIGNED code", () => {
    const r = evaluateQrCardReadiness({
      cardType: "RAW_BAG",
      status: "IDLE",
      assignedWorkflowBagId: null,
      scanToken: "bag-card-199",
      inventoryBag: null,
    });
    expect(r.codes).toContain("BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED");
    expect(r.codes).not.toContain("BLOCKED_QR_RESERVATION_LOST");
  });

  it("blocks missing receipt", () => {
    const r = evaluateInventoryBagReadiness({
      ...readyBag(),
      internalReceiptNumber: null,
    });
    expect(r.level).toBe("BLOCKED");
    expect(r.codes).toContain("BLOCKED_MISSING_RECEIPT");
  });

  it("blocks missing tablet", () => {
    const r = evaluateInventoryBagReadiness({
      ...readyBag(),
      tabletTypeId: null,
    });
    expect(r.level).toBe("BLOCKED");
    expect(r.codes).toContain("BLOCKED_MISSING_TABLET");
  });

  it("blocks missing physical QR link", () => {
    const r = evaluateInventoryBagReadiness({
      ...readyBag(),
      bagQrCode: null,
      qrCard: null,
    });
    expect(r.codes).toContain("BLOCKED_MISSING_QR_LINK");
  });

  it("blocks BAG- placeholder without matching qr_cards row", () => {
    expect(isBagQrPlaceholder("BAG-uuid")).toBe(true);
    const r = evaluateInventoryBagReadiness({
      ...readyBag(),
      bagQrCode: "BAG-11111111-1111-1111-1111-111111111111",
      qrCard: null,
    });
    expect(r.codes).toContain("WARNING_BAG_QR_PLACEHOLDER_ONLY");
    expect(r.codes).toContain("BLOCKED_MISSING_QR_LINK");
  });

  it("warns when receive has no PO but does not block if otherwise ready", () => {
    const r = evaluateInventoryBagReadiness({
      ...readyBag(),
      receivePoId: null,
    });
    expect(r.codes).toContain("WARNING_INCOMPLETE_OPTIONAL_CONTEXT");
    expect(r.level).toBe("WARNING");
  });

  it("blocks broken receive chain", () => {
    const r = evaluateInventoryBagReadiness({
      ...readyBag(),
      hasReceiveContext: false,
    });
    expect(r.codes).toContain("BLOCKED_MISSING_PO_OR_RECEIVE_CONTEXT");
    expect(r.level).toBe("BLOCKED");
  });
});

describe("evaluateQrCardReadiness", () => {
  it("blocks QR with no inventory bag", () => {
    const r = evaluateQrCardReadiness({
      ...readyCard(),
      inventoryBag: null,
    });
    expect(r.codes).toContain("BLOCKED_MISSING_INVENTORY_BAG_LINK");
    expect(floorReadinessOperatorMessage(r)).toMatch(/not linked to a received bag/i);
  });

  it("blocks IDLE QR", () => {
    const r = evaluateQrCardReadiness({
      cardType: "RAW_BAG",
      status: "IDLE",
      assignedWorkflowBagId: null,
      scanToken: "bag-card-200",
      inventoryBag: null,
    });
    expect(r.codes).toContain("BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED");
  });

  it("blocks active workflow assignment on fresh scan", () => {
    const r = evaluateQrCardReadiness({
      ...readyCard(),
      assignedWorkflowBagId: "wf-active",
      inventoryBag: readyBag(),
    });
    expect(r.codes).toContain("BLOCKED_QR_ALREADY_ACTIVE");
  });

  it("allows stale ASSIGNED workflow when allowPartialBagRestart (bag-card-104 restart)", () => {
    const r = evaluateQrCardReadiness({
      ...readyCard(),
      assignedWorkflowBagId: "3d026c01-4521-4825-9c08-3e8e9bd87196",
      inventoryBag: readyBag(),
      allowPartialBagRestart: true,
    });
    expect(r.codes).not.toContain("BLOCKED_QR_ALREADY_ACTIVE");
    expect(r.level).toBe("READY_FOR_FLOOR");
  });

  it("allows IDLE card when allowPartialBagRestart for partial floor start", () => {
    const r = evaluateQrCardReadiness({
      cardType: "RAW_BAG",
      status: "IDLE",
      assignedWorkflowBagId: null,
      scanToken: "bag-card-104",
      inventoryBag: readyBag(),
      allowPartialBagRestart: true,
    });
    expect(r.codes).not.toContain("BLOCKED_QR_NOT_ASSIGNED_OR_RESERVED");
    expect(r.level).toBe("READY_FOR_FLOOR");
  });

  it("allows intake-reserved ready card + bag", () => {
    const r = evaluateQrCardReadiness({
      ...readyCard(),
      inventoryBag: readyBag(),
    });
    expect(r.level).toBe("READY_FOR_FLOOR");
  });
});

describe("evaluateWorkflowBagReadiness", () => {
  it("legacy receipt alone does not make bag ready", () => {
    const r = evaluateWorkflowBagReadiness({
      inventoryBagId: null,
      legacyReceiptNumber: "OLD-99",
      productId: null,
      inventoryBag: null,
      qrCard: null,
    });
    expect(r.codes).toContain("BLOCKED_MISSING_INVENTORY_BAG_LINK");
    expect(r.codes).toContain("WARNING_LEGACY_BAG");
    expect(r.level).toBe("BLOCKED");
  });

  it("missing product is warning only (deferred to sealing)", () => {
    const r = evaluateWorkflowBagReadiness({
      inventoryBagId: "inv-1",
      legacyReceiptNumber: null,
      productId: null,
      inventoryBag: readyBag(),
      qrCard: readyCard(),
    });
    expect(r.codes).toContain("WARNING_PRODUCT_DEFERRED_TO_SEALING");
    expect(r.level).not.toBe("BLOCKED");
  });
});

describe("floorReadinessOperatorMessage", () => {
  it("never includes internal ids", () => {
    const msg = floorReadinessOperatorMessage({
      level: "BLOCKED",
      codes: ["BLOCKED_MISSING_RECEIPT"],
      adminAction: null,
    });
    expect(msg).toMatch(/not ready for the floor/i);
    expect(msg).not.toMatch(/uuid/i);
    expect(msg).not.toMatch(/[0-9a-f]{8}-/i);
  });
});

describe("evaluateRawBagIntakeDraftReadiness", () => {
  it("ready when receipt, tablet, physical QR, and receive context are present", () => {
    const r = evaluateRawBagIntakeDraftReadiness({
      receiptNumber: "PO1-1-B1-1",
      tabletTypeId: "tablet-1",
      bagQrCode: "bag-card-100",
      hasReceiveContext: true,
      receivePoId: "po-1",
    });
    expect(r.level).toBe("READY_FOR_FLOOR");
  });

  it("blocked when tablet type missing", () => {
    const r = evaluateRawBagIntakeDraftReadiness({
      receiptNumber: "PO1-1-B1-1",
      tabletTypeId: null,
      bagQrCode: "bag-card-100",
      hasReceiveContext: true,
      receivePoId: "po-1",
    });
    expect(r.level).toBe("BLOCKED");
    const lines = floorReadinessDetailLines(r);
    expect(lines.blocked.some((l) => /tablet/i.test(l))).toBe(true);
    expect(lines.blocked.join(" ")).not.toMatch(/BLOCKED_/);
  });

  it("blocked when physical QR missing", () => {
    const r = evaluateRawBagIntakeDraftReadiness({
      receiptNumber: "PO1-1-B1-1",
      tabletTypeId: "tablet-1",
      bagQrCode: null,
      hasReceiveContext: true,
      receivePoId: "po-1",
    });
    expect(r.codes).toContain("BLOCKED_MISSING_QR_LINK");
    const lines = floorReadinessDetailLines(r);
    expect(lines.blocked.some((l) => /QR/i.test(l))).toBe(true);
  });
});

describe("floorReadinessDetailLines", () => {
  it("separates warnings from blockers", () => {
    const r = evaluateInventoryBagReadiness({
      ...readyBag(),
      receivePoId: null,
    });
    const lines = floorReadinessDetailLines(r);
    expect(lines.warnings.length).toBeGreaterThan(0);
    expect(lines.blocked).toHaveLength(0);
  });

  it("uses admin Blocked label for blocked level", () => {
    expect(
      floorReadinessAdminLabel({
        level: "BLOCKED",
        codes: ["BLOCKED_MISSING_TABLET"],
        adminAction: null,
      }),
    ).toBe("Blocked");
  });
});
