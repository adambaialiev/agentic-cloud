import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { forgetDrafts } from '../chrome/draft-memory.js';
import { forgetClouds } from '../cloud/cloud-cache.js';
import { rememberSetupPending } from '../onboarding/setup-hint.js';
import { forgetDrives } from '../screens/drive/drive-cache.js';
import { forgetChatFileTexts } from '../screens/chat/chat-file-text.js';
import { forgetRecapChats } from '../screens/home/recap-chat-cache.js';
import { forgetDirectMessages } from '../screens/messages/messages-cache.js';
import { forgetMail } from '../screens/mail/mail-cache.js';
import { forgetNotes } from '../screens/notes/note-cache.js';
import { forgetDecided } from '../workspace/decided.js';
import { forgetHeldDecisions } from '../screens/chat/decisions-memory.js';
import { forgetPeople } from '../screens/org/people-cache.js';
import { forgetOrgDetails } from '../screens/org/org-detail-cache.js';
import { forgetAgents } from '../screens/agent/agent-cache.js';
import { forgetRememberedRuntimes } from '../screens/agent/runtime-memory.js';

/**
 * How long a `waitFor` or a `findBy*` is allowed to wait for the thing it is
 * waiting for.
 *
 * Testing Library's own default is one second, and that is the same
 * WORKSTATION assumption `backend/vitest.config.ts` raises `testTimeout` over:
 * this suite runs 172 files at once on a shared-CPU CI machine measured at 11x
 * slower than this one. A second is plenty of room for the effect a test is
 * waiting on and no room at all for the event loop it is queued behind, so the
 * failure it produces is a red test on a green screen — the note margin's
 * `.ncmt` on 2026-09-03, which no local run could reproduce.
 *
 * Nothing green pays for this: a longer window is only ever spent by a test
 * that was going to fail anyway. What it buys is that a slow HOST reads as a
 * slow run rather than as a broken main.
 *
 * FIVE SECONDS WAS NOT ENOUGH, twice in one morning (2026-09-17): a
 * `findByRole` in `Drive.test.tsx` — one query of 4334 tests — ran out and
 * took main red, on a file that passes 18/18 locally in 9 s, where the whole
 * test around that query takes 475 ms. A 10x margin on the test and far more
 * on the query does not evaporate because a budget is tight; it evaporates
 * because the box stalled, which on that morning was the ~500 MB browser
 * download that used to run beside the lanes (`.agentbuilt/ci.sh` carries the
 * measurements, and has since moved it out). Fifteen seconds, then: the cause
 * is fixed in the same change, and this is the belt beside those braces —
 * still comfortably inside the 30 s `testTimeout` that wraps it, so a
 * genuinely hung query is still caught by the wall behind this one.
 */
configure({ asyncUtilTimeout: 15_000 });

afterEach(() => {
  cleanup();
  // Home's windows keep their levels in the browser entry (note #715), and
  // jsdom's history lives as long as the file: without this, the next test's
  // Home opens on whatever window the last one left standing.
  window.history.replaceState(null, '');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.className = '';
  // A note read in one test would otherwise be served straight to the next
  // one that opens the same number — the cache is per TAB, and a test file is
  // one tab. Cleared here rather than in each test file, because the screen
  // that reads from it is reachable from several of them.
  forgetNotes();
  forgetMail();
  // A decision taken in one test is not a decision in the next one's tab.
  forgetDecided();
  forgetHeldDecisions();
  // And the people cards: held per workplace per TAB, so one test's people
  // would otherwise open the next test's Home without its skeleton.
  forgetPeople();
  forgetOrgDetails();
  forgetRecapChats();
  forgetDirectMessages();
  // Same reasoning for the cloud card: it is held per TAB, and a test file
  // is one tab, so a connected cloud read in one test would open the next
  // test's Home already connected.
  forgetClouds();
  // And Drive: a folder listing read in one test would otherwise open the
  // next test's Drive on the last one's files.
  forgetDrives();
  forgetChatFileTexts();
  // And the agent screens and runtime pickers (note #630): held per TAB.
  forgetAgents();
  // And the model and effort kept in the browser's storage (note #735).
  forgetRememberedRuntimes();
  // And the words left in a composer: a draft is held per TAB too, so
  // without this the next test's chat would open on the last one's typing.
  forgetDrafts();
  // And whether the last workplace was mid-setup: kept in localStorage for
  // the next first paint, so without this one test's gate would choose the
  // next test's opening skeleton.
  rememberSetupPending(false);
  // jsdom keeps cookies between tests; a CSRF token left over from one
  // sign-in would make the next test's "signed out" a lie.
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
});
