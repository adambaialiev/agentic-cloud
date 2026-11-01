/**
 * What happened after approval: the merge, the checks on the target branch,
 * and whether the landing reached anywhere. Three stages, each one compact
 * line with its full action rows a tap underneath — so all three stay visible
 * together on a phone.
 *
 * Deliberately separate from the Actions row above it. Those judged the source
 * branch BEFORE approval; these answer what happened once the target branch
 * moved, and on a fast-forward both runs share a sha — which is exactly why
 * the source-branch rows give way to this card rather than sitting beside it.
 */

import { useState } from 'react';
import type { WorkspaceCheckRow } from '../../../../src/shared/workspace-api.js';
import { Icon, TypeIcon, type IconName } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { PressableRow } from '../home/PressableRow.js';
import { CheckPip, ChecksCard } from './Checks.js';
import { deliveryGroups, deliveryStage, type DeliveryStageKind, type DeliveryView } from './delivery.js';

function StageRow({ kind, glyph, title, actions, delivery }: {
  kind: DeliveryStageKind;
  glyph: IconName;
  title: string;
  actions: WorkspaceCheckRow[];
  delivery: DeliveryView;
}) {
  const verdict = deliveryStage(kind, actions, delivery);
  const hasDetails = actions.length > 0;
  // A failure or an action that never ran is why the reader came back to this
  // screen, so it opens itself; anything the reader has since done to the list
  // wins over that, and a five-second repaint never closes it under a finger.
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? (verdict.state === 'failure' || verdict.state === 'superseded');
  const row = (
    <>
      <TypeIcon glyph={glyph} />
      <div className="main">
        <div className="name plain">{title}</div>
        <div className="cline"><span className="ctext">{verdict.caption}</span></div>
      </div>
      <CheckPip state={verdict.state} />
      <span className={verdict.side === 'Live' ? 'cside live' : 'cside'}>{verdict.side}</span>
      {hasDetails ? <Icon name="chev" size={17} className="icon chev" /> : null}
    </>
  );
  if (!hasDetails) return <div className="crow delivery-step">{row}</div>;
  return (
    <>
      <PressableRow className="crow delivery-step open" onPress={() => setOpen(!shown)}>{row}</PressableRow>
      <ChecksCard checks={actions} className="prlist" hidden={!shown} />
    </>
  );
}

export function Delivery({ delivery, decidedAt }: { delivery: DeliveryView; decidedAt?: string | null }) {
  const groups = deliveryGroups(delivery);
  const sha = delivery.sha ? delivery.sha.slice(0, 7) : '';
  const when = delivery.merging ? 'now' : relative(delivery.mergedAt || decidedAt || '');
  return (
    <section className="prdelivery" id="prDelivery">
      <h2>After approval</h2>
      <div className="card">
        <div className="crow delivery-step">
          <TypeIcon glyph="git" tint={delivery.merging ? '' : 'dir'} />
          <div className="main">
            <div className="name plain">
              {delivery.merging ? 'Merging into ' : 'Merged into '}{delivery.branch}
            </div>
            <div className="cline">
              <span className="ctext">
                {delivery.merging
                  ? `Moving the approved change onto ${delivery.branch}.`
                  : (sha ? `Landing ${sha}` : `The approved change is on ${delivery.branch}.`)}
              </span>
            </div>
          </div>
          <CheckPip state={delivery.merging ? 'pending' : 'success'} />
          {when ? <span className="cside">{when}</span> : null}
        </div>
        <StageRow
          kind="checks"
          glyph="play"
          title={`Checks on ${delivery.branch}`}
          actions={groups.checks}
          delivery={delivery}
        />
        <StageRow kind="deploys" glyph="globe" title="Delivery" actions={groups.deploys} delivery={delivery} />
      </div>
    </section>
  );
}
