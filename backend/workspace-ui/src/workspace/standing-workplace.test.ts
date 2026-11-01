import { afterEach, describe, expect, it } from 'vitest';
import { forgetStandingWorkplace, standInAddressedWorkplace, standInWorkplace, standingWorkplace } from './standing-workplace.js';

/**
 * The tab's own workplace (note #628): kept per tab, survives a reload, and
 * gone at sign-out. The module cache is what a page reads; sessionStorage is
 * what a reload finds.
 */
describe('standing workplace', () => {
  afterEach(() => { forgetStandingWorkplace(); window.sessionStorage.clear(); });

  it('stands in the workplace it is told, and writes it to this tab alone', () => {
    expect(standingWorkplace()).toBeNull();
    standInWorkplace('o-a');
    expect(standingWorkplace()).toBe('o-a');
    expect(window.sessionStorage.getItem('acc.standingWorkplace')).toBe('o-a');
    expect(window.localStorage.getItem('acc.standingWorkplace')).toBeNull();
  });

  it('forgets on sign-out, in memory and on the shelf', () => {
    standInWorkplace('o-a');
    forgetStandingWorkplace();
    expect(standingWorkplace()).toBeNull();
    expect(window.sessionStorage.getItem('acc.standingWorkplace')).toBeNull();
  });

  it('opens where its address says, and stays put when the address names nothing', () => {
    standInWorkplace('o-a');
    standInAddressedWorkplace('?half=rooms&room=r1');
    expect(standingWorkplace()).toBe('o-a');
    standInAddressedWorkplace('?org=o-b&room=r9');
    expect(standingWorkplace()).toBe('o-b');
    standInAddressedWorkplace('?org=%20');
    expect(standingWorkplace()).toBe('o-b');
  });

  it('treats a blank as standing nowhere', () => {
    standInWorkplace('   ');
    expect(standingWorkplace()).toBeNull();
    expect(window.sessionStorage.getItem('acc.standingWorkplace')).toBeNull();
  });
});
