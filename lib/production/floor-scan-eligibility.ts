export type FloorScanCard = {
  cardType: string;
  status: string;
  assignedWorkflowBagId: string | null | undefined;
};

export type FloorScanClassification =
  | { eligible: true; isIntakeReserved: boolean }
  | { eligible: false; reason: string };

export function classifyFloorScanCard(card: FloorScanCard): FloorScanClassification {
  if (card.cardType !== "RAW_BAG") {
    return {
      eligible: false,
      reason:
        "This is not a bag QR. Scan a bag label — not a variety pack or traveler card.",
    };
  }
  if (card.status === "RETIRED") {
    return {
      eligible: false,
      reason: "This bag QR has been retired and can no longer be used.",
    };
  }
  if (card.status === "IDLE") {
    return {
      eligible: false,
      reason:
        "This bag QR has not been linked to a received bag. Receive the bag first on the Receive Pills page.",
    };
  }
  if (card.status !== "ASSIGNED") {
    return { eligible: false, reason: "Unexpected card status." };
  }
  return {
    eligible: true,
    isIntakeReserved: !card.assignedWorkflowBagId,
  };
}
