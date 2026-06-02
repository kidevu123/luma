/** Ephemeral P0 smoke — full packaging path with UUID clientEventId. */
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import { eq } from "drizzle-orm";
import { readBagState } from "../lib/db/schema";
import { resolveStationAccountability } from "../lib/production/station-operator-session";
import { projectEvent } from "../lib/projector";
import { emitCountBasedPackagingConsumption } from "../lib/projector/packaging-consumption-hook";
import {
  buildPackagingConsumptionPayloadSummary,
  patchPackagingCompleteConsumptionSummary,
} from "../lib/production/packaging-consumption-summary";
import { refreshMaterialReadModelsAfterConsumption } from "../lib/projector/material-read-model-refresh";

const stationId = "c174b1e0-4daf-4eb5-927b-622dd8038553";
const bagId = "6b5020a8-9e29-4cf3-b357-6de6677fd18f";

async function main() {
  const clientEventId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId,
        overrideEmployeeCode: null,
      });
      const occurredAt = new Date();
      await projectEvent(tx, {
        workflowBagId: bagId,
        stationId,
        eventType: "PACKAGING_COMPLETE",
        payload: { master_cases: 1, displays_made: 0, loose_cards: 0, damaged_packaging: 0, ripped_cards: 0 },
        clientEventId,
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot: accountability.accountableEmployeeNameSnapshot,
      });
      const consumption = await emitCountBasedPackagingConsumption(tx, {
        workflowBagId: bagId,
        stationId,
        payload: { master_cases: 1, displays_made: 0, loose_cards: 0, damaged_packaging: 0, ripped_cards: 0 },
        occurredAt,
      });
      await patchPackagingCompleteConsumptionSummary(tx, {
        workflowBagId: bagId,
        summary: buildPackagingConsumptionPayloadSummary(consumption),
        clientEventId,
      });
      await refreshMaterialReadModelsAfterConsumption(tx);
      const [st] = await tx.select({ stage: readBagState.stage }).from(readBagState).where(eq(readBagState.workflowBagId, bagId));
      console.log("stage", st?.stage, "employee", accountability.accountableEmployeeId);
      throw new Error("ROLLBACK");
    });
  } catch (err) {
    if (err instanceof Error && err.message === "ROLLBACK") {
      console.log("PASS");
      return;
    }
    console.error("FAIL", err);
    process.exit(1);
  }
}

main();
