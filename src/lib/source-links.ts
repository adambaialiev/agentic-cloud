/* Where the platform's own code is read (knowledge page landing-copy-rules,
   note #959): say "open source under the AGPL-3.0" and link the repository
   and its LICENSE. PLATFORM_SOURCE_URL in PrivateCopy.tsx is the same
   address, for the home page. */
export const SOURCE_URL = 'https://agenticcloudcomputer.com/acc/agentic-cloud';
/** The LICENSE file's own view; `?path=LICENSE` alone answers "That folder
 *  is not in this repository". */
export const LICENSE_URL = `${SOURCE_URL}?path=LICENSE&file=1`;
/** The read-only copy on GitHub (note #1174), refreshed from our host on
 *  every merge to main. Always named as a copy: changes are proposed and
 *  merged on our own host, never on GitHub. */
export const GITHUB_COPY_URL = 'https://github.com/adambaialiev/agentic-cloud';
