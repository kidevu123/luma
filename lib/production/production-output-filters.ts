// PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — pure filter parsing.
//
// Parses the /packaging-output query string into a typed filter object.
// Pure (no I/O, no DB). Defensive against arbitrary operator input —
// every field has bounds, every parse failure falls back to a safe
// default instead of throwing.
//
// Default behavior (no filters) is preserved: the page renders the
// historical 7-day dashboard + 20-row backlog queue. When ANY filter
// is set, the page switches to "results" mode.

export const PRODUCTION_OUTPUT_STATUS_VALUES = [
  "all",
  "awaiting_lot",
  "ready_to_auto_issue",
  "missing_allocation",
  "blocked",
  "issued_lot",
  "zoho_pending",
  "zoho_committed",
  "packaged_not_finalized",
] as const;

export type ProductionOutputStatusFilter =
  (typeof PRODUCTION_OUTPUT_STATUS_VALUES)[number];

export const PRODUCTION_OUTPUT_LIMIT_OPTIONS = [20, 50, 100] as const;
export type ProductionOutputLimitOption =
  (typeof PRODUCTION_OUTPUT_LIMIT_OPTIONS)[number];

export const PRODUCTION_OUTPUT_LIMIT_DEFAULT: ProductionOutputLimitOption = 20;
export const PRODUCTION_OUTPUT_LIMIT_MAX: ProductionOutputLimitOption = 100;

export const PRODUCTION_OUTPUT_SEARCH_MAX_LENGTH = 120;

export type ProductionOutputFilters = {
  q: string | null;
  from: Date | null;
  to: Date | null;
  status: ProductionOutputStatusFilter | null;
  poId: string | null;
  limit: ProductionOutputLimitOption;
  page: number;
  /** True iff ANY user-driven filter (q/from/to/status/poId/page) is
   *  set. `limit` alone does NOT count — operators can change limit
   *  without leaving the default view. */
  hasUserFilter: boolean;
};

function trim(value: string | string[] | undefined): string | null {
  if (value == null) return null;
  const s = Array.isArray(value) ? value[0] : value;
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

function parseDate(value: string | null): Date | null {
  if (value == null) return null;
  // Accept ISO date (YYYY-MM-DD) or ISO timestamp. Reject anything
  // else — we don't want loose parsing turning typos into matches.
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.\-+Z]+)?$/.test(value)) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function parseLimit(value: string | null): ProductionOutputLimitOption {
  if (value == null) return PRODUCTION_OUTPUT_LIMIT_DEFAULT;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return PRODUCTION_OUTPUT_LIMIT_DEFAULT;
  if (PRODUCTION_OUTPUT_LIMIT_OPTIONS.includes(n as ProductionOutputLimitOption)) {
    return n as ProductionOutputLimitOption;
  }
  return PRODUCTION_OUTPUT_LIMIT_DEFAULT;
}

function parsePage(value: string | null): number {
  if (value == null) return 1;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  // Cap pagination so a typoed `page=99999` doesn't hammer the DB.
  return Math.min(n, 1000);
}

function parseStatus(value: string | null): ProductionOutputStatusFilter | null {
  if (value == null) return null;
  return (
    PRODUCTION_OUTPUT_STATUS_VALUES.find((s) => s === value) ?? null
  );
}

export type ProductionOutputRawSearchParams = Record<
  string,
  string | string[] | undefined
>;

/**
 * Parse a Next.js searchParams object into a typed
 * ProductionOutputFilters. Always returns a valid object — never
 * throws on bad operator input.
 */
export function parseProductionOutputFilters(
  raw: ProductionOutputRawSearchParams,
): ProductionOutputFilters {
  const rawQ = trim(raw.q);
  const q =
    rawQ != null && rawQ.length > PRODUCTION_OUTPUT_SEARCH_MAX_LENGTH
      ? rawQ.slice(0, PRODUCTION_OUTPUT_SEARCH_MAX_LENGTH)
      : rawQ;
  const from = parseDate(trim(raw.from));
  const to = parseDate(trim(raw.to));
  const status = parseStatus(trim(raw.status));
  const poId = trim(raw.poId);
  const limit = parseLimit(trim(raw.limit));
  const page = parsePage(trim(raw.page));

  const hasUserFilter =
    q != null ||
    from != null ||
    to != null ||
    (status != null && status !== "all") ||
    poId != null ||
    page > 1;

  return { q, from, to, status, poId, limit, page, hasUserFilter };
}

/**
 * Render a filters object back into a URLSearchParams string suitable
 * for building deep-links and pagination cursors. Empty values are
 * dropped so the URL stays clean.
 */
export function serializeProductionOutputFilters(
  filters: Partial<ProductionOutputFilters>,
): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.from) params.set("from", isoDate(filters.from));
  if (filters.to) params.set("to", isoDate(filters.to));
  if (filters.status && filters.status !== "all") {
    params.set("status", filters.status);
  }
  if (filters.poId) params.set("poId", filters.poId);
  if (filters.limit && filters.limit !== PRODUCTION_OUTPUT_LIMIT_DEFAULT) {
    params.set("limit", String(filters.limit));
  }
  if (filters.page && filters.page > 1) {
    params.set("page", String(filters.page));
  }
  return params.toString();
}

function isoDate(d: Date): string {
  // YYYY-MM-DD only — date inputs in the filter bar are date-only.
  // Preserves the operator's intent without serializing tz noise.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
