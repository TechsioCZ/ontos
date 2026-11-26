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
  changeSystemWorkloadEnrollmentAction,
  createNonHumanPrincipalAction,
  configureDemoCompaniesAction,
  IdentityLifecycleConflictError,
  PrincipalResolver,
  registerIntegrationWorkloadsAction,
  setManagedApiKeyBindingStatusAction,
  setSelfApiKeyBindingStatusAction,
} from '@app/core-runtime';
import { Context, Effect, Layer, Match, Option, Schema } from 'effect';
import type { Redacted } from 'effect';

import { ApiKeyService } from './api-key-service.ts';
import type {
  ApiKeyProviderError,
  ApiKeyServiceContract,
  IssuedApiKey,
  ProviderApiKeyMetadata,
  SafeApiKeyMetadata,
} from './api-key-service.ts';
import { ManagedApiKeyTargetEligibility } from '@app/core-runtime/auth/managed-api-key-eligibility';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const identityLifecycleOperationErrorFields = {
  code: Schema.Literal('identity_lifecycle_operation_failed'),
  failureCause: Schema.Defect(),
  reason: Schema.String,
};
const IdentityLifecycleOperationErrorSchema = Schema.TaggedStruct(
  'IdentityLifecycleOperationError',
  identityLifecycleOperationErrorFields,
);
const IdentityLifecycleOperationError = Schema.TaggedError<
  Schema.Schema.Type<typeof IdentityLifecycleOperationErrorSchema>
>()('IdentityLifecycleOperationError', identityLifecycleOperationErrorFields);
export type IdentityLifecycleError =
  | ActionCoreError
  | ApiKeyProviderError
  | Schema.Schema.Type<typeof IdentityLifecycleOperationErrorSchema>
  | PrincipalManagementError
  | PrincipalResolutionError;
export interface ApiKeyLifecycleResult extends SafeApiKeyMetadata {
  readonly authBindingId: string;
  readonly cleanupPending: boolean;
}
export type ApiKeyIssueResult = ApiKeyLifecycleResult & Readonly<Record<'secret', Redacted.Redacted>>;

type ManagedKeyScope = Schema.Schema.Type<typeof bindManagedApiKeyAction.descriptor.payloadSchema>['scope'] | undefined;

type RequestIdentity = Readonly<Record<'correlationId' | 'idempotencyKey', string>>;

const lifecycleFailure = (cause: unknown = 'identity lifecycle reconciliation remained pending') =>
  new IdentityLifecycleOperationError({
    code: 'identity_lifecycle_operation_failed',
    failureCause: cause,
    reason: 'The identity lifecycle operation could not be completed',
  });
const transport = (identity: RequestIdentity) => ({
  correlationId: identity.correlationId,
  idempotencyKey: identity.idempotencyKey,
});
/** A value already registered (in any state) is never registered again; the refusal keeps what it was refused on. */
const alreadyRegistered = (cause?: unknown) => {
  const refusal = new IdentityLifecycleConflictError({
    code: 'identity_lifecycle_conflict',
    reason: 'This API key value is already registered',
  });
  if (cause !== undefined) {
    Object.defineProperty(refusal, 'cause', { configurable: true, value: cause });
  }
  return refusal;
};
/**
 * A bind that may have committed although it answered a failure; its provider key is then disabled, never removed,
 * because a binding may reference it.
 */
const bindMayHaveCommitted = (error: IdentityLifecycleError): boolean =>
  Match.value(error).pipe(
    Match.tags({
      ActionAlreadyCommitted: () => true,
      ActionCommitIndeterminate: () => true,
      ActionInvocationPersistenceError: () => true,
      ActionTransactionError: () => true,
    }),
    Match.orElse(() => false),
  );
const publicMetadata = ({
  providerKeyId: _providerKeyId,
  ...metadata
}: SafeApiKeyMetadata & { readonly providerKeyId: string }): Omit<
  ApiKeyLifecycleResult,
  'authBindingId' | 'cleanupPending'
> => metadata;

export const makeIdentityLifecycleService = (
  ...dependencies: readonly [
    ActionRuntimeService,
    ApiKeyServiceContract,
    PrincipalResolverService,
    (typeof ManagedApiKeyTargetEligibility)['Service']?,
  ]
) => {
  const [actionRuntime, keys, resolver, eligibility] = dependencies;
  /**
   * A managed key's target is checked before the provider issues anything, so a refused target (a platform principal,
   * one bound to a platform-registered workload, the wrong kind) never gets a key. The bind Action checks again.
   */
  const eligibleTarget = (input: {
    readonly managedPrincipalId?: string;
    readonly managedScope?: ManagedKeyScope;
    readonly principal: TrustedPrincipalContext;
  }): Effect.Effect<void, IdentityLifecycleError> =>
    input.managedPrincipalId === undefined || input.managedScope === undefined || eligibility === undefined
      ? Effect.void
      : eligibility.check({
          legalEntityId: input.principal.legalEntityId,
          principalId: input.managedPrincipalId,
          scope: input.managedScope,
          tenantId: input.principal.tenantId,
        });
  const reconcileProviderKey = (providerKeyId: string): Effect.Effect<void, IdentityLifecycleError> =>
    resolver.resolveBetterAuthApiKey(providerKeyId).pipe(
      Effect.match({
        onFailure: (error) =>
          Match.value(error).pipe(
            Match.tag('PrincipalResolverUnavailableError', () => 'unavailable' as const),
            Match.orElse(() => 'orphan' as const),
          ),
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
  const reconcileProviderKeys = Effect.fn('makeIdentityLifecycleService.reconcileProviderKeys')(
    function* reconcileProviderKeySequence(providerKeyIds: readonly string[]) {
      yield* Effect.forEach(providerKeyIds, reconcileProviderKey, {
        concurrency: 1,
        discard: true,
      });
    },
  );
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
        Effect.mapError(lifecycleFailure),
      );
  const bindIssued = (
    input: RequestIdentity & {
      readonly issued: IssuedApiKey;
      readonly managedPrincipalId?: string;
      readonly managedScope?: ManagedKeyScope;
      readonly principal: TrustedPrincipalContext;
    },
  ): Effect.Effect<ApiKeyIssueResult, IdentityLifecycleError> => {
    const bindingEffect =
      input.managedPrincipalId === undefined
        ? actionRuntime.runAction({
            payload: { providerSubjectId: input.issued.providerKeyId },
            principal: input.principal,
            registration: bindSelfApiKeyAction,
            transport: transport(input),
          })
        : actionRuntime.runAction({
            payload: {
              principalId: input.managedPrincipalId,
              providerSubjectId: input.issued.providerKeyId,
              scope: input.managedScope,
            },
            principal: input.principal,
            registration: bindManagedApiKeyAction,
            transport: transport(input),
          });
    return bindingEffect.pipe(
      Effect.flatMap((binding) => {
        const result = (cleanupPending: boolean): ApiKeyIssueResult => ({
          ...publicMetadata(input.issued),
          authBindingId: binding.authBindingId,
          cleanupPending,
          secret: input.issued.secret,
        });
        return keys.clearPendingCleanup(input.issued.providerKeyId).pipe(
          Effect.as(result(false)),
          Effect.orElseSucceed(() => result(true)),
        );
      }),
      Effect.matchEffect({
        onFailure: (bindingError) =>
          keys.setEnabled(input.issued.providerKeyId, false).pipe(
            Effect.flatMap(() => keys.clearPendingCleanup(input.issued.providerKeyId)),
            Effect.ignore,
            Effect.andThen(Effect.fail(bindingError)),
          ),
        onSuccess: Effect.succeed,
      }),
    );
  };
  type IssueInput = RequestIdentity & {
    readonly managedPrincipalId?: string;
    readonly managedScope?: ManagedKeyScope;
    readonly name?: string;
    readonly principal: TrustedPrincipalContext;
    readonly requestHeaders: Headers;
  };
  /** A tenant-managed key of an integration Principal, registered from a value the integration already holds. */
  type RegisterInput = IssueInput & {
    readonly managedPrincipalId: string;
    readonly suppliedSecret: Redacted.Redacted;
  };
  const issuerOf = (input: IssueInput) =>
    withOptionalProperty(
      {
        issuerPrincipalId: input.principal.principalId,
        lifecycleOperationId: input.idempotencyKey,
        tenantId: input.principal.tenantId,
      },
      input.name !== undefined,
      'name',
      input.name,
      {},
    );
  const managedBinding = (input: RegisterInput, providerSubjectId: string) => ({
    payload: { principalId: input.managedPrincipalId, providerSubjectId, scope: input.managedScope },
    principal: input.principal,
    registration: bindManagedApiKeyAction,
    transport: transport(input),
  });
  /** Binds a registered existing value; a refused binding removes the provider key, so the value can be registered again. */
  const bindRegistered = (input: RegisterInput, registered: ProviderApiKeyMetadata) =>
    actionRuntime.runAction(managedBinding(input, registered.providerKeyId)).pipe(
      Effect.flatMap((binding) => {
        const result = (cleanupPending: boolean): ApiKeyLifecycleResult => ({
          ...publicMetadata(registered),
          authBindingId: binding.authBindingId,
          cleanupPending,
        });
        return keys.clearPendingCleanup(registered.providerKeyId).pipe(
          Effect.as(result(false)),
          Effect.orElseSucceed(() => result(true)),
        );
      }),
      Effect.matchEffect({
        onFailure: (bindingError: IdentityLifecycleError) =>
          (bindMayHaveCommitted(bindingError)
            ? keys
                .setEnabled(registered.providerKeyId, false)
                .pipe(Effect.flatMap(() => keys.clearPendingCleanup(registered.providerKeyId)))
            : keys.removeUnbound(registered.providerKeyId)
          ).pipe(Effect.ignore, Effect.andThen(Effect.fail(bindingError))),
        onSuccess: Effect.succeed,
      }),
    );
  /**
   * The same request again: a value this request already registered and bound to this integration answers the bind's
   * saved reply, so a retry with the same idempotency key gets the original result. Any other holder of the value, or a
   * new request, is refused as already registered; no key and no binding changes.
   */
  const replayRegistration = (input: RegisterInput, keyId: string) =>
    resolver.resolveBetterAuthApiKey(keyId).pipe(
      Effect.mapError(alreadyRegistered),
      Effect.flatMap((holder) =>
        holder.principalId === input.managedPrincipalId && holder.tenantId === input.principal.tenantId
          ? actionRuntime.runAction({ ...managedBinding(input, keyId), savedReply: 'answer' }).pipe(
              Effect.flatMap((binding) =>
                keys.metadata(keyId).pipe(
                  Effect.map((registered): ApiKeyLifecycleResult => ({
                    ...publicMetadata(registered),
                    authBindingId: binding.authBindingId,
                    cleanupPending: false,
                  })),
                ),
              ),
              Effect.mapError(alreadyRegistered),
            )
          : Effect.fail(alreadyRegistered(holder)),
      ),
    );
  /** Registers a value the integration already holds, once: `auth.apikey(key)` is unique, so a concurrent twin loses. */
  const registerSupplied = (input: RegisterInput) => {
    const secret = input.suppliedSecret;
    return keys.registeredKeyId(secret).pipe(
      Effect.flatMap((existing) =>
        Option.match(existing, {
          onNone: () =>
            keys.register(input.requestHeaders, { ...issuerOf(input), secret }).pipe(
              Effect.matchEffect({
                onFailure: (providerError: IdentityLifecycleError) =>
                  keys
                    .registeredKeyId(secret)
                    .pipe(
                      Effect.flatMap((raced) =>
                        Option.isSome(raced)
                          ? Effect.fail(alreadyRegistered(providerError))
                          : Effect.fail(providerError),
                      ),
                    ),
                onSuccess: Effect.succeed,
              }),
              Effect.flatMap((registered) => bindRegistered(input, registered)),
            ),
          onSome: (keyId) => replayRegistration(input, keyId),
        }),
      ),
    );
  };
  /** Pending registrations of this request are reconciled first, so a retried request never leaves a key behind. */
  const prepare = (input: IssueInput) =>
    eligibleTarget(input).pipe(
      Effect.andThen(
        reconcilePendingCleanup({
          lifecycleOperationId: input.idempotencyKey,
          principal: input.principal,
        }),
      ),
    );
  /** A generated key, bound to the caller or the managed target; its one-time secret is the result's. */
  const issue = (input: IssueInput): Effect.Effect<ApiKeyIssueResult, IdentityLifecycleError> =>
    prepare(input).pipe(
      Effect.andThen(() => keys.issue(input.requestHeaders, issuerOf(input))),
      Effect.flatMap((issued) =>
        bindIssued(
          withOptionalProperty(
            {
              correlationId: input.correlationId,
              idempotencyKey: input.idempotencyKey,
              issued,
            },
            input.managedPrincipalId !== undefined,
            'managedPrincipalId',
            input.managedPrincipalId,
            {
              managedScope: input.managedScope,
              principal: input.principal,
            },
          ),
        ),
      ),
    );
  /** An existing value registered for an integration; the result never carries the value. */
  const register = (input: RegisterInput): Effect.Effect<ApiKeyLifecycleResult, IdentityLifecycleError> =>
    prepare(input).pipe(Effect.andThen(() => registerSupplied(input)));
  const setStatus = (
    input: RequestIdentity & {
      readonly authBindingId: string;
      readonly expectedStatus: 'active' | 'disabled';
      readonly managedPrincipalId?: string;
      readonly managedScope?: ManagedKeyScope;
      readonly newStatus: 'active' | 'disabled' | 'revoked';
      readonly principal: TrustedPrincipalContext;
      readonly reason?: string;
    },
  ): Effect.Effect<ApiKeyLifecycleResult, IdentityLifecycleError> => {
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
                    input.reason !== undefined,
                    'reason',
                    input.reason,
                    {},
                  ),
                  principal: input.principal,
                  registration: setSelfApiKeyBindingStatusAction,
                  transport: transport(input),
                })
              : actionRuntime.runAction({
                  payload: withOptionalProperty(
                    {
                      authBindingId: input.authBindingId,
                      expectedStatus: input.expectedStatus,
                      newStatus: input.newStatus,
                      principalId: input.managedPrincipalId,
                      scope: input.managedScope,
                    },
                    input.reason !== undefined,
                    'reason',
                    input.reason,
                    {},
                  ),
                  principal: input.principal,
                  registration: setManagedApiKeyBindingStatusAction,
                  transport: transport(input),
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
          // Even provider reconciliation must cross native authorization; an already-matching binding is not permission.
          const transition = core().pipe(
            Effect.asVoid,
            Effect.catchTag('ActionAlreadyCommitted', () => Effect.void),
          );
          if (input.newStatus === 'active') {
            return transition.pipe(
              Effect.flatMap(() => keys.setEnabled(keyId, true)),
              Effect.flatMap(() => keys.metadata(keyId)),
              Effect.map(result),
            );
          }
          return transition.pipe(
            Effect.flatMap(() =>
              keys.setEnabled(keyId, false).pipe(
                Effect.map(result),
                Effect.matchEffect({
                  onFailure: (providerError) =>
                    Effect.annotateLogs(Effect.logWarning('API key disable requires reconciliation'), {
                      failureTag: providerError._tag,
                    }).pipe(Effect.andThen(keys.metadata(keyId).pipe(Effect.map(result)))),
                  onSuccess: Effect.succeed,
                }),
              ),
            ),
          );
        }),
      );
  };
  /** Replaces the old key: the replacement is bound first, then the old binding is revoked (or the replacement rolled back). */
  const rotateWith = <Replacement extends ApiKeyLifecycleResult>(
    input: RotateInput<IssueInput>,
    replacing: Effect.Effect<Replacement, IdentityLifecycleError>,
  ) =>
    replacing.pipe(
      Effect.flatMap((replacement) =>
        setStatus(
          withOptionalProperty(
            {
              authBindingId: input.oldAuthBindingId,
              correlationId: input.correlationId,
              expectedStatus: 'active' as const,
              idempotencyKey: `${input.idempotencyKey}:old`,
            },
            input.oldManagedPrincipalId !== undefined,
            'managedPrincipalId',
            input.oldManagedPrincipalId,
            {
              managedScope: input.managedScope,
              newStatus: 'revoked' as const,
              principal: input.principal,
              reason: input.reason,
            },
          ),
        ).pipe(
          Effect.matchEffect({
            onFailure: (oldError) =>
              resolver
                .loadApiKeyBindingForAdministration({
                  authBindingId: input.oldAuthBindingId,
                  principalId: input.oldManagedPrincipalId ?? input.principal.principalId,
                  tenantId: input.principal.tenantId,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (oldLookupError) =>
                      Effect.annotateLogs(Effect.logWarning('Old API key binding reconciliation is pending'), {
                        failureTag: oldLookupError._tag,
                      }).pipe(Effect.as({ ...replacement, cleanupPending: true })),
                    onSuccess: (oldBinding) =>
                      oldBinding.status === 'revoked'
                        ? Effect.succeed({
                            ...replacement,
                            cleanupPending: true,
                          })
                        : Effect.matchEffect(
                            setStatus(
                              withOptionalProperty(
                                {
                                  authBindingId: replacement.authBindingId,
                                  correlationId: input.correlationId,
                                  expectedStatus: 'active' as const,
                                  idempotencyKey: `${input.idempotencyKey}:replacement-rollback`,
                                },
                                input.managedPrincipalId !== undefined,
                                'managedPrincipalId',
                                input.managedPrincipalId,
                                {
                                  managedScope: input.managedScope,
                                  newStatus: 'revoked' as const,
                                  principal: input.principal,
                                  reason: 'Replacement rollback after old binding closure failed',
                                },
                              ),
                            ),
                            {
                              onFailure: (rollbackError) =>
                                Effect.annotateLogs(Effect.logWarning('Replacement API key rollback requires proof'), {
                                  failureTag: rollbackError._tag,
                                }).pipe(
                                  Effect.andThen(
                                    resolver
                                      .loadApiKeyBindingForAdministration({
                                        authBindingId: replacement.authBindingId,
                                        principalId: input.managedPrincipalId ?? input.principal.principalId,
                                        tenantId: input.principal.tenantId,
                                      })
                                      .pipe(
                                        Effect.matchEffect({
                                          onFailure: (replacementLookupError) =>
                                            Effect.annotateLogs(
                                              Effect.logWarning('Replacement API key reconciliation is pending'),
                                              {
                                                failureTag: replacementLookupError._tag,
                                              },
                                            ).pipe(
                                              Effect.as({
                                                ...replacement,
                                                cleanupPending: true,
                                              }),
                                            ),
                                          onSuccess: (replacementBinding) =>
                                            replacementBinding.status === 'active'
                                              ? Effect.succeed({
                                                  ...replacement,
                                                  cleanupPending: true,
                                                })
                                              : Effect.fail(oldError),
                                        }),
                                      ),
                                  ),
                                ),
                              onSuccess: () => Effect.fail(oldError),
                            },
                          ),
                  }),
                ),
            onSuccess: (old) =>
              Effect.succeed({
                ...replacement,
                cleanupPending: old.cleanupPending,
              }),
          }),
        ),
      ),
    );
  return Object.freeze({
    changePrincipalStatus: (
      input: RequestIdentity & {
        readonly payload: unknown;
        readonly principal: TrustedPrincipalContext;
      },
    ) =>
      actionRuntime.runAction({
        payload: input.payload,
        principal: input.principal,
        registration: changePrincipalStatusAction,
        // Served as-is by the Shell's HTTP endpoint: its client's same-key retry gets the saved reply.
        savedReply: 'answer',
        transport: transport(input),
      }),
    changeSystemWorkloadEnrollment: (
      input: RequestIdentity & {
        readonly payload: unknown;
        readonly principal: TrustedPrincipalContext;
      },
    ) =>
      actionRuntime.runAction({
        payload: input.payload,
        principal: input.principal,
        registration: changeSystemWorkloadEnrollmentAction,
        // Served as-is by the Shell's HTTP endpoint: its client's same-key retry gets the saved reply.
        savedReply: 'answer',
        transport: transport(input),
      }),
    configureDemoCompanies: (
      input: RequestIdentity & { readonly payload: unknown; readonly principal: TrustedPrincipalContext },
    ) =>
      actionRuntime.runAction({
        payload: input.payload,
        principal: input.principal,
        registration: configureDemoCompaniesAction,
        transport: transport(input),
      }),
    createNonHumanPrincipal: (
      input: RequestIdentity & {
        readonly payload: unknown;
        readonly principal: TrustedPrincipalContext;
      },
    ) =>
      actionRuntime.runAction({
        payload: input.payload,
        principal: input.principal,
        registration: createNonHumanPrincipalAction,
        // Served as-is by the Shell's HTTP endpoint: its client's same-key retry gets the saved reply.
        savedReply: 'answer',
        transport: transport(input),
      }),
    issue,
    register,
    /** Binds a connector partner's workloads to an integration Principal in the caller's selected company. */
    registerIntegrationWorkloads: (
      input: RequestIdentity & {
        readonly payload: unknown;
        readonly principal: TrustedPrincipalContext;
      },
    ) =>
      actionRuntime.runAction({
        payload: input.payload,
        principal: input.principal,
        registration: registerIntegrationWorkloadsAction,
        // Served as-is by the Shell's HTTP endpoint: its client's same-key retry gets the saved reply.
        savedReply: 'answer',
        transport: transport(input),
      }),
    rotate: (input: RotateInput<IssueInput>) => rotateWith(input, issue(input)),
    /** A rotation to a value the integration already holds; the replacement never carries the value. */
    rotateRegistering: (input: RotateInput<RegisterInput>) => rotateWith(input, register(input)),
    setStatus,
  });
};

type RotateInput<Input> = Input & {
  readonly oldAuthBindingId: string;
  readonly oldManagedPrincipalId?: string;
  readonly reason: string;
};

export type IdentityLifecycleService = ReturnType<typeof makeIdentityLifecycleService>;

export class IdentityLifecycle extends Context.Service<IdentityLifecycle, IdentityLifecycleService>()(
  '@app/shell-super-app/api/auth/identity-lifecycle/IdentityLifecycle',
) {}

export const IdentityLifecycleLive = Layer.effect(
  IdentityLifecycle,
  Effect.gen(function* createIdentityLifecycleService() {
    const actionRuntime = yield* ActionRuntime;
    const apiKeys = yield* ApiKeyService;
    const principalResolver = yield* PrincipalResolver;
    const eligibility = yield* ManagedApiKeyTargetEligibility;
    return makeIdentityLifecycleService(actionRuntime, apiKeys, principalResolver, eligibility);
  }),
);
