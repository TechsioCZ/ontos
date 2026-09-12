import type { ActionHandlerContext, ReadServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { DateTime, Effect } from 'effect';
import type { CustomerGroupPersistence } from '../../shared/domain/group-service.ts';
import type { CommerceCustomerProfileSubject } from '../../shared/domain/group-contract.ts';
import { CustomerGroupScopeMismatch } from '../../shared/domain/group-errors.ts';
import type { CustomerGroupMembershipRef } from '../../shared/resources/customer-group-membership.ts';
import type { CustomerGroupRef } from '../../shared/resources/customer-group.ts';
import { customerGroupPersistenceForTransaction } from '../persistence/group-persistence.ts';

export type CustomerGroupActionContext = ActionHandlerContext<
  Readonly<Record<string, never>>,
  CustomerGroupPersistence
>;

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

export const customerGroupWritePermission = (groupRef: CustomerGroupRef) => ({
  permission: 'write' as const,
  resource: {
    moduleId: groupRef.moduleId,
    resourceId: groupRef.resourceId,
    resourceType: groupRef.resourceType,
  },
});

export const customerGroupMembershipWritePermission = (membershipRef: CustomerGroupMembershipRef) => ({
  permission: 'write' as const,
  resource: {
    moduleId: membershipRef.moduleId,
    resourceId: membershipRef.resourceId,
    resourceType: membershipRef.resourceType,
  },
});

export const customerProfileWritePermission = (profile: CommerceCustomerProfileSubject) => ({
  permission: 'write' as const,
  resource: {
    moduleId: profile.profileRef.moduleId,
    resourceId: profile.profileRef.resourceId,
    resourceType: profile.profileRef.resourceType,
  },
});

export const customerGroupScopeMatches = (
  tenantId: string,
  ...refs: readonly Readonly<{ tenantId: string }>[]
): boolean => refs.every((ref) => ref.tenantId === tenantId);
