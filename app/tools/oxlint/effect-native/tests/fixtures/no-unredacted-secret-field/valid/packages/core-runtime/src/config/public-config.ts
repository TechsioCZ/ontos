import { Config, Schema } from 'effect';

// Public configuration: no credential in sight.
export const Issuer = Config.string('ONTOS_GATEWAY_ISSUER');
export const PublicJwks = Config.string('ONTOS_GATEWAY_PUBLIC_JWKS');
export const PoolSize = Config.integer('DATABASE_POOL_SIZE');

// Credential-shaped names whose shape is not an unstructured string.
// Set/Map collections of contribution *keys* are names, not credential bags.
export interface ShellContributionReferenceSets {
  readonly actionKeys: ReadonlySet<string>;
  readonly apiKeys: ReadonlySet<string>;
  readonly credentials: ReadonlyMap<string, CryptoKey>;
}

export interface EntrypointClassification {
  readonly credential: 'api_key' | 'session';
  readonly secretRotationDays: number;
}

export interface GatewayIssuerConfigValue {
  readonly privateJwk: Ed25519PrivateJwk;
  readonly signingKeys: ReadonlyMap<string, CryptoKey>;
}

export interface Ed25519PrivateJwk {
  readonly crv: 'Ed25519';
  readonly kty: 'OKP';
}

export const CredentialKindSchema = Schema.Struct({
  credential: Schema.Literals(['api_key', 'session']),
  password: Schema.Boolean,
});

// End-anchored name matching: identifiers, references and policies are not credentials.
export interface SafeApiKeyMetadata {
  readonly apiKeyId: string;
  readonly passwordPolicy: string;
  readonly providerKeyId: string;
  readonly searchKey: string;
  readonly secretRef: string;
}

export const lookup = (apiKeyId: string, secretName: string): string => `${apiKeyId}:${secretName}`;
