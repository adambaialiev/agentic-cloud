import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AskByTyping, AskToChoose } from './Ask.js';

describe('Scrim', () => {
  it('stands on the document body, not inside the scroller whose button asked (note #347)', () => {
    const onAnswer = vi.fn();
    render(
      <div className="facerow" style={{ overflowX: 'auto' }}>
        <button type="button">Create agent</button>
        <AskToChoose title="New agent" options={[{ id: 'claude', label: 'Claude Code' }]} onAnswer={onAnswer} />
      </div>,
    );

    const dialog = screen.getByRole('dialog');
    // iPhone Safari clips a fixed backdrop to a scrolling ancestor, so the
    // only safe place for one is outside every scroller: a direct child of
    // the body, with nothing of the asking section above it.
    expect(dialog.closest('.facerow')).toBeNull();
    expect(dialog.parentElement?.classList.contains('scrim')).toBe(true);
    expect(dialog.parentElement?.parentElement).toBe(document.body);

    // …and the answers still reach the component that asked.
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(onAnswer).toHaveBeenCalledWith('claude');
  });
});

describe('AskByTyping', () => {
  it('keeps the confirmation field focused while its controlled value changes', () => {
    const onAnswer = vi.fn();
    render(<AskByTyping name="Ada" lines={['This cannot be undone.']} verb="Delete" onAnswer={onAnswer} />);

    const field = screen.getByRole('textbox', { name: 'Type Ada to confirm' });
    field.focus();
    fireEvent.change(field, { target: { value: 'A' } });
    fireEvent.change(field, { target: { value: 'Ad' } });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(field);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
