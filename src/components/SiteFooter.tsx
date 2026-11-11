import { HOME_COLUMN } from './landing-kit';
import { NEW_TAB, useNewTab } from '../lib/new-tab';
import BrandMark from './BrandMark';
import { SOURCE_URL } from '../lib/source-links';

export const CONTACT_EMAIL = 'hello@agenticcloudcomputer.com';
/** The footer's Contact door goes to the founder, the one address the home
 *  page names (the owner, 29 Oct 2026, 17:21 UTC, note #834). The Terms and
 *  the Privacy Policy keep CONTACT_EMAIL as their legal contact. */
export const FOOTER_CONTACT_EMAIL = 'adam@agenticcloudcomputer.com';

// The operator's legal identity lives on /terms and /privacy rather than
// riding every public article in the site-wide footer.

type Tone = 'light' | 'dark';

/* The footer's quiet grey: the column titles and the closing line. Each is
   the tone's own secondary text at full strength, which clears 4.5:1 on its
   background (5.5:1 on the public pages), so a footer label is never fainter
   than the links under it. */
export const FOOTER_QUIET: Record<Tone, string> = { dark: 'text-hint', light: 'text-prose-soft' };

function FooterLink({ href, children, tone }: { href: string; children: string; tone: Tone }) {
  /* On the home page every link opens a new tab (note #999); on the other
     pages the footer's links open in place, as before. */
  const newTab = useNewTab();
  return (
    <a
      href={href}
      {...(newTab ? NEW_TAB : {})}
      className={
        tone === 'dark'
          ? 'text-hint underline decoration-hint/30 underline-offset-2 transition-colors hover:text-white hover:decoration-white/40'
          : 'text-prose-soft underline decoration-prose-soft/30 underline-offset-2 transition-colors hover:text-ink hover:decoration-ink/40'
      }
    >
      {children}
      {newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
    </a>
  );
}

function FooterColumn({ title, children, tone }: { title: string; children: React.ReactNode; tone: Tone }) {
  return (
    <div>
      {/* The scale's tracking is drawn for sentence case; uppercase at 12px
          needs more air than any role gives it, so this one overrides it.
          Full-strength hint, never a fraction of it: at 80% it measured 3.6:1
          on the page, under the 4.5:1 small text needs (the owner, 28 Oct
          2026). FOOTER_QUIET is the one grey both quiet lines share. */}
      <p className={`type-xs font-semibold uppercase tracking-[0.08em] ${FOOTER_QUIET[tone]}`}>{title}</p>
      <ul className="mt-3 space-y-2 type-sm">{children}</ul>
    </div>
  );
}

/**
 * The site-wide footer.
 *
 * It was a single line of slash-separated links, which is fine as furniture and
 * useless as navigation: nothing on it said what else there was to read. In
 * columns it does the job a footer is actually for. The Articles column was
 * removed on 2026-09-07 with the articles themselves; the Payments and refunds
 * row went on 2026-09-14 with that page, whose two load-bearing sentences are
 * now Terms section 3.
 */
/* `wide` (the home page, note #977): the whole width of the window with the
   page's side padding, as every section above it, and since note #978 the
   same 1280 px content cap as the screens above; every other page keeps the
   centred column. */
/* `mark` (the home page, note #1003, the owner: "in the footer Agentic Cloud
   Computer should be with logo"): the name stands with the site's wave mark
   beside it, as one unit, the way the header draws it on every other page. */
export default function SiteFooter({ pitch, tone = 'light', wide = false, mark = false }: { pitch: string; tone?: Tone; wide?: boolean; mark?: boolean }) {
  return (
    <footer className={tone === 'dark' ? 'border-t border-hint/16 bg-panel' : 'border-t border-black/[0.08] bg-white'}>
      <div className={wide ? 'mx-auto w-full max-w-[calc(1280px+6rem)] px-5 py-12 sm:px-8 lg:px-12' : 'mx-auto w-full max-w-6xl px-5 py-12 sm:px-8'}>
        {/* On the home page its content sits on the page's one column
            (HOME_COLUMN, note #1088), the film's width. */}
        <div className={wide ? `mx-auto w-full ${HOME_COLUMN}` : undefined}>
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          <div className="lg:pr-6">
            <p data-footer-name className={`type-base font-semibold ${mark ? 'flex items-center gap-2.5 tracking-[-0.01em]' : ''} ${tone === 'dark' ? 'text-white' : 'text-ink'}`}>
              {mark ? <BrandMark className="-ml-[3px] h-6 w-6 shrink-0" tint={tone === 'dark' ? 'var(--color-white)' : '#1c2028'} label="" /> : null}
              Agentic Cloud Computer
            </p>
            <p className={`mt-2 type-sm ${tone === 'dark' ? 'text-hint' : 'text-prose-soft'}`}>{pitch}</p>
          </div>

          <FooterColumn title="Product" tone={tone}>
            {/* "For teams" sat here, pointing at /teams. That page became the
                front page on 2026-08-29, so the row would have been a second
                link to the one above it. The three entry pages and the four
                phases are here because a page nothing links to is a page a
                crawler reaches only through the sitemap. */}
            <li>
              <FooterLink href="/product" tone={tone}>Product</FooterLink>
            </li>
            {/* The app catalogue and the open-source repository (note #1149):
                the Workspace draws both, so no page here linked the first
                and only two linked the second, and neither was in the
                sitemap. A footer link on every page is how a crawler and a
                reader find them. */}
            <li>
              <FooterLink href="/apps" tone={tone}>Apps built here</FooterLink>
            </li>
            <li>
              <FooterLink href="/claude-code-in-the-cloud" tone={tone}>Claude Code in the cloud</FooterLink>
            </li>
            <li>
              <FooterLink href="/codex-in-the-cloud" tone={tone}>Codex in the cloud</FooterLink>
            </li>
            <li>
              <FooterLink href="/ai-agents-for-your-team" tone={tone}>AI agents for your team</FooterLink>
            </li>
            <li>
              <FooterLink href="/four-phases" tone={tone}>The four phases of AI at work</FooterLink>
            </li>
            <li>
              <FooterLink href="/why-fly" tone={tone}>Why it runs on Fly</FooterLink>
            </li>
            <li>
              <FooterLink href="/docs" tone={tone}>Documentation</FooterLink>
            </li>
            <li>
              <FooterLink href={SOURCE_URL} tone={tone}>Source code</FooterLink>
            </li>
            <li>
              <FooterLink href={`mailto:${FOOTER_CONTACT_EMAIL}`} tone={tone}>Contact</FooterLink>
            </li>
          </FooterColumn>

          <FooterColumn title="Legal" tone={tone}>
            <li>
              <FooterLink href="/terms" tone={tone}>Terms of Service</FooterLink>
            </li>
            <li>
              <FooterLink href="/privacy" tone={tone}>Privacy Policy</FooterLink>
            </li>
          </FooterColumn>
        </div>

        <p className={`mt-10 border-t pt-6 type-xs ${tone === 'dark' ? 'border-hint/16' : 'border-black/[0.06]'} ${FOOTER_QUIET[tone]}`}>
          © {new Date().getFullYear()} Agentic Cloud Computer. Claude and Claude Code are products
          of Anthropic; ChatGPT and Codex are products of OpenAI. We are not affiliated with those
          companies.
        </p>
        </div>
      </div>
    </footer>
  );
}
