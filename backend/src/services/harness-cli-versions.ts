import type { ConfigDocSource } from './sqlite/sqlite-config-docs.js';

/**
 * Pinned harness-CLI versions — the fleet-wide "latest".
 *
 * TWO readers, and they must agree: the pre-sleep updater (see
 * HarnessCliUpdater) converges running machines onto this, and the machine-image
 * build bakes it (`GET /api/harness-cli-versions` → `--build-arg`). Until the
 * build was taught to ask, it installed npm `latest` and the updater spent every
 * sleep cycle undoing that — for one CLI per machine, while the rest drifted.
 *
 * Single config doc, deliberately written ONLY by the local
 * `scripts/harness-cli-versions.mjs` script (manual trigger): bumping the
 * fleet is an explicit human act, never an automatic follow of npm `latest`.
 * The backend only reads. An absent doc or field means "no pin" and the
 * updater leaves that CLI alone.
 */
export const HARNESS_CLI_VERSIONS_COLLECTION = 'config';
export const HARNESS_CLI_VERSIONS_DOCUMENT = 'harnessCliVersions';

/** npm packages behind each harness CLI — shared by the updater and the script. */
export const HARNESS_CLI_NPM_PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  // OpenCode (note #780). Its postinstall picks the platform binary out of
  // optional dependencies; the command is `opencode`.
  opencode: 'opencode-ai',
} as const;

export type HarnessCliName = keyof typeof HARNESS_CLI_NPM_PACKAGES;

/** The command each harness CLI is run as — `opencode-ai` installs `opencode`. */
export const HARNESS_CLI_BINARIES: Readonly<Record<HarnessCliName, string>> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

export interface PinnedCliVersions {
  claude?: string;
  codex?: string;
  opencode?: string;
}

const CACHE_TTL_MS = 60_000;

/**
 * Exact-version strings only (`2.1.219`, optionally with a pre-release/build
 * suffix). Never a dist-tag: the pin is the control plane, and installing
 * `latest` would hand that control back to the npm registry.
 */
export function isValidCliVersion(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

export class HarnessCliVersionService {
  private cached: PinnedCliVersions | null = null;
  private cacheExpiresAt = 0;

  constructor(private readonly configDocs: ConfigDocSource | null) {}

  /** The pinned versions, cached briefly. Invalid/absent fields are dropped. */
  async getPinnedVersions(): Promise<PinnedCliVersions> {
    const now = Date.now();
    if (this.cached && now < this.cacheExpiresAt) {
      return this.cached;
    }
    if (!this.configDocs) {
      return this.setCache({});
    }
    try {
      const snapshot = await this.configDocs
        .collection(HARNESS_CLI_VERSIONS_COLLECTION)
        .doc(HARNESS_CLI_VERSIONS_DOCUMENT)
        .get();
      const data = snapshot.data();
      return this.setCache({
        ...(isValidCliVersion(data?.claude) ? { claude: data.claude } : {}),
        ...(isValidCliVersion(data?.codex) ? { codex: data.codex } : {}),
        ...(isValidCliVersion(data?.opencode) ? { opencode: data.opencode } : {}),
      });
    } catch (error) {
      console.warn('[harness-cli-versions] Failed to read pinned CLI versions:', error);
      return this.setCache({});
    }
  }

  /**
   * The pinned versions, read past the cache.
   *
   * For the machine-image build, which asks exactly once per build and bakes
   * the answer into the image every new machine boots from. A stale answer
   * there is not a stale read, it is the wrong CLI in the fleet's image: on
   * 2026-09-11 a pin bump dispatched its rebuild seconds after writing, the
   * build read this within the cache window, and it baked the version the bump
   * had just replaced — reporting success, because nothing downstream compares
   * what was baked against what was asked for. A once-per-build caller has
   * nothing to gain from a 60s cache and a whole image to lose, so it skips it.
   *
   * The cheap readers behind it (the pre-sleep updater, the agent screen) are
   * left with the fresh answer rather than a dropped cache they must refill.
   */
  async getPinnedVersionsUncached(): Promise<PinnedCliVersions> {
    this.clearCache();
    return this.getPinnedVersions();
  }

  clearCache(): void {
    this.cached = null;
    this.cacheExpiresAt = 0;
  }

  private setCache(versions: PinnedCliVersions): PinnedCliVersions {
    this.cached = versions;
    this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return versions;
  }
}
