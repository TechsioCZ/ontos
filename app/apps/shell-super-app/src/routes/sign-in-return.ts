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

/** Login page URL that returns to `path` after sign-in, or the plain login page when `path` is not returnable. */
export const signInHref = (language: string, path: string): string => {
  const login = `/${language}/login`;
  return isSafeReturnPath(path, language) ? `${login}?${UrlParams.toString({ returnTo: path })}` : login;
};

/** The page to open after sign-in, read from the login page URL when it is safe to follow. */
export const signInReturnPath = (href: string, language: string): string | undefined => {
  const returnTo = UrlParams.getFirst(Url.urlParams(new URL(href)), 'returnTo');
  const search: typeof SignInRouteSearch.Type = Option.getOrElse(
    Schema.decodeOption(SignInRouteSearch)(Option.isSome(returnTo) ? { returnTo: returnTo.value } : {}),
    () => ({}),
  );
  return search.returnTo !== undefined && isSafeReturnPath(search.returnTo, language) ? search.returnTo : undefined;
};
