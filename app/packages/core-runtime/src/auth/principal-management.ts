// @effect-diagnostics asyncFunction:off globalDate:off globalDateInEffect:off
import { and, eq, isNull } from 'drizzle-orm';
import { DateTime, Effect, Predicate } from 'effect';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { principalAuthBindings, principals } from '../db/schema.ts';
import type { BindingStatus, PrincipalKind, PrincipalStatus } from '../db/schema.ts';
import {
  identityPersistenceUnavailableError,
  IdentityLifecycleConflictError,
  IdentityTargetInvalidError,
} from './principal-management-errors.ts';
import type { PrincipalManagementError } from './principal-management-errors.ts';

const persistenceFailure = (originalFailure?: unknown) =>
  identityPersistenceUnavailableError(originalFailure);
const conflict = (reason: string) =>
  new IdentityLifecycleConflictError({ code: 'identity_lifecycle_conflict', reason });
const invalid = (reason: string) =>
  new IdentityTargetInvalidError({ code: 'identity_target_invalid', reason });
const hasDatabaseErrorCode = <Failure>(error: Failure, expectedCode: string): boolean => {
  let current: unknown = error;
  const visited = new Set<object>();
  while (Predicate.isObjectKeyword(current) && current !== null && !visited.has(current)) {
    visited.add(current);
    if ('code' in current && current.code === expectedCode) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
};
const bindingInsertFailure = <Failure>(error: Failure): PrincipalManagementError =>
  hasDatabaseErrorCode(error, '23505')
    ? conflict('The API key is already bound')
    : persistenceFailure(error);

type PrincipalRecord = Readonly<{ readonly kind: PrincipalKind; readonly status: PrincipalStatus }>;
type ApiKeyBindingRecord = Readonly<{
  readonly bindingStatus: BindingStatus;
  readonly principalKind: PrincipalKind;
  readonly principalStatus: PrincipalStatus;
}>;
type SupportBindingRecord = Readonly<{ readonly authBindingId: string }>;

export interface PrincipalManagementRepositoryService {
  readonly createPrincipal: (
    input: CreateNonHumanPrincipalInput,
  ) => Promise<{ readonly principalId: string } | undefined>;
  readonly insertApiKeyBinding: (
    input: BindApiKeyInput,
  ) => Promise<{ readonly authBindingId: string } | undefined>;
  readonly loadApiKeyBinding: (
    input: SetApiKeyBindingStatusInput,
  ) => Promise<ApiKeyBindingRecord | undefined>;
  readonly loadPrincipal: (
    tenantId: string,
    principalId: string,
  ) => Promise<PrincipalRecord | undefined>;
  readonly loadSupportBindings: (input: {
    readonly activeOnly: boolean;
    readonly authBindingId?: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) => Promise<readonly SupportBindingRecord[]>;
  readonly updateApiKeyBindingStatus: (
    input: SetApiKeyBindingStatusInput,
  ) => Promise<{ readonly status: BindingStatus } | undefined>;
  readonly updatePrincipalStatus: (
    input: ChangePrincipalStatusInput,
  ) => Promise<{ readonly status: PrincipalStatus } | undefined>;
}

export const principalManagementRepositoryFromTransaction = (
  transaction: Pick<ScopedTransactionExecutor, 'insert' | 'select' | 'update'>,
): PrincipalManagementRepositoryService => ({
  createPrincipal: async (input) => {
    const [created] = await transaction
      .insert(principals)
      .values({
        displayName: input.displayName,
        kind: input.kind,
        status: 'active',
        tenantId: input.tenantId,
      })
      .returning({ principalId: principals.principalId });
    return created;
  },
  insertApiKeyBinding: async (input) => {
    const [created] = await transaction
      .insert(principalAuthBindings)
      .values({
        principalId: input.principalId,
        provider: 'better_auth',
        providerSubjectId: input.providerSubjectId,
        status: 'active',
        subjectType: 'api_key',
        tenantId: input.tenantId,
      })
      .returning({ authBindingId: principalAuthBindings.principalAuthBindingId });
    return created;
  },
  loadApiKeyBinding: async (input) => {
    const [record] = await transaction
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
          eq(principalAuthBindings.subjectType, 'api_key'),
        ),
      )
      .limit(1);
    return record;
  },
  loadPrincipal: async (tenantId, principalId) => {
    const [record] = await transaction
      .select({ kind: principals.kind, status: principals.status })
      .from(principals)
      .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, principalId)))
      .limit(1);
    return record;
  },
  loadSupportBindings: (input) =>
    transaction
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
      .limit(2),
  updateApiKeyBindingStatus: async (input) => {
    const updatedAt = DateTime.toDateUtc(DateTime.nowUnsafe());
    const [updated] = await transaction
      .update(principalAuthBindings)
      .set({
        revokedAt: input.newStatus === 'revoked' ? updatedAt : null,
        status: input.newStatus,
        updatedAt,
      })
      .where(
        and(
          eq(principalAuthBindings.principalAuthBindingId, input.authBindingId),
          eq(principalAuthBindings.status, input.expectedStatus),
        ),
      )
      .returning({ status: principalAuthBindings.status });
    return updated;
  },
  updatePrincipalStatus: async (input) => {
    const [updated] = await transaction
      .update(principals)
      .set({
        disabledAt:
          input.newStatus === 'disabled' ? DateTime.toDateUtc(DateTime.nowUnsafe()) : null,
        status: input.newStatus,
      })
      .where(
        and(
          eq(principals.tenantId, input.tenantId),
          eq(principals.principalId, input.principalId),
          eq(principals.status, input.expectedStatus),
        ),
      )
      .returning({ status: principals.status });
    return updated;
  },
});

const loadPrincipal = (
  repository: PrincipalManagementRepositoryService,
  tenantId: string,
  principalId: string,
) =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => await repository.loadPrincipal(tenantId, principalId),
  });

export interface CreateNonHumanPrincipalInput {
  readonly displayName: string;
  readonly kind: Extract<PrincipalKind, 'integration' | 'service' | 'system'>;
  readonly tenantId: string;
}

export const createNonHumanPrincipal = (
  repository: PrincipalManagementRepositoryService,
  input: CreateNonHumanPrincipalInput,
): Effect.Effect<
  { readonly principalId: string; readonly status: 'active' },
  PrincipalManagementError
> =>
  Effect.gen(function* createPrincipal() {
    const created = yield* Effect.tryPromise({
      catch: persistenceFailure,
      try: () => repository.createPrincipal(input),
    });
    if (created === undefined) {
      return yield* persistenceFailure();
    }
    return { principalId: created.principalId, status: 'active' as const };
  });

export interface ChangePrincipalStatusInput {
  readonly expectedStatus: PrincipalStatus;
  readonly newStatus: PrincipalStatus;
  readonly principalId: string;
  readonly reason?: string;
  readonly tenantId: string;
}

export const changePrincipalStatus = (
  repository: PrincipalManagementRepositoryService,
  input: ChangePrincipalStatusInput,
): Effect.Effect<
  { readonly previousStatus: PrincipalStatus; readonly status: PrincipalStatus },
  PrincipalManagementError
> =>
  Effect.gen(function* changeStatus() {
    const target = yield* loadPrincipal(repository, input.tenantId, input.principalId);
    if (target === undefined || target.kind === 'human') {
      return yield* invalid('The target is not a tenant-local non-human principal');
    }
    if (target.status !== input.expectedStatus) {
      return yield* conflict('The principal status changed concurrently');
    }
    if (target.status === 'archived' || input.newStatus === target.status) {
      return yield* conflict('The principal status transition is not allowed');
    }
    if (
      input.newStatus !== 'active' &&
      (input.reason === undefined || input.reason.trim().length === 0)
    ) {
      return yield* invalid('A reason is required for disable or archive');
    }
    const allowed =
      (target.status === 'active' && ['disabled', 'archived'].includes(input.newStatus)) ||
      (target.status === 'disabled' && ['active', 'archived'].includes(input.newStatus));
    if (!allowed) {
      return yield* conflict('The principal status transition is not allowed');
    }
    const updated = yield* Effect.tryPromise({
      catch: persistenceFailure,
      try: async () => await repository.updatePrincipalStatus(input),
    });
    if (updated === undefined) {
      return yield* conflict('The principal status changed concurrently');
    }
    return { previousStatus: input.expectedStatus, status: updated.status };
  });

export interface BindApiKeyInput {
  readonly managed: boolean;
  readonly principalId: string;
  readonly providerSubjectId: string;
  readonly tenantId: string;
}

export const bindApiKey = (
  repository: PrincipalManagementRepositoryService,
  input: BindApiKeyInput,
): Effect.Effect<
  { readonly authBindingId: string; readonly status: 'active' },
  PrincipalManagementError
> =>
  Effect.gen(function* bindKey() {
    const target = yield* loadPrincipal(repository, input.tenantId, input.principalId);
    const allowedKinds: readonly PrincipalKind[] = input.managed
      ? ['service', 'integration']
      : ['human'];
    if (target === undefined || target.status !== 'active' || !allowedKinds.includes(target.kind)) {
      return yield* invalid('The API key target is not eligible');
    }
    const created = yield* Effect.tryPromise({
      catch: bindingInsertFailure,
      try: () => repository.insertApiKeyBinding(input),
    });
    if (created === undefined) {
      return yield* persistenceFailure();
    }
    return { authBindingId: created.authBindingId, status: 'active' as const };
  });

export interface SetApiKeyBindingStatusInput {
  readonly authBindingId: string;
  readonly expectedStatus: BindingStatus;
  readonly managed: boolean;
  readonly newStatus: BindingStatus;
  readonly principalId: string;
  readonly reason?: string;
  readonly tenantId: string;
}

export interface ValidateSupportImpersonationInput {
  readonly checkpoint: 'requested' | 'started' | 'stopped';
  readonly originalAuthBindingId: string;
  readonly originalPrincipalId: string;
  readonly targetPrincipalId: string;
  readonly tenantId: string;
}

export const validateSupportImpersonation = (
  repository: PrincipalManagementRepositoryService,
  input: ValidateSupportImpersonationInput,
): Effect.Effect<void, PrincipalManagementError> =>
  Effect.gen(function* validateSupportParticipants() {
    const loadHumanBindings = (principalId: string, authBindingId?: string) =>
      Effect.tryPromise({
        catch: persistenceFailure,
        try: async () => {
          const query = {
            activeOnly: input.checkpoint !== 'stopped',
            principalId,
            tenantId: input.tenantId,
          };
          return await repository.loadSupportBindings(
            authBindingId === undefined ? query : { ...query, authBindingId },
          );
        },
      });
    const original = yield* loadHumanBindings(
      input.originalPrincipalId,
      input.originalAuthBindingId,
    );
    const target = yield* loadHumanBindings(input.targetPrincipalId);
    if (original.length !== 1 || target.length === 0) {
      return yield* invalid(
        input.checkpoint === 'stopped'
          ? 'The impersonation participants are not tenant-local users'
          : 'The impersonation participants are not active tenant-local users',
      );
    }
  });

export const setApiKeyBindingStatus = (
  repository: PrincipalManagementRepositoryService,
  input: SetApiKeyBindingStatusInput,
): Effect.Effect<
  { readonly previousStatus: BindingStatus; readonly status: BindingStatus },
  PrincipalManagementError
> =>
  Effect.gen(function* setBindingStatus() {
    const binding = yield* Effect.tryPromise({
      catch: persistenceFailure,
      try: async () => await repository.loadApiKeyBinding(input),
    });
    if (binding === undefined) {
      return yield* invalid('The API key binding is unavailable');
    }
    const allowedKinds: readonly PrincipalKind[] = input.managed
      ? ['service', 'integration']
      : ['human'];
    if (binding.principalStatus !== 'active' || !allowedKinds.includes(binding.principalKind)) {
      return yield* invalid('The API key binding target is not eligible');
    }
    if (binding.bindingStatus !== input.expectedStatus) {
      return yield* conflict('The binding status changed concurrently');
    }
    if (binding.bindingStatus === 'revoked' || binding.bindingStatus === input.newStatus) {
      return yield* conflict('The binding transition is not allowed');
    }
    if (
      input.newStatus === 'revoked' &&
      (input.reason === undefined || input.reason.trim().length === 0)
    ) {
      return yield* invalid('A reason is required for revocation');
    }
    const allowed =
      (binding.bindingStatus === 'active' && ['disabled', 'revoked'].includes(input.newStatus)) ||
      (binding.bindingStatus === 'disabled' && ['active', 'revoked'].includes(input.newStatus));
    if (!allowed) {
      return yield* conflict('The binding transition is not allowed');
    }
    const updated = yield* Effect.tryPromise({
      catch: persistenceFailure,
      try: async () => await repository.updateApiKeyBindingStatus(input),
    });
    if (updated === undefined) {
      return yield* conflict('The binding status changed concurrently');
    }
    return { previousStatus: input.expectedStatus, status: updated.status };
  });
