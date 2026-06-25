import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  assessBulkReleaseEligibility,
  type BulkReleaseSkipReason,
} from "@/lib/db/queries/batches";
import { DEFAULT_INTAKE_BATCH_STATUS } from "@/lib/production/batch-production-guard";

describe("DEFAULT_INTAKE_BATCH_STATUS", () => {
  it("is RELEASED for normal intake", () => {
    expect(DEFAULT_INTAKE_BATCH_STATUS).toBe("RELEASED");
  });
});

describe("assessBulkReleaseEligibility", () => {
  const base = {
    id: "b1",
    batchNumber: "LOT-1",
    status: "QUARANTINE" as const,
    qtyOnHand: 100,
    expiryDate: "2099-01-01",
    notes: null,
  };
  const noHolds = new Set<string>();

  it("allows eligible quarantined lots", () => {
    expect(assessBulkReleaseEligibility(base, noHolds)).toBeNull();
  });

  it("skips non-quarantine", () => {
    expect(
      assessBulkReleaseEligibility({ ...base, status: "RELEASED" }, noHolds),
    ).toBe("NOT_QUARANTINE" satisfies BulkReleaseSkipReason);
  });

  it("skips zero on hand", () => {
    expect(
      assessBulkReleaseEligibility({ ...base, qtyOnHand: 0 }, noHolds),
    ).toBe("ZERO_ON_HAND");
  });

  it("skips expired", () => {
    expect(
      assessBulkReleaseEligibility({ ...base, expiryDate: "2020-01-01" }, noHolds),
    ).toBe("EXPIRED_DATE");
  });

  it("skips open holds", () => {
    expect(
      assessBulkReleaseEligibility(base, new Set(["b1"])),
    ).toBe("OPEN_HOLD");
  });

  it("skips QA block notes", () => {
    expect(
      assessBulkReleaseEligibility(
        { ...base, notes: "Pending QA investigation" },
        noHolds,
      ),
    ).toBe("QA_BLOCK_NOTE");
  });
});

describe("intake paths create RELEASED batches", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const intakeFiles = [
    "receives.ts",
    "raw-bag-intake.ts",
    "receive-add-bag.ts",
    "bag-edits.ts",
    "batches.ts",
  ];

  for (const file of intakeFiles) {
    it(`${file} uses DEFAULT_INTAKE_BATCH_STATUS`, () => {
      const src = readFileSync(resolve(here, file), "utf8");
      expect(src).toMatch(/DEFAULT_INTAKE_BATCH_STATUS/);
      expect(src).not.toMatch(/status:\s*"QUARANTINE"/);
    });
  }

  it("raw-bag-intake.ts resolves tablet batches by kind+batch_number only", () => {
    const src = readFileSync(resolve(here, "raw-bag-intake.ts"), "utf8");
    expect(src).toMatch(/Unique index is \(kind, batch_number\)/);
    expect(src).toMatch(/mapIntakePersistenceError/);
  });
});

describe("batches page UX", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/(admin)/batches/page.tsx"),
    "utf8",
  );

  it("titles the page Input lots", () => {
    expect(src).toMatch(/title="Input lots"/);
  });

  it("maps Available filter to RELEASED", () => {
    expect(src).toMatch(/AVAILABLE.*RELEASED/s);
  });

  it("maps Blocked filter to QUARANTINE", () => {
    expect(src).toMatch(/BLOCKED.*QUARANTINE/s);
  });
});

describe("createBatch initialStatus", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "batches.ts"),
    "utf8",
  );

  it("defaults to DEFAULT_INTAKE_BATCH_STATUS", () => {
    expect(src).toMatch(/requestedStatus \?\? DEFAULT_INTAKE_BATCH_STATUS/);
  });

  it("does not spread initialStatus into insert values", () => {
    expect(src).toMatch(/initialStatus: requestedStatus/);
    expect(src).toMatch(/\.\.\.rest,/);
  });
});

describe("schema default", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../schema.ts"),
    "utf8",
  );

  it("defaults batch status to RELEASED", () => {
    expect(src).toMatch(/default\("RELEASED"\)/);
  });
});
