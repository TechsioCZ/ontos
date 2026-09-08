import { isAPIError } from 'better-auth/api';
import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import {
  Brand,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from 'effect';
import { AuthConfig } from './config.ts';
import { AuthDatabase } from './db/client.ts';
import { apikey } from './db/schema.ts';

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

const apiKeyCredentialInvalidFields = {
  code: Schema.Literal('api_key_invalid'),
  reason: Schema.String,
};
const ApiKeyCredentialInvalidErrorSchema = Schema.TaggedStruct(
  'ApiKeyCredentialInvalidError',
  apiKeyCredentialInvalidFields,
);
const ApiKeyCredentialInvalidError = Schema.TaggedError<
  Schema.Schema.Type<typeof ApiKeyCredentialInvalidErrorSchema>
>()('ApiKeyCredentialInvalidError', apiKeyCredentialInvalidFields);
const apiKeyRateLimitedFields = {
  code: Schema.Literal('api_key_rate_limited'),
  reason: Schema.String,
  retryAfterSeconds: Schema.Finite,
};
const ApiKeyRateLimitedErrorSchema = Schema.TaggedStruct(
  'ApiKeyRateLimitedError',
  apiKeyRateLimitedFields,
);
const ApiKeyRateLimitedError = Schema.TaggedError<
  Schema.Schema.Type<typeof ApiKeyRateLimitedErrorSchema>
>()('ApiKeyRateLimitedError', apiKeyRateLimitedFields);
const apiKeyProviderUnavailableFields = {
  code: Schema.Literal('api_key_provider_unavailable'),
  failureCause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
};
const ApiKeyProviderUnavailableErrorSchema = Schema.TaggedStruct(
  'ApiKeyProviderUnavailableError',
  apiKeyProviderUnavailableFields,
);
export const ApiKeyProviderUnavailableError = Schema.TaggedError<
  Schema.Schema.Type<typeof ApiKeyProviderUnavailableErrorSchema>
>()('ApiKeyProviderUnavailableError', apiKeyProviderUnavailableFields);
const apiKeyStateInconsistentFields = {
  code: Schema.Literal('api_key_state_inconsistent'),
  reason: Schema.String,
};
const ApiKeyStateInconsistentErrorSchema = Schema.TaggedStruct(
  'ApiKeyStateInconsistentError',
  apiKeyStateInconsistentFields,
);
export const ApiKeyStateInconsistentError = Schema.TaggedError<
  Schema.Schema.Type<typeof ApiKeyStateInconsistentErrorSchema>
>()('ApiKeyStateInconsistentError', apiKeyStateInconsistentFields);
export type ApiKeyProviderError =
  | Schema.Schema.Type<typeof ApiKeyCredentialInvalidErrorSchema>
  | Schema.Schema.Type<typeof ApiKeyProviderUnavailableErrorSchema>
  | Schema.Schema.Type<typeof ApiKeyRateLimitedErrorSchema>
  | Schema.Schema.Type<typeof ApiKeyStateInconsistentErrorSchema>;

const ApiKeyTimestampSchema = Schema.DateTimeUtcFromString;
type ApiKeyTimestamp = Schema.Codec.Encoded<typeof ApiKeyTimestampSchema>;
export interface SafeApiKeyMetadata {
  readonly createdAt: ApiKeyTimestamp;
  readonly enabled: boolean;
  readonly expiresAt: ApiKeyTimestamp | null;
  readonly name: null | string;
  readonly start: null | string;
}
export interface ProviderApiKeyMetadata extends SafeApiKeyMetadata {
  readonly providerKeyId: string;
}
export interface IssuedApiKey extends ProviderApiKeyMetadata {
  readonly secret: Redacted.Redacted;
}
export interface VerifiedApiKey {
  readonly providerKeyId: string;
}
interface PendingApiKeyCleanupBatch {
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

const unavailable = (cause: unknown) =>
  new ApiKeyProviderUnavailableError({
    code: 'api_key_provider_unavailable',
    failureCause: cause,
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
  if (isAPIError(error) && error.statusCode === 429) {
    return new ApiKeyRateLimitedError({
      code: 'api_key_rate_limited',
      reason: 'The API key rate limit was exceeded',
      retryAfterSeconds: 60,
    });
  }
  if (isAPIError(error) && error.statusCode < 500) {
    return invalid();
  }
  return unavailable(error);
};
const API_KEY_EXTERNAL_IO_TIMEOUT = Duration.seconds(10);
const PENDING_BINDING_LEASE = Duration.minutes(5);
const PENDING_CLEANUP_BATCH_SIZE = 100;
const IssuerPrincipalIdSchema = Schema.String.pipe(Schema.brand('ApiKeyIssuerPrincipalId'));
const TenantIdSchema = Schema.String.pipe(Schema.brand('ApiKeyTenantId'));
const LifecycleOperationIdSchema = Schema.String.pipe(Schema.brand('ApiKeyLifecycleOperationId'));
const PendingBindingScopeSchema = Schema.Struct({
  issuerPrincipalId: IssuerPrincipalIdSchema,
  ontosLifecycle: Schema.Literal('binding_pending_v1'),
  tenantId: TenantIdSchema,
});
const PendingBindingMarkerSchema = Schema.Struct({
  ...PendingBindingScopeSchema.fields,
  lifecycleOperationId: LifecycleOperationIdSchema,
});
const PendingBindingScopeJson = Schema.fromJsonString(PendingBindingScopeSchema);
const PendingBindingMarkerJson = Schema.fromJsonString(PendingBindingMarkerSchema);
const makeIssuerPrincipalId = Brand.nominal<Schema.Schema.Type<typeof IssuerPrincipalIdSchema>>();
const makeTenantId = Brand.nominal<Schema.Schema.Type<typeof TenantIdSchema>>();
const makeLifecycleOperationId =
  Brand.nominal<Schema.Schema.Type<typeof LifecycleOperationIdSchema>>();
interface PendingBindingScope {
  readonly issuerPrincipalId: string;
  readonly tenantId: string;
}
interface PendingBindingMarker extends PendingBindingScope {
  readonly lifecycleOperationId: string;
}
const pendingBindingScope = (
  input: PendingBindingScope,
): Schema.Schema.Type<typeof PendingBindingScopeSchema> => ({
  issuerPrincipalId: makeIssuerPrincipalId(input.issuerPrincipalId),
  ontosLifecycle: 'binding_pending_v1',
  tenantId: makeTenantId(input.tenantId),
});
const pendingBindingMarker = (
  input: PendingBindingMarker,
): Schema.Schema.Type<typeof PendingBindingMarkerSchema> => ({
  ...pendingBindingScope(input),
  lifecycleOperationId: makeLifecycleOperationId(input.lifecycleOperationId),
});
const decodePendingBindingMarker = (
  metadata: null | string,
): Schema.Schema.Type<typeof PendingBindingMarkerSchema> | undefined => {
  if (metadata === null) {
    return undefined;
  }
  return Option.getOrUndefined(Schema.decodeUnknownOption(PendingBindingMarkerJson)(metadata));
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
  const staleBefore = input.nowEpochMillis - Duration.toMillis(PENDING_BINDING_LEASE);
  return records.flatMap((record) => {
    const marker = decodePendingBindingMarker(record.metadata);
    return marker !== undefined &&
      marker.issuerPrincipalId === input.issuerPrincipalId &&
      marker.tenantId === input.tenantId &&
      DateTime.toEpochMillis(DateTime.makeUnsafe(record.createdAt)) <= staleBefore
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
  createdAt: DateTime.formatIso(DateTime.makeUnsafe(value.createdAt)),
  enabled: value.enabled === true,
  expiresAt:
    value.expiresAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(value.expiresAt)),
  name: value.name,
  providerKeyId: value.id,
  start: value.start,
});

const apiKeyExternalTimeout = Effect.timeoutOrElse({
  duration: API_KEY_EXTERNAL_IO_TIMEOUT,
  orElse: () => Effect.fail(unavailable('The API key provider operation timed out')),
});

export const makeApiKeyService = Effect.fn('ApiKeyService.make')(function* makeService() {
  const configuration = yield* AuthConfig;
  const { adapter: databaseAdapter, executor: database } = yield* AuthDatabase;
  const auth = betterAuth({
    baseURL: configuration.baseUrl,
    database: databaseAdapter,
    logger: { disabled: true },
    plugins: [apiKey({ enableMetadata: true, enableSessionForAPIKeys: false, references: 'user' })],
    secret: configuration.secret,
    trustedOrigins: [...configuration.trustedOrigins],
  });
  const metadata = (keyId: string) =>
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
      .limit(1)
      .pipe(
        Effect.mapError(unavailable),
        apiKeyExternalTimeout,
        Effect.flatMap(([record]) =>
          record === undefined ? Effect.fail(inconsistent()) : Effect.succeed(toSafe(record)),
        ),
      );
  const service: ApiKeyServiceContract = {
    clearPendingCleanup: (keyId) =>
      DateTime.nowAsDate.pipe(
        Effect.flatMap((updatedAt) =>
          database
            .update(apikey)
            .set({ metadata: null, updatedAt })
            .where(eq(apikey.id, keyId))
            .pipe(Effect.mapError(unavailable), apiKeyExternalTimeout),
        ),
        Effect.asVoid,
      ),
    issue: (requestHeaders, input) =>
      Effect.tryPromise({
        catch: mapProviderError,
        try: auth.api.createApiKey.bind(auth.api, {
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
      }).pipe(
        apiKeyExternalTimeout,
        Effect.map((created) => ({ ...toSafe(created), secret: Redacted.make(created.key) })),
      ),
    metadata,
    pendingCleanup: Effect.fn('ApiKeyService.pendingCleanup')(function* pendingCleanup(input) {
      const nowEpochMillis = input.nowEpochMillis ?? (yield* Clock.currentTimeMillis);
      const staleBefore = DateTime.makeUnsafe(nowEpochMillis).pipe(
        DateTime.subtractDuration(PENDING_BINDING_LEASE),
        DateTime.toDateUtc,
      );
      const encodedScope = yield* Schema.encodeEffect(PendingBindingScopeJson)(
        pendingBindingScope(input),
      ).pipe(Effect.mapError(unavailable));
      const records = yield* database
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
            sql`${apikey.metadata}::jsonb @> ${encodedScope}::jsonb`,
          ),
        )
        .orderBy(asc(apikey.createdAt), asc(apikey.id))
        .limit(PENDING_CLEANUP_BATCH_SIZE + 1)
        .pipe(Effect.mapError(unavailable), apiKeyExternalTimeout);
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
      DateTime.nowAsDate.pipe(
        Effect.flatMap((updatedAt) =>
          database
            .update(apikey)
            .set({ enabled, updatedAt })
            .where(eq(apikey.id, keyId))
            .returning({
              createdAt: apikey.createdAt,
              enabled: apikey.enabled,
              expiresAt: apikey.expiresAt,
              id: apikey.id,
              name: apikey.name,
              start: apikey.start,
            })
            .pipe(Effect.mapError(unavailable), apiKeyExternalTimeout),
        ),
        Effect.flatMap(([updated]) =>
          updated === undefined
            ? Effect.fail(unavailable('The API key record is missing'))
            : Effect.succeed(toSafe(updated)),
        ),
      ),
    verify: (rawKey) =>
      Effect.tryPromise({
        catch: mapProviderError,
        try: auth.api.verifyApiKey.bind(auth.api, { body: { key: rawKey } }),
      }).pipe(
        apiKeyExternalTimeout,
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
});

export const ApiKeyServiceLive = Layer.effect(ApiKeyService, makeApiKeyService());
