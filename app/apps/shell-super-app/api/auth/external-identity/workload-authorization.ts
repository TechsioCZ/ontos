import { PrincipalResolver, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Context, Effect, Layer, Predicate, Redacted, Schema } from 'effect';

import { ApiKeyService } from '../api-key-service.ts';
import { ExternalIdentityHttpConfigurationSchema, ExternalIdentityHttpConfigurationService } from './configuration.ts';
import type {
  ExternalIdentityHttpConfiguration,
  ExternalIdentityWorkloadGrant,
  ExternalIdentityWorkloadOperation,
} from './configuration.ts';

const ExternalIdentityWorkloadAuthenticationErrorSchema = Schema.TaggedStruct(
  'ExternalIdentityWorkloadAuthenticationError',
  { reason: Schema.String },
);
export type ExternalIdentityWorkloadAuthenticationError = typeof ExternalIdentityWorkloadAuthenticationErrorSchema.Type;
const ExternalIdentityWorkloadForbiddenErrorSchema = Schema.TaggedStruct('ExternalIdentityWorkloadForbiddenError', {
  reason: Schema.String,
});
export type ExternalIdentityWorkloadForbiddenError = typeof ExternalIdentityWorkloadForbiddenErrorSchema.Type;
const ExternalIdentityWorkloadUnavailableErrorSchema = Schema.TaggedStruct('ExternalIdentityWorkloadUnavailableError', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
});
export type ExternalIdentityWorkloadUnavailableError = typeof ExternalIdentityWorkloadUnavailableErrorSchema.Type;
const ExternalIdentityWorkloadRateLimitedErrorSchema = Schema.TaggedStruct('ExternalIdentityWorkloadRateLimitedError', {
  reason: Schema.String,
  retryAfterSeconds: Schema.Finite,
});
export type ExternalIdentityWorkloadRateLimitedError = typeof ExternalIdentityWorkloadRateLimitedErrorSchema.Type;

export interface ExternalIdentityWorkloadAuthorizationInput {
  readonly apiKey: Redacted.Redacted<string | undefined>;
  readonly operation: ExternalIdentityWorkloadOperation;
  readonly targetAudience?: string;
  readonly targetAuthenticationNamespaceId?: string;
}

export type ExternalIdentityWorkloadGrantInput = Omit<ExternalIdentityWorkloadAuthorizationInput, 'apiKey'>;
export type ExternalIdentityWorkloadAuthorizationError =
  | ExternalIdentityWorkloadAuthenticationError
  | ExternalIdentityWorkloadForbiddenError
  | ExternalIdentityWorkloadRateLimitedError
  | ExternalIdentityWorkloadUnavailableError;

export interface ExternalIdentityWorkloadAuthorizationService {
  readonly authenticate: (
    apiKey: Redacted.Redacted<string | undefined>,
  ) => Effect.Effect<
    TrustedPrincipalContext,
    ExternalIdentityWorkloadAuthorizationError,
    ApiKeyService | PrincipalResolver
  >;
  readonly authorize: (
    input: ExternalIdentityWorkloadAuthorizationInput,
  ) => Effect.Effect<
    TrustedPrincipalContext,
    ExternalIdentityWorkloadAuthorizationError,
    ExternalIdentityHttpConfigurationService | ApiKeyService | PrincipalResolver
  >;
  readonly authorizePrincipal: (
    principal: TrustedPrincipalContext,
    input: ExternalIdentityWorkloadGrantInput,
  ) => Effect.Effect<
    TrustedPrincipalContext,
    ExternalIdentityWorkloadAuthorizationError,
    ExternalIdentityHttpConfigurationService
  >;
}

export class ExternalIdentityWorkloadAuthorization extends Context.Service<
  ExternalIdentityWorkloadAuthorization,
  ExternalIdentityWorkloadAuthorizationService
>()('@app/shell-super-app/api/auth/external-identity/workload-authorization/ExternalIdentityWorkloadAuthorization') {}

const workloadAuthenticationError = (reason: string): ExternalIdentityWorkloadAuthenticationError =>
  ExternalIdentityWorkloadAuthenticationErrorSchema.make({ reason });
const workloadForbiddenError = (reason: string): ExternalIdentityWorkloadForbiddenError =>
  ExternalIdentityWorkloadForbiddenErrorSchema.make({ reason });
const workloadUnavailableError = (reason: string, cause?: unknown): ExternalIdentityWorkloadUnavailableError =>
  cause === undefined
    ? ExternalIdentityWorkloadUnavailableErrorSchema.make({ reason })
    : ExternalIdentityWorkloadUnavailableErrorSchema.make({ cause, reason });
const workloadRateLimitedError = (retryAfterSeconds: number): ExternalIdentityWorkloadRateLimitedError =>
  ExternalIdentityWorkloadRateLimitedErrorSchema.make({
    reason: 'The workload API key rate limit was exceeded',
    retryAfterSeconds,
  });
const workloadApiKeyUnusableReason = 'The workload API key is not usable';

const configurationDecodeError = (error: Schema.SchemaError): ExternalIdentityWorkloadUnavailableError =>
  workloadUnavailableError('External identity workload configuration is unavailable', error);

const decodeHttpConfiguration = (
  configuration: ExternalIdentityHttpConfiguration,
): Effect.Effect<ExternalIdentityHttpConfiguration, ExternalIdentityWorkloadUnavailableError> =>
  Schema.decodeEffect(ExternalIdentityHttpConfigurationSchema)(configuration).pipe(
    Effect.mapError(configurationDecodeError),
  );

const matchesWorkloadGrant = (
  principal: TrustedPrincipalContext,
  input: ExternalIdentityWorkloadGrantInput,
  configuration: ExternalIdentityHttpConfiguration,
  grant: ExternalIdentityWorkloadGrant,
): boolean =>
  principal.authMethod === 'api_key' &&
  principal.impersonatedByPrincipalId === undefined &&
  principal.authenticationNamespaceId === grant.workloadAuthenticationNamespaceId &&
  principal.principalId === grant.workloadPrincipalId &&
  principal.tenantId === grant.tenantId &&
  grant.operation === input.operation &&
  grant.receivingAudience === configuration.providerEndpointAudience &&
  grant.targetAudience === input.targetAudience &&
  grant.targetAuthenticationNamespaceId === input.targetAuthenticationNamespaceId;

const authenticateWorkload = Effect.fn('ExternalIdentityWorkloadAuthorization.authenticate')(
  function* authenticateWorkload(
    apiKey: Redacted.Redacted<string | undefined>,
  ): Effect.fn.Return<
    TrustedPrincipalContext,
    ExternalIdentityWorkloadAuthorizationError,
    ApiKeyService | PrincipalResolver
  > {
    const rawKey = Redacted.value(apiKey);
    if (rawKey === undefined || rawKey.trim().length === 0) {
      return yield* Effect.fail(workloadAuthenticationError('A workload API key is required'));
    }
    const keys = yield* ApiKeyService;
    const verified = yield* keys.verify(rawKey).pipe(
      Effect.mapError((error) => {
        if (Predicate.isTagged(error, 'ApiKeyCredentialInvalidError')) {
          return workloadAuthenticationError('The workload API key is invalid');
        }
        if (Predicate.isTagged(error, 'ApiKeyRateLimitedError')) {
          return workloadRateLimitedError(error.retryAfterSeconds);
        }
        return workloadUnavailableError('API-key verification is unavailable', error);
      }),
    );
    const resolver = yield* PrincipalResolver;
    const identity = yield* resolver.resolveBetterAuthApiKey(verified.providerKeyId).pipe(
      Effect.mapError((error) => {
        if (
          Predicate.isTagged(error, 'PrincipalBindingAmbiguousError') ||
          Predicate.isTagged(error, 'PrincipalBindingInactiveError') ||
          Predicate.isTagged(error, 'PrincipalBindingMissingError')
        ) {
          return workloadAuthenticationError(workloadApiKeyUnusableReason);
        }
        if (Predicate.isTagged(error, 'PrincipalInactiveError')) {
          return workloadForbiddenError('The workload principal is inactive');
        }
        if (Predicate.isTagged(error, 'TenantInactiveError')) {
          return workloadForbiddenError('The workload tenant is inactive');
        }
        return workloadUnavailableError('Principal resolution is unavailable', error);
      }),
    );
    return yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: identity.authBindingId,
      authContextRef: `better-auth-api-key:${verified.providerKeyId}`,
      authenticationNamespaceId: resolver.authenticationNamespaceId,
      authMethod: 'api_key',
      principalId: identity.principalId,
      tenantId: identity.tenantId,
    }).pipe(
      Effect.mapError((error) => workloadUnavailableError('The workload principal context is unavailable', error)),
    );
  },
);

const authorizeWorkloadPrincipal = Effect.fn('ExternalIdentityWorkloadAuthorization.authorizePrincipal')(
  function* authorizeWorkloadPrincipal(
    principal: TrustedPrincipalContext,
    input: ExternalIdentityWorkloadGrantInput,
  ): Effect.fn.Return<
    TrustedPrincipalContext,
    ExternalIdentityWorkloadAuthorizationError,
    ExternalIdentityHttpConfigurationService
  > {
    const configuration = yield* ExternalIdentityHttpConfigurationService.pipe(Effect.flatMap(decodeHttpConfiguration));
    if (!configuration.grants.some((grant) => matchesWorkloadGrant(principal, input, configuration, grant))) {
      return yield* Effect.fail(
        workloadForbiddenError('The workload is not granted for this external identity operation'),
      );
    }
    return principal;
  },
);

const authorizeWorkload = Effect.fn('ExternalIdentityWorkloadAuthorization.authorize')(function* authorizeWorkload(
  input: ExternalIdentityWorkloadAuthorizationInput,
): Effect.fn.Return<
  TrustedPrincipalContext,
  ExternalIdentityWorkloadAuthorizationError,
  ExternalIdentityHttpConfigurationService | ApiKeyService | PrincipalResolver
> {
  const principal = yield* authenticateWorkload(input.apiKey);
  return yield* authorizeWorkloadPrincipal(principal, input);
});

export const externalIdentityWorkloadAuthorizationLive = Layer.succeed(ExternalIdentityWorkloadAuthorization, {
  authenticate: authenticateWorkload,
  authorize: authorizeWorkload,
  authorizePrincipal: authorizeWorkloadPrincipal,
});
