/**
 * The public site fronts the stateful Workspace at one same-origin path. The
 * browser sees only agenticcloudcomputer.com; Pages forwards /workspace to the
 * control-plane backend without exposing its api hostname.
 */
export const WORKSPACE_SIGN_IN_URL = '/login';
export const WORKSPACE_SIGN_UP_URL = '/signup';
/** The public site's one door since note #822 (the owner, 2026-10-28: "we
 *  should not host yet ... Only on-premise"): the page for your own Agentic
 *  Cloud. Sign-up on our hosted platform is closed (note #823), so no public
 *  page sends a stranger to /signup; Sign in stays for existing accounts.
 *  At /own-cloud since note #829 (the owner, 28 Oct 2026, 15:01 UTC: rename
 *  the address); /private-copy redirects there for good (public/_redirects).
 *  Since note #832 (29 Oct 2026) the offer is the home page itself, so every
 *  door goes to its one action, the line for an agent; /own-cloud redirects
 *  to / for good. */
export const PRIVATE_COPY_URL = '/#give-your-agent';
/** The offer's public name since 2026-10-28, 11:09 UTC (the owner): "your
 *  own Agentic Cloud", and the action "Build your own Agentic Cloud". Until
 *  then "private copy" and "Get your own copy". The address followed on
 *  28 Oct (note #829): /own-cloud. */
export const PRIVATE_COPY_DOOR = 'Build your own Agentic Cloud';
