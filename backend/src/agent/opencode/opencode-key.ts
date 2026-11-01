/**
 * An OpenCode subscription is ONE API key from the OpenCode console (note
 * #780): the same key serves OpenCode Go (`opencode-go/…`) and Zen
 * (`opencode/…`), read by the CLI from OPENCODE_API_KEY. There is no OAuth,
 * no refresh and nothing to rotate — the seat stores the key, and a turn
 * hands it over in its environment.
 *
 * The live check is the Go model list with the key as a bearer: it answers
 * 200 for a key OpenCode knows and 401 `{"error":{"message":"Invalid
 * credential"}}` for one it does not (checked 2026-10-20), costs no usage,
 * and needs no model request — Go refuses those from anything but an
 * OpenCode client anyway (`MissingSessionID`).
 */

/** Where the member makes a key: the OpenCode console's sign-in. */
export const OPENCODE_KEYS_URL = 'https://opencode.ai/auth';

const OPENCODE_KEY_CHECK_URL = 'https://opencode.ai/inference/go/v1/models';
const CHECK_TIMEOUT_MS = 15_000;

export type OpenCodeKeyCheck =
  | { kind: 'ok' }
  /** OpenCode does not know this key. */
  | { kind: 'rejected'; status: number }
  /** OpenCode did not answer usefully; the key is neither good nor bad yet. */
  | { kind: 'unavailable'; reason: string };

/** A paste that cannot be a key: empty, multi-line, or the length of a document. */
export function plausibleOpenCodeKey(raw: string): string | null {
  const key = raw.trim();
  if (key.length < 8 || key.length > 500 || /\s/.test(key)) return null;
  return key;
}

export async function checkOpenCodeKey(key: string, fetchImpl: typeof fetch = fetch): Promise<OpenCodeKeyCheck> {
  try {
    const response = await fetchImpl(OPENCODE_KEY_CHECK_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (response.ok) return { kind: 'ok' };
    if (response.status === 401 || response.status === 403) return { kind: 'rejected', status: response.status };
    return { kind: 'unavailable', reason: `HTTP ${response.status}` };
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}
