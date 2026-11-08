/**
 * The Fly apps that ARE the platform in its own organization (note #1070):
 * the backend itself, its code host, its CI and the image registry. They are
 * nobody's agent and nobody's site, so no record claims them, and the idle
 * reaper used to report them every night as "UNCLAIMED FLY APP RUNNING".
 *
 * Learned, not listed. The backend knows its own app from FLY_APP_NAME, which
 * Fly sets on every machine and nobody configures. That name is
 * `<family>-<role>` — `ia-control` in production, `<prefix>-backend` in a
 * private copy (infra/copy-installer/install.mjs) — and every sibling the
 * platform runs is the same family with another fixed role: `ia-git`,
 * `ia-ci`, `ia-ci-builder`; `<prefix>-git`, `<prefix>-router`, `<prefix>-mx`.
 * So one rule covers production and every copy without a per-install list to
 * keep in step, and a renamed or added sibling needs a role here, not a
 * setting on a live machine. FLY_PLATFORM_APPS (comma-separated) adds any
 * app the rule cannot name.
 *
 * Why a role can never catch an agent: agent apps are `ia-` plus 16 hex
 * characters, and every role below contains a letter that is not hex.
 */

/** Roles a control-plane app plays beside the backend, by installation. */
export const CONTROL_PLANE_ROLES = [
  // Production since the Hetzner retirement (notes #1032, #1062).
  'control', 'git', 'ci', 'ci-builder', 'ci-jobs', 'machine-images',
  // A private copy (infra/copy-installer/install.mjs, copy-upgrader.ts).
  'backend', 'images', 'router', 'mx', 'media', 'backups', 'upgrader',
] as const;

/** The roles the backend's own app carries: `ia-control`, `<prefix>-backend`. */
const BACKEND_ROLES = ['control', 'backend'] as const;

/** `ia-control` → `ia`, `acme-backend` → `acme`; any other name → undefined. */
export function controlPlaneFamily(ownAppName: string | undefined): string | undefined {
  const name = ownAppName?.trim();
  if (!name) return undefined;
  for (const role of BACKEND_ROLES) {
    const suffix = `-${role}`;
    if (name.endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length);
  }
  return undefined;
}

export interface PlatformAppSources {
  /** FLY_APP_NAME: the app this backend runs in. Unset off Fly (dev, tests). */
  ownAppName?: string;
  /** FLY_IMAGE_APP: the machine-image registry app. */
  imageApp?: string;
  /** FLY_PLATFORM_APPS: anything the family rule cannot name. */
  extra?: Iterable<string>;
}

/** Every app name that is the platform itself, in the backend's own org. */
export function platformAppNames(sources: PlatformAppSources): Set<string> {
  const names = new Set<string>();
  const add = (name: string | undefined) => {
    const trimmed = name?.trim();
    if (trimmed) names.add(trimmed);
  };
  add(sources.ownAppName);
  add(sources.imageApp);
  for (const name of sources.extra ?? []) add(name);
  const family = controlPlaneFamily(sources.ownAppName);
  if (family) for (const role of CONTROL_PLANE_ROLES) add(`${family}-${role}`);
  return names;
}
