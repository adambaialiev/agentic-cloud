import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BackProvider } from './PageHead.js';
import { useBack } from './useBack.js';

/** A deliberately slow owner: real leaves normally unmount with their
 * screen, but a partial sheet or an async close may remain for one commit.
 * BackProvider is the last boundary, so the test keeps this one mounted while
 * the browser entry changes. */
function HeldClaim({ close }: { close: () => void }) {
  const { claim } = useBack();
  useEffect(() => claim(close), [claim, close]);
  return null;
}

function Probe({ close }: { close: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const back = useBack();
  const [handled, setHandled] = useState('');
  return (
    <>
      <HeldClaim close={close} />
      <span>{location.pathname}</span>
      <span>{back.claimed ? 'claimed here' : 'not claimed here'}</span>
      <button type="button" onClick={() => navigate('/chat?half=workplace', { replace: true })}>rewrite address</button>
      <button type="button" onClick={() => navigate('/subscription')}>open subscription</button>
      <button type="button" onClick={() => setHandled(String(back.handle()))}>ask owner</button>
      <span>{handled}</span>
    </>
  );
}

describe('Back ownership', () => {
  it('belongs only to the browser entry the leaf covered', () => {
    const close = vi.fn();
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <BackProvider><Probe close={close} /></BackProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'ask owner' }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.getByText('true')).toBeTruthy();
    expect(screen.getByText('claimed here')).toBeTruthy();

    // A replacement rewrites this browser entry; it is not a new place for
    // Back purposes, so the leaf still owns it under the fresh router key.
    fireEvent.click(screen.getByRole('button', { name: 'rewrite address' }));
    expect(screen.getByText('claimed here')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ask owner' }));
    expect(close).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'open subscription' }));
    expect(screen.getByText('/subscription')).toBeTruthy();
    expect(screen.getByText('not claimed here')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'ask owner' }));
    expect(close).toHaveBeenCalledTimes(2);
    expect(screen.getByText('false')).toBeTruthy();
  });
});
