// Opens the real Workspace shell on a note and drives its microphone in Chrome,
// so the full-screen recorder note #365 asked for is seen rather than assumed:
// the recording stage, then the review editor, in the note's own words. Note
// #454 also drives a typed draft and a voice transcript through their growing
// textareas, before and after the bounded inner-scroll threshold.
//
// Chrome is given a fake microphone (`--use-fake-device-for-media-stream`), so
// the permission is granted and the stream is a test tone rather than silence.
// The transcribe route is stubbed — what is under test is the SCREEN, not the
// transcriber, which has its own tests at the other end of the wire.
//
//   cd backend && npm run build:workspace-ui
//   backend/node_modules/.bin/tsx scripts/verify-voice-on-a-note.mts
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const express = createRequire(new URL('../backend/package.json', import.meta.url))('express') as typeof import('express');
const OUT = process.env.OUT_DIR || path.join(process.env.HOME || '/home/agent', 'mini-preview');
mkdirSync(OUT, { recursive: true });
const UI = path.join(REPO, 'backend/dist/workspace-ui');
const PORT = Number(process.env.PORT || 4189);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(process.env.HOME || '/home/agent', '.cache/puppeteer/chrome');
  const build = readdirSync(root).filter((name) => name.startsWith('linux-')).sort().pop();
  if (!build) throw new Error(`no Chrome under ${root}`);
  return path.join(root, build, 'chrome-linux64/chrome');
}

const HEARD = Array.from({ length: 9 }, (_, index) => `Spoken line ${index + 1}.`).join('\n');
const TYPED = Array.from({ length: 10 }, (_, index) =>
  `Typed line ${index + 1} stays in the note field.`).join('\n');
const note = {
  id: 'n21', number: 21, title: 'Call the plumber back', preview: 'Call the plumber back',
  html: '<p>Call the plumber back — he is closed Mondays.</p>',
  createdAt: '2026-09-05T09:00:00Z', updatedAt: '2026-09-05T09:00:00Z', comments: [],
};

const app = express();
app.use(express.json());
app.get('/workspace/auth/session', (_req, res) => res.json({
  authenticated: true, username: 'saddam', displayName: 'Saddam',
  session: { sessionId: 's1', createdAt: 't', lastSeenAt: 't', absoluteExpiresAt: 't' },
}));
app.get('/workspace/api/state', (_req, res) => res.json({
  org: { orgId: 'o1', name: 'Org #0', role: 'admin', members: 1, seats: 0, seatProviders: [] },
  organizations: [{ orgId: 'o1', name: 'Org #0', role: 'admin', active: true, members: 1, agents: 1 }],
  canCreateOrg: true,
  user: {
    name: 'Saddam', profile: { firstName: 'Saddam', lastName: '', incomplete: false },
    account: { browserLogin: { enabled: true, username: 'saddam' } },
  },
  agents: [], prs: [], knowledgeProposals: [],
  secrets: null, repos: null, sites: null, knowledge: null, notes: [note], notesArchived: 0, noteFiles: true,
}));
app.get('/workspace/api/notes/21', (_req, res) => res.json({ note }));
// The recording goes up as raw bytes; answer with words worth correcting.
app.post('/workspace/api/transcribe', (_req, res) => res.json({ text: HEARD }));
app.get('/workspace/api/org/cloud', (_req, res) => res.json({
  orgId: 'o1', role: 'admin', fly: { connected: false }, machines: null,
}));
app.get('/workspace/api/agents/live', (_req, res) => res.json({ agents: [], recaps: [], sessionLimits: [] }));
app.get('/workspace/api/notifications', (_req, res) => res.json({
  notifications: [], unread: 0, push: { available: false, subscriptions: 0 },
}));
app.get('/workspace/api/*', (_req, res) => res.json({}));
app.use('/workspace/app/assets', express.static(path.join(UI, 'assets')));
app.get('*', (_req, res) => res.sendFile(path.join(UI, 'index.html')));
const server = app.listen(PORT, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true,
  args: [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    // A microphone that always answers, playing a tone rather than silence.
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
try {
  const context = browser.defaultBrowserContext();
  await context.overridePermissions(ORIGIN, ['microphone']);
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => check('no page error', false, String(error)));
  const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) as `${string}.png` });
  const dialogText = () => page.$eval('dialog.voicereview', (node) => node.textContent ?? '').catch(() => '');
  const textareaShape = (selector: string) => page.$eval(selector, (node) => {
    const field = node as HTMLTextAreaElement;
    const style = getComputedStyle(field);
    return {
      height: Math.round(field.getBoundingClientRect().height),
      clientHeight: field.clientHeight,
      scrollHeight: field.scrollHeight,
      overflowY: style.overflowY,
      maxHeight: style.maxHeight,
      value: field.value,
    };
  });

  // 1. Open the note, and its comment box.
  await page.goto(`${ORIGIN}/notes/21?org=o1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#screenNote', { timeout: 10_000 });
  const commentBtn = await page.waitForSelector('::-p-text(Write a comment)', { timeout: 10_000 });
  await commentBtn!.click();

  // 2. Dictate into it: the recorder should take the WHOLE screen.
  await page.waitForSelector('button[aria-label^="Dictate into"]', { timeout: 10_000 });
  await page.click('button[aria-label^="Dictate into"]');
  await page.waitForSelector('dialog.voicereview[open]', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('dialog.voicereview')?.textContent?.includes('Listening'), { timeout: 10_000 });
  await shot('n365-comment-recording');
  const recording = await dialogText();
  check('the recorder fills the screen over the margin', recording.includes('Voice comment'), recording.slice(0, 90));
  check('it says it is listening', recording.includes('Listening'));
  const box = await page.$eval('dialog.voicereview', (node) => {
    const rect = node.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height) };
  });
  check('it really is full screen', box.w >= 400 && box.h >= 700, `${box.w}×${box.h}`);

  // 3. Stop, and land in the review editor holding the words.
  await page.click('button[aria-label="Stop recording"]');
  await page.waitForFunction(
    (want: string) => (document.querySelector('.voicereview-text') as HTMLTextAreaElement | null)?.value === want,
    { timeout: 20_000 }, HEARD,
  );
  await shot('n365-comment-review');
  const review = await dialogText();
  check('the words land in a full-screen editor', review.includes('Review comment'), review.slice(0, 90));
  check('and it offers to post them, not to send a message', review.includes('Post comment') && !review.includes('Send message'));
  check('the margin has no attach button', !review.includes('Attach files'));

  // 4. The same over a note's own words.
  await page.click('.voicereview-back');
  // The report came from a phone; use the owner's ordinary narrow reading
  // width for the two growth states that become proposal evidence.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  // The composer is transient and has no address of its own, so it is reached
  // the way a person reaches it: from the notes list.
  await page.goto(`${ORIGIN}/notes?org=o1`, { waitUntil: 'networkidle0' });
  const write = await page.waitForSelector('::-p-text(Write a note)', { timeout: 10_000 });
  await write!.click();
  await page.waitForSelector('#noteText', { timeout: 10_000 });
  const initialNote = await textareaShape('#noteText');
  await page.type('#noteText', TYPED);
  await page.waitForFunction(() => {
    const field = document.querySelector<HTMLTextAreaElement>('#noteText');
    return Boolean(field && field.getBoundingClientRect().height > 200 && field.scrollHeight <= field.clientHeight + 1);
  });
  const typedNote = await textareaShape('#noteText');
  check('ordinary typing grows the note until every line is visible',
    typedNote.height > initialNote.height && typedNote.scrollHeight <= typedNote.clientHeight + 1,
    JSON.stringify({ initialNote, typedNote }));
  await shot('n454-note-typed-grown');

  await page.type('#noteText', '\n' + Array.from({ length: 35 }, (_, index) => `Long line ${index + 1}.`).join('\n'));
  await page.waitForFunction(() => {
    const field = document.querySelector<HTMLTextAreaElement>('#noteText');
    return Boolean(field && field.scrollHeight > field.clientHeight + 1);
  });
  const cappedNote = await textareaShape('#noteText');
  const noteCap = Number.parseFloat(cappedNote.maxHeight);
  check('the typed note scrolls internally only after its bounded maximum',
    Math.abs(cappedNote.height - noteCap) <= 1
      && cappedNote.scrollHeight > cappedNote.clientHeight
      && cappedNote.overflowY === 'auto',
    JSON.stringify(cappedNote));
  await shot('n454-note-typed-capped');

  await page.click('#noteText');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => {
    const field = document.querySelector<HTMLTextAreaElement>('#noteText');
    return Boolean(field && !field.value && field.getBoundingClientRect().height < 140);
  });
  await page.click('button[aria-label^="Dictate into"]');
  await page.waitForSelector('dialog.voicereview[open]', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('dialog.voicereview')?.textContent?.includes('Listening'), { timeout: 10_000 });
  check('a note records full screen too', (await dialogText()).includes('Voice note'));
  await page.click('button[aria-label="Stop recording"]');
  await page.waitForFunction(
    (want: string) => (document.querySelector('.voicereview-text') as HTMLTextAreaElement | null)?.value === want,
    { timeout: 20_000 }, HEARD,
  );
  const voiceReview = await textareaShape('.voicereview-text');
  const voiceDraft = await textareaShape('#noteText');
  const voiceAutogrow = await page.$eval('.voicereview-editor', (node) => node.classList.contains('autogrow'));
  check('the voice transcript grows its note review until every spoken line is visible',
    voiceAutogrow && voiceReview.height > 200 && voiceReview.scrollHeight <= voiceReview.clientHeight + 1,
    JSON.stringify(voiceReview));
  check('the same transcript grows the note field waiting underneath',
    voiceDraft.value === HEARD && voiceDraft.height > initialNote.height
      && voiceDraft.scrollHeight <= voiceDraft.clientHeight + 1,
    JSON.stringify(voiceDraft));
  await shot('n454-note-voice-grown');
  const noteReview = await dialogText();
  check('the note review says what it will do', noteReview.includes('Review note') && noteReview.includes('Save note'), noteReview.slice(0, 90));

  // 5. The note's FILES, picked from inside the dialog — the point being that
  // you never have to leave it to attach the photograph the note is about.
  const picker = await page.$('#voiceReviewFile');
  check('the note review offers to attach', Boolean(picker));
  await picker!.uploadFile(path.join(REPO, 'scripts/fixtures/chat-screenshot.png'));
  await page.waitForSelector('dialog.voicereview .chatdraftitem', { timeout: 10_000 });
  await shot('n387-note-review-files');
  check('the pick is drawn inside the dialog',
    await page.$eval('dialog.voicereview', (node) => Boolean(node.querySelector('.chatdraftitem'))));
  check('and it is named there', (await dialogText()).includes('chat-screenshot.png'));

  // The shape he asked for in note #387: "let's remove '8 words, 1 file
  // attached'. Let's put 'Attach files' button there. And let's put small
  // attachments below big text input area."
  //
  // Note #381 came from an iPhone holding portrait screenshots here: shown
  // the way the note screen shows them, one pick was tall enough to crowd
  // the editor and the actions out of this modal. #381 capped that preview at
  // 240px; this answers it at the root, by making a pick inside this editor
  // one small chip below the box. A tap still opens the original.
  const layout = await page.$eval('dialog.voicereview', (node) => {
    const strip = node.querySelector('.voicereview-draft')!;
    const editor = node.querySelector('.voicereview-editor')!;
    const actions = node.querySelector('.voicereview-actions')!;
    const attach = node.querySelector('.voicereview-attach')!;
    const thumb = node.querySelector('.voicereview-draft .preview')!.getBoundingClientRect();
    return {
      words: /\d+ words?/.test(node.textContent ?? ''),
      counted: /files? attached/.test(node.textContent ?? ''),
      stripAfterEditor: Boolean(editor.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING),
      actionsLast: Boolean(strip.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING),
      attachInRow: Boolean(attach.closest('.voicereview-sendrow')),
      attachLeftOfSave: Math.round(attach.getBoundingClientRect().left)
        < Math.round(node.querySelector('.voicereview-sendrow .btn')!.getBoundingClientRect().left),
      thumb: { w: Math.round(thumb.width), h: Math.round(thumb.height) },
      editorHeight: Math.round(editor.getBoundingClientRect().height),
    };
  });
  check('nothing counts the words or the files at the reader', !layout.words && !layout.counted, JSON.stringify(layout));
  check('the picks sit below the box, and the buttons below them',
    layout.stripAfterEditor && layout.actionsLast, JSON.stringify(layout));
  check('Attach stands in the action row, left of the button that commits',
    layout.attachInRow && layout.attachLeftOfSave, JSON.stringify(layout));
  check('a portrait screenshot is a small chip, not the screen',
    layout.thumb.w <= 48 && layout.thumb.h <= 48 && layout.editorHeight > layout.thumb.h * 3,
    JSON.stringify(layout));
  await page.setViewport({ width: 420, height: 300, deviceScaleFactor: 2 });
  await page.waitForFunction(() => document.querySelector('.voicereview')?.getBoundingClientRect().height === window.innerHeight);
  const scroll = await page.$eval('.voicereview-inner', (node) => {
    const before = node.scrollTop;
    node.scrollTop = node.scrollHeight;
    const save = node.querySelector('.voicereview-actions')!.getBoundingClientRect();
    const view = node.getBoundingClientRect();
    return {
      before, after: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      saveBottom: Math.round(save.bottom), viewBottom: Math.round(view.bottom),
    };
  });
  check('the whole review scrolls when its contents outgrow the visible screen',
    scroll.after > scroll.before && scroll.scrollHeight > scroll.clientHeight && scroll.saveBottom <= scroll.viewBottom,
    JSON.stringify(scroll));
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
  await page.waitForFunction(() => document.querySelector('.voicereview')?.getBoundingClientRect().height === window.innerHeight);

  // Note #387: "I clicked the attachment, the full screen attachment was
  // shown and I closed it and I see how the UI is broken … the text input is
  // not seen … design this screen to be non-breakable." So the picture is
  // opened AND closed here, on a screen the height a keyboard leaves, and
  // what is measured is the shape of the review either side of it.
  //
  // The editor is the one flexible block on this screen, so before the floor
  // it absorbed every shortage going: at 360px of visible height it was two
  // borders and a hairline, and because collapsing kept the column exactly
  // as tall as the screen, the scrolling added for note #381 never engaged.
  const geometry = `(() => {
    const dialog = document.querySelector('dialog.voicereview');
    const column = document.querySelector('.voicereview-inner');
    const box = (node) => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; };
    return {
      dialog: box(dialog), head: box(dialog.querySelector('.voicereview-head')),
      editor: box(dialog.querySelector('.voicereview-editor')),
      text: box(dialog.querySelector('.voicereview-text')),
      scrollTop: Math.round(column.scrollTop), scrollHeight: column.scrollHeight, clientHeight: column.clientHeight,
      body: getComputedStyle(document.body).position,
    };
  })()`;
  await page.setViewport({ width: 420, height: 360, deviceScaleFactor: 2 });
  await page.waitForFunction(() => document.querySelector('.voicereview')?.getBoundingClientRect().height === window.innerHeight);
  const squeezed = await page.evaluate(geometry) as Record<string, any>;
  check('the words keep a box to be read in on a keyboard-height screen',
    squeezed.editor.h >= 100 && squeezed.text.h >= 90, JSON.stringify(squeezed));
  const cappedVoice = await textareaShape('.voicereview-text');
  check('only a voice note past the review cap scrolls inside its field',
    cappedVoice.scrollHeight > cappedVoice.clientHeight && cappedVoice.overflowY === 'auto',
    JSON.stringify(cappedVoice));
  // Not "it overflows": with a pick drawn as a chip rather than a 240px
  // preview this height now FITS, which is the better answer to the same
  // question. What must hold either way is that nothing was crushed to make
  // it fit — the editor is at or above its floor, and the button that commits
  // is reachable, by fitting or by scrolling to it.
  const reachable = await page.$eval('.voicereview-inner', (node) => {
    node.scrollTop = node.scrollHeight;
    const save = node.querySelector('.voicereview-actions')!.getBoundingClientRect();
    const view = node.getBoundingClientRect();
    const at = Math.round(node.scrollTop);
    node.scrollTop = 0;
    return { saveBottom: Math.round(save.bottom), viewBottom: Math.round(view.bottom), scrolledBy: at };
  });
  check('and Save is reachable there — by fitting, or by scrolling to it',
    reachable.saveBottom <= reachable.viewBottom, JSON.stringify(reachable));
  await shot('n387-keyboard-height');

  // A photo tapped in the dialog must open ABOVE it: the dialog is in the
  // browser's top layer, so a viewer portalled to the body would be invisible.
  const shown = await page.$('dialog.voicereview .chatdraftopen');
  check('the chip is the door to the picture itself', Boolean(shown));
  if (shown) {
    // Scrolled down, the way a reader who has just reached Save is.
    await page.$eval('.voicereview-inner', (node) => { node.scrollTop = node.scrollHeight; });
    const before = await page.evaluate(geometry) as Record<string, any>;
    await shown.click();
    await page.waitForSelector('dialog.voicereview [role="dialog"]', { timeout: 10_000 }).catch(() => {});
    check('a photo opens inside the dialog, not behind it',
      await page.$eval('dialog.voicereview', (node) => Boolean(node.querySelector('[role="dialog"]'))));
    await shot('n365-note-review-photo');
    // The page underneath is already sealed off by this modal, so the viewer
    // has no business reflowing it — on a phone that reflow is what moves the
    // visible rectangle this screen measured itself against.
    check('the page underneath is left alone while the picture is up',
      (await page.evaluate(() => getComputedStyle(document.body).position)) !== 'fixed');

    await page.click('#imageViewerClose');
    await page.waitForFunction(() => !document.querySelector('#imageViewer'), { timeout: 10_000 });
    await new Promise((settle) => { setTimeout(settle, 300); });
    const after = await page.evaluate(geometry) as Record<string, any>;
    await shot('n387-after-closing-the-picture');
    check('closing the picture leaves the screen where it was',
      after.dialog.top === before.dialog.top && after.dialog.h === before.dialog.h,
      `${JSON.stringify(before.dialog)} -> ${JSON.stringify(after.dialog)}`);
    check('the way out is still at the top of the screen', after.head.top === 0, JSON.stringify(after.head));
    check('the text input survived it', after.editor.h === before.editor.h && after.text.h >= 90,
      `${JSON.stringify(before.editor)} -> ${JSON.stringify(after.editor)}`);
    check('and the review is still scrolled where the reader left it',
      after.scrollTop === before.scrollTop, `${before.scrollTop} -> ${after.scrollTop}`);

    // Two separate guards, because a reading of the visible rectangle taken
    // while the page was mid-reflow used to be BOTH unchecked and permanent.
    // Each is given the bad value by hand, on the element the dialog's own
    // script writes to — the state note #387 arrived in.
    //
    // One: an offset past the window is refused outright, so the band of
    // empty background above the screen is not a shape it can take.
    await page.$eval('dialog.voicereview', (node) => node.style.setProperty('--voice-top', '260px'));
    const pushed = await page.evaluate(geometry) as Record<string, any>;
    check('a bad reading cannot push this screen off the phone',
      pushed.dialog.top === 0 && pushed.dialog.h === 360, JSON.stringify(pushed.dialog));

    // Two: a reading that is merely WRONG rather than impossible — a screen
    // measured short, its editor and Save below the fold — cannot be refused,
    // only re-taken. Anything opening and closing over this dialog is a
    // moment the rectangle may have moved, so it is a moment to measure again.
    await page.$eval('dialog.voicereview', (node) => node.style.setProperty('--voice-height', '200px'));
    const short = await page.evaluate(geometry) as Record<string, any>;
    check('a screen measured short really is short until something re-measures it',
      short.dialog.h === 200, JSON.stringify(short.dialog));
    await page.$eval('dialog.voicereview .chatdraftopen', (node) => node.click());
    await page.waitForSelector('dialog.voicereview #imageViewer', { timeout: 10_000 });
    await page.click('#imageViewerClose');
    await page.waitForFunction(() => !document.querySelector('#imageViewer'), { timeout: 10_000 });
    await new Promise((settle) => { setTimeout(settle, 300); });
    const healed = await page.evaluate(geometry) as Record<string, any>;
    check('and opening and closing a picture over it makes it measure again',
      healed.dialog.top === 0 && healed.dialog.h === 360, JSON.stringify(healed.dialog));
  }
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
  await page.waitForFunction(() => document.querySelector('.voicereview')?.getBoundingClientRect().height === window.innerHeight);
  // Saving is not sending, and the hint over the editor has to agree.
  check('it says save, never send', noteReview.includes('before you save.') && !noteReview.includes('before you send.'), noteReview.slice(0, 90));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
