import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BANNER_EXIT_MS, BANNER_MS, BannerProvider } from './Banner.js';
import { useBanner } from './useBanner.js';

function Trigger() {
  const banner = useBanner();
  return <button type="button" onClick={() => banner.show('Saved.', true)}>Show toast</button>;
}

afterEach(() => { vi.useRealTimers(); });

/** The entrance deliberately waits for two paints: mounted off-screen on the
 * first, then given `.show` on the second so the browser has two states to
 * animate between. Fake timers expose each animation frame as one timer. */
function finishEntrance() {
  act(() => { vi.advanceTimersToNextTimer(); });
  act(() => { vi.advanceTimersToNextTimer(); });
}

describe('the Workspace toast', () => {
  it('animates out when dismissed, then leaves the document', () => {
    vi.useFakeTimers();
    render(<BannerProvider><Trigger /></BannerProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
    const toast = screen.getByRole('alert');
    expect(toast.classList.contains('show')).toBe(false);
    finishEntrance();
    expect(toast.classList.contains('show')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(toast.classList.contains('show')).toBe(false);
    expect(screen.getByRole('alert')).toBe(toast);
    act(() => { vi.advanceTimersByTime(BANNER_EXIT_MS - 1); });
    expect(screen.getByRole('alert')).toBe(toast);
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('animates in, stays for five seconds, then animates out', () => {
    vi.useFakeTimers();
    render(<BannerProvider><Trigger /></BannerProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
    const toast = screen.getByRole('alert');
    expect(toast.classList.contains('show')).toBe(false);
    finishEntrance();
    expect(toast.classList.contains('show')).toBe(true);

    act(() => { vi.advanceTimersByTime(BANNER_MS - 1); });
    expect(toast.classList.contains('show')).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(toast.classList.contains('show')).toBe(false);
    expect(screen.getByRole('alert')).toBe(toast);
    act(() => { vi.advanceTimersByTime(BANNER_EXIT_MS); });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
