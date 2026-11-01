import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceRecapSettingsAnswer } from '../../../../src/shared/workspace-recap.js';
import { jsonBody } from '../../api/client.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';
import { RuntimeChoices } from '../../ui/RuntimeChoices.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { heldPrivateRuntime, holdPrivateRuntime } from '../agent/agent-cache.js';
import { knownPrivateRuntime } from '../agent/known-runtime.js';
import { recalledRuntime } from '../agent/runtime-memory.js';

/**
 * Which of the two private runtimes the picker sets (note #437): the
 * briefing's, opened from the recap card on Home, or the Workspace Agent's,
 * opened from its conversation header. Each reads and writes its own route,
 * so a pick for one never moves the other.
 */
export type RecapRuntimeTarget = 'recap' | 'agent';
const ROUTE: Record<RecapRuntimeTarget, string> = { recap: 'api/recap/settings', agent: 'api/recap/agent/settings' };
const WORDS: Record<RecapRuntimeTarget, { title: string; sub: string; hint: string }> = {
  // Nothing is rewritten on a pick (note #607): the choice waits for the
  // reader's next press of the recap's button.
  recap: { title: 'Recap model & effort', sub: 'Choose how your private recap is written.', hint: 'Choices are saved as you tap and used for your next recap.' },
  agent: { title: 'Chief of Staff model & effort', sub: 'Choose how your Chief of Staff answers and acts.', hint: 'Choices are saved as you tap and used from its next request.' },
};

export function RecapRuntimePicker({ orgId, seed, onClose, target = 'recap' }: {
  orgId: string; seed: WorkspaceRecapSettingsAnswer | null; onClose: () => void; target?: RecapRuntimeTarget;
}) {
  const { api } = useSession();
  const navigate = useNavigate();
  const { state } = useWorkspace();
  const route = ROUTE[target], words = WORDS[target];
  // The seed the opener already holds, else what this tab last read for this
  // runtime (note #630), else the catalog of every harness this workplace
  // reaches (note #718), marked with the pair this browser last saw it on
  // (note #735); the read below refreshes it silently.
  const [data, setData] = useState(() => seed ?? heldPrivateRuntime(orgId, target) ?? knownPrivateRuntime(orgId, state, recalledRuntime(orgId, target)));
  const [failure, setFailure] = useState('');
  const [refused, setRefused] = useState<{ kind: 'model' | 'effort'; text: string } | null>(null);
  const [writing, setWriting] = useState(false);
  const alive = useRef(true);
  const revision = useRef(0);
  useBackClaim(onClose);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const initialRevision = revision.current;
    void api.api<WorkspaceRecapSettingsAnswer>(route, undefined, { org: orgId })
      .then((next) => {
        if (revision.current !== initialRevision) return;
        holdPrivateRuntime(orgId, target, next);
        if (!cancelled) setData(next);
      })
      .catch((error) => { if (!cancelled && revision.current === initialRevision) setFailure(errorMessage(error)); });
    return () => { cancelled = true; alive.current = false; };
  }, [api, orgId, route, target]);
  const choose = async (kind: 'model' | 'effort', value: string) => {
    if (writing || !data) return;
    const model = data.models.find((m) => m.value === (kind === 'model' ? value : data.settings?.model));
    if (!model?.available) return;
    const effort = kind === 'effort' ? value : model.efforts.some((e) => e.value === data.settings?.effort)
      ? data.settings!.effort : model.efforts.find((e) => e.value === 'high')?.value ?? model.efforts[0]?.value;
    if (!effort) return;
    revision.current += 1; setWriting(true); setRefused(null);
    try {
      const next = await api.api<WorkspaceRecapSettingsAnswer>(route, jsonBody({ cli: model.cli, model: model.value, effort }), { org: orgId });
      holdPrivateRuntime(orgId, target, next);
      if (alive.current) setData(next);
    } catch (error) { if (alive.current) setRefused({ kind, text: errorMessage(error) }); }
    finally { if (alive.current) setWriting(false); }
  };
  const settings = data ? { model: data.settings?.model ?? '', effort: data.settings?.effort ?? '', models: data.models } : null;
  // Nothing connected yet: every model is listed and none is pickable. The
  // page still shows what there is and what is set (Opus · high), and says
  // what opens it (the owner, 2026-10-12, note #747).
  const locked = Boolean(data?.models.length) && data!.models.every((m) => !m.available);
  const lock = locked ? <>
    <div className="formhint" id="recapRuntimeLockWhy">Connect a Claude or ChatGPT subscription to change the model and effort.</div>
    <button className="btn primary" type="button" id="recapRuntimeConnect"
      onClick={() => navigate(toFor({ kind: 'seats', orgId })!)}>Connect a subscription</button>
  </> : undefined;
  return <RuntimeChoices screenId="screenRecapRuntime" prefix="recapRuntime" title={words.title}
    sub={words.sub}
    hint={words.hint}
    lock={lock}
    settings={settings} failure={failure} refused={refused} writing={writing} choose={(kind, value) => { void choose(kind, value); }} />;
}
