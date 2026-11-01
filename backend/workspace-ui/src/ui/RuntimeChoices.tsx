import type { ReactNode } from 'react';
import type { WorkspaceRuntimeModel } from '../../../src/shared/workspace-api.js';
import { ScreenTitle } from '../chrome/ScreenTitle.js';
import { effortLine, effortName, heavyEffortNote, modelName } from './runtime-words.js';

/** One model. The current choice is a STATE, not a no-op button — the same
 *  rule the room and subscription pickers follow. The name is the model's
 *  in words, in the reading face: no terminal glyph, which every row wore
 *  alike and so said nothing (the owner, 2026-09-29). */
function ModelRow({ option, current, disabled, locked, onPick }: {
  option: { value: string; label: string; available?: boolean };
  current: boolean;
  disabled: boolean;
  /** The whole page waits for a sign-in, and says so once above the list. */
  locked: boolean;
  onPick: () => void;
}) {
  const body = (
    <>
      <div className="main">
        <div className="name plain">{modelName(option.label)}{option.available === false && !locked ? ' (unavailable)' : ''}</div>
      </div>
      {current ? <span className="badge">current</span> : null}
    </>
  );
  if (current) {
    return <div className="crow current">{body}</div>;
  }
  return (
    <button className="crow open" type="button" disabled={disabled} onClick={onPick}>
      {body}
    </button>
  );
}

/**
 * Effort is a SCALE, so it is drawn as one (the owner, 2026-09-29): the
 * model's own levels as steps in one tray, least thinking on the left, with
 * one line under it about the step that is chosen. Five identical rows took
 * half the screen and hid the one thing the levels have in common — that
 * each thinks longer than the last.
 *
 * A HEAVY step still says what it costs before the tap (note #482): its word
 * is in the palette's colour for approaching a limit, and the line under the
 * tray says the mark when a heavy step is the chosen one. The mark is drawn
 * from the level's own `heavy` flag, never from its name. The chosen step is
 * a state, like the current model row: pressing it again writes nothing.
 */
function EffortScale({ prefix, efforts, current, disabled, onPick }: {
  prefix: string;
  efforts: Array<{ value: string; label: string; heavy?: boolean }>;
  current: string;
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  const chosen = efforts.find((option) => option.value === current);
  const line = chosen ? effortLine(chosen) : '';
  return (
    <div className="effortscale" id={`${prefix}Efforts`}>
      <div className="effortsteps" role="radiogroup" aria-label="Effort">
        {efforts.map((option) => {
          const on = option.value === current;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              className={`effortstep${on ? ' current' : ''}${option.heavy ? ' heavy' : ''}`}
              disabled={disabled && !on}
              onClick={() => { if (!on) onPick(option.value); }}
            >
              {effortName(option.label)}
            </button>
          );
        })}
      </div>
      <div className="effortends" aria-hidden="true"><span>Less thinking</span><span>More thinking</span></div>
      {line
        ? <div className={`effortnow${chosen?.heavy ? ' heavy' : ''}`} id={`${prefix}EffortNow`}>{line}</div>
        : null}
    </div>
  );
}

export function RuntimeChoices({ screenId, prefix, title, sub, hint, lock, settings, failure, refused, writing, choose }: {
  screenId: string; prefix: string; title: ReactNode; sub: string; hint?: string;
  /** Why nothing here can be picked yet, and the way to change that: drawn
   *  above the list, which stays readable — what there is, and what is set —
   *  while every row and level is held (note #747). */
  lock?: ReactNode;
  settings: { model: string; effort: string; models: Array<WorkspaceRuntimeModel & { available?: boolean }> } | null;
  failure: string; refused: { kind: 'model' | 'effort'; text: string } | null; writing: boolean;
  choose: (kind: 'model' | 'effort', value: string) => void;
}) {
  const catalog = settings?.models ?? [];
  const selected = catalog.find((option) => option.value === settings?.model);
  const efforts = selected?.efforts ?? [];
  // Only the levels this model actually offers: a caution naming a level the
  // command would reject is a caution about nothing.
  const heavyNote = heavyEffortNote(efforts.filter((option) => option.heavy).map((option) => effortName(option.label)));
  return (
    <div className="screen runtimepicker" id={screenId}>
      <ScreenTitle titleId={`${prefix}Title`} title={title} />
      <div className="sub" id={`${prefix}Sub`}>
        {sub}
      </div>
      {lock ? <div className="runtimelock" id={`${prefix}Lock`}>{lock}</div> : null}
      <h2>Model</h2>
      <div className={`card runtimecard${lock ? ' locked' : ''}`} id={`${prefix}Models`}>
        {!settings
          ? <div className="empty">{failure || 'Loading choices…'}</div>
          : catalog.length === 0
            ? <div className="empty">No model choices are available.</div>
            : catalog.map((option) => (
              <ModelRow
                key={option.value}
                option={option}
                current={option.value === settings.model}
                disabled={writing || option.available === false}
                locked={Boolean(lock)}
                onPick={() => { void choose('model', option.value); }}
              />
            ))}
      </div>
      {refused?.kind === 'model'
        ? <div className="formfail" id={`${prefix}ModelFail`} role="alert">{refused.text}</div>
        : null}
      <h2>Effort</h2>
      {/* No model yet — the read has not said which is current (note #718)
          — and the levels wait for one; a model with no levels says so. */}
      {!settings || !selected
        ? <div className="card runtimecard" id={`${prefix}Efforts`}><div className="empty">Effort choices follow the model.</div></div>
        : efforts.length === 0
          ? <div className="card runtimecard" id={`${prefix}Efforts`}><div className="empty">This model has no effort setting.</div></div>
          : <EffortScale prefix={prefix} efforts={efforts} current={settings.effort}
            disabled={writing || selected?.available === false}
            onPick={(value) => { void choose('effort', value); }} />}
      {refused?.kind === 'effort'
        ? <div className="formfail" id={`${prefix}EffortFail`} role="alert">{refused.text}</div>
        : null}
      {heavyNote
        ? <div className="formhint" id={`${prefix}EffortCost`}>{heavyNote}</div>
        : null}
      {hint && !lock
        ? <div className="formhint" id={`${prefix}Hint`}>{hint}</div>
        : null}
    </div>
  );
}
