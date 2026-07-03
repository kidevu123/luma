// PO-CLOSEOUT-ZOHO-DONE-1 — normalizeZohoStatus unit + structural guards. The
// loader imports @/lib/db at module load; stub it so the pure helper is testable.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("@/lib/db", () => ({ db: {} }));

import { normalizeZohoStatus } from "@/lib/db/queries/po-closeout";

describe("normalizeZohoStatus", () => {
  it("MISSING op + Zoho required = READY_TO_QUEUE (not NOT_APPLICABLE) — the v1.22.0 bug", () => {
    expect(normalizeZohoStatus(undefined, true)).toBe("READY_TO_QUEUE");
  });
  it("MISSING op + Zoho NOT required = NOT_APPLICABLE (explicit: feature off)", () => {
    expect(normalizeZohoStatus(undefined, false)).toBe("NOT_APPLICABLE");
  });
  it("committed (via status or committedAt) = COMMITTED", () => {
    expect(normalizeZohoStatus({ status: "COMMITTED", committedAt: null }, true)).toBe("COMMITTED");
    expect(normalizeZohoStatus({ status: "QUEUED", committedAt: new Date(0) }, true)).toBe("COMMITTED");
  });
  it("queued / committing = QUEUED", () => {
    expect(normalizeZohoStatus({ status: "QUEUED", committedAt: null }, true)).toBe("QUEUED");
    expect(normalizeZohoStatus({ status: "COMMITTING", committedAt: null }, true)).toBe("QUEUED");
  });
  it("ready / approved = READY_TO_QUEUE", () => {
    expect(normalizeZohoStatus({ status: "READY", committedAt: null }, true)).toBe("READY_TO_QUEUE");
    expect(normalizeZohoStatus({ status: "APPROVED", committedAt: null }, true)).toBe("READY_TO_QUEUE");
  });
  it("failed = FAILED", () => {
    expect(normalizeZohoStatus({ status: "FAILED", committedAt: null }, true)).toBe("FAILED");
  });
  it("mid-preview / mapping-blocked / held = NOT_READY", () => {
    for (const s of ["DRAFT", "PREVIEWED", "NEEDS_MAPPING", "HELD"]) {
      expect(normalizeZohoStatus({ status: s, committedAt: null }, true)).toBe("NOT_READY");
    }
  });
});

describe("loader wiring + page copy", () => {
  const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const loaderSrc = repo("lib/db/queries/po-closeout.ts");
  const pageSrc = repo("app/(admin)/po-closeout/[poId]/page.tsx");

  it("loader derives zohoRequired from persist config and passes it into normalizeZohoStatus", () => {
    expect(loaderSrc).toMatch(/isProductionOutputPersistEnabled\(\)/);
    expect(loaderSrc).toMatch(/const zohoRequired = isProductionOutputPersistEnabled/);
    expect(loaderSrc).toMatch(/normalizeZohoStatus\([^,]+,\s*zohoRequired\)/);
  });

  it("page copy distinguishes Ready to queue / Queued / Committed / Failed and never queues/commits Zoho", () => {
    expect(pageSrc).toMatch(/Ready to queue/);
    expect(pageSrc).toMatch(/Queued/);
    expect(pageSrc).toMatch(/Committed/);
    expect(pageSrc).toMatch(/Failed/);
    expect(pageSrc).toMatch(/ready for the worker/i);
    expect(pageSrc).toMatch(/no manual Luma action remains/i);
    expect(pageSrc).toMatch(/never queued or committed from this page/i);
    // The page does not import or call any Zoho queue/commit action.
    expect(pageSrc).not.toMatch(/queueProductionOutputOpAction|processConsolidatedProductionOutputCommit|commitZoho/);
  });
});

void vi;
