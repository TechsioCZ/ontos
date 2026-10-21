import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { OAUTH_SCOPES } from './env.mts';

export interface E2eOAuthProviderOptions {
  readonly redirectUrl: string;
  readonly clientName: string;
  readonly clientMetadataUrl?: string;
  readonly onRedirect: (authorizationUrl: URL) => Promise<void>;
}

/** In-memory OAuth client provider for the E2E proof; the consent page is driven by onRedirect. */
export class E2eOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl: string | undefined;
  #options: E2eOAuthProviderOptions;
  #clientInformation: StoredOAuthClientInformation | undefined = undefined;
  #tokens: StoredOAuthTokens | undefined = undefined;
  #codeVerifier: string | undefined = undefined;
  lastAuthorizationUrl: URL | undefined = undefined;

  constructor(options: E2eOAuthProviderOptions) {
    this.#options = options;
    this.clientMetadataUrl = options.clientMetadataUrl;
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

  /** Returns the stored token set or throws when the flow has not produced one. */
  currentTokens(): StoredOAuthTokens {
    if (this.#tokens === undefined) {
      throw new Error('Žádné tokeny');
    }
    return this.#tokens;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.#codeVerifier === undefined) {
      throw new Error('Chybí code verifier.');
    }
    return this.#codeVerifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.lastAuthorizationUrl = authorizationUrl;
    await this.#options.onRedirect(authorizationUrl);
  }
}
