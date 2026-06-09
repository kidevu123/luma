// ZOHO-PRODUCTION-OUTPUT-V1206 — stable product-family mapping for PO/output consistency.

/** Canonical product families used for Zoho production-output validation. */
export type ProductFamilyCode =
  | "HYROXI_MIT_A"
  | "HYROXI_MIT_B"
  | "FX_MIT"
  | "FX_RELAX"
  | "FIX_BEYOND"
  | "FIX_RELAX"
  | "UNKNOWN";

const NAME_FAMILY_RULES: Array<{ prefix: string; family: ProductFamilyCode }> = [
  { prefix: "Hyroxi MIT A", family: "HYROXI_MIT_A" },
  { prefix: "Hyroxi Mit A", family: "HYROXI_MIT_A" },
  { prefix: "Hyroxi MIT B", family: "HYROXI_MIT_B" },
  { prefix: "Hyroxi Mit B", family: "HYROXI_MIT_B" },
  { prefix: "FX MIT", family: "FX_MIT" },
  { prefix: "FX Relax", family: "FX_RELAX" },
  { prefix: "FIX Beyond", family: "FIX_BEYOND" },
  { prefix: "FIX Relax", family: "FIX_RELAX" },
];

/** Derive family from a product or tablet type display name. */
export function deriveProductFamilyFromName(name: string): ProductFamilyCode {
  const trimmed = name.trim();
  for (const rule of NAME_FAMILY_RULES) {
    if (trimmed.startsWith(rule.prefix)) return rule.family;
  }
  return "UNKNOWN";
}

export function resolveProductFamily(input: {
  persistedFamily: string | null | undefined;
  name: string;
}): ProductFamilyCode {
  const persisted = input.persistedFamily?.trim();
  if (persisted && isProductFamilyCode(persisted)) {
    return persisted;
  }
  return deriveProductFamilyFromName(input.name);
}

function isProductFamilyCode(value: string): value is ProductFamilyCode {
  return (
    value === "HYROXI_MIT_A" ||
    value === "HYROXI_MIT_B" ||
    value === "FX_MIT" ||
    value === "FX_RELAX" ||
    value === "FIX_BEYOND" ||
    value === "FIX_RELAX" ||
    value === "UNKNOWN"
  );
}

export type ProductFamilyValidationInput = {
  outputProductFamily: ProductFamilyCode;
  poLineProductFamily: ProductFamilyCode;
  outputCompositeItemId: string | null;
  poLineZohoItemId: string | null;
};

export type ProductFamilyValidationResult =
  | { ok: true }
  | { ok: false; code: "PO_OUTPUT_FAMILY_MISMATCH"; message: string };

/** Block unrelated PO line vs output composite families (e.g. FX MIT PO + Hyroxi composite). */
export function validateProductFamilyConsistency(
  input: ProductFamilyValidationInput,
): ProductFamilyValidationResult {
  if (
    input.outputProductFamily === "UNKNOWN" ||
    input.poLineProductFamily === "UNKNOWN"
  ) {
    return {
      ok: false,
      code: "PO_OUTPUT_FAMILY_MISMATCH",
      message:
        "Product family could not be resolved for the output product or PO line. Map product_family on both before commit.",
    };
  }

  if (input.outputProductFamily !== input.poLineProductFamily) {
    return {
      ok: false,
      code: "PO_OUTPUT_FAMILY_MISMATCH",
      message: `PO line family ${input.poLineProductFamily} does not match output product family ${input.outputProductFamily}.`,
    };
  }

  return { ok: true };
}
