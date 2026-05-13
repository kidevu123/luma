// QC-4 — banned-language scan over the new /qc-review surface.
//
// Per QC-0 data-honesty rules:
//   - Do NOT label receipt variance as "production loss".
//   - Do NOT label cycle-count variance as "supplier shortage".
//   - QC events are NOT a single flat "known_loss" aggregator.
//
// This test grep-scans the QC-4 source files (page + form components
// + actions + loaders) for those banned phrases. Adds a small but
// load-bearing safety net — the QC-3 panel does the same on its side.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const FILES = [
  "app/(admin)/qc-review/page.tsx",
  "app/(admin)/qc-review/actions.ts",
  "app/(admin)/qc-review/_damage-actions-row.tsx",
  "app/(admin)/qc-review/_receive-rework-row.tsx",
  "app/(admin)/qc-review/_correction-trigger.tsx",
  "lib/production/qc-review-loaders.ts",
  // QC-5 surface — projector + extended operator productivity page +
  // genealogy badge map must stay clean.
  "lib/projector/qc-events.ts",
  "app/(admin)/operator-productivity/page.tsx",
  "app/(admin)/genealogy/[bagId]/page.tsx",
];

const BANNED = [
  // Receipt variance != production loss.
  /production loss/i,
  // Cycle-count variance != supplier shortage.
  /supplier shortage/i,
  // Flat "known_loss" labels.
  /known[_\s-]?loss/i,
];

describe("QC-4 surface has no banned data-honesty phrases", () => {
  for (const rel of FILES) {
    it(`${rel} stays clean`, () => {
      const src = readFileSync(resolve(repoRoot, rel), "utf8");
      for (const pattern of BANNED) {
        expect(
          src,
          `banned pattern ${pattern} found in ${rel}`,
        ).not.toMatch(pattern);
      }
    });
  }
});
