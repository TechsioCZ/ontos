import {
  auth,
  discoverAuthorizationServerMetadata,
  refreshAuthorization,
  type OAuthClientInformationMixed,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { E2eOAuthProvider } from './provider.mts';
import type { LoopbackCallback } from './loopback.mts';
import { OAUTH_SCOPES } from './env.mts';

export async function runOAuthFlow(opts: {
  serverUrl: string;
  provider: E2eOAuthProvider;
  loopback: LoopbackCallback;
}): Promise<{ accessToken: string; refreshToken: string | undefined; iss: string | null; state: string | null; code: string }> {
  // onRedirect drives the browser consent, so the callback may already have arrived.
  const first = await auth(opts.provider, { scope: OAUTH_SCOPES, serverUrl: opts.serverUrl });
  if (first !== 'REDIRECT') {
    throw new Error(`Očekáván REDIRECT, přišlo ${String(first)}`);
  }
  const params = await opts.loopback.waitForCallback(180_000);
  const error = params.get('error');
  if (error !== null) {
    throw new Error(`authorization error ${error}`);
  }
  const code = params.get('code');
  if (code === null) {
    throw new Error('Callback neobsahuje code.');
  }
  const second = await auth(opts.provider, {
    authorizationCode: code,
    iss: params.get('iss') ?? undefined,
    serverUrl: opts.serverUrl,
  });
  if (second !== 'AUTHORIZED') {
    throw new Error(`Očekáván AUTHORIZED, přišlo ${String(second)}`);
  }
  const tokens = opts.provider.currentTokens();
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    iss: params.get('iss'),
    state: params.get('state'),
    code,
  };
}

function clientInformationFor(provider: E2eOAuthProvider): OAuthClientInformationMixed {
  const info = provider.clientInformation() ?? (provider.clientMetadataUrl ? { client_id: provider.clientMetadataUrl } : undefined);
  if (info === undefined) {
    throw new Error('Chybí informace o klientovi.');
  }
  return info as OAuthClientInformationMixed;
}

export async function rotateRefreshToken(opts: {
  issuer: string;
  resource: string;
  provider: E2eOAuthProvider;
}): Promise<{ oldRefreshToken: string; newRefreshToken: string | undefined; accessToken: string }> {
  const metadata = await discoverAuthorizationServerMetadata(opts.issuer);
  const clientInformation = clientInformationFor(opts.provider);
  const oldRefreshToken = opts.provider.currentTokens().refresh_token;
  if (oldRefreshToken === undefined) {
    throw new Error('Chybí refresh token (offline_access nebyl udělen).');
  }
  const next = await refreshAuthorization(opts.issuer, {
    clientInformation,
    metadata,
    refreshToken: oldRefreshToken,
    resource: new URL(opts.resource),
  });
  opts.provider.saveTokens(next as StoredOAuthTokens);
  return {
    accessToken: next.access_token,
    newRefreshToken: next.refresh_token,
    oldRefreshToken,
  };
}

/** Replays a refresh token and reports whether the server rejects it. Does NOT save tokens. */
export async function refreshIsRejected(opts: {
  issuer: string;
  resource: string;
  provider: E2eOAuthProvider;
  refreshToken: string;
}): Promise<boolean> {
  const metadata = await discoverAuthorizationServerMetadata(opts.issuer);
  const clientInformation = clientInformationFor(opts.provider);
  try {
    await refreshAuthorization(opts.issuer, {
      clientInformation,
      metadata,
      refreshToken: opts.refreshToken,
      resource: new URL(opts.resource),
    });
    return false;
  } catch {
    return true;
  }
}
