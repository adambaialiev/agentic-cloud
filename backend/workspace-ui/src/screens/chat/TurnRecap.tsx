/**
 * What is left of the recap under a conversation's latest completed turn.
 *
 * Note #945 put a recap line there ("recap line like in terminal claude
 * code") and note #976 made it a block: a RECAP chip, the turn's facts, the
 * recap a sentence a line behind a thin rule. Note #1193 took it out of every
 * chat. Adam, 18 Nov 2026, with a screenshot of one choice said three times
 * (the reply's words, its buttons, and the recap under them): "let's show
 * agent generated interactive html only", and, asked about the block: hide
 * it in chat. The recap itself is unchanged where it is news rather than a
 * repeat: Home, the roster and the briefing still read it.
 *
 * One thing stayed: the Chief of Staff's recap READ ALOUD (note #1146). The
 * speaker in its header reads the recap, not the reply, and its play button
 * was part of the block, so while the speaker is on, or when reading aloud
 * failed, a quiet line with that button stands where the block stood. No
 * recap words are drawn with it. An agent's chat never speaks and draws
 * nothing here.
 */

import { Svg } from '../../ui/icons.js';

export interface TurnRecapVoice {
  state: 'idle' | 'loading' | 'playing';
  onPlay: () => void;
  error?: string;
}

export function RecapAloud({ id, voice }: { id: string; voice: TurnRecapVoice }) {
  return (
    <div className="turnrecap" id={id}>
      <p className="turnfacts">
        <button
          className="recapplay"
          id={`${id}Play`}
          type="button"
          data-state={voice.state}
          aria-busy={voice.state === 'loading' || undefined}
          aria-label={voice.state === 'idle' ? 'Read the recap aloud' : 'Stop reading the recap'}
          title={voice.state === 'idle' ? 'Read aloud' : 'Stop'}
          onClick={voice.onPlay}
        >
          <Svg name={voice.state === 'idle' ? 'play' : 'stopcircle'} size={16} />
        </button>
        <span className="turnfactswords">{voice.state === 'idle' ? 'Hear the recap' : voice.state === 'loading' ? 'Getting the recap…' : 'Reading the recap'}</span>
      </p>
      {voice.error ? <p className="recapvoiceerror" id={`${id}VoiceError`} role="status">{voice.error}</p> : null}
    </div>
  );
}
