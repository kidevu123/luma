// ZOHO-PURCHASE-RECEIVE-ID — parse purchase receive fields from gateway responses.

export function parseZohoPurchaseReceiveId(body: unknown): string | null {
  if (body == null || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const direct =
    o.zoho_purchase_receive_id ?? o.receive_id ?? o.purchase_receive_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = o.receive;
  if (nested != null && typeof nested === "object") {
    const id = (nested as Record<string, unknown>).receive_id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  const data = o.data;
  if (data != null && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const fromData =
      d.zoho_purchase_receive_id ?? d.purchase_receive_id ?? d.receive_id;
    if (typeof fromData === "string" && fromData.trim()) return fromData.trim();
  }
  return null;
}

export function parseZohoReceiveNumber(body: unknown): string | null {
  if (body == null || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const data =
    root.data != null && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root;
  const num =
    data.receive_number ??
    data.purchase_receive_number ??
    data.zoho_receive_number;
  return typeof num === "string" && num.trim() ? num.trim() : null;
}
