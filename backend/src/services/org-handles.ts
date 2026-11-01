import { deriveHandle, handleProblem } from '../shared/handles.js';
import { mailAddress } from '../shared/workspace-mail.js';
import type { OrgStorage } from './org-storage.js';
import type { OrgDocument } from '../types/org.js';

/**
 * A workplace's handle (knowledge page "public-addresses", owner decisions
 * of 2026-09-26): the word its repositories live under at the root of the
 * domain, `agenticcloudcomputer.com/acme/site`. The workplace itself has no
 * page there and the word is shown nowhere (the owner, 2026-10-12, note
 * #748); it is an identifier. It is READ OFF THE NAME and never chosen or
 * changed — repository addresses are for keeps — so the only question here
 * is which free word the name becomes.
 *
 * People and workplaces share that one namespace, so every candidate is
 * checked three ways in order: is the word reserved, does a PERSON hold it
 * as their address name, does another workplace hold it. The storage claim
 * is the tie-break when two askers race.
 */
export class OrgHandleService {
  constructor(private readonly deps: {
    orgStorage: OrgStorage;
    /** The account holding this address, or null — the mailbox service's `holderOf`. */
    mailboxHolder?: (address: string) => Promise<string | null>;
  }) {}

  private async heldByPerson(handle: string): Promise<boolean> {
    if (!this.deps.mailboxHolder) return false;
    return (await this.deps.mailboxHolder(mailAddress(handle))) !== null;
  }

  /**
   * The handle a workplace's name becomes: `acme-trading`, or `-2`, `-3`…
   * when the plain word is somebody's. Never throws on a taken word; it
   * keeps counting. Null only when the workplace is gone or two hundred
   * words are all taken.
   */
  async assignDerived(org: Pick<OrgDocument, 'orgId' | 'name'>): Promise<string | null> {
    for (let suffix = 1; suffix <= 200; suffix += 1) {
      const candidate = deriveHandle(org.name, suffix);
      if (handleProblem(candidate)) continue;
      if (await this.heldByPerson(candidate)) continue;
      const outcome = await this.deps.orgStorage.claimHandle(org.orgId, candidate);
      if (outcome === 'claimed') return candidate;
      if (outcome === 'missing') return null;
    }
    return null;
  }

  /**
   * Every workplace without a handle gets one, once, at boot. Idempotent: a
   * workplace already holding a word is left alone, and a workplace whose
   * every candidate is taken is simply tried again next boot.
   */
  async backfill(): Promise<{ assigned: number; skipped: number }> {
    let assigned = 0;
    let skipped = 0;
    for (const org of await this.deps.orgStorage.listOrgs()) {
      if (org.handle) continue;
      const handle = await this.assignDerived(org);
      if (handle) assigned += 1; else skipped += 1;
    }
    return { assigned, skipped };
  }
}
