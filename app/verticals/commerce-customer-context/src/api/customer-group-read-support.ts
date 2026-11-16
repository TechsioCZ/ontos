import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  CommerceCustomerGroupMembership,
  CommerceCustomerGroupMembershipRead,
} from '../../shared/domain/group-contract.ts';
import type { CustomerGroupLookupOutcome, CustomerGroupPersistence } from '../../shared/domain/group-service.ts';

export { customerGroupServiceFactory as customerGroupReadServiceFactory } from '../actions/customer-group-action-support.ts';

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

const customerGroupReadNotFound = (cause?: unknown): ReadHandlerNotFound => {
  const failure = new ReadHandlerNotFound({
    code: 'read_handler_not_found',
    reason: 'The requested Commerce Customer Group information does not exist',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

export const unwrapCustomerGroupLookup = <Value>(
  outcome: CustomerGroupLookupOutcome<Value>,
): Effect.Effect<Value, ReadHandlerNotFound> =>
  Effect.fromOption(outcome).pipe(Effect.mapError((cause) => customerGroupReadNotFound(cause)));

export const requireCustomerGroupTenant = (
  trustedTenantId: string,
  ...refs: readonly Readonly<{ tenantId: string }>[]
): Effect.Effect<void, ReadHandlerNotFound> =>
  refs.every((ref) => ref.tenantId === trustedTenantId) ? Effect.void : Effect.fail(customerGroupReadNotFound());

export const requireCustomerGroupReadLegalEntityId = (
  legalEntityId: string | undefined,
): Effect.Effect<string, ReadHandlerUnavailable> =>
  legalEntityId === undefined ? Effect.fail(customerGroupReadUnavailable()) : Effect.succeed(legalEntityId);

const projectMembershipRemoval = ({ source, ...removal }: NonNullable<CommerceCustomerGroupMembership['removal']>) =>
  source === undefined ? removal : { ...removal, source: { order: source.order } };

export const projectCustomerGroupMembershipRead = ({
  management,
  removal,
  ...membership
}: CommerceCustomerGroupMembership): CommerceCustomerGroupMembershipRead => {
  const projected = { ...membership, removal: removal === null ? null : projectMembershipRemoval(removal) };
  if (management === undefined) {
    return projected;
  }
  return {
    ...projected,
    management:
      management.kind === 'EXTERNAL_SOURCE'
        ? { ...management, source: { order: management.source.order } }
        : management,
  };
};

export type CustomerGroupReadServices = CustomerGroupPersistence;
