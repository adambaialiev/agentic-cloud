import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import { LiveSites } from '../../components/LiveSurfaces';

/**
 * Sites and domains: how to get a site live, from the preview link to the
 * production address; the three shapes, your own domain, renames and
 * upgrades, deletion and where sites appear. Facts checked 2026-09-24
 * against the site screen, Home's Sites section and the deploy commands.
 * Written to src/docs/STYLE.md. Since note #664 (2026-09-25) sites run on
 * our cloud, ten live at a time per workplace.
 */
const chapter: DocChapter = {
  slug: 'sites-and-domains',
  title: 'Sites and domains',
  description:
    'How to ask an agent for a site: the preview link, the production address, the three shapes, your own domain, renames and upgrades, and what only you can decide.',
  lead: (
    <>
      When an agent builds something, you get to see it two ways. First a preview link, on the
      agent&rsquo;s own computer, for work in progress. Then, when you want it always on at a real
      address, a production site on the cloud, up whether the agent is awake or not.
      Hosting is included, the site belongs to the workplace, and deleting it is yours to decide.
    </>
  ),
  sections: [
    {
      id: 'how-to-get-a-site-live',
      heading: 'How to get a site live',
      body: (
        <>
          <p>
            Ask the agent for the thing itself: &ldquo;make a page for the open roles&rdquo;,
            &ldquo;put the docs online&rdquo;. The reply comes with a preview link to the page on
            the agent&rsquo;s own computer, so you can look before anything is published.
          </p>
          <p>
            The preview rides that computer, which sleeps after about three quiet minutes. A link
            you forward still works, but the first load after a quiet spell takes about ten seconds
            while the machine wakes. After that it is fast, and the agent says so when it hands
            the link over.
          </p>
          <p>
            When the page is right, say &ldquo;put it live&rdquo;. The agent deploys it and comes
            back with a production address, <code>name.agentbuilt.app</code>, where it stays up on
            its own. The first deploy takes a couple of minutes while the machine is built and the
            address and its certificate come up, and the agent reports the address once it
            answers. After that, a redeploy to the same name is instant.
          </p>
        </>
      ),
    },
    {
      id: 'production-sites',
      heading: 'Production sites',
      body: (
        <>
          <p>
            A site is a folder the agent deploys under a name you choose together. There are three
            shapes, and the agent picks one from what the folder is:
          </p>
          <ul>
            <li>
              <strong>A website</strong>: files served as they are, such as pages, images or a
              built front-end.
            </li>
            <li>
              <strong>An always-on app</strong>: a program that runs around the clock, on a machine
              with 512 MB of memory.
            </li>
            <li>
              <strong>An always-on app on a bigger machine</strong>, with 1 GB of memory, for an
              app that needs more.
            </li>
          </ul>
          <p>
            Hosting is included. There is no price per site, no tiers and no checkout. Sites run on
            the cloud beside your agents&rsquo; machines, up to ten live at a time in a workplace (see{' '}
            <DocLink href="/docs/your-cloud-and-subscriptions#what-runs-there">What runs where</DocLink>).
            An always-on app can use the workplace&rsquo;s saved keys, such as a chat bot&rsquo;s
            token. The agent names the key when it deploys, and the key never goes into the
            app&rsquo;s files (see{' '}
            <DocLink href="/docs/secrets#checks-and-sites">Keys for checks and for sites</DocLink>).
          </p>
          <p>
            A site belongs to the workplace. Any agent can list every site, read
            its logs, restart it, rename it, add a domain and redeploy it. Creating a new site,
            upgrading one and asking to delete one are for an admin&rsquo;s agent (see{' '}
            <DocLink href="/docs/workplace-and-people#roles">Roles</DocLink>).
          </p>
        </>
      ),
      panel: (
        <Panel says="The Sites section in Workplace: the dispatch app and the routing service, both running around the clock, and the docs website, each live at its own address and each last published by an agent.">
          <LiveSites />
        </Panel>
      ),
    },
    {
      id: 'the-app-catalogue',
      heading: 'The app catalogue',
      body: (
        <>
          <p>
            Every site put live here is listed in the public app catalogue at{' '}
            <a href="https://agenticcloudcomputer.com/apps">agenticcloudcomputer.com/apps</a>: its name, one line on what it
            does, who built it, a picture and the link, newest first. You do nothing for this.
            The agent writes the line when it deploys and takes the picture once the site
            answers, and a redeploy refreshes the picture so the catalogue shows the site as it
            is now.
          </p>
          <p>
            If you would rather an app were not in the catalogue, tell your agent: it takes the
            site out at once, and puts it back when you say so. A site that is paused or deleted
            leaves the catalogue by itself. Only you, by name, and the app are shown there; never
            your agents or workplace.
          </p>
        </>
      ),
    },
    {
      id: 'redeploys',
      heading: 'Redeploys',
      body: (
        <>
          <p>
            A redeploy to a live name is instant, with no approval step and no undo, and the
            public sees the new version at once. A proposal guards code that lands in a
            repository; a site is the agent publishing what you asked for. If you want a look
            first, ask for a preview.
          </p>
          <p>
            One fence stands between agents. A live site is replaced only by the agent that last
            deployed it, unless you ask a different agent to take it over. The site&rsquo;s screen
            shows who deployed it first and who deployed it last.
          </p>
        </>
      ),
    },
    {
      id: 'custom-domains',
      heading: 'How to use your own domain',
      body: (
        <>
          <p>
            A live site can answer on a domain you own, such as <code>app.example.com</code>. Ask
            an agent to add it. It requests a certificate and hands you <strong>one DNS record</strong>{' '}
            to create: a CNAME from your hostname to the site. That step is yours, at whichever
            provider holds your domain.
          </p>
          <p>
            A bare domain, <code>example.com</code> with nothing in front of it, cannot carry an
            ordinary CNAME. Use your provider&rsquo;s ALIAS record or CNAME flattening for that
            case. A subdomain like <code>www</code> or <code>app</code> takes a plain CNAME.
          </p>
          <p>
            Once the record is visible, the certificate is issued within minutes, and the agent
            can confirm the domain reads <Ui>READY</Ui>. The <code>agentbuilt.app</code> address
            keeps working beside your domain. The Workspace has no domains screen, so to see which
            domains a site answers on, ask an agent. An admin&rsquo;s agent can take a domain off
            again.
          </p>
        </>
      ),
    },
    {
      id: 'rename-and-upgrade',
      heading: 'Rename, upgrade, logs and restart',
      body: (
        <>
          <p>
            Ask an agent to rename a site and it moves to the new address at once, with nothing
            going down. The old address redirects to the new one for good and stays reserved to
            you, so every link you already shared still arrives.
          </p>
          <p>
            An always-on app that needs more memory can be upgraded: an agent moves it to the 1 GB
            machine, and it restarts for a few seconds. There is no downgrade, nothing above 1 GB,
            and no bigger machine for a website.
          </p>
          <p>
            Logs and a restart are things you ask an agent for. &ldquo;Show me the last errors on
            the dispatch app&rdquo; or &ldquo;restart the routing service&rdquo; is a message to
            any agent in the workplace.
          </p>
        </>
      ),
    },
    {
      id: 'deleting-a-site',
      heading: 'Deleting a site',
      body: (
        <>
          <p>
            An agent cannot delete a site. An admin&rsquo;s agent can ask, and the request waits
            for you on the site&rsquo;s own screen. The agent tells you in its reply, because
            nothing else does. The screen says who asked and when, and offers{' '}
            <Ui>Delete this site</Ui>, which asks you to type the site&rsquo;s name, and{' '}
            <Ui>Keep it</Ui>. Only the owner of the agent that asked can decide. An admin also has{' '}
            <Ui>Delete this site</Ui> on every site&rsquo;s screen, request or not.
          </p>
          <p>
            A deleted site stops serving at once. There is no trash and no restore, but the content
            is one redeploy away, and the name stays reserved to the workplace so an agent can
            deploy to it again. The chat where the agent asked gets a card with the outcome,{' '}
            <Ui>Kept</Ui> or <Ui>Deleted</Ui>.
          </p>
        </>
      ),
    },
    {
      id: 'the-site-screen',
      heading: 'Where sites appear',
      body: (
        <>
          <p>
            <Ui>Workplace</Ui> shows a <Ui>Sites</Ui> section once the workplace has its first site. Each row is
            one site: its name, the agent that deployed it, when it was last updated, whether it is
            a <Ui>site</Ui> or an <Ui>app</Ui>, and a state badge when it is not simply live.
          </p>
          <p>
            Tap a row for the site&rsquo;s screen: the live address, which opens the site, who
            deployed it first and last, and a delete request when there is one. A teammate&rsquo;s
            agent appears as that, with its face.
          </p>
        </>
      ),
    },
  ],
  reference: [
    {
      term: 'Preview address',
      text: 'One per agent, on the agent’s own machine, stable for the life of the agent. The first load after a quiet spell takes about ten seconds.',
    },
    {
      term: 'Site address',
      text: <>Always <code>name.agentbuilt.app</code>. A custom domain is added beside it, never instead of it.</>,
    },
    {
      term: 'Site name',
      text: 'Three to forty-two characters: lowercase letters, digits and hyphens, not starting or ending with a hyphen. A few names are reserved, such as login, admin, support, billing, api, www and agentbuilt.',
    },
    {
      term: 'Shapes',
      text: 'A website, an always-on app (512 MB), or an always-on app on the bigger machine (1 GB). An app needs a start script that listens on the port the platform expects; the agent knows.',
    },
    { term: 'How many', text: 'Up to ten a workplace, counted while live or being set up. Take one down to put up another.' },
    { term: 'Upload size', text: 'Up to 64 MB of packed site content per deploy.' },
    {
      term: 'States',
      text: <><Ui>setting up</Ui> (being built, live in a minute or two), <Ui>not built yet</Ui> (name reserved, finished on the next deploy), <Ui>paused</Ui> (files kept), <Ui>stopped</Ui> (by support). A live site shows no badge.</>,
    },
    {
      term: 'Who can do what',
      text: 'Any agent in the workplace: list, status, logs, restart, rename, add a domain, redeploy. An admin’s agent: create, revive, upgrade, remove a domain, ask to delete. Only a person deletes.',
    },
  ],
};

export default chapter;
