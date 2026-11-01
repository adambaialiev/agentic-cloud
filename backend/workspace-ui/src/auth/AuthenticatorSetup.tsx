/**
 * The manual-entry half of authenticator enrollment: what kind of code, and
 * the setup key with a copy button. A port of the legacy page's
 * `authenticatorSetupDetails`, same class vocabulary, same words.
 */

import { useState } from 'react';
import type { WorkspaceEnrollmentStartAnswer } from '../../../src/shared/workspace-api.js';

export function AuthenticatorSetup({ secret, otp }: Pick<WorkspaceEnrollmentStartAnswer, 'secret' | 'otp'>) {
  const [copyLabel, setCopyLabel] = useState('Copy key');
  const [copyError, setCopyError] = useState('');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopyLabel('Copied');
      setCopyError('');
    } catch {
      setCopyError('Could not copy the key. Select it above and copy it manually.');
    }
  };

  return (
    <div className="authsetupdetails">
      <div className="authmethod">
        <div className="authmethodlabel">Authenticator type</div>
        <div className="authmethodvalue">Time-based (TOTP)</div>
        <div className="authmethodmeta">{otp.digits} digits · {otp.periodSeconds}-second period</div>
      </div>
      <div className="authkeybox">
        <div className="authkeylabel">Setup key</div>
        <code className="authsecret" aria-label="Authenticator setup key">{secret}</code>
        <button
          type="button"
          className="btn ghost authsecretcopy"
          aria-label="Copy authenticator setup key"
          aria-live="polite"
          onClick={() => { void copy(); }}
        >
          {copyLabel}
        </button>
        {copyError ? <div className="autherror" role="alert">{copyError}</div> : null}
        <div className="authkeynote">Keep this key private — anyone with it can generate your sign-in codes.</div>
      </div>
    </div>
  );
}
