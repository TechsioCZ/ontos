// @effect-diagnostics asyncFunction:off globalDateInEffect:off
/* eslint-disable max-classes-per-file -- The provider adapter and its closed failure vocabulary form one boundary. */
import { apiKey } from '@better-auth/api-key';
import { APIError, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { Clock, Context, Effect, Layer, Schema, Predicate } from 'effect';
import { AuthConfig } from './config.ts';
import type { AuthConfigValue } from './config.ts';
import { AuthDatabase } from './db/client.ts';
import { apikey, authDatabaseSchema } from './db/schema.ts';
import type { AuthDatabaseExecutor } from './db/types.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

export class ApiKeyCredentialInvalidError extends Schema.TaggedError<ApiKeyCredentialInvalidError>()(
  'ApiKeyCredentialInvalidError',
  { code: Schema.Literal('api_key_invalid'), reason: Schema.String },
) {}
export class ApiKeyRateLimitedError extends Schema.TaggedError<ApiKeyRateLimitedError>()(
  'ApiKeyRateLimitedError',
  {
    code: Schema.Literal('api_key_rate_limited'),
    reason: Schema.String,
    retryAfterSeconds: Schema.Finite,
  },
) {}
export class ApiKeyProviderUnavailableError extends Schema.TaggedError<ApiKeyProviderUnavailableError>()(
  'ApiKeyProviderUnavailableError',
  { code: Schema.Literal('api_key_provider_unavailable'), reason: Schema.String },
) {}
export class ApiKeyStateInconsistentError extends Schema.TaggedError<ApiKeyStateInconsistentError>()(
  'ApiKeyStateInconsistentError',
  { code: Schema.Literal('api_key_state_inconsistent'), reason: Schema.String },
) {}
export type ApiKeyProviderError =
  | ApiKeyCredentialInvalidError
  | ApiKeyProviderUnavailableError
  | ApiKeyRateLimitedError
  | ApiKeyStateInconsistentError;

export interface SafeApiKeyMetadata {
  readonly createdAt: string;
  readonly enabled: boolean;
  readonly expiresAt: null | string;
  readonly name: null | string;
  readonly start: null | string;
}
export interface ProviderApiKeyMetadata extends SafeApiKeyMetadata {
  readonly providerKeyId: string;
}
export interface IssuedApiKey extends ProviderApiKeyMetadata {
  readonly secret: string;
}
export interface VerifiedApiKey {
  readonly providerKeyId: string;
}
export interface PendingApiKeyCleanupBatch {
  readonly hasMore: boolean;
  readonly providerKeyIds: readonly string[];
}

export interface ApiKeyServiceContract {
  readonly clearPendingCleanup: (keyId: string) => Effect.Effect<void, ApiKeyProviderError>;
  readonly issue: (
    requestHeaders: Headers,
    input: {
      readonly expiresIn?: number;
      readonly issuerPrincipalId: string;
      readonly lifecycleOperationId: string;
      readonly name?: string;
      readonly prefix?: string;
      readonly tenantId: string;
    },
  ) => Effect.Effect<IssuedApiKey, ApiKeyProviderError>;
  readonly metadata: (keyId: string) => Effect.Effect<ProviderApiKeyMetadata, ApiKeyProviderError>;
  readonly pendingCleanup: (input: {
    readonly issuerPrincipalId: string;
    readonly lifecycleOperationId: string;
    readonly nowEpochMillis?: number;
    readonly tenantId: string;
  }) => Effect.Effect<PendingApiKeyCleanupBatch, ApiKeyProviderError>;
  readonly setEnabled: (
    keyId: string,
    enabled: boolean,
  ) => Effect.Effect<ProviderApiKeyMetadata, ApiKeyProviderError>;
  readonly verify: (rawKey: string) => Effect.Effect<VerifiedApiKey, ApiKeyProviderError>;
}
export class ApiKeyService extends Context.Service<ApiKeyService, ApiKeyServiceContract>()(
  '@app/shell-super-app/api/auth/api-key-service/ApiKeyService',
) {}

const unavailable = () =>
  new ApiKeyProviderUnavailableError({
    code: 'api_key_provider_unavailable',
    reason: 'The credential provider is temporarily unavailable',
  });
const invalid = () =>
  new ApiKeyCredentialInvalidError({
    code: 'api_key_invalid',
    reason: 'The API key is missing or unusable',
  });
const inconsistent = () =>
  new ApiKeyStateInconsistentError({
    code: 'api_key_state_inconsistent',
    reason: 'The API key lifecycle state is inconsistent',
  });
const mapProviderError = <Failure>(error: Failure): ApiKeyProviderError => {
  if (error instanceof APIError && error.statusCode === 429) {
    return new ApiKeyRateLimitedError({
      code: 'api_key_rate_limited',
      reason: 'The API key rate limit was exceeded',
      retryAfterSeconds: 60,
    });
  }
  if (error instanceof APIError && error.statusCode < 500) {
    return invalid();
  }
  return unavailable();
};
const PENDING_BINDING_LEASE_MILLISECONDS = 5 * 60 * 1000;
const PENDING_CLEANUP_BATCH_SIZE = 100;
interface PendingBindingScope {
  readonly issuerPrincipalId: string;
  readonly tenantId: string;
}
interface PendingBindingMarker extends PendingBindingScope {
  readonly lifecycleOperationId: string;
}
const pendingBindingScope = (input: PendingBindingScope) => ({
  issuerPrincipalId: input.issuerPrincipalId,
  ontosLifecycle: 'binding_pending_v1' as const,
  tenantId: input.tenantId,
});
const pendingBindingMarker = (input: PendingBindingMarker) => ({
  ...pendingBindingScope(input),
  lifecycleOperationId: input.lifecycleOperationId,
});
const encodePendingBindingScope = (input: PendingBindingScope): string =>
  JSON.stringify(pendingBindingScope(input));
const decodePendingBindingMarker = (metadata: null | string): PendingBindingMarker | undefined => {
  if (metadata === null) {
    return undefined;
  }
  try {
    const decoded: unknown = JSON.parse(metadata);
    return Predicate.isObjectKeyword(decoded) &&
      decoded !== null &&
      'ontosLifecycle' in decoded &&
      decoded.ontosLifecycle === 'binding_pending_v1' &&
      'lifecycleOperationId' in decoded &&
      Predicate.isString(decoded.lifecycleOperationId) &&
      'issuerPrincipalId' in decoded &&
      Predicate.isString(decoded.issuerPrincipalId) &&
      'tenantId' in decoded &&
      Predicate.isString(decoded.tenantId)
      ? {
          issuerPrincipalId: decoded.issuerPrincipalId,
          lifecycleOperationId: decoded.lifecycleOperationId,
          tenantId: decoded.tenantId,
        }
      : undefined;
  } catch {
    return undefined;
  }
};
export const classifyPendingApiKeyCleanup = (
  records: readonly {
    readonly createdAt: Date;
    readonly metadata: null | string;
    readonly providerKeyId: string;
  }[],
  input: {
    readonly issuerPrincipalId: string;
    readonly lifecycleOperationId: string;
    readonly nowEpochMillis: number;
    readonly tenantId: string;
  },
): readonly string[] => {
  const staleBefore = input.nowEpochMillis - PENDING_BINDING_LEASE_MILLISECONDS;
  return records.flatMap((record) => {
    const marker = decodePendingBindingMarker(record.metadata);
    return marker !== undefined &&
      marker.issuerPrincipalId === input.issuerPrincipalId &&
      marker.tenantId === input.tenantId &&
      record.createdAt.getTime() <= staleBefore
      ? [record.providerKeyId]
      : [];
  });
};
const toSafe = (value: {
  readonly createdAt: Date;
  readonly enabled: boolean | null;
  readonly expiresAt: Date | null;
  readonly id: string;
  readonly name: string | null;
  readonly start: string | null;
}): ProviderApiKeyMetadata => ({
  createdAt: value.createdAt.toISOString(),
  enabled: value.enabled === true,
  expiresAt: value.expiresAt?.toISOString() ?? null,
  name: value.name,
  providerKeyId: value.id,
  start: value.start,
});

export const makeApiKeyService = (
  configuration: AuthConfigValue,
  database: AuthDatabaseExecutor,
): ApiKeyServiceContract => {
  const auth = betterAuth({
    baseURL: configuration.baseUrl,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: authDatabaseSchema,
      transaction: true,
    }),
    logger: { disabled: true },
    plugins: [apiKey({ enableMetadata: true, enableSessionForAPIKeys: false, references: 'user' })],
    secret: configuration.secret,
    trustedOrigins: [...configuration.trustedOrigins],
  });
  const metadata = (keyId: string) =>
    Effect.tryPromise({
      catch: unavailable,
      try: () =>
        database
          .select({
            createdAt: apikey.createdAt,
            enabled: apikey.enabled,
            expiresAt: apikey.expiresAt,
            id: apikey.id,
            name: apikey.name,
            start: apikey.start,
          })
          .from(apikey)
          .where(eq(apikey.id, keyId))
          .limit(1),
    }).pipe(
      Effect.flatMap(([record]) =>
        record === undefined ? Effect.fail(inconsistent()) : Effect.succeed(toSafe(record)),
      ),
    );
  const service: ApiKeyServiceContract = {
    clearPendingCleanup: (keyId) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () =>
          database
            .update(apikey)
            .set({ metadata: null, updatedAt: new Date() })
            .where(eq(apikey.id, keyId)),
      }).pipe(Effect.asVoid),
    issue: (requestHeaders, input) =>
      Effect.tryPromise({
        catch: mapProviderError,
        try: async () =>
          await auth.api.createApiKey({
            body: withOptionalProperty(
              withOptionalProperty(
                {
                  expiresIn: input.expiresIn ?? null,
                },
                input.name !== undefined,
                'name',
                input.name,
                {},
              ),
              input.prefix !== undefined,
              'prefix',
              input.prefix,
              {
                metadata: pendingBindingMarker(input),
                remaining: null,
              },
            ),
            headers: requestHeaders,
          }),
      }).pipe(Effect.map((created) => ({ ...toSafe(created), secret: created.key }))),
    metadata,
    pendingCleanup: (input) =>
      Effect.gen(function* pendingApiKeyCleanup() {
        const nowEpochMillis = input.nowEpochMillis ?? (yield* Clock.currentTimeMillis);
        const staleBefore = new Date(nowEpochMillis - PENDING_BINDING_LEASE_MILLISECONDS);
        const records = yield* Effect.tryPromise({
          catch: unavailable,
          try: () =>
            database
              .select({
                createdAt: apikey.createdAt,
                metadata: apikey.metadata,
                providerKeyId: apikey.id,
              })
              .from(apikey)
              .where(
                and(
                  lte(apikey.createdAt, staleBefore),
                  // Better Auth stores metadata as text, so Drizzle's typed predicates cannot
                  // express this order-insensitive JSON containment check without a JSONB cast.
                  sql`${apikey.metadata}::jsonb @> ${encodePendingBindingScope(input)}::jsonb`,
                ),
              )
              .orderBy(asc(apikey.createdAt), asc(apikey.id))
              .limit(PENDING_CLEANUP_BATCH_SIZE + 1),
        });
        const providerKeyIds = classifyPendingApiKeyCleanup(
          records.slice(0, PENDING_CLEANUP_BATCH_SIZE),
          {
            issuerPrincipalId: input.issuerPrincipalId,
            lifecycleOperationId: input.lifecycleOperationId,
            nowEpochMillis,
            tenantId: input.tenantId,
          },
        );
        return {
          hasMore: records.length > PENDING_CLEANUP_BATCH_SIZE,
          providerKeyIds,
        };
      }),
    setEnabled: (keyId, enabled) =>
      Effect.tryPromise({
        catch: unavailable,
        try: async () => {
          const [updated] = await database
            .update(apikey)
            .set({ enabled, updatedAt: new Date() })
            .where(eq(apikey.id, keyId))
            .returning({
              createdAt: apikey.createdAt,
              enabled: apikey.enabled,
              expiresAt: apikey.expiresAt,
              id: apikey.id,
              name: apikey.name,
              start: apikey.start,
            });
          if (updated === undefined) {
            throw new Error('missing key');
          }
          return toSafe(updated);
        },
      }),
    verify: (rawKey) =>
      Effect.tryPromise({
        catch: mapProviderError,
        try: async () => await auth.api.verifyApiKey({ body: { key: rawKey } }),
      }).pipe(
        Effect.flatMap((result): Effect.Effect<VerifiedApiKey, ApiKeyProviderError> => {
          if (result.valid && result.key !== null) {
            return Effect.succeed({ providerKeyId: result.key.id });
          }
          if (result.error?.code.includes('RATE') === true) {
            return Effect.fail(
              new ApiKeyRateLimitedError({
                code: 'api_key_rate_limited',
                reason: 'The API key rate limit was exceeded',
                retryAfterSeconds: 60,
              }),
            );
          }
          return Effect.fail(invalid());
        }),
      ),
  };
  return Object.freeze(service);
};

export const ApiKeyServiceLive = Layer.effect(
  ApiKeyService,
  Effect.gen(function* apiKeyServiceLive() {
    const configuration = yield* AuthConfig;
    const database = yield* AuthDatabase;
    return makeApiKeyService(configuration, database.executor);
  }),
);
