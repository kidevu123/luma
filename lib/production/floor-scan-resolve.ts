// Floor scan token resolution — prefer assigned workflow pickup cards
// over idle pool cards when the operator scans a reusable bag-card token.

import { numericSuffix } from "@/lib/production/qr-sort";

export type FloorScanCardCandidate = {
  id: string;
  label: string;
  scanToken: string;
  cardType: string;
  status: string;
  assignedWorkflowBagId: string | null | undefined;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeFloorScanInput(raw: string): string {
  return raw.trim();
}

/** True when typed/scanned input plausibly refers to this card. */
export function floorScanInputMatchesCard(
  input: string,
  card: Pick<FloorScanCardCandidate, "id" | "label" | "scanToken">,
): boolean {
  const token = normalizeFloorScanInput(input);
  if (!token) return false;
  const lower = token.toLowerCase();
  if (card.scanToken.toLowerCase() === lower) return true;
  if (UUID_RE.test(token) && card.id === token) return true;
  if (card.label.toLowerCase() === lower) return true;

  const inputSuffix = numericSuffix(token);
  const labelSuffix = numericSuffix(card.label);
  if (inputSuffix > 0 && inputSuffix === labelSuffix) {
    const inputLooksLikeBagCard =
      /bag[-\s]?card/i.test(token) || /^bag-card-/i.test(token);
    const labelLooksLikeBagCard =
      /bag\s+card/i.test(card.label) || /^bag-card-/i.test(card.label);
    if (inputLooksLikeBagCard && labelLooksLikeBagCard) return true;
  }
  return false;
}

export type PickFloorScanCardOptions = {
  pickupStageByBagId?: ReadonlyMap<string, string | null | undefined>;
  pickupStages?: readonly string[];
};

function scoreFloorScanCandidate(
  card: FloorScanCardCandidate,
  options?: PickFloorScanCardOptions,
): number {
  if (card.cardType !== "RAW_BAG") return -100;
  if (card.status === "RETIRED") return -100;
  if (card.status === "ASSIGNED" && card.assignedWorkflowBagId) {
    const stage = options?.pickupStageByBagId?.get(card.assignedWorkflowBagId);
    if (stage && options?.pickupStages?.includes(stage)) return 100;
    return 90;
  }
  if (card.status === "ASSIGNED" && !card.assignedWorkflowBagId) return 50;
  if (card.status === "IDLE") return 0;
  return -10;
}

/** Prefer workflow-assigned pickup cards over idle pool cards. */
export function pickBestFloorScanCard(
  candidates: readonly FloorScanCardCandidate[],
  input: string,
  options?: PickFloorScanCardOptions,
): FloorScanCardCandidate | null {
  const matches = candidates.filter((c) => floorScanInputMatchesCard(input, c));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;

  const scored = matches.map((c) => ({
    c,
    score: scoreFloorScanCandidate(c, options),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.c;
}
