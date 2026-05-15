// WORKFLOW-CLEANUP-2 — small pure helpers for filtering QA / test
// materials out of the receiving picker. Lives in a separate module so
// the receiving page (a Next.js route) doesn't try to export non-
// route helpers (Next forbids that under the App Router).

/** Pure: does this packaging-material row look like a QA / test
 *  fixture? Hides anything matching common QA prefixes from the
 *  operator picker. Operators can explicitly include them via the
 *  `?show_qa=true` toggle on /inbound/packaging-materials. */
export function isQaTestMaterial(input: {
  sku?: string | null;
  name?: string | null;
}): boolean {
  const sku = (input.sku ?? "").toUpperCase();
  const name = (input.name ?? "").toUpperCase();
  return (
    sku.startsWith("QA_TEST_") ||
    sku.startsWith("QA-TEST-") ||
    sku.startsWith("QA-") ||
    name.includes("QA_TEST_") ||
    name.includes("QA TEST")
  );
}
