import { auth, discoverAuthorizationServerMetadata, refreshAuthorization } from '@modelcontextprotocol/client';
import { Effect, FiberSet, Option, Redacted, Schema } from 'effect';
import type { Cause } from 'effect';
import { E2eOAuthProvider } from './provider.mts';
import type { E2eOAuthProviderOptions } from './provider.mts';
import type { LoopbackCallback } from './loopback.mts';
import { OAUTH_SCOPES } from './env.mts';

class OAuthFlowInvalid extends Schema.TaggedError<OAuthFlowInvalid>()('OAuthFlowInvalid', {
  message: Schema.String,
}) {}

export const runOAuthFlow = <E, R>(opts: {
  approve: (authorizationUrl: URL) => Effect.Effect<void, E, R>;
  loopback: LoopbackCallback;
  providerOptions: E2eOAuthProviderOptions;
  serverUrl: string;
}) =>
  Effect.gen(function* authorize() {
    const runtime = yield* FiberSet.makeRuntimePromise<never, string, Cause.NoSuchElementError>();
    const provider = new E2eOAuthProvider(opts.providerOptions, runtime);
    const first = yield* Effect.tryPromise(
      async () => await auth(provider, { scope: OAUTH_SCOPES, serverUrl: opts.serverUrl }),
    );
    if (first !== 'REDIRECT') {
      return yield* new OAuthFlowInvalid({ message: `Očekáván REDIRECT, přišlo ${first}` });
    }
    const authorizationUrl = provider.lastAuthorizationUrl;
    if (authorizationUrl === undefined) {
      return yield* new OAuthFlowInvalid({ message: 'SDK neuložilo autorizační URL.' });
    }
    // Consent runs in this fiber, rather than starting a second runtime inside the SDK callback.
    yield* opts.approve(authorizationUrl);
    const params = yield* opts.loopback.waitForCallback(180_000);
    const error = params.get('error');
    if (error !== null) {
      return yield* new OAuthFlowInvalid({ message: `authorization error ${error}` });
    }
    const code = params.get('code');
    if (code === null) {
      return yield* new OAuthFlowInvalid({ message: 'Callback neobsahuje code.' });
    }
    const second = yield* Effect.tryPromise(
      async () =>
        await auth(provider, {
          authorizationCode: code,
          iss: params.get('iss') ?? undefined,
          serverUrl: opts.serverUrl,
        }),
    );
    if (second !== 'AUTHORIZED') {
      return yield* new OAuthFlowInvalid({ message: `Očekáván AUTHORIZED, přišlo ${second}` });
    }
    const tokens = yield* provider.currentTokens();
    return {
      accessToken: Redacted.make(tokens.access_token),
      code,
      iss: Option.fromNullOr(params.get('iss')),
      provider,
      refreshToken: Option.map(Option.fromUndefinedOr(tokens.refresh_token), Redacted.make),
      state: Option.fromNullOr(params.get('state')),
    };
  });

const clientInformationFor = (provider: E2eOAuthProvider) =>
  Effect.gen(function* clientInformation() {
    const info =
      provider.clientInformation() ??
      (provider.clientMetadataUrl !== undefined && provider.clientMetadataUrl !== ''
        ? { client_id: provider.clientMetadataUrl }
        : undefined);
    if (info === undefined) {
      return yield* new OAuthFlowInvalid({ message: 'Chybí informace o klientovi.' });
    }
    return info;
  });

export const rotateRefreshToken = (opts: { issuer: string; provider: E2eOAuthProvider; resource: string }) =>
  Effect.gen(function* rotateToken() {
    const metadata = yield* Effect.tryPromise(async () => await discoverAuthorizationServerMetadata(opts.issuer));
    const clientInformation = yield* clientInformationFor(opts.provider);
    const stored = yield* opts.provider.currentTokens();
    if (stored.refresh_token === undefined) {
      return yield* new OAuthFlowInvalid({ message: 'Chybí refresh token (offline_access nebyl udělen).' });
    }
    const oldRefreshToken = Redacted.make(stored.refresh_token);
    const next = yield* Effect.tryPromise(
      async () =>
        await refreshAuthorization(opts.issuer, {
          clientInformation,
          metadata,
          refreshToken: Redacted.value(oldRefreshToken),
          resource: new URL(opts.resource),
        }),
    );
    opts.provider.saveTokens(next);
    return {
      accessToken: Redacted.make(next.access_token),
      newRefreshToken: Option.map(Option.fromUndefinedOr(next.refresh_token), Redacted.make),
      oldRefreshToken,
    };
  });

/** Replays a refresh token and reports whether the server rejects it. Does NOT save tokens. */
export const refreshIsRejected = (opts: {
  issuer: string;
  provider: E2eOAuthProvider;
  refreshToken: Redacted.Redacted;
  resource: string;
}) =>
  Effect.gen(function* replayRefreshToken() {
    const metadata = yield* Effect.tryPromise(async () => await discoverAuthorizationServerMetadata(opts.issuer));
    const clientInformation = yield* clientInformationFor(opts.provider);
    return yield* Effect.tryPromise(
      async () =>
        await refreshAuthorization(opts.issuer, {
          clientInformation,
          metadata,
          refreshToken: Redacted.value(opts.refreshToken),
          resource: new URL(opts.resource),
        }),
    ).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }));
  });
