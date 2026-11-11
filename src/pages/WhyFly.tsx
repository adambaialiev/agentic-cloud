import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import { BODY, CARD, ChapterDivider, H2, H3, LEAD, PrimaryLink, SECTION, SecondaryLink } from '../components/landing-kit';
import { FOOTER_PITCH } from '../lib/product-copy';
import { PRIVATE_COPY_DOOR, PRIVATE_COPY_URL } from '../lib/workspace-link';
import { FOUNDER_EMAIL, INSTALLER_SOURCE_URL } from './PrivateCopy';
import { AgentDayArt } from '../components/CopyArt';

/**
 * Why your own Agentic Cloud runs on Fly, not AWS, Google Cloud or Vercel
 * (note #838, the owner, 30 Oct 2026, 06:11 UTC: "We need a separate page
 * that explains why we choose Fly cloud, not AWS or Google cloud."; Vercel at
 * his word at 06:31 UTC). Linked from the home page's own-cloud chapter and
 * the footer.
 *
 * Read through the buyer's eyes (the owner, 07:06 UTC: "Look at this page
 * through customers' eyes"): an engineering lead whose company is on AWS,
 * deciding whether to install. So it opens on what they get, says the cloud
 * comparison in plain words, and answers the questions their team will ask.
 * It names no wake time and no incidents of Fly's, and it never says the
 * platform must stay on Fly.
 *
 * Every sentence about AWS, Google Cloud or Vercel carries a source from that
 * vendor's own pages, read on 30 Oct 2026 (SOURCES). Re-read them before
 * changing a claim: AWS moved twice this year (nested virtualization on EC2
 * in February, Lambda MicroVMs in June), and an outdated comparison is the
 * one thing an engineer reading this will check. Vercel's Sandbox IS a
 * lightweight virtual machine with full admin rights and files that persist,
 * so never call it containers or functions only. What we say about the
 * backups is what infra/copy-installer/install.mjs sets up.
 *
 * The look (Anthropic's frontend-design and Impeccable, at the owner's ask,
 * 08:37 UTC), inside the site's own type and colours: one drawing as the
 * page's one bold moment (an agent's computer through a day, AgentDayArt),
 * the comparison as the table it is (rows of needs, a column per cloud, Fly's
 * in ink and the rest in hint) instead of a grid of identical cards, and the
 * questions as a two-column ledger. No eyebrows, no numbered markers.
 */

/* The pages behind the claims, read on 30 Oct 2026. Numbered in the order the
   page first cites them (a test holds it). */
export const SOURCES = [
  { id: 'fly-autostop', label: 'Fly.io, Autostop/autostart Machines', url: 'https://docs.fly.io/launch/autostop-autostart' },
  { id: 'vercel-byoc', label: 'Vercel, Bring Your Own Cloud', url: 'https://vercel.com/docs/networking/bring-your-own-cloud' },
  { id: 'fly-arch', label: 'Fly.io, Architecture', url: 'https://docs.fly.io/reference/architecture' },
  { id: 'aws-fargate', label: 'AWS, What is AWS Fargate?', url: 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html' },
  { id: 'aws-lambda-limits', label: 'AWS, Lambda quotas', url: 'https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html' },
  { id: 'gcp-run-scaling', label: 'Google Cloud, About instance autoscaling in Cloud Run', url: 'https://docs.cloud.google.com/run/docs/about-instance-autoscaling' },
  { id: 'vercel-sandbox', label: 'Vercel, Sandbox concepts', url: 'https://vercel.com/docs/sandbox/concepts' },
  { id: 'vercel-sandbox-pricing', label: 'Vercel, Sandbox pricing and limits', url: 'https://vercel.com/docs/sandbox/pricing' },
  { id: 'aws-ec2-start', label: 'AWS, Stop and start Amazon EC2 instances', url: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Stop_Start.html' },
  { id: 'aws-microvms', label: 'AWS, Launching Lambda MicroVMs', url: 'https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html' },
  { id: 'gcp-stop', label: 'Google Cloud, Stop or restart a Compute Engine instance', url: 'https://docs.cloud.google.com/compute/docs/instances/stop-start-instance' },
  { id: 'gcp-run-timeout', label: 'Google Cloud, Cloud Run request timeout', url: 'https://docs.cloud.google.com/run/docs/configuring/request-timeout' },
  { id: 'vercel-persistent', label: 'Vercel, Persistent sandboxes', url: 'https://vercel.com/docs/sandbox/concepts/persistent-sandboxes' },
  { id: 'fly-config', label: 'Fly.io, App configuration: [mounts]', url: 'https://docs.fly.io/reference/configuration' },
  { id: 'aws-ec2-stop', label: 'AWS, How Amazon EC2 instance stop and start works', url: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/how-ec2-instance-stop-start-works.html' },
  { id: 'aws-ebs-tasks', label: 'AWS, Amazon EBS volumes with Amazon ECS', url: 'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html' },
  { id: 'vercel-drives', label: 'Vercel, Sandbox Drives', url: 'https://vercel.com/docs/sandbox/concepts/drives' },
  { id: 'fly-6pn', label: 'Fly.io, Private networking', url: 'https://docs.fly.io/networking/private-networking' },
  { id: 'fly-certs', label: 'Fly.io, Custom domains', url: 'https://docs.fly.io/networking/custom-domain' },
  { id: 'aws-nested', label: 'AWS, Nested virtualization on Amazon EC2', url: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html' },
  { id: 'gcp-nested', label: 'Google Cloud, About nested virtualization', url: 'https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview' },
  { id: 'vercel-secure-compute', label: 'Vercel, Secure Compute', url: 'https://vercel.com/docs/connectivity/secure-compute' },
  { id: 'fly-pricing', label: 'Fly.io, Pricing (compliance)', url: 'https://fly.io/pricing' },
  ...(INSTALLER_SOURCE_URL ? [{ id: 'installer', label: 'The installer’s code (open source)', url: INSTALLER_SOURCE_URL }] : []),
] as const;

type SourceId = (typeof SOURCES)[number]['id'];
export const SOURCES_READ_ON = '30 October 2026';

/* A citation: the sources' numbers, each a link to the list at the foot. */
function Cite({ ids }: { ids: SourceId[] }) {
  const numbers = ids
    .map((id) => SOURCES.findIndex((source) => source.id === id) + 1)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (!numbers.length) return null;
  return (
    <sup className="ml-0.5 whitespace-nowrap type-xs">
      {numbers.map((n, at) => (
        <span key={n}>
          {at ? ',' : null}
          <a href={`#source-${n}`} className="text-hint no-underline hover:text-white" aria-label={`Source ${n}`}>{n}</a>
        </span>
      ))}
    </sup>
  );
}

type Cell = { text: string; cite: SourceId[] };

/* What an agent needs, and what each cloud offers for it, in plain words.
   Each sentence from the vendor's own page. */
const ROWS: { need: string; fly: Cell; aws: Cell; gcp: Cell; vercel: Cell }[] = [
  {
    need: 'A whole computer of its own for every agent.',
    fly: { text: 'Every agent gets its own lightweight virtual machine, with its own cores.', cite: ['fly-arch'] },
    aws: { text: 'An EC2 server is a whole computer. Fargate runs containers, and Lambda runs short functions of up to 15 minutes.', cite: ['aws-fargate', 'aws-lambda-limits'] },
    gcp: { text: 'A Compute Engine server is a whole computer. Cloud Run runs containers.', cite: ['gcp-run-scaling'] },
    vercel: { text: 'Every Sandbox is a lightweight virtual machine with full admin rights, for up to 24 hours a session on Pro.', cite: ['vercel-sandbox', 'vercel-sandbox-pricing'] },
  },
  {
    need: 'Asleep when nobody needs it. Awake when a link is opened or a message arrives.',
    fly: { text: 'A sleeping computer starts by itself when a link is opened or a message arrives.', cite: ['fly-autostop'] },
    aws: { text: 'You start a stopped EC2 server yourself or on a schedule, and it can take a few minutes. Lambda MicroVMs wake on traffic, but each lives at most 8 hours and accepts only authenticated requests.', cite: ['aws-ec2-start', 'aws-microvms'] },
    gcp: { text: 'You start a stopped server yourself. Cloud Run wakes on a request, but a request can last at most 60 minutes.', cite: ['gcp-stop', 'gcp-run-scaling', 'gcp-run-timeout'] },
    vercel: { text: 'A stopped Sandbox starts again when your own code calls Vercel.', cite: ['vercel-persistent'] },
  },
  {
    need: 'A disk that keeps the work through every sleep.',
    fly: { text: 'A disk for each agent, kept while it sleeps, that grows by itself as it fills.', cite: ['fly-config'] },
    aws: { text: 'An EC2 server keeps its disk when stopped. A Fargate service deletes its task’s disk when the task ends.', cite: ['aws-ec2-stop', 'aws-ebs-tasks'] },
    gcp: { text: 'A server keeps its disks when stopped, and they are billed while it sleeps.', cite: ['gcp-stop'] },
    vercel: { text: 'A Sandbox saves its files when it stops, and a Drive keeps work across sandboxes.', cite: ['vercel-persistent', 'vercel-drives'] },
  },
  {
    need: 'A private network between them, with nothing to build.',
    fly: { text: 'Your agents’ computers share a private network, and Fly issues the certificates for your own domain.', cite: ['fly-6pn', 'fly-certs'] },
    aws: { text: 'Lightweight virtual machines like Fly’s run only inside some EC2 server types, and AWS suggests dedicated hardware for speed-sensitive work.', cite: ['aws-nested'] },
    gcp: { text: 'They run only inside some Compute Engine server types, and Google warns they can be 10% or more slower there.', cite: ['gcp-nested'] },
    vercel: { text: 'A Sandbox’s open ports are public addresses. A private network is for Enterprise plans.', cite: ['vercel-sandbox', 'vercel-secure-compute'] },
  },
];

/* The questions an engineering lead's team asks before a yes (the owner,
   07:06 UTC), answered plainly. */
export const QUESTIONS: { q: string; a: string; cite: SourceId[] }[] = [
  {
    q: 'Is Fly one more vendor to approve?',
    a: 'Yes, one. Fly has a SOC 2 Type II report and a HIPAA package with a signed BAA. Everything sits in one Fly account of yours, with one bill.',
    cite: ['fly-pricing'],
  },
  {
    q: 'Do our AWS or Google Cloud credits apply?',
    a: 'No. Fly bills your account directly, and credits or committed spend with another cloud do not carry over.',
    cite: [],
  },
  {
    q: 'Where does our data live, and how is it backed up?',
    a: 'In your Fly account and its storage, on your domain. None of your data comes to us: once a day your Agentic Cloud sends us a report of counts and the contact you chose, and your admin sees every report and can turn it off. Fly snapshots the Workspace’s disk and the code’s disk every day and keeps a week of them, and the Workspace’s database is copied to a backup bucket of yours every day, with the last 14 kept.',
    cite: ['installer'],
  },
];

const CLOUDS = [['Fly', 'fly'], ['AWS', 'aws'], ['Google Cloud', 'gcp'], ['Vercel', 'vercel']] as const;

const FOUNDER_MAILTO = `mailto:${FOUNDER_EMAIL}?subject=${encodeURIComponent('Our own Agentic Cloud on Fly')}`;

export default function WhyFly() {
  return (
    <main
      className="landing-page copy-page min-h-dvh overflow-x-clip bg-panel text-white"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      <SiteHeader ctaTarget="none" tone="dark" />

      {/* ── What you get ────────────────────────────────────────────────── */}
      <section id="why-fly-top" className={`${SECTION} grid gap-10 pb-10 pt-14 sm:pb-12 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center lg:gap-16`}>
        <div>
          <h1 className={`max-w-[900px] [text-wrap:balance] ${H2}`}>Why your Agentic Cloud runs on Fly.</h1>
          <p className={`mt-5 max-w-[36rem] [text-wrap:pretty] ${LEAD}`}>
            Every agent gets a computer of its own that sleeps when nobody needs it and wakes by
            itself when a link is opened or a message arrives.<Cite ids={['fly-autostop']} /> On Fly
            that comes built in, so the whole system runs in one account of yours, installed with
            one command.
          </p>
        </div>
        <div className="max-w-[420px]"><AgentDayArt /></div>
      </section>

      {/* The cost is the installer's own estimate at Fly's published prices
          (infra/copy-installer/install.mjs, SHAPES and PRICE: $17.41 a month,
          read 6 Nov 2026, note #1013), in claims-we-never-make's terms; it was
          our test installation's $0.86 a day, measured before note #946 took
          the mail receiver out. The time is the clean run of 29 Oct (note #834). */}
      <section id="one-account" className={`${SECTION} pb-8 sm:pb-10`}>
        <ChapterDivider />
        <h2 className={`max-w-[760px] [text-wrap:balance] ${H2}`}>One account of yours. One bill.</h2>
        <p className={`mt-5 max-w-[36rem] [text-wrap:pretty] ${LEAD}`}>
          Your own Agentic Cloud is one Fly organization of yours: one sign-in for your agent, one
          bill you read yourself, no account with us. In our clean run on 29 October, one command
          took a new organization to ready in 13 min 24 s. The installer estimates about $0.57 a day at
          Fly’s published prices for the Workspace, the code host and the router with their disks,
          plus about $0.09 an hour for each awake agent, paid to Fly. Vercel’s nearest offer, Bring Your Own Cloud, runs only your functions in your own
          AWS account, on Enterprise plans, and Vercel still routes the requests.<Cite ids={['vercel-byoc']} />
        </p>
      </section>

      {/* ── Need by need ────────────────────────────────────────────────── */}
      <section id="compare" className={`${SECTION} pb-8 sm:pb-10`}>
        <ChapterDivider />
        <h2 className={`max-w-[760px] [text-wrap:balance] ${H2}`}>What an agent needs, cloud by cloud.</h2>
        {/* On a desk, the table it is: one row per need, one column per
            cloud, Fly's in ink. A phone has no room for five columns, so it
            reads each need as a block, Fly first. Only one of the two is
            ever displayed. */}
        <table className="mt-10 hidden w-full table-fixed border-collapse text-left lg:table">
          <thead>
            <tr>
              <td className="w-[22%] pb-4" />
              {CLOUDS.map(([cloud]) => (
                <th key={cloud} scope="col" className={`pb-4 pl-6 type-sm font-semibold ${cloud === 'Fly' ? 'text-white' : 'text-hint'}`}>{cloud}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.need} className="border-t border-hint/16 align-top">
                <th scope="row" className={`py-6 pr-4 [text-wrap:pretty] ${H3}`}>{row.need}</th>
                {CLOUDS.map(([cloud, key]) => (
                  <td key={cloud} className={`py-6 pl-6 [text-wrap:pretty] type-sm ${cloud === 'Fly' ? 'text-white' : 'text-hint'}`}>
                    {row[key].text}<Cite ids={row[key].cite} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-8 lg:hidden">
          {ROWS.map((row) => (
            <div key={row.need} className="border-t border-hint/16 py-6">
              <h3 className={`[text-wrap:pretty] ${H3}`}>{row.need}</h3>
              <dl className="mt-4 grid gap-4">
                {CLOUDS.map(([cloud, key]) => (
                  <div key={cloud}>
                    <dt className={`type-sm font-semibold ${cloud === 'Fly' ? 'text-white' : 'text-hint'}`}>{cloud}</dt>
                    <dd className={`mt-1 [text-wrap:pretty] type-sm ${cloud === 'Fly' ? 'text-white' : 'text-hint'}`}>{row[key].text}<Cite ids={row[key].cite} /></dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>

      {/* ── Questions your team will ask ────────────────────────────────── */}
      <section id="questions" className={`${SECTION} pb-8 sm:pb-10`}>
        <ChapterDivider />
        <h2 className={`max-w-[760px] [text-wrap:balance] ${H2}`}>Questions your team will ask.</h2>
        <dl className="mt-8">
          {QUESTIONS.map(({ q, a, cite }) => (
            <div key={q} className="grid gap-2 border-t border-hint/16 py-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
              <dt className={`[text-wrap:balance] ${H3}`}>{q}</dt>
              <dd className={`max-w-[36rem] [text-wrap:pretty] ${LEAD}`}>{a}<Cite ids={cite} /></dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── The door ─────────────────────────────────────────────────────── */}
      <section id="door" className={`${SECTION} pb-10 sm:pb-12`}>
        <ChapterDivider />
        <div className={`${CARD} lg:p-8`}>
          <h2 className={`max-w-[700px] [text-wrap:balance] ${H2}`}>Build it in your own Fly account.</h2>
          <div className="mt-7 flex flex-wrap items-center gap-7">
            <PrimaryLink href={PRIVATE_COPY_URL}>{PRIVATE_COPY_DOOR}</PrimaryLink>
            <SecondaryLink href={FOUNDER_MAILTO}>Write to the founder</SecondaryLink>
          </div>
        </div>
      </section>

      {/* ── Sources ──────────────────────────────────────────────────────── */}
      <section id="sources" className={`${SECTION} pb-16 sm:pb-24`}>
        <h2 className={H3}>Sources, each read on {SOURCES_READ_ON}</h2>
        <ol className={`mt-4 list-decimal gap-x-10 space-y-2 pl-5 ${BODY} marker:text-hint/70 lg:columns-2`}>
          {SOURCES.map((source, at) => (
            <li key={source.id} id={`source-${at + 1}`} className="min-w-0 scroll-mt-20 break-words break-inside-avoid [text-wrap:pretty]">
              <a href={source.url} className="text-hint underline decoration-hint/35 underline-offset-2 hover:text-white">{source.label}</a>
            </li>
          ))}
        </ol>
      </section>

      <SiteFooter pitch={FOOTER_PITCH} tone="dark" />
    </main>
  );
}
