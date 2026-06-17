// PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — filter parsing tests.

import { describe, expect, it } from "vitest";
import {
  parseProductionOutputFilters,
  serializeProductionOutputFilters,
  PRODUCTION_OUTPUT_LIMIT_DEFAULT,
  PRODUCTION_OUTPUT_STATUS_VALUES,
} from "./production-output-filters";

describe("parseProductionOutputFilters — defaults", () => {
  it("returns all-null filters for an empty searchParams object", () => {
    const filters = parseProductionOutputFilters({});
    expect(filters).toEqual({
      q: null,
      from: null,
      to: null,
      status: null,
      poId: null,
      limit: PRODUCTION_OUTPUT_LIMIT_DEFAULT,
      page: 1,
      hasUserFilter: false,
    });
  });

  it("treats empty/whitespace strings as missing", () => {
    const filters = parseProductionOutputFilters({
      q: "   ",
      from: "",
      to: "",
      status: "",
      poId: "  ",
    });
    expect(filters.q).toBe(null);
    expect(filters.from).toBe(null);
    expect(filters.to).toBe(null);
    expect(filters.status).toBe(null);
    expect(filters.poId).toBe(null);
    expect(filters.hasUserFilter).toBe(false);
  });
});

describe("parseProductionOutputFilters — search", () => {
  it("trims the search needle", () => {
    expect(parseProductionOutputFilters({ q: "  RCP-123  " }).q).toBe(
      "RCP-123",
    );
  });

  it("caps overlong queries at 120 chars to bound DB cost", () => {
    const long = "x".repeat(500);
    expect(parseProductionOutputFilters({ q: long }).q?.length).toBe(120);
  });

  it("setting q flips hasUserFilter to true", () => {
    expect(parseProductionOutputFilters({ q: "abc" }).hasUserFilter).toBe(
      true,
    );
  });
});

describe("parseProductionOutputFilters — dates", () => {
  it("accepts YYYY-MM-DD", () => {
    const f = parseProductionOutputFilters({
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(f.from?.toISOString().startsWith("2026-05-01")).toBe(true);
    expect(f.to?.toISOString().startsWith("2026-05-31")).toBe(true);
    expect(f.hasUserFilter).toBe(true);
  });

  it("accepts ISO timestamps", () => {
    const f = parseProductionOutputFilters({
      from: "2026-05-01T00:00:00Z",
    });
    expect(f.from?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("rejects garbage date strings (falls back to null)", () => {
    const f = parseProductionOutputFilters({ from: "yesterday" });
    expect(f.from).toBe(null);
  });

  it("rejects 5-digit years and other loose forms", () => {
    expect(parseProductionOutputFilters({ from: "12345-01-01" }).from).toBe(
      null,
    );
    expect(parseProductionOutputFilters({ from: "01/15/2026" }).from).toBe(
      null,
    );
  });
});

describe("parseProductionOutputFilters — status", () => {
  it.each(PRODUCTION_OUTPUT_STATUS_VALUES)(
    "accepts the canonical status %s",
    (s) => {
      expect(parseProductionOutputFilters({ status: s }).status).toBe(s);
    },
  );

  it("rejects unknown status values", () => {
    expect(
      parseProductionOutputFilters({ status: "completed" }).status,
    ).toBe(null);
  });

  it("status=all does not flip hasUserFilter (all is the default-ish view)", () => {
    expect(parseProductionOutputFilters({ status: "all" }).hasUserFilter).toBe(
      false,
    );
  });

  it("status=awaiting_lot flips hasUserFilter", () => {
    expect(
      parseProductionOutputFilters({ status: "awaiting_lot" }).hasUserFilter,
    ).toBe(true);
  });
});

describe("parseProductionOutputFilters — limit", () => {
  it("defaults to 20", () => {
    expect(parseProductionOutputFilters({}).limit).toBe(20);
  });

  it("accepts 20, 50, 100", () => {
    expect(parseProductionOutputFilters({ limit: "20" }).limit).toBe(20);
    expect(parseProductionOutputFilters({ limit: "50" }).limit).toBe(50);
    expect(parseProductionOutputFilters({ limit: "100" }).limit).toBe(100);
  });

  it("rejects 1000 (off-list) and clamps to 20", () => {
    expect(parseProductionOutputFilters({ limit: "1000" }).limit).toBe(20);
  });

  it("rejects NaN", () => {
    expect(parseProductionOutputFilters({ limit: "abc" }).limit).toBe(20);
  });

  it("a non-default limit alone does NOT flip hasUserFilter", () => {
    expect(parseProductionOutputFilters({ limit: "100" }).hasUserFilter).toBe(
      false,
    );
  });
});

describe("parseProductionOutputFilters — page", () => {
  it("defaults to 1", () => {
    expect(parseProductionOutputFilters({}).page).toBe(1);
  });

  it("accepts positive integers", () => {
    expect(parseProductionOutputFilters({ page: "3" }).page).toBe(3);
  });

  it("clamps to 1 on negative/zero", () => {
    expect(parseProductionOutputFilters({ page: "0" }).page).toBe(1);
    expect(parseProductionOutputFilters({ page: "-5" }).page).toBe(1);
  });

  it("clamps to 1000 on absurd values", () => {
    expect(parseProductionOutputFilters({ page: "9999999" }).page).toBe(
      1000,
    );
  });

  it("page > 1 flips hasUserFilter (so the URL truly differs)", () => {
    expect(parseProductionOutputFilters({ page: "2" }).hasUserFilter).toBe(
      true,
    );
  });
});

describe("parseProductionOutputFilters — array values", () => {
  it("takes the first element when a key has an array value", () => {
    expect(
      parseProductionOutputFilters({ q: ["abc", "def"] }).q,
    ).toBe("abc");
  });

  it("ignores non-string array elements", () => {
    expect(
      parseProductionOutputFilters({ q: [undefined as unknown as string] }).q,
    ).toBe(null);
  });
});

describe("serializeProductionOutputFilters", () => {
  it("returns empty string for default-shape input", () => {
    expect(
      serializeProductionOutputFilters({
        q: null,
        from: null,
        to: null,
        status: "all",
        poId: null,
        limit: 20,
        page: 1,
        hasUserFilter: false,
      }),
    ).toBe("");
  });

  it("includes only set values", () => {
    const qs = serializeProductionOutputFilters({
      q: "RCP-123",
      status: "issued_lot",
      limit: 100,
      page: 2,
    });
    const params = new URLSearchParams(qs);
    expect(params.get("q")).toBe("RCP-123");
    expect(params.get("status")).toBe("issued_lot");
    expect(params.get("limit")).toBe("100");
    expect(params.get("page")).toBe("2");
  });

  it("drops status=all from the URL", () => {
    expect(
      serializeProductionOutputFilters({ status: "all" }).includes("status"),
    ).toBe(false);
  });

  it("drops the default limit from the URL", () => {
    expect(
      serializeProductionOutputFilters({ limit: 20 }).includes("limit"),
    ).toBe(false);
  });

  it("serializes a Date to YYYY-MM-DD", () => {
    const qs = serializeProductionOutputFilters({
      from: new Date("2026-05-01T12:34:56Z"),
    });
    expect(new URLSearchParams(qs).get("from")).toBe("2026-05-01");
  });
});
