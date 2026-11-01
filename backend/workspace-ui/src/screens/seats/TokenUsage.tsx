/**
 * The tokens the reader's own agents spent, week by week (GET api/org/tokens)
 * — under their subscriptions, because those are what the tokens are spent
 * on, and private like them. Claude Code, Codex and OpenCode count tokens differently,
 * so each week shows them side by side and never adds them up.
 */
import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceTokenUsageAnswer } from '../../../../src/shared/workspace-api.js';
import { useSession } from '../../session/useSession.js';
import { useFocusRefresh } from '../../ui/useFocusRefresh.js';
import { tokenProviderLine, tokenWeekLabel } from './token-usage-words.js';

export function TokenUsage() {
  const { api } = useSession();
  // The weeks are named against the moment they were read ("This week").
  const [usage, setUsage] = useState<{ answer: WorkspaceTokenUsageAnswer; readAt: number } | null>(null);
  const load = useCallback(async () => {
    try {
      const answer = await api.api<WorkspaceTokenUsageAnswer>('api/org/tokens');
      setUsage({ answer, readAt: Date.now() });
    }
    catch { /* a secondary read: the section keeps what it had, or stays away */ }
  }, [api]);
  useEffect(() => {
    let cancelled = false;
    api.api<WorkspaceTokenUsageAnswer>('api/org/tokens').then(
      (answer) => { if (!cancelled) setUsage({ answer, readAt: Date.now() }); },
      () => { /* as in load */ },
    );
    return () => { cancelled = true; };
  }, [api]);
  useFocusRefresh(load);

  if (!usage) return null;
  const { answer, readAt } = usage;
  // An answer without weeks is a backend from before the ledger: nothing yet.
  const weeks = answer.weeks ?? [];
  return (
    <div id="seatsTokens">
      <h2>Tokens your agents used</h2>
      <div className="card" id="seatsTokensList">
        {weeks.length
          ? weeks.map((week) => (
            <div className="crow" key={week.start}>
              <div className="main">
                <div className="name plain">{tokenWeekLabel(week.start, readAt)}</div>
                {week.providers.map((row) => (
                  <div className="cline wrap" key={row.provider}><span className="ctext">{tokenProviderLine(row)}</span></div>
                ))}
              </div>
            </div>
          ))
          : <div className="empty">Nothing counted yet. Your agents’ next turns will show here.</div>}
      </div>
      <div className="formhint">Every agent of yours, in every workplace. Output includes thinking; input leaves out the cache, which is counted on its own. Claude Code, Codex and OpenCode count tokens differently, so they are never added together. Only you see this.</div>
    </div>
  );
}
