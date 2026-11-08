// Drives the React Workspace shell's VOICE-TO-TEXT flow in real Chrome
// against a real audio signal: MediaRecorder encodes it, a real AnalyserNode
// reads it, the real route is handed the bytes, and the bars on screen are
// measured while the sound is loud and again while it is silent.
// The account here is a personal one, with no workplace: its Home (`/`) is
// still the one-column overview (`#screenOverview`) with every shelf drawn,
// where a workplace's Home is the Chief of Staff's conversation (note #715).
//
// That is the whole reason this harness exists (note #233). jsdom can prove
// the numbers move when a stubbed analyser is fed a stubbed wave; it cannot
// prove MediaRecorder produces bytes the route accepts, that Web Audio hears
// the stream at all, or that the strip is visible where the composer draws it.
//
// WHERE THE SOUND COMES FROM. An agent machine has no audio backend, so
// Chrome's `--use-fake-device-for-media-capture` finds no device to stand in
// for and `getUserMedia` fails with NotFoundError; adding `--alsa-*-device=null`
// gets a device that is silent, which is the one thing a level meter must not
// be tested against. So the page mints its own: an oscillator into a
// `MediaStreamAudioDestinationNode`, which is a real MediaStream carrying a
// real waveform, handed back from `getUserMedia`. Everything downstream of the
// device is the production path, and the harness can turn the volume down —
// which is what makes "the bars follow the microphone" a checkable claim
// rather than "the bars move".
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-workspace-react-voice.mts
//
// `--shell <dir>` re-points the run at a different built shell; `CHROME=<path>`
// overrides the browser. Screenshots land in ~/mini-preview/.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { settleAfterShot, tap } from './browser-settle.mjs';
import { workspaceRoutes } from '../backend/src/routes/workspace.js';
import { workspaceRootRoutes } from '../backend/src/routes/workspace-root.js';
import type { RouteDeps } from '../backend/src/routes/deps.js';
import { InMemoryQuickNoteStorage } from '../backend/src/services/quick-note-storage.js';
import { InMemoryOrgStorage } from '../backend/src/services/org-storage.js';
import { InMemoryUserStorage } from '../backend/src/services/user-storage.js';
import { SecretCipher } from '../backend/src/services/secret-cipher.js';
import {
  InMemoryWorkspaceWebAuthStorage,
  WorkspaceWebAuthService,
} from '../backend/src/services/workspace-web-auth.js';
import { harnessMailService, harnessSignedIn } from './workspace-harness-auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};
const SHELL = flag('--shell', path.join(REPO, 'backend/dist/workspace-ui'));
function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const builds = readdirSync(root).filter((name) => name.startsWith('linux-')).sort();
  const build = builds[builds.length - 1];
  if (!build) throw new Error(`no Chrome under ${root} — run: npx puppeteer browsers install chrome`);
  return path.join(root, build, 'chrome-linux64/chrome');
}
const CHROME = findChrome();
const PORT = Number(process.env.PORT || 4179);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const userStorage = new InMemoryUserStorage();
// Signing up has needed a confirmed address since 2026-09-11. This is the
// harness's own mailbox: it keeps the link the router mints so the browser
// can follow it, exactly as a person follows the one in their mail.
const mailbox = harnessMailService(`${ORIGIN}/`);
const workspaceWebAuth = new WorkspaceWebAuthService(
  new InMemoryWorkspaceWebAuthStorage(),
  userStorage,
  new SecretCipher(randomBytes(32).toString('base64')),
  () => new Date(),
  mailbox.config,
  mailbox.mailboxes,
);

/** What the recording came back as, plus what the route was actually handed —
 *  the size and the container are the half a jsdom test cannot produce. */
const quickNoteStorage = new InMemoryQuickNoteStorage();

const uploads: Array<{ bytes: number; contentType: string }> = [];
const sentMessages: string[] = [];
const sentFiles: string[][] = [];
// The workplace's own key and model are the service's business (note #1026);
// this harness only needs the words back and what the route handed over.
// Voice-to-text belongs to a WORKPLACE (note #1026): a recording with no
// workplace is "not set up". The account joins one for the recording steps
// below and leaves it before the steps that need a personal Home.
const orgStorage = new InMemoryOrgStorage();
const voiceOrg = await orgStorage.createOrg({ name: 'Harness', createdByUserId: 'harness' });
const workplaceVoice = {
  answer: async () => ({ state: 'on', model: { id: 'fake', name: 'Fake' }, admins: [], canChange: true }),
  models: async () => ({ models: [], pricesCheckedAt: null }),
  transcribe: async (_orgId: string, args: { audio: Buffer; contentType: string }) => {
    uploads.push({ bytes: args.audio.byteLength, contentType: args.contentType });
    return { text: 'ship it on Friday', model: 'fake' };
  },
} as unknown as RouteDeps['workplaceVoice'];

const agentLifecycle = {
  createAgent: async () => ({ ok: true as const }),
  agentVersion: async () => ({
    cliLabel: 'Claude Code', installed: '1.2.3', busy: false,
    machine: { awake: true, region: 'ams', regionName: 'Amsterdam', memoryMb: 4096 },
    model: 'opus', effort: 'high', lastActiveAt: iso(5), turnCount: 3,
  }),
  isAgentWorking: () => false,
  agentActivity: () => null,
  agentChatMessages: async () => [
    { seq: 1, role: 'owner' as const, text: 'Morning!', at: iso(30) },
    { seq: 2, role: 'agent' as const, text: 'Morning — what are we building?', at: iso(29) },
  ],
  latestAgentChatMessage: async () => ({ text: 'Morning — what are we building?', at: iso(29) }),
  chatMessageAgentFromUser: async (args: { message: string; attachments?: Array<{ fileName: string }> }) => {
    sentMessages.push(args.message);
    sentFiles.push((args.attachments ?? []).map((file) => file.fileName));
    return { ok: true as const, recipient: { id: 'felix', name: 'Felix', cli: 'claude' as const } };
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
  workplaceVoice,
  orgStorage,
  quickNoteStorage,
} as unknown as RouteDeps;

const app = express();
app.use(express.json());
// What the microphones read before recording (note #1026): in this world the
// workplace's voice-to-text is on, whichever Home the account stands on.
app.get('/workspace/api/voice', (_req, res) => {
  res.json({ state: 'on', model: { id: 'fake', name: 'Fake' }, admins: [], canChange: true });
});
app.use('/workspace', workspaceRoutes(deps));
// The shell itself answers at the root of the domain (public-addresses).
app.use(workspaceRootRoutes({ workspaceUiDir: deps.workspaceUiDir }));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

/**
 * A microphone for a machine that has none: an oscillator into a media-stream
 * destination, handed back by `getUserMedia`. `setLoudness(0)` is the room
 * going quiet, which the bars have to follow down.
 */
async function installMicrophone(page: import('puppeteer-core').Page): Promise<void> {
  // Passed as source rather than as a function: tsx compiles a callback's
  // inner arrows through esbuild's keepNames, which injects a `__name` helper
  // that does not exist in the page and fails at the first call.
  await page.evaluate(`(() => {
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const gain = context.createGain();
    const oscillator = context.createOscillator();
    oscillator.type = 'sawtooth';
    oscillator.frequency.value = 220;
    gain.gain.value = 0.6;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    window.__voiceGain = gain;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: function () { return Promise.resolve(destination.stream); } },
    });
  })()`);
}

const setLoudness = (page: import('puppeteer-core').Page, level: number) => page.evaluate(
  `window.__voiceGain.gain.value = ${level};`,
);

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    // The page builds its own audio source before any tap, so its AudioContext
    // must be allowed to run without a gesture.
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const consoleErrors: string[] = [];
  // Two answers are the shell working rather than failing: `auth/session`
  // answers 401 to the boot probe that asks whether anybody is signed in, and
  // nothing here serves a favicon. Everything else is a real complaint — and
  // the browser's own "Failed to load resource" line for those two comes
  // through the console, so it is dropped by the same rule.
  const expected = (line: string) => /auth\/session|favicon\.ico/.test(line)
    || (/Failed to load resource/.test(line) && /401|404/.test(line));
  page.on('console', (message) => {
    if (message.type() === 'error' && !expected(message.text())) consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    const where = `${response.status()} ${new URL(response.url()).pathname}`;
    if (response.status() >= 400 && !expected(where)) {
      // Which request and what the server said, so a red names its cause
      // rather than only a status (note #1075: a lone 403 on this route under
      // load said nothing else).
      const at = consoleErrors.push(`${where} (${response.request().method()})`) - 1;
      void response.text().then((body) => { consoleErrors[at] += ` ${body.slice(0, 160)}`; }).catch(() => {});
    }
  });
  const view = (name: string) => page.screenshot({ path: path.join(OUT, `n233-${name}.png`) as `${string}.png` });
  const shot = async (name: string) => {
    await page.screenshot({ path: path.join(OUT, `n233-${name}.png`) as `${string}.png`, fullPage: true });
    await settleAfterShot(page);
  };
  await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['microphone']);

  // 1. Access, and one agent to write to.
  await harnessSignedIn(page, workspaceWebAuth, ORIGIN, 'saddam@example.com');
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  const [me] = await userStorage.getAllUsers();
  if (!me) throw new Error('enrollment created no user');
  await userStorage.updateProfile(me.userId, {
    telegram: {
      ...(me.telegram ?? {}),
      agents: {
        felix: {
          id: 'felix', name: 'Felix', cli: 'claude', createdAt: iso(4320), serverId: 'm1',
          connectedAt: iso(4320), lastActivityAt: iso(5), model: 'opus', effort: 'high',
        },
      } as never,
    },
  });

  // 2. The chat composer, with words already in the box: dictation has to land
  //    beside them rather than replace them. In a workplace, which is what
  //    voice-to-text is paid by (note #1026).
  await orgStorage.addMember({ orgId: voiceOrg.orgId, userId: me.userId, role: 'admin' });
  await page.goto(`${ORIGIN}/chat/felix`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#agentChatText', { timeout: 15_000 });
  // Exercise the browser's REAL permission path before substituting our
  // controllable waveform. A mocked getUserMedia bypasses Permissions-Policy
  // and previously let microphone=() pass every voice check.
  const allowed = await page.evaluate('document.featurePolicy.allowsFeature("microphone")') as boolean;
  check('the delivered page policy allows this origin to request a microphone', allowed);
  await tap(page, '.chatinput .voicebtn');
  await page.waitForFunction(() => document.querySelector('.voicereview-stop') || document.querySelector('.voicereview-error'));
  check('a mic tap records through native getUserMedia after browser permission is granted',
    Boolean(await page.$('.voicereview-stop')));
  await view('native-microphone');
  await tap(page, '.voicereview-back');
  await installMicrophone(page);
  await tap(page, '#agentChatText');
  await page.type('#agentChatText', 'Tell Ada');
  const mic = await page.$('.chatinput .voicebtn');
  check('the chat composer has a microphone', Boolean(mic));
  check('it says what it dictates into',
    (await page.$eval('.chatinput .voicebtn', (node) => node.getAttribute('aria-label'))) === 'Dictate into Message');
  await view('composer-idle');

  // 3. Record. The button turns into Stop and the wave appears.
  await tap(page, '.chatinput .voicebtn');
  // Either the wave appears or the app says why it could not; waiting only for
  // the wave turns a refusal into an unexplained timeout.
  await page.waitForFunction(
    () => document.querySelector('.voicereview .voicewave') || document.querySelector('.voicereview-error'),
    { timeout: 15_000 },
  );
  const refusal = await page.$eval('#banner', (node) => node.textContent ?? '').catch(() => '');
  check('the microphone starts', !refusal, refusal);
  const bars = await page.$$eval('.voicewave > span', (nodes) => nodes.length);
  check('the wave is drawn as a strip of bars', bars >= 20, `${bars} bars`);
  check('the button is the stop, and it knows the analyser is running',
    (await page.$eval('.chatinput .voicebtn', (node) => node.className)).includes('metered'),
    await page.$eval('.chatinput .voicebtn', (node) => node.className));
  check('the keyboard is put away while recording',
    await page.evaluate(() => document.activeElement?.id !== 'agentChatText'));
  const modal = await page.$eval('.voicereview', (node) => {
    const rect = node.getBoundingClientRect();
    // Whole pixels: a dialog still finishing its entrance reads 859.99997 (note #1075).
    return { modal: node.matches(':modal'), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  });
  check('chat dictation fills the phone and makes the conversation inert',
    modal.modal && modal.x === 0 && modal.y === 0 && modal.width === 420 && modal.height === 860, JSON.stringify(modal));
  await page.focus('#agentChatText');
  check('focus cannot escape the recorder into the chat underneath',
    await page.evaluate(() => Boolean(document.activeElement?.closest('.voicereview'))));

  // 4. The bars must MOVE, and must move with the sound rather than on a
  //    timer. Sampled over a second of the fake device's tone.
  const scales = () => page.$$eval('.voicewave > span', (nodes) => nodes.map((node) => {
    const found = /scaleY\(([\d.]+)\)/.exec((node as HTMLElement).style.transform);
    return found ? Number(found[1]) : NaN;
  }));
  const sample = async (takes: number) => {
    const rows: number[][] = [];
    for (let take = 0; take < takes; take += 1) {
      rows.push(await scales());
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    return rows;
  };
  const loud = await sample(12);
  const drawn = loud.filter((row) => row.length > 0 && row.every((value) => Number.isFinite(value)));
  const peak = Math.max(...drawn.flat());
  const distinct = new Set(drawn.map((row) => row.join(','))).size;
  check('every bar is given a height', drawn.length === loud.length, `${drawn.length}/${loud.length} frames`);
  check('the microphone signal reaches the bars', peak > 0.2, `peak scale ${peak.toFixed(3)}`);
  // A still picture is ONE distinct frame. Until 2026-10-08 this asked for all
  // but one of the twelve to differ, which measured the CI machine's cores
  // rather than the strip: a Chrome short of CPU paints fewer frames than we
  // sample, so two samples read the same paint. Main's run of 06c73e1d went
  // red on 10 of 12, and the same commit had passed on its branch an hour
  // earlier. Locally it passed 6 of 6, and with three `yes` loops on two cores
  // it failed 4 of 4 at 7 or 8. A third of the samples still tells a moving
  // strip from a frozen one. Moving WITH the sound is the fall-to-quiet check
  // below, not this one.
  //
  // And since note #1075 it is a STATE, not a rate. A third of twelve still
  // asked how many frames a starved Chrome paints in a second: with four
  // checks on two busy cores it read 3 of 12. So the sampling carries on,
  // at the same pace, until four different paints have been seen, for up to
  // sixty samples (about six seconds plus the reads). A still picture never
  // gets past one however long it is watched; a living strip gets to four.
  const paints = new Set(drawn.map((row) => row.join(',')));
  let watched = loud.length;
  while (paints.size < 4 && watched < 60) {
    const row = await scales();
    if (row.length > 0 && row.every((value) => Number.isFinite(value))) paints.add(row.join(','));
    watched += 1;
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  check('the strip is alive rather than a still picture', paints.size >= 4,
    `${paints.size} distinct frames in ${watched} samples (${distinct} in the first ${drawn.length})`);
  await view('composer-recording-loud');
  // The bar on its own, at the size a thumb sees it: a full-page shot puts the
  // one control this note is about into forty pixels of a phone screen.
  const closeUp = async (name: string) => {
    const bar = await page.$('.voicereview-wave');
    await bar?.screenshot({ path: path.join(OUT, `n233-${name}.png`) as `${string}.png` });
  };
  await closeUp('closeup-loud');

  // The room goes quiet. A meter reading the microphone falls to its floor; a
  // decorative animation would carry on exactly as before.
  await setLoudness(page, 0);
  // Waited for rather than sampled a fixed number of times: the strip holds a
  // second of history and the analyser smooths on top of that, so how long the
  // fall takes is a property of the meter, not a number this harness may pick.
  const fell = await page.waitForFunction(
    () => [...document.querySelectorAll('.voicewave > span')].every((node) => {
      const found = /scaleY\(([\d.]+)\)/.exec((node as HTMLElement).style.transform);
      return found ? Number(found[1]) < 0.15 : false;
    }),
    { timeout: 8_000 },
  ).then(() => true, () => false);
  const settledQuiet = Math.max(...(await scales()));
  check('the bars fall to the floor when the room goes quiet',
    fell && settledQuiet < peak / 2, `quiet peak ${settledQuiet.toFixed(3)} vs loud ${peak.toFixed(3)}`);
  await view('composer-recording-quiet');
  await closeUp('closeup-quiet');
  await setLoudness(page, 0.6);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const ring = await page.$eval('.chatinput .voicebtn', (node) => (node as HTMLElement).style.getPropertyValue('--voicelevel'));
  check('the ring around the button carries the same level', Number(ring) > 0, `--voicelevel: ${ring || '(unset)'}`);
  const strip = await page.$eval('.voicereview .voicewave', (node) => {
    const box = node.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height), visible: box.width > 300 && box.height > 150 };
  });
  check('the wave is large enough to read across the screen', strip.visible, JSON.stringify(strip));
  await view('composer-recording');

  // 5. Stop: the recording goes up as real audio and the words come back into
  //    the box, after the ones already typed.
  await tap(page, '.voicereview-stop');
  await page.waitForFunction(
    () => (document.getElementById('agentChatText') as HTMLTextAreaElement | null)?.value.includes('Friday'),
    { timeout: 20_000 },
  );
  const composed = await page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value);
  check('the transcript lands after the words already typed', composed === 'Tell Ada ship it on Friday', composed);
  check('the route was handed a real recording',
    uploads.length === 1 && (uploads[0]?.bytes ?? 0) > 500 && Boolean(uploads[0]?.contentType.startsWith('audio/')),
    JSON.stringify(uploads));
  check('the wave goes with the recording', (await page.$('.voicewave')) === null);
  check('the button is a microphone again',
    (await page.$eval('.chatinput .voicebtn', (node) => node.getAttribute('aria-label'))) === 'Dictate into Message');
  await view('composer-after');
  check('stopping opens the full-screen editor without sending',
    Boolean(await page.$('.voicereview-text')) && sentMessages.length === 0);
  const editor = await page.$eval('.voicereview-text', (node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height, font: getComputedStyle(node).fontSize, value: (node as HTMLTextAreaElement).value };
  });
  check('the transcript is a page of editable text', editor.height > 500 && editor.font === '22px' && editor.value === composed, JSON.stringify(editor));
  await tap(page, '.voicereview-text');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.type('Tell Ada: ship it on Monday.\nPlease check the mobile version first.');
  // This is a document editor: Enter makes a line even on a desktop.
  check('editing and line breaks do not send the draft', sentMessages.length === 0);
  await view('review-edited');

  // 5a. The review is a complete composer now (note #335): its own picker
  //     reaches the same draft, and a picture must open ABOVE the native
  //     modal rather than in the document underneath its top layer.
  const choose = page.waitForFileChooser();
  await tap(page, '.voicereview-attach');
  await (await choose).accept([path.join(REPO, 'public/away/walk.jpg')]);
  await page.waitForSelector('.voicereview-draft:not([hidden]) .chatdraftitem');
  const picked = await page.$eval('.voicereview-draft .chatdraftitem .name', (node) => node.textContent ?? '');
  check('files can be attached without leaving the review', picked === 'walk.jpg', picked);
  await view('review-with-file');
  await tap(page, '.voicereview-draft .chatdraftopen');
  await page.waitForSelector('#imageViewer');
  const preview = await page.$eval('#imageViewer', (node) => {
    const box = node.getBoundingClientRect();
    return {
      insideReview: Boolean(node.parentElement?.matches('.voicereview')),
      width: Math.round(box.width), height: Math.round(box.height), name: document.getElementById('imageViewerName')?.textContent ?? '',
    };
  });
  check('a picked picture opens full screen over the review',
    preview.insideReview && preview.width === 420 && preview.height === 860 && preview.name === 'walk.jpg', JSON.stringify(preview));
  await view('review-file-fullscreen');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#imageViewer', { hidden: true });
  check('closing the picture returns to the same review and keeps the file',
    Boolean(await page.$('.voicereview-text')) && Boolean(await page.$('.voicereview-draft:not([hidden]) .chatdraftitem')));

  await page.setViewport({ width: 420, height: 420, deviceScaleFactor: 2 });
  // setViewport returns before the browser delivers its resize event.
  await page.waitForFunction(() => document.querySelector('.voicereview')?.getBoundingClientRect().height === window.innerHeight);
  const short = await page.$eval('.voicereview-actions', (node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: window.innerHeight };
  });
  check('Send stays reachable with a keyboard-sized viewport', short.top >= 0 && short.bottom <= short.height, JSON.stringify(short));
  await view('review-keyboard');
  // iOS can keep a tall layout viewport and cover its bottom with keys.
  // Deliver that reading, including its pan, to the actual modal listener.
  await page.evaluate(`(() => {
    const actual = window.visualViewport;
    const viewport = new EventTarget();
    Object.assign(viewport, { height: 300, offsetTop: 24 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    window.dispatchEvent(new Event('resize'));
    const dialog = document.querySelector('.voicereview').getBoundingClientRect();
    const send = document.querySelector('.voicereview-actions').getBoundingClientRect();
    window.__voiceGeometry = { top: Math.round(dialog.top), height: Math.round(dialog.height), sendBottom: Math.round(send.bottom) };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: actual });
    window.dispatchEvent(new Event('resize'));
  })()`);
  const covered = await page.evaluate('window.__voiceGeometry') as { top: number; height: number; sendBottom: number };
  check('a covering keyboard and viewport pan keep the editor and Send in sight',
    covered.top === 24 && covered.height === 300 && covered.sendBottom <= 324, JSON.stringify(covered));
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.waitForFunction(() => document.querySelector('.voicereview')?.getBoundingClientRect().height === window.innerHeight);
  await view('review-desktop');
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  await page.waitForFunction(() => document.querySelector('.voicereview')?.getBoundingClientRect().height === window.innerHeight);
  await tap(page, '.voicereview-actions .primary');
  await page.waitForSelector('.voicereview', { hidden: true });
  // The dialog closes on the press; the send is a request still on its way.
  // Reading the fake's list the moment the dialog was gone read [] on a
  // loaded machine, 1 round in 20 (note #1075). Wait for the request to land,
  // then for the composer to clear (the send's own answer), then count, so
  // "exactly once" is still counted after the answer rather than before it.
  for (const until = Date.now() + 10_000; sentMessages.length === 0 && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await page.waitForFunction(() => (document.getElementById('agentChatText') as HTMLTextAreaElement | null)?.value === '', { timeout: 10_000 })
    .catch(() => {});
  check('Send delivers the corrected words exactly once and returns to chat',
    sentMessages.length === 1 && sentMessages[0] === 'Tell Ada: ship it on Monday.\nPlease check the mobile version first.', JSON.stringify(sentMessages));
  check('the file picked in the review travels with those words',
    sentFiles.length === 1 && sentFiles[0]?.length === 1 && sentFiles[0]?.[0] === 'walk.jpg', JSON.stringify(sentFiles));
  check('a successful voice send clears the composer',
    (await page.$eval('#agentChatText', (node) => (node as HTMLTextAreaElement).value)) === '');

  // 6. The same control on a note. It no longer draws an inline wave over the
  //    box: since the recorder came off chat and onto notes (note #365) the
  //    note's microphone opens the SAME full-screen dialog, and its depth is
  //    covered by scripts/verify-voice-on-a-note.mts. What is worth proving
  //    here is only that the two screens really do share the one recorder.
  // Back to a personal account: its Home is the overview this step needs.
  // Off the chat FIRST: it polls its transcript with ?org= every few seconds,
  // and a poll landing after the membership is gone is answered 403 "You do
  // not belong to this workplace", which the console check then reports. Under
  // load that gap was caught 1 run in 10 (note #1075). about:blank stops every
  // poll before anything changes.
  await page.goto('about:blank');
  await orgStorage.removeMember(voiceOrg.orgId, me.userId);
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenOverview #newNoteBtn', { timeout: 15_000 });
  await tap(page, '#newNoteBtn');
  await page.waitForSelector('#screenNoteNew #noteText', { timeout: 15_000 });
  // The recording is still paid by a workplace, so the account rejoins one
  // before it speaks.
  await orgStorage.addMember({ orgId: voiceOrg.orgId, userId: me.userId, role: 'admin' });
  await installMicrophone(page);
  await page.type('#noteText', 'Bring the drill on Thursday.\nAsk about the gate.\nThe code is on the fridge.');
  check('a note is dictated into too', Boolean(await page.$('.voicefield > #noteText')));
  await tap(page, '#screenNoteNew .voicebtn');
  await page.waitForSelector('dialog.voicereview[open]', { timeout: 15_000 });
  const noteRecorder = await page.$eval('dialog.voicereview', (node) => node.textContent ?? '');
  check('a note opens the same full-screen recorder, in its own words',
    noteRecorder.includes('Voice note') && !noteRecorder.includes('Voice message'), noteRecorder.slice(0, 60));
  await shot('note-composer');
  await tap(page, 'button[aria-label="Stop recording"]');
  await page.waitForFunction(
    () => (document.querySelector('.voicereview-text') as HTMLTextAreaElement | null)?.value.includes('Friday'),
    { timeout: 20_000 },
  );
  const noteWords = await page.$eval('.voicereview-text', (node) => (node as HTMLTextAreaElement).value);
  check('a note keeps the words it had and gains the dictated ones',
    noteWords.endsWith('fridge. ship it on Friday'), noteWords);
  // The note's review carries the note's own verb, not chat's. It offers no
  // attach button here because this fixture's backend holds no note files —
  // which is the documented behaviour, and the case where files ARE on is
  // covered end to end by scripts/verify-voice-on-a-note.mts.
  const noteReview = await page.$eval('dialog.voicereview', (node) => node.textContent ?? '');
  check('and it offers to save, in the note\'s own words',
    noteReview.includes('Save note') && !noteReview.includes('Send message'), noteReview.slice(0, 70));
  await shot('note-composer-after');

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
