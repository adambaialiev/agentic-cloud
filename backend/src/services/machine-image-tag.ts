import { isValidCliVersion, type PinnedCliVersions } from './harness-cli-versions.js';

/**
 * The agent machine image's tag names its contents (note #1052).
 *
 *   sha-<12 hex of the commit>-c<claude>-x<codex>-o<opencode>
 *   sha-0477944f1b34-c2.1.316-x0.166.0-o1.19.5
 *
 * The image is built from two inputs: the commit (infra/fly-machine-image) and
 * the fleet pin (config/harnessCliVersions), which lives outside the repo. The
 * tag used to carry only the first, so a pin bump rebuilt at an unchanged
 * commit pushed DIFFERENT bytes under the SAME tag — and `MachineImageUpdater`,
 * which compares `config.image` strings, read every machine already on the old
 * bytes as current, forever (trap 2 on the updating-the-fleet-cli page; hit on
 * 2026-09-11 and 2026-09-23, repaired by hand each time with a `-r2` retag).
 *
 * With both inputs in the tag, a bump is a new tag and the roller's string
 * comparison is the right comparison. CI also refuses to push over a tag that
 * is already published (run-job.sh), so one tag is one set of bytes.
 *
 * `+` (semver build metadata) is not legal in an OCI tag; it is written `_`,
 * which semver never uses, so the mapping reverses exactly.
 *
 * MIRRORED in bash by `machine_image_label` in infra/ci-runner/run-job.sh — the
 * CI box does not run repo code. machine-image-tag.test.ts runs both and
 * requires the same answer.
 */
export interface MachineImageTagParts {
  /** The first 12 hex digits of the commit the image was built from. */
  commit: string;
  pins: Required<PinnedCliVersions>;
}

const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const VERSION = String.raw`\d+\.\d+\.\d+(?:[-_][0-9A-Za-z.-]+?)?`;
const LABEL_PATTERN = new RegExp(`^sha-([0-9a-f]{12})-c(${VERSION})-x(${VERSION})-o(${VERSION})$`);

/** The tag CI gives an image built from `commit` with these pins, or undefined if it cannot be one. */
export function machineImageTag(commit: string, pins: PinnedCliVersions): string | undefined {
  const short = commit.trim().slice(0, 12);
  if (!/^[0-9a-f]{12}$/.test(short)) return undefined;
  const { claude, codex, opencode } = pins;
  if (!isValidCliVersion(claude) || !isValidCliVersion(codex) || !isValidCliVersion(opencode)) {
    return undefined;
  }
  const tag = `sha-${short}-c${claude}-x${codex}-o${opencode}`.replaceAll('+', '_');
  return TAG_PATTERN.test(tag) ? tag : undefined;
}

/**
 * What an agent image ref says it carries. Undefined for any tag that does not
 * name its pins — the `sha-<12>` images built before note #1052, their `-r2`
 * retags, host images — so a caller can never mistake "unknown" for a match.
 *
 * Accepts a bare tag or a whole ref (`ghcr.io/<owner>/ia-machine-images:<tag>`).
 * Only answers when re-forming the parts gives back the very same tag, so a
 * version that happens to contain `-x` or `-o` cannot be split the wrong way
 * and read as a different pin. A hand retag of a pinned tag (`…-o1.19.5-r2`)
 * reads as an OpenCode pre-release, `1.19.5-r2`: that matches no real pin, so
 * it reads as behind, never as current — the safe way to be wrong.
 */
export function parseMachineImageTag(refOrTag: string | undefined): MachineImageTagParts | undefined {
  const trimmed = refOrTag?.trim();
  if (!trimmed) return undefined;
  const lastColon = trimmed.lastIndexOf(':');
  const tag = lastColon > trimmed.lastIndexOf('/') ? trimmed.slice(lastColon + 1) : trimmed;
  const match = LABEL_PATTERN.exec(tag);
  if (!match) return undefined;
  const [, commit, claude, codex, opencode] = match;
  const pins = {
    claude: claude.replaceAll('_', '+'),
    codex: codex.replaceAll('_', '+'),
    opencode: opencode.replaceAll('_', '+'),
  };
  return machineImageTag(commit, pins) === tag ? { commit, pins } : undefined;
}

/**
 * Whether an image ref bakes exactly these pins. False when the tag names no
 * pins at all: an image whose contents the tag does not state is never
 * reported as up to date with the pin.
 */
export function machineImageMatchesPins(refOrTag: string | undefined, pins: PinnedCliVersions): boolean {
  const parts = parseMachineImageTag(refOrTag);
  if (!parts) return false;
  return parts.pins.claude === pins.claude
    && parts.pins.codex === pins.codex
    && parts.pins.opencode === pins.opencode;
}
