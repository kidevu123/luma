// getStationView() — the single tablet read.
//
// Assembles the whole station payload an operator's tablet needs in
// one call. Phase 1 keeps upNext empty (the queue read model arrives
// in Phase 2) and derives everything else from today's tables.
//
// getStationView is deliberately kept to fetching and delegating: this
// repo runs no database in its test suite (vitest.config.ts excludes
// DB access by design; DB behaviour is verified on staging by deploy
// smoke). Every decision lives in the pure assembleStationView below,
// which is what the tests exercise.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  machines,
  products,
  purchaseOrders,
  qrCards,
  readBagState,
  readStationLive,
  receives,
  smallBoxes,
  stations,
  tabletTypes,
  workflowBags,
} from "@/lib/db/schema";
import type { RouteOperationView } from "@/lib/production/routes";
import { getActiveStationSession } from "@/lib/production/station-operator-session";
import { buildCurrentBagDisplayLabel } from "@/lib/production/current-bag-display-label";
import { resolveOperation } from "./resolve-operation";
import { resolveCompletionInputs } from "./resolve-completion";
import { evaluateChecks, blockersFromChecks, type CheckResult } from "./resolve-exceptions";
import type { CurrentWork, NextAction, StationView, UpNextBag } from "./types";

export type NextActionInput = {
  hasOperatorSession: boolean;
  current: CurrentWork | null;
  operation: RouteOperationView | null;
  checks: CheckResult[];
  bagStage: string | null;
  expected: UpNextBag | null;
};

/** Operator-facing verb for an operation. Never an event name. */
const OPERATION_VERB: Readonly<Record<string, string>> = {
  BLISTER: "Blistering",
  HEAT_SEAL: "Sealing",
  PACKAGING: "Packaging",
  BOTTLE_FILL: "Filling",
  STICKERING: "Stickering",
  INDUCTION_SEAL: "Sealing",
};

export function operationVerb(operationCode: string): string {
  return OPERATION_VERB[operationCode] ?? "Work";
}

export function buildNextAction(input: NextActionInput): NextAction {
  if (!input.hasOperatorSession) return { kind: "OPEN_SHIFT" };

  if (!input.current) {
    return { kind: "SCAN_TO_CLAIM", expected: input.expected };
  }

  const blockers = blockersFromChecks(input.checks);
  if (blockers.length > 0) return { kind: "BLOCKED", blockers };

  if (!input.operation) {
    return { kind: "SCAN_TO_CLAIM", expected: input.expected };
  }

  return {
    kind: "COMPLETE",
    label: `${operationVerb(input.operation.operationCode)} complete`,
    inputs: resolveCompletionInputs(input.operation),
  };
}

export async function getStationView(stationId: string): Promise<StationView> {
  const [stationRow] = await db
    .select({ station: stations, machine: machines })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .where(eq(stations.id, stationId));
  if (!stationRow) throw new Error("Station not found.");

  const session = await getActiveStationSession(db, stationId);

  // Moved verbatim from app/(floor)/floor/[token]/page.tsx:125-145 — do
  // not redesign the joins or select shape.
  const [currentAtStation] = await db
    .select({
      bag: workflowBags,
      card: qrCards,
      state: readBagState,
      product: products,
      inventoryBagNumber: inventoryBags.bagNumber,
      tabletTypeName: tabletTypes.name,
      poNumber: purchaseOrders.poNumber,
    })
    .from(readStationLive)
    .innerJoin(workflowBags, eq(readStationLive.currentWorkflowBagId, workflowBags.id))
    .leftJoin(qrCards, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, receives.poId))
    .where(eq(readStationLive.stationId, stationId));

  const resolved = currentAtStation
    ? await resolveOperation({
        productId: currentAtStation.bag.productId,
        stationKind: stationRow.station.kind,
      })
    : null;

  const currentBagLabel = currentAtStation
    ? buildCurrentBagDisplayLabel({
        cardLabel: currentAtStation.card?.label ?? null,
        poNumber: currentAtStation.poNumber,
        tabletTypeName: currentAtStation.tabletTypeName,
        productName: currentAtStation.product?.name ?? null,
        inventoryBagNumber: currentAtStation.inventoryBagNumber,
        workflowBagNumber: currentAtStation.bag.bagNumber,
      })
    : null;

  return assembleStationView({
    station: {
      id: stationRow.station.id,
      label: stationRow.station.label,
      kind: stationRow.station.kind,
      machineName: stationRow.machine?.name ?? null,
    },
    session: session
      ? { id: session.id, employeeNameSnapshot: session.employeeNameSnapshot }
      : null,
    current: currentAtStation && currentBagLabel
      ? {
          workflowBagId: currentAtStation.bag.id,
          // buildCurrentBagDisplayLabel returns
          // { primary, secondary, hasReceivedContext } — NOT a string.
          // page.tsx:980-984 renders primary as the heading and secondary
          // as a subline, so both must survive into StationView or the
          // rewire in Task 8 would visibly change the screen.
          bagLabel: currentBagLabel.primary,
          bagSubLabel: currentBagLabel.secondary,
          productName: currentAtStation.product?.name ?? null,
          productId: currentAtStation.bag.productId,
          stage: currentAtStation.state?.stage ?? null,
          isPaused: currentAtStation.state?.isPaused ?? false,
          isFinalized: currentAtStation.state?.isFinalized ?? false,
          isOnHold: currentAtStation.state?.isOnHold ?? false,
        }
      : null,
    operation: resolved?.operation ?? null,
  });
}

export type StationViewRows = {
  station: { id: string; label: string; kind: string; machineName: string | null };
  session: { id: string; employeeNameSnapshot: string | null } | null;
  current: {
    workflowBagId: string;
    bagLabel: string;
    bagSubLabel: string | null;
    productName: string | null;
    productId: string | null;
    stage: string | null;
    isPaused: boolean;
    isFinalized: boolean;
    isOnHold: boolean;
  } | null;
  operation: RouteOperationView | null;
};

/** Pure: rows in, StationView out. No DB, no clock, no I/O. */
export function assembleStationView(rows: StationViewRows): StationView {
  const current: CurrentWork | null = rows.current
    ? {
        workflowBagId: rows.current.workflowBagId,
        bagLabel: rows.current.bagLabel,
        bagSubLabel: rows.current.bagSubLabel,
        productName: rows.current.productName,
        statusLine: rows.operation
          ? `Ready to ${operationVerb(rows.operation.operationCode).toLowerCase()}`
          : "Waiting",
        progress: null,
      }
    : null;

  const checks = evaluateChecks({
    bagRecognized: rows.current != null,
    productResolved: rows.current?.productId != null,
    operationResolved: rows.operation != null,
    // Phase 1 does not evaluate material availability; resolve-materials
    // lands in Phase 2 with the queue read model.
    materialsAvailable: true,
    upstreamStageComplete: true,
    bagPaused: rows.current?.isPaused ?? false,
    bagFinalized: rows.current?.isFinalized ?? false,
    bagOnHold: rows.current?.isOnHold ?? false,
    waitingForLabel: null,
  });

  return {
    station: rows.station,
    operator: rows.session
      ? {
          sessionId: rows.session.id,
          name: rows.session.employeeNameSnapshot ?? "Operator",
        }
      : null,
    // Supervisor sessions arrive in Phase 5.
    supervisor: null,
    current,
    // read_bag_queue arrives in Phase 2.
    upNext: [],
    nextAction: buildNextAction({
      hasOperatorSession: rows.session != null,
      current,
      operation: rows.operation,
      checks,
      bagStage: rows.current?.stage ?? null,
      expected: null,
    }),
    capabilities: { canPause: current != null, canReportProblem: true },
  };
}
