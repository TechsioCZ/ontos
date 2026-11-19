import { Result } from 'effect';

/**
 * The owner's link policy for one message (#1399 scope 7): the exact HTTPS origins its links may point to, and the only
 * query parameters a link may carry. Links come only from owner-published values; a proof, reset or claim link is never
 * a generic link at all (it is owner-rendered), and nothing a customer supplies may choose where a link goes.
 */
export interface LinkPolicy {
  readonly allowedOrigins: readonly string[];
  /**
   * The owner-declared query parameter names a link may carry, each with a plain value (see {@link plainParameterValue}).
   * The policy is an allow-list: a link with any other parameter, or with a value that could name a URL or a path, is
   * refused, so a redirect or return parameter cannot be smuggled in under a name nobody listed. None by default.
   */
  readonly allowedQueryParameters?: readonly string[];
}

export type LinkFailure = 'link_not_permitted';
const refused = Result.fail<LinkFailure>('link_not_permitted');

const MAX_URL = 2048;
// A value that is a token (an id, a tab, a language): never a URL, a host (no dot), a path or an escape sequence.
const plainParameterValue = /^[A-Za-z0-9_-]{1,64}$/u;
const unsafeCharacter = /[\p{Cc}\s]/u;
const MAX_DECODING_ROUNDS = 4;

// The named HTML references of a brace; numeric references (decimal, hexadecimal, with or without `;`) are decoded alike.
const namedBraces = new Map([
  ['lbrace', '{'],
  ['lcub', '{'],
  ['rbrace', '}'],
  ['rcub', '}'],
]);
const htmlReference = /&(?:#(?<decimal>[0-9]+)|#[xX](?<hexadecimal>[0-9a-fA-F]+)|(?<name>[a-zA-Z]+));?/gu;
const MAX_CODE_POINT = 1_114_111;

const decodeHtmlReferences = (text: string) =>
  text.replaceAll(htmlReference, (reference, decimal?: string, hexadecimal?: string, name?: string) => {
    if (name !== undefined) {
      return namedBraces.get(name) ?? reference;
    }
    const codePoint = decimal === undefined ? Number.parseInt(hexadecimal ?? '', 16) : Number(decimal);
    return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : reference;
  });

/**
 * The text a URL turns into when its percent escapes and HTML references are undone, round after round, until nothing
 * changes. It is `undefined` when an escape is malformed or the text keeps changing, which is itself disqualifying.
 */
const fullyDecoded = (url: string): string | undefined => {
  let current = url;
  for (let round = 0; round < MAX_DECODING_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeHtmlReferences(decodeURIComponent(current));
    } catch {
      return undefined;
    }
    if (next === current) {
      return current;
    }
    current = next;
  }
  return undefined;
};

/**
 * A URL must never be able to complete a placeholder token for a later owner step, however it is written: raw, percent
 * encoded, or as an HTML reference, alone or nested. Any brace after decoding is refused, not only a pair.
 */
const carriesBrace = (url: string) => {
  const decoded = fullyDecoded(url);
  return decoded === undefined || /[{}]/u.test(decoded);
};

// A path segment that could itself be a URL or a further path: a scheme, an authority, a separator or a dot segment.
const steersElsewhere = (segment: string) => {
  const decoded = fullyDecoded(segment);
  return decoded === undefined || /[:\\/;]/u.test(decoded) || decoded === '.' || decoded === '..';
};

/**
 * A link is permitted only when it is an HTTPS URL of an allowed origin, carries no credentials or fragment, no brace in
 * any encoding, a path made of plain segments, and no query parameter beyond the owner's declared set, each with a plain
 * value. The accepted value is the normalized URL, so what was checked is exactly what is shown.
 */
export const approveLink = (url: string, policy: LinkPolicy): Result.Result<string, LinkFailure> => {
  if (
    url.length === 0 ||
    url.length > MAX_URL ||
    unsafeCharacter.test(url) ||
    !URL.canParse(url) ||
    carriesBrace(url)
  ) {
    return refused;
  }
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    !policy.allowedOrigins.includes(parsed.origin) ||
    carriesBrace(parsed.href)
  ) {
    return refused;
  }
  const segments = parsed.pathname.split('/').slice(1);
  // an empty segment (a doubled slash) is only a trailing one: `/a//b` is a path-valued smuggle, `/a/` is a directory
  const interior = segments.slice(0, -1);
  if (interior.some((segment) => segment === '') || segments.some(steersElsewhere)) {
    return refused;
  }
  const allowed = new Set(policy.allowedQueryParameters);
  for (const [name, value] of parsed.searchParams) {
    if (!(allowed.has(name) && plainParameterValue.test(value))) {
      return refused;
    }
  }
  return Result.succeed(parsed.href);
};
