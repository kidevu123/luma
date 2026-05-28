import { eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { machines, stations } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { compact } from "@/lib/db/compact";
import type { CurrentUser } from "@/lib/auth";

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
