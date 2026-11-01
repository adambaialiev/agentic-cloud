#!/usr/bin/env node
/**
 * Mail, read: the inbox behind a person's own address and one letter in it
 * (note #509, slice 3).
 *
 * Its own scenario rather than four more stops on the tour, because what it
 * has to prove is not that the screens draw — it is the promise the screens
 * make about mail a stranger sent. So it asserts, in a real browser: a
 * hard-wrapped letter reads as paragraphs on a phone; a message whose only
 * body is HTML is drawn from that HTML with NO picture fetched and no markup
 * of the sender's running; and the files shelf holds what the SENDER attached
 * and nothing else — a message that carried nothing has no shelf (note #517).
 *
 * Since slice 7 it walks search, the archive and Trash too: the field under
 * the way to write one, Back from a result landing on the results, a letter
 * archived and then trashed from its own screen with the place said from the
 * server's answer, an agent's move named in Trash, and Restore putting the
 * letter back in the archive it came from.
 *
 * Since slice 8 the inbox is CONVERSATIONS: Priya's brief, the answer her
 * agent sent and Priya's answer to that are one row with a count, read on one
 * screen oldest first — the owner's own letter marked as hers, and Priya's
 * copy of it at the bottom of her answer folded behind a tap. An answer
 * arriving to a message the agent STARTED lands in that conversation rather
 * than on a row of its own, a search result opens its conversation standing
 * at the letter it found, and a whole conversation is archived at once.
 *
 * And since slice 9 it walks SENT: the door at the foot of the inbox, one row
 * per letter that has gone out — her own answer, her agent's, and a message
 * that is in the archive and still here because Sent is not a place — none of
 * them able to be new, a search that looks through the words of a reply, and
 * a row that opens the conversation it belongs to standing at that letter.
 *
 * Slice 10 is the PICTURES, and it is the one part of this scenario that
 * asserts something about the network rather than the screen: the invoice's
 * logo is not fetched until she taps, and then only through our own proxy;
 * her standing yes for that sender holds on the next open and comes off from
 * the same line; the photograph that travelled inside Priya's letter is drawn
 * with no tap and nothing said; and the tracking pixel is never requested by
 * anybody, which is read off the requests this server answered.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// `tap` rather than `page.click` for anything below the fold that is tapped
// straight after a screen lands: for three seconds after it lands the shell
// takes back every scroll no reader made (`place-scroll.ts`), and that
// includes the one `page.click` makes to reach its target — so on a loaded
// machine the press lands where the row WAS. The inbox's doors sit under a
// 900px window, and main went red on exactly that, three times on 2026-09-24.
// `tap` scrolls with the wheel, which the shell reads as a person.
import { tap } from '../scripts/browser-settle.mjs';
import { startMockWorkspace } from './support/mock-workspace.mjs';
import {
  normalizedText, repoRoot, runBrowserScenario, screenshotPathFor, textOf, waitVisible,
} from './support/browser-simulation.mjs';
import { headerTitle, open, openWorkplace, signIn, tapByText, waitForAll } from './support/team-steps.mjs';

const slug = 'mail';
const app = await startMockWorkspace(repoRoot, { world: 'team', stage: 'settled' });

await runBrowserScenario({
  app,
  slug,
  screenshotPath: screenshotPathFor(slug),
  async run({ page, shoot }) {
    await signIn(page, app, app.fixture.account);
    // The way in stands in the Messages card in Home's Workplace window
    // (note #715). With a letter waiting it says so and wears the dot; the
    // address is what it shows when nothing is new.
    await openWorkplace(page);
    await waitForAll(page, '#humanMessagesCard', ['Mail', '1 new message']);
    assert.equal(await page.$$eval('#humanMessagesCard .unreaddot', (dots) => dots.length), 1);
    await shoot('home-mail-door', { fullPage: true });

    await open(page, app, '/mail', '#screenMail');
    assert.equal(await headerTitle(page), 'Mail');
    await waitForAll(page, '#mailList', ['Priya Raman', 'The brief, and one photograph', '1 file', 'Fly.io']);
    // ONE row for the three letters of Priya's conversation — her brief, the
    // answer her agent sent, her answer to that — with the count on the
    // name's line and her newest words under the subject (slice 8).
    const briefRow = await page.$$eval('#mailList .crow.open', (rows) => {
      const matching = rows.filter((one) => one.textContent.includes('The brief, and one photograph'));
      const row = matching[0];
      const name = row.querySelector('.mailtop .name').getBoundingClientRect();
      const count = row.querySelector('.mailcount');
      const box = count.getBoundingClientRect();
      const clock = row.querySelector('.mailwhen').getBoundingClientRect();
      return {
        rows: matching.length,
        names: row.querySelector('.mailnames').textContent.trim(),
        count: count.textContent.trim(),
        countOnNameLine: Math.abs(box.top - name.top) < 6,
        countBeforeClock: box.right <= clock.left,
        line: [...row.querySelectorAll('.cline .ctext')].map((one) => one.textContent.trim()),
        opens: row.getAttribute('href'),
      };
    });
    assert.deepEqual(briefRow, {
      rows: 1, names: 'Priya Raman', count: '3', countOnNameLine: true, countBeforeClock: true,
      line: ['The brief, and one photograph', 'Thank you — tonight is fine. I will keep the evening clear.'],
      // New for Priya's answer, so a tap opens it standing there.
      opens: '/mail/mm_studio_back',
    });
    // A message her agent wrote from her address, marked as such. The row is
    // named by who it went to, and the mark is the only place she is told she
    // did not write it — the person receiving it saw her name (slice 6).
    await waitForAll(page, '#mailList', ['To Priya Raman', 'sent by Ruby']);
    // What has not been opened yet is the heavy row. Asserted in PIXELS, not
    // on the class: a rule that reaches the wrong element still leaves the
    // class on the row, and weight is exactly the kind of change that looks
    // applied in the markup and is not on the screen.
    const rowWeights = () => page.$$eval('#mailList .crow.open', (rows) => rows.map((row) => ({
      subject: row.querySelector('.mailsubject .ctext')?.textContent ?? '',
      isNew: row.classList.contains('mailnew'),
      name: getComputedStyle(row.querySelector('.name')).fontWeight,
      subjectWeight: getComputedStyle(row.querySelector('.mailsubject .ctext')).fontWeight,
      colour: getComputedStyle(row.querySelector('.mailsubject .ctext')).color,
    })));
    const before = await rowWeights();
    const brief = before.find((row) => row.subject.startsWith('The brief'));
    const invoice = before.find((row) => row.subject.startsWith('Your September'));
    assert.equal(brief.isNew, true);
    assert.equal(invoice.isNew, false);
    assert.equal(brief.name, '700');
    assert.equal(brief.subjectWeight, '700');
    assert.equal(invoice.name, '400');
    assert.equal(invoice.subjectWeight, '400');
    assert.notEqual(brief.colour, invoice.colour);

    // And it is laid out the way mail is laid out (note #529). Every one of
    // these is MEASURED in the page rather than looked up as a class: the
    // right-hand clock and the top-of-card compose door are rules that can be
    // on the element and doing nothing on the screen.
    const inbox = await page.evaluate(() => {
      const card = document.getElementById('mailList');
      const rows = [...card.querySelectorAll('.crow.open')];
      const row = rows.find((one) => one.textContent.includes('The brief'));
      const read = rows.find((one) => one.textContent.includes('Your September'));
      const name = row.querySelector('.mailtop .name').getBoundingClientRect();
      const when = row.querySelector('.mailtop .mailwhen');
      const clock = when.getBoundingClientRect();
      const main = row.querySelector('.main').getBoundingClientRect();
      const write = document.getElementById('mailWrite').getBoundingClientRect();
      return {
        rows: rows.length,
        // The owner asked for no avatars, so nothing stands in the column the
        // words start in — and no row may quietly grow a mark there again.
        marks: card.querySelectorAll('.crow .avatar, .crow .icon, .crow .iconbox, .crow .mailface').length,
        // The one mark the card itself carries is the search field's own
        // magnifier at its head (slice 7) — never a row's.
        strayMarks: [...card.querySelectorAll('.icon, svg')].filter((icon) => !icon.closest('#mailSearch') && !icon.closest('.mailstar')).length,
        // ...and the STAR (note #666), which the owner asked for: one per
        // row, standing BESIDE the row's link rather than in it, at the
        // right-hand edge under the clock — never in the column the words
        // start in.
        stars: rows.map((one) => {
          const star = one.parentElement.querySelector(':scope > .mailstar');
          if (!star) return null;
          const box = star.getBoundingClientRect();
          const whenBox = one.querySelector('.mailtop .mailwhen').getBoundingClientRect();
          const subjectBox = one.querySelector('.mailsubject').getBoundingClientRect();
          const mainBox = one.querySelector('.main').getBoundingClientRect();
          const middle = (rect) => (rect.top + rect.bottom) / 2;
          return {
            inLink: Boolean(star.closest('a')),
            belowClock: middle(box) > whenBox.bottom,
            onSubjectLine: Math.abs(middle(box) - middle(subjectBox)) <= 3 || Math.round(middle(box) - middle(subjectBox)),
            rightOfWords: box.left > mainBox.left + mainBox.width * 0.7,
            size: Math.round(box.width),
          };
        }),
        // Nor does the unopened row take a surface of its own: this page's
        // paper is nearly white, and a white row on it washed out.
        newSurface: getComputedStyle(row).backgroundColor,
        readSurface: getComputedStyle(read).backgroundColor,
        when: when.textContent.trim(),
        clockAfterName: Math.round(clock.left - name.right),
        clockAtEdge: Math.round(main.right - clock.right),
        nameWidth: Math.round(name.width), mainWidth: Math.round(main.width),
        sameLine: Math.abs(clock.top - name.top) < 6,
        writeAboveRows: write.bottom <= Math.min(...rows.map((one) => one.getBoundingClientRect().top)) + 1,
        writeFirst: card.firstElementChild.id,
        chevrons: card.querySelectorAll('.chev').length,
      };
    });
    // Four conversations, and since slice 10 Priya's photograph as a fifth.
    assert.equal(inbox.rows, 5);
    assert.equal(inbox.marks, 0);
    assert.equal(inbox.strayMarks, 0);
    for (const star of inbox.stars) {
      assert.deepEqual(star, { inLink: false, belowClock: true, onSubjectLine: true, rightOfWords: true, size: 36 });
    }
    assert.equal(inbox.newSurface, inbox.readSurface);
    // The hour, on the name's own line, against the right-hand edge of the
    // row — the column an inbox is scanned down.
    assert.match(inbox.when, /^\d{1,2}:\d{2}( ?[AP]M)?$/);
    // And a message from a fortnight ago says the DAY it came instead, which
    // is the whole reason the column stopped counting ages.
    const older = await page.$$eval('#mailList .crow.open', (rows) => {
      const row = rows.find((one) => one.textContent.includes('The studio lease'));
      return row.querySelector('.mailwhen').textContent.trim();
    });
    // "3 Sept" here, "3 Sep" in another CLDR: the shape is what matters — a
    // day and a month, and no clock in it.
    assert.match(older, /^\d{1,2} [A-Z][a-z]{2,4}$/);
    assert.equal(inbox.sameLine, true);
    assert.ok(inbox.clockAfterName >= 0, `clock stands after the name: ${inbox.clockAfterName}`);
    assert.ok(inbox.clockAtEdge <= 1, `clock sits at the row's edge: ${inbox.clockAtEdge}`);
    // The name is what gives way: its box takes everything the clock does not
    // want, so a long address is cut rather than pushing the hour off screen.
    assert.ok(inbox.nameWidth > inbox.mainWidth * 0.6, `name takes the rest of the line: ${inbox.nameWidth} of ${inbox.mainWidth}`);
    // The way to write one is the first thing in the card, above every
    // message, and no row carries a chevron any more.
    assert.equal(inbox.writeFirst, 'mailWrite');
    assert.equal(inbox.writeAboveRows, true);
    assert.equal(inbox.chevrons, 0);
    await shoot('inbox', { fullPage: true });

    // A letter hard-wrapped at 72 columns, read on a phone: the sender's
    // paragraph is one paragraph again, and the signature keeps its shape.
    await open(page, app, '/mail/mm_studio_brief', '#screenMailMessage');
    assert.equal(await headerTitle(page), 'The brief, and one photograph');
    await waitForAll(page, '#screenMailMessage', ['harborlight-brief.pdf']);
    // Her file, and only her file. The raw message is still stored and an
    // agent can still fetch it; it is not a row a person meets (note #517).
    assert.equal(await page.$$eval('.mailfiles .crow', (rows) => rows.length), 1);
    assert.doesNotMatch(normalizedText(await textOf(page, '#screenMailMessage')), /original message/);
    const letter = normalizedText(await textOf(page, '#mailLetter-mm_studio_brief .mailtext'));
    assert.match(letter, /the photograph is the one for the header/);
    assert.equal(await page.$$eval('.mailbody img', (nodes) => nodes.length), 0);

    // And the screen around the letter is the letter's, not the envelope's
    // (note #545). Every one of these is MEASURED: a heading taken out of the
    // visual flow still answers `getByRole`, and a card that stopped being a
    // card keeps its class either way.
    const envelope = await page.evaluate(() => {
      const brief = document.getElementById('mailLetter-mm_studio_brief');
      const head = brief.querySelector('.mailenvelope');
      const who = head.querySelector('.mailwho .name');
      const stamp = head.querySelector('time');
      const box = head.getBoundingClientRect();
      const name = who.getBoundingClientRect();
      const clock = stamp.getBoundingClientRect();
      return {
        who: who.textContent.trim(),
        about: head.querySelector('.mailabout').textContent.trim(),
        // The envelope is on the page now; the files shelf is what a card
        // looks like on this screen.
        surface: getComputedStyle(head).backgroundColor,
        cardSurface: getComputedStyle(brief.querySelector('.mailfiles')).backgroundColor,
        sameLine: Math.abs(clock.top - name.top) < 6,
        clockAtEdge: Math.round(box.right - clock.right),
        // A clipped heading measures a pixel tall. This is the whole of
        // "the reader can see it".
        filesHeadHeight: Math.round(brief.querySelector('.mailfileshead').getBoundingClientRect().height),
        // The sender is named once: the header's second line is gone.
        headerSubs: document.querySelectorAll('#pageHead .sub').length,
      };
    });
    assert.equal(envelope.who, 'Priya Raman');
    assert.equal(envelope.about, 'priya@harborlight.co · to you');
    assert.equal(envelope.surface, 'rgba(0, 0, 0, 0)');
    assert.notEqual(envelope.cardSurface, 'rgba(0, 0, 0, 0)');
    assert.equal(envelope.sameLine, true);
    assert.ok(envelope.clockAtEdge <= 1, `the moment sits at the edge: ${envelope.clockAtEdge}`);
    assert.ok(envelope.filesHeadHeight > 8, `Files is a heading a reader can see: ${envelope.filesHeadHeight}px`);
    assert.equal(envelope.headerSubs, 0);
    await shoot('letter', { fullPage: true });

    // THE CONVERSATION (slice 8): her brief, the answer her agent sent, and
    // Priya's answer to that — oldest first, on one screen. Her own letter is
    // marked as hers in words and in colour, and says which agent wrote it.
    const conversation = await page.evaluate(() => {
      const letters = [...document.querySelectorAll('#mailConversation .mailletter')];
      const own = letters.find((one) => one.classList.contains('mailown'));
      const back = document.getElementById('mailLetter-mm_studio_back');
      return {
        order: letters.map((one) => one.id),
        ownLine: own.querySelector('.mailownhead .ctext').textContent.trim(),
        ownBy: own.querySelector('.mailreplyby').textContent.trim(),
        ownRule: getComputedStyle(own).borderLeftWidth,
        ownSurface: getComputedStyle(own).backgroundColor,
        theirSurface: getComputedStyle(back).backgroundColor,
        // Priya's answer shows what she wrote; her copy of the agent's letter
        // is behind a tap, still there, not on the page a second time.
        backWords: back.querySelector('.mailtext').textContent,
        fold: back.querySelector('.mailfoldtoggle')?.textContent.trim() ?? null,
        folded: !back.querySelector('.mailquotedbody'),
        replies: [...document.querySelectorAll('#mailReply')].map((one) => one.textContent.trim()),
      };
    });
    assert.deepEqual(conversation.order, ['mailLetter-mm_studio_brief', 'mailLetter-mm_reply_ruby', 'mailLetter-mm_studio_back']);
    assert.equal(conversation.ownLine, 'From you to Priya Raman');
    assert.equal(conversation.ownBy, 'Sent by Ruby');
    assert.equal(conversation.ownRule, '2px');
    assert.notEqual(conversation.ownSurface, conversation.theirSurface);
    assert.match(conversation.backWords, /Thank you — tonight is fine/);
    assert.doesNotMatch(conversation.backWords, /wrote:/);
    assert.equal(conversation.fold, 'Show quoted text');
    assert.equal(conversation.folded, true);
    // One Reply, at the foot, to the newest letter that arrived.
    assert.deepEqual(conversation.replies, ['Reply to Priya Raman']);
    await shoot('conversation', { fullPage: true });
    await page.click('#mailLetter-mm_studio_back .mailfoldtoggle');
    await waitForAll(page, '#mailLetter-mm_studio_back .mailquotedbody', ['wrote:', 'Samira is away until this evening']);
    assert.equal(await page.$eval('#mailLetter-mm_studio_back .mailfoldtoggle', (node) => node.getAttribute('aria-expanded')), 'true');
    await shoot('conversation-quote-open', { fullPage: true });

    // The other direction, and the branch a screenshot pass would otherwise
    // skip: a message her AGENT started from her address. It is hers, and
    // the line above it says so in words — and which agent wrote it.
    await open(page, app, '/mail/mm_agent_sent', '#screenMailMessage');
    await waitVisible(page, '#mailLetter-mm_agent_sent');
    assert.equal(
      await page.$eval('#mailLetter-mm_agent_sent .mailownhead .ctext', (node) => node.textContent.trim()),
      'From you to Priya Raman',
    );
    assert.equal(await page.$eval('#mailLetter-mm_agent_sent .mailreplyby', (node) => node.textContent.trim()), 'Sent by Ruby');
    await shoot('a-message-the-agent-sent', { fullPage: true });

    // And the whole reason for slice 8: Priya ANSWERS that message. Her answer
    // lands in its conversation — the row now named by her, two letters in
    // it — and not on a row of its own, unrelated to what it answers.
    const answered = await fetch(`${app.origin}/workspace/api/mail/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: 'mm_agent_sent', subject: 'Re: The crop, as promised', snippet: 'The crop is perfect — thank you both.' }),
    });
    assert.equal(answered.status, 201);
    await open(page, app, '/mail', '#screenMail');
    await waitForAll(page, '#mailList', ['The crop is perfect']);
    const cropRows = await page.$$eval('#mailList .crow.open', (rows) => rows
      .filter((one) => one.textContent.includes('The crop, as promised') || one.textContent.includes('The crop is perfect'))
      .map((one) => ({ names: one.querySelector('.mailnames').textContent.trim(), count: one.querySelector('.mailcount')?.textContent.trim() ?? null })));
    assert.deepEqual(cropRows, [{ names: 'Priya Raman', count: '2' }]);
    await shoot('an-answer-lands-in-its-conversation', { fullPage: true });

    // Back on the list, the conversation she just read has receded: opening
    // it is what marks every letter in it read, and the server decides that.
    await open(page, app, '/mail', '#screenMail');
    await waitForAll(page, '#mailList', ['The brief, and one photograph']);
    const after = await rowWeights();
    assert.equal(after.find((row) => row.subject.startsWith('The brief')).isNew, false);
    assert.equal(after.find((row) => row.subject.startsWith('The brief')).name, '400');

    // And a letter that arrives while she is LOOKING at this list turns up in
    // it, without her leaving the screen: the inbox asks again every
    // MAIL_POLL_MS. Waited out at twice the interval, because a 15s wait
    // cannot prove a 15s poll — and read off the row's own words rather than
    // off a request count, which would pass just as well with nothing drawn.
    const arrived = await fetch(`${app.origin}/workspace/api/mail/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'The rush order', snippet: 'Can you look at this today?' }),
    });
    assert.equal(arrived.status, 201);
    await waitForAll(page, '#mailList', ['The rush order'], 30_000);
    // Nobody has opened it, so it arrives heavy.
    const fresh = await rowWeights();
    assert.equal(fresh.find((row) => row.subject === 'The rush order').isNew, true);
    await shoot('arrived-while-open', { fullPage: true });

    // A machine-written message that carried BOTH halves — markup and the
    // flattened text its sender generated from it. The formatted half is what
    // the screen draws, unasked: it is the shape the sender meant, and it is
    // safe because it went through the allowlist on the way in. Every picture
    // is left out and nothing of theirs is in the document.
    await open(page, app, '/mail/mm_receipt', '#screenMailMessage');
    await waitForAll(page, '#screenMailMessage', ['Invoice 4821', 'Pictures in this message are not loaded']);
    const drawn = await page.evaluate(() => ({
      images: document.querySelectorAll('.mailhtml img').length,
      scripts: document.querySelectorAll('.mailhtml script, .mailhtml style').length,
      tables: document.querySelectorAll('.mailhtml table').length,
    }));
    assert.deepEqual(drawn, { images: 0, scripts: 0, tables: 1 });
    // It carried nothing, so there is no files shelf under it at all — which
    // is the whole of note #517: the only row that shelf ever had was the raw
    // message, and a shelf holding one dead end is worse than no shelf.
    assert.equal(await page.$$eval('.mailfiles', (cards) => cards.length), 0);
    assert.doesNotMatch(normalizedText(await textOf(page, '#screenMailMessage')), /original message/);
    // And it is the ONLY body drawn. The fixture carries both halves on
    // purpose — the flattened text its sender generated from that table is
    // the same invoice as a column of stray figures — and note #534 decided
    // that half is not shown at all: no second version, and nothing to tap to
    // reach one. The reader is not asked which of two bodies is the letter.
    assert.equal(await page.$$eval('.mailtext', (nodes) => nodes.length), 0);
    assert.equal(await page.$$eval('#mailBodySwitch', (nodes) => nodes.length), 0);
    assert.doesNotMatch(normalizedText(await textOf(page, '#screenMailMessage')), /plain version|formatted version/);
    // Which leaves the pictures sentence alone on its line — the layout the
    // note was asked about, read off the line's own text.
    assert.equal(normalizedText(await textOf(page, '.mailnotes')), 'Pictures in this message are not loaded.');
    await shoot('invoice', { fullPage: true });

    // ── Slice 10: PICTURES ────────────────────────────────────────────────
    // The invoice is also where the two kinds of picture live. Its sender's
    // mark is at THEIR address, so nothing is fetched on open — the line
    // says so — and the tap that would fetch it says what it costs in its
    // own words, which is the only honest way to ask.
    const pictureRow = await page.evaluate(() => {
      const box = document.getElementById('mailPictures-mm_receipt');
      const load = document.getElementById('mailLoadPictures-mm_receipt');
      const notes = document.querySelector('.mailnotes');
      return {
        button: load?.textContent.trim() ?? null,
        // Under the letter and under the line about it, in that order.
        belowNotes: Boolean(notes && box && notes.getBoundingClientRect().bottom <= box.getBoundingClientRect().top + 1),
        always: document.getElementById('mailAlwaysPictures-mm_receipt') !== null,
        images: document.querySelectorAll('.mailhtml img').length,
      };
    });
    assert.deepEqual(pictureRow, {
      button: 'Load pictures (the sender may learn you opened this)',
      belowNotes: true,
      // Not offered until she has loaded this sender's pictures once.
      always: false,
      images: 0,
    });

    // Asked for: the logo is drawn — and it is drawn from OUR address, so the
    // sender's server saw this platform and never her browser.
    await page.click('#mailLoadPictures-mm_receipt');
    await page.waitForFunction(() => {
      const image = document.querySelector('.mailhtml img');
      return Boolean(image && image.complete && image.naturalWidth > 0);
    }, { timeout: 10_000 });
    const loaded = await page.evaluate(() => {
      const images = [...document.querySelectorAll('.mailhtml img')];
      return {
        count: images.length,
        src: images[0]?.getAttribute('src') ?? '',
        width: images[0]?.naturalWidth ?? 0,
        // Nothing is left out any more, so the line has gone.
        notes: document.querySelectorAll('.mailnotes').length,
        load: document.getElementById('mailLoadPictures-mm_receipt') !== null,
        always: document.getElementById('mailAlwaysPictures-mm_receipt')?.textContent.trim() ?? null,
      };
    });
    assert.equal(loaded.count, 1, 'the logo, and only the logo');
    assert.match(loaded.src, /^\/workspace\/api\/mail\/messages\/mm_receipt\/remote-image\?src=/);
    assert.ok(loaded.width > 0, 'the picture actually drew');
    assert.equal(loaded.notes, 0);
    assert.equal(loaded.load, false);
    assert.equal(loaded.always, 'Always load pictures from billing@fly.io');
    await shoot('pictures-loaded', { fullPage: true });

    // THE TRACKING PIXEL WAS NEVER FETCHED — not before the tap and not
    // after it. Read off the requests this server actually answered, not off
    // the document: a picture that is not in the DOM but was requested once
    // has already done the sender's work for them.
    const proxied = app.requests
      .filter((request) => request.path.endsWith('/remote-image'))
      .map((request) => new URLSearchParams(request.search).get('src'));
    assert.deepEqual(proxied, ['https://cdn.fly.io/flyio-mark.png']);
    assert.equal(app.requests.filter((request) => `${request.path}${request.search}`.includes('track.example.com')).length, 0);
    assert.equal(await page.evaluate(() => document.body.innerHTML.includes('track.example.com')), false);

    // The standing yes, for this sender alone. Taken, it holds on the next
    // open — the letter draws its pictures with no tap, and the way back off
    // the list is on the letter itself.
    await page.click('#mailAlwaysPictures-mm_receipt');
    await page.waitForFunction(
      () => document.getElementById('mailAlwaysPictures-mm_receipt')?.textContent.includes('Stop loading'),
      { timeout: 10_000 },
    );
    await open(page, app, '/mail', '#screenMail');
    await open(page, app, '/mail/mm_receipt', '#screenMailMessage');
    await page.waitForFunction(() => {
      const image = document.querySelector('.mailhtml img');
      return Boolean(image && image.complete && image.naturalWidth > 0);
    }, { timeout: 10_000 });
    assert.equal(await page.$$eval('#mailLoadPictures-mm_receipt', (nodes) => nodes.length), 0);
    assert.equal(
      await page.$eval('#mailAlwaysPictures-mm_receipt', (node) => node.textContent.trim()),
      'Stop loading pictures from billing@fly.io',
    );
    await shoot('pictures-always', { fullPage: true });
    // And off it again, which puts the pictures back behind the tap.
    await page.click('#mailAlwaysPictures-mm_receipt');
    await page.waitForFunction(() => document.getElementById('mailLoadPictures-mm_receipt') !== null, { timeout: 10_000 });
    assert.equal(await page.$$eval('.mailhtml img', (nodes) => nodes.length), 0);

    // A PICTURE THAT TRAVELLED INSIDE THE LETTER is drawn with no tap at all:
    // the bytes are ours already, so there is nobody to tell and nothing to
    // ask. Nothing was left out, so the letter says nothing about pictures.
    await open(page, app, '/mail/mm_crop_photo', '#screenMailMessage');
    await page.waitForFunction(() => {
      const image = document.querySelector('.mailhtml img');
      return Boolean(image && image.complete && image.naturalWidth > 0);
    }, { timeout: 10_000 });
    const inside = await page.evaluate(() => {
      const image = document.querySelector('.mailhtml img');
      return {
        src: image.getAttribute('src'),
        width: image.naturalWidth,
        // It fits the reading column rather than running off the screen.
        drawnWidth: Math.round(image.getBoundingClientRect().width),
        column: Math.round(document.querySelector('.mailhtml').getBoundingClientRect().width),
        notes: document.querySelectorAll('.mailnotes').length,
        pictures: document.querySelectorAll('[id^=mailPictures-]').length,
        file: document.querySelector('.mailfiles .cline')?.textContent.trim() ?? '',
      };
    });
    assert.equal(inside.src, '/workspace/api/mail/messages/mm_crop_photo/inline/ma_dusk');
    assert.ok(inside.width > 0, 'the photograph actually drew');
    assert.ok(inside.drawnWidth <= inside.column, 'a sender\'s picture never pushes the column sideways');
    assert.equal(inside.notes, 0);
    assert.equal(inside.pictures, 0);
    // It is still a file of the letter, and its row says where it is shown.
    assert.match(inside.file, /shown inside the message/);
    await shoot('picture-inside-the-letter', { fullPage: true });

    // Answering it. The recipient is shown and is not a field: a reply is
    // still addressed on the server, off the message, so this composer has
    // nowhere to aim one — writing to somebody new is its own door, below.
    await open(page, app, '/mail/mm_studio_brief', '#screenMailMessage');
    await tap(page, '#mailReply');
    await waitVisible(page, '#screenMailReply');
    assert.equal(await headerTitle(page), 'Reply');
    assert.match(normalizedText(await textOf(page, '#pageHead')), /to Priya Raman <priya@harborlight.co>/);
    assert.equal(await page.$$eval('#screenMailReply input[type=text], #screenMailReply input[type=email]', (nodes) => nodes.length), 0);
    await page.type('#mailReplyText', 'Tuesday works. I will send the header crop back tonight.');
    await shoot('writing-a-reply', { fullPage: true });
    await page.click('#mailReplySend');
    // Back in the conversation, with the answer standing at its foot — after
    // the one her agent sent this morning and Priya's answer to that.
    await waitForAll(page, '#mailConversation', ['From you to Priya Raman', 'Tuesday works']);
    await page.waitForFunction(() => document.querySelectorAll('#mailConversation .mailown').length === 2, { timeout: 10_000 });
    const thread = await page.evaluate(() => {
      const replies = [...document.querySelectorAll('#mailConversation .mailown')];
      return {
        last: [...document.querySelectorAll('#mailConversation .mailletter')].at(-1).classList.contains('mailown'),
        lines: replies.map((one) => one.querySelector('.mailownhead').textContent.replace(/\s+/g, ' ').trim()),
        wrote: replies.map((one) => one.querySelector('.mailreplyby')?.textContent.trim() ?? null),
        // The two marks that these words are this side of the conversation:
        // the rule down the edge, and a surface that is neither the page nor
        // the grey every other shelf on this screen is drawn on.
        rule: replies.map((one) => getComputedStyle(one).borderLeftWidth),
        surface: getComputedStyle(replies[0]).backgroundColor,
        pageSurface: getComputedStyle(document.getElementById('screenMailMessage')).backgroundColor,
        cardSurface: getComputedStyle(document.querySelector('.mailfiles')).backgroundColor,
        // One clock over the whole conversation: an answer is dated the way
        // the letter above it is, never aged against it.
        stamps: replies.map((one) => one.querySelector('time').textContent.trim()),
      };
    });
    assert.equal(thread.last, true);
    assert.equal(thread.lines.length, 2);
    // Which of the two she wrote, said in the one place she reads them.
    assert.match(thread.lines[0], /^From you to Priya Raman/);
    assert.match(thread.lines[1], /^From you to Priya Raman/);
    assert.equal(thread.wrote[0], 'Sent by Ruby');
    assert.equal(thread.wrote[1], null);
    assert.deepEqual(thread.rule, ['2px', '2px']);
    assert.notEqual(thread.surface, thread.cardSurface);
    assert.notEqual(thread.surface, thread.pageSurface);
    for (const stamp of thread.stamps) {
      assert.doesNotMatch(stamp, /ago/);
      assert.match(stamp, /\d{4}/);
    }
    await shoot('replied', { fullPage: true });

    // Writing to somebody who has not written first (slice 5) — the one
    // composer that DOES name a recipient, and the ceilings behind it are the
    // server's. What this proves here is the shape a person meets: one
    // address, one subject, words, and the sent message standing in their own
    // list afterwards named by who it went to rather than by themselves.
    await open(page, app, '/mail', '#screenMail');
    await page.click('#mailWrite');
    await waitVisible(page, '#screenMailCompose');
    assert.equal(await headerTitle(page), 'New message');
    // Nothing in small print under the form, and no Cancel (note #611).
    assert.equal(await page.$$eval('#screenMailCompose .mailnotes', (nodes) => nodes.length), 0);
    assert.equal(await page.$$eval('#screenMailCompose .authactions button', (nodes) => nodes.map((n) => n.textContent).join('|')), 'Send message');
    // And no box around the form: it is written on the page itself, its
    // fields starting where the title starts. Measured, not read off a class.
    const flat = await page.evaluate(() => {
      const form = document.querySelector('#screenMailCompose .mailcompose');
      const caption = form.querySelector('.drow .k').getBoundingClientRect();
      const title = document.querySelector('#pageHead #pageId h1');
      return {
        background: getComputedStyle(form).backgroundColor,
        cards: document.querySelectorAll('#screenMailCompose .card').length,
        offset: title ? Math.round(caption.left - title.getBoundingClientRect().left) : null,
      };
    });
    assert.equal(flat.background, 'rgba(0, 0, 0, 0)');
    assert.equal(flat.cards, 0);
    assert.equal(flat.offset, 0);
    await page.type('#mailToField', 'ada@example.com');
    await page.type('#mailSubjectField', 'The header crop');
    await page.type('#mailComposeText', 'Sending the crop over before Thursday, as promised.');
    await shoot('writing-a-new-message', { fullPage: true });
    await page.click('#mailComposeSend');
    await waitForAll(page, '#mailList', ['To ada@example.com', 'The header crop']);
    await shoot('written', { fullPage: true });

    // Last, the awkward shape behind note #534's one remaining doubt. A
    // message arrives carrying a formatted half made ENTIRELY of things this
    // app will not build — and with the plain-version switch gone, showing it
    // would leave the reader looking at an envelope over a blank card. The
    // text half catches it, unasked, in the same paint.
    const refused = await fetch(`${app.origin}/workspace/api/mail/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: 'Your parcel is out for delivery',
        snippet: 'Tracking 99-4412 · arriving before 6pm.',
        text: 'Tracking 99-4412\n\nArriving before 6pm. Nobody needs to be home.\n',
        html: '<marquee>Arriving before 6pm.</marquee><img src="https://track.example.com/open.gif" width="1" height="1">',
      }),
    });
    assert.equal(refused.status, 201);
    const { message: { id: refusedId } } = await refused.json();
    await open(page, app, `/mail/${refusedId}`, '#screenMailMessage');
    await waitVisible(page, '.mailtext');
    assert.match(normalizedText(await textOf(page, '.mailtext')), /Arriving before 6pm\. Nobody needs to be home\./);
    // No empty formatted box beside it, and no line about pictures either:
    // nothing was left out of the body that is being shown.
    assert.equal(await page.$$eval('.mailhtml', (nodes) => nodes.length), 0);
    assert.equal(await page.$$eval('.mailnotes', (nodes) => nodes.length), 0);
    assert.doesNotMatch(normalizedText(await textOf(page, '#screenMailMessage')), /had no words in it/);
    await shoot('markup-refused', { fullPage: true });

    // ── Slice 7: search, the archive and Trash ────────────────────────────
    // A search, typed into the field at the head of the list. The words go
    // into the entry's own address as she types, and the rows are the
    // inbox's own rows — only the ones that match.
    await open(page, app, '/mail', '#screenMail');
    await waitVisible(page, '#mailSearchField');
    const head = await page.evaluate(() => {
      const card = document.getElementById('mailList');
      const field = document.getElementById('mailSearch').getBoundingClientRect();
      const write = document.getElementById('mailWrite').getBoundingClientRect();
      const rows = [...card.querySelectorAll('.crow.open')].map((row) => row.getBoundingClientRect().top);
      return { underWrite: field.top >= write.bottom - 1, aboveRows: field.bottom <= Math.min(...rows) + 1, inCard: card.contains(document.getElementById('mailSearch')) };
    });
    assert.deepEqual(head, { underWrite: true, aboveRows: true, inCard: true });
    await page.type('#mailSearchField', 'brief');
    await waitForAll(page, '#mailFound', ['2 messages in your inbox and archive matching “brief”']);
    assert.equal(new URL(page.url()).searchParams.get('q'), 'brief');
    // A search finds LETTERS — Priya's answer and her brief, each its own
    // result — not the conversation around them.
    const found = await page.$$eval('#mailList .crow.open .mailsubject', (rows) => rows.map((row) => row.textContent.trim()));
    assert.deepEqual(found, ['Re: The brief, and one photograph', 'The brief, and one photograph']);
    await shoot('search', { fullPage: true });

    // Open what it found: its conversation, standing at the letter found —
    // Priya's answer, below her brief and the agent's letter. And come Back:
    // the results are still there, and so are the words that found them —
    // which is how a person works through a search.
    await page.click('#mailList .crow.open');
    await waitVisible(page, '#mailLetter-mm_studio_back');
    // Measured, not assumed: the page stands where that letter starts under
    // the header — or, on a screen tall enough to hold the whole conversation,
    // as far down as the page goes, with the letter in view.
    await page.waitForFunction(() => {
      const head = document.querySelector('.pagehead').getBoundingClientRect().bottom;
      const top = document.getElementById('mailLetter-mm_studio_back').getBoundingClientRect().top;
      const deepest = document.documentElement.scrollHeight - window.innerHeight;
      const wanted = Math.min(Math.max(0, Math.round(top + window.scrollY - head - 10)), deepest);
      return Math.abs(window.scrollY - wanted) <= 2 && top >= head - 1 && top < window.innerHeight - 40;
    }, { timeout: 10_000 });
    await shoot('search-result-in-its-conversation');
    await page.goBack();
    await waitVisible(page, '#screenMail');
    await waitForAll(page, '#mailFound', ['matching “brief”']);
    assert.equal(await page.$eval('#mailSearchField', (field) => field.value), 'brief');

    // Archive, from the letter itself. It stays in front of her with one line
    // saying where it now is — the SERVER's answer, not the button's — and
    // the way back standing where Archive was.
    await open(page, app, '/mail/mm_receipt', '#screenMailMessage');
    await waitVisible(page, '#mailArchive');
    // For the whole conversation, so under the title and above its first
    // letter — deciding it is done with does not need reading it to the end.
    const tools = await page.evaluate(() => {
      const row = document.getElementById('mailTools').getBoundingClientRect();
      const head = document.querySelector('.pagehead').getBoundingClientRect();
      const first = document.querySelector('#mailConversation .mailletter').getBoundingClientRect();
      return { belowTitle: row.top >= head.bottom - 1, aboveLetters: row.bottom <= first.top + 1,
        buttons: [...document.querySelectorAll('#mailTools button')].map((button) => button.textContent.trim()) };
    });
    assert.deepEqual(tools, { belowTitle: true, aboveLetters: true, buttons: ['Archive', 'Mark as spam', 'Move to Trash'] });
    await page.click('#mailArchive');
    await waitForAll(page, '#mailPlace', ['Archived. It is kept whole and still turns up in a search.']);
    assert.deepEqual(await page.$$eval('#mailTools button', (buttons) => buttons.map((button) => button.textContent.trim())), ['Move to inbox', 'Mark as spam', 'Move to Trash']);
    // Kept whole: the same letter, still drawn.
    await waitForAll(page, '#screenMailMessage', ['Invoice 4821']);
    await shoot('archived', { fullPage: true });

    // Out of the inbox, and found by a search from it, marked as archived.
    await open(page, app, '/mail', '#screenMail');
    await waitForAll(page, '#mailList', ['The brief, and one photograph']);
    assert.doesNotMatch(normalizedText(await textOf(page, '#mailList')), /Your September invoice/);
    await page.type('#mailSearchField', 'invoice');
    await waitForAll(page, '#mailList', ['Your September invoice', 'archived']);
    await shoot('found-in-the-archive', { fullPage: true });

    // The archive is a door at the foot of the inbox.
    await open(page, app, '/mail', '#screenMail');
    await tap(page, '#mailArchiveDoor');
    await waitVisible(page, '#screenMailArchive');
    assert.equal(await headerTitle(page), 'Archive');
    await waitForAll(page, '#mailList', ['Your September invoice']);
    assert.equal(await page.$$eval('#mailWrite', (nodes) => nodes.length), 0);
    await shoot('archive', { fullPage: true });

    // To Trash — from the archive, where it now is — and back with Restore,
    // which returns it to the archive it came from.
    await page.click('#mailList .crow.open');
    await waitVisible(page, '#mailTrash');
    await page.click('#mailTrash');
    await waitForAll(page, '#mailPlace', ['In Trash. Nothing here is deleted for good.']);
    assert.deepEqual(await page.$$eval('#mailTools button', (buttons) => buttons.map((button) => button.textContent.trim())), ['Restore']);
    await shoot('in-trash', { fullPage: true });

    // Trash holds it, and the newsletter her agent put there days ago — said
    // so on its row. An ordinary search does not dig in here.
    await open(page, app, '/mail/trash', '#screenMailTrash');
    assert.equal(await headerTitle(page), 'Trash');
    await waitForAll(page, '#mailList', ['Your September invoice', 'This week at Harborlight', 'put in Trash by Ruby']);
    await shoot('trash', { fullPage: true });
    await open(page, app, '/mail', '#screenMail');
    await waitVisible(page, '#mailSearchField');
    await page.type('#mailSearchField', 'harborlight');
    await waitForAll(page, '#mailFound', ['matching “harborlight”']);
    assert.doesNotMatch(normalizedText(await textOf(page, '#mailList')), /This week at Harborlight/);

    await open(page, app, '/mail/mm_receipt', '#screenMailMessage');
    await page.click('#mailRestore');
    await waitForAll(page, '#mailPlace', ['Archived.']);
    await page.click('#mailUnarchive');
    await page.waitForFunction(() => !document.getElementById('mailPlace'), { timeout: 10_000 });
    await open(page, app, '/mail', '#screenMail');
    await waitForAll(page, '#mailList', ['Your September invoice']);

    // A WHOLE conversation put away at once (slice 8): the one her agent
    // started and Priya answered. Both letters leave the inbox together, and
    // the archive holds the one row, still saying two.
    await open(page, app, '/mail/mm_agent_sent', '#screenMailMessage');
    await page.click('#mailArchive');
    await waitForAll(page, '#mailPlace', ['Archived.']);
    await open(page, app, '/mail', '#screenMail');
    await waitForAll(page, '#mailList', ['Your September invoice']);
    assert.doesNotMatch(normalizedText(await textOf(page, '#mailList')), /The crop/);
    await open(page, app, '/mail/archive', '#screenMailArchive');
    await waitForAll(page, '#mailList', ['The crop, as promised']);
    assert.equal(await page.$$eval('#mailList .crow.open', (rows) => rows
      .find((one) => one.textContent.includes('The crop, as promised'))?.querySelector('.mailcount')?.textContent.trim()), '2');
    await shoot('a-conversation-archived', { fullPage: true });

    // ── Slice 9: SENT ─────────────────────────────────────────────────────
    // What has gone OUT of the address, a door at the foot of the inbox and
    // ONE ROW PER LETTER: the message she wrote from the composer, the answer
    // she typed, the answer her AGENT sent — which is a row of no other list
    // — and the message her agent started, which she archived a moment ago
    // and which is still here, because Sent is not a place.
    await open(page, app, '/mail', '#screenMail');
    await tap(page, '#mailSentDoor');
    await waitVisible(page, '#screenMailSent');
    assert.equal(await headerTitle(page), 'Sent');
    await waitForAll(page, '#mailList', ['The header crop', 'The crop, as promised', 'sent by Ruby', 'archived']);
    const sent = await page.evaluate(() => [...document.querySelectorAll('#mailList .crow.open')].map((row) => ({
      name: row.querySelector('.mailtop .name').textContent.trim(),
      subject: row.querySelector('.mailsubject').textContent.trim(),
      marks: row.querySelector('.mailmarks')?.textContent.trim() ?? null,
    })));
    assert.deepEqual(sent, [
      { name: 'To ada@example.com', subject: 'The header crop', marks: null },
      { name: 'To Priya Raman', subject: 'Re: The brief, and one photograph', marks: null },
      { name: 'To Priya Raman', subject: 'Re: The brief, and one photograph', marks: 'sent by Ruby' },
      { name: 'To Priya Raman', subject: 'The crop, as promised', marks: 'sent by Ruby · archived' },
    ]);
    // Every row is one she sent, so none of them can be new — and the clock
    // still rides the name's line, at the row's own edge (note #529).
    const sentRows = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#mailList .crow.open')];
      const first = rows[0];
      const name = first.querySelector('.mailtop .name').getBoundingClientRect();
      const clock = first.querySelector('.mailtop .mailwhen').getBoundingClientRect();
      const main = first.querySelector('.main').getBoundingClientRect();
      return {
        neW: document.querySelectorAll('#mailList .mailnew').length,
        chevrons: document.querySelectorAll('#mailList .chev').length,
        write: document.querySelectorAll('#mailWrite').length,
        sameLine: Math.abs(clock.top - name.top) <= 4,
        clockAtEdge: Math.round(main.right - clock.right),
      };
    });
    assert.equal(sentRows.neW, 0);
    assert.equal(sentRows.chevrons, 0);
    assert.equal(sentRows.write, 0);
    assert.equal(sentRows.sameLine, true);
    assert.ok(sentRows.clockAtEdge <= 1, `the clock sits at the row's edge: ${sentRows.clockAtEdge}`);
    await shoot('sent', { fullPage: true });

    // Searched in Sent alone — and it looks through the words of a REPLY,
    // which no other list can: `Tuesday works` is what she typed back.
    await page.type('#mailSearchField', 'tuesday');
    await waitForAll(page, '#mailFound', ['1 message in Sent matching “tuesday”.']);
    assert.deepEqual(
      await page.$$eval('#mailList .crow.open .mailsubject', (rows) => rows.map((row) => row.textContent.trim())),
      ['Re: The brief, and one photograph'],
    );
    await shoot('sent-searched', { fullPage: true });

    // And a row opens the CONVERSATION it is part of, standing at that
    // letter: her answer, under Priya's brief and above Priya's answer.
    await page.click('#mailList .crow.open');
    await waitVisible(page, '#screenMailMessage');
    assert.equal(await headerTitle(page), 'The brief, and one photograph');
    await page.waitForFunction(() => {
      const own = [...document.querySelectorAll('#mailConversation .mailown')].at(-1);
      if (!own) return false;
      const head = document.querySelector('.pagehead').getBoundingClientRect().bottom;
      const top = own.getBoundingClientRect().top;
      return top >= head - 1 && top < window.innerHeight - 40;
    }, { timeout: 10_000 });
    await shoot('sent-letter-in-its-conversation');

    // ── Slice 12: WRITING GROWS UP ──────────────────────────────────────
    // Files on disk the way a phone's picker hands them over.
    const picks = mkdtempSync(path.join(tmpdir(), 'mail-picks-'));
    const file = (name, bytes) => { const at = path.join(picks, name); writeFileSync(at, bytes); return at; };
    const wide = file('header-crop-wide.jpg', Buffer.alloc(412_000, 1));
    const square = file('header-crop-square.jpg', Buffer.alloc(268_000, 2));
    const printNotes = file('print-notes.pdf', Buffer.alloc(96_000, 3));

    // A new message with a Cc line and two files. The Cc box is not there
    // until it is asked for — most letters go to one person — and the files
    // stand in the rows a letter's own files stand in.
    await open(page, app, '/mail', '#screenMail');
    await page.click('#mailWrite');
    await waitVisible(page, '#screenMailCompose');
    assert.equal(await page.$$eval('#screenMailCompose [id^="mailCcField-"]', (nodes) => nodes.length), 0);
    await page.type('#mailToField', 'ada@example.com');
    await page.click('#mailAddCc');
    await waitVisible(page, '#mailCcField-0');
    await page.type('#mailCcField-0', 'sam@harborlight.co');
    await page.type('#mailSubjectField', 'Both crops');
    await page.type('#mailComposeText', 'The wide one for the header and the square one for the card. Sam, over to you for print.');
    await (await page.$('#mailFileInput')).uploadFile(wide, square);
    await waitForAll(page, '#mailOutFiles', ['header-crop-wide.jpg', '402 KB', 'header-crop-square.jpg', '262 KB', 'Attach another file']);
    await shoot('writing-with-cc-and-files', { fullPage: true });
    await page.click('#mailComposeSend');
    await waitForAll(page, '#mailList', ['To ada@example.com', 'Both crops']);

    // Reply to all: Priya writes with Sam copied, and the reply composer
    // offers to copy him back — the answer still goes TO her, read off the
    // letter; only the Cc line is the reader's.
    const withSam = await fetch(`${app.origin}/workspace/api/mail/deliver`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: { name: 'Priya Raman', address: 'priya@harborlight.co' },
        cc: [{ name: 'Sam Okafor', address: 'sam@harborlight.co' }],
        subject: 'Thursday, with Sam',
        snippet: 'Sam is doing the print run — copying him so he has the dates.',
        text: 'Sam is doing the print run — copying him so he has the dates.\n\nThursday at ten still good?\n\n  — Priya',
      }),
    }).then((res) => res.json());
    await open(page, app, `/mail/${withSam.message.id}`, '#screenMailMessage');
    await page.click('#mailReply');
    await waitVisible(page, '#screenMailReply');
    await waitForAll(page, '#screenMailReply', ['Reply to all — also sam@harborlight.co']);
    await page.click('#mailReplyAll');
    await page.waitForFunction(() => document.getElementById('mailCcField-0')?.value === 'sam@harborlight.co', { timeout: 10_000 });
    assert.equal(await page.$$eval('#mailReplyAll', (nodes) => nodes.length), 0);
    await page.type('#mailReplyText', 'Thursday at ten is good for both of us.');
    await shoot('replying-to-all', { fullPage: true });
    await page.click('#mailReplySend');
    await waitForAll(page, '#mailConversation', ['From you to Priya Raman, copy to sam@harborlight.co', 'Thursday at ten is good']);

    // Forwarding the brief to the printer: its own file ticked, one more
    // added, and afterwards the letter itself says where it went.
    await open(page, app, '/mail/mm_studio_brief', '#screenMailMessage');
    await page.click('#mailForward-mm_studio_brief');
    await waitVisible(page, '#screenMailForward');
    assert.equal(await headerTitle(page), 'Forward');
    assert.equal(await page.$eval('#mailOutFiles .mailcarried input', (box) => box.checked), true);
    await page.type('#mailForwardTo', 'print@northpress.example');
    await page.type('#mailForwardText', 'The brief from Harborlight, with my notes for the run.');
    await (await page.$('#mailFileInput')).uploadFile(printNotes);
    await waitForAll(page, '#mailOutFiles', ['harborlight-brief.pdf', 'goes with it', 'print-notes.pdf']);
    await waitForAll(page, '#screenMailForward', ['The letter you are forwarding']);
    await shoot('forwarding-a-letter', { fullPage: true });
    await page.click('#mailForwardSend');
    await waitVisible(page, '#screenMailMessage');
    await waitForAll(page, '#mailConversation', ['Forwarded to print@northpress.example on', 'The brief from Harborlight']);
    const forwarded = await page.evaluate(() => {
      const own = [...document.querySelectorAll('#mailConversation .mailown')].at(-1);
      return {
        head: own.querySelector('.mailownhead .ctext').textContent.trim(),
        files: [...own.querySelectorAll('.mailfiles .name')].map((name) => name.textContent.trim()),
        under: document.querySelector('#mailLetter-mm_studio_brief .mailforwarded')?.textContent.trim() ?? '',
      };
    });
    assert.equal(forwarded.head, 'Forwarded to print@northpress.example');
    assert.deepEqual(forwarded.files, ['harborlight-brief.pdf', 'print-notes.pdf']);
    assert.match(forwarded.under, /^Forwarded to print@northpress\.example on /);
    await shoot('forwarded', { fullPage: true });

    // An agent asking to send with files (slice 12): the card in its chat
    // lists everybody the letter reaches and every file by name and size,
    // because a file is the part of a letter nobody can read off its words.
    const ruby = app.fixture.agent;
    await fetch(`${app.origin}/workspace/api/mail/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: ruby.id, kind: 'send', requestedBy: ruby.name,
        to: { address: 'ada@example.com' }, cc: [{ address: 'sam@harborlight.co' }],
        subject: 'Final crops for Thursday',
        text: 'Ada — the final crops are attached, and Sam has the print notes.\n\nSaddam',
        attachments: [
          { fileName: 'header-crop-wide.jpg', size: 412_000, contentType: 'image/jpeg' },
          { fileName: 'print-notes.pdf', size: 96_000, contentType: 'application/pdf' },
        ],
      }),
    });
    await open(page, app, `/chat/${ruby.id}`, '#screenAgentChat');
    await page.waitForSelector('[data-mail-approval] .mailapprovalfiles', { timeout: 10_000 });
    const card = await page.evaluate(() => {
      const node = [...document.querySelectorAll('[data-mail-approval]')].at(-1);
      return {
        title: node.querySelector('.chatnoticetitle').textContent.trim(),
        facts: [...node.querySelectorAll('.mailapprovalfacts > div')].map((row) => `${row.querySelector('dt').textContent.trim()} ${row.querySelector('dd').textContent.replace(/\s+/g, ' ').trim()}`),
        files: [...node.querySelectorAll('.mailapprovalfiles li')].map((item) => item.textContent.replace(/\s+/g, ' ').trim()),
      };
    });
    assert.equal(card.title, `${ruby.name} wants to send this message`);
    assert.ok(card.facts.includes('Cc sam@harborlight.co'), card.facts.join(' | '));
    assert.deepEqual(card.files, ['header-crop-wide.jpg 402 KB', 'print-notes.pdf 94 KB']);
    await page.evaluate(() => [...document.querySelectorAll('[data-mail-approval]')].at(-1).scrollIntoView({ block: 'center' }));
    await shoot('agent-card-lists-files');
    rmSync(picks, { recursive: true, force: true });

    // ── Who a letter wakes (slice 11) ───────────────────────────────────
    // The one place a person says that an arriving letter may start a turn.
    // It stands under Your address, because the choice is about the address.
    await open(page, app, '/profile', '#profileMailCard');
    await waitForAll(page, '#profileMailCard', [
      `${app.fixture.account.username.split('_')[0]}@agenticcloudcomputer.com`,
      'When mail arrives, wake',
      // The default is named — never a blank row that leaves them to guess
      // what nothing means.
      'Nobody',
    ]);
    await shoot('settings-mail-wake-nobody', { fullPage: true });

    await tapByText(page, '#profileMailCard', 'When mail arrives, wake');
    // The question stays on screen while it is answered — three bare names
    // under an address say nothing about what they are for.
    await waitForAll(page, '#profileMailCard', [
      'When mail arrives, wake',
      'Cancel',
    ]);
    // Nobody first, because that is where every address stands, then this
    // person's own agents with what each runs on. (Each named the room it
    // worked in too, until rooms left the product — note #843.)
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#profileMailCard .mailwakepick .name')];
      return rows.length === 3;
    }, { timeout: 10_000 });
    assert.deepEqual(
      await page.$$eval('#profileMailCard .mailwakepick', (rows) => rows.map((row) => ({
        name: row.querySelector('.name').textContent.trim(),
        line: row.querySelector('.meta').textContent.trim(),
      }))),
      [
        { name: 'Nobody', line: 'Default' },
        { name: 'Ruby', line: 'codex' },
        { name: 'Milo', line: 'claude' },
      ],
    );
    await shoot('settings-mail-wake-picking', { fullPage: true });

    await tapByText(page, '#profileMailCard', 'Ruby');
    // The row closes on the server's own answer and names who it now wakes
    // — by name alone, where it said "Ruby · Product" while there were rooms
    // (note #843). Read off the row's own line, since "Ruby" alone is also
    // in the list the row closes.
    await page.waitForFunction(() => (
      document.querySelectorAll('#profileMailCard .mailwakepick').length === 0
      && document.querySelector('#profileMailCard .mailwakerow .meta')?.textContent?.trim() === 'Ruby'
    ), { timeout: 10_000 });
    assert.equal(await page.$$eval('#profileMailCard .mailwakepick', (rows) => rows.length), 0);
    await shoot('settings-mail-wake-chosen', { fullPage: true });

    // ── Slice 13: SPAM, and blocking a sender ─────────────────────────────
    // A forgery wearing an address on her own domain landed in Spam on the
    // way in: it is on no inbox row, and a search from the inbox does not
    // reach into Spam for it.
    await open(page, app, '/mail', '#screenMail');
    await waitForAll(page, '#mailList', ['Priya Raman']);
    assert.doesNotMatch(normalizedText(await textOf(page, '#mailList')), /card was declined/);
    await page.type('#mailSearchField', 'declined');
    await waitForAll(page, '#mailFound', ['Nothing in your inbox and archive matches “declined”.']);

    // Spam is a door at the foot of the inbox, between the archive and Trash,
    // and its list says WHY each row is there.
    await open(page, app, '/mail', '#screenMail');
    await waitForAll(page, '#mailList', ['Priya Raman']);
    await waitVisible(page, '#mailSpamDoor');
    assert.deepEqual(await page.$$eval('#mailPlaces .crow', (doors) => doors.map((door) => door.id)),
      ['mailStarredDoor', 'mailSentDoor', 'mailArchiveDoor', 'mailSpamDoor', 'mailTrashDoor']);
    await tap(page, '#mailSpamDoor');
    await waitVisible(page, '#screenMailSpam');
    assert.equal(await headerTitle(page), 'Spam');
    await waitForAll(page, '#mailList', ['Agentbuilt Billing', 'Your card was declined — update it today', 'unverified sender']);
    assert.equal(await page.$$eval('#mailWrite', (nodes) => nodes.length), 0);
    await shoot('spam', { fullPage: true });

    // Opened: the warning, why it is here, Not spam and Trash — and no Reply.
    await page.click('#mailList .crow.open');
    await waitVisible(page, '#screenMailMessage');
    await waitForAll(page, '#mailPlace', ['In Spam: nothing vouched for the sender, so it never reached the inbox. It is kept whole.']);
    assert.deepEqual(await page.$$eval('#mailTools button', (buttons) => buttons.map((button) => button.textContent.trim())), ['Not spam', 'Move to Trash']);
    await waitForAll(page, '#mailConversation', ['treat it as forged', 'Block billing@agenticcloudcomputer.com']);
    assert.equal(await page.$$eval('#mailReply', (nodes) => nodes.length), 0);
    await shoot('in-spam', { fullPage: true });

    // BLOCKING A SENDER, from a letter they wrote: Fly.io's invoice leaves
    // the inbox for Spam with the decision, the letter says so from the
    // server's answer, and the way back stands where the block was.
    await open(page, app, '/mail/mm_receipt', '#screenMailMessage');
    await waitVisible(page, '#mailBlock-mm_receipt');
    assert.equal(await page.$eval('#mailBlock-mm_receipt', (button) => button.textContent.trim()), 'Block billing@fly.io');
    await page.click('#mailBlock-mm_receipt');
    await waitForAll(page, '#mailPlace', ['In Spam: you blocked the sender. It is kept whole.']);
    await waitForAll(page, '#mailBlock-mm_receipt', ['Unblock billing@fly.io']);
    await shoot('blocked-sender', { fullPage: true });
    await open(page, app, '/mail', '#screenMail');
    await waitForAll(page, '#mailList', ['Priya Raman']);
    assert.doesNotMatch(normalizedText(await textOf(page, '#mailList')), /Your September invoice/);
    await open(page, app, '/mail/spam', '#screenMailSpam');
    await waitForAll(page, '#mailList', ['Your September invoice', 'blocked sender', 'Your card was declined']);
    await shoot('spam-with-blocked', { fullPage: true });

    // Unblocked, the letter stays in Spam until she says it is not spam —
    // and Not spam puts it back in the inbox, where Mark as spam is offered
    // beside Archive.
    await open(page, app, '/mail/mm_receipt', '#screenMailMessage');
    await waitForAll(page, '#mailBlock-mm_receipt', ['Unblock billing@fly.io']);
    await page.click('#mailBlock-mm_receipt');
    await waitForAll(page, '#mailBlock-mm_receipt', ['Block billing@fly.io']);
    await waitForAll(page, '#mailPlace', ['In Spam: you blocked the sender.']);
    await page.click('#mailUnspam');
    await page.waitForFunction(() => !document.getElementById('mailPlace'), { timeout: 10_000 });
    assert.deepEqual(await page.$$eval('#mailTools button', (buttons) => buttons.map((button) => button.textContent.trim())), ['Archive', 'Mark as spam', 'Move to Trash']);
    await shoot('not-spam', { fullPage: true });
    await open(page, app, '/mail', '#screenMail');
    await waitForAll(page, '#mailList', ['Your September invoice']);

    // ── Note #666: STARS, and a list that PAGES ───────────────────────────
    // The star on a conversation's row stars it without opening it, and the
    // fill is the server's answer.
    const briefStar = await page.$eval('#mailList', (card) => {
      const row = [...card.querySelectorAll('.crow.open')].find((one) => one.textContent.includes('The brief, and one photograph'));
      return row.parentElement.querySelector(':scope > .mailstar').id;
    });
    await tap(page, `#${briefStar}`);
    await page.waitForFunction((id) => document.getElementById(id)?.getAttribute('aria-pressed') === 'true', { timeout: 10_000 }, briefStar);
    assert.ok(await page.$('#screenMail'), 'starring a row opened nothing');
    const lit = await page.$eval(`#${briefStar}`, (star) => ({
      classes: star.className,
      fill: getComputedStyle(star.querySelector('svg')).fill,
      label: star.getAttribute('aria-label'),
    }));
    assert.equal(lit.classes, 'mailstar on');
    assert.equal(lit.fill, 'rgb(244, 185, 47)');
    assert.equal(lit.label, 'Remove the star from this conversation');
    await shoot('starred-row', { fullPage: true });

    // Inside a conversation, every letter has its own star, on the line that
    // says who wrote it, just before the moment; the Fly.io invoice gets one.
    await open(page, app, '/mail/mm_receipt', '#screenMailMessage');
    await waitVisible(page, '#mailStar-mm_receipt');
    assert.ok(await page.$eval('#mailStar-mm_receipt', (star) => Boolean(star.closest('.mailwho'))));
    await page.click('#mailStar-mm_receipt');
    await page.waitForFunction(() => document.getElementById('mailStar-mm_receipt')?.getAttribute('aria-pressed') === 'true', { timeout: 10_000 });
    await shoot('starred-letter', { fullPage: true });

    // STARRED is a door at the head of the foot card, and a list of LETTERS:
    // both stars, newest first, each still where it is kept.
    await open(page, app, '/mail', '#screenMail');
    await waitVisible(page, '#mailStarredDoor');
    await tap(page, '#mailStarredDoor');
    await waitVisible(page, '#screenMailStarred');
    assert.equal(await headerTitle(page), 'Starred');
    await waitForAll(page, '#mailList', ['Your September invoice', 'The brief, and one photograph']);
    // The row's star went on what PRIYA wrote — not on the forward the owner
    // sent after it, which is newer and not what she starred the row for.
    assert.deepEqual(await page.$$eval('#mailList .crow.open .mailtop .name', (names) => names.map((name) => name.textContent.trim())),
      ['Priya Raman', 'Fly.io']);
    await shoot('starred-list', { fullPage: true });
    // Its star off, a letter leaves Starred at once.
    await page.click('#mailStar-mm_receipt');
    await page.waitForFunction(() => !document.body.textContent.includes('Your September invoice'), { timeout: 10_000 });
    assert.equal(await page.$$eval('#mailList .crow.open', (rows) => rows.length), 1);

    // PAGES. Sixty newsletters arrive; the inbox shows the newest fifty, and
    // the way to the rest stands at the foot of the list. Priya's brief is
    // older than all of them, so it is on the NEXT page.
    for (let at = 0; at < 60; at += 1) {
      const delivered = await fetch(`${app.origin}/workspace/api/mail/deliver`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: { name: 'Harborlight Weekly', address: 'weekly@harborlight.co' },
          subject: `This week at Harborlight, no. ${at + 1}`,
          snippet: 'The studio news, the lease, and the crop.',
        }),
      });
      assert.equal(delivered.status, 201);
    }
    await open(page, app, '/mail', '#screenMail');
    await waitForAll(page, '#mailList', ['This week at Harborlight, no. 60']);
    assert.equal(await page.$$eval('#mailList .crow.open', (rows) => rows.length), 50);
    assert.doesNotMatch(normalizedText(await textOf(page, '#mailList')), /The brief, and one photograph/);
    await waitVisible(page, '#mailOlder');
    assert.equal(await page.$eval('#mailOlder', (button) => button.textContent.trim()), 'Show older conversations');
    await tap(page, '#mailOlder');
    await waitForAll(page, '#mailList', ['The brief, and one photograph']);
    const paged = await page.$$eval('#mailList .crow.open', (rows) => rows.length);
    assert.ok(paged > 50, `the next page landed under the first: ${paged} rows`);
    // The last page carries no way to a next one.
    assert.equal(await page.$$eval('#mailOlder', (nodes) => nodes.length), 0);
    await shoot('older-conversations', { fullPage: true });
  },
});
