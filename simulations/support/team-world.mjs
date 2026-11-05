/**
 * The lived-in Workspace: what Northstar Studio looks like a day after the
 * first result, as `fixtures/team.json` holds it, and the three journeys that
 * move it — a second person joining, a note handed to an agent that comes
 * back as a change proposal, and the tour a screenshot run takes through
 * every screen.
 *
 * Same rules as the first-day mock: every field advances by ONE user action,
 * or by the reads the UI makes while it waits (the agent's chat polls are
 * the clock for work happening on its machine). The world answers only the
 * requests it knows; anything else falls through to the fixture server,
 * which faults on what neither recognises.
 *
 * Stages:
 *   `invite`  — Leo has no account yet; the owner is alone in the org.
 *   `invite-known` — Leo has an account and a workplace of his own already;
 *               the owner is alone in the org.
 *   `joined`  — Leo is a member; note #7 is not written yet; Milo's
 *               knowledge proposal waits; no change proposal exists.
 *   `settled` — everything landed: note #7 live, PR #1 merged, the page
 *               published, the site live. The tour reads this one.
 */

const iso = (value) => new Date(value).toISOString();

/**
 * The faces. An agent wears the product's own avatar, from the same pool and
 * at the same address the real backend serves it from; a person and the
 * workplace wear the pictures committed beside this fixture. Every field
 * the UI would draw a face from carries one, so no screen ever falls back to
 * the grey glyph — which in a marketing screenshot reads as a missing
 * feature rather than as a person who has not uploaded a photograph.
 */
const dogFace = (agentName) => `/workspace/avatars/${agentName.toLowerCase()}`;
const personFace = (username) => `/workspace/faces/${username.split('_')[0]}.svg`;
const ORG_MARK = '/workspace/faces/northstar.svg';

// ── Subscription windows ───────────────────────────────────────────────────
/**
 * The one fixture fact that has to be measured against the reader's own
 * clock. A window's PACE is how much of its own length has gone by against
 * how much of it has been spent (`src/shared/usage-pace.ts`), so a window
 * whose reset is a fixed date is simply in the past by the next time anyone
 * runs this — and `windowPace` returns null, which draws no tick and no
 * line. Each fixture window therefore carries `elapsedFraction`, how far
 * through itself it is, and the reset is derived from it at read time.
 *
 * The real backend sends the seat's own screen a full window (label, length
 * and both reset forms) and the compact strip a projection with the verdict
 * already decided; these two build the same pair, so the pictures show what
 * the shipped API produces rather than what the fixture found convenient.
 */

/** `formatUsageReset`: reset stamps render in UTC and say so. */
const utcStamp = (ms) => `${new Intl.DateTimeFormat('en', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
}).format(new Date(ms))} UTC`;

/**
 * The ChatGPT seat's one window. A seat with a single window has no second
 * track to tell it apart from, so `formatUsageTrackLabel` leaves it
 * unadorned and the compact row reads "12% used".
 */
const CODEX_WINDOW = { label: '5 hours', usedPercent: 12, percentText: '12', windowMins: 300, elapsedFraction: 0.16 };

/** One window as the seat's own screen reads it, resets included. */
function seatWindow(spec, now = Date.now()) {
  const { elapsedFraction, ...window } = spec;
  if (elapsedFraction === undefined || !window.windowMins) return window;
  const resetMs = now + window.windowMins * 60_000 * (1 - elapsedFraction);
  return { ...window, resetAt: iso(resetMs), resetsText: utcStamp(resetMs) };
}

/** Within this many points of even, `usage-pace.ts` calls it even. */
const PACE_DEADBAND = 3;

/** The same window as the compact seat strip carries it: no label, no
 *  length, and the pace already reduced to its verdict. */
function seatStripWindow(spec) {
  const { label, windowMins, elapsedFraction, ...window } = spec;
  if (elapsedFraction === undefined || !windowMins) return window;
  const delta = window.usedPercent - elapsedFraction * 100;
  return {
    ...window,
    pace: delta > PACE_DEADBAND ? 'ahead' : delta < -PACE_DEADBAND ? 'under' : 'even',
  };
}

export function createTeamWorld({ fixture, team, stage = 'joined' }) {
  if (!['invite', 'invite-known', 'joined', 'settled'].includes(stage)) throw new Error(`Unknown team stage: ${stage}`);
  const owner = { userId: team.owner.userId, name: fixture.account.displayName, username: fixture.account.username };
  const member = { userId: team.member.userId, name: team.member.displayName, username: team.member.username };
  const ruby = fixture.agent;
  const milo = team.milo;
  const roomId = fixture.room.roomId;

  // ── State ────────────────────────────────────────────────────────────────
  const membership = new Map([[owner.userId, { role: 'admin', joinedAt: '2026-09-06T07:00:00.000Z', here: true }]]);
  const joining = stage === 'invite' || stage === 'invite-known';
  if (!joining) membership.set(member.userId, { role: 'member', joinedAt: '2026-09-06T08:15:00.000Z', invitedByName: owner.name });
  const invites = [];
  const joinRequests = [];
  // A workplace of the joiner's own: only `invite-known`'s, made before the
  // link reached him. An account made THROUGH the link gets none (note #949),
  // so after the `invite` stage registers the team's workplace is his only one.
  let spareOrg = null;
  // `invite-known`: Leo already has an account and a workplace of his own,
  // set up and named, when the link reaches him.
  if (stage === 'invite-known') {
    member.name = `${team.member.firstName} ${team.member.lastName}`;
    spareOrg = {
      orgId: 'org_leo_own', name: 'Okafor Design', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'],
      paymentRequiredSeatProviders: [], seatUsage: [], founded: true,
    };
  }
  // The real register route, given a live link (note #949): no spare
  // workplace, and the request to join filed with the account.
  function registered(account, inviteToken) {
    member.name = account.displayName;
    if (!invites.some((row) => row.token === inviteToken)) throw new Error('the joiner registered with a link that is not live');
    joinRequests.push({ requestId: `req_${account.username}`, userId: account.userId, name: account.displayName, username: account.username, requestedAt: iso(Date.now()), status: 'pending' });
  }
  const notes = team.notes.map((note) => ({
    ...note,
    comments: (note.comments || []).map((comment) => ({
      ...comment,
      ...(comment.agentName ? { agentAvatarUrl: dogFace(comment.agentName) } : {}),
    })),
  }));
  let proposal = null;          // PR #1 once Ruby proposes it
  let kpStatus = stage === 'settled' ? 'approved' : 'open';
  const knowledgePages = team.knowledgePages.map((page) => ({ ...page, agentName: milo.name, agentAvatarUrl: dogFace(milo.name), updatedByAgentId: milo.id }));
  let site = null;
  const chats = { [ruby.id]: [], [milo.id]: [] };
  let rubyPolls = null;         // null until the handoff; then the clock
  let rubyAcked = false;
  const notifications = [];

  const seq = (agentId) => chats[agentId].length + 1;
  const say = (agentId, row) => { chats[agentId].push({ seq: seq(agentId), ...row }); };

  // The transcripts as they stand before the scenario touches anything.
  say(ruby.id, { role: 'owner', text: fixture.firstJob.brief, at: '2026-09-06T08:04:00.000Z' });
  say(ruby.id, { role: 'agent', text: fixture.firstJob.reply, at: '2026-09-06T08:05:00.000Z' });
  for (const row of milo.chat) say(milo.id, row);
  say(milo.id, { role: 'platform', text: team.knowledgeProposal.card, at: team.knowledgeProposal.createdAt, open: { kp: team.knowledgeProposal.id } });
  if (stage === 'joined') {
    notifications.push({
      ...team.notification, userId: owner.userId, kind: 'agent_completed', source: 'direct_agent_chat',
      url: `/chat/${milo.id}`, dedupeKey: `chat:${milo.id}:2`,
    });
  }

  function publishKnowledgePage() {
    const kp = team.knowledgeProposal;
    knowledgePages.push({
      name: kp.page, title: kp.title, description: kp.description, html: kp.html,
      sizeBytes: kp.html.length, sha: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
      updatedAt: iso(Date.now()), agentName: milo.name, agentAvatarUrl: dogFace(milo.name), updatedByAgentId: milo.id,
    });
  }
  function createNote7() {
    const now = iso(Date.now());
    const note = { ...team.newNote, createdAt: now, updatedAt: now, work: { state: 'unclaimed' }, comments: [] };
    notes.push(note);
    return note;
  }
  function propose() {
    const p = team.proposal;
    proposal = { status: 'open', decidedAt: null, delivery: null };
    say(ruby.id, { role: 'platform', text: p.card, at: iso(Date.now()), open: { pr: p.id } });
    const note = notes.find((row) => row.number === team.newNote.number);
    if (note) note.work = { state: 'proposal', proposalNumber: p.number, proposalStatus: 'open' };
  }
  function merge() {
    const p = team.proposal;
    const now = iso(Date.now());
    proposal.status = 'merged';
    proposal.decidedAt = now;
    proposal.delivery = { sha: p.headSha, branch: p.delivery.branch, mergedAt: now, checks: p.delivery.checks, live: true };
    say(ruby.id, { role: 'platform', text: p.mergedCard, at: now, open: { pr: p.id } });
    const note = notes.find((row) => row.number === team.newNote.number);
    if (note) note.work = { state: 'live', proposalNumber: p.number, proposalStatus: 'merged' };
    site = { ...team.site, roomId, status: 'live', agentName: ruby.name, agentAvatarUrl: dogFace(ruby.name), iconUrl: ORG_MARK, lastDeployAt: now };
  }
  if (stage === 'settled') {
    publishKnowledgePage();
    say(milo.id, { role: 'platform', text: team.knowledgeProposal.approvedCard, at: '2026-09-06T08:52:00.000Z', open: { kp: team.knowledgeProposal.id } });
    createNote7();
    say(ruby.id, { role: 'owner', text: team.handoff.message, at: '2026-09-06T08:57:00.000Z' });
    say(ruby.id, { role: 'agent', text: team.handoff.ack, at: '2026-09-06T08:57:30.000Z' });
    say(milo.id, { role: 'platform', text: team.handoff.peerMessage, at: '2026-09-06T08:59:00.000Z', fromAvatarUrl: dogFace(ruby.name) });
    say(milo.id, { role: 'agent', text: team.handoff.peerReply, at: '2026-09-06T08:59:40.000Z' });
    propose();
    merge();
    rubyPolls = 2;
    rubyAcked = true;
  }

  // ── Views ────────────────────────────────────────────────────────────────
  const isMember = (account) => membership.has(account.userId);
  const roleOf = (account) => membership.get(account.userId)?.role ?? null;
  const personOf = (userId) => (userId === owner.userId ? owner : member);

  function agentRows() {
    const rubyRow = {
      id: ruby.id, name: ruby.name, cli: ruby.cli, model: ruby.model, effort: ruby.effort,
      status: 'ready', roomId, createdAt: '2026-09-06T08:00:00.000Z',
      avatarUrl: dogFace(ruby.name),
      recap: team.ruby.recap, recapAt: '2026-09-06T08:12:00.000Z',
      lastActiveAt: chats[ruby.id].at(-1)?.at, lastReply: lastAgentReply(ruby.id),
      ...(proposal ? { doing: { kind: 'proposal', count: 1, number: team.proposal.number } } : {}),
    };
    const miloRow = {
      id: milo.id, name: milo.name, cli: milo.cli, model: milo.model, effort: milo.effort,
      status: 'ready', roomId, createdAt: milo.createdAt, avatarUrl: dogFace(milo.name),
      recap: milo.recap, recapAt: '2026-09-06T08:44:00.000Z',
      context: milo.context, lastActiveAt: chats[milo.id].at(-1)?.at, lastReply: lastAgentReply(milo.id),
    };
    return [rubyRow, miloRow];
  }
  function lastAgentReply(agentId) {
    const row = [...chats[agentId]].reverse().find((r) => r.role === 'agent');
    return row ? { text: row.text, at: row.at } : undefined;
  }
  const agentRuntime = (agent) => ({ cli: agent.cli, model: agent.model, effort: agent.effort });

  function proposalRow(account) {
    if (!proposal) return null;
    const p = team.proposal;
    return {
      id: p.id, number: p.number, repoName: p.repoName, title: p.title, body: p.body, from: p.from, to: p.to,
      diffStat: { insertions: p.diffStat.insertions, deletions: p.diffStat.deletions },
      status: proposal.status, createdAt: p.createdAt, decidedAt: proposal.decidedAt,
      agentName: ruby.name, agentId: ruby.id, agentAvatarUrl: dogFace(ruby.name), userName: owner.name,
      canDecide: account.userId === owner.userId,
      checks: { total: 1, failing: 0, pending: 0, worst: 'success' },
    };
  }
  function knowledgeProposalRow(account) {
    const kp = team.knowledgeProposal;
    return {
      id: kp.id, number: kp.number, title: kp.title, status: kpStatus, pages: [kp.page], createdAt: kp.createdAt,
      ...(kpStatus !== 'open' ? { decidedAt: '2026-09-06T08:52:00.000Z' } : {}),
      agentName: milo.name, agentId: milo.id, agentAvatarUrl: dogFace(milo.name),
      canDecide: account.userId === owner.userId,
    };
  }
  const noteHtml = (text) => text.split(/\n\n+/).map((block, index) => {
    if (block.startsWith('- ')) return `<ul>${block.split('\n').map((line) => `<li>${line.replace(/^- /, '')}</li>`).join('')}</ul>`;
    return index === 0 ? `<h2>${block}</h2>` : `<p>${block}</p>`;
  }).join('');
  function noteRow(note, account) {
    const preview = note.text.split('\n\n').slice(1).join(' ').replace(/\n/g, ' ').slice(0, 140);
    const last = note.comments.at(-1);
    return {
      id: note.id, number: note.number, title: note.title, preview, createdAt: note.createdAt, updatedAt: note.updatedAt,
      ...(account.userId === owner.userId ? { byUser: true } : { byMember: true, memberName: owner.name }),
      authorUserId: owner.userId, authorName: owner.name, authorPhotoUrl: personFace(owner.username),
      work: note.work,
      ...(note.work.agentName
        ? { agentName: note.work.agentName, agentId: note.work.agentId, agentAvatarUrl: dogFace(note.work.agentName), userName: owner.name }
        : {}),
      ...(note.comments.length
        ? {
          comments: note.comments.length,
          lastComment: {
            html: last.text, text: last.text.replace(/<[^>]+>/g, ''),
            agentName: last.agentName, agentAvatarUrl: dogFace(last.agentName),
          },
        }
        : {}),
    };
  }
  function noteRecord(note, account) {
    return {
      ...noteRow(note, account), html: noteHtml(note.text),
      ...(account.userId === owner.userId ? { text: note.text } : {}),
      attachments: [], commentRoomId: roomId, comments: note.comments,
    };
  }
  /**
   * What has arrived at the owner's own address (note #509). Two messages,
   * and they are the two shapes the screen has to get right: an ordinary
   * letter from a person, with a file; and a machine-written one whose only
   * body is HTML, which the screen shows without fetching a single picture.
   */
  const MAIL_ADDRESS = `${owner.username.split('_')[0]}@agenticcloudcomputer.com`;
  /** The agent this address wakes, if its owner has chosen one (slice 11). */
  let mailWakeAgentId = null;
  const xProfile = { x: undefined };
  /**
   * The two pictures mail slice 10 is about, as real PNG bytes: one that
   * travelled INSIDE a letter (Priya's photograph, served from our own
   * storage) and one at a sender's own address (the invoice's logo, which
   * only ever reaches the browser through our proxy). Real bytes rather than
   * a stub, because what the scenario measures is a picture actually drawn.
   */
  const MAIL_PHOTO_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAWgAAADICAIAAABK7OzYAAAEfUlEQVR42u3U5ZoVBB4H4P+d2N0LKligwhqrgoCEit16KUz3'
    + 'OXPOEFKSwwwMAwzY3Z27urZr16qfvIbf9/d53mt466/DawAi9efhNQCR+nNmDUCk/phZAxCpP2Y6ACL1/5kOgEj9fqgDICIO'
    + 'II/jt0MdAJH67WAHQKR+PdgJEKlfDnYCROqXA50Akfr5QCdARBxAHsdPBzoBIvXjdCdApH6c7gKI1A/TXQCR+mF/F0Ckvt/f'
    + 'BRCp7/Z3AUTqu6kugEh9O9UFEKlvp7oBIvW/qW6ASH2zrxsgIg4gj+Prfd0Akfp6bzdApL7a2wMQqS/39gBE6svJHoBIfTHZ'
    + 'AxARB5DH8flkD0CkPpvoAYjUZxO9AJH6dKIXIFKf7ukFiNR/9/QCROqTPb0AkfpkvBcgUh+P9wJE6uPxPoBI/We8DyBS/97d'
    + 'BxARB5DH8dHuPoBIfbSrDyBSH+7qB4jUB7v6ASL1wc5+gEi9v7MfICIOII/jvZ39AJF6d0c/QKTe3TEAEKl3dgwAROqd7QMA'
    + 'kXp7+wBApN7aPgAQqbe2DQBE6s1tAwCRenPbIECk3tg2CBCp1x8ZBIiIA8jjeO2RQYBIvbZ1ECBSr24dAojUK1uHACL1ypYh'
    + 'gEi9vGUIICIOII/jpS1DAJF6cfMQQKRe3DwMEKkXNg8DROqFTcMAkXp+0zBApJ7bNAwQqec2DgNE6tmNwwCRenbjCECkntk4'
    + 'AhCppx8eAYiIA8jjeOrhEYBIPbVhBCBST25oAETqiQ0NgEg9sb4BEKnH1zcAIuIA8jgeW98AiNSj6xoAkXp0XRMgUkfWNQEi'
    + 'dWRtEyBSh9c2ASI1s7YJEKmZsSZApA6NNQEidWhsFCBSB8dGASJ1oD0KEBEHkMcx3R4FiNR0axQgUvtbLYBITbVaAJGaGm0B'
    + 'RGrfaAsgIg4gj2PvaAsgUpPNFkCkJpttgEhNNNsAkZpotAEitafRBojUeKMNEKnxkTZApHaPtAEitXtkDCBSR826DiBSR81a'
    + 'BBCpo2cvAojU0bMXA0TqmHMXA0TEAeRxHHve9QARcQB5HMedvwQgIg4gj+P4OUsAInX8nKUAkTph7lKASJ0wdxlApE68YBlA'
    + 'RBxAHsdJF94AEBEHkMdx8kXLASJ1ysXLASLiAPI4Tr1kBUBEHEAex2nzVgBE6rR5KwEidfr8lQCROn3+KoBInXHpKoCIOIA8'
    + 'jjMvuxEgIg4gj+Osy28CiIgDyOM4e8FNAJE6e8HNAJE6Z+HNAJE6Z+FqgEj945+rASI164rVAJGadcUtAJGafeUtAJGafeWt'
    + 'AJE696pbASLiAPI4zrv6NoCIOIA8jvP/dTtARBxAHseca24HiNSca+4AiNTca+8AiNTca+8EiNQF190JEBEHkMdx4aK7ACLi'
    + 'API4Llp8N0CkLr7+boCIOIA8jkuW3AMQEQeQxzFv6T0AkZq39F6ASM1fdi9ApOYvuw8gUpfecB9ARBxAHsdly+8HiIgDyOO4'
    + 'fMUDABFxAHkcC1Y+ABCpBSsfBIjUwlUPAkRq4aqHACJ/A7rxPBsS1/JEAAAAAElFTkSuQmCC',
    'base64',
  );
  const MAIL_LOGO_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAMgAAAA8CAIAAACsOWLGAAAAn0lEQVR42u3SMQ0AIAwAwepDAoprCAYmNJB0KbnkFXwu5kip'
    + 'vLBAYAksgSWBJbAElgSWwBJYElgCS2BJYAksgSWBJbAE1lNrH/0aWAJLYIEFFlgCS2CBBRZYAktggQUWWAJLYIEFFlgCS2CB'
    + 'BRZYAktggQUWWAJLYIEFFljqDEsCS2AJLAksgSWwJLAElsCSwBJYAksCS2AJLAksgaVuXXHmtRu/8pUVAAAAAElFTkSuQmCC',
    'base64',
  );
  /** Where the invoice's logo lives, and the tracker beside it. Neither host
   *  is ever asked for anything by the browser: one goes through the proxy,
   *  and the other is refused before any request is made. */
  const MAIL_LOGO_URL = 'https://cdn.fly.io/flyio-mark.png';
  const MAIL_PIXEL_URL = 'https://track.example.com/open.gif';
  /** The senders this person loads pictures from, as the backend's table. */
  const mailImageSenders = [];
  /** The senders this person has BLOCKED (slice 13), as the backend's table. */
  const mailBlockedSenders = [];
  const mail = [
    {
      id: 'mm_studio_brief',
      from: { name: 'Priya Raman', address: 'priya@harborlight.co' },
      subject: 'The brief, and one photograph',
      snippet: 'Here is the brief we talked through on Tuesday — the photograph is the one for the header.',
      receivedAt: iso(Date.now() - 41 * 60_000),
      sentAt: iso(Date.now() - 42 * 60_000),
      // Read when it came. What is NEW in this conversation is Priya's answer
      // below, so the row is new for that and opens standing at it.
      readAt: iso(Date.now() - 40 * 60_000),
      thread: 'mm_studio_brief',
      files: 1,
      to: [{ address: MAIL_ADDRESS }],
      cc: [],
      replyTo: [],
      text: 'Hello,\n\nHere is the brief we talked through on Tuesday — the photograph is the\none for the header. Anything you want changed, say so and I will send it\nback tonight.\n\n  — Priya\n    Harborlight',
      attachments: [{ id: 'ma_brief', fileName: 'harborlight-brief.pdf', contentType: 'application/pdf', size: 184_320 }],
      rawSize: 214_518,
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    },
    // One her AGENT wrote from her address while she was away (slice 6). It
    // reads as a row of her own mail with a mark saying she did not write it —
    // the only place that fact is ever shown, since the recipient sees her.
    {
      id: 'mm_agent_sent',
      direction: 'sent',
      sentBy: 'Ruby',
      from: { address: MAIL_ADDRESS },
      to: [{ name: 'Priya Raman', address: 'priya@harborlight.co' }],
      subject: 'The crop, as promised',
      snippet: 'Attaching the header crop — Samira asked me to send it over tonight.',
      receivedAt: iso(Date.now() - 55 * 60_000),
      cc: [],
      replyTo: [],
      text: 'Attaching the header crop — Samira asked me to send it over tonight.\n',
      attachments: [],
      rawSize: 0,
    },
    {
      id: 'mm_receipt',
      from: { name: 'Fly.io', address: 'billing@fly.io' },
      subject: 'Your September invoice',
      snippet: 'Invoice 4821 · $18.40 · paid by the card ending 4242.',
      receivedAt: iso(Date.now() - 6 * 60 * 60_000),
      // Read this morning, so the list has one of each: the new letter is
      // drawn heavy above an invoice that has receded.
      readAt: iso(Date.now() - 5 * 60 * 60_000),
      files: 0,
      to: [{ address: MAIL_ADDRESS }],
      cc: [],
      replyTo: [],
      // The two kinds of picture a machine-written letter carries: the
      // sender's own mark, at their address, which is not fetched until she
      // asks — and a one-pixel tracker, which is not fetched at all.
      html: `<p><img src="${MAIL_LOGO_URL}" alt="Fly.io" width="200" height="60"></p>`
        + '<h2>Invoice 4821</h2><p>Paid by the card ending 4242.</p>'
        + '<table><tr><th>Machines</th><td>$12.40</td></tr><tr><th>Volumes</th><td>$6.00</td></tr></table>'
        + `<p><img src="${MAIL_PIXEL_URL}" width="1" height="1"></p>`,
      // And the plain-text half its sender generated from that markup, which
      // is what nearly every machine-written message actually carries: the
      // table flattened into a column of stray figures. The screen shows the
      // FORMATTED half of a message that has both, and this is why.
      text: 'Invoice 4821\n\nPaid by the card ending 4242.\n\nMachines\n$12.40\nVolumes\n$6.00\n',
      attachments: [],
      rawSize: 38_902,
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    },
    // A letter whose photograph travelled INSIDE it (slice 10): the body
    // points at the part with `cid:`, the bytes are in our own storage, and
    // the screen draws it with no tap and nothing said about pictures.
    {
      id: 'mm_crop_photo',
      from: { name: 'Priya Raman', address: 'priya@harborlight.co' },
      subject: 'The header crop, as shot',
      snippet: 'Here is the frame we chose — straight off the camera.',
      receivedAt: iso(Date.now() - 26 * 60_000),
      readAt: iso(Date.now() - 25 * 60_000),
      files: 1,
      to: [{ address: MAIL_ADDRESS }],
      cc: [],
      replyTo: [],
      html: '<p>Here is the frame we chose — straight off the camera.</p>'
        + '<p><img src="cid:harbour-dusk" alt="The harbour at dusk"></p>',
      attachments: [{
        id: 'ma_dusk', fileName: 'harbour-dusk.png', contentType: 'image/png', size: MAIL_PHOTO_PNG.length,
        contentId: 'harbour-dusk', inline: true,
      }],
      rawSize: 41_882,
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    },
    // And one from a fortnight ago, read at the time. It is here for the
    // right-hand column (note #529): mail that did not arrive today says
    // WHICH DAY it came, and a list with only this morning in it never shows
    // the difference between the two readings.
    {
      id: 'mm_lease',
      from: { name: 'Dana Okonjo', address: 'dana@merrowstreet.co.uk' },
      subject: 'The studio lease, signed',
      snippet: 'Both copies are signed and with the agent — nothing else needed from you.',
      receivedAt: iso(Date.now() - 13 * 24 * 60 * 60_000),
      readAt: iso(Date.now() - 13 * 24 * 60 * 60_000 + 60 * 60_000),
      files: 0,
      to: [{ address: MAIL_ADDRESS }],
      cc: [],
      replyTo: [],
      text: 'Both copies are signed and with the agent — nothing else needed from you.\n\n  — Dana',
      attachments: [],
      rawSize: 12_804,
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    },
    // A FORGERY (slice 13): a letter wearing an address on her own mail
    // domain that never proved itself. It landed in Spam on the way in —
    // never in the inbox — and its row there says why. Whole, and one tap
    // from the inbox if she decides it is not spam after all.
    {
      id: 'mm_forged',
      from: { name: 'Agentbuilt Billing', address: 'billing@agenticcloudcomputer.com' },
      subject: 'Your card was declined — update it today',
      snippet: 'Update your card within 24 hours to keep your agents running.',
      receivedAt: iso(Date.now() - 5 * 60 * 60_000),
      spamAt: iso(Date.now() - 5 * 60 * 60_000),
      spamWhy: 'suspicious',
      suspicious: true,
      files: 0,
      to: [{ address: MAIL_ADDRESS }],
      cc: [],
      replyTo: [{ address: 'collect@billing-agenticcloud.example' }],
      text: 'Update your card within 24 hours to keep your agents running.\n\nhttps://billing-agenticcloud.example/update\n',
      attachments: [],
      rawSize: 6_120,
      authentication: { dmarc: 'none' },
    },
    // A newsletter her AGENT put in Trash (slice 7). Kept whole and out of
    // the way: no row in the inbox, no match for an ordinary search, and in
    // Trash a mark saying which agent put it there — the one place she would
    // otherwise never learn that a letter left her inbox without her.
    {
      id: 'mm_digest',
      from: { name: 'Harborlight Weekly', address: 'weekly@harborlight.co' },
      subject: 'This week at Harborlight',
      snippet: 'Three new projects and an open studio evening on Friday.',
      receivedAt: iso(Date.now() - 3 * 24 * 60 * 60_000),
      readAt: iso(Date.now() - 3 * 24 * 60 * 60_000 + 30 * 60_000),
      trashedAt: iso(Date.now() - 2 * 24 * 60 * 60_000),
      trashedBy: 'Ruby',
      files: 0,
      to: [{ address: MAIL_ADDRESS }],
      cc: [],
      replyTo: [],
      text: 'Three new projects and an open studio evening on Friday.\n',
      attachments: [],
      rawSize: 9_210,
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    },
  ];
  /**
   * A CONVERSATION (slice 8): Priya's brief, the answer her AGENT sent from
   * her address while she was away (slice 6), and Priya's answer to THAT —
   * which before slice 8 landed as a fresh, unrelated row of the inbox. The
   * screen has to say which of the letters are hers, which of those her agent
   * wrote, and fold Priya's copy of the answer at the bottom of her own.
   */
  mail.push(
    {
      id: 'mm_reply_ruby',
      direction: 'sent',
      answers: 'mm_studio_brief',
      thread: 'mm_studio_brief',
      sentBy: 'Ruby',
      from: { address: MAIL_ADDRESS },
      to: [{ name: 'Priya Raman', address: 'priya@harborlight.co' }],
      subject: 'Re: The brief, and one photograph',
      snippet: 'Samira is away until this evening — she has the brief and will come back to you tonight.',
      receivedAt: iso(Date.now() - 38 * 60_000),
      cc: [],
      replyTo: [],
      text: 'Samira is away until this evening — she has the brief and will come back to you tonight.',
      attachments: [],
      rawSize: 0,
    },
    {
      id: 'mm_studio_back',
      thread: 'mm_studio_brief',
      from: { name: 'Priya Raman', address: 'priya@harborlight.co' },
      subject: 'Re: The brief, and one photograph',
      snippet: 'Thank you — tonight is fine. I will keep the evening clear.',
      receivedAt: iso(Date.now() - 12 * 60_000),
      files: 0,
      to: [{ address: MAIL_ADDRESS }],
      cc: [],
      replyTo: [],
      text: 'Thank you — tonight is fine. I will keep the evening clear.\n\n  — Priya\n\n'
        + `On Tue, 22 Sep 2026 at 10:04, Samira <${MAIL_ADDRESS}> wrote:\n`
        + '> Samira is away until this evening — she has the brief and will come back to\n'
        + '> you tonight.\n',
      attachments: [],
      rawSize: 4_210,
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    },
  );
  for (const message of mail) message.thread ??= message.id;
  /** A row of the list: what arrived, and what the owner started. */
  const isListRow = (message) => message.direction !== 'sent' || !message.answers;
  /**
   * A send, reply or forward as the backend reads it (mail slice 12): JSON
   * when there are only words, and the upload envelope when files go too —
   * four big-endian bytes of manifest length, the manifest, then the bytes.
   * The world keeps what a row needs of each file: its name, type and size.
   */
  const readMailUpload = (body) => {
    if (!Buffer.isBuffer(body)) return { fields: body ?? {}, files: [] };
    const length = body.readUInt32BE(0);
    const { files = [], ...fields } = JSON.parse(body.subarray(4, 4 + length).toString('utf8'));
    return { fields, files: files.map((file) => ({ fileName: file.fileName, contentType: file.contentType || 'application/octet-stream', size: file.sizeBytes })) };
  };
  const ONE_ADDRESS = /^[^\s@,]+@[^\s@,.]+(?:\.[^\s@,.]+)+$/;
  /** The Cc line as the backend reads it: filled boxes, one address each, three at most. */
  const readCc = (value) => {
    const boxes = (Array.isArray(value) ? value : []).map((box) => String(box ?? '').trim()).filter(Boolean);
    if (boxes.length > 3) return { refused: 'A message reaches four people at most: one To and up to 3 Cc.' };
    const bad = boxes.find((box) => !ONE_ADDRESS.test(box));
    return bad ? { refused: `${bad} is not one email address. Put one address in each Cc box.` } : { cc: boxes.map((address) => ({ address })) };
  };
  let mailFiles = 0;
  const keptFiles = (files) => files.map((file) => ({ id: `ma_out_${mailFiles += 1}`, ...file }));
  /** The approvals an agent's `mail send/reply/forward` raised, by id. */
  const mailApprovals = new Map();
  const mailSummary = (message) => ({
    id: message.id, from: message.from, subject: message.subject, snippet: message.snippet,
    receivedAt: message.receivedAt, ...(message.sentAt ? { sentAt: message.sentAt } : {}),
    files: message.attachments.length,
    ...(message.direction === 'sent' ? { direction: 'sent', to: message.to } : {}),
    ...(message.sentBy ? { sentBy: message.sentBy } : {}),
    ...(message.direction !== 'sent' && !message.readAt ? { unread: true } : {}),
    ...(message.suspicious ? { suspicious: true } : {}),
    ...(mailPlace(message) !== 'inbox' ? { place: mailPlace(message) } : {}),
    ...(message.trashedAt ? (message.trashedBy ? { movedBy: message.trashedBy } : {})
      : message.spamAt ? (message.spamBy ? { movedBy: message.spamBy } : {})
        : message.archivedBy ? { movedBy: message.archivedBy } : {}),
    ...(mailPlace(message) === 'spam' && message.spamWhy ? { spamWhy: message.spamWhy } : {}),
    ...(message.forwards ? { forwards: message.forwards } : {}),
    // Stars (note #666), and whose, when an agent put one on.
    ...(message.starredAt ? { starred: true } : {}),
    ...(message.starredAt && message.starredBy ? { starredBy: message.starredBy } : {}),
  });
  const mailRow = (id) => mail.find((row) => row.id === id);
  /**
   * The world's stand-in for the backend's conversations, decided the way it
   * decides them: in the inbox while any letter of it is, else in the archive
   * while any is, else in Trash — named by who it is with, called by its
   * first subject, and showing its newest letter.
   */
  const conversationOf = (id) => {
    const found = mailRow(id);
    return found ? mail.filter((row) => row.thread === found.thread).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)) : [];
  };
  const conversationPlace = (letters) => {
    const places = letters.filter(isListRow).map(mailPlace);
    return places.includes('inbox') ? 'inbox' : places.includes('archive') ? 'archive' : places.includes('spam') ? 'spam' : 'trash';
  };
  const conversationSummary = (letters) => {
    const latest = letters[letters.length - 1];
    const people = new Map();
    for (const letter of letters) {
      // A forward's recipient was handed one letter; they are not IN it.
      if (letter.forwards) continue;
      for (const party of letter.direction === 'sent' ? [...letter.to, ...(letter.cc ?? [])] : [letter.from]) {
        if (party && party.address !== MAIL_ADDRESS && !people.has(party.address)) people.set(party.address, party);
      }
    }
    const place = conversationPlace(letters);
    const inPlace = letters.filter((letter) => isListRow(letter) && mailPlace(letter) === place);
    const mover = inPlace.length ? mailSummary(inPlace[inPlace.length - 1]).movedBy : undefined;
    const spamWhy = place === 'spam' && inPlace.length ? mailSummary(inPlace[inPlace.length - 1]).spamWhy : undefined;
    const unopened = letters.find((letter) => letter.direction !== 'sent' && !letter.readAt);
    const trashed = place === 'trash' ? 0 : letters.filter((letter) => isListRow(letter) && mailPlace(letter) === 'trash').length;
    return {
      id: letters[0].thread,
      with: [...people.values()],
      ...(letters.every((letter) => letter.direction === 'sent') ? { started: true } : {}),
      subject: letters.find((letter) => letter.subject.trim())?.subject ?? '',
      latest: {
        id: latest.id, snippet: latest.snippet, receivedAt: latest.receivedAt,
        ...(latest.direction === 'sent' ? { direction: 'sent' } : {}),
        ...(latest.sentBy ? { sentBy: latest.sentBy } : {}),
      },
      count: letters.length,
      opens: unopened?.id ?? latest.id,
      ...(unopened ? { unread: true } : {}),
      files: letters.reduce((sum, letter) => sum + letter.attachments.length, 0),
      ...(letters.some((letter) => letter.suspicious) ? { suspicious: true } : {}),
      ...(place !== 'inbox' ? { place } : {}),
      ...(mover ? { movedBy: mover } : {}),
      ...(spamWhy ? { spamWhy } : {}),
      ...(trashed ? { trashed } : {}),
      // Starred while any letter in it is, outside Trash and Spam (note #666).
      ...(letters.some((letter) => letter.starredAt && !letter.trashedAt && !letter.spamAt) ? { starred: true } : {}),
    };
  };
  /** One letter as the conversation screen reads it: a sent one as what the
   *  owner wrote, the quote under it having gone to the recipient. */
  const threadLetter = (message) => ({
    ...mailSummary(message), to: message.to, cc: message.cc, replyTo: message.replyTo,
    ...(message.text ? { text: message.text } : {}), ...(message.html ? { html: message.html } : {}),
    attachments: message.attachments, ...(message.authentication ? { authentication: message.authentication } : {}),
    // Whether this reader loads pictures from this sender is the SERVER's
    // answer (slice 10), exactly as where the letter is kept is.
    ...(message.direction !== 'sent' && message.from && mailImageSenders.includes(message.from.address.toLowerCase())
      ? { imagesAllowed: true } : {}),
    // And whether this reader has blocked the sender (slice 13).
    ...(message.direction !== 'sent' && message.from && mailBlockedSenders.includes(message.from.address.toLowerCase())
      ? { senderBlocked: true } : {}),
    rawSize: message.rawSize,
  });
  /** A move, the way the backend makes one: stamps on a list row, guarded. */
  const moveLetter = (message, move) => {
    const at = iso(Date.now());
    if (move === 'archive' && !message.archivedAt && !message.spamAt && !message.trashedAt) { message.archivedAt = at; delete message.archivedBy; }
    if (move === 'unarchive' && !message.spamAt && !message.trashedAt) { delete message.archivedAt; delete message.archivedBy; }
    // Spam and Not spam (slice 13), stamped as the backend stamps them.
    if (move === 'spam' && !message.spamAt && !message.trashedAt) { message.spamAt = at; message.spamWhy = 'marked'; delete message.spamBy; delete message.notSpam; }
    if (move === 'unspam' && !message.trashedAt) { delete message.spamAt; delete message.spamWhy; delete message.spamBy; message.notSpam = true; }
    if (move === 'trash' && !message.trashedAt) { message.trashedAt = at; delete message.trashedBy; }
    if (move === 'restore') { delete message.trashedAt; delete message.trashedBy; }
  };
  /** Where a letter is kept (slices 7 and 13), decided as the backend decides
   *  it: Trash wins over Spam wins over the archive, and Restore leaves an
   *  archived one archived. */
  const mailPlace = (message) => (message.trashedAt ? 'trash' : message.spamAt ? 'spam' : message.archivedAt ? 'archive' : 'inbox');
  const inMailView = (message, view) => (view === 'sent' ? mailPlace(message) !== 'trash'
    : view === 'all' ? mailPlace(message) !== 'trash' && mailPlace(message) !== 'spam'
      // Starred (note #666): a starred letter wherever it is kept, Trash and Spam apart.
      : view === 'starred' ? Boolean(message.starredAt) && mailPlace(message) !== 'trash' && mailPlace(message) !== 'spam'
        : mailPlace(message) === view);
  /**
   * One page of a list, as the backend pages it (note #666): `limit` rows at
   * most, newest first, and a cursor for the next when there is one. The
   * world's cursor is how many rows came before — the backend's is a row's
   * sequence number — and the screen treats both as the opaque word it is.
   */
  const pageOf = (rows, url) => {
    const limit = Math.max(1, Math.min(Number.parseInt(url.searchParams.get('limit') ?? '', 10) || 50, 200));
    const from = Math.max(0, Number.parseInt(url.searchParams.get('before') ?? '', 10) || 0);
    const page = rows.slice(from, from + limit);
    return { page, ...(from + limit < rows.length ? { nextBefore: String(from + limit) } : {}) };
  };
  /**
   * The world's stand-in for the backend's search index: every typed word
   * must begin a word the letter is found by — who it was with, its subject,
   * its body — ignoring case and accents, the way `unicode61 remove_diacritics`
   * reads them. Not the index; the same answers for the letters in this world.
   */
  const mailWords = (value) => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const mailMatches = (message, words) => {
    const people = message.direction === 'sent' ? message.to : [message.from];
    const found = mailWords([
      ...people.flatMap((party) => [party?.name, party?.address]),
      message.subject, message.text ?? String(message.html ?? '').replace(/<[^>]*>/g, ' '),
    ].join(' '));
    return mailWords(words).every((word) => found.some((one) => one.startsWith(word)));
  };

  function seatUsage(journey) {
    const codex = journey.seat;
    const claude = team.seats.claude;
    return [
      ...(codex ? [{ seatId: codex.seatId, provider: codex.provider, label: codex.label, planText: codex.planText, status: 'active', selected: true, windows: [seatStripWindow(CODEX_WINDOW)] }] : []),
      { seatId: claude.seatId, provider: claude.provider, label: claude.label, planText: claude.planText, status: 'active', selected: true, windows: claude.windows.map(seatStripWindow) },
    ];
  }
  function orgSummary(account, journey) {
    return {
      orgId: fixture.organization.id, name: fixture.organization.name, role: roleOf(account),
      members: membership.size, seats: 2, seatProviders: ['codex', 'claude'], paymentRequiredSeatProviders: [],
      seatUsage: seatUsage(journey),
      avatarUrl: ORG_MARK,
    };
  }
  function state(account, journey) {
    const user = {
      name: account.displayName,
      profile: { firstName: account.firstName ?? account.displayName, lastName: account.lastName ?? '', incomplete: false, photoUrl: personFace(account.username) },
      account: {
        browserLogin: { enabled: true, username: account.username },
        // In the lived-in world everybody already has their own address.
        mailbox: { address: `${account.username.split('_')[0]}@agenticcloudcomputer.com` },
      },
    };
    const spare = account.userId === member.userId && spareOrg
      ? { orgId: spareOrg.orgId, name: spareOrg.name, role: 'admin', active: false, members: 1, agents: spareOrg.founded ? 1 : 0 }
      : null;
    if (!isMember(account)) {
      // Before approval the joiner is in no workplace (made through the
      // link, note #949), or in his own (`invite-known`). While a request of
      // his is pending the state says so, as the real backend does for a
      // person in no workplace or only an unnamed one.
      const waiting = joinRequests.find((row) => row.userId === account.userId && row.status === 'pending');
      return {
        ...(waiting && (!spareOrg || spareOrg.unnamed) ? { joining: { requestId: waiting.requestId, inviteToken: team.invite.token, orgName: fixture.organization.name } } : {}),
        org: spareOrg, organizations: spare ? [{ ...spare, active: true }] : [], canCreateOrg: true, rooms: [], user, agents: [], prs: [], knowledgeProposals: [],
        secrets: null, repos: null, sites: null, knowledge: null, notes: null, notesArchived: 0, noteFiles: false,
      };
    }
    const org = orgSummary(account, journey);
    const pr = proposalRow(account);
    return {
      org,
      organizations: [
        { orgId: org.orgId, name: org.name, role: org.role, active: true, members: membership.size, agents: 2, avatarUrl: ORG_MARK },
        ...(spare ? [spare] : []),
      ],
      canCreateOrg: true,
      rooms: team.rooms,
      room: roomId,
      user,
      agents: agentRows(),
      prs: pr ? [pr] : [],
      knowledgeProposals: kpStatus === 'open' ? [knowledgeProposalRow(account)] : [],
      secrets: team.secrets,
      repos: [{
        name: team.repo.name, cloneUrl: team.repo.cloneUrl, sizeBytes: team.repo.sizeBytes,
        contributors: [{ name: ruby.name, agentAvatarUrl: dogFace(ruby.name), commits: 4 }, { name: milo.name, agentAvatarUrl: dogFace(milo.name), commits: 1 }],
        protectedBranch: team.repo.protectedBranch, createdAt: team.repo.createdAt,
        lastPushAt: team.repo.lastPushAt, branch: 'main', branchPushAt: proposal?.decidedAt ?? team.repo.lastPushAt,
      }],
      sites: site ? [site] : [],
      knowledge: knowledgePages.map(({ html: _html, ...row }) => row),
      notes: notes.map((note) => noteRow(note, account)),
      driveAvailable: true,
      notesArchived: 0,
      noteFiles: true,
      quota: { repoMaxBytes: 1_000_000_000, userMaxBytes: 5_000_000_000, userUsedBytes: team.repo.sizeBytes },
    };
  }
  function people(account) {
    return [...membership].map(([userId, row]) => {
      const person = personOf(userId);
      return {
        userId, name: person.name, photoUrl: personFace(person.username),
        you: userId === account.userId, role: row.role, joinedAt: row.joinedAt,
        agents: userId === owner.userId ? 2 : 0,
        ...(row.invitedByName ? { invitedByName: row.invitedByName } : {}),
        ...(row.here ? { here: true, lastSeenAt: iso(Date.now()) } : { lastSeenAt: row.joinedAt }),
        // A recap always arrives with the hour it was written on (the server
        // stores `recap { text, at }` and sends both), and the row draws that
        // as an "ago" under the line — note #385.
        ...(userId === owner.userId
          ? { recap: 'Approving what Ruby and Milo bring back.', recapAt: iso(Date.now() - 12 * 60_000) }
          : {}),
      };
    });
  }
  const pendingRequests = () => joinRequests.filter((request) => request.status === 'pending');
  function orgDetail(account) {
    const admin = roleOf(account) === 'admin';
    return {
      orgId: fixture.organization.id, name: fixture.organization.name, role: roleOf(account), avatarUrl: ORG_MARK,
      members: people(account),
      invites: admin ? invites : null,
      joinRequests: admin ? pendingRequests().map(({ status: _status, ...row }) => row) : null,
      canDelete: false,
      fly: { connected: true, orgSlug: fixture.cloud.orgSlug, peer: 'up' },
      platformBackup: { workspace: { at: '2026-09-06T03:00:00.000Z', ok: true } },
    };
  }
  function versionAnswer(agent) {
    const extra = agent === ruby ? team.ruby.version : milo.version;
    return {
      cliLabel: agent.cli === 'codex' ? 'Codex' : 'Claude Code', installed: extra.installed, cliUpdateAvailable: false,
      image: { current: true, canUpdate: false }, busy: false,
      machine: { awake: true, region: 'ams', regionName: 'Amsterdam', memoryMb: 2048, cpuKind: 'shared', cpus: 2 },
      model: agent.model, effort: agent.effort, lastActiveAt: chats[agent.id].at(-1)?.at, turnCount: extra.turnCount,
      ...(agent === ruby && site ? { siteUrl: site.url } : {}),
      docs: { file: 'AGENTS.md', version: 12, latest: 12, current: true },
    };
  }
  function proposalDetail(account) {
    const p = team.proposal;
    return {
      pr: {
        ...proposalRow(account), checks: undefined,
        commitSubjects: p.commits.map((c) => c.subject), decisionNote: null, agentRuntime: agentRuntime(ruby),
        quickNoteNumbers: [team.newNote.number], quickNotes: [{ number: team.newNote.number, title: team.newNote.title }],
        attachments: [], commentRoomId: roomId, comments: [],
      },
      checks: p.checks, patch: p.patch, patchTruncated: false, commits: p.commits, diffStat: p.diffStat,
      headSha: p.headSha, requireChecks: true,
      ...(proposal.delivery ? { delivery: proposal.delivery } : {}),
    };
  }
  function knowledgeProposalDetail(account) {
    const kp = team.knowledgeProposal;
    return {
      proposal: { ...knowledgeProposalRow(account), userName: owner.name, note: kp.note, summary: kp.summary, agentRuntime: agentRuntime(milo), commentRoomId: roomId, comments: [] },
      changes: [{ page: kp.page, action: 'create', title: kp.title, description: kp.description, html: kp.html }],
    };
  }
  const driveItem = (row, kind) => ({ kind, sizeBytes: 0, contentType: kind === 'folder' ? 'inode/directory' : row.contentType, ...row });
  function driveListing(parent) {
    const folders = team.drive.folders.filter((f) => (f.parentId ?? '') === parent).map((f) => driveItem(f, 'folder'));
    const files = team.drive.files.filter((f) => (f.parentId ?? '') === parent).map((f) => driveItem(f, 'file'));
    const folder = team.drive.folders.find((f) => f.id === parent);
    return {
      items: [...folders, ...files], folder: folder ? driveItem(folder, 'folder') : null,
      breadcrumbs: folder ? [driveItem(folder, 'folder')] : [],
      totalBytes: team.drive.files.reduce((sum, f) => sum + f.sizeBytes, 0), trashCount: 0, canDeleteForever: true, maxFileBytes: 1024 * 1024 * 1024,
    };
  }
  const agentById = (id) => (id === ruby.id ? ruby : id === milo.id ? milo : null);

  // ── The requests the world answers ───────────────────────────────────────
  function handle({ req, url, body, account, respondJson, respondBytes, expectCsrf, expectJson, fault }) {
    const { pathname } = url;
    const method = req.method;
    const orgId = fixture.organization.id;
    const orgName = fixture.organization.name;

    // Unauthenticated: what a visitor may learn about an invite link.
    if (method === 'GET' && pathname.startsWith('/workspace/auth/invite/')) {
      const token = decodeURIComponent(pathname.split('/').pop());
      const invite = invites.find((row) => row.token === token);
      if (!invite) respondJson(404, { error: 'This invite link is no longer active.' });
      else respondJson(200, { status: 'available' });
      return true;
    }
    /**
     * THE WORLD'S OWN LETTERBOX — a scenario making a message arrive while a
     * screen is open. The real backend has no such route: mail arrives there
     * through the inbound Email Worker, which a browser cannot stand in for.
     * It is here so the INBOX POLL can be proved the only way that counts —
     * a letter landing on a list somebody is already looking at.
     */
    if (method === 'POST' && pathname === '/workspace/api/mail/deliver') {
      // `answers` names a letter of this world the arrival answers, the way
      // In-Reply-To names one in real mail: it lands in that conversation.
      const answered = typeof body?.answers === 'string' ? mailRow(body.answers) : null;
      const arrival = {
        id: `mm_late_${mail.length + 1}`,
        thread: answered?.thread,
        from: body?.from ?? { name: 'Priya Raman', address: 'priya@harborlight.co' },
        subject: String(body?.subject ?? 'One more thing'),
        snippet: String(body?.snippet ?? 'One more thing before Thursday.'),
        // A scenario may date one in the past (note #666 fills a page with them).
        receivedAt: typeof body?.receivedAt === 'string' ? body.receivedAt : iso(Date.now()),
        to: [{ address: MAIL_ADDRESS }],
        cc: Array.isArray(body?.cc) ? body.cc : [],
        replyTo: [],
        text: typeof body?.text === 'string' ? body.text : `${body?.snippet ?? 'One more thing before Thursday.'}\n`,
        // A caller may hand this one a formatted half too — which is how the
        // scenario delivers the awkward shape a fixture cannot sit on all
        // run: markup the allowlist refuses down to nothing (note #534).
        ...(typeof body?.html === 'string' ? { html: body.html } : {}),
        attachments: [],
        rawSize: 1024,
      };
      arrival.thread ??= arrival.id;
      mail.unshift(arrival);
      respondJson(201, { message: mailSummary(arrival) });
      return true;
    }
    /**
     * THE WORLD'S OWN AGENT ASKING TO SEND (mail slice 12) — what `agentbuilt
     * mail send --attach …` does on a machine: record the request and put the
     * card in that agent's chat. The real route is the agent CLI's, which a
     * browser cannot stand in for; the card it places is what is pictured.
     */
    if (method === 'POST' && pathname === '/workspace/api/mail/approvals') {
      const approval = {
        id: `ma_sim_${mailApprovals.size + 1}`,
        status: 'pending',
        createdAt: iso(Date.now()),
        from: { address: MAIL_ADDRESS },
        ...body,
      };
      mailApprovals.set(approval.id, approval);
      const agentId = typeof body?.agentId === 'string' ? body.agentId : ruby.id;
      delete approval.agentId;
      say(agentId, {
        role: 'platform', at: approval.createdAt, mailApprovalId: approval.id, mailApproval: approval,
        text: `${approval.requestedBy} wants to send email to ${approval.to.address}. Nothing will be sent until you approve it here.`,
      });
      respondJson(201, { approval });
      return true;
    }
    if (!account) return false;
    const admin = roleOf(account) === 'admin';

    if (method === 'GET' && pathname === '/workspace/api/recap') {
      // The plate wears the Workspace Agent's reserved face, as production hands it out (note #434).
      const agent = { name: 'Workspace Agent', started: true, working: false, waiting: [], avatarUrl: '/workspace/avatars/workspace-agent' };
      // A briefing this reader already asked for (note #607: the card draws
      // it with its age and a Refresh button; nothing here writes a new one).
      // One room's briefing (note #688): the room asked about, else the one
      // the state stands in; the card takes no answer for another room.
      respondJson(200, { orgId, roomId: url.searchParams.get('room') ?? roomId, agent, summary: { text: team.recap.text, at: team.recap.at, fingerprint: 'fp1' }, updating: false, stale: false, sources: team.recap.sources, since: '2026-08-30T00:00:00.000Z', checkedAt: iso(Date.now()), incomplete: false });
      return true;
    }
    // The Workspace Agent's own conversation, which Home IS since 2026-10-10
    // and reads on every visit. Nobody in this world has written to it yet,
    // so the shell draws its empty card; the face is the reserved one.
    if (method === 'GET' && pathname === '/workspace/api/recap/chat') {
      respondJson(200, { orgId, messages: [], working: false, waiting: [], avatarUrl: '/workspace/avatars/workspace-agent' });
      return true;
    }
    // Its details, read by its cards at the foot of Home's Workplace window
    // (note #715). Nobody has written to it, so no machine was ever
    // built for it (note #656) and no model was picked: an agent not started.
    if (method === 'GET' && pathname === '/workspace/api/recap/agent') {
      respondJson(200, {
        orgId,
        agent: { name: 'Workspace Agent', started: false, working: false, waiting: [], avatarUrl: '/workspace/avatars/workspace-agent' },
        settings: null,
      });
      return true;
    }
    if (method === 'GET' && pathname === '/workspace/api/notifications') {
      respondJson(200, { notifications, unread: notifications.filter((n) => !n.readAt).length, push: { available: false, subscriptions: 0 } });
      return true;
    }
    if (method === 'POST' && pathname === '/workspace/api/notifications/read') {
      expectCsrf(req, 'notification read');
      let marked = 0;
      for (const n of notifications) {
        if (!n.readAt && (body?.all || body?.notificationIds?.includes(n.notificationId))) { n.readAt = iso(Date.now()); marked += 1; }
      }
      respondJson(200, { marked });
      return true;
    }

    // ── Joining ──
    if (method === 'POST' && pathname === '/workspace/api/org/invites') {
      expectCsrf(req, 'invite link creation');
      if (!admin) { respondJson(403, { error: 'Only an admin can create invite links.' }); return true; }
      // One link per workplace, as the route does: asking again hands back
      // the one that exists rather than minting beside it.
      // The link names the public address the real backend would (the site
      // fronts /workspace); a scenario opens the same path on the fixture.
      const invite = invites[0]
        ?? { token: team.invite.token, link: `${team.invite.webOrigin}/invite/${team.invite.token}`, createdAt: iso(Date.now()) };
      if (!invites[0]) invites.push(invite);
      respondJson(201, { ok: true, invite });
      return true;
    }
    if (method === 'DELETE' && pathname.startsWith('/workspace/api/org/invites/')) {
      expectCsrf(req, 'invite link revoke');
      const token = decodeURIComponent(pathname.split('/')[5]);
      const index = invites.findIndex((row) => row.token === token);
      if (index >= 0) invites.splice(index, 1);
      respondJson(200, { ok: true });
      return true;
    }
    const inviteMatch = pathname.match(/^\/workspace\/api\/org\/invites\/([^/]+)(\/redeem)?$/);
    if (inviteMatch) {
      const token = decodeURIComponent(inviteMatch[1]);
      const invite = invites.find((row) => row.token === token);
      const mine = joinRequests.find((row) => row.userId === account.userId);
      if (method === 'GET') {
        if (isMember(account)) respondJson(200, { orgId, name: orgName, status: 'member' });
        else if (mine) respondJson(200, { orgId, name: orgName, status: mine.status === 'rejected' ? 'rejected' : 'pending', requestId: mine.requestId });
        else if (invite) respondJson(200, { orgId, name: orgName, status: 'available' });
        else respondJson(404, { error: 'This invite link is no longer active.', reason: 'unknown' });
        return true;
      }
      if (method === 'POST' && inviteMatch[2]) {
        expectCsrf(req, 'join request');
        if (!invite) { respondJson(404, { error: 'This invite link is no longer active.', reason: 'unknown' }); return true; }
        if (isMember(account)) { respondJson(200, { ok: true, orgId, name: orgName, status: 'member', alreadyMember: true }); return true; }
        if (mine && mine.status === 'pending') fault('a second join request was sent while the first was pending');
        const request = { requestId: `req_${account.username}`, userId: account.userId, name: account.displayName, username: account.username, requestedAt: iso(Date.now()), status: 'pending' };
        joinRequests.push(request);
        respondJson(201, { ok: true, orgId, name: orgName, status: 'pending', requestId: request.requestId });
        return true;
      }
    }
    if (method === 'GET' && pathname === '/workspace/api/org/join-requests') {
      if (!admin) { respondJson(403, { error: 'Only an admin can see join requests.' }); return true; }
      respondJson(200, { joinRequests: pendingRequests().map(({ status: _status, ...row }) => row) });
      return true;
    }
    const requestMatch = pathname.match(/^\/workspace\/api\/org\/join-requests\/([^/]+)(\/decision)?$/);
    if (requestMatch) {
      const request = joinRequests.find((row) => row.requestId === decodeURIComponent(requestMatch[1]));
      if (!request) { respondJson(404, { error: 'No such request.' }); return true; }
      if (method === 'GET') {
        respondJson(200, { orgId, name: orgName, requestId: request.requestId, status: request.status === 'approved' ? 'member' : request.status });
        return true;
      }
      if (method === 'POST' && requestMatch[2]) {
        expectCsrf(req, 'join decision');
        if (!admin) { respondJson(403, { error: 'Only an admin decides.' }); return true; }
        if (request.status !== 'pending') fault('a join request was decided twice');
        if (body?.decision === 'approve') {
          request.status = 'approved';
          membership.set(request.userId, { role: 'member', joinedAt: iso(Date.now()), invitedByName: account.displayName });
          respondJson(200, { ok: true, status: 'member' });
        } else if (body?.decision === 'reject') {
          request.status = 'rejected';
          respondJson(200, { ok: true, status: 'rejected' });
        } else fault(`join decision sent ${JSON.stringify(body)}`);
        return true;
      }
    }
    if (method === 'POST' && pathname === '/workspace/api/org/active') {
      expectCsrf(req, 'workplace switch');
      expectJson(body, { orgId }, 'workplace switch');
      if (!isMember(account)) { respondJson(403, { error: 'Not a member.' }); return true; }
      respondJson(200, { ok: true, orgId, name: orgName });
      return true;
    }
    if (method === 'GET' && pathname === '/workspace/api/org') {
      if (!isMember(account)) { respondJson(404, { error: 'No workplace.' }); return true; }
      respondJson(200, { org: orgDetail(account) });
      return true;
    }
    // A member's contribution here (note #925): the lived-in team's ledgers
    // are not part of this world, so every member's reads as zeros.
    if (method === 'GET' && /^\/workspace\/api\/org\/members\/[^/]+\/contribution$/.test(pathname)) {
      if (!isMember(account)) { respondJson(403, { error: 'Not a member.' }); return true; }
      respondJson(200, {
        weekStart: '2026-10-26', tokensFrom: '2026-10-10',
        week: { workingMs: 0, merged: 0, tokens: {} }, allTime: { workingMs: 0, merged: 0, tokens: {} }, merged: [],
      });
      return true;
    }
    if (method === 'GET' && (pathname === '/workspace/api/org/people' || pathname === '/workspace/api/org/people/live')) {
      if (!isMember(account)) { respondJson(403, { error: 'Not a member.' }); return true; }
      const rows = people(account);
      respondJson(200, pathname.endsWith('/live')
        ? { people: rows.map(({ userId, lastSeenAt, here, recap, recapAt }) => ({ userId, lastSeenAt, ...(here ? { here } : {}), ...(recap ? { recap, recapAt } : {}) })) }
        : { org: { orgId, name: orgName, role: roleOf(account), avatarUrl: ORG_MARK }, people: rows });
      return true;
    }
    if (!isMember(account)) return false;

    // ── Notes ──
    if (method === 'POST' && pathname === '/workspace/api/notes') {
      expectCsrf(req, 'note write');
      expectJson(body, { text: team.newNote.text }, 'note write');
      if (notes.some((row) => row.number === team.newNote.number)) fault('note #7 was written twice');
      const note = createNote7();
      respondJson(201, { ok: true, note: noteRow(note, account), title: note.title });
      return true;
    }
    const noteMatch = pathname.match(/^\/workspace\/api\/notes\/(\d+)(\/handoff)?$/);
    if (noteMatch) {
      const note = notes.find((row) => row.number === Number(noteMatch[1]));
      if (!note) { respondJson(404, { error: 'No such note.' }); return true; }
      if (method === 'GET' && !noteMatch[2]) { respondJson(200, { note: noteRecord(note, account) }); return true; }
      if (method === 'POST' && noteMatch[2]) {
        expectCsrf(req, 'note handoff');
        expectJson(body, { agentId: ruby.id, message: team.handoff.message }, 'note handoff');
        if (note.number !== team.newNote.number) fault(`note #${note.number} was handed off; only #7 is expected`);
        if (rubyPolls !== null) fault('note #7 was handed to Ruby twice');
        note.work = { state: 'working', agentName: ruby.name, agentId: ruby.id, expiresAt: iso(Date.now() + 2 * 3600_000) };
        note.updatedAt = iso(Date.now());
        say(ruby.id, { role: 'owner', text: team.handoff.message, at: iso(Date.now()) });
        // Ruby asks Milo at once; Milo answers in his own chat. Both are
        // visible the moment the reader opens Milo's conversation.
        say(milo.id, { role: 'platform', text: team.handoff.peerMessage, at: iso(Date.now()), fromAvatarUrl: dogFace(ruby.name) });
        say(milo.id, { role: 'agent', text: team.handoff.peerReply, at: iso(Date.now()) });
        rubyPolls = 0;
        respondJson(202, { ok: true, name: ruby.name, work: note.work });
        return true;
      }
    }

    // ── Agents: chats, details, proposals ──
    const agentMatch = pathname.match(/^\/workspace\/api\/agents\/([^/]+)\/(chat|chat\/latest|version|prs|message|schedule)$/);
    if (agentMatch) {
      const agent = agentById(decodeURIComponent(agentMatch[1]));
      if (!agent) { respondJson(404, { error: 'No such agent.' }); return true; }
      const which = agentMatch[2];
      if (which === 'chat' && method === 'GET') {
        if (agent === ruby && rubyPolls !== null && !proposal) {
          // The reads are Ruby's clock: the first poll finds her reply, the
          // second finds the proposal card — the work on her machine
          // happening out of the browser's sight.
          rubyPolls += 1;
          if (rubyPolls >= 1 && !rubyAcked) { rubyAcked = true; say(ruby.id, { role: 'agent', text: team.handoff.ack, at: iso(Date.now()) }); }
          if (rubyPolls >= 2) propose();
        }
        const after = Number(url.searchParams.get('after') || 0);
        const working = agent === ruby && rubyPolls !== null && !proposal;
        respondJson(200, { messages: chats[agent.id].filter((row) => row.seq > after), working, ...(working ? { activity: 'Building the section on a branch' } : {}), ...(agent.context ? { context: agent.context } : {}) });
        return true;
      }
      if (which === 'chat' && method === 'POST') fault(`a message was sent to ${agent.name} during the team journey: ${JSON.stringify(body)}`);
      if (which === 'chat/latest' && method === 'GET') { respondJson(200, { message: lastAgentReply(agent.id) ?? null }); return true; }
      if (which === 'version' && method === 'GET') { respondJson(200, versionAnswer(agent)); return true; }
      if (which === 'schedule' && method === 'GET') { respondJson(200, { schedule: null }); return true; }
      if (which === 'prs' && method === 'GET') {
        const pr = proposalRow(account);
        respondJson(200, { prs: agent === ruby && pr ? [pr] : [], knowledgeProposals: agent === milo ? [knowledgeProposalRow(account)] : [] });
        return true;
      }
    }

    // ── Decisions ──
    const prMatch = pathname.match(/^\/workspace\/api\/prs\/([^/]+)(\/decision|\/delivery)?$/);
    if (prMatch) {
      if (!proposal || decodeURIComponent(prMatch[1]) !== team.proposal.id) { respondJson(404, { error: 'No such proposal.' }); return true; }
      if (method === 'GET' && !prMatch[2]) { respondJson(200, proposalDetail(account)); return true; }
      if (method === 'GET' && prMatch[2] === '/delivery') { respondJson(200, { status: proposal.status, decidedAt: proposal.decidedAt, delivery: proposal.delivery }); return true; }
      if (method === 'POST' && prMatch[2] === '/decision') {
        expectCsrf(req, 'proposal decision');
        if (account.userId !== owner.userId) { respondJson(403, { error: 'Only the owner of the agent that proposed this change can approve or reject it.' }); return true; }
        expectJson(body, { decision: 'approve', headSha: team.proposal.headSha }, 'proposal decision');
        if (proposal.status !== 'open') fault('PR #1 was decided twice');
        merge();
        respondJson(200, { ok: true, status: 'merged' });
        return true;
      }
    }
    const kpMatch = pathname.match(/^\/workspace\/api\/knowledge\/proposals\/([^/]+)(\/decision)?$/);
    if (kpMatch) {
      if (decodeURIComponent(kpMatch[1]) !== team.knowledgeProposal.id) { respondJson(404, { error: 'No such proposal.' }); return true; }
      if (method === 'GET') { respondJson(200, knowledgeProposalDetail(account)); return true; }
      if (method === 'POST' && kpMatch[2]) {
        expectCsrf(req, 'knowledge decision');
        expectJson(body, { decision: 'approve' }, 'knowledge decision');
        if (kpStatus !== 'open') fault('knowledge proposal #2 was decided twice');
        kpStatus = 'approved';
        publishKnowledgePage();
        say(milo.id, { role: 'platform', text: team.knowledgeProposal.approvedCard, at: iso(Date.now()), open: { kp: team.knowledgeProposal.id } });
        respondJson(200, { ok: true, status: 'approved' });
        return true;
      }
    }
    const pageMatch = pathname.match(/^\/workspace\/api\/knowledge\/pages\/([^/]+)$/);
    if (pageMatch && method === 'GET') {
      const page = knowledgePages.find((row) => row.name === decodeURIComponent(pageMatch[1]));
      if (!page) { respondJson(404, { error: 'No such page.' }); return true; }
      respondJson(200, { page: { name: page.name, html: page.html, title: page.title, description: page.description, commentRoomId: roomId, comments: [] } });
      return true;
    }

    // ── Read-only screens of the tour ──
    if (method === 'GET' && pathname === '/workspace/api/org/seats') {
      // The seat's own screen says when the reading was taken; the server
      // probes the provider only when its cache is stale, so this is minutes
      // old rather than live, and the screen says so out loud.
      const checkedAt = iso(Date.now() - 4 * 60_000);
      const codex = { seatId: 'seat_fixture_codex', provider: 'codex', label: fixture.signin.seatLabel, planText: 'Plus', status: 'active', selected: true, createdAt: '2026-09-06T08:03:00.000Z', usageRefreshedAt: checkedAt, windows: [seatWindow(CODEX_WINDOW)] };
      const claude = { ...team.seats.claude, usageRefreshedAt: checkedAt, windows: team.seats.claude.windows.map((window) => seatWindow(window)) };
      respondJson(200, { seats: [codex, claude], available: [] });
      return true;
    }
    if (method === 'GET' && pathname === '/workspace/api/org/tokens') {
      // What this person's own agents spent, under the subscriptions it was
      // spent on: this week and the one before, the two providers apart.
      const monday = (weeksBack) => {
        const at = new Date();
        at.setUTCHours(0, 0, 0, 0);
        at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7) - 7 * weeksBack);
        return at.toISOString().slice(0, 10);
      };
      respondJson(200, {
        since: monday(7),
        weeks: [
          {
            start: monday(0),
            providers: [
              { provider: 'claude', input: 342_000, output: 1_240_000, cacheRead: 1_480_000_000, cacheWrite: 21_000_000, reasoning: 0, models: ['claude-opus-5-5'] },
              { provider: 'codex', input: 1_130_000, output: 812_000, cacheRead: 9_400_000, cacheWrite: 0, reasoning: 214_000, models: ['gpt-6-sol'] },
            ],
          },
          {
            start: monday(1),
            providers: [
              { provider: 'claude', input: 518_000, output: 2_070_000, cacheRead: 2_310_000_000, cacheWrite: 34_000_000, reasoning: 0, models: ['claude-opus-5-5'] },
            ],
          },
        ],
      });
      return true;
    }
    const repoMatch = pathname.match(/^\/workspace\/api\/repos\/([^/]+)\/(tree|commits|prs|checks|contributors|file)$/);
    if (repoMatch && method === 'GET') {
      if (decodeURIComponent(repoMatch[1]) !== team.repo.name) { respondJson(404, { error: 'No such repository.' }); return true; }
      const kind = repoMatch[2];
      const commits = [...team.repo.commits, ...(proposal?.status === 'merged' ? [{ sha: team.proposal.headSha, authorName: ruby.name, at: proposal.decidedAt, subject: `Merge PR #1: ${team.proposal.title}` }] : [])]
        .map((c) => ({ ...c, checks: { total: 1, failing: 0, pending: 0, worst: 'success' } })).reverse();
      const pr = proposalRow(account);
      if (kind === 'tree') respondJson(200, { branch: 'main', entries: team.repo.tree });
      else if (kind === 'commits') respondJson(200, { branch: 'main', commits });
      else if (kind === 'prs') respondJson(200, { prs: pr ? [pr] : [] });
      else if (kind === 'checks') respondJson(200, { runs: commits.slice(0, 3).map((c) => ({ sha: c.sha, context: 'ci', state: 'success', description: 'Build, lint and 12 tests passed', startedAt: c.at, completedAt: c.at })) });
      else if (kind === 'contributors') respondJson(200, { contributors: [{ name: ruby.name, email: 'ruby@agents.northstar', commits: 4, insertions: 512, deletions: 40, agentId: ruby.id, agentAvatarUrl: dogFace(ruby.name) }, { name: milo.name, email: 'milo@agents.northstar', commits: 1, insertions: 18, deletions: 9, agentId: milo.id, agentAvatarUrl: dogFace(milo.name) }], countedAt: iso(Date.now()) });
      else if (kind === 'file') respondJson(200, { branch: 'main', sizeBytes: team.repo.readme.length, content: team.repo.readme });
      return true;
    }
    if (method === 'GET' && pathname === '/workspace/api/mail/unread') {
      respondJson(200, { unread: mail.filter((row) => row.direction !== 'sent' && !row.readAt && mailPlace(row) === 'inbox').length });
      return true;
    }
    // Who a letter wakes (slice 11). The default is NOBODY, and the roster is
    // this person's own agents — so the Settings row is walked against the
    // same three choices the real one offers.
    if (pathname === '/workspace/api/mail/wake' && (method === 'GET' || method === 'PUT')) {
      if (method === 'PUT') {
        expectCsrf(req, 'mail wake');
        const asked = body?.agentId ?? null;
        if (asked && !agentRows().some((row) => row.id === asked)) {
          respondJson(404, { error: 'That is not one of your agents.' });
          return true;
        }
        mailWakeAgentId = asked;
      }
      const agents = agentRows().map((row) => ({ id: row.id, name: row.name, cli: row.cli, room: (team.rooms.find((one) => one.roomId === roomId) ?? {}).name }));
      respondJson(200, {
        agent: agents.find((row) => row.id === mailWakeAgentId) ?? null,
        agents,
      });
      return true;
    }
    // Settings → Your builder page (note #824): the X profile their page
    // links to.
    if (pathname === '/workspace/api/profile/x' && (method === 'GET' || method === 'PUT')) {
      if (method === 'PUT') {
        expectCsrf(req, 'x profile');
        if (typeof body?.x === 'string') xProfile.x = body.x.trim().replace(/^@/, '') || undefined;
      }
      respondJson(200, xProfile.x ? { x: xProfile.x } : {});
      return true;
    }
    // A builder's page (note #200), as the public route answers it: the
    // reader and their teammate, this week. Read signed in from the account
    // menu's name (note #824), inside the Workspace.
    if (method === 'GET' && pathname.startsWith('/workspace/api/public/addresses/')) {
      const DAY = 86_400_000;
      const now = new Date();
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const weekStartMs = today - ((now.getUTCDay() + 6) % 7) * DAY;
      const gridStartMs = weekStartMs - 84 * DAY;
      const day = (ms) => new Date(ms).toISOString().slice(0, 10);
      const days = Math.round((today - gridStartMs) / DAY) + 1;
      const grid = (busy) => Array.from({ length: days }, (_, i) => (i >= days - busy ? 1 + ((i * 3) % 4) : 0));
      const builders = [
        { handle: MAIL_ADDRESS.split('@')[0], name: owner.name, photoUrl: personFace(owner.username), agents: 2, working: 1, runs: ['claude'],
          week: { workingMs: 14 * 3_600_000, merged: 6, claude: 1_840_000 }, grid: grid(10) },
        { handle: member.username.split('_')[0], name: member.name, photoUrl: personFace(member.username), agents: 1, working: 0, runs: ['claude'],
          week: { workingMs: 9 * 3_600_000, merged: 3, claude: 920_000 }, grid: grid(6) },
      ];
      const handle = decodeURIComponent(pathname.slice('/workspace/api/public/addresses/'.length));
      const place = builders.findIndex((row) => row.handle === handle);
      if (place < 0) { respondJson(404, { error: 'Nothing at this address' }); return true; }
      const { handle: _h, name, photoUrl, ...board } = builders[place];
      // Each square's day (note #208) and the totals (note #209), as a
      // builder's own page carries them.
      const squares = board.grid.map((level) => ({ workingMs: level * 3_600_000, merged: level ? 1 : 0, ...(level ? { claude: level * 90_000 } : {}) }));
      const allTime = { workingMs: board.week.workingMs * 2, claude: board.week.claude * 2 };
      respondJson(200, { kind: 'person', person: { handle, name, photoUrl, repos: [], board: { ...board, gridStart: day(gridStartMs), days: squares, allTime } } });
      return true;
    }
    if (method === 'GET' && pathname === '/workspace/api/mail/messages') {
      // The place and the search, with the backend's defaults: the inbox, or
      // — for a search — everything but Trash. Letters, not conversations:
      // a search finds the one that says the words.
      const words = (url.searchParams.get('q') ?? '').trim();
      const view = url.searchParams.get('in') || (words ? 'all' : 'inbox');
      if (!['inbox', 'archive', 'spam', 'trash', 'all', 'sent', 'starred'].includes(view)) { respondJson(400, { error: 'No such place.' }); return true; }
      // SENT (slice 9) is the one list a reply is a row of: everything that
      // has gone out, wherever it is kept, Trash apart. STARRED (note #666)
      // holds any letter that wears a star, a reply among them.
      const ofView = (row) => (view === 'sent' ? row.direction === 'sent' : view === 'starred' ? true : isListRow(row));
      const rows = mail
        .filter((row) => ofView(row) && inMailView(row, view) && (!words || mailMatches(row, words)))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      const { page, nextBefore } = pageOf(rows, url);
      respondJson(200, { address: MAIL_ADDRESS, messages: page.map(mailSummary), ...(nextBefore ? { nextBefore } : {}) });
      return true;
    }
    if (method === 'GET' && pathname === '/workspace/api/mail/conversations') {
      const place = url.searchParams.get('in') || 'inbox';
      if (!['inbox', 'archive', 'spam', 'trash'].includes(place)) { respondJson(400, { error: 'No such place.' }); return true; }
      const threads = [...new Set(mail.map((row) => row.thread))].map((thread) => conversationOf(thread));
      const rows = threads
        .filter((letters) => letters.length && conversationPlace(letters) === place)
        .map(conversationSummary)
        .sort((a, b) => b.latest.receivedAt.localeCompare(a.latest.receivedAt));
      const { page, nextBefore } = pageOf(rows, url);
      respondJson(200, { address: MAIL_ADDRESS, conversations: page, ...(nextBefore ? { nextBefore } : {}) });
      return true;
    }
    // STARS (note #666), put on and taken off as the backend does it: one
    // letter, or a conversation's row — its newest letter that arrived (else
    // its newest) outside Trash and Spam, and every letter of it when the
    // star comes off. Never onto a letter in Trash or Spam.
    const starMatch = pathname.match(/^\/workspace\/api\/mail\/(messages|conversations)\/([^/]+)\/(star|unstar)$/);
    if (starMatch && method === 'POST') {
      expectCsrf(req, `mail ${starMatch[3]}`);
      const whole = starMatch[1] === 'conversations';
      const on = starMatch[3] === 'star';
      const asked = mailRow(decodeURIComponent(starMatch[2]));
      if (!asked) { respondJson(404, { error: 'No such message.', code: 'no_such_message' }); return true; }
      const letters = conversationOf(asked.id);
      if (on) {
        const kept = letters.filter((letter) => !letter.trashedAt && !letter.spamAt);
        const arrived = kept.filter((letter) => letter.direction !== 'sent');
        const target = whole ? (arrived.length ? arrived : kept).at(-1) ?? asked : asked;
        if (target.trashedAt) { respondJson(409, { error: 'That message is in Trash. Restore it first, then star it.', code: 'in_trash' }); return true; }
        if (target.spamAt) { respondJson(409, { error: 'That message is in Spam. Mark it Not spam first, then star it.', code: 'in_spam' }); return true; }
        if (!target.starredAt) { target.starredAt = iso(Date.now()); delete target.starredBy; }
      } else {
        for (const letter of whole ? letters : [asked]) { delete letter.starredAt; delete letter.starredBy; }
      }
      respondJson(200, { conversation: conversationSummary(letters), messages: letters.map(mailSummary) });
      return true;
    }
    const conversationMoveMatch = pathname.match(/^\/workspace\/api\/mail\/conversations\/([^/]+)\/(archive|unarchive|spam|unspam|trash|restore)$/);
    if (conversationMoveMatch && method === 'POST') {
      expectCsrf(req, `mail conversation ${conversationMoveMatch[2]}`);
      const letters = conversationOf(decodeURIComponent(conversationMoveMatch[1]));
      if (!letters.length) { respondJson(404, { error: 'No such message.', code: 'no_such_message' }); return true; }
      const move = conversationMoveMatch[2];
      if (move !== 'trash' && move !== 'restore' && letters.filter(isListRow).every((letter) => letter.trashedAt)) {
        respondJson(409, { error: 'That conversation is in Trash. Restore it first.', code: 'in_trash' });
        return true;
      }
      if ((move === 'archive' || move === 'unarchive') && letters.filter(isListRow).every((letter) => letter.spamAt || letter.trashedAt)) {
        respondJson(409, { error: 'That conversation is in Spam. Mark it Not spam first.', code: 'in_spam' });
        return true;
      }
      // Every letter of it, the replies among them: a reply is kept where its
      // conversation is (slice 9), which is what Sent reads off it.
      for (const letter of letters) moveLetter(letter, move);
      respondJson(200, {
        conversation: conversationSummary(letters),
        messages: letters.map((letter) => {
          const summary = mailSummary(letter);
          return { id: letter.id, ...(summary.place ? { place: summary.place } : {}), ...(summary.movedBy ? { movedBy: summary.movedBy } : {}), ...(summary.spamWhy ? { spamWhy: summary.spamWhy } : {}) };
        }),
      });
      return true;
    }
    const conversationMatch = pathname.match(/^\/workspace\/api\/mail\/conversations\/([^/]+)$/);
    if (conversationMatch && method === 'GET') {
      const letters = conversationOf(decodeURIComponent(conversationMatch[1]));
      if (!letters.length) { respondJson(404, { error: 'No such message.' }); return true; }
      // Opening it is reading it — every letter in it — exactly as the backend decides it.
      for (const letter of letters) if (letter.direction !== 'sent' && !letter.readAt) letter.readAt = iso(Date.now());
      const answering = [...letters].reverse().find((letter) => letter.direction !== 'sent' && letter.from);
      respondJson(200, { conversation: {
        ...conversationSummary(letters),
        messages: letters.map(threadLetter),
        ...(answering ? { reply: {
          id: answering.id, to: answering.from,
          // Reply to all (slice 12), read off the letter as the backend reads it.
          ...(() => {
            const skip = new Set([MAIL_ADDRESS, answering.from.address]);
            const all = [...answering.to, ...(answering.cc ?? [])].filter((party) => !skip.has(party.address) && skip.add(party.address));
            return all.length ? { all: all.slice(0, 3), ...(all.length > 3 ? { allLeftOut: all.length - 3 } : {}) } : {};
          })(),
        } } : {}),
      } });
      return true;
    }
    const mailMoveMatch = pathname.match(/^\/workspace\/api\/mail\/messages\/([^/]+)\/(archive|unarchive|spam|unspam|trash|restore)$/);
    if (mailMoveMatch && method === 'POST') {
      expectCsrf(req, `mail ${mailMoveMatch[2]}`);
      const message = mailRow(decodeURIComponent(mailMoveMatch[1]));
      if (!message) { respondJson(404, { error: 'No such message.', code: 'no_such_message' }); return true; }
      const move = mailMoveMatch[2];
      if (move !== 'trash' && move !== 'restore' && message.trashedAt) {
        respondJson(409, { error: 'That message is in Trash. Restore it first.', code: 'in_trash' });
        return true;
      }
      if ((move === 'archive' || move === 'unarchive') && message.spamAt) {
        respondJson(409, { error: 'That message is in Spam. Mark it Not spam first.', code: 'in_spam' });
        return true;
      }
      moveLetter(message, move);
      // The replies under it go with it, as the backend stamps them.
      for (const letter of mail.filter((row) => row.answers === message.id)) moveLetter(letter, move);
      respondJson(200, { message: mailSummary(message) });
      return true;
    }
    // PICTURES IN LETTERS (slice 10). Three doors, answered the way the
    // backend answers them: the bytes of a picture that came inside the
    // message, the proxy for one the letter points at — which is the only
    // thing that ever fetches anything outside — and the list of senders
    // whose pictures this person loads.
    const mailInlineMatch = pathname.match(/^\/workspace\/api\/mail\/messages\/([^/]+)\/inline\/([^/]+)$/);
    if (mailInlineMatch && method === 'GET') {
      const message = mailRow(decodeURIComponent(mailInlineMatch[1]));
      const file = message?.attachments.find((one) => one.id === decodeURIComponent(mailInlineMatch[2]));
      if (!file || !file.contentType.startsWith('image/')) { respondJson(404, { error: 'No such picture on this message.' }); return true; }
      respondBytes(200, file.contentType, MAIL_PHOTO_PNG);
      return true;
    }
    const mailRemoteMatch = pathname.match(/^\/workspace\/api\/mail\/messages\/([^/]+)\/remote-image$/);
    if (mailRemoteMatch && method === 'GET') {
      const message = mailRow(decodeURIComponent(mailRemoteMatch[1]));
      const src = url.searchParams.get('src') ?? '';
      // The backend fetches only a picture the stored letter itself names —
      // and a tracker the screen refuses never reaches this door at all.
      if (!message || !(message.html ?? '').includes(src)) { respondJson(404, { error: 'That picture is not in this message.' }); return true; }
      if (src !== MAIL_LOGO_URL) { respondJson(502, { error: 'That picture could not be loaded.' }); return true; }
      respondBytes(200, 'image/png', MAIL_LOGO_PNG, { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      return true;
    }
    // BLOCKED SENDERS (slice 13): the list, and the two ways to change it,
    // answered as the backend answers them — blocking moves what that sender
    // already sent out of the inbox and the archive into Spam, and
    // unblocking moves nothing back.
    if (pathname === '/workspace/api/mail/blocked-senders' && (method === 'GET' || method === 'POST')) {
      if (method === 'POST') {
        expectCsrf(req, 'mail blocked senders');
        const address = String(body?.address ?? '').trim().toLowerCase();
        if (!address.includes('@')) { respondJson(400, { error: 'That is not an email address.' }); return true; }
        if (address === MAIL_ADDRESS) { respondJson(400, { error: 'That is your own address.' }); return true; }
        if (!mailBlockedSenders.includes(address)) mailBlockedSenders.push(address);
        let moved = 0;
        for (const letter of mail) {
          if (letter.direction === 'sent' || letter.from?.address.toLowerCase() !== address || letter.spamAt || letter.trashedAt) continue;
          letter.spamAt = iso(Date.now()); letter.spamWhy = 'blocked'; delete letter.spamBy; delete letter.notSpam;
          moved += 1;
          for (const reply of mail.filter((row) => row.answers === letter.id)) { reply.spamAt = letter.spamAt; }
        }
        respondJson(200, { addresses: [...mailBlockedSenders].sort(), moved });
        return true;
      }
      respondJson(200, { addresses: [...mailBlockedSenders].sort() });
      return true;
    }
    const mailBlockedMatch = pathname.match(/^\/workspace\/api\/mail\/blocked-senders\/([^/]+)$/);
    if (mailBlockedMatch && method === 'DELETE') {
      expectCsrf(req, 'mail blocked senders');
      const address = decodeURIComponent(mailBlockedMatch[1]).toLowerCase();
      const at = mailBlockedSenders.indexOf(address);
      if (at >= 0) mailBlockedSenders.splice(at, 1);
      respondJson(200, { addresses: [...mailBlockedSenders].sort() });
      return true;
    }
    if (pathname === '/workspace/api/mail/image-senders' && (method === 'GET' || method === 'POST')) {
      if (method === 'POST') {
        expectCsrf(req, 'mail image senders');
        const address = String(body?.address ?? '').trim().toLowerCase();
        if (!address.includes('@')) { respondJson(400, { error: 'That is not an email address.' }); return true; }
        if (!mailImageSenders.includes(address)) mailImageSenders.push(address);
      }
      respondJson(200, { addresses: [...mailImageSenders].sort() });
      return true;
    }
    const mailSenderMatch = pathname.match(/^\/workspace\/api\/mail\/image-senders\/([^/]+)$/);
    if (mailSenderMatch && method === 'DELETE') {
      expectCsrf(req, 'mail image senders');
      const address = decodeURIComponent(mailSenderMatch[1]).toLowerCase();
      const at = mailImageSenders.indexOf(address);
      if (at >= 0) mailImageSenders.splice(at, 1);
      respondJson(200, { addresses: [...mailImageSenders].sort() });
      return true;
    }
    const mailFileMatch = pathname.match(/^\/workspace\/api\/mail\/messages\/([^/]+)\/files\/([^/]+)$/);
    if (mailFileMatch && method === 'GET') {
      respondJson(200, { url: '/workspace/faces/northstar.svg', fileName: 'harborlight-brief.pdf', expiresAt: iso(Date.now() + 900_000) });
      return true;
    }
    const mailReplyMatch = pathname.match(/^\/workspace\/api\/mail\/messages\/([^/]+)\/reply$/);
    if (mailReplyMatch && method === 'POST') {
      const id = decodeURIComponent(mailReplyMatch[1]);
      expectCsrf(req, 'mail reply');
      const message = mail.find((row) => row.id === id && row.direction !== 'sent');
      if (!message) { respondJson(404, { error: 'No such message.' }); return true; }
      const upload = readMailUpload(body);
      const copies = readCc(upload.fields.cc);
      if (copies.refused) { respondJson(400, { error: copies.refused, code: 'bad_recipient' }); return true; }
      const said = String(upload.fields.text ?? '').trim();
      if (!said) { respondJson(400, { error: 'Write something first.' }); return true; }
      // The world answers the way the backend does: the recipient comes off
      // the message, never off the request — and the answer is stored in the
      // conversation of the letter it answers.
      const attachments = keptFiles(upload.files);
      const reply = {
        id: `mm_reply_${mail.length + 1}`,
        to: [message.from],
        ...(copies.cc.length ? { cc: copies.cc } : {}),
        ...(attachments.length ? { attachments } : {}),
        // The words only: the backend sends the quote and keeps it in the
        // record, and hands the screen back what the person actually wrote.
        text: said,
        sentAt: iso(Date.now()),
      };
      mail.push({
        id: reply.id, direction: 'sent', answers: message.id, thread: message.thread,
        from: { address: MAIL_ADDRESS }, to: reply.to, cc: copies.cc, replyTo: [],
        subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
        snippet: said.replace(/\s+/g, ' ').slice(0, 200), text: said, receivedAt: reply.sentAt,
        attachments, rawSize: 0,
      });
      respondJson(201, { reply });
      return true;
    }
    if (method === 'POST' && pathname === '/workspace/api/mail/send') {
      expectCsrf(req, 'mail send');
      // The world refuses what the backend refuses: one address a box, and words.
      const upload = readMailUpload(body);
      const to = String(upload.fields.to ?? '').trim();
      const said = String(upload.fields.text ?? '').trim();
      const copies = readCc(upload.fields.cc);
      if (copies.refused) { respondJson(400, { error: copies.refused, code: 'bad_recipient' }); return true; }
      if (!ONE_ADDRESS.test(to)) {
        respondJson(400, { error: 'Write one email address to send this to.', code: 'bad_recipient' });
        return true;
      }
      if (!said) { respondJson(400, { error: 'Write something first.', code: 'empty_reply' }); return true; }
      const written = {
        id: `mm_out_${mail.length + 1}`,
        direction: 'sent',
        from: { address: MAIL_ADDRESS },
        to: [{ address: to }],
        cc: copies.cc,
        replyTo: [],
        subject: String(upload.fields.subject ?? '').trim(),
        snippet: said.replace(/\s+/g, ' ').slice(0, 200),
        text: `${said}\n`,
        receivedAt: iso(Date.now()),
        attachments: keptFiles(upload.files),
        rawSize: 0,
      };
      written.thread = written.id;
      mail.unshift(written);
      respondJson(201, { message: mailSummary(written) });
      return true;
    }
    // FORWARD (slice 12): a letter of its own that answers nothing, kept in
    // the conversation of the letter it passes on, with that letter's ticked
    // files and any new ones — exactly the backend's shape.
    const mailForwardMatch = pathname.match(/^\/workspace\/api\/mail\/messages\/([^/]+)\/forward$/);
    if (mailForwardMatch && method === 'POST') {
      expectCsrf(req, 'mail forward');
      const message = mailRow(decodeURIComponent(mailForwardMatch[1]));
      if (!message) { respondJson(404, { error: 'No such message.' }); return true; }
      if (message.trashedAt) { respondJson(409, { error: 'That letter is in Trash. Restore it first to forward it.', code: 'not_forwardable' }); return true; }
      const upload = readMailUpload(body);
      const to = String(upload.fields.to ?? '').trim();
      if (!ONE_ADDRESS.test(to)) { respondJson(400, { error: 'Write one email address to forward this to.', code: 'bad_recipient' }); return true; }
      const copies = readCc(upload.fields.cc);
      if (copies.refused) { respondJson(400, { error: copies.refused, code: 'bad_recipient' }); return true; }
      const carry = Array.isArray(upload.fields.carry) ? upload.fields.carry : message.attachments.map((file) => file.id);
      const said = String(upload.fields.text ?? '').trim();
      const forward = {
        id: `mm_fwd_${mail.length + 1}`,
        direction: 'sent',
        forwards: message.id,
        thread: message.thread,
        ...(message.archivedAt ? { archivedAt: message.archivedAt } : {}),
        from: { address: MAIL_ADDRESS },
        to: [{ address: to }],
        cc: copies.cc,
        replyTo: [],
        subject: /^(fwd?|fw)\s*:/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`,
        snippet: (said || message.snippet).replace(/\s+/g, ' ').slice(0, 200),
        ...(said ? { text: said } : {}),
        receivedAt: iso(Date.now()),
        attachments: [...message.attachments.filter((file) => carry.includes(file.id)).map((file) => ({ ...file, inline: undefined })), ...keptFiles(upload.files)],
        rawSize: 0,
      };
      mail.push(forward);
      respondJson(201, { message: mailSummary(forward) });
      return true;
    }
    const mailApprovalMatch = pathname.match(/^\/workspace\/api\/mail\/approvals\/([^/]+)(\/decision)?$/);
    if (mailApprovalMatch) {
      const approval = mailApprovals.get(decodeURIComponent(mailApprovalMatch[1]));
      if (!approval) { respondJson(404, { error: 'No such mail approval.' }); return true; }
      if (mailApprovalMatch[2] && method === 'POST') {
        expectCsrf(req, 'mail approval');
        if (approval.status === 'pending') {
          approval.status = body?.decision === 'approve' ? 'sent' : 'rejected';
          approval.decidedAt = iso(Date.now());
        }
      }
      respondJson(200, { approval });
      return true;
    }
    const mailMatch = pathname.match(/^\/workspace\/api\/mail\/messages\/([^/]+)$/);
    if (mailMatch && method === 'GET') {
      const message = mailRow(decodeURIComponent(mailMatch[1]));
      if (!message) { respondJson(404, { error: 'No such message.' }); return true; }
      // Opening it is reading it, exactly as the backend decides it.
      if (!message.readAt) message.readAt = iso(Date.now());
      respondJson(200, { message: { ...mailSummary(message), to: message.to, cc: message.cc, replyTo: message.replyTo,
        ...(message.text ? { text: message.text } : {}), ...(message.html ? { html: message.html } : {}),
        attachments: message.attachments, ...(message.authentication ? { authentication: message.authentication } : {}),
        rawSize: message.rawSize,
        replies: mail.filter((row) => row.answers === message.id).map((row) => ({
          id: row.id, to: row.to, text: row.text, sentAt: row.receivedAt, ...(row.sentBy ? { sentBy: row.sentBy } : {}),
        })),
        // A message this person wrote has nobody to answer: they are the sender.
        ...(message.direction === 'sent' ? {} : { answerTo: message.from }) } });
      return true;
    }
    if (method === 'GET' && pathname === '/workspace/api/git-access') { respondJson(200, { createdAt: null }); return true; }
    if (method === 'GET' && pathname === '/workspace/api/drive') {
      if (url.searchParams.get('trash') === '1') { respondJson(200, { ...driveListing(''), items: [], folder: null }); return true; }
      respondJson(200, driveListing(url.searchParams.get('parent') || ''));
      return true;
    }
    // A list row's picture (note #694). The backend redirects to a signed
    // copy; the world hands back a picture's bytes, which is what the <img>
    // ends up with either way. Anything that is not a picture is refused.
    const drivePictureMatch = pathname.match(/^\/workspace\/api\/drive\/([^/]+)\/image$/);
    if (drivePictureMatch && method === 'GET') {
      const file = team.drive.files.find((f) => f.id === decodeURIComponent(drivePictureMatch[1]));
      if (!file || !file.contentType.startsWith('image/')) { respondJson(404, { error: 'No such picture in this Drive.' }); return true; }
      respondBytes(200, 'image/png', file.contentType === 'image/svg+xml' ? MAIL_LOGO_PNG : MAIL_PHOTO_PNG, { 'Cache-Control': 'private, max-age=300' });
      return true;
    }
    const driveMatch = pathname.match(/^\/workspace\/api\/drive\/([^/]+)$/);
    if (driveMatch && method === 'GET') {
      const id = decodeURIComponent(driveMatch[1]);
      const folder = team.drive.folders.find((f) => f.id === id);
      const file = team.drive.files.find((f) => f.id === id);
      if (folder) respondJson(200, { canDeleteForever: true, item: driveItem(folder, 'folder'), breadcrumbs: [] });
      else if (file) respondJson(200, { canDeleteForever: true, item: driveItem(file, 'file'), breadcrumbs: file.parentId ? [driveItem(team.drive.folders.find((f) => f.id === file.parentId), 'folder')] : [] });
      else respondJson(404, { error: 'No such item.' });
      return true;
    }
    // The Sites screen's estimates (note #993): the real route prices the
    // machine and disks Fly reports with config/fly-cost-estimates.ts. These
    // figures are that table's answer for a static site (1 shared CPU,
    // 256 MB, one 1 GB disk) — a fixture, not a second price source.
    if (pathname === '/workspace/api/sites/costs' && method === 'GET') {
      const sites = site && site.status !== 'destroyed'
        ? [{
          name: site.name, preset: site.preset, read: true,
          machine: { cpuKind: 'shared', cpus: 1, memoryMb: 256, running: true, monthlyUsd: 1.94 },
          disks: [{ sizeGb: 1, monthlyUsd: 0.15 }], spareDisks: [], disksMonthlyUsd: 0.15, monthlyUsd: 2.09,
        }]
        : [];
      respondJson(200, {
        hosted: true, sites, monthlyUsd: sites.length ? 2.09 : 0, unread: 0,
        disclaimer: 'Estimates from Fly’s published prices — the Fly dashboard is the authority.',
      });
      return true;
    }
    const roomMatch = pathname.match(/^\/workspace\/api\/rooms\/([^/]+)$/);
    if (roomMatch && method === 'GET') {
      const room = team.rooms.find((row) => row.roomId === decodeURIComponent(roomMatch[1]));
      if (!room) { respondJson(404, { error: 'No such room.' }); return true; }
      const product = room.roomId === roomId;
      respondJson(200, { room, holds: product ? { agents: 2, sites: site ? 1 : 0, repos: 1, notes: notes.length, knowledge: knowledgePages.length, proposals: proposal ? 1 : 0, secrets: 1 } : { agents: 0, sites: 0, repos: 0, notes: 0, knowledge: 0, proposals: 0, secrets: 0 }, canDelete: !product });
      return true;
    }
    return false;
  }

  return {
    stage,
    state,
    handle,
    registered,
    snapshot: () => ({
      members: [...membership.keys()],
      invites: invites.map((row) => row.token),
      joinRequests: joinRequests.map(({ requestId, status }) => ({ requestId, status })),
      notes: notes.map(({ number, work }) => ({ number, work })),
      proposal: proposal ? { status: proposal.status, live: Boolean(proposal.delivery?.live) } : null,
      knowledgeProposal: kpStatus,
      knowledgePages: knowledgePages.map((row) => row.name),
      site: site ? site.status : null,
      chatRows: { [ruby.name]: chats[ruby.id].length, [milo.name]: chats[milo.id].length },
      unread: notifications.filter((n) => !n.readAt).length,
    }),
  };
}
