import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfirmProvider } from './Confirm.js';
import { useConfirm } from './useConfirm.js';

/** A screen that asks the way the real ones do: in the middle of a handler,
 *  and carrying on only if the answer came back true. */
function Screen({ done, question = { title: 'Delete it?', message: 'It cannot be undone.', verb: 'Delete', danger: true } }: {
  done: (answered: boolean) => void;
  question?: { title: string; message: string; verb: string; danger?: boolean };
}) {
  const ask = useConfirm();
  return (
    <button type="button" onClick={async () => { done(await ask(question)); }}>Act</button>
  );
}

describe('ConfirmProvider', () => {
  it('answers true only when the verb is pressed, and the card carries the question', async () => {
    const answers: boolean[] = [];
    render(<ConfirmProvider><Screen done={(answered) => answers.push(answered)} /></ConfirmProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Act' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Delete it?' })).toBeTruthy();
    expect(within(dialog).getByText('It cannot be undone.')).toBeTruthy();
    // `danger` is the whole warning this button carries (note #624).
    expect(within(dialog).getByRole('button', { name: 'Delete' }).classList.contains('danger')).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(answers).toEqual([true]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('answers false on Cancel — the handler that asked must carry on, not hang', async () => {
    const answers: boolean[] = [];
    render(<ConfirmProvider><Screen done={(answered) => answers.push(answered)} /></ConfirmProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Act' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(answers).toEqual([false]));
  });

  it('paints the answer as the primary move when nothing is destroyed', async () => {
    render(
      <ConfirmProvider>
        <Screen done={() => {}} question={{ title: 'Grow it?', message: 'Costs more.', verb: 'Grow storage' }} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Act' }));
    const grow = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Grow storage' });
    expect(grow.classList.contains('primary')).toBe(true);
    expect(grow.classList.contains('danger')).toBe(false);
  });

  it('answers a question it replaces NO, so no handler is left suspended for good', async () => {
    const answers: string[] = [];
    function Two() {
      const ask = useConfirm();
      return (
        <>
          <button type="button" onClick={async () => { answers.push(`first:${await ask({ title: 'First?', message: 'm', verb: 'Yes' })}`); }}>First</button>
          <button type="button" onClick={async () => { answers.push(`second:${await ask({ title: 'Second?', message: 'm', verb: 'Yes' })}`); }}>Second</button>
        </>
      );
    }
    render(<ConfirmProvider><Two /></ConfirmProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'First' }));
    await screen.findByRole('heading', { name: 'First?' });
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    await screen.findByRole('heading', { name: 'Second?' });
    await waitFor(() => expect(answers).toEqual(['first:false']));

    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(answers).toEqual(['first:false', 'second:true']));
  });

  it('refuses to be used without a provider, rather than silently answering no', () => {
    // The screens ask inside a handler that then deletes something: a hook
    // that quietly resolved false here would read as "the reader said no"
    // on every screen mounted outside the app.
    expect(() => render(<Screen done={() => {}} />)).toThrow(/needs a ConfirmProvider/);
  });
});
