import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import type { ResourceAccessTarget } from '@app/core-runtime';
import { Effect, Option } from 'effect';
import type { CommerceCustomerProfileSubject } from '../../shared/domain/group-contract.ts';
import type {
  CustomerGroupLookupOutcome,
  CustomerGroupPersistence,
} from '../../shared/domain/group-service.ts';
import type { CustomerGroupRef } from '../../shared/resources/customer-group.ts';
import { customerGroupServiceFactory } from '../actions/customer-group-action-support.ts';

export const customerGroupReadServiceFactory: typeof customerGroupServiceFactory = (
  transaction,
  scope,
) => customerGroupServiceFactory(transaction, scope);

export const customerGroupReadUnavailable = (cause?: unknown): ReadHandlerUnavailable => {
  const failure = new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'Commerce Customer Group persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

export const customerGroupReadNotFound = (): ReadHandlerNotFound =>
  new ReadHandlerNotFound({
    code: 'read_handler_not_found',
    reason: 'The requested Commerce Customer Group information does not exist',
  });

export const unwrapCustomerGroupLookup = <Value>(
  outcome: CustomerGroupLookupOutcome<Value>,
): Effect.Effect<Value, ReadHandlerNotFound> =>
  Option.match(outcome, {
    onNone: () => Effect.fail(customerGroupReadNotFound()),
    onSome: (value) => Effect.succeed(value),
  });

export const customerGroupResourceTarget = (groupRef: CustomerGroupRef) => ({
  kind: 'resource' as const,
  resource: {
    moduleId: groupRef.moduleId,
    resourceId: groupRef.resourceId,
    resourceType: groupRef.resourceType,
  },
});

export const customerProfileResourceTarget = (
  profile: CommerceCustomerProfileSubject,
): ResourceAccessTarget => ({
  moduleId: profile.profileRef.moduleId,
  resourceId: profile.profileRef.resourceId,
  resourceType: profile.profileRef.resourceType,
});

export const groupResourceAccessTarget = (groupRef: CustomerGroupRef): ResourceAccessTarget => ({
  moduleId: groupRef.moduleId,
  resourceId: groupRef.resourceId,
  resourceType: groupRef.resourceType,
});

export const requireCustomerGroupTenant = (
  trustedTenantId: string,
  ...refs: readonly Readonly<{ tenantId: string }>[]
): Effect.Effect<void, ReadHandlerNotFound> =>
  refs.every((ref) => ref.tenantId === trustedTenantId)
    ? Effect.void
    : Effect.fail(customerGroupReadNotFound());

export const requireCustomerGroupReadLegalEntityId = (
  legalEntityId: string | undefined,
): Effect.Effect<string, ReadHandlerUnavailable> =>
  legalEntityId === undefined
    ? Effect.fail(customerGroupReadUnavailable())
    : Effect.succeed(legalEntityId);

export type CustomerGroupReadServices = CustomerGroupPersistence;
