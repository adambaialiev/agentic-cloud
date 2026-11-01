/**
 * The page's one toast — the legacy `banner(text, ok)`.
 *
 * It exists because some answers have nowhere else to land: a send that
 * failed while the composer is still on screen, a delete whose own screen has
 * already gone. Anything the screen itself can say, the screen says; this is
 * for the rest.
 *
 * Rebuilt on every message rather than re-texted, exactly as the legacy one
 * is: the tick/warning glyph is part of the message, and a failure that kept
 * the previous success's tick would read as a success.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BannerContext, type BannerValue } from './banner-context.js';
import { Icon } from '../ui/icons.js';

export const BANNER_MS = 5000;
export const BANNER_EXIT_MS = 300;

interface Message { text: string; ok: boolean; nonce: number }

export function BannerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<Message | null>(null);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const firstFrame = useRef<number | undefined>(undefined);
  const secondFrame = useRef<number | undefined>(undefined);
  const nonce = useRef(0);

  const clearFrames = useCallback(() => {
    if (firstFrame.current !== undefined) cancelAnimationFrame(firstFrame.current);
    if (secondFrame.current !== undefined) cancelAnimationFrame(secondFrame.current);
    firstFrame.current = undefined;
    secondFrame.current = undefined;
  }, []);

  useEffect(() => () => {
    clearTimeout(timer.current);
    clearTimeout(exitTimer.current);
    clearFrames();
  }, [clearFrames]);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    clearFrames();
    setShown(false);
    clearTimeout(exitTimer.current);
    // Keep the node mounted while the base rule's exit transition runs.
    exitTimer.current = setTimeout(() => setMessage(null), BANNER_EXIT_MS);
  }, [clearFrames]);

  const show = useCallback((text: string, ok = false) => {
    clearTimeout(timer.current);
    clearTimeout(exitTimer.current);
    clearFrames();
    setShown(false);
    nonce.current += 1;
    setMessage({ text, ok, nonce: nonce.current });
  }, [clearFrames]);

  useEffect(() => {
    if (!message) return undefined;
    // Two frames guarantee that the browser paints the mounted toast in its
    // off-screen base state before `.show` asks it to transition into place.
    firstFrame.current = requestAnimationFrame(() => {
      secondFrame.current = requestAnimationFrame(() => {
        firstFrame.current = undefined;
        secondFrame.current = undefined;
        setShown(true);
        timer.current = setTimeout(hide, BANNER_MS);
      });
    });
    return () => {
      clearTimeout(timer.current);
      clearFrames();
    };
  }, [clearFrames, hide, message]);

  const value = useMemo<BannerValue>(() => ({ show, hide }), [show, hide]);

  return (
    <BannerContext value={value}>
      {children}
      {/* Absent, not empty, when there is nothing to say: an always-present
          `role="alert"` is a second alert on every screen, and the one the
          reader (or a test) means is the screen's own. */}
      {message
        ? (
          <div className={`${shown ? 'show ' : ''}${message.ok ? 'ok' : ''}`.trim()} id="banner" role="alert" key={message.nonce}>
            <Icon name={message.ok ? 'check' : 'alert'} size={17} className="toastmark" />
            <span className="toastmessage">{message.text}</span>
            <button className="toastdismiss" type="button" aria-label="Dismiss notification" onClick={hide}>
              <Icon name="x" size={16} />
            </button>
          </div>
        )
        : null}
    </BannerContext>
  );
}
