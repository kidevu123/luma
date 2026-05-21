// Regression guard for the "synthetic client_event_id" bug class.
//
// material_inventory_events.client_event_id is a uuid column. Any
// code that builds a client_event_id by concatenating a UUID with a
// suffix (`${id}-pvc`, `${id}-seg-foil`, `${id}-deplete`, ...) makes
// PG reject the insert with "invalid input syntax for type uuid"
// (22P02) — and because the actions wrap their inserts in a single
// transaction, the whole submit rolls back.
//
// We've now hit this twice (segment hook in VALIDATION-2C, then the
// roll-actions in VALIDATION-2E). This test scans the source files
// known to insert into material_inventory_events and fails CI if
// anyone reintroduces the pattern.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const FILES_THAT_TOUCH_CLIENT_EVENT_ID = [
  "app/(floor)/floor/[token]/roll-actions.ts",
  "lib/projector/material-consumption-hook.ts",
  "lib/projector/index.ts",
  "scripts/replay-blister-segments.ts",
];

// Patterns that build a non-UUID string for client_event_id.
const FORBIDDEN = [
  // `${someId}-suffix`
  /clientEventId\s*:\s*`\$\{[^}]+\}-/,
  // `${someId}` + 'suffix'  (not used today but easy to catch)
  /clientEventId\s*:\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*\+\s*["'`]/,
  // .concat("-foo")
  /clientEventId[^,;\n]*\.concat\s*\(/,
];

describe("client_event_id rule (uuid-only or null)", () => {
  for (const rel of FILES_THAT_TOUCH_CLIENT_EVENT_ID) {
    it(`${rel} does not build a synthetic client_event_id`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      for (const pat of FORBIDDEN) {
        const m = src.match(pat);
        if (m) {
          throw new Error(
            `${rel}: forbidden client_event_id pattern matched\n  ${m[0]}\n` +
              `client_event_id is uuid-typed; build a UUID with crypto.randomUUID() ` +
              `or set client_event_id to null and put correlation data in payload.`,
          );
        }
      }
    });
  }
});

describe("client_event_id rule — explicit anti-cases", () => {
  it("flags `${id}-seg-pvc` as forbidden", () => {
    const sample = "clientEventId: `${d.clientEventId}-seg-pvc`";
    expect(FORBIDDEN.some((p) => p.test(sample))).toBe(true);
  });
  it("flags `${id}-deplete` as forbidden", () => {
    const sample = "clientEventId: `${d.clientEventId}-deplete`";
    expect(FORBIDDEN.some((p) => p.test(sample))).toBe(true);
  });
  it("flags `${id}-w` as forbidden", () => {
    const sample = "clientEventId: `${d.clientEventId}-w`";
    expect(FORBIDDEN.some((p) => p.test(sample))).toBe(true);
  });
  it("does NOT flag a plain uuid var", () => {
    const sample = "clientEventId: d.clientEventId";
    expect(FORBIDDEN.some((p) => p.test(sample))).toBe(false);
  });
  it("does NOT flag randomUUID()", () => {
    const sample = "clientEventId: randomUUID()";
    expect(FORBIDDEN.some((p) => p.test(sample))).toBe(false);
  });
  it("does NOT flag a conditional uuid spread", () => {
    const sample = "...(d.clientEventId ? { clientEventId: d.clientEventId } : {})";
    expect(FORBIDDEN.some((p) => p.test(sample))).toBe(false);
  });
});
