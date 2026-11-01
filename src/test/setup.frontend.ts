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

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

globalHooks.afterEach?.(() => {
  cleanup();
});
