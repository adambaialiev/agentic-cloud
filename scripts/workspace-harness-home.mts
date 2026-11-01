// Home's Workplace window and the agents picker (note #715), for the
// harnesses that used to open the overview's tabs. The overview's address
// still works — its workplace half opens Home with the Workplace window, its
// other half (`half=agents`, or an old link's `half=rooms`) opens Home with
// the agents picker.
//
// The picker had ROOMS as its tabs, a room's tab was the room's whole view
// (its agents and notes shelves), and these helpers walked into one, until
// rooms left the product (note #843): the picker is one list of every agent,
// and the notes are the workplace's, in the Workplace window beside Drive,
// knowledge and secrets.
import type { Page } from 'puppeteer-core';

/**
 * Home with the agents picker open from the stack of faces by the message
 * box: one list of every agent, its cards drawn. A picker already up is
 * used as it is.
 */
export async function openAgentsPicker(page: Page, origin: string, { timeout = 15_000 }: { timeout?: number } = {}): Promise<void> {
  if (!(await page.$('#agentSwitchSheet'))) {
    await page.goto(`${origin}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#screenHome #agentChatSwitch', { timeout });
    // Loading `/` while already on `/` is a reload, and a reload stands the
    // Workplace window that was open up again (it is the entry's state) — so
    // close whatever stands before the stack it covers is tapped.
    await closeHomeWindow(page, { timeout });
    await page.click('#agentChatSwitch');
    await page.waitForSelector('#agentSwitchSheet', { timeout });
  }
  await page.waitForSelector('#agentSwitchSheet #agentSwitchGrid', { timeout });
}

/** The agents the picker lists, in its order, by their cards' ids. */
export async function pickerAgentIds(page: Page): Promise<string[]> {
  return page.$$eval('#agentSwitchGrid .crow[data-agent]', (nodes) => nodes.map((node) => node.getAttribute('data-agent') ?? ''));
}

/** Home with the Workplace window open. */
export async function openWorkplaceWindow(page: Page, origin: string, { timeout = 15_000 }: { timeout?: number } = {}): Promise<void> {
  await page.goto(`${origin}/overview?half=workplace`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#homeSheet #homeWorkplace', { timeout });
}

/** Close whatever stands over Home — the Workplace window, the picker —
 *  by its Close, and wait for it to go. */
export async function closeHomeWindow(page: Page, { timeout = 10_000 }: { timeout?: number } = {}): Promise<void> {
  if (await page.$('#homeSheetClose')) {
    await page.click('#homeSheetClose');
    await page.waitForFunction(() => !document.getElementById('homeSheet'), { timeout });
  }
  if (await page.$('#agentSwitchClose')) {
    await page.click('#agentSwitchClose');
    await page.waitForFunction(() => !document.getElementById('agentSwitchSheet'), { timeout });
  }
}
