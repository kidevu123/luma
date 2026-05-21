-- INTAKE-WORKFLOW-1 — link a receive to a specific PO line so variance
-- against the line's qty_ordered is computable without ambiguity.
--
-- Existing schema only stored receives.po_id (header). When a PO had
-- multiple lines for the same tablet type, Luma couldn't tell which
-- line a given receive fulfilled. Adding a nullable po_line_id FK is
-- additive and idempotent. Legacy receives stay with po_line_id NULL;
-- the new intake screen requires it.

ALTER TABLE "receives"
  ADD COLUMN IF NOT EXISTS "po_line_id" uuid REFERENCES "po_lines"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "receives_po_line_idx"
  ON "receives" ("po_line_id")
  WHERE "po_line_id" IS NOT NULL;
