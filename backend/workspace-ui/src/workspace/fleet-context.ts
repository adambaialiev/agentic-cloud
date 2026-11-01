import { createContext } from 'react';
import type { HomeAgent } from './live.js';

/**
 * How far along a delete is, for the row that is on its way out. `working`
 * while the machine is being torn down; `leaving` for the moment the row
 * spends going, which is why the delete's own screen hands the reader back to
 * Home BEFORE this flips — a row that is already gone cannot be seen leaving.
 */
export type AgentDeparture = 'working' | 'leaving';

export interface FleetValue {
  /** Agent id → how far along its delete is. */
  departing: ReadonlyMap<string, AgentDeparture>;
  /** The row of every agent on its way out, as it last stood (note #715):
   *  a state read that lands while it is leaving no longer carries it, and
   *  the reader is owed the moment it leaves, not a row that simply vanishes. */
  departingRows: ReadonlyMap<string, HomeAgent>;
  /** Deleted, and dropped locally before any refresh lands: a delete that
   *  succeeded must never look like it did not. */
  removed: ReadonlySet<string>;
  /** Creates in flight. */
  pendingCreates: number;
  /** Start an agent. Resolves once its record has appeared, or the attempt
   *  has been given up on; the banner says which. It named the room to make
   *  it in until rooms left the product (note #843). */
  createAgent: (cli: string) => Promise<boolean>;
  /** Erase one. Resolves as soon as the row is on its way out, so the caller
   *  can hand the reader back to Home while it leaves. */
  deleteAgent: (agent: { id: string; name: string }) => Promise<{ ok: boolean; name: string }>;
}

export const FleetContext = createContext<FleetValue | null>(null);
