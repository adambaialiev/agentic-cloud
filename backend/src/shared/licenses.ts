/**
 * Which licence a LICENSE file is, from its words — for the About strip on
 * a public repository (the owner, 2026-09-27), where a visitor wants the
 * name before cloning. Publishing already requires a non-empty conventional
 * licence file; this only names the common ones and says nothing for the
 * rest, so the page can say "See LICENSE" rather than guess.
 *
 * Matched on distinctive phrases rather than titles alone: many files carry
 * no title, and a few carry a title that is not the licence that follows.
 */

const RULES: Array<{ name: string; test: RegExp }> = [
  { name: 'AGPL-3.0', test: /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i },
  { name: 'LGPL-3.0', test: /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i },
  { name: 'LGPL-2.1', test: /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/i },
  { name: 'GPL-3.0', test: /GNU GENERAL PUBLIC LICENSE\s+Version 3/i },
  { name: 'GPL-2.0', test: /GNU GENERAL PUBLIC LICENSE\s+Version 2/i },
  { name: 'Apache-2.0', test: /Apache License\s+Version 2\.0/i },
  { name: 'MPL-2.0', test: /Mozilla Public License,? (?:Version )?2\.0/i },
  { name: 'MIT', test: /Permission is hereby granted, free of charge, to any person obtaining a copy/i },
  { name: 'ISC', test: /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/i },
  { name: 'BSD-3-Clause', test: /Redistribution and use in source and binary forms[\s\S]*Neither the name of/i },
  { name: 'BSD-2-Clause', test: /Redistribution and use in source and binary forms/i },
  { name: 'Unlicense', test: /This is free and unencumbered software released into the public domain/i },
  { name: 'CC0-1.0', test: /CC0 1\.0 Universal/i },
  { name: 'CC-BY-4.0', test: /Creative Commons Attribution 4\.0/i },
];

/** The SPDX-style name of a licence file's licence, or null when it is not
 *  one of the common ones. */
export function detectLicense(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ');
  for (const rule of RULES) if (rule.test.test(flat)) return rule.name;
  return null;
}

/** The root entry that IS the licence file, by the same rule publishing uses. */
export const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:\.(?:md|txt|rst))?$/i;

/**
 * A README's first paragraph as a one-line description: headings, badges,
 * images, HTML and blank lines skipped, inline markdown stripped, cut at a
 * word before `max` characters. Null for a README that opens with nothing
 * but those.
 */
export function readmeDescription(markdown: string, max = 200): string | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const paragraph: string[] = [];
  let fenced = false;
  for (const raw of lines) {
    const line = raw.trim();
    // A fenced block is code whatever it says; skip it whole.
    if (/^(```|~~~)/.test(line)) { if (paragraph.length) break; fenced = !fenced; continue; }
    if (fenced) continue;
    if (!line) { if (paragraph.length) break; continue; }
    if (paragraph.length === 0) {
      if (/^#{1,6}\s/.test(line) || /^[=-]{3,}$/.test(line)) continue;
      if (/^<!--/.test(line) || /^<[a-z!/]/i.test(line)) continue;
      if (/^!\[/.test(line) || /^\[!\[/.test(line) || /^\[\!/.test(line)) continue;
      if (/^[-*+]\s/.test(line) || /^\d+\.\s/.test(line) || /^>/.test(line) || /^\|/.test(line)) continue;
    } else if (/^#{1,6}\s/.test(line)) break;
    paragraph.push(line);
  }
  let text = paragraph.join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length > max) {
    const cut = text.slice(0, max);
    const at = cut.lastIndexOf(' ');
    text = `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.!?-]+$/, '')}…`;
  }
  return text;
}
