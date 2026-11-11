import { CHAPTERS, DOCS_PATH, chapterPath } from '../docs/chapters';
import { QUESTIONS as WHY_FLY_QUESTIONS } from '../pages/WhyFly';
import { CLAUDE_CODE_IN_THE_CLOUD, CODEX_IN_THE_CLOUD } from './entry-specs';
import { BUILT_IN_LINE, PRODUCT_HEADLINE } from './product-copy';
import { LICENSE_URL, SOURCE_URL } from './source-links';

/* What each page says about itself to a search engine, as JSON-LD in its
   <head> (note #1149, from the search report on note #1144: the site had
   none, while the name collides with agenticcloud.com, Alibaba's "Agentic
   Computer" and AMD's "Agent Computers").

   scripts/prerender.mjs writes these at build time. Nothing here is a new
   claim: every string is the page's own (the FAQ answers are the ones the
   page draws, from product-copy.ts and WhyFly.tsx), so a change to the copy
   is a change here with no second edit. The price is the sentence on
   claims-we-never-make: free for now, and the providers bill their own. */

const ORIGIN = 'https://agenticcloudcomputer.com';
const NAME = 'Agentic Cloud Computer';
/** The product's account on X (knowledge page posting-in-public). */
export const X_URL = 'https://x.com/AgenticCloud';

const ORGANIZATION_ID = `${ORIGIN}/#organization`;
const WEBSITE_ID = `${ORIGIN}/#website`;

const organization = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': ORGANIZATION_ID,
  name: NAME,
  url: `${ORIGIN}/`,
  logo: { '@type': 'ImageObject', url: `${ORIGIN}/android-chrome-512x512.png`, width: 512, height: 512 },
  sameAs: [SOURCE_URL, X_URL],
};

const website = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  name: NAME,
  url: `${ORIGIN}/`,
  publisher: { '@id': ORGANIZATION_ID },
};

const software = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: NAME,
  url: `${ORIGIN}/product`,
  description: `${PRODUCT_HEADLINE} ${BUILT_IN_LINE}`,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Web',
  license: LICENSE_URL,
  isAccessibleForFree: true,
  sameAs: [SOURCE_URL],
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
    description: 'Your own Agentic Cloud is free for now: no licence, no key and no charge from us. Your cloud provider and your AI provider bill you directly.',
  },
  publisher: { '@id': ORGANIZATION_ID },
};

function faqPage(entries: { question: string; answer: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entries.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
}

function breadcrumbs(trail: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(({ name, path }, at) => ({
      '@type': 'ListItem',
      position: at + 1,
      name,
      item: `${ORIGIN}${path}`,
    })),
  };
}

const HOME_CRUMB = { name: NAME, path: '/' };
const DOCS_CRUMB = { name: 'Documentation', path: DOCS_PATH };

/** The JSON-LD blocks for one public route; none for a route with nothing
 *  of its own to say. */
export function structuredDataFor(path: string): object[] {
  if (path === '/') return [organization, website];
  if (path === '/product') return [software];
  if (path === '/claude-code-in-the-cloud') return [faqPage(CLAUDE_CODE_IN_THE_CLOUD.faqs ?? [])];
  if (path === '/codex-in-the-cloud') return [faqPage(CODEX_IN_THE_CLOUD.faqs ?? [])];
  if (path === '/why-fly') return [faqPage(WHY_FLY_QUESTIONS.map(({ q, a }) => ({ question: q, answer: a })))];
  if (path === DOCS_PATH) return [breadcrumbs([HOME_CRUMB, DOCS_CRUMB])];
  const chapter = CHAPTERS.find((entry) => chapterPath(entry) === path);
  if (chapter) return [breadcrumbs([HOME_CRUMB, DOCS_CRUMB, { name: chapter.title, path }])];
  return [];
}
