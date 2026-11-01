import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrgSeatSignInFlow } from '../../services/org-seat-signin-flow.js';
import { InMemorySeatSignInStorage } from '../../services/seat-signin-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { CODEX_OAUTH_TOKEN_ENDPOINT } from '../../agent/codex/codex-device-login.js';
import { fakeOpenAiLogin } from '../helpers/fake-openai-login.js';

/**
 * A backend restart in the middle of a ChatGPT sign-in.
 *
 * Deploys restart the backend several times a day, and the member approving
 * a device code is on OpenAI's page, where nothing of ours can see them. On
 * 2026-09-06 (when the ceremony still ran on the member's machine) a deploy
 * landed mid-ceremony, the new process came up with an empty map, and the
 * code the member had already approved was spent on nothing. The device
 * login is written down, so the next process collects the approval instead.
 */

afterEach(() => { vi.useRealTimers(); });

async function orgWithMember() {
  const orgStorage = new InMemoryOrgStorage();
  const org = await orgStorage.createOrg({ name: 'Growth', createdByUserId: 'ruby-owner' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'ruby-owner', role: 'admin' });
  return { orgStorage, orgId: org.orgId };
}

describe('a ChatGPT sign-in survives the backend restarting under it', () => {
  it('resumes the same code across a restart and lands the seat in the new process', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { orgStorage, orgId } = await orgWithMember();
    const seatSignInStorage = new InMemorySeatSignInStorage();
    const openai = fakeOpenAiLogin();

    // --- the old process: the code is up and the member is approving ---
    const before = new OrgSeatSignInFlow({ orgStorage, seatSignInStorage, fetchImpl: openai.fetchImpl });
    expect((await before.start({ userId: 'ruby-owner', orgId, provider: 'codex' })).state)
      .toMatchObject({ phase: 'awaiting_approval', userCode: '6LP7-E6DH7' });

    // --- a deploy restarts the backend ---
    // A new process is a new flow over the same durable storage. Nothing of
    // the old one's memory comes with it.
    const after = new OrgSeatSignInFlow({ orgStorage, seatSignInStorage, fetchImpl: openai.fetchImpl });
    await after.restore();

    // The member's screen picks up where it was — the SAME one-time code,
    // still valid, with nothing asked of them a second time.
    expect((await after.poll('ruby-owner'))?.state)
      .toMatchObject({ phase: 'awaiting_approval', userCode: '6LP7-E6DH7' });

    // They approve. The new process collects the login.
    openai.state.approved = true;
    vi.setSystemTime(Date.now() + 6_000);
    expect((await after.poll('ruby-owner'))?.state.phase).toBe('done');
    expect(await orgStorage.listSeatsByMember(orgId, 'ruby-owner')).toHaveLength(1);
    // The record is off the books.
    expect(await seatSignInStorage.listAll()).toHaveLength(0);
  });

  it('is the storage that carries it: with nothing written down, there is nothing to resume', async () => {
    const { orgStorage, orgId } = await orgWithMember();
    const openai = fakeOpenAiLogin();
    const before = new OrgSeatSignInFlow({ orgStorage, fetchImpl: openai.fetchImpl });
    await before.start({ userId: 'ruby-owner', orgId, provider: 'codex' });
    const after = new OrgSeatSignInFlow({ orgStorage, fetchImpl: openai.fetchImpl });
    expect(await after.poll('ruby-owner')).toBeNull();
  });

  it('brings back nothing older than the code it belongs to', async () => {
    const { orgStorage, orgId } = await orgWithMember();
    const seatSignInStorage = new InMemorySeatSignInStorage();
    // A ceremony from twenty minutes ago: past the provider's code lifetime.
    await seatSignInStorage.save({
      userId: 'ruby-owner',
      orgId,
      provider: 'codex',
      startedAt: Date.now() - 20 * 60_000,
      state: { phase: 'awaiting_approval', url: 'https://auth.openai.com/codex/device', userCode: '6LP7-E6DH7' },
      device: { deviceAuthId: 'dev-auth-1', userCode: '6LP7-E6DH7', intervalSeconds: 5 },
    });
    const flow = new OrgSeatSignInFlow({ orgStorage, seatSignInStorage, fetchImpl: fakeOpenAiLogin().fetchImpl });
    await flow.restore();

    // It answers nothing, and it does not sit in the table waiting to be
    // read again on the next boot.
    expect(await flow.poll('ruby-owner')).toBeNull();
    expect(await seatSignInStorage.listAll()).toHaveLength(0);
  });

  it('drops a machine-run ceremony recorded before the backend minted logins itself', async () => {
    // Written by the previous deploy: a CLI in a tmux pane on a machine,
    // with no device login this code could ask OpenAI about.
    const { orgStorage, orgId } = await orgWithMember();
    const seatSignInStorage = new InMemorySeatSignInStorage();
    await seatSignInStorage.save({
      userId: 'ruby-owner',
      orgId,
      provider: 'codex',
      sandboxId: 'fly-sandbox-ia-ruby.aa11',
      startedAt: Date.now() - 60_000,
      state: { phase: 'awaiting_approval', url: 'https://auth.openai.com/codex/device', userCode: '6LP7-E6DH7' },
    } as never);
    const flow = new OrgSeatSignInFlow({ orgStorage, seatSignInStorage, fetchImpl: fakeOpenAiLogin().fetchImpl });
    await flow.restore();
    expect(await flow.poll('ruby-owner')).toBeNull();
    expect(await seatSignInStorage.listAll()).toHaveLength(0);
  });

  it('takes an approved login off the record before spending its single-use code', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { orgStorage, orgId } = await orgWithMember();
    const seatSignInStorage = new InMemorySeatSignInStorage();
    const openai = fakeOpenAiLogin();
    // What a restart during the exchange would find on the books.
    let recordedAtExchange: number | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === CODEX_OAUTH_TOKEN_ENDPOINT) recordedAtExchange = (await seatSignInStorage.listAll()).length;
      return openai.fetchImpl(input, init);
    }) as typeof fetch;
    const flow = new OrgSeatSignInFlow({ orgStorage, seatSignInStorage, fetchImpl });
    await flow.start({ userId: 'ruby-owner', orgId, provider: 'codex' });
    expect(await seatSignInStorage.listAll()).toHaveLength(1);

    openai.state.approved = true;
    vi.setSystemTime(Date.now() + 6_000);
    expect((await flow.poll('ruby-owner'))?.state.phase).toBe('done');
    expect(recordedAtExchange).toBe(0);
  });
});
