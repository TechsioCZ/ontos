// @effect-diagnostics asyncFunction:off globalDateInEffect:off
/* eslint-disable max-classes-per-file, no-shadow, promise/prefer-await-to-then -- Shell orchestration and Effect recovery remain one typed boundary. */
import type {
  ActionCoreError,
  ActionRuntimeService,
  PrincipalManagementError,
  PrincipalResolutionError,
  PrincipalResolverService,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import {
  ActionRuntime,
  bindManagedApiKeyAction,
  bindSelfApiKeyAction,
  changePrincipalStatusAction,
  createNonHumanPrincipalAction,
  IdentityLifecycleConflictError,
  PrincipalResolver,
  setManagedApiKeyBindingStatusAction,
  setSelfApiKeyBindingStatusAction,
} from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';
import { ApiKeyService } from './api-key-service.ts';
import type {
  ApiKeyProviderError,
  ApiKeyServiceContract,
  IssuedApiKey,
  SafeApiKeyMetadata,
} from './api-key-service.ts';

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

export class IdentityLifecycleOperationError extends Schema.TaggedError<IdentityLifecycleOperationError>()(
  'IdentityLifecycleOperationError',
  { code: Schema.Literal('identity_lifecycle_operation_failed'), reason: Schema.String },
) {}
export type IdentityLifecycleError =
  | ActionCoreError
  | ApiKeyProviderError
  | IdentityLifecycleOperationError
  | PrincipalManagementError
  | PrincipalResolutionError;
export interface ApiKeyLifecycleResult extends SafeApiKeyMetadata {
  readonly authBindingId: string;
  readonly cleanupPending: boolean;
}
export interface ApiKeyIssueResult extends ApiKeyLifecycleResult {
  readonly secret: string;
}

const lifecycleFailure = () =>
  new IdentityLifecycleOperationError({
    code: 'identity_lifecycle_operation_failed',
    reason: 'The identity lifecycle operation could not be completed',
  });
const transport = (correlationId: string, idempotencyKey: string) => ({
  correlationId,
  idempotencyKey,
});
const publicMetadata = ({
  providerKeyId: _providerKeyId,
  ...metadata
}: SafeApiKeyMetadata & { readonly providerKeyId: string }): SafeApiKeyMetadata => metadata;

export const makeIdentityLifecycleService = (
  actionRuntime: ActionRuntimeService,
  keys: ApiKeyServiceContract,
  resolver: PrincipalResolverService,
) => {
  const reconcileProviderKey = (
    providerKeyId: string,
  ): Effect.Effect<void, IdentityLifecycleError> =>
    resolver.resolveBetterAuthApiKey(providerKeyId).pipe(
      Effect.match({
        onFailure: (error) =>
          error._tag === 'PrincipalResolverUnavailableError'
            ? ('unavailable' as const)
            : ('orphan' as const),
        onSuccess: () => 'bound' as const,
      }),
      Effect.flatMap((classification): Effect.Effect<void, IdentityLifecycleError> => {
        if (classification === 'unavailable') {
          return Effect.fail(lifecycleFailure());
        }
        if (classification === 'bound') {
          return keys.clearPendingCleanup(providerKeyId);
        }
        return keys
          .setEnabled(providerKeyId, false)
          .pipe(Effect.flatMap(() => keys.clearPendingCleanup(providerKeyId)));
      }),
    );
  const reconcileProviderKeys = (
    providerKeyIds: readonly string[],
  ): Effect.Effect<void, IdentityLifecycleError> =>
    Effect.gen(function* reconcileProviderKeySequence() {
      for (const providerKeyId of providerKeyIds) {
        yield* reconcileProviderKey(providerKeyId);
      }
    });
  const reconcilePendingCleanup = (input: {
    readonly lifecycleOperationId: string;
    readonly principal: TrustedPrincipalContext;
  }): Effect.Effect<void, IdentityLifecycleError> =>
    keys
      .pendingCleanup({
        issuerPrincipalId: input.principal.principalId,
        lifecycleOperationId: input.lifecycleOperationId,
        tenantId: input.principal.tenantId,
      })
      .pipe(
        Effect.flatMap((batch) =>
          reconcileProviderKeys(batch.providerKeyIds).pipe(
            Effect.flatMap(() => (batch.hasMore ? Effect.fail(lifecycleFailure()) : Effect.void)),
          ),
        ),
        Effect.mapError(() => lifecycleFailure()),
      );
  const bindIssued = (input: {
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly issued: IssuedApiKey;
    readonly managedPrincipalId?: string;
    readonly principal: TrustedPrincipalContext;
  }): Effect.Effect<ApiKeyIssueResult, IdentityLifecycleError> => {
    const bindingEffect =
      input.managedPrincipalId === undefined
        ? actionRuntime.runAction({
            payload: { providerSubjectId: input.issued.providerKeyId },
            principal: input.principal,
            registration: bindSelfApiKeyAction,
            transport: transport(input.correlationId, input.idempotencyKey),
          })
        : actionRuntime.runAction({
            payload: {
              principalId: input.managedPrincipalId,
              providerSubjectId: input.issued.providerKeyId,
            },
            principal: input.principal,
            registration: bindManagedApiKeyAction,
            transport: transport(input.correlationId, input.idempotencyKey),
          });
    return bindingEffect.pipe(
      Effect.flatMap((binding) =>
        keys.clearPendingCleanup(input.issued.providerKeyId).pipe(
          Effect.as({
            ...publicMetadata(input.issued),
            authBindingId: binding.authBindingId,
            cleanupPending: false,
            secret: input.issued.secret,
          }),
          Effect.orElseSucceed(() => ({
            ...publicMetadata(input.issued),
            authBindingId: binding.authBindingId,
            cleanupPending: true,
            secret: input.issued.secret,
          })),
        ),
      ),
      Effect.catch((bindingError) =>
        keys.setEnabled(input.issued.providerKeyId, false).pipe(
          Effect.flatMap(() => keys.clearPendingCleanup(input.issued.providerKeyId)),
          Effect.ignore,
          Effect.andThen(Effect.fail(bindingError)),
        ),
      ),
    );
  };
  const issue = (input: {
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly managedPrincipalId?: string;
    readonly name?: string;
    readonly principal: TrustedPrincipalContext;
    readonly requestHeaders: Headers;
  }) =>
    reconcilePendingCleanup({
      lifecycleOperationId: input.idempotencyKey,
      principal: input.principal,
    }).pipe(
      Effect.flatMap(() =>
        keys.issue(
          input.requestHeaders,
          withOptionalProperty(
            {
              issuerPrincipalId: input.principal.principalId,
              lifecycleOperationId: input.idempotencyKey,
              tenantId: input.principal.tenantId,
            },
            !(input.name === undefined),
            'name',
            input.name,
            {},
          ),
        ),
      ),
      Effect.flatMap((issued) =>
        bindIssued(
          withOptionalProperty(
            {
              correlationId: input.correlationId,
              idempotencyKey: input.idempotencyKey,
              issued,
            },
            !(input.managedPrincipalId === undefined),
            'managedPrincipalId',
            input.managedPrincipalId,
            {
              principal: input.principal,
            },
          ),
        ),
      ),
    );
  const setStatus = (input: {
    readonly authBindingId: string;
    readonly correlationId: string;
    readonly expectedStatus: 'active' | 'disabled';
    readonly idempotencyKey: string;
    readonly managedPrincipalId?: string;
    readonly newStatus: 'active' | 'disabled' | 'revoked';
    readonly principal: TrustedPrincipalContext;
    readonly reason?: string;
  }): Effect.Effect<ApiKeyLifecycleResult, IdentityLifecycleError> => {
    const bindingPrincipalId = input.managedPrincipalId ?? input.principal.principalId;
    return resolver
      .loadApiKeyBindingForAdministration({
        authBindingId: input.authBindingId,
        principalId: bindingPrincipalId,
        tenantId: input.principal.tenantId,
      })
      .pipe(
        Effect.flatMap(({ providerSubjectId: keyId, status: currentStatus }) => {
          const core = () =>
            input.managedPrincipalId === undefined
              ? actionRuntime.runAction({
                  payload: withOptionalProperty(
                    {
                      authBindingId: input.authBindingId,
                      expectedStatus: input.expectedStatus,
                      newStatus: input.newStatus,
                    },
                    !(input.reason === undefined),
                    'reason',
                    input.reason,
                    {},
                  ),
                  principal: input.principal,
                  registration: setSelfApiKeyBindingStatusAction,
                  transport: transport(input.correlationId, input.idempotencyKey),
                })
              : actionRuntime.runAction({
                  payload: withOptionalProperty(
                    {
                      authBindingId: input.authBindingId,
                      expectedStatus: input.expectedStatus,
                      newStatus: input.newStatus,
                      principalId: input.managedPrincipalId,
                    },
                    !(input.reason === undefined),
                    'reason',
                    input.reason,
                    {},
                  ),
                  principal: input.principal,
                  registration: setManagedApiKeyBindingStatusAction,
                  transport: transport(input.correlationId, input.idempotencyKey),
                });
          const result = (metadata: SafeApiKeyMetadata & { readonly providerKeyId: string }) => ({
            ...publicMetadata(metadata),
            authBindingId: input.authBindingId,
            cleanupPending: metadata.enabled !== (input.newStatus === 'active'),
          });
          if (currentStatus !== input.expectedStatus && currentStatus !== input.newStatus) {
            return Effect.fail(
              new IdentityLifecycleConflictError({
                code: 'identity_lifecycle_conflict',
                reason: 'The API key binding changed before this lifecycle operation',
              }),
            );
          }
          const transition =
            currentStatus === input.newStatus ? Effect.void : core().pipe(Effect.asVoid);
          if (input.newStatus === 'active') {
            return keys.setEnabled(keyId, true).pipe(
              Effect.flatMap(() => transition),
              Effect.flatMap(() => keys.metadata(keyId)),
              Effect.map(result),
            );
          }
          return transition.pipe(
            Effect.flatMap(() =>
              keys.setEnabled(keyId, false).pipe(
                Effect.map(result),
                Effect.catch(() => keys.metadata(keyId).pipe(Effect.map(result))),
              ),
            ),
          );
        }),
      );
  };
  return Object.freeze({
    changePrincipalStatus: (input: {
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly payload: unknown;
      readonly principal: TrustedPrincipalContext;
    }) =>
      actionRuntime.runAction({
        payload: input.payload,
        principal: input.principal,
        registration: changePrincipalStatusAction,
        transport: transport(input.correlationId, input.idempotencyKey),
      }),
    createNonHumanPrincipal: (input: {
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly payload: unknown;
      readonly principal: TrustedPrincipalContext;
    }) =>
      actionRuntime.runAction({
        payload: input.payload,
        principal: input.principal,
        registration: createNonHumanPrincipalAction,
        transport: transport(input.correlationId, input.idempotencyKey),
      }),
    issue,
    rotate: (
      input: Parameters<typeof issue>[0] & {
        readonly oldAuthBindingId: string;
        readonly oldManagedPrincipalId?: string;
        readonly reason: string;
      },
    ) =>
      issue(input).pipe(
        Effect.flatMap((replacement) =>
          setStatus(
            withOptionalProperty(
              {
                authBindingId: input.oldAuthBindingId,
                correlationId: input.correlationId,
                expectedStatus: 'active' as const,
                idempotencyKey: `${input.idempotencyKey}:old`,
              },
              !(input.oldManagedPrincipalId === undefined),
              'managedPrincipalId',
              input.oldManagedPrincipalId,
              {
                newStatus: 'revoked' as const,
                principal: input.principal,
                reason: input.reason,
              },
            ),
          ).pipe(
            Effect.map((old) => ({ ...replacement, cleanupPending: old.cleanupPending })),
            Effect.catch((oldError) =>
              resolver
                .loadApiKeyBindingForAdministration({
                  authBindingId: input.oldAuthBindingId,
                  principalId: input.oldManagedPrincipalId ?? input.principal.principalId,
                  tenantId: input.principal.tenantId,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: () => Effect.succeed({ ...replacement, cleanupPending: true }),
                    onSuccess: (oldBinding) =>
                      oldBinding.status === 'revoked'
                        ? Effect.succeed({ ...replacement, cleanupPending: true })
                        : Effect.matchEffect(
                            setStatus(
                              withOptionalProperty(
                                {
                                  authBindingId: replacement.authBindingId,
                                  correlationId: input.correlationId,
                                  expectedStatus: 'active' as const,
                                  idempotencyKey: `${input.idempotencyKey}:replacement-rollback`,
                                },
                                !(input.managedPrincipalId === undefined),
                                'managedPrincipalId',
                                input.managedPrincipalId,
                                {
                                  newStatus: 'revoked' as const,
                                  principal: input.principal,
                                  reason: 'Replacement rollback after old binding closure failed',
                                },
                              ),
                            ),
                            {
                              onFailure: () =>
                                resolver
                                  .loadApiKeyBindingForAdministration({
                                    authBindingId: replacement.authBindingId,
                                    principalId:
                                      input.managedPrincipalId ?? input.principal.principalId,
                                    tenantId: input.principal.tenantId,
                                  })
                                  .pipe(
                                    Effect.matchEffect({
                                      onFailure: () =>
                                        Effect.succeed({
                                          ...replacement,
                                          cleanupPending: true,
                                        }),
                                      onSuccess: (replacementBinding) =>
                                        replacementBinding.status === 'active'
                                          ? Effect.succeed({
                                              ...replacement,
                                              cleanupPending: true,
                                            })
                                          : Effect.fail(oldError),
                                    }),
                                  ),
                              onSuccess: () => Effect.fail(oldError),
                            },
                          ),
                  }),
                ),
            ),
          ),
        ),
      ),
    setStatus,
  });
};

export type IdentityLifecycleService = ReturnType<typeof makeIdentityLifecycleService>;

export class IdentityLifecycle extends Context.Service<
  IdentityLifecycle,
  IdentityLifecycleService
>()('@app/shell-super-app/api/auth/identity-lifecycle/IdentityLifecycle') {}

export const IdentityLifecycleLive = Layer.effect(
  IdentityLifecycle,
  Effect.gen(function* createIdentityLifecycleService() {
    const actionRuntime = yield* ActionRuntime;
    const apiKeys = yield* ApiKeyService;
    const principalResolver = yield* PrincipalResolver;
    return makeIdentityLifecycleService(actionRuntime, apiKeys, principalResolver);
  }),
);
