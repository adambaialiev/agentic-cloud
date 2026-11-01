import type { DocChapter } from './model';
import gettingStarted from './chapters/getting-started';
import agents from './chapters/agents';
import talking from './chapters/talking-to-agents';
import notes from './chapters/notes-knowledge-drive';
import repositories from './chapters/repositories-and-proposals';
import sites from './chapters/sites-and-domains';
import secrets from './chapters/secrets';
import email from './chapters/email';
import workplace from './chapters/workplace-and-people';
import cloud from './chapters/your-cloud-and-subscriptions';

/** Every chapter, in reading order. The sidebar, the previous/next doors,
 *  the route table and the sitemap all read this one list. */
export const CHAPTERS: DocChapter[] = [
  gettingStarted,
  agents,
  talking,
  notes,
  repositories,
  sites,
  secrets,
  email,
  workplace,
  cloud,
];

export const DOCS_PATH = '/docs';

export function chapterPath(chapter: Pick<DocChapter, 'slug'>): string {
  return `${DOCS_PATH}/${chapter.slug}`;
}

export function chapterBySlug(slug: string | undefined): DocChapter | undefined {
  return CHAPTERS.find((chapter) => chapter.slug === slug);
}
