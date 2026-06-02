# PRODUCT-MAP-3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Zoho product readiness visible and auditable — pure helper, compact status banner on the product detail page, and a read-only CLI audit script — so supervisors know which products can generate valid Zoho assembly payloads before enabling dry-run testing.

**Architecture:** Pure `classifyProductZohoReadiness` helper in `lib/zoho/product-zoho-readiness.ts` (follows the `lib/production/product-floor-readiness.ts` pattern). Zoho readiness (IDs configured?) and floor readiness (tablet mapping?) are separate concerns and must not be merged. A `ZohoReadinessCard` server component is added inline in `app/(admin)/products/[id]/page.tsx` inside the existing Zoho assembly mapping card. A standalone read-only audit script queries all products and prints a grouped summary.

**Tech Stack:** TypeScript strict, Drizzle ORM, Next.js 15 App Router (Server Component), Tailwind CSS v3, Vitest, tsx for scripts.

---

## Pre-work Safety Check

- Branch: `main`, HEAD `1225628`, origin/main `1225628` ✅
- Version: `0.2.47` ✅
- Deployed SHA: `1225628` ✅
- Working tree: clean (one untracked plan file, irrelevant) ✅
- Tests at baseline: 2413/2413 ✅
- Safe to proceed.

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `lib/zoho/product-zoho-readiness.ts` | Pure helper: `classifyProductZohoReadiness`, `zohoReadinessLabel`, `zohoReadinessReasonLabel`, `ZohoReadinessLevel`, `ZohoReadinessReason`, `ZohoReadinessResult` |
| Create | `lib/zoho/product-zoho-readiness.test.ts` | 13 unit tests |
| Modify | `app/(admin)/products/[id]/page.tsx` | Import helper; add `ZohoReadinessCard` component; render it inside existing Zoho mapping card |
| Create | `scripts/audit-product-zoho-readiness.ts` | Read-only CLI: queries all products, classifies, prints grouped summary |
| Modify | `package.json` | Bump 0.2.47 → 0.2.48 |
| Modify | `CHANGELOG.md` | Prepend `[0.2.48]` entry |

---

## Task 1: Pure Zoho readiness helper (TDD)

**Files:**
- Create: `lib/zoho/product-zoho-readiness.ts`
- Create: `lib/zoho/product-zoho-readiness.test.ts`

### Step 1a — Write failing tests first

- [ ] **Step 1: Write `lib/zoho/product-zoho-readiness.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import {
  classifyProductZohoReadiness,
  zohoReadinessLabel,
  zohoReadinessReasonLabel,
} from "./product-zoho-readiness";

const BASE = {
  isActive: true,
  zohoItemIdUnit: null as string | null,
  zohoItemIdDisplay: null as string | null,
  zohoItemIdCase: null as string | null,
  unitsPerDisplay: null as number | null,
  displaysPerCase: null as number | null,
};

describe("classifyProductZohoReadiness", () => {
  it("inactive product → INACTIVE regardless of configured IDs", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      isActive: false,
      zohoItemIdUnit: "460000000001",
    });
    expect(result.level).toBe("inactive");
    expect(result.reasons).toHaveLength(0);
  });

  it("unit-only product with unit ID → READY", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
    });
    expect(result.level).toBe("ready");
    expect(result.reasons).toHaveLength(0);
  });

  it("unit-only product without unit ID → MISSING", () => {
    const result = classifyProductZohoReadiness({ ...BASE });
    expect(result.level).toBe("missing");
    expect(result.reasons).toContain("no_unit_id");
    expect(result.reasons).toHaveLength(1);
  });

  it("unit+display product with only unit ID → PARTIAL", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
      unitsPerDisplay: 12,
    });
    expect(result.level).toBe("partial");
    expect(result.reasons).toContain("no_display_id");
    expect(result.reasons).not.toContain("no_unit_id");
  });

  it("unit+display product with both IDs → READY", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
      zohoItemIdDisplay: "460000000002",
      unitsPerDisplay: 12,
    });
    expect(result.level).toBe("ready");
    expect(result.reasons).toHaveLength(0);
  });

  it("unit+display product with no IDs → MISSING (all required missing)", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      unitsPerDisplay: 12,
    });
    expect(result.level).toBe("missing");
    expect(result.reasons).toContain("no_unit_id");
    expect(result.reasons).toContain("no_display_id");
    expect(result.reasons).toHaveLength(2);
  });

  it("unit+display+case product with all three IDs → READY", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
      zohoItemIdDisplay: "460000000002",
      zohoItemIdCase: "460000000003",
      unitsPerDisplay: 12,
      displaysPerCase: 4,
    });
    expect(result.level).toBe("ready");
    expect(result.reasons).toHaveLength(0);
  });

  it("unit+display+case product with only unit ID → PARTIAL (two IDs missing)", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
      unitsPerDisplay: 12,
      displaysPerCase: 4,
    });
    expect(result.level).toBe("partial");
    expect(result.reasons).toContain("no_display_id");
    expect(result.reasons).toContain("no_case_id");
    expect(result.reasons).not.toContain("no_unit_id");
  });

  it("unit+display+case product with no IDs → MISSING (all three missing)", () => {
    const result = classifyProductZohoReadiness({
      ...BASE,
      unitsPerDisplay: 12,
      displaysPerCase: 4,
    });
    expect(result.level).toBe("missing");
    expect(result.reasons).toHaveLength(3);
  });

  it("tablet mapping count is not an input — Zoho readiness ignores floor readiness", () => {
    // The helper signature does not accept tabletMappingCount.
    // Calling with a product that has a unit ID is always READY regardless.
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: "460000000001",
    });
    expect(result.level).toBe("ready");
  });

  it("legacy zoho_item_id is not checked — zohoItemIdUnit is required for READY", () => {
    // The planner reads zohoItemIdUnit (not the legacy zoho_item_id column).
    // A product with only the legacy field is MISSING for Zoho operations.
    const result = classifyProductZohoReadiness({
      ...BASE,
      zohoItemIdUnit: null, // canonical field absent
    });
    expect(result.level).toBe("missing");
    expect(result.reasons).toContain("no_unit_id");
  });
});

describe("zohoReadinessLabel", () => {
  it("returns non-empty strings for all four levels", () => {
    expect(zohoReadinessLabel("ready")).toMatch(/ready/i);
    expect(zohoReadinessLabel("partial")).toMatch(/partial/i);
    expect(zohoReadinessLabel("missing")).toMatch(/missing/i);
    expect(zohoReadinessLabel("inactive")).toMatch(/inactive/i);
  });
});

describe("zohoReadinessReasonLabel", () => {
  it("returns descriptive strings for all three reasons", () => {
    expect(zohoReadinessReasonLabel("no_unit_id")).toMatch(/unit/i);
    expect(zohoReadinessReasonLabel("no_display_id")).toMatch(/display/i);
    expect(zohoReadinessReasonLabel("no_case_id")).toMatch(/case/i);
  });
});
```

- [ ] **Step 2: Run tests — verify failures**

```bash
npx vitest run lib/zoho/product-zoho-readiness.test.ts
```

Expected: FAIL — `product-zoho-readiness` module not found.

### Step 1b — Implement the helper

- [ ] **Step 3: Write `lib/zoho/product-zoho-readiness.ts`**

```typescript
// PRODUCT-MAP-3 — Pure helpers for product Zoho assembly readiness classification.
// Zoho readiness = whether required Zoho item IDs are configured for assembly ops.
// Floor readiness (tablet mapping) is a separate concern — see
// lib/production/product-floor-readiness.ts.

export type ZohoReadinessLevel = "ready" | "partial" | "missing" | "inactive";

export type ZohoReadinessReason =
  | "no_unit_id"
  | "no_display_id"   // only emitted when unitsPerDisplay > 0
  | "no_case_id";     // only emitted when displaysPerCase > 0

export interface ZohoReadinessResult {
  level: ZohoReadinessLevel;
  reasons: ZohoReadinessReason[];
}

export function classifyProductZohoReadiness(product: {
  isActive: boolean;
  zohoItemIdUnit: string | null;
  zohoItemIdDisplay: string | null;
  zohoItemIdCase: string | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
}): ZohoReadinessResult {
  if (!product.isActive) return { level: "inactive", reasons: [] };

  const reasons: ZohoReadinessReason[] = [];

  if (!product.zohoItemIdUnit) reasons.push("no_unit_id");
  if ((product.unitsPerDisplay ?? 0) > 0 && !product.zohoItemIdDisplay)
    reasons.push("no_display_id");
  if ((product.displaysPerCase ?? 0) > 0 && !product.zohoItemIdCase)
    reasons.push("no_case_id");

  const requiredCount =
    1 +
    ((product.unitsPerDisplay ?? 0) > 0 ? 1 : 0) +
    ((product.displaysPerCase ?? 0) > 0 ? 1 : 0);

  const level: ZohoReadinessLevel =
    reasons.length === 0
      ? "ready"
      : reasons.length === requiredCount
        ? "missing"
        : "partial";

  return { level, reasons };
}

export function zohoReadinessLabel(level: ZohoReadinessLevel): string {
  switch (level) {
    case "ready":
      return "Ready for Zoho assembly operations";
    case "partial":
      return "Partially mapped — some Zoho item IDs missing";
    case "missing":
      return "Not mapped — Zoho assembly IDs not configured";
    case "inactive":
      return "Inactive — product excluded from assembly operations";
  }
}

export function zohoReadinessReasonLabel(reason: ZohoReadinessReason): string {
  switch (reason) {
    case "no_unit_id":
      return "Missing single-unit Zoho item ID";
    case "no_display_id":
      return "Missing display Zoho item ID";
    case "no_case_id":
      return "Missing case Zoho item ID";
  }
}
```

- [ ] **Step 4: Run tests — verify 13 pass**

```bash
npx vitest run lib/zoho/product-zoho-readiness.test.ts
```

Expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/zoho/product-zoho-readiness.ts lib/zoho/product-zoho-readiness.test.ts
git commit -m "$(cat <<'EOF'
feat(zoho): pure Zoho product readiness helper (PRODUCT-MAP-3)

classifyProductZohoReadiness: READY/PARTIAL/MISSING/INACTIVE based on
zohoItemIdUnit/Display/Case; floor readiness is a separate concern.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: ZohoReadinessCard on product detail page

**Files:**
- Modify: `app/(admin)/products/[id]/page.tsx`

Background: The product detail page at this path currently has four sections:
1. Spec card + BOM card (2-column grid)
2. `FloorReadinessCard` (full-width, colored border)
3. Zoho assembly mapping card (full-width, contains the `ZohoMappingForm`)

The `ZohoReadinessCard` must go INSIDE the existing Zoho assembly mapping card, ABOVE the description paragraph and `ZohoMappingForm`. Do NOT create a new full-width card.

The file currently imports `ArrowLeft, CheckCircle2, AlertTriangle, XCircle` from `lucide-react` and `floorReadinessLevel, floorReadinessLabel` from `@/lib/production/product-floor-readiness`. All Lucide icons needed for the new component are already imported.

- [ ] **Step 1: Add the import for the Zoho readiness helper**

In `app/(admin)/products/[id]/page.tsx`, find the import line:

```typescript
import { floorReadinessLevel, floorReadinessLabel } from "@/lib/production/product-floor-readiness";
```

Replace it with:

```typescript
import { floorReadinessLevel, floorReadinessLabel } from "@/lib/production/product-floor-readiness";
import {
  classifyProductZohoReadiness,
  zohoReadinessLabel,
  zohoReadinessReasonLabel,
} from "@/lib/zoho/product-zoho-readiness";
```

- [ ] **Step 2: Add the ZohoReadinessCard component at the bottom of the file**

Append the following function at the bottom of `app/(admin)/products/[id]/page.tsx`, after the `FloorReadinessCard` function:

```typescript
// ── Zoho readiness ────────────────────────────────────────────────────────────

function ZohoReadinessCard({
  isActive,
  zohoItemIdUnit,
  zohoItemIdDisplay,
  zohoItemIdCase,
  unitsPerDisplay,
  displaysPerCase,
  tabletMappingCount,
}: {
  isActive: boolean;
  zohoItemIdUnit: string | null;
  zohoItemIdDisplay: string | null;
  zohoItemIdCase: string | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  tabletMappingCount: number;
}) {
  const result = classifyProductZohoReadiness({
    isActive,
    zohoItemIdUnit,
    zohoItemIdDisplay,
    zohoItemIdCase,
    unitsPerDisplay,
    displaysPerCase,
  });

  const styles = {
    ready: {
      container: "border-emerald-200 bg-emerald-50/60",
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />,
      title: "text-emerald-900",
      body: "text-emerald-800/80",
    },
    partial: {
      container: "border-amber-200 bg-amber-50/60",
      icon: <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />,
      title: "text-amber-900",
      body: "text-amber-800/80",
    },
    missing: {
      container: "border-amber-200 bg-amber-50/60",
      icon: <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />,
      title: "text-amber-900",
      body: "text-amber-800/80",
    },
    inactive: {
      container: "border-border bg-surface-2/40",
      icon: <XCircle className="h-4 w-4 text-text-muted flex-shrink-0 mt-0.5" />,
      title: "text-text-muted",
      body: "text-text-subtle",
    },
  }[result.level];

  const floorNote =
    isActive && tabletMappingCount === 0
      ? "Floor: Missing tablet mapping — product cannot be selected at a station."
      : null;

  return (
    <div className={`rounded-xl border px-4 py-3 flex gap-3 mb-4 ${styles.container}`}>
      {styles.icon}
      <div className="space-y-1 min-w-0">
        <p className={`text-sm font-semibold ${styles.title}`}>
          Zoho: {zohoReadinessLabel(result.level)}
        </p>
        {result.reasons.length > 0 && (
          <ul className="space-y-0.5">
            {result.reasons.map((r) => (
              <li key={r} className={`text-xs ${styles.body}`}>
                {zohoReadinessReasonLabel(r)}
              </li>
            ))}
          </ul>
        )}
        {floorNote && (
          <p className="text-xs text-text-muted mt-0.5">{floorNote}</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Render ZohoReadinessCard inside the existing Zoho mapping card**

In `app/(admin)/products/[id]/page.tsx`, find the existing Zoho assembly mapping card's `<CardContent>` block:

```typescript
        <CardContent>
          <p className="text-[11px] text-text-muted mb-4 leading-relaxed">
            These IDs map Luma product levels to existing Zoho composite items. Luma will use
            these later for tablet receiving and assembly jobs. They must match the Zoho item IDs
            exactly — Luma does not create or validate Zoho items.
          </p>
          <ZohoMappingForm
```

Replace it with:

```typescript
        <CardContent>
          <ZohoReadinessCard
            isActive={product.isActive}
            zohoItemIdUnit={product.zohoItemIdUnit ?? null}
            zohoItemIdDisplay={product.zohoItemIdDisplay ?? null}
            zohoItemIdCase={product.zohoItemIdCase ?? null}
            unitsPerDisplay={product.unitsPerDisplay ?? null}
            displaysPerCase={product.displaysPerCase ?? null}
            tabletMappingCount={product.allowed.length}
          />
          <p className="text-[11px] text-text-muted mb-4 leading-relaxed">
            These IDs map Luma product levels to existing Zoho composite items. Luma will use
            these later for tablet receiving and assembly jobs. They must match the Zoho item IDs
            exactly — Luma does not create or validate Zoho items. Run{" "}
            <code className="font-mono text-[10px]">scripts/audit-product-zoho-readiness.ts</code>{" "}
            for a fleet-wide readiness summary before enabling Zoho operations.
          </p>
          <ZohoMappingForm
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "npm notice"
```

Expected: no output / exit 0.

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run
```

Expected: 2426 passed (2413 baseline + 13 from Task 1). No failures.

- [ ] **Step 6: Commit**

```bash
git add "app/(admin)/products/[id]/page.tsx"
git commit -m "$(cat <<'EOF'
feat(products): Zoho readiness banner on product detail page (PRODUCT-MAP-3)

ZohoReadinessCard shows READY/PARTIAL/MISSING/INACTIVE inside the existing
Zoho assembly mapping card. Floor readiness note surfaced separately.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Read-only audit script

**Files:**
- Create: `scripts/audit-product-zoho-readiness.ts`

- [ ] **Step 1: Write the audit script**

Create `scripts/audit-product-zoho-readiness.ts`:

```typescript
// PRODUCT-MAP-3 — Read-only audit of product Zoho assembly readiness.
// Prints a grouped summary of all products by Zoho readiness level,
// plus BOM packaging materials that are missing Zoho item IDs.
//
// Usage:
//   DATABASE_URL=postgres://... tsx scripts/audit-product-zoho-readiness.ts
//
// Read-only. No DB writes. No Zoho calls.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import {
  classifyProductZohoReadiness,
  zohoReadinessReasonLabel,
} from "@/lib/zoho/product-zoho-readiness";

const {
  products,
  productAllowedTablets,
  productPackagingSpecs,
  packagingMaterials,
} = schema;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Error: DATABASE_URL env var is required");
    process.exit(1);
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  const [allProducts, allTabletMappings, allBomRows] = await Promise.all([
    db.select().from(products).orderBy(asc(products.name)),
    db
      .select({ productId: productAllowedTablets.productId })
      .from(productAllowedTablets),
    db
      .select({
        productId: productPackagingSpecs.productId,
        materialName: packagingMaterials.name,
        materialZohoItemId: packagingMaterials.zohoItemId,
      })
      .from(productPackagingSpecs)
      .innerJoin(
        packagingMaterials,
        eq(productPackagingSpecs.packagingMaterialId, packagingMaterials.id),
      ),
  ]);

  // Count tablet mappings per product
  const tabletCountByProduct = new Map<string, number>();
  for (const row of allTabletMappings) {
    tabletCountByProduct.set(
      row.productId,
      (tabletCountByProduct.get(row.productId) ?? 0) + 1,
    );
  }

  // Collect BOM materials missing Zoho IDs
  const bomIssuesByProduct = new Map<string, string[]>();
  for (const row of allBomRows) {
    if (!row.materialZohoItemId) {
      const existing = bomIssuesByProduct.get(row.productId) ?? [];
      existing.push(row.materialName);
      bomIssuesByProduct.set(row.productId, existing);
    }
  }

  type Bucket = { name: string; sku: string; reasons: string[] };
  const ready: Bucket[] = [];
  const partial: Bucket[] = [];
  const missing: Bucket[] = [];
  const inactive: Bucket[] = [];
  const missingTabletMapping: string[] = [];

  for (const product of allProducts) {
    const result = classifyProductZohoReadiness({
      isActive: product.isActive,
      zohoItemIdUnit: product.zohoItemIdUnit ?? null,
      zohoItemIdDisplay: product.zohoItemIdDisplay ?? null,
      zohoItemIdCase: product.zohoItemIdCase ?? null,
      unitsPerDisplay: product.unitsPerDisplay ?? null,
      displaysPerCase: product.displaysPerCase ?? null,
    });

    const bucket: Bucket = {
      name: product.name,
      sku: product.sku,
      reasons: result.reasons.map(zohoReadinessReasonLabel),
    };

    switch (result.level) {
      case "ready":   ready.push(bucket);   break;
      case "partial": partial.push(bucket); break;
      case "missing": missing.push(bucket); break;
      case "inactive": inactive.push(bucket); break;
    }

    const tabletCount = tabletCountByProduct.get(product.id) ?? 0;
    if (product.isActive && tabletCount === 0) {
      missingTabletMapping.push(`${product.name} (${product.sku})`);
    }
  }

  const active = allProducts.filter((p) => p.isActive);

  console.log("\n=== Product Zoho Readiness Audit ===\n");
  console.log(`Total products : ${allProducts.length}`);
  console.log(`Active         : ${active.length}`);
  console.log(`  Ready        : ${ready.length}`);
  console.log(`  Partial      : ${partial.length}`);
  console.log(`  Missing      : ${missing.length}`);
  console.log(`Inactive       : ${inactive.length}`);

  if (partial.length > 0) {
    console.log("\n--- Partially mapped (some Zoho IDs missing) ---");
    for (const b of partial) {
      console.log(`  • ${b.name} (${b.sku})`);
      for (const r of b.reasons) console.log(`      – ${r}`);
    }
  }

  if (missing.length > 0) {
    console.log("\n--- Not mapped (no Zoho assembly IDs) ---");
    for (const b of missing) {
      console.log(`  • ${b.name} (${b.sku})`);
      for (const r of b.reasons) console.log(`      – ${r}`);
    }
  }

  if (missingTabletMapping.length > 0) {
    console.log("\n--- Missing tablet mapping (floor readiness — separate concern) ---");
    for (const label of missingTabletMapping) console.log(`  • ${label}`);
  }

  const bomProductIds = [...bomIssuesByProduct.keys()];
  if (bomProductIds.length > 0) {
    console.log("\n--- BOM materials missing Zoho item ID ---");
    for (const [productId, materials] of bomIssuesByProduct) {
      const p = allProducts.find((x) => x.id === productId);
      const label = p ? `${p.name} (${p.sku})` : productId;
      console.log(`  • ${label}: ${materials.join(", ")}`);
    }
  }

  if (partial.length === 0 && missing.length === 0 && bomProductIds.length === 0) {
    console.log("\n✓ All active products are Zoho-ready.");
  }

  console.log(
    "\nRun this script before enabling Zoho dry-run or live writes.\n",
  );

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck the script**

```bash
npx tsc --noEmit 2>&1 | grep -v "npm notice"
```

Expected: no output / exit 0. Fix any type errors before committing.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-product-zoho-readiness.ts
git commit -m "$(cat <<'EOF'
feat(scripts): read-only Zoho product readiness audit script (PRODUCT-MAP-3)

DATABASE_URL=... tsx scripts/audit-product-zoho-readiness.ts
Prints ready/partial/missing counts, per-product missing IDs,
floor readiness gaps, and BOM materials lacking Zoho item IDs.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Version bump + CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version in `package.json`**

Change `"version": "0.2.47"` → `"version": "0.2.48"`.

- [ ] **Step 2: Prepend CHANGELOG entry**

Add this block at the very top of `CHANGELOG.md`, before the existing `## [0.2.47]` entry:

```markdown
## [0.2.48] — 2026-05-26

### Added
- **Zoho product readiness helper (PRODUCT-MAP-3):** Pure `classifyProductZohoReadiness` in `lib/zoho/product-zoho-readiness.ts`. Classifies active products as READY / PARTIAL / MISSING based only on configured Zoho item IDs (`zohoItemIdUnit`, `zohoItemIdDisplay`, `zohoItemIdCase`). Floor readiness (tablet mapping) is a separate concern, not mixed into the Zoho level. `zohoReadinessLabel` and `zohoReadinessReasonLabel` provide UI copy.
- **Zoho readiness banner on product detail page (PRODUCT-MAP-3):** A compact `ZohoReadinessCard` banner appears inside the existing Zoho assembly mapping card on each product detail page, showing the product's Zoho readiness level, specific missing IDs, and a separate note if tablet mapping is absent. Supervisors can see at a glance whether a product can generate valid Zoho assembly payloads.
- **`scripts/audit-product-zoho-readiness.ts` (PRODUCT-MAP-3):** Read-only CLI script. Prints a grouped summary: total/active/ready/partial/missing/inactive counts, per-product missing Zoho IDs, floor readiness gaps, and BOM materials missing Zoho item IDs. Usage: `DATABASE_URL=postgres://... tsx scripts/audit-product-zoho-readiness.ts`. Run before enabling Zoho dry-run or live writes.

### Tests added (PRODUCT-MAP-3)
- `lib/zoho/product-zoho-readiness.test.ts` (13 tests): inactive early-return, unit-only READY/MISSING, unit+display PARTIAL/READY/MISSING, unit+display+case READY/PARTIAL/MISSING, tablet mapping separation, legacy field contract.

```

- [ ] **Step 3: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore: bump to v0.2.48 — PRODUCT-MAP-3 Zoho readiness visibility

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Final checks + push

- [ ] **Step 1: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "npm notice"
```

Expected: exit 0, no output.

- [ ] **Step 2: Full test run**

```bash
npx vitest run 2>&1 | tail -8
```

Expected: `Tests 2426 passed (2426)` (2413 baseline + 13 new). No failures.

- [ ] **Step 3: Build**

```bash
npx next build 2>&1 | tail -15
```

Expected: exit 0. Pre-existing OTel warning acceptable.

- [ ] **Step 4: Push**

```bash
git push origin main
```

- [ ] **Step 5: Health check**

```bash
curl -s http://192.168.1.134:3000/api/health
```

New SHA will appear after ~60s systemd timer fires.

- [ ] **Step 6: Report git log**

```bash
git log --oneline -6
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Safety/deploy check | Pre-work note |
| Pure helper in `lib/zoho/product-zoho-readiness.ts` | Task 1 |
| READY/PARTIAL/MISSING/INACTIVE levels | Task 1 helper |
| Unit ID always required | Task 1 — `reasons.push("no_unit_id")` |
| Display ID required if `unitsPerDisplay > 0` | Task 1 — guarded |
| Case ID required if `displaysPerCase > 0` | Task 1 — guarded |
| Zoho readiness separate from floor readiness | Task 1 design; no `tabletMappingCount` param |
| Tablet mapping not blocking Zoho level | Task 1 test: "tablet mapping count is not an input" |
| Legacy fallback behavior tested | Task 1 test: "legacy zoho_item_id is not checked" |
| Tests: unit only, partial, missing, inactive, legacy | Task 1 — 13 tests |
| Compact readiness banner on product detail page | Task 2 `ZohoReadinessCard` |
| Banner inside existing Zoho mapping card (not new card) | Task 2 placement |
| Shows missing fields explicitly | Task 2 — renders `zohoReadinessReasonLabel(r)` per reason |
| Separate note for tablet/floor readiness | Task 2 — `floorNote` shown if active + no tablets |
| Read-only audit script | Task 3 |
| Grouped output: total/active/ready/partial/missing/inactive | Task 3 script |
| Per-product missing ID details | Task 3 — prints reasons |
| Missing tablet mapping as separate section | Task 3 — separate section |
| BOM materials missing Zoho IDs | Task 3 — `bomIssuesByProduct` |
| Admin note about audit script | Task 2 — description text links to script |
| Version bump | Task 4 |
| CHANGELOG | Task 4 |
| typecheck + vitest + build | Task 5 |
| push to origin/main | Task 5 |

**Placeholder scan:** None found. All code blocks are complete.

**Type consistency:**
- `ZohoReadinessLevel`: defined Task 1 → used Task 1 (tests, labels), Task 2 (styles lookup), Task 3 (switch).
- `ZohoReadinessReason`: defined Task 1 → used Task 1 (reasons array, tests), Task 2 (map reasons), Task 3 (map reasons).
- `ZohoReadinessResult`: defined Task 1 → used in Task 2 (`result.level`, `result.reasons`), Task 3 same.
- `classifyProductZohoReadiness` signature: `{ isActive, zohoItemIdUnit, zohoItemIdDisplay, zohoItemIdCase, unitsPerDisplay, displaysPerCase }` — consistent across Task 1 implementation, Task 2 call site, Task 3 call site.
- `zohoReadinessLabel(level)`: defined Task 1, used Task 2.
- `zohoReadinessReasonLabel(reason)`: defined Task 1, used Task 2 and Task 3.
