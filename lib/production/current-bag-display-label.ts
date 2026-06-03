export type CurrentBagDisplayLabelInput = {
  cardLabel: string | null | undefined;
  poNumber: string | null | undefined;
  tabletTypeName: string | null | undefined;
  productName: string | null | undefined;
  inventoryBagNumber: number | null | undefined;
  workflowBagNumber: number | null | undefined;
};

export type CurrentBagDisplayLabel = {
  primary: string;
  secondary: string | null;
  hasReceivedContext: boolean;
};

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildCurrentBagDisplayLabel(
  input: CurrentBagDisplayLabelInput,
): CurrentBagDisplayLabel {
  const cardLabel = clean(input.cardLabel);
  const poNumber = clean(input.poNumber);
  const tabletName = clean(input.tabletTypeName) ?? clean(input.productName);
  const bagNumber = input.inventoryBagNumber ?? input.workflowBagNumber ?? null;
  const parts = [
    poNumber ? `PO ${poNumber}` : null,
    tabletName,
    bagNumber != null ? `Bag ${bagNumber}` : null,
  ].filter((part): part is string => part != null);

  if (parts.length > 0) {
    return {
      primary: parts.join(" - "),
      secondary: cardLabel,
      hasReceivedContext: true,
    };
  }

  return {
    primary: cardLabel ?? "Current bag",
    secondary: null,
    hasReceivedContext: false,
  };
}
