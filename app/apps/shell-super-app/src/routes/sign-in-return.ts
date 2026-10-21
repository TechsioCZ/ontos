// Sign-in round trip for protected deep links: the module page sends an anonymous visitor to the login page with
// the page it asked for, and the login page returns there after a successful sign-in.
import { throwTanstackRedirect } from '@modern-js/plugin-tanstack/runtime';
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

/**
 * Route loaders call this for a browser without a live session (never signed in, disabled account, session the
 * Shell no longer accepts): every protected page goes to sign-in, during server rendering as an HTTP redirect, and
 * sign-in returns to the page that was asked for. Throws; never returns.
 */
export const redirectToSignIn = (request: Request, reason?: SignInReason): never => {
  const url = new URL(request.url);
  const segment = url.pathname.split('/')[1] ?? '';
  const language = /^[a-z]{2}$/u.test(segment) ? segment : 'cs';
  // An absolute same-origin URL: TanStack keeps its query string and loads the sign-in page as a fresh document,
  // which also drops every browser read cached for the dead session.
  return throwTanstackRedirect(new URL(signInHref(language, `${url.pathname}${url.search}`, reason), url).href);
};

/** Throws the sign-in redirect when the Shell answered "not signed in"; any other model passes through. */
export const requireSignedIn = <M extends { readonly shell: SignInShellState }>(request: Request, model: M): M =>
  model.shell.state === 'anonymous' ? redirectToSignIn(request, model.shell.reason) : model;

/** The part of the Shell page model that tells whether the browser still holds a live session. */
export interface SignInShellState {
  readonly reason?: SignInReason;
  readonly state: string;
}

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
