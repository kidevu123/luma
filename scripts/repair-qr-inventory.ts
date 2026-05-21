// Idempotently ensures the physical QR card inventory exists.
// Safe to re-run: never overwrites ASSIGNED or RETIRED card status.

import { db } from "../lib/db";
import { qrCards } from "../lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";

interface CardSpec {
  scanToken: string;
  label: string;
  cardType: "RAW_BAG" | "VARIETY_PACK";
}

function buildSpecs(): CardSpec[] {
  const specs: CardSpec[] = [];

  for (let n = 1; n <= 200; n++) {
    specs.push({
      scanToken: `bag-card-${n}`,
      label: `Bag Card ${n}`,
      cardType: "RAW_BAG",
    });
  }

  for (let n = 1; n <= 5; n++) {
    specs.push({
      scanToken: `variety-pack-${n}`,
      label: `Variety Pack ${n}`,
      cardType: "VARIETY_PACK",
    });
  }

  return specs;
}

async function main() {
  console.log("repair-qr-inventory: starting…");

  const specs = buildSpecs();
  const allTokens = specs.map((s) => s.scanToken);

  // Fetch all existing rows for these tokens in one query.
  const existing = await db
    .select({ scanToken: qrCards.scanToken, cardType: qrCards.cardType })
    .from(qrCards)
    .where(inArray(qrCards.scanToken, allTokens));

  const existingByToken = new Map(existing.map((r) => [r.scanToken, r.cardType]));

  // Partition into: needs insert vs already exists.
  const toInsert: CardSpec[] = [];
  const alreadyExisted: string[] = [];

  for (const spec of specs) {
    if (existingByToken.has(spec.scanToken)) {
      alreadyExisted.push(spec.scanToken);
    } else {
      toInsert.push(spec);
    }
  }

  // Insert new cards in a single call.
  if (toInsert.length > 0) {
    await db.insert(qrCards).values(
      toInsert.map((s) => ({
        label: s.label,
        scanToken: s.scanToken,
        status: "IDLE" as const,
        cardType: s.cardType,
      })),
    );
  }

  // Correct cardType for any existing UNKNOWN cards — one UPDATE per type.
  const unknownRawBagTokens = specs
    .filter(
      (s) =>
        s.cardType === "RAW_BAG" &&
        existingByToken.get(s.scanToken) === "UNKNOWN",
    )
    .map((s) => s.scanToken);

  const unknownVarietyPackTokens = specs
    .filter(
      (s) =>
        s.cardType === "VARIETY_PACK" &&
        existingByToken.get(s.scanToken) === "UNKNOWN",
    )
    .map((s) => s.scanToken);

  let typeCorrected = 0;

  if (unknownRawBagTokens.length > 0) {
    await db
      .update(qrCards)
      .set({ cardType: "RAW_BAG" })
      .where(
        and(
          inArray(qrCards.scanToken, unknownRawBagTokens),
          eq(qrCards.cardType, "UNKNOWN"),
        ),
      );
    typeCorrected += unknownRawBagTokens.length;
  }

  if (unknownVarietyPackTokens.length > 0) {
    await db
      .update(qrCards)
      .set({ cardType: "VARIETY_PACK" })
      .where(
        and(
          inArray(qrCards.scanToken, unknownVarietyPackTokens),
          eq(qrCards.cardType, "UNKNOWN"),
        ),
      );
    typeCorrected += unknownVarietyPackTokens.length;
  }

  console.log(
    `repair-qr-inventory: done — inserted ${toInsert.length}, already existed ${alreadyExisted.length}, types corrected ${typeCorrected}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("repair-qr-inventory: error —", err);
  process.exit(1);
});
