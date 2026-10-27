import type {
  OAuthClientMetadata,
  OAuthDiscoveryState,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { Cause, Effect } from 'effect';
import type { FiberSet } from 'effect';
import { OAUTH_SCOPES } from './env.mts';

export interface E2eOAuthProviderOptions {
  readonly clientMetadataUrl?: string;
  readonly clientName: string;
  readonly redirectUrl: string;
}

/** Captured by the owning flow; every native callback fiber belongs to its Scope. */
export type E2eOAuthProviderRuntime = Effect.Success<
  ReturnType<typeof FiberSet.makeRuntimePromise<never, string, Cause.NoSuchElementError>>
>;

/** SDK state adapter. The owning Effect flow drives consent after the SDK reports REDIRECT. */
export class E2eOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl: string | undefined;
  readonly codeVerifier: OAuthClientProvider['codeVerifier'];
  readonly #options: E2eOAuthProviderOptions;
  #clientInformation: StoredOAuthClientInformation | undefined = undefined;
  #tokens: StoredOAuthTokens | undefined = undefined;
  #codeVerifier: string | undefined = undefined;
  #discoveryState: OAuthDiscoveryState | undefined = undefined;
  lastAuthorizationUrl: URL | undefined = undefined;

  constructor(options: E2eOAuthProviderOptions, runtime: E2eOAuthProviderRuntime) {
    this.#options = options;
    this.clientMetadataUrl = options.clientMetadataUrl;
    const verifier = Effect.gen({ self: this }, function* readCodeVerifier() {
      if (this.#codeVerifier === undefined) {
        return yield* new Cause.NoSuchElementError('Chybí code verifier.');
      }
      return this.#codeVerifier;
    });
    // Native SDK entrypoint: the captured runner rejects with the original squashed failure.
    this.codeVerifier = runtime.bind(undefined, verifier);
  }

  get redirectUrl(): string {
    return this.#options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.#options.clientName,
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [this.redirectUrl],
      response_types: ['code'],
      scope: OAUTH_SCOPES,
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.#clientInformation;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.#clientInformation = info;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.#tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.#tokens = tokens;
  }

  currentTokens() {
    return Effect.gen({ self: this }, function* storedTokens() {
      if (this.#tokens === undefined) {
        return yield* new Cause.NoSuchElementError('Žádné tokeny');
      }
      return this.#tokens;
    });
  }

  /** Persisted with the code verifier so the SDK binds the callback leg to the same authorization server (SEP-2352). */
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discoveryState = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discoveryState;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizationUrl = authorizationUrl;
  }
}
