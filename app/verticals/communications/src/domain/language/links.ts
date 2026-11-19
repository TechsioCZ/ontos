import { Result } from 'effect';

/**
 * The owner's link policy for one message (#1399 scope 7): the exact HTTPS origins its links may point to. Links come
 * only from owner-published values; a proof, reset or claim link is never a generic link at all (it is owner-rendered),
 * and nothing a customer supplies may choose where a link goes.
 */
export interface LinkPolicy {
  readonly allowedOrigins: readonly string[];
}

export type LinkFailure = 'link_not_permitted';
const refused = Result.fail<LinkFailure>('link_not_permitted');

const MAX_URL = 2048;
const redirectParameter =
  /^(?:redirect|redirect_?uri|redirect_?url|return|return_?to|return_?url|next|continue|url|uri|target|dest|destination|callback|goto|forward)$/iu;
const unsafeCharacter = /[\p{Cc}\s]/u;
const absoluteOrProtocolRelative = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/**
 * A link is permitted only when it is an HTTPS URL of an allowed origin, carries no credentials or fragment, and none of
 * its query parameters can redirect elsewhere. The accepted value is the normalized URL, so what was checked is exactly
 * what is shown.
 */
export const approveLink = (url: string, policy: LinkPolicy): Result.Result<string, LinkFailure> => {
  if (url.length === 0 || url.length > MAX_URL || unsafeCharacter.test(url) || !URL.canParse(url)) {
    return refused;
  }
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    !policy.allowedOrigins.includes(parsed.origin)
  ) {
    return refused;
  }
  for (const [name, value] of parsed.searchParams) {
    if (redirectParameter.test(name) || absoluteOrProtocolRelative.test(value)) {
      return refused;
    }
  }
  return Result.succeed(parsed.href);
};
