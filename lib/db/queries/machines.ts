import { eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { machines, stations } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { compact } from "@/lib/db/compact";
import type { CurrentUser } from "@/lib/auth";
import {
  getMachineDeactivateBlockers,
  getStationDeactivateBlockers,
} from "@/lib/production/station-management";

export async function listMachines() {
  return db.select().from(machines).orderBy(asc(machines.name));
}

export async function listStations() {
  return db
    .select({ station: stations, machineName: machines.name })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .orderBy(asc(stations.label));
}

export async function listStationsGrouped() {
  const rows = await listStations();
  return {
    active: rows.filter((r) => r.station.isActive),
    inactive: rows.filter((r) => !r.station.isActive),
  };
}

export async function listMachinesGrouped() {
  const rows = await listMachines();
  return {
    active: rows.filter((m) => m.isActive),
    inactive: rows.filter((m) => !m.isActive),
  };
}

export async function createMachine(
  input: { name: string; kind: typeof machines.$inferInsert.kind; cardsPerTurn?: number | undefined; isActive?: boolean | undefined },
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(machines).values(compact(input)).returning();
    if (!row) throw new Error("createMachine: insert empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "machine.create",
        targetType: "Machine",
        targetId: row.id,
        after: row,
      },
      tx,
    );
    return row;
  });
}

export async function updateMachineCardsPerTurn(
  machineId: string,
  cardsPerTurn: number,
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(machines)
      .where(eq(machines.id, machineId));
    if (!before) throw new Error("updateMachineCardsPerTurn: not found");
    const [row] = await tx
      .update(machines)
      .set({ cardsPerTurn })
      .where(eq(machines.id, machineId))
      .returning();
    if (!row) throw new Error("updateMachineCardsPerTurn: update empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "machine.update_cards_per_turn",
        targetType: "Machine",
        targetId: machineId,
        before: { cardsPerTurn: before.cardsPerTurn },
        after: { cardsPerTurn: row.cardsPerTurn },
      },
      tx,
    );
    return row;
  });
}

export async function rotateStationToken(id: string, actor: CurrentUser) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(stations).where(eq(stations.id, id));
    if (!before) throw new Error("rotateStationToken: not found");
    // crypto.randomUUID gives a 122-bit random token — replaces the
    // Math.random()-based legacy format which was ~41 bits + a
    // predictable kind prefix. A scraper enumerating /floor/<token>
    // could find live stations against the old format.
    const fresh = crypto.randomUUID();
    const [row] = await tx
      .update(stations)
      .set({ scanToken: fresh })
      .where(eq(stations.id, id))
      .returning();
    if (!row) throw new Error("rotateStationToken: update empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "station.rotate_token",
        targetType: "Station",
        targetId: id,
        before: { token: before.scanToken },
        after: { token: row.scanToken },
      },
      tx,
    );
    return row;
  });
}

export async function createStation(
  input: {
    label: string;
    kind: typeof stations.$inferInsert.kind;
    machineId?: string | null | undefined;
  },
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const scanToken = crypto.randomUUID();
    const [row] = await tx
      .insert(stations)
      .values(compact({ ...input, scanToken }))
      .returning();
    if (!row) throw new Error("createStation: insert empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "station.create",
        targetType: "Station",
        targetId: row.id,
        after: row,
      },
      tx,
    );
    return row;
  });
}

export async function updateMachineName(
  machineId: string,
  name: string,
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(machines)
      .where(eq(machines.id, machineId));
    if (!before) throw new Error("updateMachineName: not found");
    const [row] = await tx
      .update(machines)
      .set({ name })
      .where(eq(machines.id, machineId))
      .returning();
    if (!row) throw new Error("updateMachineName: update empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "machine.update",
        targetType: "Machine",
        targetId: machineId,
        before: { name: before.name },
        after: { name: row.name },
      },
      tx,
    );
    return row;
  });
}

export async function setMachineActive(
  machineId: string,
  isActive: boolean,
  actor: CurrentUser,
) {
  if (!isActive) {
    const blockers = await getMachineDeactivateBlockers(machineId);
    if (blockers.length > 0) {
      throw new Error(blockers.join(" "));
    }
  }
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(machines)
      .where(eq(machines.id, machineId));
    if (!before) throw new Error("setMachineActive: not found");
    const [row] = await tx
      .update(machines)
      .set({ isActive })
      .where(eq(machines.id, machineId))
      .returning();
    if (!row) throw new Error("setMachineActive: update empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: isActive ? "machine.reactivate" : "machine.deactivate",
        targetType: "Machine",
        targetId: machineId,
        before: { isActive: before.isActive, name: before.name },
        after: { isActive: row.isActive, name: row.name },
      },
      tx,
    );
    return row;
  });
}

export async function updateStationLabel(
  stationId: string,
  label: string,
  actor: CurrentUser,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(stations)
      .where(eq(stations.id, stationId));
    if (!before) throw new Error("updateStationLabel: not found");
    const [row] = await tx
      .update(stations)
      .set({ label })
      .where(eq(stations.id, stationId))
      .returning();
    if (!row) throw new Error("updateStationLabel: update empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: "station.update",
        targetType: "Station",
        targetId: stationId,
        before: { label: before.label, scanToken: before.scanToken },
        after: { label: row.label, scanToken: row.scanToken },
      },
      tx,
    );
    return row;
  });
}

export async function setStationActive(
  stationId: string,
  isActive: boolean,
  actor: CurrentUser,
) {
  if (!isActive) {
    const blockers = await getStationDeactivateBlockers(stationId);
    if (blockers.length > 0) {
      throw new Error(blockers.join(" "));
    }
  }
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(stations)
      .where(eq(stations.id, stationId));
    if (!before) throw new Error("setStationActive: not found");
    const [row] = await tx
      .update(stations)
      .set({ isActive })
      .where(eq(stations.id, stationId))
      .returning();
    if (!row) throw new Error("setStationActive: update empty");
    await writeAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: isActive ? "station.reactivate" : "station.deactivate",
        targetType: "Station",
        targetId: stationId,
        before: {
          isActive: before.isActive,
          label: before.label,
          scanToken: before.scanToken,
        },
        after: {
          isActive: row.isActive,
          label: row.label,
          scanToken: row.scanToken,
        },
      },
      tx,
    );
    return row;
  });
}
