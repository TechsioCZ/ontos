// @effect-diagnostics asyncFunction:off globalDateInEffect:off
import { and, eq, isNull } from 'drizzle-orm';
import { Effect } from 'effect';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { principalAuthBindings, principals } from '../db/schema.ts';
import type { BindingStatus, PrincipalKind, PrincipalStatus } from '../db/schema.ts';
import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
} from './principal-management-errors.ts';
import type { PrincipalManagementError } from './principal-management-errors.ts';

const persistenceFailure = () =>
  new IdentityPersistenceUnavailableError({
    code: 'identity_persistence_unavailable',
    reason: 'Identity state could not be persisted',
  });
const conflict = (reason: string) =>
  new IdentityLifecycleConflictError({ code: 'identity_lifecycle_conflict', reason });
const invalid = (reason: string) =>
  new IdentityTargetInvalidError({ code: 'identity_target_invalid', reason });
const hasDatabaseErrorCode = (error: unknown, expectedCode: string): boolean => {
  let current = error;
  const visited = new Set<object>();
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    if ('code' in current && current.code === expectedCode) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
};
const bindingInsertFailure = (error: unknown): PrincipalManagementError =>
  hasDatabaseErrorCode(error, '23505')
    ? conflict('The API key is already bound')
    : persistenceFailure();

const loadPrincipal = (
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  principalId: string,
) =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      const [record] = await transaction
        .select({ kind: principals.kind, status: principals.status })
        .from(principals)
        .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, principalId)))
        .limit(1);
      return record;
    },
  });

export interface CreateNonHumanPrincipalInput {
  readonly displayName: string;
  readonly kind: Extract<PrincipalKind, 'integration' | 'service' | 'system'>;
  readonly tenantId: string;
}

export const createNonHumanPrincipal = (
  transaction: ScopedTransactionExecutor,
  input: CreateNonHumanPrincipalInput,
): Effect.Effect<
  { readonly principalId: string; readonly status: 'active' },
  PrincipalManagementError
> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      const [created] = await transaction
        .insert(principals)
        .values({
          displayName: input.displayName,
          kind: input.kind,
          status: 'active',
          tenantId: input.tenantId,
        })
        .returning({ principalId: principals.principalId, status: principals.status });
      if (created === undefined) {
        throw new Error('principal insert returned no row');
      }
      return { principalId: created.principalId, status: 'active' as const };
    },
  });

export interface ChangePrincipalStatusInput {
  readonly expectedStatus: PrincipalStatus;
  readonly newStatus: PrincipalStatus;
  readonly principalId: string;
  readonly reason?: string;
  readonly tenantId: string;
}

export const changePrincipalStatus = (
  transaction: ScopedTransactionExecutor,
  input: ChangePrincipalStatusInput,
): Effect.Effect<
  { readonly previousStatus: PrincipalStatus; readonly status: PrincipalStatus },
  PrincipalManagementError
> =>
  Effect.gen(function* changeStatus() {
    const target = yield* loadPrincipal(transaction, input.tenantId, input.principalId);
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
    const [updated] = yield* Effect.tryPromise({
      catch: persistenceFailure,
      try: () =>
        transaction
          .update(principals)
          .set({
            disabledAt: input.newStatus === 'disabled' ? new Date() : null,
            status: input.newStatus,
          })
          .where(
            and(
              eq(principals.tenantId, input.tenantId),
              eq(principals.principalId, input.principalId),
              eq(principals.status, input.expectedStatus),
            ),
          )
          .returning({ status: principals.status }),
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
  transaction: ScopedTransactionExecutor,
  input: BindApiKeyInput,
): Effect.Effect<
  { readonly authBindingId: string; readonly status: 'active' },
  PrincipalManagementError
> =>
  Effect.gen(function* bindKey() {
    const target = yield* loadPrincipal(transaction, input.tenantId, input.principalId);
    const allowedKinds: readonly PrincipalKind[] = input.managed
      ? ['service', 'integration']
      : ['human'];
    if (target === undefined || target.status !== 'active' || !allowedKinds.includes(target.kind)) {
      return yield* invalid('The API key target is not eligible');
    }
    return yield* Effect.tryPromise({
      catch: bindingInsertFailure,
      try: async () => {
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
        if (created === undefined) {
          throw new Error('binding insert returned no row');
        }
        return { authBindingId: created.authBindingId, status: 'active' as const };
      },
    });
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
  transaction: ScopedTransactionExecutor,
  input: ValidateSupportImpersonationInput,
): Effect.Effect<void, PrincipalManagementError> =>
  Effect.gen(function* validateSupportParticipants() {
    const loadHumanBindings = (principalId: string, authBindingId?: string) =>
      Effect.tryPromise({
        catch: persistenceFailure,
        try: () =>
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
                eq(principalAuthBindings.principalId, principalId),
                eq(principalAuthBindings.subjectType, 'user'),
                eq(principals.kind, 'human'),
                ...(input.checkpoint === 'stopped'
                  ? []
                  : [
                      eq(principalAuthBindings.status, 'active'),
                      isNull(principalAuthBindings.revokedAt),
                      eq(principals.status, 'active'),
                    ]),
                ...(authBindingId === undefined
                  ? []
                  : [eq(principalAuthBindings.principalAuthBindingId, authBindingId)]),
              ),
            )
            .limit(2),
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
  transaction: ScopedTransactionExecutor,
  input: SetApiKeyBindingStatusInput,
): Effect.Effect<
  { readonly previousStatus: BindingStatus; readonly status: BindingStatus },
  PrincipalManagementError
> =>
  Effect.gen(function* setBindingStatus() {
    const binding = yield* Effect.tryPromise({
      catch: persistenceFailure,
      try: async () => {
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
    const [updated] = yield* Effect.tryPromise({
      catch: persistenceFailure,
      try: () =>
        transaction
          .update(principalAuthBindings)
          .set({
            revokedAt: input.newStatus === 'revoked' ? new Date() : null,
            status: input.newStatus,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(principalAuthBindings.principalAuthBindingId, input.authBindingId),
              eq(principalAuthBindings.status, input.expectedStatus),
            ),
          )
          .returning({ status: principalAuthBindings.status }),
    });
    if (updated === undefined) {
      return yield* conflict('The binding status changed concurrently');
    }
    return { previousStatus: input.expectedStatus, status: updated.status };
  });
