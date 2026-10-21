// Pure helpers for the OAuth login hand-off (ONTOS-MCP-AUTH-DESIGN.md §2.3): no React, no browser globals.
export const OAUTH_AUTHORIZE_PATH = '/shell-super-app-api/oauth/oauth2/authorize';
export const OAUTH_PRELOGIN_PATH = '/shell-super-app-api/oauth/oauth2/public-client-prelogin';
const SIGNATURE_PARAMS = ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param'] as const;
const KNOWN_CLIENT_HOSTS: ReadonlySet<string> = new Set(['chatgpt.com', 'claude.ai', 'claude.com', 'vscode.dev', 'cursor.com', 'www.cursor.com']);

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

const hostOf = (value: string | null): string | undefined =>
  value !== null && URL.canParse(value) ? new URL(value).hostname : undefined;

/** The OAuth authorization request carried by the login page URL, or undefined for an ordinary sign-in. */
export const readOAuthLoginRequest = (href: string): OAuthLoginRequest | undefined => {
  if (!URL.canParse(href)) {
    return undefined;
  }
  const url = new URL(href);
  const params = url.searchParams;
  const clientId = params.get('client_id');
  if (clientId === null || clientId === '' || params.get('response_type') !== 'code' || params.get('sig') === null) {
    return undefined;
  }
  const authorize = new URLSearchParams(params);
  for (const name of SIGNATURE_PARAMS) {
    authorize.delete(name);
  }
  // The person signs in right here, so prompt=login/create are satisfied; keeping them would loop back to this page.
  const prompt = (authorize.get('prompt') ?? '')
    .split(' ')
    .filter((value) => value !== '' && value !== 'login' && value !== 'create');
  if (prompt.length === 0) {
    authorize.delete('prompt');
  } else {
    authorize.set('prompt', prompt.join(' '));
  }
  const documentHost = hostOf(clientId);
  const clientHost = documentHost ?? hostOf(params.get('redirect_uri')) ?? '';
  return {
    authorizeUrl: `${url.origin}${OAUTH_AUTHORIZE_PATH}?${authorize.toString()}`,
    clientHost,
    clientId,
    knownClient: documentHost !== undefined && KNOWN_CLIENT_HOSTS.has(documentHost),
    signedQuery: url.search.startsWith('?') ? url.search.slice(1) : url.search,
  };
};

/** `client_name` from the public-client-prelogin JSON body. */
export const clientNameFrom = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null || !('client_name' in body)) {
    return undefined;
  }
  const name = body.client_name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined;
};
