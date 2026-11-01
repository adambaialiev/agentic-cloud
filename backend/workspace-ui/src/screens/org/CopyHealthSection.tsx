/**
 * A private copy's health, on its workplace page, for admins only (note #813,
 * stage 3 piece 3 of note #811). One row per part of the copy, each line
 * written by the copy as it asked that part just now, flagged when it needs
 * a look. Below them, the diagnostics file: made on this screen, downloaded
 * to the admin's own computer, sent to support only if they choose to.
 */
import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceCopyHealth, WorkspaceCopyHealthPart } from '../../../../src/shared/workspace-api.js';
import { useBanner } from '../../chrome/useBanner.js';
import { errorMessage } from '../../ui/format.js';
import { TypeIcon, type IconName } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { useOrgApi } from './useOrgApi.js';
import { useNavigate } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

const GLYPHS: Record<WorkspaceCopyHealthPart['key'], IconName> = {
  workspace: 'gauge',
  licence: 'key',
  database: 'database',
  disk: 'drive',
  'code-host': 'git',
  previews: 'globe',
  'mail-in': 'mail',
};

export function CopyHealthSection() {
  const api = useOrgApi();
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const banner = useBanner();
  const [health, setHealth] = useState<WorkspaceCopyHealth | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [licenceText, setLicenceText] = useState('');

  const load = useCallback(async () => {
    try {
      setHealth(await api.api<WorkspaceCopyHealth>('api/copy/health'));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const download = async () => {
    setSaving(true);
    try {
      const bundle = await api.api<{ generatedAt: string }>('api/copy/diagnostics');
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `copy-diagnostics-${bundle.generatedAt.slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      banner.show(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveLicence = async () => {
    setSaving(true);
    try {
      const answer = await api.api<{ line: string }>('api/copy/licence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licence: licenceText.trim() }),
      });
      banner.show(answer.line, true);
      setPasting(false);
      setLicenceText('');
      await load();
    } catch (err) {
      banner.show(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const hasLicence = Boolean(health?.parts.some((part) => part.key === 'licence'));

  return (
    <section id="orgCopyHealth" aria-labelledby="orgCopyHealthTitle">
      <h2 id="orgCopyHealthTitle">This copy</h2>
      <div className="card" id="orgCopyHealthCard">
        {health
          ? health.parts.map((part) => (
            <div className="crow" key={part.key} data-part={part.key}>
              <TypeIcon glyph={GLYPHS[part.key]} />
              <div className="main">
                <div className="name plain">{part.name}</div>
                <div className="cline">
                  <span className="ctext">{part.line}</span>
                  {part.ok ? null : <span className="badge warn">Needs a look</span>}
                </div>
              </div>
            </div>
          ))
          : <div className="empty">{error || 'Checking every part…'}</div>}
        {/* The licence's renewal comes from us as one line; pasted here it
            takes effect at once, with no restart (note #814). */}
        {hasLicence && pasting
          ? (
            <div id="orgCopyLicencePaste">
              <label className="drow frow">
                <span className="k">Licence</span>
                <textarea
                  id="orgCopyLicenceText" rows={3} placeholder="acc1.…"
                  value={licenceText} onChange={(event) => setLicenceText(event.target.value)}
                />
              </label>
              <div className="actions">
                <button className="btn primary" id="orgCopyLicenceSave" type="button" disabled={saving || !licenceText.trim()} onClick={() => { void saveLicence(); }}>Save licence</button>
                <button className="btn ghost" type="button" disabled={saving} onClick={() => setPasting(false)}>Cancel</button>
              </div>
            </div>
          )
          : null}
        {hasLicence && !pasting
          ? <button className="addrow" id="orgCopyLicenceDoor" type="button" onClick={() => setPasting(true)}>Paste a licence</button>
          : null}
        {/* Email is set up after the install (note #946), from its own screen. */}
        <button className="addrow" id="orgCopyMailDoor" type="button" onClick={() => navigate(toFor({ kind: 'mailSetup' })!)}>
          {state?.mailSetup?.state === 'on' ? 'Email settings' : 'Set up email'}
        </button>
        <button className="addrow" id="orgCopyDiagnostics" type="button" disabled={saving} onClick={() => { void download(); }}>
          {saving ? <span className="spinner" /> : null}
          Download diagnostics
        </button>
      </div>
      <p className="formhint">
        {health ? `Checked ${relative(health.checkedAt)}. ` : ''}
        The diagnostics file stays on your computer until you send it to support. It holds no messages, code, files, mail, keys or names.
      </p>
    </section>
  );
}
