import type { ReadServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { DateTime, Effect } from 'effect';
import type { CustomerGroupPersistence } from '../../shared/domain/group-service.ts';
import { CustomerGroupScopeMismatch } from '../../shared/domain/group-errors.ts';
import { customerGroupPersistenceForTransaction } from '../persistence/group-persistence.ts';

export const customerGroupRecordedAt = DateTime.now.pipe(Effect.map((instant) => DateTime.formatIso(instant)));

export const requireCustomerGroupLegalEntityId = (
  legalEntityId: string | undefined,
): Effect.Effect<string, InstanceType<typeof CustomerGroupScopeMismatch>> =>
  legalEntityId === undefined
    ? Effect.fail(
        new CustomerGroupScopeMismatch({
          code: 'customer_group_scope_mismatch',
          reason: 'Commerce Customer Group operations require a trusted Legal Entity scope',
        }),
      )
    : Effect.succeed(legalEntityId);

export const customerGroupServiceFactory: ReadServiceFactory<CustomerGroupPersistence> = (transaction, scope) => {
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Commerce Customer Group operations require a trusted Legal Entity scope',
      }),
    );
  }
  return Effect.succeed(customerGroupPersistenceForTransaction(transaction, { ...scope, legalEntityId }));
};

export const customerGroupScopeMatches = (
  tenantId: string,
  ...refs: readonly Readonly<{ tenantId: string }>[]
): boolean => refs.every((ref) => ref.tenantId === tenantId);
