import { Option, Schema } from 'effect';
import { Url, UrlParams } from 'effect/unstable/http';

// Pure helpers for the OAuth login hand-off (ONTOS-MCP-AUTH-DESIGN.md §2.3): no React, no browser globals.
export const OAUTH_AUTHORIZE_PATH = '/shell-super-app-api/oauth/oauth2/authorize';
export const OAUTH_PRELOGIN_PATH = '/shell-super-app-api/oauth/oauth2/public-client-prelogin';
const SIGNATURE_PARAMS = ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param'] as const;
const KNOWN_CLIENT_HOSTS: ReadonlySet<string> = new Set([
  'chatgpt.com',
  'claude.ai',
  'claude.com',
  'vscode.dev',
  'cursor.com',
  'www.cursor.com',
]);

export interface OAuthLoginRequest {
  /** Same-origin authorize URL to open after sign-in. */
  readonly authorizeUrl: string;
  /** Host for the banner: the CIMD document host, else the redirect host; '' when unknown. */
  readonly clientHost: string;
  readonly clientId: string;
  /** CIMD document on a well-known host (ChatGPT, Claude, VS Code, Cursor). */
  readonly knownClient: boolean;
  /** The signed query exactly as received, without '?' (body field oauth_query of public-client-prelogin). */
  readonly signedQuery: string;
}

const hostOf = (value: string | undefined): string | undefined =>
  value !== undefined && URL.canParse(value) ? new URL(value).hostname : undefined;

const SearchValueSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const OAuthLoginSearchSchema = Schema.RecordFromUrlParams.pipe(
  Schema.decodeTo(
    Schema.Struct({
      client_id: Schema.optionalKey(SearchValueSchema),
      oauth_error: Schema.optionalKey(SearchValueSchema),
      prompt: Schema.optionalKey(SearchValueSchema),
      redirect_uri: Schema.optionalKey(SearchValueSchema),
      response_type: Schema.optionalKey(SearchValueSchema),
      sig: Schema.optionalKey(SearchValueSchema),
    }),
  ),
);
const firstSearchValue = (value: typeof SearchValueSchema.Type | undefined): string | undefined =>
  Schema.is(Schema.String)(value) ? value : value?.[0];
const loginSearch = (url: URL) =>
  Option.getOrUndefined(Schema.decodeOption(OAuthLoginSearchSchema)(Url.urlParams(url)));

/** The OAuth authorization request carried by the login page URL, or undefined for an ordinary sign-in. */
export const readOAuthLoginRequest = (href: string): OAuthLoginRequest | undefined => {
  if (!URL.canParse(href)) {
    return undefined;
  }
  const url = new URL(href);
  const search = loginSearch(url);
  const clientId = firstSearchValue(search?.client_id);
  if (
    clientId === undefined ||
    clientId === '' ||
    firstSearchValue(search?.response_type) !== 'code' ||
    firstSearchValue(search?.sig) === undefined
  ) {
    return undefined;
  }
  // Keep order and duplicates exactly as URLSearchParams.delete/set did, while retaining the original signed query below.
  const prompt = (firstSearchValue(search?.prompt) ?? '')
    .split(' ')
    .filter((value) => value !== '' && value !== 'login' && value !== 'create');
  let promptWritten = false;
  const authorize = UrlParams.make(
    Url.urlParams(url).params.flatMap(([name, value]): readonly (readonly [string, string])[] => {
      if (SIGNATURE_PARAMS.some((signature) => signature === name)) {
        return [];
      }
      if (name !== 'prompt') {
        return [[name, value]];
      }
      if (promptWritten || prompt.length === 0) {
        return [];
      }
      promptWritten = true;
      return [[name, prompt.join(' ')]];
    }),
  );
  const documentHost = hostOf(clientId);
  const clientHost = documentHost ?? hostOf(firstSearchValue(search?.redirect_uri)) ?? '';
  return {
    authorizeUrl: `${url.origin}${OAUTH_AUTHORIZE_PATH}?${UrlParams.toString(authorize)}`,
    clientHost,
    clientId,
    knownClient: documentHost !== undefined && KNOWN_CLIENT_HOSTS.has(documentHost),
    signedQuery: url.search.startsWith('?') ? url.search.slice(1) : url.search,
  };
};

const PreloginClientName = Schema.Struct({ client_name: Schema.String });

/** `client_name` from the public-client-prelogin JSON body. */
export const clientNameFrom = (body: Schema.Json | undefined): string | undefined => {
  const name = Option.getOrUndefined(Schema.decodeUnknownOption(PreloginClientName)(body))?.client_name;
  return name === undefined || name.trim() === '' ? undefined : name.trim();
};

export const OAuthLoginErrorCodeSchema = Schema.Literals(['invalid_client', 'invalid_redirect', 'request_failed']);
export type OAuthLoginErrorCode = typeof OAuthLoginErrorCodeSchema.Type;

/**
 * `?oauth_error=<code>`: the authorization server refused a connect request it cannot send back to the client
 * (unknown client, unregistered redirect). The page then shows a Czech error card instead of the sign-in form.
 */
export const readOAuthLoginError = (href: string): OAuthLoginErrorCode | undefined => {
  if (!URL.canParse(href)) {
    return undefined;
  }
  const code = firstSearchValue(loginSearch(new URL(href))?.oauth_error);
  if (code === undefined) {
    return undefined;
  }
  return Option.getOrElse(Schema.decodeUnknownOption(OAuthLoginErrorCodeSchema)(code), () => 'request_failed');
};
