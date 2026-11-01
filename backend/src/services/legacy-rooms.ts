/**
 * The rooms a workplace used to have, for the migrations alone (note #843).
 *
 * Rooms left the product in three stages: stage 1 moved every room's notes
 * onto its workplace (room-merge-backfill.ts), stage 2 took rooms out of the
 * Workspace, agentbuilt and keys, and stage 3 (note #923) took them out of
 * the model — nothing outside this file and the two migrations knows a room
 * ever existed. What is left is this narrow reader over the old rows, so
 * that a database that has not been through the merge yet (a company's own
 * Agentic Cloud that skipped a release) is still merged before the rooms go
 * (room-drop.ts), and nothing else.
 */
export interface LegacyRoom {
  roomId: string;
  orgId: string;
  name: string;
  /** The room's own namespace, where its notes stood before the merge. */
  namespaceId: string;
  /** 'workspace': the hidden room the Chief of Staff stood in (note #458). */
  purpose?: 'workspace';
}

export interface LegacyRoomStore {
  /** Whether the old rooms are still stored at all. */
  present(): Promise<boolean>;
  /** One workplace's rooms, the hidden one included; [] once dropped. */
  listByOrg(orgId: string): Promise<LegacyRoom[]>;
  /** Every room still stored, across workplaces. */
  listAll(): Promise<LegacyRoom[]>;
  /**
   * Drops the rooms and every room field still written on other records,
   * in one go. Returns how many records of each kind lost a room field.
   */
  drop(): Promise<Record<string, number>>;
}

/** Tests' stand-in: the rows a test seeds, and nothing to strip. */
export class InMemoryLegacyRooms implements LegacyRoomStore {
  private rows: LegacyRoom[] | null;

  constructor(rows: LegacyRoom[] = []) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  async present(): Promise<boolean> {
    return this.rows !== null;
  }

  async listByOrg(orgId: string): Promise<LegacyRoom[]> {
    return (this.rows ?? []).filter((row) => row.orgId === orgId).map((row) => ({ ...row }));
  }

  async listAll(): Promise<LegacyRoom[]> {
    return (this.rows ?? []).map((row) => ({ ...row }));
  }

  async drop(): Promise<Record<string, number>> {
    this.rows = null;
    return {};
  }

  /** Tests seed a room the way an old database held it. */
  add(row: LegacyRoom): LegacyRoom {
    (this.rows ??= []).push({ ...row });
    return row;
  }
}
