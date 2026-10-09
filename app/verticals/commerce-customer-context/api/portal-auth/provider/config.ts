import { Config, ConfigProvider, Effect, Layer, Option, Redacted, Schema } from 'effect';

import { CommercePortalAuthConfig } from './config-service.ts';
import { HttpUrlSchema, optionalConfigReader, parseHttpUrl } from './config-support.ts';

export { CommercePortalAuthConfig } from './config-service.ts';

/**
 * These values are intentionally separate from Staff's Better Auth environment. A Commerce
 * deployment must be able to rotate its secret, origin and database credentials independently.
 * `COMMERCE_PORTAL_AUTH_SECRETS` uses Better Auth's `version:value` entries in current-key-first
 * order; the singular secret remains the legacy bare-value fallback during that transition.
 */
const EnvironmentKeySchema = Schema.Literals([
  'COMMERCE_PORTAL_AUTH_DATABASE_URL',
  'COMMERCE_PORTAL_AUTH_NODE_ENV',
  'COMMERCE_PORTAL_AUTH_SECRET',
  'COMMERCE_PORTAL_AUTH_SECRETS',
  'COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS',
  'COMMERCE_PORTAL_AUTH_URL',
]);
type EnvironmentKey = typeof EnvironmentKeySchema.Type;
export type CommercePortalAuthEnvironment = Readonly<Partial<Record<EnvironmentKey, string>>>;

export class CommercePortalAuthConfigError extends Schema.TaggedError<CommercePortalAuthConfigError>()(
  'CommercePortalAuthConfigError',
  {
    reason: Schema.String,
  },
) {}

export interface CommercePortalAuthPolicyValue {
  readonly accountCreation: {
    readonly providerCallTimeoutMilliseconds: number;
    readonly requiresActiveAttempt: boolean;
    readonly requiresOwnerInvocation: boolean;
  };
  readonly cookie: {
    readonly domain?: string;
    readonly httpOnly: boolean;
    readonly namePrefix: string;
    readonly path: string;
    readonly sameSite: 'lax';
  };
  readonly csrf: {
    readonly enabled: boolean;
    readonly originCheck: boolean;
  };
  readonly emailVerification: {
    readonly expiresInSeconds: number;
    readonly requiredBeforeSignIn: boolean;
  };
  readonly mfa: {
    readonly challengeMaxAgeSeconds: number;
    readonly maxAttempts: number;
    readonly trustDeviceMaxAgeSeconds: number;
  };
  readonly password: {
    readonly maxLength: number;
    readonly minLength: number;
    readonly resetTokenExpiresInSeconds: number;
    readonly revokeSessionsOnReset: boolean;
  };
  readonly policyVersion: string;
  readonly rateLimit: {
    readonly accountCreation: { readonly max: number; readonly windowSeconds: number };
    readonly default: { readonly max: number; readonly windowSeconds: number };
    readonly mfa: { readonly max: number; readonly windowSeconds: number };
    readonly recovery: { readonly max: number; readonly windowSeconds: number };
    readonly signIn: { readonly max: number; readonly windowSeconds: number };
  };
  readonly secretRotation: {
    readonly routineRefreshRotatesSessionIdentifier: boolean;
    readonly versionedSecretsSupportedByProvider: boolean;
  };
  readonly session: {
    readonly absoluteLifetimeSeconds: number;
    readonly concurrentDevice: {
      readonly maxActiveSessions: number | null;
      readonly overflow: 'reject-new';
    };
    readonly cookieCacheEnabled: boolean;
    readonly expiresInSeconds: number;
    readonly freshAgeSeconds: number;
    readonly identifierRotation: {
      readonly onCredentialChange: boolean;
      readonly onPrivilegeBoundary: boolean;
      readonly onRecovery: boolean;
      readonly onRefresh: boolean;
      readonly onSignIn: boolean;
      readonly onStepUp: boolean;
    };
    readonly inactivityLifetimeSeconds: number;
    readonly providerCallTimeoutMilliseconds: number;
    readonly updateAgeSeconds: number;
  };
}

/** Source-controlled admission/session controls used to build the Better Auth options. */
export const COMMERCE_PORTAL_AUTH_POLICY: CommercePortalAuthPolicyValue = Object.freeze({
  accountCreation: Object.freeze({
    providerCallTimeoutMilliseconds: 5000,
    requiresActiveAttempt: true,
    requiresOwnerInvocation: true,
  }),
  cookie: Object.freeze({
    // A host-only cookie is intentional: no Domain attribute is emitted and the provider realm
    // cannot be shared with sibling subdomains.
    httpOnly: true,
    namePrefix: 'commerce-portal',
    // The provider and protected Commerce routes share this host; a host-only cookie path keeps
    // the realm isolated while allowing the receiver to perform fresh admission on its routes.
    path: '/',
    sameSite: 'lax',
  }),
  csrf: Object.freeze({
    enabled: true,
    originCheck: true,
  }),
  emailVerification: Object.freeze({
    expiresInSeconds: 900,
    requiredBeforeSignIn: true,
  }),
  mfa: Object.freeze({
    challengeMaxAgeSeconds: 600,
    maxAttempts: 5,
    trustDeviceMaxAgeSeconds: 0,
  }),
  password: Object.freeze({
    maxLength: 128,
    minLength: 12,
    resetTokenExpiresInSeconds: 900,
    revokeSessionsOnReset: true,
  }),
  policyVersion: 'commerce-portal-auth-policy.v1',
  rateLimit: Object.freeze({
    accountCreation: Object.freeze({ max: 3, windowSeconds: 3600 }),
    default: Object.freeze({ max: 30, windowSeconds: 60 }),
    mfa: Object.freeze({ max: 5, windowSeconds: 300 }),
    recovery: Object.freeze({ max: 3, windowSeconds: 3600 }),
    signIn: Object.freeze({ max: 5, windowSeconds: 60 }),
  }),
  secretRotation: Object.freeze({
    routineRefreshRotatesSessionIdentifier: false,
    versionedSecretsSupportedByProvider: true,
  }),
  session: Object.freeze({
    absoluteLifetimeSeconds: 86_400,
    cookieCacheEnabled: false,
    identifierRotation: Object.freeze({
      onCredentialChange: true,
      onPrivilegeBoundary: true,
      onRecovery: true,
      onRefresh: false,
      onSignIn: true,
      onStepUp: true,
    }),
    // Better Auth's expiry is the inactivity window; the absolute bound is checked by the
    // authoritative verifier and must not be inferred from this provider setting.
    inactivityLifetimeSeconds: 28_800,
    // Five active sessions per account is the Commerce Portal v1 device policy. New sign-ins are
    // rejected at the cap; existing sessions are never silently evicted. The session lifecycle
    // enforces this value before provider session creation and repeats it in the provider hook so
    // a Better Auth default cannot widen the policy.
    concurrentDevice: Object.freeze({
      maxActiveSessions: 5,
      overflow: 'reject-new',
    }),
    expiresInSeconds: 28_800,
    freshAgeSeconds: 900,
    // A timed-out sign-in is indeterminate; callers must reconcile before any deliberate retry,
    // and the session adapter never replays the provider effect automatically.
    providerCallTimeoutMilliseconds: 5000,
    // Better Auth must emit a fresh signed cookie the moment the audited `/refresh` route asks, not
    // on its own stale updateAge. Every other provider read is taken with refresh disabled, so a
    // zero update age never renews anything on its own.
    updateAgeSeconds: 0,
  }),
});

export interface CommercePortalAuthConfigValue {
  readonly baseUrl: string;
  readonly connectionString: Redacted.Redacted;
  readonly nodeEnvironment: string;
  readonly policy: typeof COMMERCE_PORTAL_AUTH_POLICY;
  readonly secret: Redacted.Redacted;
  readonly secureCookies: boolean;
  readonly trustedOrigins: readonly string[];
  /**
   * The exact peer addresses of the deployment's own reverse proxies. Only when the socket peer is
   * one of these may a forwarded-for hop be believed; an empty list means the socket peer is the
   * only client identity the owner will key a durable budget on.
   */
  readonly trustedProxies: readonly string[];
  readonly versionedSecrets: readonly {
    readonly value: Redacted.Redacted;
    readonly version: number;
  }[];
}

const malformedConfiguration = () =>
  new CommercePortalAuthConfigError({
    reason: 'Commerce portal authentication configuration is missing or malformed',
  });

const PostgreSqlUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'postgres:' || url.protocol === 'postgresql:' ? undefined : 'URL must use the PostgreSQL protocol',
  ),
);

const configSource = Config.all({
  baseUrl: Config.schema(HttpUrlSchema, 'COMMERCE_PORTAL_AUTH_URL'),
  databaseUrl: Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL'),
  nodeEnvironment: Config.String('COMMERCE_PORTAL_AUTH_NODE_ENV').pipe(Config.withDefault('')),
  secret: Config.Redacted('COMMERCE_PORTAL_AUTH_SECRET'),
  trustedOrigins: Config.schema(Schema.Trim, 'COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS').pipe(Config.withDefault('')),
  trustedProxies: Config.schema(Schema.Trim, 'COMMERCE_PORTAL_AUTH_TRUSTED_PROXIES').pipe(Config.withDefault('')),
  versionedSecrets: Config.Redacted('COMMERCE_PORTAL_AUTH_SECRETS').pipe(Config.withDefault(Redacted.make(''))),
});

const parseHttpOrigin = (value: string): Effect.Effect<string, CommercePortalAuthConfigError> =>
  Effect.map(parseHttpUrl(value, malformedConfiguration), (url) => url.origin);

const parseCommercePortalAuthConfigFromProvider = Effect.fn('CommercePortalAuthConfig.parse')(function* parseConfig(
  provider: ConfigProvider.ConfigProvider,
): Effect.fn.Return<CommercePortalAuthConfigValue, CommercePortalAuthConfigError> {
  const source = yield* configSource
    .parse(provider)
    .pipe(Effect.catchTag('ConfigError', () => Effect.fail(malformedConfiguration())));
  const connectionString = Redacted.make(Redacted.value(source.databaseUrl).trim());
  yield* Schema.decodeEffect(PostgreSqlUrlSchema)(Redacted.value(connectionString)).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(malformedConfiguration())),
    Effect.filterOrFail(
      (url) => url.hostname.length > 0 && url.pathname.replace(/^\/+/u, '').length > 0,
      () => malformedConfiguration(),
    ),
  );

  const secretValue = Redacted.value(source.secret).trim();
  if (secretValue.length < 32) {
    return yield* malformedConfiguration();
  }

  const versionedSecrets: { readonly value: Redacted.Redacted; readonly version: number }[] = [];
  const seenSecretVersions = new Set<number>();
  for (const entry of Redacted.value(source.versionedSecrets)
    .split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0)) {
    const separator = entry.indexOf(':');
    const versionText = separator === -1 ? '' : entry.slice(0, separator).trim();
    const value = separator === -1 ? '' : entry.slice(separator + 1).trim();
    const version = Number(versionText);
    if (
      !/^\d+$/u.test(versionText) ||
      !Number.isSafeInteger(version) ||
      value.length < 32 ||
      seenSecretVersions.has(version)
    ) {
      return yield* malformedConfiguration();
    }
    seenSecretVersions.add(version);
    versionedSecrets.push({ value: Redacted.make(value), version });
  }

  const configuredTrustedOrigins = source.trustedOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const baseUrl = source.baseUrl.origin;
  const trustedOrigins = yield* Effect.forEach([...new Set([baseUrl, ...configuredTrustedOrigins])], parseHttpOrigin, {
    concurrency: 1,
  });
  const trustedProxies = [
    ...new Set(
      source.trustedProxies
        .split(',')
        .map((proxy) => proxy.trim())
        .filter((proxy) => proxy.length > 0),
    ),
  ];

  return Object.freeze({
    baseUrl,
    connectionString,
    nodeEnvironment: source.nodeEnvironment,
    policy: COMMERCE_PORTAL_AUTH_POLICY,
    secret: Redacted.make(secretValue),
    secureCookies: source.baseUrl.protocol === 'https:' || source.nodeEnvironment === 'production',
    trustedOrigins,
    trustedProxies: Object.freeze(trustedProxies),
    versionedSecrets: Object.freeze(versionedSecrets),
  });
});

/** Parse only the supplied process environment. This function never reads a dotenv file. */
export const parseCommercePortalAuthConfig = (
  environment: CommercePortalAuthEnvironment,
): Effect.Effect<CommercePortalAuthConfigValue, CommercePortalAuthConfigError> =>
  parseCommercePortalAuthConfigFromProvider(ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }));

/**
 * The three operator-supplied values that admit a host into the Commerce portal realm. The realm is
 * optional, so a deployment that names none of them never opted in and the vertical still serves
 * readiness and every business route.
 */
const parseOptionalCommercePortalAuthConfigFromProvider = optionalConfigReader(
  'CommercePortalAuthConfig.parseOptional',
  ['COMMERCE_PORTAL_AUTH_URL', 'COMMERCE_PORTAL_AUTH_DATABASE_URL', 'COMMERCE_PORTAL_AUTH_SECRET'],
  parseCommercePortalAuthConfigFromProvider,
  malformedConfiguration,
);

/** `Option.none()` only when the supplied environment names no portal-realm value at all. */
export const parseOptionalCommercePortalAuthConfig = (
  environment: CommercePortalAuthEnvironment,
): Effect.Effect<Option.Option<CommercePortalAuthConfigValue>, CommercePortalAuthConfigError> =>
  parseOptionalCommercePortalAuthConfigFromProvider(
    ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }),
  );

/** The availability read that keeps a misconfiguration an error; the portal groups answer for it. */
export const optionalCommercePortalAuthConfig: Effect.Effect<
  Option.Option<CommercePortalAuthConfigValue>,
  CommercePortalAuthConfigError
> = parseOptionalCommercePortalAuthConfigFromProvider(ConfigProvider.fromEnv({ preserveEmptyStrings: true }));

/**
 * The one fail-closed availability read every consumer that must keep serving shares. A realm
 * configuration that names some `COMMERCE_PORTAL_AUTH_*` value but not all of them is a
 * misconfiguration, and `optionalCommercePortalAuthConfig` reports it as one — but a consumer that
 * sits inside the runtime every governed business route is served from must not be taken down by
 * an unreadable realm. Folding the error to "not configured" with one warning is the honest
 * answer: no governed Action may proceed on a claimed owner payload without owner evidence, which
 * is exactly what a deployment whose portal realm cannot be read should get. A consumer that may
 * keep the error — the four portal groups — reads `optionalCommercePortalAuthConfig` instead.
 */
export const portalAuthRealmConfigured: Effect.Effect<boolean> = optionalCommercePortalAuthConfig.pipe(
  Effect.map(Option.isSome),
  Effect.catchTag('CommercePortalAuthConfigError', (failure) =>
    Effect.annotateLogs(
      Effect.logWarning('Commerce portal realm configuration is unreadable; enrollment owner evidence fails closed'),
      { reason: failure.reason },
    ).pipe(Effect.as(false)),
  ),
);

export const CommercePortalAuthConfigLive = Layer.effect(
  CommercePortalAuthConfig,
  parseCommercePortalAuthConfigFromProvider(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
);
