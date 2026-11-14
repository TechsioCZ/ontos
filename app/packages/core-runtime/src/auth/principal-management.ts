import { and, eq, isNull, sql } from 'drizzle-orm';
import { Context, DateTime, Effect, Option, Schema } from 'effect';

import type { BindingStatus, PrincipalKind, PrincipalStatus } from '../db/schema.ts';
import { principalAuthBindings, principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { PrincipalManagementError } from './principal-management-errors.ts';
import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
} from './principal-management-errors.ts';
import { PLATFORM_TENANT } from './platform-tenant.ts';

const persistenceFailure = <FailureCause>(cause?: FailureCause) => {
  const failure = new IdentityPersistenceUnavailableError({
    code: 'identity_persistence_unavailable',
    reason: 'Identity state could not be persisted',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return failure;
};
const conflict = (reason: string) =>
  new IdentityLifecycleConflictError({
    code: 'identity_lifecycle_conflict',
    reason,
  });
const invalid = (reason: string) => new IdentityTargetInvalidError({ code: 'identity_target_invalid', reason });

type PrincipalRecord = Readonly<{
  readonly kind: PrincipalKind;
  readonly platformRole: string | null;
  readonly status: PrincipalStatus;
}>;
const ApiKeyBindingStatusSchema = Schema.Literals(['active', 'disabled', 'revoked']);
type ApiKeyBindingStatus = typeof ApiKeyBindingStatusSchema.Type;
type ApiKeyBindingRecord = Readonly<{
  readonly bindingStatus: BindingStatus;
  readonly principalKind: PrincipalKind;
  readonly principalStatus: PrincipalStatus;
}>;
type SupportBindingRecord = Readonly<{ readonly authBindingId: string }>;

const isApiKeyBindingStatus = Schema.is(ApiKeyBindingStatusSchema);

/**
 * The marker of a principal the platform registered for a module's internal workload. Only Core's platform writer sets
 * it, when it creates the principal; no Action or API payload has the field, and the database refuses any change to it
 * afterwards (`core.keep_system_principals`). The release step recognises its own principals by this marker together
 * with their derived id, never by their name.
 */
export const INTERNAL_WORKLOAD_PLATFORM_ROLE = 'internal_workload';
export type InternalWorkloadPlatformRole = typeof INTERNAL_WORKLOAD_PLATFORM_ROLE;

export interface PrincipalManagementPersistence {
  readonly createPrincipal: (
    input: CreateNonHumanPrincipalInput & {
      /** Set only by the platform's own writer; no Action or API carries it. */
      readonly platformRole?: InternalWorkloadPlatformRole;
      readonly principalId?: string;
    },
  ) => Effect.Effect<Option.Option<{ readonly principalId: string }>, IdentityPersistenceUnavailableError>;
  readonly insertApiKeyBinding: (
    input: BindApiKeyInput,
  ) => Effect.Effect<Option.Option<{ readonly authBindingId: string }>, IdentityPersistenceUnavailableError>;
  readonly loadApiKeyBinding: (
    input: SetApiKeyBindingStatusInput,
  ) => Effect.Effect<Option.Option<ApiKeyBindingRecord>, IdentityPersistenceUnavailableError>;
  readonly loadPrincipal: (
    tenantId: string,
    principalId: string,
  ) => Effect.Effect<Option.Option<PrincipalRecord>, IdentityPersistenceUnavailableError>;
  readonly loadSupportBindings: (input: {
    readonly activeOnly: boolean;
    readonly authBindingId?: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<readonly SupportBindingRecord[], IdentityPersistenceUnavailableError>;
  readonly renamePlatformPrincipal: (
    input: RenamePlatformServicePrincipalInput,
  ) => Effect.Effect<Option.Option<{ readonly principalId: string }>, IdentityPersistenceUnavailableError>;
  readonly setPlatformPrincipalStatus: (
    input: ChangePlatformPrincipalStatusInput,
  ) => Effect.Effect<Option.Option<{ readonly principalId: string }>, IdentityPersistenceUnavailableError>;
  readonly updateApiKeyBindingStatus: (
    input: SetApiKeyBindingStatusInput,
  ) => Effect.Effect<Option.Option<{ readonly status: BindingStatus }>, IdentityPersistenceUnavailableError>;
  readonly updatePrincipalStatus: (
    input: ChangePrincipalStatusInput,
  ) => Effect.Effect<Option.Option<{ readonly status: PrincipalStatus }>, IdentityPersistenceUnavailableError>;
}

export interface PrincipalManagementRepositoryService {
  readonly bindApiKey: (
    input: BindApiKeyInput,
  ) => Effect.Effect<{ readonly authBindingId: string; readonly status: 'active' }, PrincipalManagementError>;
  /** The release step's own status change of such a principal; touches no principal without its marker. */
  readonly changePlatformPrincipalStatus: (
    input: ChangePlatformPrincipalStatusInput,
  ) => Effect.Effect<void, PrincipalManagementError>;
  readonly changePrincipalStatus: (input: ChangePrincipalStatusInput) => Effect.Effect<
    {
      readonly previousStatus: PrincipalStatus;
      readonly status: PrincipalStatus;
    },
    PrincipalManagementError
  >;
  readonly createNonHumanPrincipal: (
    input: CreateNonHumanPrincipalInput,
  ) => Effect.Effect<{ readonly principalId: string; readonly status: 'active' }, PrincipalManagementError>;
  /**
   * The platform's own service principal with an id the platform derived (a module's internal workload in one company,
   * `internalWorkloadPrincipalId`). Only the release step calls it; no Action or API passes a principal id through.
   */
  readonly createPlatformServicePrincipal: (
    input: CreatePlatformServicePrincipalInput,
  ) => Effect.Effect<{ readonly principalId: string; readonly status: 'active' }, PrincipalManagementError>;
  /** Renames such a principal (a company or the workload's label was renamed); touches no principal without its marker. */
  readonly renamePlatformServicePrincipal: (
    input: RenamePlatformServicePrincipalInput,
  ) => Effect.Effect<void, PrincipalManagementError>;
  readonly setApiKeyBindingStatus: (
    input: SetApiKeyBindingStatusInput,
  ) => Effect.Effect<
    { readonly previousStatus: ApiKeyBindingStatus; readonly status: ApiKeyBindingStatus },
    PrincipalManagementError
  >;
  readonly validateSupportImpersonation: (
    input: ValidateSupportImpersonationInput,
  ) => Effect.Effect<void, PrincipalManagementError>;
}

export class PrincipalManagementRepository extends Context.Service<
  PrincipalManagementRepository,
  PrincipalManagementRepositoryService
>()('@app/core-runtime/auth/principal-management/PrincipalManagementRepository') {}

const principalManagementPersistenceFromTransaction = (
  transaction: Pick<ScopedTransactionExecutor, 'insert' | 'select' | 'update'>,
  authenticationNamespaceId?: string,
): PrincipalManagementPersistence => ({
  createPrincipal: (input) =>
    transaction
      .insert(principals)
      .values(
        input.principalId === undefined
          ? { displayName: input.displayName, kind: input.kind, status: 'active', tenantId: input.tenantId }
          : {
              displayName: input.displayName,
              kind: input.kind,
              platformRole: input.platformRole ?? null,
              principalId: input.principalId,
              status: 'active',
              tenantId: input.tenantId,
            },
      )
      .returning({ principalId: principals.principalId })
      .pipe(
        Effect.mapError(persistenceFailure),
        Effect.map(([created]) => Option.fromNullishOr(created)),
      ),
  insertApiKeyBinding: (input) =>
    authenticationNamespaceId === undefined
      ? Effect.fail(persistenceFailure())
      : (() => {
          const values =
            input.createdByInvocationId === undefined
              ? {
                  authenticationNamespaceId,
                  principalId: input.principalId,
                  provider: 'better_auth' as const,
                  providerSubjectId: input.providerSubjectId,
                  status: 'active' as const,
                  subjectType: 'api_key' as const,
                  tenantId: input.tenantId,
                }
              : {
                  authenticationNamespaceId,
                  createdByInvocationId: input.createdByInvocationId,
                  principalId: input.principalId,
                  provider: 'better_auth' as const,
                  providerSubjectId: input.providerSubjectId,
                  status: 'active' as const,
                  subjectType: 'api_key' as const,
                  tenantId: input.tenantId,
                };
          return transaction
            .insert(principalAuthBindings)
            .values(values)
            .onConflictDoNothing()
            .returning({
              authBindingId: principalAuthBindings.principalAuthBindingId,
            })
            .pipe(
              Effect.mapError(persistenceFailure),
              Effect.map(([created]) => Option.fromNullishOr(created)),
            );
        })(),
  loadApiKeyBinding: (input) =>
    authenticationNamespaceId === undefined
      ? Effect.fail(persistenceFailure())
      : transaction
          .select({
            bindingStatus: principalAuthBindings.status,
            principalKind: principals.kind,
            principalStatus: principals.status,
          })
          .from(principalAuthBindings)
          .innerJoin(
            principals,
            and(
              eq(principals.tenantId, principalAuthBindings.tenantId),
              eq(principals.principalId, principalAuthBindings.principalId),
            ),
          )
          .where(
            and(
              eq(principalAuthBindings.tenantId, input.tenantId),
              eq(principalAuthBindings.principalAuthBindingId, input.authBindingId),
              eq(principalAuthBindings.principalId, input.principalId),
              eq(principalAuthBindings.authenticationNamespaceId, authenticationNamespaceId),
              eq(principalAuthBindings.provider, 'better_auth'),
              eq(principalAuthBindings.subjectType, 'api_key'),
            ),
          )
          .limit(1)
          .pipe(
            Effect.mapError(persistenceFailure),
            Effect.map(([record]) => Option.fromNullishOr(record)),
          ),
  loadPrincipal: (tenantId, principalId) =>
    transaction
      .select({ kind: principals.kind, platformRole: principals.platformRole, status: principals.status })
      .from(principals)
      .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, principalId)))
      .limit(1)
      .pipe(
        Effect.mapError(persistenceFailure),
        Effect.map(([record]) => Option.fromNullishOr(record)),
      ),
  loadSupportBindings: (input) =>
    authenticationNamespaceId === undefined
      ? Effect.fail(persistenceFailure())
      : transaction
          .select({ authBindingId: principalAuthBindings.principalAuthBindingId })
          .from(principalAuthBindings)
          .innerJoin(
            principals,
            and(
              eq(principals.tenantId, principalAuthBindings.tenantId),
              eq(principals.principalId, principalAuthBindings.principalId),
            ),
          )
          .where(
            and(
              eq(principalAuthBindings.tenantId, input.tenantId),
              eq(principalAuthBindings.principalId, input.principalId),
              eq(principalAuthBindings.authenticationNamespaceId, authenticationNamespaceId),
              eq(principalAuthBindings.provider, 'better_auth'),
              eq(principalAuthBindings.subjectType, 'user'),
              eq(principals.kind, 'human'),
              ...(input.activeOnly
                ? [
                    eq(principalAuthBindings.status, 'active'),
                    isNull(principalAuthBindings.revokedAt),
                    eq(principals.status, 'active'),
                  ]
                : []),
              ...(input.authBindingId === undefined
                ? []
                : [eq(principalAuthBindings.principalAuthBindingId, input.authBindingId)]),
            ),
          )
          .limit(2)
          .pipe(Effect.mapError(persistenceFailure)),
  renamePlatformPrincipal: (input) =>
    transaction
      .update(principals)
      .set({ displayName: input.displayName })
      .where(
        and(
          eq(principals.tenantId, input.tenantId),
          eq(principals.principalId, input.principalId),
          eq(principals.platformRole, INTERNAL_WORKLOAD_PLATFORM_ROLE),
        ),
      )
      .returning({ principalId: principals.principalId })
      .pipe(
        Effect.mapError(persistenceFailure),
        Effect.map(([renamed]) => Option.fromNullishOr(renamed)),
      ),
  setPlatformPrincipalStatus: (input) =>
    transaction
      .update(principals)
      .set({
        disabledAt: input.newStatus === 'active' ? null : DateTime.toDateUtc(DateTime.nowUnsafe()),
        status: input.newStatus,
      })
      .where(
        and(
          eq(principals.tenantId, input.tenantId),
          eq(principals.principalId, input.principalId),
          eq(principals.platformRole, INTERNAL_WORKLOAD_PLATFORM_ROLE),
        ),
      )
      .returning({ principalId: principals.principalId })
      .pipe(
        Effect.mapError(persistenceFailure),
        Effect.map(([changed]) => Option.fromNullishOr(changed)),
      ),
  updateApiKeyBindingStatus: (input) => {
    if (authenticationNamespaceId === undefined) {
      return Effect.fail(persistenceFailure());
    }
    const updatedAt = DateTime.toDateUtc(DateTime.nowUnsafe());
    const values = {
      bindingRevision: sql`${principalAuthBindings.bindingRevision} + 1`,
      revokedAt: input.newStatus === 'revoked' ? updatedAt : null,
      status: input.newStatus,
      updatedAt,
    };
    const valuesWithTransition =
      input.transitionRef === undefined ? values : { ...values, lastTransitionRef: input.transitionRef };
    return transaction
      .update(principalAuthBindings)
      .set(valuesWithTransition)
      .where(
        and(
          eq(principalAuthBindings.tenantId, input.tenantId),
          eq(principalAuthBindings.principalAuthBindingId, input.authBindingId),
          eq(principalAuthBindings.principalId, input.principalId),
          eq(principalAuthBindings.authenticationNamespaceId, authenticationNamespaceId),
          eq(principalAuthBindings.provider, 'better_auth'),
          eq(principalAuthBindings.subjectType, 'api_key'),
          eq(principalAuthBindings.status, input.expectedStatus),
        ),
      )
      .returning({ status: principalAuthBindings.status })
      .pipe(
        Effect.mapError(persistenceFailure),
        Effect.map(([updated]) => Option.fromNullishOr(updated)),
      );
  },
  updatePrincipalStatus: (input) =>
    transaction
      .update(principals)
      .set({
        disabledAt: input.newStatus === 'disabled' ? DateTime.toDateUtc(DateTime.nowUnsafe()) : null,
        status: input.newStatus,
      })
      .where(
        and(
          eq(principals.tenantId, input.tenantId),
          eq(principals.principalId, input.principalId),
          eq(principals.status, input.expectedStatus),
        ),
      )
      .returning({ status: principals.status })
      .pipe(
        Effect.mapError(persistenceFailure),
        Effect.map(([updated]) => Option.fromNullishOr(updated)),
      ),
});

export interface CreateNonHumanPrincipalInput {
  readonly displayName: string;
  readonly kind: Extract<PrincipalKind, 'integration' | 'service'>;
  readonly tenantId: string;
}

export interface CreatePlatformServicePrincipalInput {
  readonly displayName: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface RenamePlatformServicePrincipalInput {
  readonly displayName: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const createPlatformServicePrincipalFor = (persistence: PrincipalManagementPersistence) =>
  Effect.fn('PrincipalManagement.createPlatformServicePrincipal')(function* createPlatformPrincipal(
    input: CreatePlatformServicePrincipalInput,
  ) {
    const created = yield* persistence.createPrincipal({
      ...input,
      kind: 'service',
      platformRole: INTERNAL_WORKLOAD_PLATFORM_ROLE,
    });
    if (Option.isNone(created) || created.value.principalId !== input.principalId) {
      return yield* persistenceFailure();
    }
    return { principalId: created.value.principalId, status: 'active' as const };
  });

/** The status the release step sets on a principal it registered: active while wanted, disabled once retired. */
export interface ChangePlatformPrincipalStatusInput {
  readonly newStatus: 'active' | 'disabled';
  readonly principalId: string;
  readonly reason: string;
  readonly tenantId: string;
}

/**
 * The release step's own status writer for the principals it registered. No Action or API reaches it; it touches only
 * a principal carrying the platform's internal workload marker, and it heals what anything else set: an archived or
 * disabled registration that is still wanted becomes active again.
 */
const changePlatformPrincipalStatusFor = (persistence: PrincipalManagementPersistence) =>
  Effect.fn('PrincipalManagement.changePlatformPrincipalStatus')(function* changePlatformStatus(
    input: ChangePlatformPrincipalStatusInput,
  ) {
    const changed = yield* persistence.setPlatformPrincipalStatus(input);
    if (Option.isNone(changed)) {
      return yield* persistenceFailure();
    }
    return yield* Effect.void;
  });

const renamePlatformServicePrincipalFor = (persistence: PrincipalManagementPersistence) =>
  Effect.fn('PrincipalManagement.renamePlatformServicePrincipal')(function* renamePlatformPrincipal(
    input: RenamePlatformServicePrincipalInput,
  ) {
    const renamed = yield* persistence.renamePlatformPrincipal(input);
    if (Option.isNone(renamed)) {
      return yield* persistenceFailure();
    }
    return yield* Effect.void;
  });

const createNonHumanPrincipalFor = (persistence: PrincipalManagementPersistence) =>
  Effect.fn('PrincipalManagement.createNonHumanPrincipal')(function* createPrincipal(
    input: CreateNonHumanPrincipalInput,
  ) {
    const created = yield* persistence.createPrincipal(input);
    if (Option.isNone(created)) {
      return yield* persistenceFailure();
    }
    return {
      principalId: created.value.principalId,
      status: 'active' as const,
    };
  });

export interface ChangePrincipalStatusInput {
  readonly expectedStatus: PrincipalStatus;
  readonly newStatus: PrincipalStatus;
  readonly principalId: string;
  readonly reason?: string;
  readonly tenantId: string;
}

const hasStatusChangeReason = (reason: string | undefined): boolean => reason !== undefined && reason.trim().length > 0;

const principalTransitionAllowed = (current: PrincipalStatus, next: PrincipalStatus): boolean =>
  (current === 'active' && ['disabled', 'archived'].includes(next)) ||
  (current === 'disabled' && ['active', 'archived'].includes(next));

const bindingTransitionAllowed = (current: BindingStatus, next: BindingStatus): boolean =>
  (current === 'active' && ['disabled', 'revoked'].includes(next)) ||
  (current === 'disabled' && ['active', 'revoked'].includes(next));

const changePrincipalStatusFor = (persistence: PrincipalManagementPersistence) =>
  Effect.fn('PrincipalManagement.changePrincipalStatus')(function* changeStatus(input: ChangePrincipalStatusInput) {
    const target = yield* persistence.loadPrincipal(input.tenantId, input.principalId);
    if (Option.isNone(target) || target.value.kind === 'human') {
      return yield* invalid('The target is not a tenant-local non-human principal');
    }
    // The platform's own principals are not tenant-managed: the release actor (a `system` principal, which the
    // database refuses too), a module's internal workload principal in one company (marked `internal_workload`) and
    // anything in the platform tenant. Disabling one would stop the platform's work for the tenant; only the
    // platform's own writer (`changePlatformPrincipalStatus`, which no Action reaches) changes their status.
    if (
      target.value.kind === 'system' ||
      target.value.platformRole !== null ||
      input.tenantId === PLATFORM_TENANT.tenantId
    ) {
      return yield* invalid('The platform manages its own principals');
    }
    if (target.value.status !== input.expectedStatus) {
      return yield* conflict('The principal status changed concurrently');
    }
    if (!principalTransitionAllowed(target.value.status, input.newStatus)) {
      return yield* conflict('The principal status transition is not allowed');
    }
    if (input.newStatus !== 'active' && !hasStatusChangeReason(input.reason)) {
      return yield* invalid('A reason is required for disable or archive');
    }
    const updated = yield* persistence.updatePrincipalStatus(input);
    if (Option.isNone(updated)) {
      return yield* conflict('The principal status changed concurrently');
    }
    return {
      previousStatus: input.expectedStatus,
      status: updated.value.status,
    };
  });

export interface BindApiKeyInput {
  /** The Action invocation that created this binding, when available. */
  readonly createdByInvocationId?: string;
  readonly managed: boolean;
  readonly principalId: string;
  readonly providerSubjectId: string;
  readonly tenantId: string;
}

const bindApiKeyFor = (persistence: PrincipalManagementPersistence) =>
  Effect.fn('PrincipalManagement.bindApiKey')(function* bindKey(input: BindApiKeyInput) {
    const target = yield* persistence.loadPrincipal(input.tenantId, input.principalId);
    const allowedKinds: readonly PrincipalKind[] = input.managed ? ['service', 'integration', 'agent'] : ['human'];
    if (Option.isNone(target) || target.value.status !== 'active' || !allowedKinds.includes(target.value.kind)) {
      return yield* invalid('The API key target is not eligible');
    }
    const created = yield* persistence.insertApiKeyBinding(input);
    if (Option.isNone(created)) {
      return yield* conflict('The API key is already bound');
    }
    return {
      authBindingId: created.value.authBindingId,
      status: 'active' as const,
    };
  });

export interface SetApiKeyBindingStatusInput {
  readonly authBindingId: string;
  readonly expectedStatus: BindingStatus;
  readonly managed: boolean;
  readonly newStatus: BindingStatus;
  readonly principalId: string;
  readonly reason?: string;
  readonly tenantId: string;
  /** The Action transition reference for this actual lifecycle write. */
  readonly transitionRef?: string;
}

export interface ValidateSupportImpersonationInput {
  readonly checkpoint: 'requested' | 'started' | 'stopped';
  readonly originalAuthBindingId: string;
  readonly originalPrincipalId: string;
  readonly targetPrincipalId: string;
  readonly tenantId: string;
}

const validateSupportImpersonationFor = (persistence: PrincipalManagementPersistence) =>
  Effect.fn('PrincipalManagement.validateSupportImpersonation')(function* validateSupportParticipants(
    input: ValidateSupportImpersonationInput,
  ) {
    const loadHumanBindings = (principalId: string, authBindingId?: string) => {
      const query = {
        activeOnly: input.checkpoint !== 'stopped',
        principalId,
        tenantId: input.tenantId,
      };
      return persistence.loadSupportBindings(authBindingId === undefined ? query : { ...query, authBindingId });
    };
    const [original, target] = yield* Effect.all(
      [
        loadHumanBindings(input.originalPrincipalId, input.originalAuthBindingId),
        loadHumanBindings(input.targetPrincipalId),
      ],
      { concurrency: 1 },
    );
    if (original.length !== 1 || target.length === 0) {
      return yield* invalid(
        input.checkpoint === 'stopped'
          ? 'The impersonation participants are not tenant-local users'
          : 'The impersonation participants are not active tenant-local users',
      );
    }
  });

const isEligibleBindingTarget = (managed: boolean, status: PrincipalStatus, kind: PrincipalKind): boolean => {
  const allowedKinds: readonly PrincipalKind[] = managed ? ['service', 'integration', 'agent'] : ['human'];
  return status === 'active' && allowedKinds.includes(kind);
};

const setApiKeyBindingStatusFor = (persistence: PrincipalManagementPersistence) =>
  Effect.fn('PrincipalManagement.setApiKeyBindingStatus')(function* setBindingStatus(
    input: SetApiKeyBindingStatusInput,
  ) {
    const binding = yield* persistence.loadApiKeyBinding(input);
    if (Option.isNone(binding)) {
      return yield* invalid('The API key binding is unavailable');
    }
    if (!isEligibleBindingTarget(input.managed, binding.value.principalStatus, binding.value.principalKind)) {
      return yield* invalid('The API key binding target is not eligible');
    }
    if (!isApiKeyBindingStatus(input.expectedStatus) || !isApiKeyBindingStatus(input.newStatus)) {
      return yield* invalid('The API key binding status is not supported');
    }
    if (binding.value.bindingStatus !== input.expectedStatus) {
      return yield* conflict('The binding status changed concurrently');
    }
    if (!bindingTransitionAllowed(binding.value.bindingStatus, input.newStatus)) {
      return yield* conflict('The binding transition is not allowed');
    }
    if (input.newStatus === 'revoked' && !hasStatusChangeReason(input.reason)) {
      return yield* invalid('A reason is required for revocation');
    }
    const updated = yield* persistence.updateApiKeyBindingStatus(input);
    if (Option.isNone(updated)) {
      return yield* conflict('The binding status changed concurrently');
    }
    if (!isApiKeyBindingStatus(updated.value.status)) {
      return yield* invalid('The API key binding status is not supported');
    }
    return {
      previousStatus: input.expectedStatus,
      status: updated.value.status,
    };
  });

export const principalManagementRepositoryFromPersistence = (
  persistence: PrincipalManagementPersistence,
): PrincipalManagementRepositoryService =>
  Object.freeze({
    bindApiKey: bindApiKeyFor(persistence),
    changePlatformPrincipalStatus: changePlatformPrincipalStatusFor(persistence),
    changePrincipalStatus: changePrincipalStatusFor(persistence),
    createNonHumanPrincipal: createNonHumanPrincipalFor(persistence),
    createPlatformServicePrincipal: createPlatformServicePrincipalFor(persistence),
    renamePlatformServicePrincipal: renamePlatformServicePrincipalFor(persistence),
    setApiKeyBindingStatus: setApiKeyBindingStatusFor(persistence),
    validateSupportImpersonation: validateSupportImpersonationFor(persistence),
  });

export const principalManagementRepositoryFromTransaction = (
  transaction: Pick<ScopedTransactionExecutor, 'insert' | 'select' | 'update'>,
  authenticationNamespaceId?: string,
): PrincipalManagementRepositoryService =>
  principalManagementRepositoryFromPersistence(
    principalManagementPersistenceFromTransaction(transaction, authenticationNamespaceId),
  );

export const createNonHumanPrincipal = (input: CreateNonHumanPrincipalInput) =>
  PrincipalManagementRepository.pipe(Effect.flatMap((repository) => repository.createNonHumanPrincipal(input)));

export const changePrincipalStatus = (input: ChangePrincipalStatusInput) =>
  PrincipalManagementRepository.pipe(Effect.flatMap((repository) => repository.changePrincipalStatus(input)));

export const bindApiKey = (input: BindApiKeyInput) =>
  PrincipalManagementRepository.pipe(Effect.flatMap((repository) => repository.bindApiKey(input)));

export const validateSupportImpersonation = (input: ValidateSupportImpersonationInput) =>
  PrincipalManagementRepository.pipe(Effect.flatMap((repository) => repository.validateSupportImpersonation(input)));

export const setApiKeyBindingStatus = (input: SetApiKeyBindingStatusInput) =>
  PrincipalManagementRepository.pipe(Effect.flatMap((repository) => repository.setApiKeyBindingStatus(input)));
