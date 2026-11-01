import { useRef, useState } from 'react';
import { RADIO_STATION_NAME } from '../../../src/shared/radio.js';
import { HeaderMenu } from '../screens/home/HeaderMenu.js';
import { Svg } from '../ui/icons.js';
import { useRadio } from './radio-context.js';

/**
 * The work radio's control (note #712): a small play button at the far edge
 * of the header, on Home, on every screen under the shared header and in an
 * agent's chat. It is the same radio wherever it is pressed, and the sound
 * outlives the screen it was pressed on. It is not there at all until a
 * station has something on air.
 *
 * Off it says what it is, "Radio"; on, it names the track that is playing,
 * in the header's own ink — a state, not a badge (no pill, no fill).
 *
 * Once there is more than one station to hear (note #761), a narrow arrow
 * joins the same strip and drops the stations: each one's name and what it
 * is playing, the one tuned to ticked. Choosing a station plays it, inside
 * that tap. The play button stays one tap either way.
 */
export function RadioButton() {
  const radio = useRadio();
  const picker = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!radio?.available) return null;
  const { on, starting, title, station, stations, toggle } = radio;
  const label = on ? `Pause ${RADIO_STATION_NAME.toLowerCase()}` : `Play ${RADIO_STATION_NAME.toLowerCase()}`;
  const hint = on && title ? `${RADIO_STATION_NAME}: ${title} · ${station.name}` : `${RADIO_STATION_NAME} · ${station.name}`;
  const pick = stations.length > 1;
  return (
    <span className={`radiogroup${pick ? ' picks' : ''}`}>
      <button
        className="radiobtn" type="button" onClick={toggle}
        aria-label={label} aria-pressed={on} aria-busy={starting || undefined} title={hint}
        data-on={on || undefined}
      >
        <span className="radiobody">
          <Svg name={on ? 'pause' : 'play'} size={16} />
          <span className="radioword" aria-hidden="true">{on && title ? title : 'Radio'}</span>
        </span>
      </button>
      {pick
        ? (
          <button
            className="radiopick" type="button" ref={picker}
            aria-haspopup="menu" aria-expanded={open} aria-label={`Choose a station: ${station.name}`} title={`Station: ${station.name}`}
            onClick={() => { if (!open) radio.refresh(); setOpen((was) => !was); }}
          >
            <span className="radiopickbody"><Svg name="chevdown" size={14} /></span>
          </button>
        )
        : null}
      {open && pick
        ? (
          <HeaderMenu id="radioStations" label="Radio stations" anchor={picker} onClose={() => setOpen(false)}>
            <div className="orgmenulist" role="group" aria-label="Choose a station">
              {stations.map((one) => (
                <button
                  key={one.station.id} className={`orgmenurow${one.station.id === station.id ? ' current' : ''}`}
                  type="button" role="menuitemradio" aria-checked={one.station.id === station.id} data-station={one.station.id}
                  onClick={() => { setOpen(false); radio.choose(one.station.id); }}
                >
                  <span className="orgmenumain">
                    <span className="orgmenuname"><span className="orgmenunametext">{one.station.name}</span></span>
                    <span className="orgmenufacts">{one.title}</span>
                  </span>
                  {one.station.id === station.id ? <span className="orgmenutick"><Svg name="tick" size={18} /></span> : null}
                </button>
              ))}
            </div>
          </HeaderMenu>
        )
        : null}
    </span>
  );
}
