// Pure PVC/FOIL role inference from material kind — safe for client imports.

export function inferRollRole(
  materialKind: string,
  payloadRole: string | null | undefined,
): "PVC" | "FOIL" {
  if (payloadRole === "PVC" || payloadRole === "FOIL") return payloadRole;
  if (materialKind === "PVC_ROLL") return "PVC";
  if (materialKind === "FOIL_ROLL" || materialKind === "BLISTER_FOIL") return "FOIL";
  return "PVC";
}
