/**
 * The reader's own picture at the end of Home's header row, and the menu it
 * drops (note #634).
 *
 * Home used to spend two shelves of the Workplace half on this: a deck of
 * people plates near the top and a Settings card at the very bottom. Both
 * are doors rather than news — the plates said little a glance needed, and
 * the card cost a scroll past every shared shelf — so both moved up here,
 * one tap away from anywhere on Home: who is in the workplace (the People
 * page, which holds everyone the deck only glimpsed) and the reader's own
 * settings (profile, picture, sign-in and sign out).
 *
 * The reader's name at the top opens their own builder page — their week,
 * all time and last 90 days (Adam, 28 Oct 2026, note #824: "in the header
 * dropdown I should be able to click on my name and my profile opens, my
 * builder page"). It replaced the Leaderboard row, which went with the
 * public board. Someone with no address yet has no page, so their name
 * stays words.
 *
 * A personal account has no workplace and so no People row, but it keeps
 * the picture and its Settings row: this is the one way into them from Home.
 * Nor is there a People row in a workplace of one that nobody can join
 * (`workplaceHasTeam`; notes #205, 2026-10-28): there is nobody to list.
 */

import { useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { Svg } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { workplaceHasTeam } from '../org/org-words.js';
import { HeaderMenu } from './HeaderMenu.js';

/** The picture, or the user glyph in the same round box when there is none
 *  or it fails to load — as `PersonFace` answers for everybody else. */
function OwnFace({ photoUrl }: { photoUrl?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (photoUrl && broken !== photoUrl) {
    return <img className="avatar accountface" src={photoUrl} alt="" onError={() => setBroken(photoUrl)} />;
  }
  return <span className="avatar accountface blank"><Svg name="user" size={18} /></span>;
}

function AccountMenu({ anchor, onClose }: {
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const user = state?.user ?? null;
  const org = state?.org ?? null;
  const login = user?.account.browserLogin;
  const identity = login?.enabled ? (login.method === 'email' ? login.email : `@${login.username}`) : '';
  const handle = user?.account.mailbox?.address.split('@')[0];
  const own = handle ? toFor({ kind: 'person', handle }) : null;
  const go = (to: string) => { onClose(); navigate(to); };
  const who = user
    ? (
      <span className="orgmenumain">
        <span className="orgmenuname"><span className="orgmenunametext" id="accountMenuName">{user.name}</span></span>
        {identity ? <span className="orgmenufacts orgmenunametext">{identity}</span> : null}
      </span>
    )
    : null;
  return (
    <HeaderMenu id="accountMenu" label="Your account" anchor={anchor} onClose={onClose}>
      {who && own
        ? (
          <div className="orgmenulist accountmenuself">
            <button
              className="orgmenurow" id="accountMenuSelf" type="button" role="menuitem"
              title="Your builder page" onClick={() => go(own)}
            >
              {who}
              <span className="orgmenutick"><Svg name="chev" size={16} /></span>
            </button>
          </div>
        )
        : who ? <div className="orgmenulist accountmenuwho">{who}</div> : null}
      <div className="orgmenulist orgmenuactions" role="group">
        {org && workplaceHasTeam(org, state?.invitesClosed)
          ? (
            <button
              className="orgmenurow" id="accountMenuPeople" type="button" role="menuitem"
              onClick={() => go(toFor({ kind: 'organizationPeople', orgId: org.orgId })!)}
            >
              <span className="orgmenumain">
                <span className="orgmenuname">People</span>
                <span className="orgmenufacts">{org.members} {org.members === 1 ? 'person' : 'people'} in {org.name}</span>
              </span>
              <span className="orgmenutick"><Svg name="user" size={16} /></span>
            </button>
          )
          : null}
        <button
          className="orgmenurow" id="accountMenuApps" type="button" role="menuitem"
          onClick={() => go(toFor({ kind: 'apps' })!)}
        >
          <span className="orgmenumain">
            <span className="orgmenuname">Apps</span>
            <span className="orgmenufacts">Every app launched here</span>
          </span>
          <span className="orgmenutick"><Svg name="globe" size={16} /></span>
        </button>
        <button
          className="orgmenurow" id="accountMenuSettings" type="button" role="menuitem"
          onClick={() => go(toFor({ kind: 'profile' })!)}
        >
          <span className="orgmenumain">
            <span className="orgmenuname">Settings</span>
            <span className="orgmenufacts">Profile, picture and sign-in</span>
          </span>
          <span className="orgmenutick"><Svg name="sliders" size={16} /></span>
        </button>
        {/* The platform operator's alone (note #758): the state read names
            the page only for them. */}
        {state?.radioLibrary
          ? (
            <button
              className="orgmenurow" id="accountMenuRadioLibrary" type="button" role="menuitem"
              onClick={() => go(toFor({ kind: 'radioLibrary' })!)}
            >
              <span className="orgmenumain">
                <span className="orgmenuname">Radio library</span>
                <span className="orgmenufacts">Every track on the radio</span>
              </span>
              <span className="orgmenutick"><Svg name="audio" size={16} /></span>
            </button>
          )
          : null}
        {/* The private copies (note #1058): the operator's alone, like the radio library. */}
        {state?.copies
          ? (
            <button
              className="orgmenurow" id="accountMenuCopies" type="button" role="menuitem"
              onClick={() => go(toFor({ kind: 'copies' })!)}
            >
              <span className="orgmenumain">
                <span className="orgmenuname">Copies</span>
                <span className="orgmenufacts">Every company's own Agentic Cloud</span>
              </span>
              <span className="orgmenutick"><Svg name="globe" size={16} /></span>
            </button>
          )
          : null}
        {/* Outreach (note #1089): the owner's own target companies and their letters. */}
        {state?.outreach
          ? (
            <button
              className="orgmenurow" id="accountMenuOutreach" type="button" role="menuitem"
              onClick={() => go(toFor({ kind: 'outreach' })!)}
            >
              <span className="orgmenumain">
                <span className="orgmenuname">Outreach</span>
                <span className="orgmenufacts">Target companies, every letter and reply</span>
              </span>
              <span className="orgmenutick"><Svg name="mail" size={16} /></span>
            </button>
          )
          : null}
      </div>
    </HeaderMenu>
  );
}

export function AccountButton() {
  const { state } = useWorkspace();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!state?.user) return null;
  return (
    <>
      <button
        className="accountbtn" id="homeAccount" type="button" ref={button}
        aria-haspopup="menu" aria-expanded={open} aria-label="Your account" title="Your account"
        onClick={() => setOpen((was) => !was)}
      >
        <OwnFace photoUrl={state.user.profile.photoUrl} />
      </button>
      {open ? <AccountMenu anchor={button} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
