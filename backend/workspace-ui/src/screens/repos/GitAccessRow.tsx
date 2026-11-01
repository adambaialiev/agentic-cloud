/**
 * "Clone on your computer" — the personal git key, in the FOOTER of the
 * repository list.
 *
 * There rather than on a repository's own screen because cloning is a
 * property of the whole namespace, not of any one repository — which is also
 * why it shares the footer strip with the storage line, the card's other
 * namespace-wide fact. It used to be a full row: a 20px key in the icon
 * column, a 15px title and a second line under it, which is the exact shape
 * a REPOSITORY has. With one repository on the shelf, half the card was a
 * link to a settings panel wearing a repository's clothes (note #360). A
 * key is not a thing you own, it is a thing you fetch once, so it reads as
 * one quiet line of the footer and opens the same panel it always did.
 *
 * The key is never shown: minting it writes it straight to the clipboard,
 * inside the tap that asked for it, because Safari only honours a clipboard
 * write that starts synchronously in the gesture.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceGitAccessAnswer } from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { Icon } from '../../ui/icons.js';
import { copyFromTap, errorMessage } from '../../ui/format.js';
import { relative } from '../../ui/time.js';

export function GitAccessRow({ cloneExample }: { cloneExample?: string }) {
  const { api } = useSession();
  const banner = useBanner();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<WorkspaceGitAccessAnswer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const read = useCallback(async () => {
    try {
      const answer = await api.api<WorkspaceGitAccessAnswer>('api/git-access');
      if (alive.current) { setState(answer); setError(''); }
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure));
    }
  }, [api]);

  // Read only when the card is opened: a key nobody asked about costs a
  // request on every Home paint otherwise.
  useEffect(() => { if (open && !state && !error) void read(); }, [open, state, error, read]);

  const mint = () => {
    setBusy(true);
    // The mint must live INSIDE the tap for the clipboard write to count.
    void copyFromTap(() => api.api<{ token: string }>('api/git-access', { method: 'POST' })
      .then((answer) => answer.token))
      .then(async () => {
        banner.show('Key copied — paste it wherever git asks for a password.', true);
        setState(null);
        await read();
      })
      .catch((failure) => { banner.show(errorMessage(failure)); })
      .finally(() => { if (alive.current) setBusy(false); });
  };

  const revoke = () => {
    setBusy(true);
    void (async () => {
      try {
        await api.api('api/git-access', { method: 'DELETE' });
        banner.show('Key revoked.', true);
        setState(null);
        await read();
      } catch (failure) {
        banner.show(errorMessage(failure));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  };

  return (
    <>
      {/* No second line any more: "A git key for your own machine" said in
          the closed state exactly what the panel's own first sentence says
          in the open one, and it was the line that made this a two-storey
          row. The words that remain are the words the note names. */}
      <button
        className="gitkeytap"
        type="button"
        id="gitKeyTap"
        aria-expanded={open}
        aria-controls="gitKeyCard"
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="key" size={13} />
        Clone on your computer
      </button>
      <div className="gitkeycard" id="gitKeyCard" hidden={!open}>
        {open ? (
          <>
            <div className="hintline">
              Clone and push with git from your own computer. Username: x-access-token — password: your key.
            </div>
            {cloneExample ? <div className="clone">git clone {cloneExample}</div> : null}
            {error ? <div className="hintline">{error}</div> : null}
            {!error && !state ? <div className="hintline">Loading…</div> : null}
            {state ? (
              <div className="hintline">
                {state.createdAt
                  ? `You have a key, made ${relative(state.createdAt)}. A new one replaces it everywhere.`
                  : 'No key yet. It is shown to nobody — it goes straight to your clipboard.'}
              </div>
            ) : null}
            {state ? (
              <div className="btns">
                <button className="btn" type="button" disabled={busy} onClick={mint}>
                  {state.createdAt ? 'New key & copy' : 'Create key & copy'}
                </button>
                {state.createdAt
                  ? <button className="btn ghost" type="button" disabled={busy} onClick={revoke}>Revoke</button>
                  : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
