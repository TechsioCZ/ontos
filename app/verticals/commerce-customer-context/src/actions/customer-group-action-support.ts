import type { OperationalScope } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { readScopedAdmittedWorkload } from '@app/core-runtime/access/enforcement';
import { DateTime, Effect } from 'effect';
import type { CustomerGroupPersistence } from '../../shared/domain/group-service.ts';
import { CustomerGroupPersistenceUnavailable, CustomerGroupScopeMismatch } from '../../shared/domain/group-errors.ts';
import { customerGroupPersistenceForTransaction } from '../persistence/group-persistence.ts';
import type { CustomerGroupScopedRoutineInvoker } from '../persistence/group-persistence.ts';

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

export const customerGroupServiceFactory = (
  transaction: CustomerGroupScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<CustomerGroupPersistence, OperationContextUnavailable> => {
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Commerce Customer Group operations require a trusted Legal Entity scope',
      }),
    );
  }
  const base = customerGroupPersistenceForTransaction(transaction, scope);
  const admittedSource = readScopedAdmittedWorkload(transaction, scope, 'commerce.customer-context.source-write').pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new CustomerGroupPersistenceUnavailable({
          code: 'customer_group_persistence_unavailable',
          reason: 'Current Group carrier authority is unavailable',
        }),
        'cause',
        { value: cause },
      ),
    ),
  );
  return Effect.succeed({
    ...base,
    create: (command) =>
      command.source === undefined
        ? admittedSource.pipe(
            Effect.flatMap((admitted) =>
              admitted
                ? Effect.succeed({
                    _tag: 'definition_source_rejected' as const,
                    code: 'customer_group_source_authority_denied' as const,
                  })
                : base.create(command),
            ),
          )
        : base.create(command),
    update: (command) =>
      command.source === undefined
        ? admittedSource.pipe(
            Effect.flatMap((admitted) =>
              admitted
                ? Effect.succeed({
                    _tag: 'definition_source_rejected' as const,
                    code: 'customer_group_source_authority_denied' as const,
                  })
                : base.update(command),
            ),
          )
        : base.update(command),
  });
};

export const customerGroupScopeMatches = (
  tenantId: string,
  ...refs: readonly Readonly<{ tenantId: string }>[]
): boolean => refs.every((ref) => ref.tenantId === tenantId);
