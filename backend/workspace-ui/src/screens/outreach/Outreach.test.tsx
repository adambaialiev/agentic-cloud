import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  outreachDraft, outreachNext, outreachTargetId, outreachWordCount, parseOutreachSeed, sortOutreachRows,
  type OutreachListAnswer, type OutreachRow, type OutreachSeed, type OutreachTargetAnswer, type OutreachTargetRecord, type OutreachTouch,
} from '../../../../src/shared/outreach.js';
import { fixtureOutreachSeed } from '../../../../src/shared/outreach-fixtures.js';
import { App } from '../../App.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

const org = { orgId: 'org-1', name: 'ACC', role: 'admin' as const, members: 1, seats: 1, seatProviders: ['claude' as const] };

function seed(): OutreachSeed {
  const parsed = parseOutreachSeed(fixtureOutreachSeed());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.seed;
}

/** What the server would answer, built from the same shared rules it uses. */
function world(now = new Date(), touchesFor: Record<string, OutreachTouch[]> = {}, states: Record<string, OutreachTargetRecord['state']> = {}) {
  const words = seed();
  const records: OutreachTargetRecord[] = words.targets.map((target) => ({
    id: outreachTargetId(target.company), userId: 'u', seed: target, edits: {}, state: states[outreachTargetId(target.company)] ?? 'not-contacted',
    stateAt: null, importedAt: '2026-11-09T12:50:00Z', inLatestImport: true,
  }));
  const rowOf = (record: OutreachTargetRecord): OutreachRow => {
    const touches = touchesFor[record.id] ?? [];
    return {
      id: record.id, company: record.seed.company, group: record.seed.group, fit: record.seed.fit, firstBatchOrder: record.seed.firstBatchOrder,
      city: record.seed.city, person: record.seed.person, email: record.seed.email, verification: record.seed.verification,
      state: record.state, stateAt: null, lastTouchAt: touches[0]?.at ?? null, next: outreachNext(record, touches, now),
      written: Boolean(record.seed.firstEmail), inLatestImport: true,
    };
  };
  const list = (firstSends = 0): OutreachListAnswer => ({
    imported: { at: '2026-11-09T12:50:00Z', source: words.source, generatedBy: 'test', generatedAt: '2026-11-09' },
    rows: sortOutreachRows(records.map(rowOf), new Map(records.map((record) => [record.id, record.seed.number]))),
    firstSends, reviewAfter: 15,
  });
  const detail = (id: string): OutreachTargetAnswer => {
    const record = records.find((one) => one.id === id)!;
    const row = rowOf(record);
    const touches = touchesFor[id] ?? [];
    const draft = outreachDraft(record, words, touches, row.next);
    return { row, seed: record.seed, edits: {}, touches, draft, noSend: draft ? null : 'Nothing to send.' };
  };
  return { words, list, detail };
}

function open(path: string, script: Record<string, Answer>, owner = true) {
  const test = scriptedApi({ ...workspaceScript(() => emptyState({ org, ...(owner ? { outreach: true as const } : {}) })), ...script });
  render(<MemoryRouter initialEntries={[path]}><App api={test.api} /></MemoryRouter>);
  return test;
}

afterEach(cleanup);

describe('Outreach (note #1089)', () => {
  it('is no screen at all for anybody but the owner', async () => {
    open('/outreach', {}, false);
    await waitFor(() => expect(document.querySelector('#screenOutreach')).toBeNull());
    expect(await screen.findByText('This is not a Workspace address we know. Home is the honest place to start.')).toBeTruthy();
  });

  it('offers the import before anything is brought in, and sends nothing by it', async () => {
    const test = open('/outreach', {
      'GET api/outreach': () => ({ imported: null, rows: [], firstSends: 0, reviewAfter: 15 }),
      'POST api/outreach/import': () => ({ added: 14, updated: 0, kept: 0, total: 14 }),
    });
    const go = await screen.findByRole('button', { name: 'Import' });
    expect((document.querySelector('#outreachImportNote') as HTMLInputElement).value).toBe('1089');
    expect((document.querySelector('#outreachImportFile') as HTMLInputElement).value).toBe('outreach-targets.json');
    fireEvent.click(go);
    await waitFor(() => expect(test.calls.some((call) => call.path === 'api/outreach/import')).toBe(true));
    const call = test.calls.find((one) => one.path === 'api/outreach/import')!;
    expect(JSON.parse(String(call.init!.body))).toEqual({ note: '1089', file: 'outreach-targets.json' });
    expect(test.calls.some((one) => one.path.includes('/send'))).toBe(false);
  });

  it('lists the first batch in order, then the groups, the dropped last, with the gaps showing', async () => {
    const { list } = world(new Date('2026-11-09T13:00:00Z'));
    open('/outreach', { 'GET api/outreach': () => list() });
    await waitFor(() => expect(document.querySelectorAll('.outreachrow').length).toBe(14));
    const sections = [...document.querySelectorAll('#screenOutreach section h2')].map((h) => h.textContent);
    expect(sections).toEqual(['First batch', 'Group B', 'Group C', 'Not a fit']);
    const batch = [...document.querySelectorAll('#outreach-batch .outreachrow')].map((row) => row.getAttribute('data-target'));
    expect(batch).toHaveLength(10);
    expect(batch[0]).toBe('northwind-health');
    const solace = document.querySelector('[data-target="solace-studio"]')!.textContent!;
    expect(solace).toContain('No address on note #799');
    expect(solace).toContain('No city');
    expect(document.querySelector('[data-target="juniper-works"]')!.textContent).toContain('US remote · no local time');
    expect(document.querySelector('#outreachReview')).toBeNull();
  });

  it('says so after fifteen first letters', async () => {
    const { list } = world();
    open('/outreach', { 'GET api/outreach': () => list(15) });
    expect((await screen.findByText(/15 first letters have gone/)).id).toBe('outreachReview');
  });

  it('opens the note\'s own letter word for word, counted as the note counts, and sends exactly the box', async () => {
    const { detail, words } = world(new Date('2026-11-09T13:00:00Z'));
    const answer = detail('northwind-health');
    const test = open('/outreach/northwind-health', {
      'GET api/outreach/targets/northwind-health': () => answer,
      'POST api/outreach/targets/northwind-health/send': () => ({ touch: {}, mailId: 'mm_1' }),
    });
    const box = await waitFor(() => { const found = document.querySelector('#outreachTextField') as HTMLTextAreaElement; expect(found).toBeTruthy(); return found; });
    const written = words.targets[0]!.firstEmail!;
    expect(box.value).toBe(written.body);
    expect((document.querySelector('#outreachSubjectField') as HTMLInputElement).value).toBe(written.subject);
    expect(document.querySelector('#outreachWordCount')!.textContent).toContain(`${outreachWordCount(written.subject, written.body)} words · `);
    expect(document.querySelector('#outreachNotThis')!.textContent).toContain('patient line');
    expect(document.querySelector('#outreachLocal')!.textContent).toMatch(/^San Francisco · \w{3} \d\d:\d\d there$/);
    fireEvent.change(box, { target: { value: `${written.body}\nPS` } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to mara@northwind-health.test' }));
    await waitFor(() => expect(test.calls.some((call) => call.path.endsWith('/send'))).toBe(true));
    const sent = JSON.parse(String(test.calls.find((call) => call.path.endsWith('/send'))!.init!.body));
    expect(sent).toEqual({ step: 'first', subject: written.subject, text: `${written.body}\nPS` });
  });

  it('keeps Send off while a template placeholder is left in the box', async () => {
    const { detail } = world();
    open('/outreach/kestrel-systems', { 'GET api/outreach/targets/kestrel-systems': () => detail('kestrel-systems') });
    const go = await screen.findByRole('button', { name: 'Send to hello@kestrel.test' });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('#outreachPlaceholders')!.textContent).toBe('Fill in {first name} and {their line} before sending.');
  });

  it('shows a follow-up\'s day until it comes, and nothing to press', async () => {
    const sentAt = '2026-11-09T13:00:00.000Z';
    const touches: OutreachTouch[] = [{ id: 't1', targetId: 'northwind-health', at: sentAt, kind: 'sent', step: 'first', mailId: 'mm_1', to: 'mara@northwind-health.test', subject: 'Your agents need a workplace', text: 'Hi' }];
    const { detail } = world(new Date('2026-11-10T13:00:00Z'), { 'northwind-health': touches }, { 'northwind-health': 'sent' });
    open('/outreach/northwind-health', { 'GET api/outreach/targets/northwind-health': () => detail('northwind-health') });
    expect((await screen.findByText(/Day-4 follow-up on Fri 13 Nov/)).id).toBe('outreachNotYet');
    expect(document.querySelector('#outreachSendGo')).toBeNull();
    expect(document.querySelector('[data-kind="sent"]')!.textContent).toContain('First letter sent to mara@northwind-health.test');
  });
});
