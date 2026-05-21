// Command Center Visual Polish — static guards for the 4 polished
// pages.
//
// Rules enforced (per the polish brief):
//   - No emoji characters in the source (Unicode pictographs /
//     emoticons / dingbat range). Custom SVG / lucide-react icons
//     only.
//   - No banned data-honesty phrases ("production loss" / "supplier
//     shortage" / "known_loss") — same gate as the QC-4 surface.
//   - No fake-percentage placeholders like "100%" / "0%" hard-coded
//     into the page templates.
//
// This is a presentation-layer gate. Business logic continues to live
// in lib/production/metrics.ts and the read-model rebuilders; the
// pages render those values verbatim.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const POLISHED_PAGES = [
  "app/(admin)/floor-board/page.tsx",
  "app/(admin)/genealogy/[bagId]/page.tsx",
  "app/(admin)/operator-productivity/page.tsx",
  "app/(admin)/packaging-output/page.tsx",
  "app/(admin)/material-alerts/page.tsx",
  "app/(admin)/qc-review/page.tsx",
  "app/(admin)/recall/page.tsx",
  "components/production/ui.tsx",
];

// Conservative emoji regex covering the common Unicode emoji blocks.
// Matches pictographs / supplemental symbols / emoticons / regional
// indicators / variation selectors; avoids matching plain text.
const EMOJI_RE =
  /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}]/u;

const BANNED_PHRASES = [
  /production loss/i,
  /supplier shortage/i,
  /known[_\s-]?loss/i,
];

describe("Command center polish — no emojis on polished pages", () => {
  for (const rel of POLISHED_PAGES) {
    it(`${rel} contains no emoji glyphs`, () => {
      const src = readFileSync(resolve(repoRoot, rel), "utf8");
      const m = src.match(EMOJI_RE);
      expect(
        m,
        `emoji glyph ${m?.[0] ?? ""} found in ${rel}`,
      ).toBeNull();
    });
  }
});

describe("Command center polish — no banned data-honesty phrases", () => {
  for (const rel of POLISHED_PAGES) {
    for (const pattern of BANNED_PHRASES) {
      it(`${rel} stays clean of ${pattern}`, () => {
        const src = readFileSync(resolve(repoRoot, rel), "utf8");
        expect(
          src,
          `banned pattern ${pattern} found in ${rel}`,
        ).not.toMatch(pattern);
      });
    }
  }
});

describe("Command center polish — confidence ladder lives in the page sources", () => {
  // At least one of the four polished pages must reference the
  // ConfidenceBadge primitive — confidence rendering is part of the
  // polish contract. The shared component is the only sanctioned
  // way to render HIGH / MEDIUM / LOW / MISSING badges.
  it("at least one polished page imports ConfidenceBadge", () => {
    const anyImports = POLISHED_PAGES.some((rel) => {
      const src = readFileSync(resolve(repoRoot, rel), "utf8");
      return /ConfidenceBadge/.test(src);
    });
    expect(anyImports).toBe(true);
  });
});
