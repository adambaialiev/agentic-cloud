import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

class MockIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];

  disconnect(): void {}
  observe(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  unobserve(): void {}
}

class MockNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => 'default' as NotificationPermission);

  onclick: (() => void) | null = null;

  close(): void {}
}

const globalHooks = globalThis as unknown as {
  afterEach?: (fn: () => void) => void;
};

vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
vi.stubGlobal('Notification', MockNotification);
vi.spyOn(console, 'log').mockImplementation(() => {});
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.scrollTo = vi.fn();
/* jsdom does not play media; the home film starts itself from code (note
   #965), so give every test a quiet play() that resolves, as a browser that
   allows a muted film does. Tests that need another answer spy on it. */
window.HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
window.HTMLMediaElement.prototype.pause = function pause() {};

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

globalHooks.afterEach?.(() => {
  cleanup();
});
