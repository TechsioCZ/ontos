// Sign-in round trip for protected deep links: the module page sends an anonymous visitor to the login page with
// the page it asked for, and the login page returns there after a successful sign-in.
import { Option, Schema } from 'effect';
import { Url, UrlParams } from 'effect/unstable/http';

const SignInRouteSearch = Schema.Struct({
  returnTo: Schema.optionalKey(Schema.String),
});

/**
 * Accepts only a same-origin path inside the current language, never the login page itself. Anything else
 * (absolute URLs, protocol-relative `//host`, backslash tricks) is ignored so the login page cannot redirect away.
 */
const isSafeReturnPath = (path: string, language: string): boolean =>
  path.startsWith(`/${language}/`) && !path.includes('\\') && !path.startsWith(`/${language}/login`);

/** Why a signed-in browser was sent back to sign-in: the account lost access, or the session is no longer valid. */
export const signInReasons = ['account_forbidden', 'session_ended'] as const;
export type SignInReason = (typeof signInReasons)[number];
const SignInReasonSchema = Schema.Literals(signInReasons);

/** Login page URL that returns to `path` after sign-in, or the plain login page when `path` is not returnable. */
export const signInHref = (language: string, path: string, reason?: SignInReason): string => {
  const login = `/${language}/login`;
  const params = {
    ...(isSafeReturnPath(path, language) ? { returnTo: path } : {}),
    ...(reason === undefined ? {} : { reason }),
  };
  return Object.keys(params).length === 0 ? login : `${login}?${UrlParams.toString(params)}`;
};

/** The sign-in notice to show, read from the login page URL or path; unknown values are ignored. */
export const signInReason = (href: string): SignInReason | undefined =>
  Option.getOrUndefined(
    Option.flatMap(
      UrlParams.getFirst(Url.urlParams(new URL(href, 'http://localhost')), 'reason'),
      Schema.decodeUnknownOption(SignInReasonSchema),
    ),
  );

/** The page to open after sign-in, read from the login page URL when it is safe to follow. */
export const signInReturnPath = (href: string, language: string): string | undefined => {
  const returnTo = UrlParams.getFirst(Url.urlParams(new URL(href)), 'returnTo');
  const search: typeof SignInRouteSearch.Type = Option.getOrElse(
    Schema.decodeOption(SignInRouteSearch)(Option.isSome(returnTo) ? { returnTo: returnTo.value } : {}),
    () => ({}),
  );
  return search.returnTo !== undefined && isSafeReturnPath(search.returnTo, language) ? search.returnTo : undefined;
};
