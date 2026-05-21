-- 0042 — Add is_tablet_po flag to purchase_orders.
--
-- Zoho Integration Service now exposes app_flags.luma.is_tablet_po on the
-- tablet-filtered PO list endpoint (?luma_tablet_only=true). We store the
-- flag so the raw bag intake dropdown can filter locally without re-fetching.
--
-- Existing POs default to null (not yet verified as tablet). After a
-- tablet-filtered sync they will be set to true. Non-tablet POs never
-- appear in the raw bag intake dropdown.

ALTER TABLE "purchase_orders" ADD COLUMN "is_tablet_po" boolean;
