import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { legalEntities, principals, tenants } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { ScopedRoleMembershipRole } from '../outbox/core-identity-scoped-role-membership-changed-v1.ts';
import type { PrincipalRef } from '../permissions/principal-ref.ts';
import { IdentityPersistenceUnavailableError, IdentityTargetInvalidError } from './principal-management-errors.ts';

export interface ScopedRoleMembershipCommand {
  readonly operation: 'assign' | 'revoke';
  readonly principalRef: PrincipalRef;
  readonly roleKey: string;
}

const invalid = (reason: string) => new IdentityTargetInvalidError({ code: 'identity_target_invalid', reason });
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'Scoped role membership could not be recorded',
    }),
    'cause',
    { value: cause },
  );

/** The row lock orders standard Action evidence; it stores no desired grant or role policy. */
export const scopedRoleMembershipManagementFromTransaction = (
  transaction: Pick<ScopedTransactionExecutor, 'select' | 'scope'>,
) => ({
  prepare: Effect.fn('ScopedRoleMembershipManagement.prepare')(function* prepare(input: ScopedRoleMembershipCommand) {
    const { legalEntityId, tenantId } = transaction.scope;
    if (input.principalRef.tenantId !== tenantId) {
      return yield* invalid('Scoped role membership requires a tenant-local PrincipalRef');
    }
    const [target] = yield* transaction
      .select({ kind: principals.kind, status: principals.status, tenantStatus: tenants.status })
      .from(principals)
      .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
      .where(and(eq(principals.tenantId, tenantId), eq(principals.principalId, input.principalRef.principalId)))
      .for('no key update', { of: principals })
      .pipe(Effect.mapError(unavailable));
    if (target === undefined || (target.kind !== 'human' && target.kind !== 'agent')) {
      return yield* invalid('Scoped roles require an existing working actor');
    }
    if (input.operation === 'assign' && (target.status !== 'active' || target.tenantStatus !== 'active')) {
      return yield* invalid('Scoped roles cannot be assigned to an inactive actor or tenant');
    }
    if (legalEntityId !== undefined) {
      const [company] = yield* transaction
        .select({ status: legalEntities.status })
        .from(legalEntities)
        .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.legalEntityId, legalEntityId)))
        .pipe(Effect.mapError(unavailable));
      if (company === undefined || (input.operation === 'assign' && company.status !== 'active')) {
        return yield* invalid('Scoped roles require the exact company and cannot be assigned in an inactive company');
      }
    }
    return {
      roleKey: input.roleKey,
      scope: legalEntityId === undefined ? { _tag: 'tenant' } : { _tag: 'company', legalEntityId },
      tenantId,
    } satisfies ScopedRoleMembershipRole;
  }),
});
