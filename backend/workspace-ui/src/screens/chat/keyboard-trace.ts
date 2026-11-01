import { useEffect, type RefObject } from 'react';

/**
 * A recorder for the phone in the owner's hand — nothing else has reproduced
 * what it does with its keyboard (PRs #621, #624, #631 in September; #1337
 * and #1348 on the Chief of Staff's chat in October: every fix measured right
 * in a harness and wrong on the phone).
 *
 * Off unless the Workspace is opened with `?trace=keyboard` once, which
 * turns it on for that browser until `?trace=off`. On, every focus and blur
 * of the chat's box — and a visual viewport that moves while nothing is
 * being recorded, which is a keyboard leaving with the box still focused —
 * records the geometry the shell is placed by: the visual viewport, the
 * window, the page's scroll, whichever ancestor of the box the browser has
 * scrolled, the shell's own writes and where the box ended up — every frame
 * for three seconds, folded to the frames where something changed, and
 * paints it as a small table over the screen. A screenshot of that table is
 * the whole point: it travels through the chat as a picture.
 *
 * Shared by the room chat and the Chief of Staff's conversation, so a trace
 * from each on the same phone says what the two do differently (note #736).
 */
export const KEYBOARD_TRACE_KEY = 'chat-keyboard-trace';

export function keyboardTraceWanted(search: string): boolean {
  try {
    const asked = new URLSearchParams(search).get('trace');
    if (asked === 'keyboard') localStorage.setItem(KEYBOARD_TRACE_KEY, '1');
    else if (asked === 'off') localStorage.removeItem(KEYBOARD_TRACE_KEY);
    return localStorage.getItem(KEYBOARD_TRACE_KEY) === '1';
  } catch { return false; }
}

type Frame = Record<string, string | number>;

const same = (a: Frame, b: Frame): boolean => Object.keys(a).every((key) => key === 't' || key === 'why' || a[key] === b[key]);

/** The nearest ancestor of the box (the transcript's own pane excepted) that
 *  the browser has scrolled, named by id or first class with its scroll —
 *  the one fact a document-level reading cannot show. */
function scrolledAncestor(box: HTMLElement | null, pane: HTMLElement | null): string {
  for (let node = box?.parentElement ?? null; node; node = node.parentElement) {
    if (node === pane || !(node.scrollTop > 0)) continue;
    const name = node.id || node.classList[0] || node.tagName.toLowerCase();
    return `${name}:${Math.round(node.scrollTop)}`;
  }
  return '-';
}

/** The element whose bottom edge reaches furthest below the window — what
 *  gives the page room to scroll past its one screen. On the owner's phone
 *  (2026-10-11 20:00) the Chief of Staff's page was placed 516px down at
 *  the keyboard's first event, where the lab's copy of the same markup could
 *  only move the keyboard's 320: something on the live page extends it. */
function lowestElement(): string {
  const limit = window.innerHeight + 1;
  let best: { name: string; bottom: number } | null = null;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    if (el.id === 'agentChatTrace') continue;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= limit) continue;
    if (!best || rect.bottom > best.bottom) {
      best = { name: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList[0] ? `.${el.classList[0]}` : ''}`, bottom: Math.round(rect.bottom) };
    }
  }
  return best ? `${best.name}:${best.bottom}` : '-';
}

export function useKeyboardTrace(root: RefObject<HTMLElement | null>, pane: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const screen = root.current;
    if (!screen) return;
    const box = () => document.getElementById('agentChatText') as HTMLTextAreaElement | null;
    let sheet = document.getElementById('agentChatTrace') as HTMLPreElement | null;
    if (!sheet) {
      sheet = document.createElement('pre');
      sheet.id = 'agentChatTrace';
      sheet.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;margin:0;padding:6px 8px;max-width:100vw;max-height:60vh;overflow:auto;'
        + 'font:8.5px/1.25 ui-monospace,Menlo,monospace;background:rgba(0,0,0,.85);color:#9f9;pointer-events:auto;white-space:pre';
      sheet.textContent = `keyboard trace on (${screen.id}) — tap the box, hide the keyboard, screenshot this`;
      sheet.addEventListener('click', () => { sheet!.hidden = true; });
      document.body.appendChild(sheet);
    }
    let run: { t0: number; kind: string; frames: Frame[]; stop: boolean } | null = null;
    const snap = (why: string): Frame => {
      const vv = window.visualViewport;
      const b = box();
      const se = document.scrollingElement;
      return {
        t: Math.round(performance.now() - (run?.t0 ?? 0)), why,
        vh: vv ? Math.round(vv.height) : -1, vtop: vv ? Math.round(vv.offsetTop) : -1, vpage: vv ? Math.round(vv.pageTop) : -1,
        inner: window.innerHeight, sy: Math.round(window.scrollY), dvh: document.documentElement.clientHeight,
        dsh: se ? Math.round(se.scrollHeight) : -1, bsh: Math.round(document.body.scrollHeight),
        shell: document.documentElement.style.getPropertyValue('--chat-shell-height') || '-', shift: screen.style.transform || '-',
        anc: scrolledAncestor(b, pane.current), low: lowestElement(),
        st: pane.current ? Math.round(pane.current.scrollTop) : -1,
        boxB: b ? Math.round(b.getBoundingClientRect().bottom) : -1, foc: document.activeElement === b ? 1 : 0,
      };
    };
    const paint = (r: { kind: string; frames: Frame[] }) => {
      const kept = [] as Frame[];
      for (const frame of r.frames) {
        const last = kept[kept.length - 1];
        if (!last || frame.why !== 'frame' || !same(frame, last)) kept.push(frame);
      }
      const keys = Object.keys(kept[0] ?? {});
      const lines = [`${screen.id} ${r.kind} ${new Date().toISOString().slice(11, 19)}`, keys.join(' ')];
      for (const frame of kept) lines.push(keys.map((key) => String(frame[key])).join(' '));
      sheet!.hidden = false;
      sheet!.textContent = `${lines.join('\n')}\n\n${sheet!.textContent}`.slice(0, 6000);
    };
    const record = (kind: string) => {
      if (run) run.stop = true;
      const r = run = { t0: performance.now(), kind, frames: [] as Frame[], stop: false };
      const loop = () => {
        if (r.stop) return;
        r.frames.push(snap('frame'));
        if (performance.now() - r.t0 < 3000) requestAnimationFrame(loop);
        else { if (run === r) run = null; paint(r); }
      };
      requestAnimationFrame(loop);
    };
    // A viewport that moves while nothing is being recorded is a keyboard
    // leaving (or arriving) with no focus change — Send, Done, a swipe — and
    // starts a recording of its own.
    const mark = (why: string) => () => { if (run) run.frames.push(snap(why)); else record(why); };
    const marks: Array<[EventTarget | undefined, string, () => void]> = [
      [window.visualViewport ?? undefined, 'resize', mark('vv-resize')],
      [window.visualViewport ?? undefined, 'scroll', mark('vv-scroll')],
      [window, 'resize', mark('win-resize')],
      [window, 'scroll', mark('win-scroll')],
    ];
    for (const [target, name, fn] of marks) target?.addEventListener(name, fn);
    const onFocus = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.id !== 'agentChatText') return;
      record(event.type === 'focusin' ? 'focus' : 'blur');
    };
    screen.addEventListener('focusin', onFocus);
    screen.addEventListener('focusout', onFocus);
    return () => {
      if (run) run.stop = true;
      for (const [target, name, fn] of marks) target?.removeEventListener(name, fn);
      screen.removeEventListener('focusin', onFocus);
      screen.removeEventListener('focusout', onFocus);
      sheet?.remove();
    };
  }, [on, pane, root]);
}
