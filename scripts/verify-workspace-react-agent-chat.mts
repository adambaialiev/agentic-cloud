// Drives the React Workspace shell's AGENT screen and CHAT in real Chrome
// against a real backend router, an in-memory auth service, a seeded fleet
// and a scripted agent lifecycle: open an agent from Home, read its facts and
// its version card, change its model through the picker, open the chat, read
// every kind of row, decide an agent-authored email in place, send a message,
// stop a running turn, and come Back the
// two ways the navigation model allows. The transcript is made long enough
// to SCROLL, because where the chat opens, what a send follows, what a leaf
// gives back and how the box grows are the things the port got wrong
// (note #273) and jsdom cannot see any of them. Screenshots land in
// ~/mini-preview/.
// Since 2026-10-10 Home (`/`) is the Workspace Agent's conversation — the
// Chief of Staff's since note #715. This run's account has no workplace, and
// a personal account is the one Home that still draws the tabbed overview
// (`#screenOverview`), which is where its agents' rows stand.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-agent-chat.mts
//
// `--shell <dir>` re-points the run at a DIFFERENT built shell — the one
// unpacked from a deploy artifact, say — while this process keeps serving the
// scripted backend the fixture needs. That is the React equivalent of the
// single-file harnesses' `--page`: an already-served production shell cannot
// be driven against a fixture, because its API half is the real account.
// `CHROME=<path>` overrides the browser; by default the newest one puppeteer
// downloaded is used, so a machine rebuild does not strand this script.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryGitPullRequestStorage } from '../backend/src/services/git-pr-storage.js';
import { InMemoryGitRepoStorage } from '../backend/src/services/git-repo-storage.js';
import { InMemoryKnowledgeProposalStorage } from '../backend/src/services/knowledge-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessMailService, harnessSignedIn } from './workspace-harness-auth.mjs';
import type { WorkspaceMailApproval } from '../backend/src/shared/workspace-mail.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
// express lives in backend/node_modules; puppeteer-core in the root's.
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};
const SHELL = flag('--shell', path.join(REPO, 'backend/dist/workspace-ui'));
/**
 * The Chrome puppeteer downloaded, whichever build it is. Resolved rather
 * than pinned: this machine's browser is replaced on every rebuild, and a
 * harness that names one version simply stops running the day it changes.
 */
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4176);
/** `VIEWPORT=<width>x<height>`; a phone unless a run asks for something else. */
const viewport = (() => {
  const [width, height] = (process.env.VIEWPORT || '420x860').split('x').map(Number);
  return { width: width || 420, height: height || 860 };
})();
const ORIGIN = `http://127.0.0.1:${PORT}`;

const now = new Date();
const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

/** How long the picture route holds its bytes: long enough that a row drawn
 *  before they land is a state a check can see (note #302). */
const PICTURE_DELAY_MS = 400;
/** How long the state read is held while a reload is under test: the chat's
 *  own read then wins the race, which on a real cold load it usually does. */
let stateDelayMs = 0;
/** A gate, where a delay would be a race (note #563). The check that pictures
 *  are framed BEFORE their bytes land used to lean on PICTURE_DELAY_MS alone:
 *  400 ms to load the transcript, settle the scroll and take the reading. A
 *  quiet machine does that in time; three harnesses on two cores do not — the
 *  bytes were already in on 5 runs of 6 under load, and on both of CI's
 *  attempts on 2026-09-18. While this is set the route keeps every picture
 *  until `releasePictures()`, so "before" is a fact instead of a hope. */
let picturesHeld = false;
const heldPictures: Array<() => void> = [];
const releasePictures = () => {
  picturesHeld = false;
  for (const send of heldPictures.splice(0)) send();
};

/** Note #658: the next send waits on a machine rebuild, as the real route
 *  does when the agent's machine has gone — the chat read says `preparing`
 *  meanwhile, and the harness lets it go with `releaseSend`. */
let sendHeld = false;
let preparing = false;
let releaseSend: () => void = () => {};
/** Note #672: the file names the last send carried through the real route. */
let lastSentFiles: string[] = [];
/** Note #704: the words the last send carried through the real route. */
let lastSentMessage = '';

/** The transcript this harness serves, and whether a turn is running. */
let working = true;
const transcript: Array<{
  seq: number;
  role: 'owner' | 'agent' | 'platform';
  kind?: 'new-chat-divider';
  text: string;
  at: string;
  open?: { pr?: string; kp?: string };
  mailApprovalId?: string;
  files?: Array<{ id: string; fileName: string; contentType: string; sizeBytes: number }>;
}> = [
  { seq: 1, role: 'owner' as const, text: 'Ship the checkout page, **exactly** as typed.', at: iso(90) },
  { seq: 2, role: 'agent' as const, text: '## On it\n\nBuilding it now:\n\n- the form\n- the receipt\n\n```ts\nconst total = 42;\n```\n\nSee [the plan](https://example.com/plan).', at: iso(88) },
  {
    seq: 3,
    role: 'platform' as const,
    text: 'PR #12 ("Move the checkout to React") in infinite-agents awaits your decision: '
      + 'checkout → main. 9 files, +870 −20 · checks passed. Nothing lands on your protected branch until you say so.',
    at: iso(20),
    open: { pr: 'p1' },
  },
  { seq: 4, role: 'platform' as const, text: '[Platform] Message from agent Oscar: rebased slice 4 on main.', at: iso(10) },
  { seq: 5, role: 'platform' as const, text: 'Turn stopped by the user.', at: iso(5) },
  // Notes #263/#284: a note NAMED in the words is a door to it — in the
  // reader's own message, in an agent's reply, and on the receipt that says
  // which note a fresh chat picked up. The proposal number beside it is the
  // reason a bare `#` is never enough to go on.
  { seq: 6, role: 'owner' as const, text: 'then pick up the note #284', at: iso(5) },
  {
    seq: 7,
    role: 'agent' as const,
    text: 'Landed: **note #284**, and note #263 with it. PR #560 is the change; note #262 is still open.',
    at: iso(4),
  },
  // A reset, exactly as the record carries one: the structural rule the
  // backend writes, and the handoff receipt standing under it. Note #394 made
  // that receipt the rule's quiet CAPTION rather than a bordered card, so the
  // pair has to be seen together — the wrap, the spacing and the weight of it
  // are the whole change, and none of the three exists in jsdom.
  { seq: 8, role: 'platform' as const, kind: 'new-chat-divider' as const, text: '─'.repeat(30), at: iso(3) },
  {
    seq: 9,
    role: 'platform' as const,
    text: 'Fresh conversation. You reset the previous one yourself and left this handoff for exactly this '
      + 'moment: pick up note #284.\n\nThis is your own note, addressed to you.',
    at: iso(3),
  },
  { seq: 10, role: 'agent' as const, text: 'Picked it up. Reading the note now.', at: iso(3) },
  // …and the wording for a reset that carried no note, which is the one the
  // owner was looking at when they asked for this.
  { seq: 11, role: 'platform' as const, kind: 'new-chat-divider' as const, text: '─'.repeat(30), at: iso(2) },
  {
    seq: 12,
    role: 'platform' as const,
    text: 'Fresh conversation. You reset the previous one yourself and left this handoff for exactly this '
      + 'moment: the deploy is half applied.\n\nThis is your own note, addressed to you.',
    at: iso(2),
  },
  // Note #425: all three states of the knowledge-proposal receipt stand
  // together so a real browser can prove the state is plain colour, Rejected
  // is danger ink, and the document cards are tighter than the change card.
  {
    seq: 13,
    role: 'platform' as const,
    text: 'Knowledge proposal #160 ("Update the Workspace agent runbook") awaits your decision — '
      + 'Update one page. Nothing changes until you approve.',
    at: iso(2),
    open: { kp: 'k160' },
  },
  {
    seq: 14,
    role: 'platform' as const,
    text: 'Your user APPROVED knowledge proposal #161 ("How a room is drawn").',
    at: iso(1),
    open: { kp: 'k161' },
  },
  {
    seq: 15,
    role: 'platform' as const,
    text: 'Your user REJECTED knowledge proposal #162 ("Workspace agent"). They said: "not yet".',
    at: iso(1),
    open: { kp: 'k162' },
  },
  // Note #448: a platform event the recogniser does not know still keeps all
  // of its human-facing words, but it has no robot tile and no redundant
  // "Platform" eyebrow. It is the generic shape from the owner's screenshot.
  {
    seq: 16,
    role: 'platform' as const,
    text: 'Sent to Alex: Handing you note #423 "Workspace Agent: follow-ups". Please claim it and work the backend items.',
    at: iso(1),
  },
  // Note #507: the Workspace Agent speaks here like any other peer. Since
  // note #715 the person-facing name is "Chief of Staff", drawn with no face
  // even though the backend still sends the reserved one (`fromAvatarUrl`).
  {
    seq: 17,
    role: 'platform' as const,
    text: '[Platform] Message from agent Workspace Agent: Owner direction: the live landing is canonical. '
      + 'Own the Growth room\'s public-site work as one coherent change, and say what you removed.',
    at: iso(1),
  },
];
// Enough after those five that the page scrolls a few screens: the checks
// below on where the chat opens and what it follows pass vacuously on a
// transcript that fits the viewport.
for (let i = 0; i < 40; i++) {
  transcript.push({
    seq: transcript.length + 1,
    role: i % 2 ? 'agent' : 'owner',
    text: `Filler row ${i} — ${'words '.repeat(12 + (i % 7) * 6).trim()}`,
    at: iso(4),
  });
}

/**
 * A real PNG of `width` x `height`, built here rather than pasted in as
 * base64: what these fixtures have to be is BIG, of two different SHAPES and
 * telling apart on sight, and three lines of arithmetic say that better than
 * a kilobyte of unreadable literal. The bands are what make a stretch, a crop
 * or a picture that never changed when the reader stepped visible in a
 * screenshot.
 */
function png(width: number, height: number, colour: (x: number, y: number) => [number, number, number]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      row[1 + x * 3] = r & 255; row[2 + x * 3] = g & 255; row[3 + x * 3] = b & 255;
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Two pictures and a document on ONE message — the shape note #294 is about,
 *  and the shape that makes the viewer's gallery worth having. Wide first and
 *  tall second, so a step between them changes the picture unmistakably. */
const pictures: Record<string, Buffer> = {
  'wide.png': png(640, 200, (x, y) => [30 + Math.floor(x / 40) * 20, 90 + Math.floor(y / 25) * 12, 200 - Math.floor(x / 64) * 15]),
  'tall.png': png(300, 480, (x, y) => [200 - Math.floor(y / 60) * 18, 40 + Math.floor(x / 30) * 20, 80 + Math.floor(y / 48) * 15]),
};
// The wide one carries its size on the row, as every picture stored since
// note #302 does; the tall one does not, and is measured by the preview read
// the way a picture stored before then is. Both are framed before their bytes.
const PICTURE_SIZES: Record<string, { width: number; height: number }> = {
  'wide.png': { width: 640, height: 200 },
  'tall.png': { width: 300, height: 480 },
};
/**
 * A real PDF, written by hand so this harness needs no dependency to make
 * one — three pages of plain Helvetica, which is enough for Chrome's own
 * viewer to draw and enough to tell a preview (page one only) from the full
 * document (scrollable, three pages).
 */
function pdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((words, index) => {
    const stream = `BT /F1 34 Tf 60 700 Td (${words}) Tj ET`;
    objects[4 + index * 2] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`;
    objects[5 + index * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = out.length;
    out += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const startxref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) {
    out += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const documents: Record<string, Buffer> = {
  'design-review.pdf': pdf([
    'Design review - page one', 'Design review - page two', 'Design review - page three',
  ]),
};
// Note #557: a report an agent wrote as a PAGE — the shape a table-heavy
// write-up takes — with a script in it, because whether the sandbox lets the
// page draw itself while giving it no origin is the whole thing to prove.
const pages: Record<string, string> = {
  'calibration-review.html': `<!doctype html><html><head><meta charset="utf-8"><title>Calibration review</title>
<style>body{font:16px/1.5 system-ui;margin:24px;color:#111}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}</style>
</head><body><h1>Startup outreach review</h1><p>5 qualified prospects. Evidence only; this report cannot approve or send outreach.</p>
<table><tr><th>Company</th><th>State</th><th>Fit</th></tr><tr><td>Cactus Compute</td><td>contact_found</td><td>88</td></tr><tr><td>Attar</td><td>qualified</td><td>86</td></tr></table>
<p id="ran">script did not run</p><p><a href="https://example.com/evidence" target="_blank">evidence</a></p>
<script>document.getElementById('ran').textContent = 'script ran, origin ' + (function () { try { return window.origin; } catch (e) { return 'unreadable'; } })();</script>
</body></html>`,
};
// Note #677: the shape of what an agent actually hands over — a heading, a
// lede, sections, lists, a table, a quote and a fenced block — so the page
// is proved on everything the renderer draws, not on one line.
const LAUNCH_PLAN = `# Ship it: building in public

A two-week plan for putting the game in front of people, one small post at a time. **Nothing here goes out without you.**

## Where to post

1. Start with r/SideProject now, and r/gamedesign for discussion with no links.
2. Post on X twice a week: one gif, one lesson.
3. Save Hacker News for the playable version.

## This week

- Record a 20-second clip of the first run
- Write the "what I learned" thread
  - keep it under six posts
  - end with a question, never a link
- Put a *tell me when it's ready* signup on the landing page

| Channel | When | Goal |
| --- | --- | --- |
| r/SideProject | Monday | first 50 players |
| X | Tue, Thu | 100 followers |
| Hacker News | when playable | front page |

> Reddit punishes accounts that only promote. Spend two weeks commenting first.

## The first post

\`\`\`
I'm building an idle game about running a startup,
with AI agents doing the building. Day 1.
\`\`\`

Read the [Vibe Jam 2026 winners](https://example.com/vibe-jam) before writing it.

---

— Ruby
`;
const chatFiles = [
  { id: 'cf1', fileName: 'wide.png', contentType: 'image/png', sizeBytes: pictures['wide.png']!.length, ...PICTURE_SIZES['wide.png'] },
  { id: 'cf2', fileName: 'tall.png', contentType: 'image/png', sizeBytes: pictures['tall.png']!.length },
  // Note #677: a Markdown file is shown as the page it is, not saved.
  { id: 'cf3', fileName: 'launch-plan.md', contentType: 'text/markdown', sizeBytes: Buffer.byteLength(LAUNCH_PLAN) },
  // Note #403: the third shape a message carries — a document the Workspace
  // draws itself rather than handing to the browser to download.
  { id: 'cf4', fileName: 'design-review.pdf', contentType: 'application/pdf', sizeBytes: documents['design-review.pdf']!.length },
  // Note #557: a page, under the generic header an agent's `attach` sends.
  { id: 'cf5', fileName: 'calibration-review.html', contentType: 'application/octet-stream', sizeBytes: Buffer.byteLength(pages['calibration-review.html']!) },
];
transcript.push({
  seq: transcript.length + 1,
  role: 'owner' as const,
  text: 'both screenshots, the notes and the review',
  at: iso(1),
  files: chatFiles,
});
/**
 * Note #693: the clip an agent renders and hands over, and a recording, which
 * the chat PLAYS. Real bytes for a real decoder, made once with ffmpeg and
 * kept beside the screenshot fixture: a portrait H.264 clip in one flat
 * colour, so the frame the player draws can be read back, and three seconds
 * of a tone.
 */
const media: Record<string, { bytes: Buffer; type: string }> = {
  'chat-clip.mp4': { bytes: readFileSync(path.join(REPO, 'scripts/fixtures/chat-clip.mp4')), type: 'video/mp4' },
  'chat-voice.mp3': { bytes: readFileSync(path.join(REPO, 'scripts/fixtures/chat-voice.mp3')), type: 'audio/mpeg' },
};
const mediaFiles = Object.entries(media).map(([fileName, file], index) => ({
  id: `cm${index + 1}`, fileName, contentType: file.type, sizeBytes: file.bytes.length,
}));
transcript.push({ seq: transcript.length + 1, role: 'agent' as const, text: '', at: iso(1), files: mediaFiles });
let mailApproval: WorkspaceMailApproval = {
  id: 'ma_chat_fixture', kind: 'send', from: { name: 'Saddam', address: 'saddam@agenticcloudcomputer.com' },
  to: { name: 'Ada Lovelace', address: 'ada@example.com' },
  subject: 'Tuesday’s launch',
  text: 'Hi Ada,\n\nThe launch is ready for Tuesday at four. I’ll bring the final notes.\n\nSaddam',
  requestedBy: 'Felix', status: 'pending', createdAt: new Date().toISOString(),
};
transcript.push({
  seq: transcript.length + 1,
  role: 'platform',
  text: 'Felix wants to send email to ada@example.com. Nothing will be sent until you approve it here.',
  at: new Date().toISOString(),
  mailApprovalId: mailApproval.id,
});

const userStorage = new InMemoryUserStorage();
// Both proposal stores, because the agent screen's history has two halves
// (note #276) and only a real browser shows the two row shapes standing in
// one card. No git HOST beside them: listing what an agent PROPOSED reads the
// documents alone, which is also why the repositories section of Home stays
// away and this fixture keeps its subject.
const gitRepoStorage = new InMemoryGitRepoStorage();
const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);

/** Just enough lifecycle for the two screens under test. */
const agentLifecycle = {
  createAgent: async () => ({ ok: true as const }),
  deleteAgent: async (_userId: string, agentId: string) => ({
    ok: true as const, name: agentId, machine: 'destroyed' as const, remaining: 0,
  }),
  // The facts card, per agent: this fixture has two, and a card that answered
  // the same runtime for both would put Felix's opus on Oscar's screen under
  // a header reading fable — a screenshot that argues with itself.
  agentVersion: async (_userId: string, agentId: string) => ({
    cliLabel: 'Claude Code',
    installed: '1.2.3',
    pinned: '1.3.0',
    cliUpdateAvailable: true,
    image: { current: true, canUpdate: false },
    busy: working && agentId === 'felix',
    machine: { awake: false, region: 'ams', regionName: 'Amsterdam', memoryMb: 4096 },
    ...(agentId === 'felix'
      ? { model: 'opus', effort: 'high', lastActiveAt: iso(5), turnCount: 1204 }
      : { model: 'fable', effort: 'medium', lastActiveAt: iso(30), turnCount: 78 }),
    siteUrl: 'https://shop.agentbuilt.app',
    docs: { file: 'CLAUDE.md', version: 4, latest: 5, current: false },
  }),
  // Per AGENT, not per fixture: the turn this run starts, stops and steers is
  // Felix's, and the peer whose face raises a card in the transcript is idle.
  // A flag that answered for every agent made that card say "Active" about an
  // agent doing nothing, which is exactly the fact the card is there to give.
  isAgentWorking: (_userId: string, agentId: string) => working && agentId === 'felix',
  agentActivity: (_userId: string, agentId: string) => (working && agentId === 'felix'
    ? { activity: 'Bash: npm run build', startedAt: Date.now() - 42_000 }
    : null),
  isAgentPreparing: (_userId: string, agentId: string) => preparing && agentId === 'felix',
  agentChatMessages: async (_userId: string, _agentId: string, afterSeq: number) =>
    transcript.filter((message) => message.seq > afterSeq),
  listManagedJobs: async (_userId: string, agentId: string) => ({
    jobs: agentId === 'felix' ? [
      {
        id: 'j_111111111111111111111111',
        label: 'npm run build:workspace-ui',
        startedAt: iso(2),
      },
      {
        id: 'j_222222222222222222222222',
        label: 'node scripts/render-product-tour.mjs --mobile',
        startedAt: iso(1),
      },
    ] : [],
    recent: [],
  }),
  latestAgentChatMessage: async () => ({ text: '**Done** — the checkout page is `live`.', at: iso(5) }),
  chatMessageAgentFromUser: async (args: { message: string; attachments?: Array<{ fileName: string }> }) => {
    lastSentFiles = (args.attachments ?? []).map((file) => file.fileName);
    lastSentMessage = args.message;
    if (sendHeld) {
      sendHeld = false;
      preparing = true;
      await new Promise<void>((resolve) => { releaseSend = resolve; });
      preparing = false;
    }
    transcript.push({
      seq: transcript.length + 1, role: 'owner' as const, text: args.message, at: new Date().toISOString(),
    });
    return { ok: true as const, recipient: { id: 'felix', name: 'Felix', cli: 'claude' as const } };
  },
  // Note #677: a Markdown file's words, as the backend reads them out of the
  // store for the Workspace to draw itself.
  agentChatFileText: async (_userId: string, _agentId: string, fileId: string) => {
    const file = chatFiles.find((candidate) => candidate.id === fileId);
    if (!file) return null;
    return file.fileName === 'launch-plan.md'
      ? { kind: 'markdown' as const, fileName: file.fileName, content: LAUNCH_PLAN }
      : { kind: 'unsupported' as const, fileName: file.fileName };
  },
  agentChatFileAccess: async (_userId: string, _agentId: string, fileId: string, preview?: boolean) => {
    const file = [...chatFiles, ...mediaFiles].find((candidate) => candidate.id === fileId);
    if (!file) return null;
    return {
      // A fresh URL per mint, as a signed URL is: a reload must fetch the
      // bytes again rather than paint them from the cache before the frame
      // check can look.
      // …and signed for the read it was asked for: inline for a preview, and
      // save-as otherwise, as the backend signs them (note #557 reads both).
      url: `${ORIGIN}/fixtures/${file.fileName}?mint=${Date.now()}-${Math.random().toString(36).slice(2)}${preview ? '&preview=1' : ''}`,
      fileName: file.fileName,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      // The backend measures a picture stored without a size on its first
      // preview read and says so; the frame is drawn from this answer.
      ...(preview ? PICTURE_SIZES[file.fileName] ?? {} : {}),
    };
  },
  stopAgentTurn: async () => {
    working = false;
    transcript.push({
      seq: transcript.length + 1, role: 'platform' as const, text: 'Turn stopped by the user.', at: new Date().toISOString(),
    });
    return { ok: true as const, stopped: true, name: 'Felix' };
  },
} as unknown as RouteDeps['agentLifecycle'];

const deps = {
  userStorage,
  workspaceWebAuth,
  mailboxes: mailbox.mailboxes,
  workspaceWebOrigin: ORIGIN,
  workspaceUiDir: SHELL,
  workspaceUiDefault: 'react',
  agentLifecycle,
  gitRepoStorage,
  gitPullRequestStorage,
  knowledgeProposalStorage,
  mailApprovals: {
    get: async (_userId: string, id: string) => id === mailApproval.id ? mailApproval : null,
    getMany: async (_userId: string, ids: string[]) => new Map(ids.includes(mailApproval.id) ? [[mailApproval.id, mailApproval]] : []),
    decide: async (args: { id: string; decision: 'approve' | 'reject' }) => {
      if (args.id !== mailApproval.id) return null;
      mailApproval = {
        ...mailApproval,
        status: args.decision === 'approve' ? 'sent' : 'rejected',
        decidedAt: new Date().toISOString(),
        ...(args.decision === 'approve' ? { sentMessageId: 'mm_chat_fixture' } : {}),
      };
      return mailApproval;
    },
  } as never,
} as RouteDeps;

const app = express();
app.use(express.json());
// Where the signed URLs above point: the object store this fixture stands in
// for. Real bytes, because a picture the browser cannot decode proves nothing
// about a viewer whose whole job is to show one.
app.get('/fixtures/:name', (req, res) => {
  const picture = pictures[String(req.params.name)];
  if (picture) {
    const send = () => { res.type('image/png').send(picture); };
    if (picturesHeld) heldPictures.push(send); else setTimeout(send, PICTURE_DELAY_MS);
    return;
  }
  const document = documents[String(req.params.name)];
  // Inline, as a preview read is signed: a document served save-as is
  // downloaded by the browser rather than drawn in the frame, which is the
  // whole difference this harness is here to see.
  if (document) return res.type('application/pdf').set('Content-Disposition', 'inline').send(document);
  const html = pages[String(req.params.name)];
  if (html) {
    // Inline as a preview read is signed, and save-as when it is not: the
    // viewer's Download must hand the browser the bytes, not open a tab.
    const disposition = req.query.preview === '1' ? 'inline' : 'attachment; filename="calibration-review.html"';
    return res.type('text/html').set('Content-Disposition', disposition).send(html);
  }
  if (media[String(req.params.name)]) {
    // As the bucket serves it: in RANGES, which is how a player reads (and
    // the only way Safari will play one at all), inline for a preview and
    // save-as for the Download.
    return res.sendFile(path.join(REPO, 'scripts/fixtures', String(req.params.name)), {
      headers: { 'Content-Disposition': req.query.preview === '1' ? 'inline' : `attachment; filename="${req.params.name}"` },
    });
  }
  if (req.params.name === 'launch-plan.md') return res.type('text/markdown').set('Content-Disposition', 'attachment; filename="launch-plan.md"').send(LAUNCH_PLAN);
  return res.status(404).end();
});
app.use('/workspace/api/state', (_req, _res, next) => {
  if (stateDelayMs) setTimeout(next, stateDelayMs); else next();
});
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  // A HOVER-CAPABLE pointer, which headless Chrome does not report on its
  // own: with no input device attached it answers `(hover: none)`, so every
  // rule the app gates on `@media (hover: hover)` was invisible to every
  // check here — passing not because it was right but because it never
  // applied. `Emulation.setEmulatedMedia` will not do it, through puppeteer
  // or raw CDP; the launch flag is the only lever that moves it.
  // HOVER TYPES ONLY, and deliberately not the pointer ones the same flag
  // would take: `(pointer: coarse)` is what note #291's two windows turn on,
  // and `hasTouch` — the viewport's, further down — has to stay the one
  // thing that decides it.
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2'],
});
try {
  const page = await browser.newPage();
  // A phone by default, because that is what the Workspace is read on. The
  // chat is a viewport-tall SHELL now (note #278), so `VIEWPORT=1280x800`
  // is how the same run is watched at desktop width, where the reading
  // column is centred and the shell still has to end at the window's edge.
  await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`); });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `n256-slice3-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };
  /** The viewport alone: where the page STANDS, which a full-page shot cannot show. */
  const view = (name: string) => page.screenshot({ path: path.join(OUT, `n256-slice3-${name}.png`) as `${string}.png` });
  const text = (selector: string) => page.$eval(selector, (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '').catch(() => '');
  /** What a header item is actually PAINTED, beside the two theme colours it
   *  could be (note #323). The palette is read off `:root` and resolved
   *  through a probe rather than written down here, so this keeps meaning
   *  "the page's white" and not "#ffffff" the day either value moves — and so
   *  a FAIL names the colour it found instead of a hex nobody can place.
   *  The glyph is reported too: both drawings are `currentColor`, and that is
   *  only proven by the SVG computing to the same colour as its word. */
  const ink = async (selector: string) => await page.evaluate(
    "(() => { var node = document.querySelector(" + JSON.stringify(selector) + ");"
    + " if (!node) return null;"
    + " var root = getComputedStyle(document.documentElement);"
    + " var probe = document.createElement('span'); document.body.append(probe);"
    + " probe.style.color = root.getPropertyValue('--text').trim();"
    + " var white = getComputedStyle(probe).color;"
    + " probe.style.color = root.getPropertyValue('--accent').trim();"
    + " var accent = getComputedStyle(probe).color; probe.remove();"
    + " var svg = node.querySelector('svg');"
    + " return { color: getComputedStyle(node).color,"
    + " glyph: svg ? getComputedStyle(svg).color : '', white: white, accent: accent }; })()",
  ) as { color: string; glyph: string; white: string; accent: string } | null;
  /** What a control is painted while the POINTER is on it, and what it was
   *  painted before. Both, because "no surface" is only worth checking
   *  beside a fade that proves the control answered at all. The mouse is
   *  parked off the bar afterwards, so a hover left standing cannot colour
   *  a check further down. */
  const underPointer = async (selector: string) => {
    const paint = () => page.evaluate(
      "(() => { var seen = getComputedStyle(document.querySelector("
      + JSON.stringify(selector) + "));"
      + " return { background: seen.backgroundColor, opacity: seen.opacity }; })()",
    ) as Promise<{ background: string; opacity: string }>;
    await page.mouse.move(Math.round(viewport.width / 2), Math.round(viewport.height * 0.75));
    const resting = await paint();
    await page.hover(selector);
    const hovered = await paint();
    await page.mouse.move(Math.round(viewport.width / 2), Math.round(viewport.height * 0.75));
    return { resting, hovered };
  };
  /** Where the TRANSCRIPT stands against its end. The chat is a shell now
   *  (note #278): the page itself never scrolls, and the pane between the
   *  header and the composer is the only thing that does. */
  const scrolled = () => page.evaluate(() => {
    const pane = document.getElementById('agentChatScroll');
    if (!pane) return { y: -1, max: -1 };
    return { y: Math.round(pane.scrollTop), max: Math.round(pane.scrollHeight - pane.clientHeight) };
  });
  const settled = () => page.waitForFunction(
    () => {
      const pane = document.getElementById('agentChatScroll');
      return Boolean(pane) && Math.round(pane!.scrollTop) >= Math.round(pane!.scrollHeight - pane!.clientHeight) - 2;
    },
    { timeout: 5_000 },
  ).then(() => true, () => false);
  const atEnd = async (label: string) => {
    const ok = await settled();
    const place = await scrolled();
    check(label, ok && place.max > 300, JSON.stringify(place));
  };
  const texts = (selector: string) => page.$$eval(selector, (nodes) => nodes.map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''));

  // 1. Create access and seed one agent with everything the screen can say.
  await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  await page.goto(`${ORIGIN}/overview`, { waitUntil: 'networkidle0' });

  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: {
        felix: {
          id: 'felix', name: 'Felix', cli: 'claude', createdAt: iso(60 * 24 * 3), serverId: 'm1',
          connectedAt: iso(60 * 24 * 3), lastActivityAt: iso(5),
          model: 'opus', effort: 'high',
          recap: { text: 'Built the landing page and proposed #12 for the checkout flow.', at: iso(5) },
          tasks: [{ text: 'Ship the checkout page', at: iso(6) }],
          contextUsage: { tokens: 141_000, window: 200_000, at: iso(6) },
        },
        // The peer whose message sits in the transcript below (note #353).
        // A DIFFERENT runtime and a recap of its own, so the card its face
        // raises is provably about Oscar and not about the agent whose chat
        // this is. Used longer ago than Felix, so Home's top row — the one
        // this run clicks to get here — is still Felix.
        oscar: {
          id: 'oscar', name: 'Oscar', cli: 'claude', createdAt: iso(60 * 24 * 5), serverId: 'm2',
          connectedAt: iso(60 * 24 * 5), lastActivityAt: iso(30),
          model: 'fable', effort: 'medium',
          recap: { text: 'Rebased slice 4 on main and re-ran the checks.', at: iso(30) },
          tasks: [{ text: 'Rebase slice 4', at: iso(31) }],
        },
      } as never,
    },
  });

  // The work this agent has to show for itself, both kinds and mixed states:
  // a change that landed, a page that was published, and one of each still
  // waiting. Dated apart so the interleave has something to prove.
  const repo = await gitRepoStorage.create({
    userId: me.userId, name: 'infinite-agents', createdByAgentId: 'felix',
    defaultBranch: 'main', sizeBytes: 4096,
  } as never);
  const seedChange = async (over: Record<string, unknown>) => {
    const doc = await gitPullRequestStorage.create({
      repoId: repo.id, userId: me.userId, createdByUserId: me.userId, createdByAgentId: 'felix',
      sourceBranch: 'agent/checkout', targetBranch: 'main', headSha: 'b'.repeat(40),
      diffStat: { files: 9, insertions: 870, deletions: 20 },
      commitSubjects: ['Move the checkout to React'], status: 'open', ...over,
    } as never);
    await gitPullRequestStorage.update(doc.id, over as never);
  };
  const seedPage = async (over: Record<string, unknown>) => {
    const doc = await knowledgeProposalStorage.create({
      userId: me.userId, createdByUserId: me.userId, createdByAgentId: 'felix',
      changes: [{ page: 'deploys', action: 'edit', title: 'Deploys', html: '<p>x</p>' }],
      status: 'open', ...over,
    } as never);
    await knowledgeProposalStorage.update(doc.id, over as never);
  };
  await seedChange({ title: 'Move the checkout to React', status: 'open', createdAt: iso(60 * 3) });
  await seedChange({
    title: 'Give the landing page its own header', status: 'merged',
    sourceBranch: 'agent/header', createdAt: iso(60 * 30), decidedAt: iso(60 * 29),
  });
  await seedPage({
    title: 'Write down how a deploy reaches production', status: 'approved',
    changes: [{ page: 'how-a-change-reaches-production', action: 'create', title: 'Deploys', html: '<p>x</p>' }],
    createdAt: iso(60 * 10), decidedAt: iso(60 * 9),
  });
  await seedPage({
    title: 'Say what the checkout page assumes', status: 'open',
    changes: [{ page: 'checkout-notes', action: 'create', title: 'Checkout', html: '<p>y</p>' }],
    createdAt: iso(60),
  });

  // 2. The agent's own screen: its row on Home opens the conversation (note
  //    #573), and the conversation's name opens the agent.
  await page.goto(`${ORIGIN}/overview`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#agents .crow', { timeout: 10_000 });
  await page.click('#agents .crow');
  await page.waitForSelector('#agentChatTitle', { timeout: 10_000 });
  check('a row opens its agent’s conversation at the registered address (note #573)',
    page.url() === `${ORIGIN}/chat/felix`, page.url());
  await page.click('.chathead .chatnamedoor');
  await page.waitForSelector('#agentInfoTitle', { timeout: 10_000 });
  check('…and its name there opens the agent at the registered address', page.url() === `${ORIGIN}/agents/felix`, page.url());
  // The height of the shared navigation row, measured where every ordinary
  // screen draws it, so the chat's own bar can be held to the same one below
  // rather than to a number written twice (note #312).
  const navHeight = await page.evaluate(
    "Math.round(document.querySelector('#pageHead .pagenav').getBoundingClientRect().height)",
  ) as number;
  check('the shared navigation row is the 48px bar the stylesheet declares', navHeight === 48, String(navHeight));
  check('the shared header has no Home action', !(await page.$('#pageHome'))
    && !(await page.$('#pageHead [aria-label="Home"]')));
  check('the header names the agent and what it runs',
    (await text('#agentInfoTitle')) === 'Felix' && (await text('#agentInfoSub')).startsWith('Claude Code'),
    `${await text('#agentInfoTitle')} / ${await text('#agentInfoSub')}`);
  const headerRuntimeDoor = await page.$eval('#agentInfoSub', (node) => ({
    tag: node.tagName,
    label: node.getAttribute('aria-label'),
  }));
  check('the runtime in the agent header is the shared picker door',
    headerRuntimeDoor.tag === 'BUTTON'
    && headerRuntimeDoor.label?.startsWith('Choose model and effort.'));
  check('the recap leads, and the exact reply stands under it as Markdown',
    (await text('#agentInfoAbout')).startsWith('Built the landing page')
    && Boolean(await page.$('#agentInfoLastMessage .md.agentmessage strong')),
    await text('#agentInfoLast'));
  // The label carries the reply's AGE (note #558): the words alone cannot say
  // whether this is what the agent said ten minutes ago or last week, and
  // that is the first thing this screen is read for. The fixture's reply is
  // minutes old, so the shape is asserted rather than one exact number — the
  // harness itself takes a little while to get here.
  const replyLabel = await text('#agentInfoLast .agentlastlabel');
  check('the last reply says how long ago it was said',
    /^Last reply · \d+m ago$/.test(replyLabel), replyLabel);
  const agentReading = await page.evaluate(() => ({
    recap: getComputedStyle(document.getElementById('agentInfoAbout')!).fontSize,
    reply: getComputedStyle(document.getElementById('agentInfoLastMessage')!).fontSize,
    button: document.getElementById('agentChat')?.textContent?.trim() ?? '',
    icon: Boolean(document.querySelector('#agentChat .icon')),
    primaryRule: getComputedStyle(document.getElementById('agentChat')!, '::after').content,
  }));
  check('the recap and last reply both use the 14px reading step',
    agentReading.recap === '14px' && agentReading.reply === '14px', JSON.stringify(agentReading));
  check('the chat door matches proposal details: Open chat with a robot icon',
    agentReading.button === 'Open chat' && agentReading.icon, JSON.stringify(agentReading));
  check('the chat door has no generated hairline',
    agentReading.primaryRule === 'none', JSON.stringify(agentReading));
  // The door is the answer to the reply above it, so the smaller gap must be
  // the one toward that reply and not the one toward the facts card below
  // (note #519). Measured on ink, which is what a reader sees: the button's
  // own tap padding is invisible and would hide the difference.
  const doorGaps = await page.evaluate(() => {
    const ink = [...document.querySelectorAll('#agentChat span')]
      .map((node) => node.getBoundingClientRect());
    const top = Math.min(...ink.map((box) => box.top));
    const bottom = Math.max(...ink.map((box) => box.bottom));
    return {
      above: Math.round(top - document.getElementById('agentInfoLast')!.getBoundingClientRect().bottom),
      below: Math.round(document.getElementById('agentFacts')!.getBoundingClientRect().top - bottom),
    };
  });
  check('the chat door sits nearer the reply it answers than the facts under it',
    doorGaps.above < doorGaps.below, JSON.stringify(doorGaps));
  await page.waitForFunction(
    () => [...document.querySelectorAll('#agentFacts .drow .k')].some((node) => node.textContent === 'Machine'),
    { timeout: 10_000 },
  ).catch(() => {});
  const factKeys = await texts('#agentFacts .drow .k');
  check('the facts name the machine, the runtime and the site',
    ['Machine', 'Thinks with', 'Its site', 'Turns'].every((key) => factKeys.includes(key)), factKeys.join(','));
  const detailType = await page.evaluate(() => ({
    key: getComputedStyle(document.querySelector('#agentFacts .drow .k')!).fontSize,
    value: getComputedStyle(document.querySelector('#agentFacts .drow .v')!).fontSize,
    software: getComputedStyle(document.querySelector('#agentInfoCard .crow .name')!).fontSize,
    softwareMeta: getComputedStyle(document.querySelector('#agentInfoCard .crow .cline')!).fontSize,
  }));
  check('agent detail values step up while their labels stay compact',
    detailType.key === '12px' && detailType.value === '14px'
    && detailType.software === '14px' && detailType.softwareMeta === '13px',
    JSON.stringify(detailType));
  check('the machine row says what wakes a sleeping one',
    (await texts('#agentFacts .drow .v.dim')).some((line) => line.includes('It wakes on your next message')));
  check('the version card names the CLI and the instructions it was written',
    (await text('#agentInfoCard')).includes('1.2.3 → 1.3.0')
    && (await text('#agentInfoCard')).includes('v4 → v5 on its next turn'),
    await text('#agentInfoCard'));
  check('the context bar draws the reading, and the face wears the same one',
    Boolean(await page.$('.contextrow .meter.warn')) && Boolean(await page.$('#agentInfoHead .ctxring.warn')),
    await text('.contextrow .ctext'));
  check('a running turn locks the update actions and says why',
    (await page.$$eval('.busylock', (nodes) => nodes.every((node) => (node as HTMLButtonElement).disabled)))
    && !(await page.$eval('.busyhint', (node) => (node as HTMLElement).hidden)));
  await shot('agent');

  // 2b. The proposal history: one card, both kinds, newest first (note #276).
  await page.waitForSelector('#agentPrs .crow', { timeout: 10_000 });
  const history = await page.$$eval('#agentPrs .crow', (rows) => rows.map((row) => ({
    name: row.querySelector('.name')?.textContent?.trim() ?? '',
    state: row.querySelector('.prstate')?.textContent?.trim() ?? '',
    chip: row.querySelector('.bname')?.textContent?.trim() ?? '',
    // No name reaches the DOM for a glyph, so the drawing itself is the
    // identity: two kinds of row must not be leading with one picture.
    glyph: row.querySelector('.icon.ft svg')?.innerHTML ?? '',
    stat: row.querySelector('.stat')?.textContent?.trim() ?? '',
  })));
  check('both kinds of proposal stand in one history, newest first',
    history.map((row) => row.name).join(' | ')
      === 'Say what the checkout page assumes | Move the checkout to React'
      + ' | Write down how a deploy reaches production | Give the landing page its own header',
    history.map((row) => row.name).join(' | '));
  check('each kind keeps its own word for what became of it',
    history.map((row) => row.state).join(' | ')
      === 'Awaiting approval | Awaiting approval | Approved | Merged',
    history.map((row) => row.state).join(' | '));
  check('a change row names its repository and a page row names its page',
    history[1]!.chip === 'infinite-agents' && history[0]!.chip === 'checkout-notes',
    `${history[1]!.chip} / ${history[0]!.chip}`);
  check('the two kinds are told apart by the row itself, not by their place in it',
    history[0]!.glyph !== history[1]!.glyph
    && Boolean(history[1]!.stat) && !history[0]!.stat,
    `${history[1]!.stat || '(none)'} / ${history[0]!.stat || '(none)'}`);
  await shot('agent-proposals');

  // 2c. The header's own indicator (note #240): whether this agent is
  // working, on every line of a screen that is several screens long.
  const headBoxes = await page.evaluate(
    () => ['#pageHead .pagenav', '#pageBack', '#agentHeadState'].map((selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  );
  const [headBox, backBox, stateBox] = headBoxes;
  /** The indicator's classes, or '' when there is none — a missing element is
   *  a FAILED check here, never a crashed run. */
  const stateClass = () => page.$eval('#agentHeadState', (node) => node.className).catch(() => '');
  check('the header says the agent is working, in Home’s own words',
    (await text('#agentHeadState')) === 'Active' && (await stateClass()).includes('active'),
    `${await text('#agentHeadState')} / ${await stateClass()}`);
  check('…standing clear of Back in the row',
    Boolean(stateBox && backBox && headBox)
    && stateBox!.left > backBox!.right && stateBox!.right < headBox!.right,
    JSON.stringify(headBoxes));
  check('…centred on the row rather than leaned by their unequal widths',
    Boolean(stateBox && headBox)
    && Math.abs((stateBox!.left + stateBox!.right) / 2 - (headBox!.left + headBox!.right) / 2) <= 1,
    JSON.stringify([stateBox, headBox]));
  // Note #323: the bar frames the screen, so Back is the page's own white and
  // not the accent it used to wear — while the pill, the one item there that
  // is REPORTING rather than navigating, keeps it.
  const backInk = await ink('#pageBack');
  const stateInk = await ink('#agentHeadState');
  check('Back is the page’s own white, not a link’s blue',
    Boolean(backInk) && backInk!.color === backInk!.white && backInk!.glyph === backInk!.white,
    JSON.stringify(backInk));
  check('…while the state in the row keeps the accent, as its fleet row does',
    Boolean(stateInk) && stateInk!.color === stateInk!.accent,
    JSON.stringify(stateInk));
  // The whole point of putting it in the header: the facts card that spells
  // the same turn out is a screen and a half below, and this stays put.
  await page.mouse.wheel({ deltaY: 900 });
  await page.waitForFunction(() => window.scrollY > 200, { timeout: 5_000 });
  const stuck = await page.evaluate(() => {
    const node = document.getElementById('agentHeadState');
    if (!node) return { y: Math.round(window.scrollY), top: -1, bottom: -1, view: window.innerHeight };
    const box = node.getBoundingClientRect();
    return { y: Math.round(window.scrollY), top: Math.round(box.top), bottom: Math.round(box.bottom), view: window.innerHeight };
  });
  check('…and travels with the header down the whole screen',
    stuck.y > 200 && stuck.top >= 0 && stuck.bottom <= stuck.view, JSON.stringify(stuck));
  await view('agent-head-stuck');
  await page.evaluate(() => window.scrollTo(0, 0));
  await view('agent-head-active');
  // The turn ends under the reader, as it does in life: nothing is tapped,
  // and the live tick alone has to turn the indicator over.
  working = false;
  const wentIdle = await page.waitForFunction(
    () => document.getElementById('agentHeadState')?.textContent === 'Ready',
    { timeout: 15_000 },
  ).then(() => true, () => false);
  check('…and turns over on its own when that turn ends', wentIdle, await text('#agentHeadState'));
  check('…hollow rather than blue, so colour is not the only difference',
    (await stateClass()).includes('idle'), await stateClass());
  await view('agent-head-idle');
  // Back to the running turn the rest of this run is written against.
  working = true;
  await page.waitForFunction(
    () => document.getElementById('agentHeadState')?.textContent === 'Active',
    { timeout: 15_000 },
  ).catch(() => {});

  // 3. The runtime picker is a transient leaf: Back closes it, no new entry.
  const entriesBeforePicker = await page.evaluate(() => history.length);
  await page.click('#agentInfoSub');
  await page.waitForSelector('#agentRuntimeModels .crow', { timeout: 10_000 });
  check('the runtime line opens the shared picker', (await text('#agentRuntimeTitle')) === 'How Felix thinks');
  check('the current model is a state, not a no-op button',
    (await page.$eval('#agentRuntimeModels .crow.current', (node) => node.tagName)) === 'DIV');
  check('effort choices follow the selected model', (await texts('#agentRuntimeEfforts .effortstep')).length > 0);
  check('a leaf spends no history entry', (await page.evaluate(() => history.length)) === entriesBeforePicker);
  await shot('runtime-picker');
  await page.click('#pageBack');
  await page.waitForSelector('#agentInfoTitle', { timeout: 10_000 });
  check('Back closes the leaf onto the agent, not out of it', page.url() === `${ORIGIN}/agents/felix`, page.url());

  // 4. The conversation.
  await page.click('#agentChat');
  await page.waitForSelector('#agentChatTitle', { timeout: 10_000 });
  check('the chat opens at the registered address', page.url() === `${ORIGIN}/chat/felix`, page.url());
  check('it pins its own identity header and the persistent one steps aside',
    Boolean(await page.$('.chathead .back')) && !(await page.$('#pageHead')));
  check('the header names who is answering and with what',
    (await text('#agentChatTitle')) === 'Felix' && (await text('#agentChatStatus')).startsWith('Claude Code'));
  await page.waitForSelector('#agentChatJobs', { timeout: 10_000 });
  const jobStrip = await page.$eval('#agentChatJobs', (node) => {
    const strip = node as HTMLElement;
    return {
      text: strip.textContent?.trim(),
      label: strip.getAttribute('aria-label'),
      radius: parseFloat(getComputedStyle(strip).borderTopLeftRadius),
      height: strip.getBoundingClientRect().height,
      centred: (() => {
        const row = strip.parentElement!.getBoundingClientRect();
        const pill = strip.getBoundingClientRect();
        return Math.abs((pill.left + pill.right) / 2 - (row.left + row.right) / 2) <= 1
          && pill.width < row.width - 40;
      })(),
      dot: Boolean(strip.querySelector('.chatjobdot')),
      chevron: Boolean(strip.querySelector('svg')),
      commands: strip.querySelectorAll('.chatjob').length,
      beforePane: strip.parentElement?.nextElementSibling?.id === 'agentChatScroll',
      underHeader: strip.parentElement?.previousElementSibling?.classList.contains('chathead') ?? false,
    };
  });
  check('active background jobs collapse into one counted door under the header',
    jobStrip.text === '2 background jobs' && jobStrip.label === '2 background jobs. Open details'
    && jobStrip.dot && jobStrip.chevron && jobStrip.commands === 0
    && jobStrip.underHeader && jobStrip.beforePane,
    JSON.stringify(jobStrip));
  // Note #603: the door is a pill centred in its band, not a full-width line.
  check('the background-job door is a pill centred under the header',
    jobStrip.centred && jobStrip.radius >= jobStrip.height / 2,
    JSON.stringify(jobStrip));
  // ...floating on the page: its row draws no band and no divider of its own.
  const jobsRow = await page.$eval('#agentChatJobsRow', (node) => {
    const style = getComputedStyle(node);
    return { surface: style.backgroundColor, rule: style.borderBottomWidth };
  });
  check('the pill has no edge-to-edge band or divider behind it',
    ['rgba(0, 0, 0, 0)', 'transparent'].includes(jobsRow.surface) && jobsRow.rule === '0px',
    JSON.stringify(jobsRow));
  await view('chat-background-jobs');

  const jobsLine = await scrolled();
  await page.click('#agentChatJobs');
  await page.waitForSelector('#screenAgentJobs #agentJobsList', { timeout: 10_000 });
  check('the background-job door opens its registered detail address',
    page.url() === `${ORIGIN}/agents/felix/jobs`, page.url());
  const jobsBack = await page.$eval('#pageBack', (node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      text: node.textContent?.trim(), glyph: Boolean(node.querySelector('svg')),
      opacity: style.opacity, visibility: style.visibility,
      box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
    };
  });
  const jobsBackInk = await ink('#pageBack');
  check('the job detail screen keeps the shared Back control',
    jobsBack.text === 'Back' && jobsBack.glyph && jobsBack.opacity === '1'
    && jobsBack.visibility === 'visible' && jobsBack.box.top >= 0 && jobsBack.box.bottom <= viewport.height
    && jobsBackInk?.color === jobsBackInk?.white && jobsBackInk?.glyph === jobsBackInk?.white,
    JSON.stringify({ ...jobsBack, ink: jobsBackInk }));
  const jobDetails = await page.$$eval('#agentJobsList .jobdetail', (rows) => rows.map((row) => ({
    state: row.querySelector('.jobdetailstate')?.textContent?.trim() ?? '',
    command: row.querySelector('.jobcommand')?.textContent?.trim(),
    id: row.getAttribute('data-job-id'),
    runningFor: row.querySelector('.jobelapsed')?.textContent?.trim(),
    started: row.querySelector('time')?.getAttribute('datetime'),
  })));
  check('the detail screen names every running job with its complete safe description',
    jobDetails.length === 2
    && jobDetails.every((job) => job.state === '')
    && jobDetails[0]?.command === 'npm run build:workspace-ui'
    && jobDetails[0]?.id === 'j_111111111111111111111111'
    && jobDetails[1]?.command === 'node scripts/render-product-tour.mjs --mobile'
    && jobDetails[1]?.id === 'j_222222222222222222222222'
    && jobDetails.every((job) => /^\d+(?::\d\d){1,2}$/.test(job.runningFor ?? ''))
    && jobDetails.every((job) => Boolean(job.started)),
    JSON.stringify(jobDetails));
  await page.waitForFunction(() => window.scrollY === 0, { timeout: 5_000 }).catch(() => {});
  await view('background-jobs');
  await page.click('#pageBack');
  await page.waitForSelector('#screenAgentChat #agentChatJobs', { timeout: 10_000 });
  // The restore is an effect AFTER the screen is drawn, so the selector above
  // can resolve a frame before it: one read here caught the pane mid-restore
  // once in four quiet runs (the FAIL line printed 8454 of 8456 — already
  // within tolerance by the time the message was built). Wait for the line,
  // then judge; a restore that never comes still fails, five seconds later.
  await page.waitForFunction((y: number) => {
    const pane = document.getElementById('agentChatScroll');
    return Boolean(pane) && Math.abs(Math.round(pane!.scrollTop) - y) <= 2;
  }, { timeout: 5_000 }, jobsLine.y).catch(() => {});
  check('Back returns from job details to the same conversation line',
    Math.abs((await scrolled()).y - jobsLine.y) <= 2,
    `${JSON.stringify(await scrolled())} from ${JSON.stringify(jobsLine)}`);
  // Note #312: the chat's bar used to take its height from what was in it and
  // came out 61.5px, so its controls stood in a row a quarter taller than
  // everywhere else. The
  // hairline is the chat's own and is not counted on either side: `.pagenav`
  // has none, and it is `.pagehead` that closes the block below it.
  const chatBar = await page.evaluate(
    "(() => { var h = document.querySelector('.chathead'); var r = h.getBoundingClientRect();"
    + " return { row: Math.round(r.height - parseFloat(getComputedStyle(h).borderBottomWidth)),"
    + " back: Math.round(document.querySelector('.chathead .back').getBoundingClientRect().height),"
    + " fits: Array.from(h.children).every(function (kid) { return kid.getBoundingClientRect().height <= r.height; }) }; })()",
  ) as { row: number; back: number; fits: boolean };
  check('…in the same 48px row every other screen gives Back',
    chatBar.row === navHeight, JSON.stringify({ ...chatBar, navHeight }));
  check('…which its face, name and runtime line fit inside rather than stretch',
    chatBar.fits, JSON.stringify(chatBar));
  check('…and Back keeps a thumb-sized target inside that row',
    chatBar.back >= 36, String(chatBar.back));
  check('…and the chat header has no Home action', !(await page.$('#chatHome'))
    && !(await page.$('.chathead [aria-label="Home"]')));
  // The chat's Back is painted the same as the shared bar's, for the same
  // reason the geometry is shared.
  const chatBackInk = await ink('.chathead .back');
  check('…and the chat’s own bar paints it that same white',
    Boolean(chatBackInk) && chatBackInk!.color === chatBackInk!.white,
    JSON.stringify(chatBackInk));
  // Note #388. A cursor crossing one of these must not turn it into a button:
  // the fill it used to take under the pointer is the one a ghost BUTTON
  // wears, and on a bare word in a pinned bar it read as the loudest thing
  // there. What answers now is the fade the app already presses with, which
  // is checked TOO — a surface removed and nothing put back would pass a test
  // that only looked for the absence.
  check('the pointer is a desk’s here, so a hover rule is a rule this run can see',
    await page.evaluate(() => matchMedia('(hover: hover)').matches));
  const backPointer = await underPointer('.chathead .back');
  const bare = (paint: { background: string }) => /rgba\(0, 0, 0, 0\)|transparent/.test(paint.background);
  check('…and Back grows no surface under the pointer',
    bare(backPointer.hovered), JSON.stringify(backPointer.hovered));
  check('…answering with the app’s own fade instead, off a word at full strength',
    backPointer.resting.opacity === '1' && Number(backPointer.hovered.opacity) < 1,
    JSON.stringify(backPointer));
  await page.waitForFunction(() => document.querySelectorAll('#agentChatLog .chatmsg').length >= 45, { timeout: 10_000 }).catch(() => {});
  await atEnd('the chat opens at its newest message, not its first');
  await view('chat-open');
  check('the page gives its own scroll up to the conversation',
    await page.evaluate(() => document.body.classList.contains('agent-chat-open')
      && getComputedStyle(document.body).overflowY === 'hidden'
      && Math.abs(document.body.getBoundingClientRect().height - window.innerHeight) <= 1
      && document.documentElement.scrollHeight <= window.innerHeight + 1));
  const classes = await page.$$eval('#agentChatLog .chatmsg', (nodes) => nodes.map((node) => node.className));
  check('each role gets its own shape', classes.some((name) => name.includes('owner'))
    && classes.some((name) => name.includes('agent'))
    && classes.some((name) => name.includes('peer'))
    && classes.some((name) => name.includes('platform')), classes.join(' | '));
  const mailCard = await page.$('[data-mail-approval="ma_chat_fixture"]');
  check('an agent email ask is the full decision inside the chat', Boolean(mailCard)
    && (await text('[data-mail-approval="ma_chat_fixture"]')).includes('Felix wants to send this message')
    && (await text('[data-mail-approval="ma_chat_fixture"]')).includes('Ada Lovelace <ada@example.com>')
    && (await text('[data-mail-approval="ma_chat_fixture"]')).includes('Tuesday’s launch')
    && (await text('[data-mail-approval="ma_chat_fixture"]')).includes('The launch is ready for Tuesday at four.')
    && (await texts('[data-mail-approval="ma_chat_fixture"] button')).join(' | ') === 'Send email | Don’t send',
    await text('[data-mail-approval="ma_chat_fixture"]'));
  check('the email decision has no door to a separate page',
    (await page.$$('[data-mail-approval="ma_chat_fixture"] a')).length === 0);
  await page.$eval('[data-mail-approval="ma_chat_fixture"]', (node) => node.scrollIntoView({ block: 'center' }));
  await view('mail-approval');
  await page.click('[data-mail-approval="ma_chat_fixture"] .btn.danger');
  await page.waitForFunction(() => document.querySelector('[data-mail-approval="ma_chat_fixture"]')?.textContent?.includes('Nothing was sent.'), { timeout: 5_000 });
  check('Don’t send closes the decision in place',
    (await text('[data-mail-approval="ma_chat_fixture"]')).includes('Not sent')
    && (await page.$$('[data-mail-approval="ma_chat_fixture"] button')).length === 0);
  check('the owner’s words are preserved exactly as typed',
    (await text('#agentChatLog .chatmsg.owner')) === 'Ship the checkout page, **exactly** as typed.');
  // Notes #263/#284. The reader's own sentence keeps every character and
  // gains a door; the agent's reply links the same way; and the number that
  // belongs to a PROPOSAL is left as the ink it is.
  check('a note named in the words is a link, wherever the words came from',
    (await page.$$eval('#agentChatLog a.noteref', (nodes) => nodes.map((node) => node.textContent)))
      .join(' | ') === 'note #284 | note #284 | note #263 | note #262 | note #284');
  check('…and the reader’s own sentence still reads exactly as they typed it',
    (await page.$eval('#agentChatLog a.noteref', (node) => node.closest('.chatmsg')!.textContent))
      === 'then pick up the note #284');
  check('a proposal’s number is not turned into a note',
    (await page.$$eval('#agentChatLog a.noteref', (nodes) => nodes.map((node) => node.getAttribute('href'))))
      .every((href) => !String(href).includes('/560')));
  // Note #394. A reset is a boundary the reader asked for, and it already has
  // a rule drawn across the column — so the receipt under it is that rule's
  // quiet CAPTION, not a bordered card with an icon tile, an uppercase eyebrow
  // and the transcript's boldest line. The door survives as the anchor inside
  // its one sentence, which is the same door a note gets in any other message.
  // jsdom can assert the class; only a browser can say whether the pair reads
  // as ONE boundary, and whether the rule above it is still one line.
  const boundary = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#agentChatLog .chatmsg')];
    const said = rows.filter((node) => (node.textContent || '').startsWith('Picking up'));
    const at = rows.indexOf(said[0]!);
    if (said.length !== 2 || at < 1) return null;
    const rule = rows[at - 1]!;
    const caption = rows[at]!;
    const after = rows[at + 1]!;
    const ruleBox = rule.getBoundingClientRect();
    const captionBox = caption.getBoundingClientRect();
    const ruled = getComputedStyle(rule);
    const quiet = getComputedStyle(caption);
    const bubble = getComputedStyle(rows.find((node) => node.className.includes('chatmsg agent'))!);
    return {
      words: said.map((node) => node.textContent),
      // No card left around either wording: no border, no surface, no tile.
      cards: said.filter((node) => node.querySelector('.chatnotice')).length,
      quietRows: said.filter((node) => node.className.includes('chatquiet')).length,
      buttons: said.filter((node) => node.tagName === 'BUTTON').length,
      border: quiet.borderTopWidth,
      surface: quiet.backgroundColor,
      // Quieter than the words around it, in the day rail's grey.
      size: parseFloat(quiet.fontSize), bubbleSize: parseFloat(bubble.fontSize),
      // `--hint` resolved through a probe, not compared raw: the variable is
      // a hex and a computed colour is `rgb(...)`, so the two never match as
      // written — and the point is that this line is painted the day rail's
      // grey whatever value that grey moves to.
      ink: quiet.color,
      hint: (() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--hint').trim();
        const grey = getComputedStyle(probe).color;
        probe.remove();
        return grey;
      })(),
      // …and standing WITH the rule: closer to it than to the message below.
      toRule: captionBox.top - ruleBox.bottom,
      toNext: after.getBoundingClientRect().top - captionBox.bottom,
      // The rule is two hairlines and its words since note #725 (thirty
      // box-drawing characters before, wider than the bubble cap on iOS) —
      // and it is cut rather than folded whatever the font: the contract that
      // saves the phone is the CSS. One rect per line box of the WORDS, which
      // is the only honest count: the element's own box is a rect too.
      ruleLines: (() => {
        const words = document.createRange();
        const text = [...rule.querySelectorAll('*'), rule].flatMap((node) => [...node.childNodes]).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
        if (!text) return 0;
        words.selectNodeContents(text);
        return words.getClientRects().length;
      })(),
      ruleWraps: ruled.whiteSpace !== 'nowrap' || ruled.overflowX !== 'hidden',
    };
  });
  check('a fresh chat is said quietly, in both its wordings',
    boundary !== null && boundary.words.join(' | ') === 'Picking up note #284 | Picking up saved work'
    && boundary.quietRows === 2 && boundary.cards === 0 && boundary.buttons === 0,
    JSON.stringify(boundary));
  check('…with no card, no surface and no border left around it',
    Boolean(boundary) && boundary!.border === '0px'
    && ['rgba(0, 0, 0, 0)', 'transparent'].includes(boundary!.surface),
    JSON.stringify(boundary && { border: boundary.border, surface: boundary.surface }));
  check('…in the day rail’s grey, under the size the messages are spoken in',
    Boolean(boundary) && boundary!.ink === boundary!.hint && boundary!.size < boundary!.bubbleSize,
    JSON.stringify(boundary && { ink: boundary.ink, hint: boundary.hint, size: boundary.size, bubble: boundary.bubbleSize }));
  check('…standing with the reset rule, which stays one line',
    Boolean(boundary) && boundary!.toRule < boundary!.toNext && boundary!.ruleLines === 1
    && !boundary!.ruleWraps,
    JSON.stringify(boundary && { toRule: boundary.toRule, toNext: boundary.toNext, ruleLines: boundary.ruleLines, ruleWraps: boundary.ruleWraps }));
  // The number it names is still the door — an anchor in the sentence now,
  // because a quiet line has no room for a card's own verb.
  const noteDoor = await page.$$eval('#agentChatLog .chatmsg.chatquiet a.noteref',
    (nodes) => nodes.map((node) => `${node.textContent} → ${node.getAttribute('href')}`));
  check('the receipt that picked a note up is a door to that note',
    noteDoor.length === 1 && noteDoor[0]!.startsWith('note #284 → ') && noteDoor[0]!.includes('/notes/284'),
    noteDoor.join(' | '));
  // The picture that shows it: the boundary among the rows it stands between,
  // which is the only place "too heavy" was ever readable.
  await page.evaluate(() => document.querySelectorAll('#agentChatLog .chatmsg.newchatdivider')[0]!
    .scrollIntoView({ block: 'center' }));
  await view('chat-fresh-chat');
  check('an agent’s reply is drawn as Markdown, built rather than poured',
    Boolean(await page.$('#agentChatLog .chatmsg.agent .chatmarkdown h2'))
    && Boolean(await page.$('#agentChatLog .chatmsg.agent .chatmarkdown pre code'))
    && Boolean(await page.$('#agentChatLog .chatmsg.agent .chatmarkdown li')));
  check('a link out of a message carries no opener',
    (await page.$eval('#agentChatLog .chatmarkdown a', (node) => node.getAttribute('rel'))) === 'noopener noreferrer');
  check('a peer is a third person speaking, not a receipt',
    Boolean(await page.$('#agentChatLog .chatmsg.peer .chatfrom'))
    && !(await page.$('#agentChatLog .chatmsg.peer .chatnotice')));
  // Note #339. The speaker's name is the page's own white. It was the accent
  // until now, and blue means ONE thing across this app — something to tap —
  // so a name that is not a link wearing it read as a link that does
  // nothing. jsdom cannot see this: it has no stylesheet, so the class is
  // all it can assert. The probe resolves the palette off `:root`, like the
  // header check above, so it keeps meaning "the page's white" if the value
  // ever moves.
  const peerInk = await ink('#agentChatLog .chatmsg.peer .chatfrom');
  check('…and its name is painted the page’s white, not the accent',
    Boolean(peerInk) && peerInk!.color === peerInk!.white && peerInk!.color !== peerInk!.accent,
    JSON.stringify(peerInk));
  // The picture that shows it: the peer bubble in place among the rows
  // around it, since the name only reads as wrong beside the words it tops.
  await page.evaluate(() => document.querySelector('#agentChatLog .chatmsg.peer')!
    .scrollIntoView({ block: 'center' }));
  await view('chat-peer-name');

  // Note #507 gave EVERY peer a face, the Workspace Agent included. Note
  // #715 took the face off the Chief of Staff wherever a person reads it:
  // its row is named "Chief of Staff" and drawn bare, though the backend
  // still sends its reserved dog — so this check is inverted for that one
  // row, while every other peer must still wear its own. Asked of the
  // rendered rows rather than of the payload, because what matters is what
  // the reader SEES.
  const peerFaces = await page.$$eval('#agentChatLog .chatmsg.peer .chatfrom', (rows) => rows.map((row) => ({
    from: (row.textContent ?? '').trim(),
    face: row.querySelector('img.face')?.getAttribute('src') ?? '',
  })));
  check('every peer in the transcript but the Chief of Staff wears a face',
    peerFaces.length >= 2 && peerFaces.filter((peer) => peer.from !== 'Chief of Staff').every((peer) => peer.face !== ''),
    JSON.stringify(peerFaces));
  check('…and the Chief of Staff’s message is named so and drawn with no face (note #715)',
    peerFaces.some((peer) => peer.from === 'Chief of Staff' && peer.face === '')
    && !peerFaces.some((peer) => peer.from === 'Workspace Agent'),
    JSON.stringify(peerFaces));
  await page.evaluate(() => [...document.querySelectorAll('#agentChatLog .chatmsg.peer .chatfrom span')]
    .find((name) => name.textContent === 'Chief of Staff')?.closest('.chatmsg')
    ?.scrollIntoView({ block: 'center' }));
  await view('chat-chief-of-staff-no-face');

  // Note #353. That face is the only thing the transcript says about the
  // agent that spoke, and a pointer can ask for the rest of it — the same
  // card the decision queue raises, and the card is the reason the fleet is
  // asked WHICH agent this name belongs to at all. Everything here is
  // Chrome's to answer: jsdom has no pointer, no stylesheet and no hit
  // testing, so the raised card, the target around a 16px picture and the
  // click landing on the door rather than on the box that raises the card
  // are all invisible to the unit tests beside it.
  check('nothing is raised until a pointer arrives', !(await page.$('.agentcard')));
  await page.hover('#agentChatLog .chatmsg.peer .chatfrom .facehover');
  const peerCard = await page.waitForSelector('.agentcard', { timeout: 5_000 })
    .then(() => true, () => false);
  check('hovering a peer’s face raises the agent that sent the message', peerCard);
  check('…named, with ITS runtime, its state and what it last did — not this chat’s agent',
    (await text('.agentcard .name')) === 'Oscar'
    && (await text('.agentcard .cruntime')) === 'Claude Code · fable · medium'
    && (await text('.agentcard .statetext')) === 'Ready'
    && (await text('.agentcard .cabout')) === 'Rebased slice 4 on main and re-ran the checks.',
    [await text('.agentcard .name'), await text('.agentcard .cruntime'),
      await text('.agentcard .statetext'), await text('.agentcard .cabout')].join(' | '));
  check('…floating over the transcript, inside the window, catching nothing',
    await page.evaluate(() => {
      const card = document.querySelector('.agentcard');
      const face = document.querySelector('#agentChatLog .chatmsg.peer .chatfrom .facehover');
      if (!card || !face) return 'no card';
      const box = card.getBoundingClientRect();
      const on = face.getBoundingClientRect();
      const style = getComputedStyle(card);
      return [
        `position=${style.position}`,
        `pointer-events=${style.pointerEvents}`,
        `clear=${box.bottom <= on.top || box.top >= on.bottom}`,
        `inside=${box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight}`,
      ].join(' ');
    }) === 'position=fixed pointer-events=none clear=true inside=true',
    String(await page.evaluate(() => {
      const card = document.querySelector('.agentcard');
      return card ? JSON.stringify(card.getBoundingClientRect()) : 'no card';
    })));
  await view('chat-peer-card');
  await page.mouse.move(2, 2);
  check('…and it goes when the pointer does',
    await page.waitForFunction(() => !document.querySelector('.agentcard'), { timeout: 5_000 })
      .then(() => true, () => false));

  // The other half: the face is the way TO that agent. The name beside it
  // stays words — note #339 took the affordance off it on purpose.
  const peerDoor = await page.$eval('#agentChatLog .chatmsg.peer .chatfrom a.facebtn', (node) => ({
    href: node.getAttribute('href'),
    label: node.getAttribute('aria-label'),
    wraps: Boolean(node.querySelector('img.face')),
  })).catch(() => null);
  check('a peer’s face is a door onto that agent, at the registered address',
    peerDoor?.href === '/agents/oscar' && peerDoor.label === 'Open Oscar' && peerDoor.wraps === true,
    JSON.stringify(peerDoor));
  check('…and the name beside it is still text, not a second door',
    await page.$eval('#agentChatLog .chatmsg.peer .chatfrom > span', (node) => node.tagName === 'SPAN' && !node.closest('a')));
  // A 16px picture is nothing to aim at, so the target grows around it —
  // sideways, because the next line down is the message and a link inside
  // those words must still take its own taps. Asked of the browser the way a
  // thumb asks: what is under this point?
  check('…on a target bigger than the picture, that does not reach into the words',
    await page.evaluate(() => {
      const link = document.querySelector('#agentChatLog .chatmsg.peer .chatfrom a.facebtn') as HTMLElement;
      const words = document.querySelector('#agentChatLog .chatmsg.peer .chatmarkdown') as HTMLElement;
      if (!link || !words) return 'nothing to measure';
      const box = link.getBoundingClientRect();
      const line = words.getBoundingClientRect();
      // Anonymous arrows only: a named function inside `evaluate` is compiled
      // with esbuild's `__name` helper, which does not exist in the page.
      const hits = [
        [box.left - 4, box.top + box.height / 2],
        [box.left + box.width / 2, box.top - 4],
        [line.left + 4, line.top + 4],
      ].map((point) => link.contains(document.elementFromPoint(point[0]!, point[1]!)));
      return `grown=${hits[0] && hits[1]} words=${hits[2]}`;
    }) === 'grown=true words=false');
  // And it really opens: a click where a reader would put one, through the
  // hover box that stands over this picture to raise the card.
  await page.click('#agentChatLog .chatmsg.peer .chatfrom a.facebtn');
  await page.waitForSelector('#agentInfoTitle', { timeout: 10_000 }).catch(() => {});
  check('tapping it opens that agent’s own screen',
    page.url() === `${ORIGIN}/agents/oscar` && (await text('#agentInfoTitle')) === 'Oscar',
    `${page.url()} / ${await text('#agentInfoTitle')}`);
  await view('chat-peer-agent');
  await page.goBack();
  await page.waitForSelector('#agentChatScroll', { timeout: 10_000 });

  // Put the transcript back where the checks after this one expect to find
  // it. `settled()` swallows its own timeout, so a pane left mid-transcript
  // would not fail here — it would fail something further down, wearing
  // somebody else's name.
  await page.evaluate(() => {
    const pane = document.getElementById('agentChatScroll')!;
    pane.scrollTop = pane.scrollHeight;
  });
  await settled();
  const door = await page.$('#agentChatLog button.chatmsg.platform');
  check('a receipt that names a proposal is a real button with a named door',
    Boolean(door) && (await door!.evaluate((node) => node.getAttribute('aria-label')))?.startsWith('Review and decide') === true);
  check('the counts in that card are painted, not left grey',
    Boolean(await page.$('#agentChatLog .chatnoticedetail .plus')) && Boolean(await page.$('#agentChatLog .chatnoticedetail .minus')));
  const knowledgeReceipts = await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>('#agentChatLog .chatmsg.platform.knowledge')];
    const statuses = cards.map((card) => card.querySelector<HTMLElement>('.chatnoticestatus'));
    // Anonymous callback only: tsx gives a declared helper an esbuild
    // `__name()` call, and the browser page does not carry that build helper.
    const palette = ['--accent', '--ok', '--danger'].map((name) => {
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    const change = document.querySelector<HTMLElement>('#agentChatLog .chatmsg.platform:not(.knowledge)')!;
    const knowledgeStyle = cards[0] ? getComputedStyle(cards[0]) : null;
    const changeStyle = getComputedStyle(change);
    return {
      words: statuses.map((status) => status?.textContent ?? ''),
      classes: statuses.map((status) => status?.className ?? ''),
      badges: cards.filter((card) => card.querySelector('.badge')).length,
      plain: statuses.every((status) => {
        if (!status) return false;
        const style = getComputedStyle(status);
        return ['rgba(0, 0, 0, 0)', 'transparent'].includes(style.backgroundColor)
          && parseFloat(style.paddingLeft) === 0 && parseFloat(style.paddingRight) === 0
          && parseFloat(style.borderTopLeftRadius) === 0;
      }),
      inks: statuses.map((status) => status ? getComputedStyle(status).color : ''),
      accent: palette[0], ok: palette[1], danger: palette[2],
      knowledgePadding: knowledgeStyle ? parseFloat(knowledgeStyle.paddingTop) : -1,
      changePadding: parseFloat(changeStyle.paddingTop),
      knowledgeIcons: cards.filter((card) => card.querySelector('.chatnoticeicon')).length,
      changeIcon: Boolean(change.querySelector('.chatnoticeicon')),
    };
  });
  check('knowledge proposal states are plain words rather than badge UI',
    knowledgeReceipts.words.join(' | ') === 'Awaiting approval | Live | Rejected'
    && knowledgeReceipts.badges === 0 && knowledgeReceipts.plain,
    JSON.stringify(knowledgeReceipts));
  check('…with approval blue, Live green and Rejected red',
    knowledgeReceipts.inks[0] === knowledgeReceipts.accent
    && knowledgeReceipts.inks[1] === knowledgeReceipts.ok
    && knowledgeReceipts.inks[2] === knowledgeReceipts.danger,
    JSON.stringify({ inks: knowledgeReceipts.inks, accent: knowledgeReceipts.accent, ok: knowledgeReceipts.ok, danger: knowledgeReceipts.danger }));
  check('change and knowledge proposal receipts have no icon tiles',
    knowledgeReceipts.knowledgeIcons === 0 && !knowledgeReceipts.changeIcon,
    JSON.stringify(knowledgeReceipts));
  check('…on a tighter receipt than the change proposal beside it',
    knowledgeReceipts.knowledgePadding < knowledgeReceipts.changePadding,
    JSON.stringify(knowledgeReceipts));
  await page.evaluate(() => document.querySelector('#agentChatLog button.chatmsg.platform:not(.knowledge)')!
    .scrollIntoView({ block: 'center' }));
  await view('chat-change-proposal');
  await page.evaluate(() => document.querySelector('#agentChatLog .chatmsg.platform.knowledge:last-of-type')!
    .scrollIntoView({ block: 'center' }));
  await view('chat-knowledge-proposals');
  const genericReceipt = await page.evaluate(() => {
    const title = [...document.querySelectorAll<HTMLElement>('#agentChatLog .chatnoticetitle')]
      .find((node) => node.textContent?.includes('Sent to Alex: Handing you note #423 "Workspace Agent: follow-ups".'));
    const card = title?.closest<HTMLElement>('.chatmsg.platform');
    const body = card?.querySelector<HTMLElement>('.chatnoticebody');
    const time = card?.querySelector<HTMLElement>('.chatnoticetime');
    if (!card || !body || !time) return null;
    card.scrollIntoView({ block: 'center' });
    const cardBox = card.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    return {
      icon: Boolean(card.querySelector('.chatnoticeicon')),
      label: card.querySelector('.chatnoticelabel')?.textContent ?? '',
      emptyHead: Boolean(card.querySelector('.chatnoticehead')),
      timeInTitle: time.parentElement === title,
      words: card.textContent ?? '',
      leftInset: bodyBox.left - cardBox.left,
      rightInset: cardBox.right - timeBox.right,
      topGap: timeBox.top - titleBox.top,
    };
  });
  check('a generic receipt has no robot tile or Platform eyebrow',
    Boolean(genericReceipt) && !genericReceipt!.icon && genericReceipt!.label === ''
    && !genericReceipt!.words.includes('Platform'), JSON.stringify(genericReceipt));
  // 13, not the card's old 11: since "Three voices in the chat, drawn as
  // three things" (0581b514, 2026-09-11) a generic receipt is an ASIDE — a
  // 2px rule down the left and 11px of padding off it, rather than a bordered
  // card — and this harness has not been able to say so, because signup broke
  // the same day. What the number is still holding is the thing worth
  // holding: an icon tile would put the words 40px in, not 13.
  check('…and its words reclaim the left edge while the time stays right',
    Boolean(genericReceipt) && genericReceipt!.leftInset <= 13 && genericReceipt!.rightInset <= 12,
    JSON.stringify(genericReceipt));
  check('…without leaving an empty row above the title',
    Boolean(genericReceipt) && !genericReceipt!.emptyHead && genericReceipt!.timeInTitle
    && genericReceipt!.topGap >= 0 && genericReceipt!.topGap <= 4,
    JSON.stringify(genericReceipt));
  await view('chat-generic-receipt');
  await page.evaluate(() => {
    const pane = document.getElementById('agentChatScroll')!;
    pane.scrollTop = pane.scrollHeight;
  });
  check('the typing bubble carries the newest tool line',
    !(await page.$eval('#agentChatLive', (node) => (node as HTMLElement).hidden))
    && (await text('#agentChatActivity')) === 'Bash: npm run build');
  // Note #278: the header and the composer are the shell's furniture, and
  // the transcript is the one thing that moves between them.
  check('the header, jobs and composer stand outside the one scroller',
    await page.evaluate(() => {
      const pane = document.getElementById('agentChatScroll')!;
      return pane.contains(document.getElementById('agentChatLog'))
        && !pane.contains(document.querySelector('.chathead'))
        && !pane.contains(document.getElementById('agentChatJobs'))
        && !pane.contains(document.getElementById('agentChatForm'));
    }));
  check('the four of them fill the viewport exactly, with nothing over anything',
    await page.evaluate(() => {
      const head = document.querySelector('.chathead')!.getBoundingClientRect();
      const jobs = document.getElementById('agentChatJobsRow')!.getBoundingClientRect();
      const pane = document.getElementById('agentChatScroll')!.getBoundingClientRect();
      const bar = document.getElementById('agentChatForm')!.getBoundingClientRect();
      return Math.round(head.top) === 0 && Math.abs(jobs.top - head.bottom) <= 1
        && Math.abs(pane.top - jobs.bottom) <= 1
        && Math.abs(bar.top - pane.bottom) <= 1 && Math.abs(bar.bottom - window.innerHeight) <= 1;
    }),
    JSON.stringify(await page.evaluate(() => ({
      head: document.querySelector('.chathead')!.getBoundingClientRect().toJSON(),
      jobs: document.getElementById('agentChatJobsRow')!.getBoundingClientRect().toJSON(),
      pane: document.getElementById('agentChatScroll')!.getBoundingClientRect().toJSON(),
      bar: document.getElementById('agentChatForm')!.getBoundingClientRect().toJSON(),
      inner: window.innerHeight,
    }))));
  check('the header stays put while the transcript moves under it',
    await page.evaluate(() => {
      const pane = document.getElementById('agentChatScroll')!;
      const before = document.querySelector('.chathead')!.getBoundingClientRect().top;
      pane.scrollTop = 0;
      const top = document.querySelector('.chathead')!.getBoundingClientRect().top;
      pane.scrollTop = pane.scrollHeight;
      return Math.round(before) === 0 && Math.round(top) === 0
        && Math.round(document.querySelector('.chathead')!.getBoundingClientRect().top) === 0;
    }));
  // Note #547: on a DESK the transcript moves from anywhere in the window.
  // The frame from `body` down is `overflow: hidden` while a chat is up, so
  // the pane is the only scroller — and at 1280px it stood 752px wide in the
  // middle of the window, which left a wheel turned over either gutter with
  // nothing to move. The pane now spans the window and the column moves
  // inside it. Only a real browser can put a pointer over a gutter, turn a
  // wheel and see what moved; jsdom has neither a gutter nor a wheel.
  {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.evaluate(() => {
      const pane = document.getElementById('agentChatScroll')!;
      pane.scrollTop = pane.scrollHeight;
    });
    const desk = await page.evaluate(() => {
      const pane = document.getElementById('agentChatScroll')!;
      const paneBox = pane.getBoundingClientRect();
      const head = document.querySelector<HTMLElement>('.chathead')!;
      const headBox = head.getBoundingClientRect();
      const log = document.getElementById('agentChatLog')!.getBoundingClientRect();
      const bar = document.getElementById('agentChatForm')!.getBoundingClientRect();
      const row = document.querySelector('#agentChatForm .row')!.getBoundingClientRect();
      return {
        inner: window.innerWidth,
        pane: { left: paneBox.left, right: paneBox.right, scrollTop: pane.scrollTop, scrollbar: pane.offsetWidth - pane.clientWidth },
        head: { left: headBox.left, right: headBox.right, words: headBox.left + parseFloat(getComputedStyle(head).paddingLeft) },
        log: { left: log.left, width: log.width },
        bar: { left: bar.left, right: bar.right, rowCentre: row.left + row.width / 2, rowWidth: row.width },
      };
    });
    const edgeToEdge = (box: { left: number; right: number }) => Math.round(box.left) === 0 && Math.abs(box.right - desk.inner) <= 1;
    check('at a desk the transcript’s scroller is the width of the window',
      edgeToEdge(desk.pane), JSON.stringify(desk));
    check('…and so are the header and the composer around it',
      edgeToEdge(desk.head) && edgeToEdge(desk.bar), JSON.stringify(desk));
    check('…while the conversation still reads down the centred 720px column',
      Math.abs(desk.log.width + desk.pane.scrollbar - 720) <= 1 && Math.abs(desk.log.left - (desk.inner - 720) / 2) <= 1,
      JSON.stringify(desk));
    check('…with the header’s words and the compose row on that same column',
      Math.abs(desk.head.words - desk.log.left) <= 1 && Math.abs(desk.bar.rowCentre - desk.inner / 2) <= 1 && desk.bar.rowWidth === 640,
      JSON.stringify(desk));
    // The pointer over the LEFT GUTTER, 220px short of where the column
    // starts, and a wheel turned toward the top of the conversation.
    await page.mouse.move(60, 400);
    await page.mouse.wheel({ deltaY: -600 });
    const moved = await page.waitForFunction(
      (from: number) => document.getElementById('agentChatScroll')!.scrollTop < from - 100,
      { timeout: 3_000 }, desk.pane.scrollTop,
    ).then(() => true, () => false);
    check('a wheel turned with the pointer over the gutter moves the transcript',
      moved, `${desk.pane.scrollTop} → ${await page.evaluate(() => document.getElementById('agentChatScroll')!.scrollTop)}`);
    await view('chat-desk');
    await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.evaluate(() => {
      const pane = document.getElementById('agentChatScroll')!;
      pane.scrollTop = pane.scrollHeight;
    });
    await settled();
  }
  await shot('chat');
  // The mentions, in the one place they were asked for (notes #263/#284):
  // the reader's own message, an agent's reply and the receipt, together on
  // one screen. The pane is put back at the end afterwards, because
  // everything below reads where the conversation was left.
  await page.evaluate(() => {
    const pane = document.getElementById('agentChatScroll')!;
    const row = document.querySelector('#agentChatLog a.noteref')!.closest('.chatmsg')!;
    pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - 14;
  });
  await view('chat-note-links');
  await page.evaluate(() => {
    const pane = document.getElementById('agentChatScroll')!;
    pane.scrollTop = pane.scrollHeight;
  });

  // 4a. A picture in the transcript opens FULL SCREEN, in the same viewer a
  //     note, a proposal and a repository file open theirs (note #294). Only
  //     a real browser can say whether it covers the chat's own shell — this
  //     screen is the one that pins a header and a composer of its own, and
  //     a viewer that opened underneath either of them would be worse than
  //     the new tab it replaces.
  // The pictures are framed before their bytes land (note #302); what a tap
  // does depends on whether they HAVE landed, so the rows are read once they
  // have.
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLImageElement>('#agentChatLog .chatfileitem img')]
      .filter((img) => img.complete && img.naturalWidth > 0).length === 2,
    { timeout: 10_000 },
  ).catch(() => {});
  // The page's row says "full screen" once its preview link is minted, a
  // read of its own that lands beside the pictures'.
  await page.waitForFunction(
    () => document.querySelector('#agentChatLog .chatfileitem[aria-label="Open calibration-review.html full screen"]') !== null
      // …and so does a Markdown file's, once its words are read (note #677).
      && document.querySelector('#agentChatLog .chatmditem [aria-label="Open launch-plan.md full screen"]') !== null,
    { timeout: 10_000 },
  ).catch(() => {});
  const pictureRows = await page.$$('#agentChatLog .chatfileitem');
  // Seven: the owner's five, and the clip and the recording the agent sent
  // back (note #693), which play rather than open and are read further down.
  check('a message carries its pictures and names its other files',
    pictureRows.length === 7
    && (await page.$$('#agentChatLog .chatfileitem.haspicture')).length === 2
    && (await page.$$('#agentChatLog .chatfileitem.chatpdfitem')).length === 1
    && (await page.$$('#agentChatLog .chatfileitem.chatmediaitem')).length === 2,
    `${pictureRows.length} rows, ${(await page.$$('#agentChatLog .chatfileitem.haspicture')).length} of them pictures`);
  const labels = await page.$$eval(
    '#agentChatLog .chatfileitem, #agentChatLog .chatpdfitem .chatfileline, #agentChatLog .chatmditem .chatfileline',
    (nodes) => nodes.filter((node) => node.getAttribute('aria-label')).map((node) => node.getAttribute('aria-label')),
  );
  // A file that is only ever saved says so (note #552): a tap on it hands
  // the browser the bytes, and its name is what that tap does.
  check('…and each row says what its own tap will do',
    labels.join(' | ') === 'Open wide.png full screen | Open tall.png full screen | Open launch-plan.md full screen'
      + ' | Open design-review.pdf full screen | Open calibration-review.html full screen',
    labels.join(' | '));
  await page.click('#agentChatLog .chatfileitem.haspicture');
  // Where the reader stands once the tap has landed, which is not always
  // where they stood before it: a picture clipped by the pane's top edge is
  // scrolled into view by the browser when the tap focuses its button, and
  // that scroll belongs to the tap, not to the viewer. What the viewer
  // promises is this line back, exactly (`ImageViewer.tsx`).
  const openedFrom = await scrolled();
  await page.waitForSelector('#imageViewer', { timeout: 10_000 });
  check('a tap on a picture opens the shared viewer, not a new tab',
    (await text('#imageViewerName')) === 'wide.png', await text('#imageViewerName'));
  check('…on the conversation’s pictures as one gallery (note #544: this one has two)',
    (await text('#imageViewerCount')) === '1 of 2', await text('#imageViewerCount'));
  // The chat is a viewport-tall shell with furniture of its own at both ends;
  // the viewer has to cover all of it.
  // Written without a helper of its own on purpose: a named inner function
  // inside `evaluate` is compiled with esbuild's `__name` shim, which does not
  // exist in the page and throws there.
  const covered = await page.evaluate(() => {
    const box = document.getElementById('imageViewer')!.getBoundingClientRect();
    const head = document.querySelector('.chathead')!.getBoundingClientRect();
    const bar = document.getElementById('agentChatForm')!.getBoundingClientRect();
    return {
      viewport: Math.round(box.width) >= window.innerWidth - 1 && Math.round(box.height) >= window.innerHeight - 1,
      head: box.top <= head.top + 1 && box.bottom >= head.bottom - 1
        && box.left <= head.left + 1 && box.right >= head.right - 1,
      bar: box.top <= bar.top + 1 && box.bottom >= bar.bottom - 1
        && box.left <= bar.left + 1 && box.right >= bar.right - 1,
      box: box.toJSON(),
    };
  });
  check('…covering the chat’s own header and composer, not opening under them',
    covered.viewport && covered.head && covered.bar, JSON.stringify(covered));
  // The picture's SHAPE as PAINTED, the check note #274 was written for: a
  // wide screenshot letterboxes inside the stage rather than filling it.
  const painted = await page.$eval('#imageViewer img', (node) => {
    const img = node as HTMLImageElement;
    const box = img.getBoundingClientRect();
    const stage = document.querySelector('#imageViewerStage')!.getBoundingClientRect();
    const scale = getComputedStyle(img).objectFit === 'contain'
      ? Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight)
      : 0;
    return {
      width: scale ? img.naturalWidth * scale : box.width,
      height: scale ? img.naturalHeight * scale : box.height,
      natural: img.naturalWidth / img.naturalHeight,
      stage: { width: stage.width, height: stage.height },
    };
  });
  check('…drawing the picture in its own shape, inside the stage',
    Math.abs(painted.width / painted.height - painted.natural) < 0.02
    && painted.width <= painted.stage.width + 1 && painted.height <= painted.stage.height + 1,
    `drawn ${Math.round(painted.width)}x${Math.round(painted.height)} (its own ratio ${painted.natural.toFixed(2)}) `
    + `in a stage of ${Math.round(painted.stage.width)}x${Math.round(painted.stage.height)}`);
  await view('chat-picture-viewer');
  await page.click('#imageViewerNext');
  await page.waitForFunction(
    () => document.getElementById('imageViewerName')?.textContent === 'tall.png', { timeout: 10_000 },
  ).catch(() => {});
  check('the second picture on the message is one step away',
    (await text('#imageViewerName')) === 'tall.png'
    && (await page.$eval('#imageViewerImage', (node) => (node as HTMLImageElement).naturalHeight)) === 480,
    await text('#imageViewerName'));
  await view('chat-picture-viewer-step');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#imageViewer'), { timeout: 10_000 });
  check('Escape gives the conversation back, on the line it was opened from',
    Boolean(await page.$('#agentChatLog .chatfileitem.haspicture'))
    && Math.abs((await scrolled()).y - openedFrom.y) <= 2,
    `${JSON.stringify(await scrolled())} from ${JSON.stringify(openedFrom)}`);

  // 4a-ii. The document half of the same act (note #403). A PDF used to be a
  //     name, a size and a download; it is now a band of its own first page
  //     in the transcript and the whole document full screen at a tap. Only a
  //     real browser can say ANY of this: jsdom draws no PDF, and a frame on
  //     another origin never tells the page whether it painted.
  const pdfCard = await page.$eval('#agentChatLog .chatpdfitem', (node) => {
    const frame = node.querySelector('iframe') as HTMLIFrameElement;
    const band = node.querySelector('.pdfpreview')!.getBoundingClientRect();
    const line = node.querySelector('.chatfileline')!.getBoundingClientRect();
    return {
      src: frame.getAttribute('src') ?? '',
      lazy: frame.getAttribute('loading'),
      // The pointer must reach the button under the band, not the frame.
      through: getComputedStyle(frame).pointerEvents,
      band: { width: band.width, height: band.height },
      // The name line keeps its place under the page: a band of a page one
      // cannot say "design-review.pdf · 871 KB".
      named: node.textContent?.includes('design-review.pdf') ?? false,
      stacked: line.top >= band.bottom - 1,
    };
  });
  await page.evaluate(() => document.querySelector('#agentChatLog .chatpdfitem')!.scrollIntoView({ block: 'center' }));
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await view('chat-pdf-card');
  check('a PDF in the transcript shows a band of its first page, above its name',
    pdfCard.src.includes('#page=1&toolbar=0') && pdfCard.lazy === 'lazy' && pdfCard.through === 'none'
    && pdfCard.band.width > 100 && pdfCard.band.height > 100 && pdfCard.named && pdfCard.stacked,
    JSON.stringify(pdfCard));
  // Chrome puts the document itself in a child frame. Its presence is the
  // only honest answer to "did the bytes reach the browser as a PDF" that a
  // page on another origin is allowed to have.
  const framed = () => page.frames().filter((frame) => frame.url().includes('design-review.pdf')).length;
  await page.waitForFunction(() => true);
  check('…and the browser really loaded it into that frame', framed() > 0, `${framed()} frames`);

  // What is actually UNDER the thumb on the band, and what would be there
  // without the rule that puts it there (note #353's shape, one screen over).
  // The band is a frame with the pointer turned off and the name line's own
  // stretched box over it, so a tap anywhere on the card lands on a real
  // <button>; take the stretch away and it lands on the card itself, which
  // does nothing at all.
  const underThumb = await page.evaluate(() => {
    const card = document.querySelector('#agentChatLog .chatpdfitem') as HTMLElement;
    const band = card.querySelector('.pdfpreview')!.getBoundingClientRect();
    const x = band.left + band.width / 2;
    const y = band.top + band.height / 2;
    const hit = document.elementFromPoint(x, y);
    card.style.setProperty('--probe', '1');
    const line = card.querySelector('.chatfileline') as HTMLElement;
    line.style.display = 'none';
    const without = document.elementFromPoint(x, y);
    line.style.display = '';
    return { hit: hit?.className ?? '', without: without?.className ?? '' };
  });
  check('…and a tap anywhere on that card lands on the button, not the frame',
    underThumb.hit.includes('chatfileline') && !underThumb.without.includes('chatfileline'),
    JSON.stringify(underThumb));

  await page.click('#agentChatLog .chatpdfitem .chatfileline');
  const readFrom = await scrolled();
  await page.waitForSelector('#pdfViewer', { timeout: 10_000 });
  check('a tap on a PDF opens it full screen, in the Workspace',
    (await text('#pdfViewerName')) === 'design-review.pdf', await text('#pdfViewerName'));
  const documentCovered = await page.evaluate(() => {
    const box = document.getElementById('pdfViewer')!.getBoundingClientRect();
    const stage = document.getElementById('pdfViewerStage')!.getBoundingClientRect();
    const head = document.querySelector('.chathead')!.getBoundingClientRect();
    const bar = document.getElementById('agentChatForm')!.getBoundingClientRect();
    return {
      viewport: Math.round(box.width) >= window.innerWidth - 1 && Math.round(box.height) >= window.innerHeight - 1,
      overChat: box.top <= head.top + 1 && box.bottom >= bar.bottom - 1,
      // The frame IS the stage: nothing between them, and the stage takes
      // what the header and the control bar leave.
      stage: stage.height > box.height * 0.5 && stage.width >= box.width - 1,
      reading: document.getElementById('pdfViewerFrame')!.getAttribute('src')?.endsWith('#view=FitH'),
      box: box.toJSON(),
    };
  });
  check('…covering the chat, with the document filling the stage at fit-to-width',
    documentCovered.viewport && documentCovered.overChat && documentCovered.stage
    && documentCovered.reading === true, JSON.stringify(documentCovered));
  // Give the framed viewer a beat to paint before the photograph: this is the
  // one shot in the run that shows the feature working rather than its shape.
  await page.waitForFunction(
    () => (document.getElementById('pdfViewerFrame') as HTMLIFrameElement).getBoundingClientRect().height > 200,
    { timeout: 10_000 },
  ).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await view('chat-pdf-viewer');
  await page.click('#pdfViewerClose');
  await page.waitForFunction(() => !document.querySelector('#pdfViewer'), { timeout: 10_000 });
  check('…and closing it gives the conversation back on the line it was opened from',
    Math.abs((await scrolled()).y - readFrom.y) <= 2,
    `${JSON.stringify(await scrolled())} from ${JSON.stringify(readFrom)}`);

  // 4a-html. A page an agent wrote (note #557) opens in the same viewer,
  //     and the frame it is drawn in has NO origin: the page lays itself out
  //     and runs its own script, and can reach neither the Workspace nor the
  //     host it was served from. Read from inside the frame, which the
  //     browser lets a harness do and lets the page itself do to nobody.
  await page.click('#agentChatLog .chatfileitem[aria-label="Open calibration-review.html full screen"]');
  const pageReadFrom = await scrolled();
  await page.waitForSelector('#pdfViewer.htmlviewer', { timeout: 10_000 });
  check('a tap on an HTML page opens it full screen, in the Workspace',
    (await text('#pdfViewerName')) === 'calibration-review.html', await text('#pdfViewerName'));
  const pageFrame = await page.evaluate(() => {
    const frame = document.getElementById('pdfViewerFrame') as HTMLIFrameElement;
    const box = document.getElementById('pdfViewer')!.getBoundingClientRect();
    const stage = document.getElementById('pdfViewerStage')!.getBoundingClientRect();
    return {
      sandbox: frame.getAttribute('sandbox'),
      src: frame.getAttribute('src'),
      save: document.getElementById('pdfViewerSave')?.getAttribute('aria-label') ?? null,
      openOut: document.getElementById('pdfViewerOpenOut') !== null,
      viewport: Math.round(box.width) >= window.innerWidth - 1 && Math.round(box.height) >= window.innerHeight - 1,
      stage: stage.height > box.height * 0.8 && stage.width >= box.width - 1,
    };
  });
  check('…sandboxed, with Download in the head and no way out of the frame',
    pageFrame.sandbox === 'allow-scripts allow-popups allow-popups-to-escape-sandbox'
    && pageFrame.src?.includes('calibration-review.html') === true && !pageFrame.src.includes('#')
    && pageFrame.save === 'Download' && !pageFrame.openOut && pageFrame.viewport && pageFrame.stage,
    JSON.stringify(pageFrame));
  const inFrame = page.frames().find((frame) => frame.url().includes('calibration-review.html'));
  await inFrame?.waitForSelector('h1', { timeout: 10_000 }).catch(() => {});
  const drawn = inFrame ? await inFrame.evaluate(() => ({
    heading: document.querySelector('h1')?.textContent ?? '',
    rows: document.querySelectorAll('tr').length,
    ran: document.getElementById('ran')?.textContent ?? '',
    // What the page can see of the world: an opaque origin, and no parent
    // it can read — the two facts that make framing it safe.
    origin: (() => { try { return window.origin; } catch { return 'unreadable'; } })(),
    parentReadable: (() => { try { return typeof window.parent.document.title === 'string'; } catch { return false; } })(),
  })) : null;
  check('…and the page really drew itself inside that frame, with an opaque origin',
    drawn !== null && drawn.heading === 'Startup outreach review' && drawn.rows === 3
    && drawn.ran === 'script ran, origin null' && drawn.origin === 'null' && drawn.parentReadable === false,
    JSON.stringify(drawn));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await view('chat-html-viewer');
  await page.click('#pdfViewerClose');
  await page.waitForFunction(() => !document.querySelector('#pdfViewer'), { timeout: 10_000 });
  check('…and closing the page gives the conversation back on its line',
    Math.abs((await scrolled()).y - pageReadFrom.y) <= 2,
    `${JSON.stringify(await scrolled())} from ${JSON.stringify(pageReadFrom)}`);

  // 4a-md. A Markdown file (note #677) is the page it is: a card with the top
  //     of the document on it, and a tap opens the whole of it full screen,
  //     drawn by the Workspace's own renderer on the Workspace's own paper.
  await page.evaluate(() => document.querySelector('#agentChatLog .chatmditem')!.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(
    () => document.querySelector('#agentChatLog .chatmditem .mdglimpse:not(.loading) h1') !== null,
    { timeout: 10_000 },
  ).catch(() => {});
  const mdCard = await page.$eval('#agentChatLog .chatmditem', (node) => {
    const card = node.getBoundingClientRect();
    const band = node.querySelector('.mdglimpse')!.getBoundingClientRect();
    const line = node.querySelector('.chatfileline')!.getBoundingClientRect();
    const heading = node.querySelector('.mdglimpse h1');
    return {
      heading: heading?.textContent ?? '',
      headingWidth: heading ? Math.round(heading.getBoundingClientRect().width) : 0,
      cardWidth: Math.round(card.width),
      band: { width: Math.round(band.width), height: Math.round(band.height) },
      stacked: line.top >= band.bottom - 1,
      named: node.textContent?.includes('launch-plan.md') ?? false,
      through: getComputedStyle(node.querySelector('.mdglimpse')!).pointerEvents,
      inert: node.querySelector('.mdglimpse')!.hasAttribute('inert'),
    };
  });
  await view('chat-md-card');
  check('a Markdown file shows the top of its page on a card above its name',
    mdCard.heading === 'Ship it: building in public' && mdCard.band.height > 100 && mdCard.band.width > 100
    && mdCard.headingWidth > 0 && mdCard.headingWidth <= mdCard.cardWidth
    && mdCard.stacked && mdCard.named && mdCard.through === 'none' && mdCard.inert,
    JSON.stringify(mdCard));
  const mdReadFrom = await scrolled();
  await page.click('#agentChatLog .chatmditem .chatfileline');
  await page.waitForSelector('#pdfViewer.mdviewer', { timeout: 10_000 });
  const mdPage = await page.evaluate(() => {
    const box = document.getElementById('pdfViewer')!.getBoundingClientRect();
    const stage = document.getElementById('pdfViewerStage')!;
    const sheet = stage.querySelector('.mdsheet')!;
    const body = sheet.querySelector('p')!;
    return {
      name: document.getElementById('pdfViewerName')?.textContent ?? '',
      heading: sheet.querySelector('h1')?.textContent ?? '',
      sections: sheet.querySelectorAll('h2').length,
      rows: sheet.querySelectorAll('tbody tr').length,
      items: sheet.querySelectorAll('li').length,
      quote: sheet.querySelector('blockquote')?.textContent ?? '',
      code: sheet.querySelector('pre code')?.textContent ?? '',
      link: sheet.querySelector('a')?.getAttribute('target') ?? '',
      font: getComputedStyle(body).fontSize,
      paper: getComputedStyle(document.getElementById('pdfViewer')!).backgroundColor,
      save: document.getElementById('pdfViewerSave')?.getAttribute('aria-label') ?? null,
      frame: document.getElementById('pdfViewerFrame') !== null,
      openOut: document.getElementById('pdfViewerOpenOut') !== null,
      viewport: Math.round(box.width) >= window.innerWidth - 1 && Math.round(box.height) >= window.innerHeight - 1,
      scrolls: stage.scrollHeight > stage.clientHeight,
      focused: document.activeElement === stage,
      selectable: getComputedStyle(body).userSelect !== 'none',
    };
  });
  check('a tap opens the whole file full screen, as a page of its own words',
    mdPage.name === 'launch-plan.md' && mdPage.heading === 'Ship it: building in public'
    && mdPage.sections === 3 && mdPage.rows === 3 && mdPage.items >= 8
    && mdPage.quote.startsWith('Reddit punishes') && mdPage.code.startsWith("I'm building an idle game")
    && mdPage.link === '_blank',
    JSON.stringify(mdPage));
  check('…set in the reading type on the Workspace’s light paper, with Download and no frame',
    mdPage.font === '17px' && mdPage.paper === 'rgb(252, 252, 251)' && mdPage.save === 'Download'
    && !mdPage.frame && !mdPage.openOut && mdPage.viewport && mdPage.scrolls && mdPage.focused && mdPage.selectable,
    JSON.stringify(mdPage));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await view('chat-md-viewer');
  await page.evaluate(() => { document.getElementById('pdfViewerStage')!.scrollTop = 520; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await view('chat-md-viewer-scrolled');
  await page.click('#pdfViewerClose');
  await page.waitForFunction(() => !document.querySelector('#pdfViewer'), { timeout: 10_000 });
  check('…and closing it gives the conversation back on its line',
    Math.abs((await scrolled()).y - mdReadFrom.y) <= 2,
    `${JSON.stringify(await scrolled())} from ${JSON.stringify(mdReadFrom)}`);

  // 4a-media. A video and a recording PLAY where they were said (note #693):
  //     the browser's own player above the name, which stays the Download.
  //     Real bytes through a real decoder, because whether a clip's first
  //     frame is drawn and whether pressing play moves it are things only a
  //     browser can say.
  await page.evaluate(() => document.querySelector('#agentChatLog .chatvideoitem')!.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#agentChatLog .chatvideoitem video');
    const audio = document.querySelector<HTMLAudioElement>('#agentChatLog .chataudioitem audio');
    return Boolean(video && video.readyState >= 2 && audio && audio.readyState >= 1);
  }, { timeout: 10_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  const clip = await page.$eval('#agentChatLog .chatvideoitem', (node) => {
    const video = node.querySelector('video')!;
    const frame = node.querySelector('.chatvideo')!.getBoundingClientRect();
    const line = node.querySelector('.chatfileline')!;
    // The frame the decoder drew, read back off a canvas: the clip is one
    // flat colour, so any pixel of it says whether a picture is there.
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext('2d')!;
    context.drawImage(video, 0, 0, 8, 8);
    const [red, green, blue] = context.getImageData(4, 4, 1, 1).data;
    // The clip as PAINTED inside its frame: an upright one letterboxes in
    // the card rather than shrinking the card to a strip.
    const scale = Math.min(frame.width / video.videoWidth, frame.height / video.videoHeight);
    return {
      ready: video.readyState,
      size: `${video.videoWidth}x${video.videoHeight}`,
      shape: getComputedStyle(node).getPropertyValue('--video-shape').trim(),
      frame: { width: Math.round(frame.width), height: Math.round(frame.height) },
      painted: { width: Math.round(video.videoWidth * scale), height: Math.round(video.videoHeight * scale) },
      fit: getComputedStyle(video).objectFit,
      cardWidth: Math.round(node.getBoundingClientRect().width),
      rowWidth: Math.round(node.closest('.chatmsg')!.getBoundingClientRect().width),
      pixel: [red ?? 0, green ?? 0, blue ?? 0],
      controls: video.controls,
      inline: video.playsInline,
      stacked: line.getBoundingClientRect().top >= frame.bottom - 1,
      label: line.getAttribute('aria-label'),
      named: line.textContent?.includes('chat-clip.mp4') ?? false,
      save: line.querySelector('.chatsave') !== null,
    };
  });
  await view('chat-media');
  check('a video plays where it was said: its first frame drawn, in its own upright shape (note #693)',
    clip.ready >= 2 && clip.size === '360x640' && clip.shape === '360 / 640'
    && clip.fit === 'contain' && clip.frame.height >= 300 && clip.frame.height <= 321
    && clip.painted.height === clip.frame.height && Math.abs(clip.painted.width / clip.painted.height - 360 / 640) < 0.02
    && clip.cardWidth >= 300 && clip.cardWidth <= clip.rowWidth + 1 && clip.controls && clip.inline
    && Math.abs(clip.pixel[0]! - 0x2a) < 24 && Math.abs(clip.pixel[1]! - 0x9d) < 24 && Math.abs(clip.pixel[2]! - 0x8f) < 24,
    JSON.stringify(clip));
  check('…with its name under the player, as the Download it is (note #552)',
    clip.stacked && clip.label === 'Download chat-clip.mp4' && clip.named && clip.save, JSON.stringify(clip));
  // Note #700: on a DESK the same clip stands larger. The phone's 320px
  //     height ceiling is the whole frame a phone has to give; in a 720px
  //     column under an 800px window it left a 2:13 product video 300px
  //     wide with black down both sides (the owner's screenshot). The
  //     ceiling rises to 480px there, and the card to the column; an upright
  //     clip keeps the 300px floor its controls need, now at 480px tall.
  //     Measured at the same window the desk section above uses, and the
  //     phone's put back after, since everything below is proved on a phone.
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.evaluate(() => document.querySelector('#agentChatLog .chatvideoitem')!.scrollIntoView({ block: 'center' }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const deskClip = await page.$eval('#agentChatLog .chatvideoitem', (node) => {
    const video = node.querySelector('video')!;
    const frame = node.querySelector('.chatvideo')!.getBoundingClientRect();
    const scale = Math.min(frame.width / video.videoWidth, frame.height / video.videoHeight);
    return {
      frame: { width: Math.round(frame.width), height: Math.round(frame.height) },
      painted: { width: Math.round(video.videoWidth * scale), height: Math.round(video.videoHeight * scale) },
      cardWidth: Math.round(node.getBoundingClientRect().width),
      rowWidth: Math.round(node.closest('.chatmsg')!.getBoundingClientRect().width),
      window: `${window.innerWidth}x${window.innerHeight}`,
    };
  });
  await view('chat-media-desk');
  check('on a desk the clip stands at 480px, half as tall again as on a phone (note #700)',
    deskClip.frame.height >= 470 && deskClip.frame.height <= 481
    && deskClip.painted.height === deskClip.frame.height && Math.abs(deskClip.painted.width / deskClip.painted.height - 360 / 640) < 0.02
    && deskClip.cardWidth >= 300 && deskClip.cardWidth <= deskClip.rowWidth + 1,
    JSON.stringify(deskClip));
  await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.evaluate(() => document.querySelector('#agentChatLog .chatvideoitem')!.scrollIntoView({ block: 'center' }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const mediaFrom = await scrolled();
  await page.click('#agentChatLog .chatvideoitem video');
  await page.waitForFunction(
    () => (document.querySelector<HTMLVideoElement>('#agentChatLog .chatvideoitem video')?.currentTime ?? 0) > 0.4,
    { timeout: 10_000 },
  ).catch(() => {});
  const played = await page.$eval('#agentChatLog .chatvideoitem video', (node) => {
    const video = node as HTMLVideoElement;
    return { at: Number(video.currentTime.toFixed(2)), error: video.error?.code ?? 0, fullscreen: document.fullscreenElement !== null };
  });
  check('…and pressed, it plays in the conversation, not thrown full screen',
    played.at > 0.4 && !played.error && !played.fullscreen && Math.abs((await scrolled()).y - mediaFrom.y) <= 2,
    JSON.stringify(played));
  const recording = await page.$eval('#agentChatLog .chataudioitem', (node) => {
    const audio = node.querySelector('audio')!;
    const player = audio.getBoundingClientRect();
    const line = node.querySelector('.chatfileline')!;
    return {
      ready: audio.readyState,
      duration: Math.round(audio.duration),
      controls: audio.controls,
      player: { width: Math.round(player.width), height: Math.round(player.height) },
      stacked: line.getBoundingClientRect().top >= player.bottom - 1,
      label: line.getAttribute('aria-label'),
    };
  });
  await page.evaluate(() => document.querySelector<HTMLAudioElement>('#agentChatLog .chataudioitem audio')!.play());
  await page.waitForFunction(
    () => (document.querySelector<HTMLAudioElement>('#agentChatLog .chataudioitem audio')?.currentTime ?? 0) > 0.3,
    { timeout: 10_000 },
  ).catch(() => {});
  const heard = await page.$eval('#agentChatLog .chataudioitem audio', (node) => Number((node as HTMLAudioElement).currentTime.toFixed(2)));
  check('a recording plays where it was said, above the name that saves it',
    recording.ready >= 1 && recording.duration === 3 && recording.controls && recording.player.height > 20
    && recording.player.width > 200 && recording.stacked && recording.label === 'Download chat-voice.mp3' && heard > 0.3,
    `${JSON.stringify(recording)} played to ${heard}s`);
  await page.evaluate(() => { for (const player of document.querySelectorAll<HTMLMediaElement>('#agentChatLog video, #agentChatLog audio')) player.pause(); });
  // The name is the way to the file: the very bytes, under its own name, and
  // the player left standing where it was.
  const shelf = mkdtempSync(path.join(os.tmpdir(), 'n693-shelf-'));
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: shelf });
  await page.click('#agentChatLog .chatvideoitem .chatfileline');
  const clipSaved = path.join(shelf, 'chat-clip.mp4');
  for (const deadline = Date.now() + 10_000; !existsSync(clipSaved) && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 100));
  check('…and its name saves the very clip that was sent, leaving the player where it stood',
    existsSync(clipSaved) && readFileSync(clipSaved).equals(media['chat-clip.mp4']!.bytes)
    && Boolean(await page.$('#agentChatLog .chatvideoitem video')) && !(await page.$('#imageViewer, #pdfViewer')),
    existsSync(clipSaved) ? `${readFileSync(clipSaved).length} bytes` : `nothing in ${shelf}: ${readdirSync(shelf).join(', ')}`);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  await cdp.detach();

  // 4b. The runtime picker over the chat: a leaf, not a screen. The line the
  //     reader was on and the words they had typed are both there when they
  //     come back — and the composer's reserve is measured again.
  await page.type('#agentChatText', 'half a thought');
  await page.evaluate(() => { document.getElementById('agentChatScroll')!.scrollTop = 900; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await page.click('#agentChatStatus');
  await page.waitForSelector('#agentRuntimeModels .crow', { timeout: 10_000 });
  // The header follows the leaf's Back claim a render later than its rows.
  check('the picker over the chat brings the persistent header out',
    Boolean(await page.waitForSelector('#pageHead', { timeout: 3_000 }).catch(() => null)));
  await page.click('#pageBack');
  await page.waitForFunction(() => !document.getElementById('screenAgentChat')?.hidden, { timeout: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('Back from the picker returns to the line the reader left', Math.abs((await scrolled()).y - 900) <= 2, JSON.stringify(await scrolled()));
  check('…with the unsent draft still in the box',
    (await page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value)) === 'half a thought');
  check('…and the shell still exactly as tall as the viewport',
    await page.evaluate(() => Math.abs(document.getElementById('agentChatForm')!.getBoundingClientRect().bottom
      - window.innerHeight) <= 1));
  await page.click('#agentChatText');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');

  // 4b-2. Through a receipt's door and back again. A conversation the reader
  //       RETURNS to owes them the row they left rather than its end — and
  //       the line is the pane's own now (note #278), because the window has
  //       none to remember. Clicked from script so the browser does not
  //       scroll the receipt into view and move the pane under the test.
  await page.evaluate(() => { document.getElementById('agentChatScroll')!.scrollTop = 1200; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await page.evaluate(() => (document.querySelector('#agentChatLog button.chatmsg.platform') as HTMLElement).click());
  await page.waitForFunction(() => !document.getElementById('screenAgentChat'), { timeout: 10_000 });
  await page.goBack();
  await page.waitForSelector('#agentChatScroll', { timeout: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  check('a conversation returned to keeps the row the reader left, not its end',
    Math.abs((await scrolled()).y - 1200) <= 2, JSON.stringify(await scrolled()));
  await page.evaluate(() => { document.getElementById('agentChatScroll')!.scrollTop = 10 ** 6; });
  // Let the pane's scroll listener record that the reader is following again
  // before the composer and viewport begin changing its height. The browser
  // delivers a programmatic scroll asynchronously; racing it made this proof
  // depend on how much other live furniture the chat happened to render.
  await page.waitForFunction(() => {
    const pane = document.getElementById('agentChatScroll')!;
    return pane.scrollTop >= pane.scrollHeight - pane.clientHeight - 2;
  }, { timeout: 5_000 });
  // The first event after the composer's height changed is deliberately
  // spent teaching the handler that new height; a user's gesture produces
  // more than one event, while this direct assignment does not. Deliver the
  // settled event a real drag would have produced.
  await page.$eval('#agentChatScroll', (pane) => pane.dispatchEvent(new Event('scroll')));
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 4c. The box grows with its lines, and the transcript gives up the room.
  //     SHIFT+Enter is what opens a line here now (note #291): a plain Enter
  //     in this window is a send, because a headless Chrome reports no
  //     pointing device at all — `pointer: none` — and the rule reads that,
  //     correctly, as a desk rather than a finger.
  const oneLine = await page.$eval('#agentChatText', (node) => (node as HTMLElement).offsetHeight);
  const openLine = async (word: string) => {
    await page.type('#agentChatText', word);
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
  };
  await openLine('one');
  await openLine('two');
  await page.type('#agentChatText', 'three');
  const threeLines = await page.$eval('#agentChatText', (node) => (node as HTMLElement).offsetHeight);
  check('the box grows with its lines', threeLines > oneLine + 20, `${oneLine} → ${threeLines}`);
  // A bar that grows takes its lines out of the TRANSCRIPT now, rather than
  // covering it and asking for a reserve to be held open underneath.
  check('the transcript gives up the lines the bar takes', await page.waitForFunction(() => {
    const pane = document.getElementById('agentChatScroll')!.getBoundingClientRect();
    const bar = document.getElementById('agentChatForm')!.getBoundingClientRect();
    return Math.abs(bar.top - pane.bottom) <= 1 && Math.abs(bar.bottom - window.innerHeight) <= 1;
  }, { timeout: 5_000 }).then(() => true, () => false));
  await page.click('#agentChatText');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  check('…and shrinks back when emptied',
    (await page.$eval('#agentChatText', (node) => (node as HTMLElement).offsetHeight)) <= oneLine + 2);

  // 4d. A phone keyboard that RESIZES the layout viewport — the ordinary
  //     case, and the one `100dvh` answers by itself. The shell has to end at
  //     the new bottom with nothing measured, and the reader has to still be
  //     at the end of the conversation when it does.
  await page.setViewport({ ...viewport, height: Math.round(viewport.height / 2), deviceScaleFactor: 2 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('the shell follows a viewport that shrinks under it', await page.evaluate(() => {
    const bar = document.getElementById('agentChatForm')!.getBoundingClientRect();
    const pane = document.getElementById('agentChatScroll')!.getBoundingClientRect();
    return Math.abs(bar.bottom - window.innerHeight) <= 1 && pane.height > 0
      && Math.round(document.querySelector('.chathead')!.getBoundingClientRect().top) === 0;
  }));
  check('…and keeps the reader at the end of the conversation while it does', await settled(), JSON.stringify(await scrolled()));
  await view('chat-short-viewport');
  await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 4e. A phone keyboard painted OVER the layout viewport — and with this
  //     shell's `width=device-width` and no `interactive-widget`, that is
  //     what a phone browser actually does: the VISUAL viewport loses the
  //     keyboard's height and `window.innerHeight` does not move at all.
  //     `dvh` does not shrink for a keyboard in any browser, so the shell
  //     stays a whole screen tall and the composer is left under the keys
  //     unless the visual viewport is read and written back. This is the
  //     case notes #305 and #289 were both reported for, and the one 4d
  //     above does NOT cover: 4d moves the layout viewport, which is the
  //     easy half.
  //
  //     Simulated by standing a fake visual viewport in front of the real
  //     one. Events are dispatched on the REAL one, where the screen's
  //     listeners are, so what runs is the shipped code path rather than a
  //     copy of it.
  const keys = (visible: number | null, silent = false) => page.evaluate(({ px, quiet }) => {
    const held = window as unknown as { realViewport?: VisualViewport };
    const real = (held.realViewport ??= window.visualViewport!);
    // Reading a real visual viewport's height LAYS THE PAGE OUT first —
    // WebKit and Chromium both do — so a shell that unsets its own height
    // before it reads gets laid out a whole screen tall in between, and the
    // transcript's scroll is clamped against a pane the keyboard is about to
    // take back (note #322). A plain number here hid that for two notes.
    const value = px === null ? real : {
      get height() { void document.documentElement.offsetHeight; return px; },
      width: real.width, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
      addEventListener: real.addEventListener.bind(real),
      removeEventListener: real.removeEventListener.bind(real),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value });
    if (!quiet) real.dispatchEvent(new Event('resize'));
  }, { px: visible, quiet: silent });
  const composerBottom = () => page.evaluate(() => ({
    bar: Math.round(document.getElementById('agentChatForm')!.getBoundingClientRect().bottom),
    inner: window.innerHeight,
    visible: Math.round(window.visualViewport!.height),
  }));
  const visible = Math.round(viewport.height * 0.52);
  await page.focus('#agentChatText');
  await keys(visible);
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('a keyboard painted OVER the page leaves the composer above it, not under the keys',
    Math.abs((await composerBottom()).bar - visible) <= 1, JSON.stringify(await composerBottom()));
  check('…with the header still over the transcript, and transcript left to read',
    await page.evaluate(() => {
      const head = document.querySelector('.chathead')!.getBoundingClientRect();
      const pane = document.getElementById('agentChatScroll')!.getBoundingClientRect();
      const bar = document.getElementById('agentChatForm')!.getBoundingClientRect();
      return Math.round(head.top) === 0 && pane.height > 100 && Math.abs(bar.top - pane.bottom) <= 1;
    }));
  check('…and the reader still at the end of the conversation', await settled(), JSON.stringify(await scrolled()));
  await view('chat-keyboard-overlay');

  //     The reading that arrives WITH the event is the wrong one: a keyboard
  //     SLIDES, and the browser reports the viewport while it is still
  //     moving. Simulated at its worst — the viewport moves with NO event at
  //     all — so nothing but a second look after the focus can find it. That
  //     second look is what note #289 was getting by accident, from the box
  //     growing a line: "I can't see the text input. Then when I type
  //     something, I start seeing it properly."
  await keys(null);
  await page.evaluate(() => (document.getElementById('agentChatText') as HTMLElement).blur());
  await new Promise((resolve) => setTimeout(resolve, 800));
  const slid = Math.round(viewport.height * 0.44);
  await page.focus('#agentChatText');
  await keys(slid, true);
  await new Promise((resolve) => setTimeout(resolve, 900));
  check('…and a keyboard that lands after the event that announced it is measured again, not left',
    Math.abs((await composerBottom()).bar - slid) <= 1, JSON.stringify(await composerBottom()));
  await keys(null);
  await page.evaluate(() => (document.getElementById('agentChatText') as HTMLElement).blur());
  await new Promise((resolve) => setTimeout(resolve, 800));
  check('…and the shell has the whole window back once the keyboard goes',
    Math.abs((await composerBottom()).bar - (await composerBottom()).inner) <= 1, JSON.stringify(await composerBottom()));

  // 4f. The keyboard's SLIDE. A phone pans the page under its rising
  //     keyboard on the compositor, a frame ahead of every reading it sends,
  //     so a shell written to each reading sat a step behind the viewport
  //     for the whole quarter-second — the "flash of chat content
  //     flickering" the owner saw on tapping the box. The contract now:
  //     readings that keep changing are HELD, the one that stands still is
  //     written, and a keyboard met before (4e above left one remembered)
  //     has the shell placed for it at the focus itself, before it moves.
  //     Simulated with readings delivered in successive frames, each one
  //     announced the way a browser announces it.
  const transition = async (reading = false) => page.evaluate(async (reading) => {
    const pane = document.getElementById('agentChatScroll')!;
    const bar = document.getElementById('agentChatForm')!;
    const root = document.getElementById('screenAgentChat')!;
    const box = document.getElementById('agentChatText') as HTMLElement;
    const real = (window as unknown as { realViewport: VisualViewport }).realViewport;
    let height = window.innerHeight;
    let top = 0;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: {
      get height() { void document.documentElement.offsetHeight; return height; },
      get offsetTop() { return top; },
      addEventListener: real.addEventListener.bind(real),
      removeEventListener: real.removeEventListener.bind(real),
    } });
    pane.scrollTop = reading ? 400 : pane.scrollHeight;
    pane.dispatchEvent(new Event('scroll'));
    const line = pane.scrollTop;
    // Bound from an array, not declared one by one: the harness runs through
    // tsx, which names every declared function with a helper the page has
    // never heard of (`__name is not defined`).
    type Geometry = { shell: string; shift: string; bar: number; scrollError: number };
    type Slide = { held: Geometry[]; frames: number; landed: Geometry & { barError: number; headError: number } };
    const [frame, geometry, announce, slide]: [() => Promise<void>, () => Geometry, (fraction: number, panned: number) => void, (steps: Array<[number, number]>) => Promise<Slide>] = [
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      () => ({
        shell: document.documentElement.style.getPropertyValue('--chat-shell-height'),
        shift: root.style.transform,
        bar: Math.round(bar.getBoundingClientRect().bottom),
        scrollError: Math.round(reading ? pane.scrollTop - line : pane.scrollHeight - pane.clientHeight - pane.scrollTop),
      }),
      (fraction, panned) => {
        height = Math.round(window.innerHeight * fraction);
        top = panned;
        real.dispatchEvent(new Event('resize'));
        real.dispatchEvent(new Event('scroll'));
      },
      // Deliver a slide frame by frame; every reading but the last keeps
      // changing, and the last is left standing until the shell takes it.
      async (steps) => {
        const held: Geometry[] = [];
        for (const [fraction, panned] of steps) { await frame(); announce(fraction, panned); held.push(geometry()); }
        let frames = 0;
        while (frames < 8) {
          await frame(); frames += 1;
          if (geometry().shell === (height < window.innerHeight ? `${height}px` : '') && geometry().shift === (top ? `translateY(${top}px)` : '')) break;
        }
        return { held, frames, landed: { ...geometry(), barError: Math.round(bar.getBoundingClientRect().bottom - top - height), headError: Math.round(root.getBoundingClientRect().top - top) } };
      },
    ];
    // The reader's own scroll is reported by the browser a frame after it
    // happens; a tap on the box comes long after that.
    await frame();
    box.focus({ preventScroll: true });
    const placed = geometry();
    const opening = await slide([[0.92, 6], [0.8, 12], [0.65, 18], [0.52, 24]]);
    box.blur();
    const closing = await slide([[0.65, 18], [0.8, 12], [0.92, 6], [1, 0]]);
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: real });
    real.dispatchEvent(new Event('resize'));
    return { placed, opening, closing, line };
  }, reading);
  const followed = await transition();
  check('a keyboard met before has the shell placed for it at the focus, before it moves',
    followed.placed.bar === slid && followed.placed.shell === `${slid}px`, JSON.stringify(followed.placed));
  const heldThrough = (run: Awaited<ReturnType<typeof transition>>['opening'], from: { shell: string; shift: string }) =>
    run.held.slice(0, -1).every((frame) => frame.shell === from.shell && frame.shift === from.shift);
  check('…readings that keep changing through the slide are held, not chased',
    heldThrough(followed.opening, followed.placed) && heldThrough(followed.closing, followed.opening.landed),
    JSON.stringify({ opening: followed.opening.held, closing: followed.closing.held }));
  check('…and the reading the slide ends on is written within two frames, shell and newest line together',
    followed.opening.frames <= 2 && followed.closing.frames <= 2
      && [followed.opening.landed, followed.closing.landed].every((landed) => Math.abs(landed.barError) <= 1 && Math.abs(landed.headError) <= 1 && Math.abs(landed.scrollError) <= 1),
    JSON.stringify({ opening: followed.opening, closing: followed.closing }));
  const readingBack = await transition(true);
  check('opening and closing the keyboard preserves an older reading position on every delivery',
    [readingBack.placed, ...readingBack.opening.held, readingBack.opening.landed, ...readingBack.closing.held, readingBack.closing.landed]
      .every((frame) => Math.abs(frame.scrollError) <= 1),
    JSON.stringify(readingBack));
  // The remembered keyboard is this run's, not the next step's: a send below
  // focuses the box on a desk, where no keyboard is coming.
  await page.evaluate(() => localStorage.removeItem('chat-keyboard'));
  await page.evaluate(() => {
    const pane = document.getElementById('agentChatScroll')!;
    pane.scrollTop = pane.scrollHeight;
    pane.dispatchEvent(new Event('scroll'));
  });

  // 5. Stop is answered by the transcript itself.
  await page.click('#agentChatStop');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.chatmsg.chatquiet')].some((node) => node.textContent === 'You stopped this turn'),
    { timeout: 10_000 },
  ).catch(() => {});
  check('a stopped turn is answered by the row it appends, with no toast over the composer',
    (await texts('.chatmsg.chatquiet')).includes('You stopped this turn') && !(await page.$('#banner.show')));
  // Note #384: the reader's own tap is a quiet line — no card around it, no
  // chip on it, and centred rather than filling the width a receipt takes.
  check('…and it is a quiet line rather than a receipt card', await page.evaluate(() => {
    const line = [...document.querySelectorAll('#agentChatLog .chatmsg.chatquiet')]
      .find((node) => node.textContent === 'You stopped this turn');
    if (!line) return false;
    const style = getComputedStyle(line);
    const box = line.getBoundingClientRect();
    const log = document.getElementById('agentChatLog')!.getBoundingClientRect();
    return !line.querySelector('.chatnotice') && !line.querySelector('.badge') && !line.querySelector('svg')
      && style.borderBottomWidth === '0px'
      && style.textAlign === 'center'
      && box.width < log.width * 0.7
      && Math.abs((box.left + box.right) / 2 - (log.left + log.right) / 2) <= 1;
  }));
  await page.waitForFunction(() => (document.getElementById('agentChatLive') as HTMLElement).hidden, { timeout: 10_000 }).catch(() => {});
  check('…and the live row goes down with it',
    await page.$eval('#agentChatLive', (node) => (node as HTMLElement).hidden));

  // 6. Send.
  await page.type('#agentChatText', 'thanks — ship it');
  await page.click('#agentChatSend');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#agentChatLog .chatmsg.owner:not(.sending)')].some((node) => node.textContent === 'thanks — ship it'),
    { timeout: 10_000 },
  ).catch(() => {});
  // The bubble a send stands up at once (note #658) is REPLACED by the row
  // the read brings — never left beside it as a second copy.
  check('a sent message ends as the row on the record, with no copy beside it',
    (await texts('#agentChatLog .chatmsg.owner')).filter((text) => text === 'thanks — ship it').length === 1
      && !(await page.$('#agentChatLog .chatmsg.sending')));
  check('the box empties with the send', (await page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value)) === '');
  // What a send does with the keyboard, in the two halves note #305 split it
  // into. This window is a DESK — a headless Chrome reports no pointing
  // device at all, which `chat-compose.ts` reads as a keyboard — so the box
  // keeps the focus and note #291's Enter still sends the next message.
  check('…and at a desk keeps the focus, so Enter sends the next message',
    await page.evaluate(() => document.activeElement?.id === 'agentChatText'), await page.evaluate(() => document.activeElement?.id ?? 'none'));
  await atEnd('the sent row is followed to the end of the conversation');
  await shot('chat-sent');

  // The same send under a FINGER. `hasTouch` is real touch emulation, not a
  // stubbed media query: it is what makes `(pointer: coarse)` true, the one
  // claim a phone makes and a desk never does, and the composer reads it
  // through the same helper that decides whether Enter is a key of its own.
  // Note #305 asked for the keyboard to go away after a send, and letting the
  // box drop its focus is what puts a touch keyboard down.
  //
  // This REPLACES the check that used to stand here — "…and keeps the
  // keyboard for the next message" — which was a deliberate decision for
  // rapid chat before the reader said what it costs on a phone.
  await page.setViewport({ ...viewport, deviceScaleFactor: 2, hasTouch: true });
  // Waited for, because changing `hasTouch` RELOADS the page — the same fact
  // `finger()` below is built around. Typing straight into the composer won
  // that race most of the time and lost it often enough to end a whole run on
  // "No element found for selector".
  await page.waitForSelector('#agentChatText', { timeout: 10_000 });
  await page.type('#agentChatText', 'and once more');
  // Said out loud, so the check below cannot pass by the box never having had
  // the focus in the first place.
  check('…with the box holding the focus right up to the send',
    await page.evaluate(() => document.activeElement?.id === 'agentChatText'), await page.evaluate(() => document.activeElement?.id ?? 'none'));
  await page.click('#agentChatSend');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#agentChatLog .chatmsg.owner')].some((node) => node.textContent === 'and once more'),
    { timeout: 10_000 },
  ).catch(() => {});
  check('a send under a finger puts the touch keyboard away (note #305)',
    await page.evaluate(() => document.activeElement?.id !== 'agentChatText'),
    await page.evaluate(() => document.activeElement?.id ?? 'none'));
  await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
  // Waited for again: putting the finger away reloads exactly as taking it
  // out did, and the click below used to be aimed at a bar that was not
  // there yet.
  await page.waitForSelector('.chathead .back', { timeout: 10_000 });

  // 6c. A send that has to wait for the agent's machine to be rebuilt (note
  //     #658) — what self-healing onto a replaced cloud looked like: for the
  //     whole rebuild the message was nowhere, Send was dim, and the words
  //     outlived the reply in a read-only box. The route holds its answer
  //     here exactly as the real one does while it builds, and the message is
  //     in the conversation throughout.
  sendHeld = true;
  await page.type('#agentChatText', 'are you still there?');
  await page.click('#agentChatSend');
  await page.waitForSelector('#agentChatLog .chatmsg.owner.sending', { timeout: 5_000 }).catch(() => {});
  check('a message is in the conversation the moment it is sent, before the server answers (note #658)',
    (await texts('#agentChatLog .chatmsg.owner.sending')).includes('are you still there?'));
  check('…with the box already empty and live, not holding the words read-only',
    await page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value === '' && !(node as HTMLTextAreaElement).readOnly));
  await page.waitForFunction(
    () => document.getElementById('agentChatActivity')?.textContent === 'Getting Felix’s machine ready',
    { timeout: 10_000 },
  ).catch(() => {});
  check('…and the typing row says what it is waiting on, with no Stop for a turn that has not begun',
    (await page.$eval('#agentChatActivity', (node) => node.textContent)) === 'Getting Felix’s machine ready'
      && !(await page.$('#agentChatStop')),
    await page.$eval('#agentChatActivity', (node) => node.textContent ?? ''));
  await atEnd('the waiting message is followed to the end of the conversation');
  // Past the second after which a waiting bubble pales, so the picture is of
  // the wait as a reader sees it.
  await new Promise((resolve) => { setTimeout(resolve, 1600); });
  await shot('chat-sending');
  releaseSend();
  await page.waitForFunction(() => !document.querySelector('#agentChatLog .chatmsg.sending'), { timeout: 10_000 }).catch(() => {});
  check('…and once it is on the record its row takes the bubble’s place, once',
    (await texts('#agentChatLog .chatmsg.owner')).filter((text) => text === 'are you still there?').length === 1
      && !(await page.$('#agentChatLog .chatmsg.sending')));
  await shot('chat-sending-landed');

  // Words left half-typed on the way out (note #515). Put in the box BEFORE
  // the trip below, so the same Back that proves the navigation model also
  // carries the draft away — the composer is destroyed and rebuilt between
  // the two screens, which is the whole of what the reader was losing.
  await page.type('#agentChatText', 'half a thought I have not finished');

  // 7. Back out of a conversation this session pushed: it spends the entry.
  const entriesBeforeBack = await page.evaluate(() => history.length);
  await page.click('.chathead .back');
  await page.waitForSelector('#agentInfoTitle', { timeout: 10_000 });
  check('Back from a chat opened on the agent returns to that agent',
    page.url() === `${ORIGIN}/agents/felix`, page.url());
  check('…by spending the entry, not pushing over it',
    (await page.evaluate(() => history.length)) === entriesBeforeBack, String(await page.evaluate(() => history.length)));

  // 7b. And back IN through the agent's own door: the draft is waiting
  //     (note #515). Two whole screens apart, a composer built from nothing,
  //     and the words the reader had not finished are in the box with the
  //     send live on them — which is what the screenshot is of.
  await page.click('#agentChat');
  await page.waitForSelector('#agentChatText', { timeout: 10_000 });
  check('an unfinished message is in the box again on the way back (note #515)',
    (await page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value)) === 'half a thought I have not finished',
    await page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value));
  check('…with Send live on it, not a box full of words that cannot go',
    !(await page.$eval('#agentChatSend', (node) => (node as HTMLButtonElement).disabled)));
  // The box is also the height its words need, rather than one line with the
  // rest scrolled out of sight: the grow runs off the state it was rebuilt
  // with, not only off typing.
  check('…and the box is laid out for the draft it came back with',
    await page.$eval('#agentChatText', (node) => {
      const field = node as HTMLTextAreaElement;
      return field.scrollHeight - field.clientHeight <= 1;
    }));
  await atEnd('and the conversation is still at its newest message behind the draft');
  await shot('chat-draft-kept');

  // 8. A pasted or reloaded chat has no agent entry beneath it. The product's
  //    rule still says Chat → Agent, so Back REPLACES rather than pushes.
  //    The state read is held back so the transcript lands FIRST, while the
  //    screen is still a spinner — the usual order on a real cold load, and
  //    the one that used to open the conversation at its first message
  //    (note #302).
  stateDelayMs = 600;
  picturesHeld = true;
  await page.goto(`${ORIGIN}/chat/felix`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#agentChatTitle', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('#agentChatLog .chatmsg').length >= 45, { timeout: 10_000 }).catch(() => {});
  stateDelayMs = 0;
  await atEnd('a reloaded chat opens at its newest message too, when its transcript beats the state read');
  // The pictures on the newest message: framed at their final size before
  // their bytes land, so the transcript's height — and the reader's place
  // in it — is the same before and after they do. Sampled while the bytes
  // are still on their way (the route holds them), then once they are in.
  const pictureState = () => page.evaluate(() => {
    const pane = document.getElementById('agentChatScroll')!;
    const bytes = [...document.querySelectorAll<HTMLImageElement>('#agentChatLog img.chatpicturebytes')];
    return {
      frames: document.querySelectorAll('#agentChatLog .chatpicture').length,
      loaded: bytes.filter((img) => img.complete && img.naturalWidth > 0).length,
      height: pane.scrollHeight,
      top: Math.round(pane.scrollTop),
    };
  });
  await page.waitForFunction(() => document.querySelectorAll('#agentChatLog .chatpicture').length === 2, { timeout: 5_000 }).catch(() => {});
  const framedBefore = await pictureState();
  releasePictures();
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLImageElement>('#agentChatLog img.chatpicturebytes')]
      .filter((img) => img.complete && img.naturalWidth > 0).length === 2,
    { timeout: 10_000 },
  ).catch(() => {});
  const framedAfter = await pictureState();
  check('both pictures are framed before their bytes arrive, the measured one included',
    framedBefore.frames === 2 && framedBefore.loaded < 2, JSON.stringify(framedBefore));
  check('…and the bytes landing change nothing: same height, same line',
    framedAfter.loaded === 2 && framedAfter.height === framedBefore.height && framedAfter.top === framedBefore.top,
    `${JSON.stringify(framedBefore)} → ${JSON.stringify(framedAfter)}`);
  check('…with each frame the size its picture turns out to be, not a guess', await page.evaluate(() => {
    return [...document.querySelectorAll<HTMLElement>('#agentChatLog .chatpicture')].every((frame) => {
      const bytes = frame.querySelector<HTMLImageElement>('img.chatpicturebytes')!;
      const a = frame.getBoundingClientRect();
      const b = bytes.getBoundingClientRect();
      return a.width > 100 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1
        && Math.abs(a.width / a.height - bytes.naturalWidth / bytes.naturalHeight) < 0.02;
    });
  }));
  await view('chat-pictures');
  const entriesBeforeReplace = await page.evaluate(() => history.length);
  await page.click('.chathead .back');
  await page.waitForSelector('#agentInfoTitle', { timeout: 10_000 });
  check('Back from a pasted chat lands on its agent', page.url() === `${ORIGIN}/agents/felix`, page.url());
  check('…without adding an entry the next Back would walk through',
    (await page.evaluate(() => history.length)) === entriesBeforeReplace,
    `${entriesBeforeReplace} → ${await page.evaluate(() => history.length)}`);

  // 9. The same key, two meanings (note #291). Where a finger drives the
  //    window Enter is the newline key of a touch keyboard and must send
  //    nothing; at a desk it is the send. Two traps sit under that test.
  //    What separates the two windows is one media feature,
  //    `(pointer: coarse)`, and the ONLY lever that moves it is `hasTouch` on
  //    the viewport — `Emulation.setEmulatedMedia` accepts a pointer feature
  //    and silently ignores it, which reads as the RULE being broken rather
  //    than the emulation. And changing `hasTouch` RELOADS the page, so each
  //    half opens the chat again instead of typing across the switch; that
  //    reload is also why this stands after the history checks rather than
  //    beside the send it belongs to.
  const boxValue = () => page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value);
  const finger = async (coarse: boolean) => {
    await page.setViewport({ ...viewport, deviceScaleFactor: 2, hasTouch: coarse });
    await page.goto(`${ORIGIN}/chat/felix`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#agentChatText', { timeout: 10_000 });
    await page.click('#agentChatText');
  };
  await finger(true);
  await page.type('#agentChatText', 'one more thing');
  await page.keyboard.press('Enter');
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('Enter opens a line where a finger drives the window, and sends nothing',
    (await boxValue()) === 'one more thing\n'
      && !(await texts('#agentChatLog .chatmsg.owner')).includes('one more thing'),
    JSON.stringify(await boxValue()));
  await finger(false);
  await page.type('#agentChatText', 'one more thing');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#agentChatLog .chatmsg.owner')].some((node) => node.textContent === 'one more thing'),
    { timeout: 10_000 },
  ).catch(() => {});
  check('…and the same press sends at a desk, leaving the box empty',
    (await texts('#agentChatLog .chatmsg.owner')).includes('one more thing') && (await boxValue()) === '',
    JSON.stringify(await boxValue()));

  // 9b. Any number of files (note #672): the paperclip used to stop at five.
  //     Twelve screenshots are picked in one go, all twelve wait in the strip
  //     above the box, and one send carries all twelve through the real
  //     route's envelope as ONE message.
  const shotsDir = path.join(OUT, 'n672-shots');
  mkdirSync(shotsDir, { recursive: true });
  const twelve = Array.from({ length: 12 }, (_, i) => {
    const file = path.join(shotsDir, `screenshot-${i + 1}.png`);
    writeFileSync(file, png(60, 120, (x, y) => [(i * 20) % 255, (x * 4) % 255, (y * 2) % 255]));
    return file;
  });
  const picker = await page.$('#agentChatFile');
  await (picker as unknown as { uploadFile: (...paths: string[]) => Promise<void> }).uploadFile(...twelve);
  await page.waitForFunction(() => document.querySelectorAll('#agentChatDraft .chatdraftitem').length === 12, { timeout: 10_000 }).catch(() => {});
  check('twelve files picked at once all wait in the strip, with no refusal',
    (await page.$$eval('#agentChatDraft .chatdraftitem', (nodes) => nodes.length)) === 12 && !(await page.$('.banner[role="alert"], [role="alert"]')),
    String(await page.$$eval('#agentChatDraft .chatdraftitem', (nodes) => nodes.length)));
  await view('n672-twelve-picked');
  await page.type('#agentChatText', 'twelve screenshots');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#agentChatLog .chatmsg.owner')].some((node) => node.textContent?.includes('twelve screenshots')), { timeout: 10_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  check('…and one send carries all twelve as one message',
    lastSentFiles.length === 12 && lastSentFiles[11] === 'screenshot-12.png',
    JSON.stringify(lastSentFiles));

  // Note #704: a long brief is one message. A paste past ten thousand stops
  // at ten thousand, the counter says so, and the route takes all of it.
  // Spaces only where the cap cannot land, so the route's trim takes nothing.
  const brief = 'The model isn\'t the bottleneck. The shared memory and the gate are. ';
  const pasted = `${brief.repeat(Math.ceil(10_050 / brief.length)).slice(0, 9_990)}${'x'.repeat(60)}`;
  await page.focus('#agentChatText');
  await page.keyboard.sendCharacter(pasted);
  const kept = await page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value.length);
  check('a 10,050-character paste stops at 10,000', kept === 10_000, String(kept));
  check('…and the counter reads the cap',
    (await page.$eval('#agentChatCount', (node) => !(node as HTMLElement).hidden && node.textContent)) === '10000 / 10000',
    String(await page.$eval('#agentChatCount', (node) => node.textContent)));
  await view('n704-at-the-cap');
  await page.click('#agentChatSend');
  await page.waitForFunction(() => (document.getElementById('agentChatText') as HTMLTextAreaElement).value === '', { timeout: 10_000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  check('…and all ten thousand reach the agent as one message, with no refusal',
    lastSentMessage.length === 10_000 && lastSentMessage === pasted.slice(0, 10_000) && !(await page.$('.banner[role="alert"], [role="alert"]')),
    String(lastSentMessage.length));
  await view('n704-sent');

  // Both proposal stores are seeded now, so the history route is expected to
  // ANSWER; what this fixture still declines to stand up is the git host, and
  // the reads that need one say 503 by design.
  const unexpected = consoleErrors.filter((url) => !/status of (400|401|404|503)|^503 |\b401 .*auth\/session|favicon\.ico/.test(url));
  check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));

  // 9. An empty pane says WHICH empty it is (note #301). Everything above ran
  //    against a backend that answers; this runs against one that does not,
  //    which is the state that got reported — and the one a jsdom test can
  //    assert but not SHOW. The console check above has already banked its
  //    verdict, because the answers below are deliberate failures.
  const lifecycle = agentLifecycle as unknown as Record<string, unknown>;
  const realRead = lifecycle.agentChatMessages;

  // 9a. A read still in flight. The screen used to draw nothing at all here,
  //     for as long as it took — indistinguishable from one that is broken —
  //     and then a ring turning in an empty rectangle. It holds the SHAPE of
  //     the thing it is fetching now (note #309), which is the one state a
  //     jsdom test can assert and not see: whether a wait stands in the same
  //     boxes as the answer is a question only a browser with layout can
  //     settle.
  let release: (() => void) | undefined;
  lifecycle.agentChatMessages = () => new Promise((resolve) => {
    release = () => resolve(transcript.filter((message) => message.seq > 0));
  });
  await page.goto(`${ORIGIN}/chat/felix`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#agentChatTitle', { timeout: 10_000 });
  await page.waitForSelector('#agentChatLog .chatwaitmsg', { timeout: 10_000 }).catch(() => {});
  /** The furniture the wait must not move, and the held turns standing in it. */
  const furniture = () => page.evaluate(() => {
    const head = document.querySelector('.chathead')!.getBoundingClientRect();
    const bar = document.getElementById('agentChatForm')?.getBoundingClientRect()
      ?? document.querySelector('.chatwaitbar')!.getBoundingClientRect();
    const pane = document.getElementById('agentChatScroll')?.getBoundingClientRect() ?? null;
    return {
      head: Math.round(head.bottom),
      bar: Math.round(bar.top),
      barHeight: Math.round(bar.height),
      pane: pane ? Math.round(pane.height) : -1,
    };
  });
  const waiting = await furniture();
  const held = await page.evaluate(() => {
    const turns = [...document.querySelectorAll<HTMLElement>('#agentChatLog .chatwaitmsg')];
    const log = document.getElementById('agentChatLog')!;
    const width = log.getBoundingClientRect().width;
    return {
      turns: turns.length,
      agent: turns.filter((node) => node.classList.contains('agent')).length,
      owner: turns.filter((node) => node.classList.contains('owner')).length,
      // Real bubbles, borrowing only their fill: the box, the 86% cap and the
      // cut corner are what make a column of grey read as a conversation.
      boxed: turns.every((node) => node.classList.contains('chatmsg')),
      capped: turns.every((node) => node.getBoundingClientRect().width <= width * 0.87 + 1),
      sided: new Set(turns.map((node) => Math.round(node.getBoundingClientRect().left))).size > 1,
      hidden: turns.every((node) => node.getAttribute('aria-hidden') === 'true'),
      breathing: turns.every((node) => [...node.querySelectorAll('.skel')]
        .every((bar) => getComputedStyle(bar).animationName === 'breathe')),
      busy: log.getAttribute('aria-busy'),
      said: log.querySelector('.sr-only')?.textContent ?? '',
      spinner: Boolean(log.querySelector('#loading')),
    };
  });
  check('a transcript still on its way is held as the conversation it is fetching',
    held.turns >= 3 && held.agent > 0 && held.owner > 0 && !held.spinner, JSON.stringify(held));
  check('…in real message boxes, on both sides, inside the same 86% cap',
    held.boxed && held.capped && held.sided, JSON.stringify(held));
  check('…drawn for nobody, said once in words, and breathing rather than still',
    held.hidden && held.breathing && held.busy === 'true'
      && held.said === 'Loading this conversation…', JSON.stringify(held));
  await view('chat-loading');
  release?.();
  await page.waitForFunction(
    () => document.querySelectorAll('#agentChatLog .chatmsg:not(.chatwaitmsg)').length >= 45,
    { timeout: 10_000 },
  ).catch(() => {});
  const landed = await furniture();
  check('…and the read landing fills the pane rather than moving the furniture',
    landed.head === waiting.head && landed.bar === waiting.bar && landed.pane === waiting.pane,
    `${JSON.stringify(waiting)} → ${JSON.stringify(landed)}`);

  // 9b. A read that failed. The reason belongs IN the pane: the banner that
  //     also carries it fades, and every poll after the opening read is quiet.
  lifecycle.agentChatMessages = undefined;
  await page.goto(`${ORIGIN}/chat/felix`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#agentChatTitle', { timeout: 10_000 });
  await page.waitForSelector('#agentChatFailed', { timeout: 10_000 }).catch(() => {});
  const failed = await text('#agentChatFailed');
  check('a transcript that could not be read says so, in the pane, with the reason',
    failed.includes('could not be loaded') && failed.includes('Chat is not available on this backend yet'), failed);
  check('…and offers the reader a way to ask again',
    Boolean(await page.$('#agentChatFailed .chatretry')));
  check('…rather than inviting a hello into a conversation it never managed to read',
    !failed.includes('say hello'), failed);
  await view('chat-failed');

  // 9c. And the way out works: the same read, answered.
  lifecycle.agentChatMessages = realRead;
  await page.click('#agentChatFailed .chatretry');
  await page.waitForFunction(() => document.querySelectorAll('#agentChatLog .chatmsg').length >= 45, { timeout: 10_000 })
    .catch(() => {});
  check('Try again replaces the failure with the conversation',
    (await page.$$('#agentChatLog .chatmsg')).length >= 45 && !(await page.$('#agentChatFailed')),
    String((await page.$$('#agentChatLog .chatmsg')).length));

  // 9d. The OTHER wait on this screen, and the one nobody could see: the
  //     FLEET read is the one still out, so there is no name to pin and
  //     nobody to send to. The whole screen is held then — and what it holds
  //     is a header and a composer, because a wait that left those out would
  //     lend the transcript their height and take it back the moment the read
  //     landed, which is the whole conversation jumping (note #302).
  // KNOWN AND OPEN (note #563): under heavy load this wait timed out on 1 run
  // in 15. It is not simply the 2.5 s running out — holding the read behind a
  // gate instead made it WORSE (7 in 21): on those runs the document answers
  // in ~360 ms and the app polls normally, yet Puppeteer can neither finish
  // the navigation nor evaluate in the new page until the state read lands.
  // The timer stays because the read landing is what un-sticks it.
  stateDelayMs = 2500;
  await page.goto(`${ORIGIN}/chat/felix`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screenAgentChat .chatwaitbar', { timeout: 10_000 });
  const cold = await page.evaluate(() => {
    const screen = document.getElementById('screenAgentChat')!;
    return {
      busy: screen.getAttribute('aria-busy'),
      turns: screen.querySelectorAll('.chatwaitmsg').length,
      back: screen.querySelector('.chathead .back')?.textContent?.trim() ?? '',
      home: Boolean(screen.querySelector('.chathead [aria-label="Home"]')),
      said: screen.querySelector('.sr-only')?.textContent ?? '',
      // THE HELD PANE IS NOT THE REAL PANE: the opening snap waits on the
      // transcript's own scroller, and a wait that claimed that ref would
      // spend the snap on a box about to be thrown away (note #278).
      claimed: Boolean(screen.querySelector('#agentChatScroll') || screen.querySelector('#agentChatForm')),
      // The shell still ends exactly at the window's bottom edge.
      bottom: Math.round(screen.getBoundingClientRect().bottom),
      inner: window.innerHeight,
    };
  });
  const coldFurniture = await furniture();
  await view('chat-cold-open');
  check('a chat opened before its fleet read is held as a whole chat',
    cold.turns >= 3 && cold.busy === 'true' && cold.said === 'Loading this conversation…', JSON.stringify(cold));
  check('…with Back drawn as itself and no Home action in the held header',
    cold.back.includes('Back') && !cold.home, JSON.stringify(cold));
  check('…claiming neither the transcript\'s scroller nor the composer\'s form',
    !cold.claimed, JSON.stringify(cold));
  check('…and ending at the window\'s own bottom edge, as the shell does',
    Math.abs(cold.bottom - cold.inner) <= 1, JSON.stringify(cold));
  await page.waitForSelector('#agentChatTitle', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('#agentChatLog .chatmsg').length >= 45, { timeout: 10_000 })
    .catch(() => {});
  stateDelayMs = 0;
  const warm = await furniture();
  check('…in the header and composer the real ones then stand in, to the pixel',
    warm.head === coldFurniture.head && warm.bar === coldFurniture.bar
      && warm.barHeight === coldFurniture.barHeight,
    `${JSON.stringify(coldFurniture)} → ${JSON.stringify(warm)}`);
  await atEnd('…and the conversation still opens at its newest message, the wait having taken no scroll');
  await view('chat-cold-open-landed');

  // 10. The way back down (note #334). At the end there is no button; two
  //     panes up there is one, standing INSIDE the transcript's box just
  //     above the composer and off to the right, over the words rather than
  //     in their flow; a tap lands the reader at the newest message and the
  //     button is gone again. Geometry, because that is what jsdom cannot see.
  const jumpAt = () => page.evaluate(() => {
    const anchor = document.querySelector<HTMLElement>('.chatjump');
    const button = document.getElementById('agentChatJump');
    const pane = document.getElementById('agentChatScroll')!;
    const bar = document.getElementById('agentChatForm')!;
    const box = button?.getBoundingClientRect();
    return {
      hidden: anchor?.hidden ?? null,
      shown: Boolean(box && box.height > 0 && anchor && !anchor.hidden),
      box: box ? { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom) } : null,
      pane: { left: Math.round(pane.getBoundingClientRect().left), right: Math.round(pane.getBoundingClientRect().right),
        bottom: Math.round(pane.getBoundingClientRect().bottom) },
      // The COLUMN's right edge: the pane's, less its padding. On a phone the
      // two are 16px apart; on a desk the pane is the window and the column
      // is 720px in the middle of it (note #547), and the button stands over
      // the words either way.
      column: Math.round(pane.getBoundingClientRect().right - parseFloat(getComputedStyle(pane).paddingRight)),
      barTop: Math.round(bar.getBoundingClientRect().top),
      scrollTop: pane.scrollTop,
      gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
    };
  });
  check('at the newest message there is no way-back-down button', (await jumpAt()).hidden === true, JSON.stringify(await jumpAt()));
  await page.evaluate(() => {
    const pane = document.getElementById('agentChatScroll')!;
    pane.scrollTop = pane.scrollTop - pane.clientHeight * 2;
  });
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.chatjump')?.hidden, { timeout: 5_000 }).catch(() => {});
  const up = await jumpAt();
  check('two panes up, the button is there', up.shown, JSON.stringify(up));
  check('…inside the transcript\'s box, above the composer, at the column\'s right edge',
    Boolean(up.box) && up.box!.bottom <= up.barTop && up.box!.bottom <= up.pane.bottom
      && up.box!.right <= up.column && up.box!.right >= up.column - 40
      && up.box!.top > up.pane.bottom - 80,
    JSON.stringify(up));
  await view('chat-jump-shown');
  // What a thumb on the button actually lands on. Here it floats over the
  // Markdown card, whose name is stretched over the whole card: until note
  // #693 the tap went to the card underneath and opened the document.
  const jumpHit = await page.evaluate(() => {
    const box = document.getElementById('agentChatJump')!.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const over = [...document.querySelectorAll('#agentChatLog .chatfileitem')].find((card) => {
      const edge = card.getBoundingClientRect();
      return edge.top < box.bottom && edge.bottom > box.top && edge.left < box.right && edge.right > box.left;
    });
    return { button: Boolean(hit?.closest('#agentChatJump')), hit: hit ? `${hit.tagName}.${hit.getAttribute('class') ?? ''}` : null, over: over?.className ?? null };
  });
  check('…on top of whatever it floats over, so a tap reaches it', jumpHit.button, JSON.stringify(jumpHit));
  await page.click('#agentChatJump');
  await page.waitForFunction(() => {
    const pane = document.getElementById('agentChatScroll')!;
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 2;
  }, { timeout: 5_000 }).catch(() => {});
  const down = await jumpAt();
  check('…and a tap lands the reader at the newest message', down.gap <= 2, JSON.stringify(down));
  check('…where the button is gone again', down.hidden === true, JSON.stringify(down));
  await view('chat-jump-landed');
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
