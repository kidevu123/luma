/** Human-readable labels for inventory_bags.bag_qr_code in admin UI. */

import { isBagQrPlaceholder } from "@/lib/production/floor-readiness";

export type BagQrDisplay = {
  /** Primary line for tables */
  primary: string;
  /** Optional secondary detail (full token for copy/reference) */
  secondary: string | null;
  isPlaceholder: boolean;
};

/** Avoid showing raw BAG-<uuid> as if it were a scannable floor card. */
export function formatBagQrForDisplay(bagQrCode: string | null | undefined): BagQrDisplay {
  if (!bagQrCode || bagQrCode.trim() === "") {
    return {
      primary: "Missing",
      secondary: null,
      isPlaceholder: false,
    };
  }
  const code = bagQrCode.trim();
  if (isBagQrPlaceholder(code)) {
    return {
      primary: "System placeholder — assign floor card",
      secondary: code,
      isPlaceholder: true,
    };
  }
  return {
    primary: code,
    secondary: null,
    isPlaceholder: false,
  };
}
