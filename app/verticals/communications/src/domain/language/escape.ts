/** Escaping of every owner-supplied value for HTML text and attribute positions; the template text is escaped too. */
const replacements = new Map([
  ["'", '&#39;'],
  ['"', '&quot;'],
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
]);
export const escapeHtml = (text: string): string =>
  text.replaceAll(/[&<>"']/gu, (character) => replacements.get(character) ?? character);

/** The inverse of {@link escapeHtml}, used to prove that the HTML of a message says exactly what its text says. */
export const unescapeHtml = (html: string): string =>
  html
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
