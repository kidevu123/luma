// GLOBAL INVARIANT — a qr_cards row set to status "IDLE" must never retain an
// assignedWorkflowBagId. This test scans the whole app/ + lib/ source tree for
// any `.set({ ... status: "IDLE" ... })` on a qr card and fails if the same
// object does not also clear assignedWorkflowBagId. It is the backstop that
// catches a NEW release path added in the future without the clear.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "lib"];

function collectSourceFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      collectSourceFiles(full, out);
    } else if (
      (full.endsWith(".ts") || full.endsWith(".tsx")) &&
      !full.endsWith(".test.ts") &&
      !full.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
}

// Match each `.set({ ... })` object (non-greedy; these qr-card set objects are
// flat, so the first `})` closes them).
const SET_BLOCK_RE = /\.set\(\s*\{[\s\S]*?\}\s*\)/g;

describe("GLOBAL — IDLE qr_cards release clears assignedWorkflowBagId", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) collectSourceFiles(join(ROOT, d), files);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("every .set({...status:'IDLE'...}) on a qr card also clears assignedWorkflowBagId", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes('status: "IDLE"')) continue;
      const matches = src.match(SET_BLOCK_RE) ?? [];
      for (const block of matches) {
        if (!/status:\s*"IDLE"/.test(block)) continue;
        if (!/assignedWorkflowBagId:\s*null/.test(block)) {
          offenders.push(
            `${file.replace(ROOT + "/", "")}: ${block.replace(/\s+/g, " ").slice(0, 120)}`,
          );
        }
      }
    }
    expect(offenders, `IDLE release missing assignedWorkflowBagId clear:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });
});
