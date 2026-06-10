// ZOHO-PURCHASE-RECEIVE-ID — parse purchase_receive_id from gateway responses.

export function parseZohoPurchaseReceiveId(body: unknown): string | null {
  if (body == null || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const direct = o.receive_id ?? o.purchase_receive_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = o.receive;
  if (nested != null && typeof nested === "object") {
    const id = (nested as Record<string, unknown>).receive_id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  const data = o.data;
  if (data != null && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const fromData = d.purchase_receive_id ?? d.receive_id;
    if (typeof fromData === "string" && fromData.trim()) return fromData.trim();
  }
  return null;
}
