/** True when the card is on an active workflow bag and must not be retired. */
export function isQrCardMidProduction(card: {
  status: string;
  assignedWorkflowBagId: string | null;
}): boolean {
  return card.status === "ASSIGNED" && card.assignedWorkflowBagId !== null;
}
