// SIMPLIFY-A — pure finished-lot transition table (UI policy; the server
// accepts any transition and audits previous_status). Kept free of component
// and server-action imports so tests can pin the table directly.
//   PENDING_QC ↔ ON_HOLD     (QA flag / clear)
//   PENDING_QC → RELEASED    (QA approve)
//   ON_HOLD    → RELEASED    (QA release from hold, reason optional)
//   RELEASED   → SHIPPED     (ops mark shipped)
//   any        → RECALLED    (admin only, with required reason)

export type LotStatus = "PENDING_QC" | "RELEASED" | "ON_HOLD" | "SHIPPED" | "RECALLED";

export type LotTransition = {
  next: LotStatus;
  label: string;
  danger?: boolean;
  needsReason?: boolean;
  optionalReason?: boolean;
};

export const ALLOWED: Record<LotStatus, LotTransition[]> = {
  PENDING_QC: [
    { next: "RELEASED", label: "Approve & release" },
    { next: "ON_HOLD", label: "Place on hold", needsReason: true },
    { next: "RECALLED", label: "Recall", danger: true, needsReason: true },
  ],
  ON_HOLD: [
    { next: "RELEASED", label: "Release lot", optionalReason: true },
    { next: "PENDING_QC", label: "Clear hold" },
    { next: "RECALLED", label: "Recall", danger: true, needsReason: true },
  ],
  RELEASED: [
    { next: "SHIPPED", label: "Mark shipped" },
    { next: "ON_HOLD", label: "Place on hold", needsReason: true },
    { next: "RECALLED", label: "Recall", danger: true, needsReason: true },
  ],
  SHIPPED: [{ next: "RECALLED", label: "Recall", danger: true, needsReason: true }],
  RECALLED: [],
};
