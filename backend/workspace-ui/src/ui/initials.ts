/** A person's initials for a face with no picture (note #833). */

/** "Dana Ives" → "DI", "saddam" → "S"; '' when the name has no letter. */
export function personInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => /\p{L}/u.test(word));
  const first = (word: string | undefined) => (word ? [...word.replace(/^[^\p{L}]+/u, '')][0] ?? '' : '');
  return `${first(words[0])}${words.length > 1 ? first(words[words.length - 1]) : ''}`.toLocaleUpperCase();
}
