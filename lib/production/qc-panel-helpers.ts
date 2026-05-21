// QC-3 — pure helpers for the floor QC quick-action panel.
//
// Lives in lib/ (not app/) so it sits inside the .test.ts glob and
// can be exercised without spinning up React. The panel component
// imports these to decide:
//   - whether to render at all for a station kind
//   - what default reason code each quick-action button uses
//   - what unit + label a station kind expects
//   - whether OTHER requires non-empty notes
//
// Mirrors the QC-1 reason-code vocabulary. Adding a quick action
// here without also adding a reason code to qc-events.ts produces
// a TS error — the cross-check is the QC_REASON_CODES const.

import type { QCReasonCode, QCUnit } from "./qc-events";

/** Station kinds where the QC quick-action panel makes sense.
 *  Packaging is the primary surface (damage + send to rework);
 *  sealing/combined also need it because rework-received lives on
 *  the receiving station. Blister/bottle-* stations stay out of
 *  scope for QC-3 — they don't currently surface QC events. */
export const QC_PANEL_STATION_KINDS = [
  "PACKAGING",
  "SEALING",
  "COMBINED",
] as const;
type PanelStationKind = (typeof QC_PANEL_STATION_KINDS)[number];

export function shouldRenderQcPanel(stationKind: string | null | undefined): boolean {
  if (stationKind == null) return false;
  return (QC_PANEL_STATION_KINDS as ReadonlyArray<string>).includes(stationKind);
}

/** The five quick-action damage types operators see on the floor.
 *  Each maps 1:1 to a QC_REASON_CODE. OTHER lives separately
 *  because it requires notes (enforced by qc-events.ts). */
export type QuickDamageType =
  | "DAMAGED_PACKAGING"
  | "RIPPED_CARD"
  | "BAD_SEAL"
  | "LABEL_ISSUE"
  | "COUNT_VARIANCE";

type QuickDamageEntry = {
  /** Stable key — used as the button id + maps to reason_code. */
  type: QuickDamageType;
  reasonCode: QCReasonCode;
  /** Operator-facing label. Keep short — tablet UI. */
  label: string;
  /** Hint shown under the label on tap targets that need extra context. */
  hint?: string;
};

export const QUICK_DAMAGE_ENTRIES: ReadonlyArray<QuickDamageEntry> = [
  {
    type: "DAMAGED_PACKAGING",
    reasonCode: "DAMAGED_PACKAGING",
    label: "Damaged packaging",
    hint: "Crushed card, torn film, bent case.",
  },
  {
    type: "RIPPED_CARD",
    reasonCode: "RIPPED_CARD",
    label: "Ripped card",
    hint: "Single card torn at the perforation.",
  },
  {
    type: "BAD_SEAL",
    reasonCode: "BAD_SEAL",
    label: "Bad seal",
    hint: "Blister seal failed — consider Send to rework.",
  },
  {
    type: "LABEL_ISSUE",
    reasonCode: "LABEL_ISSUE",
    label: "Label issue",
    hint: "Misprint, crooked label, wrong SKU.",
  },
  {
    type: "COUNT_VARIANCE",
    reasonCode: "COUNT_VARIANCE",
    label: "Count issue",
    hint: "Cards short of standard display/case.",
  },
];

/** Single-source map for tests + UI — never embed the array twice. */
export function reasonCodeForQuickType(type: QuickDamageType): QCReasonCode {
  const e = QUICK_DAMAGE_ENTRIES.find((x) => x.type === type);
  if (!e) throw new Error(`Unknown QC quick type: ${type}`);
  return e.reasonCode;
}

/** Default unit per station kind. The floor UI defaults to this;
 *  operator can override (unit field is required). */
export function defaultUnitForStation(stationKind: PanelStationKind): QCUnit {
  switch (stationKind) {
    case "PACKAGING":
    case "SEALING":
    case "COMBINED":
      return "cards";
  }
}

/** Whether a given reason code requires notes to be non-empty.
 *  Today only OTHER does; mirrors the qc-events.ts otherNeedsNotes
 *  rule so the UI can refuse to submit before the action layer. */
export function reasonRequiresNotes(reasonCode: QCReasonCode): boolean {
  return reasonCode === "OTHER";
}

/** Whether a damage type has a paired "also send back to rework"
 *  shortcut. Today only BAD_SEAL — the floor UI hides the rework
 *  shortcut for damage types where it doesn't apply. */
export function damageHasReworkShortcut(type: QuickDamageType): boolean {
  return type === "BAD_SEAL";
}
