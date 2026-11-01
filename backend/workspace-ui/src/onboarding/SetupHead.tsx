/**
 * The head of every setup screen (2026-09-18, the owner): the brand mark on
 * the left and nothing actionable beside it. Form actions live after their
 * fields, where a mobile browser cannot translate the fixed head away while
 * its keyboard is open. No step counter: the road is short, and a "Step 2
 * of 3" over each screen was the one line on it nobody needed.
 *
 * On the account doors (sign in, sign up, password and email screens) the
 * mark leads home to the landing page (the owner, 2026-09-29): a full load
 * of `/`, which the edge answers with the site, not the Workspace shell.
 */

import brandLogo from '../../../../public/logo-bw.png';

export function SetupHead({ home = false }: { home?: boolean }) {
  const mark = <img className="webbrandmark" src={brandLogo} alt="Agentic Cloud Computer" />;
  return (
    <header className="setuphead">
      {home ? <a className="setuphome" id="authHome" href="/" aria-label="Agentic Cloud Computer home">{mark}</a> : mark}
    </header>
  );
}
