import {
  addContactPoint,
  counterpartyCustomerOnboard,
  createParty,
  executeDuplicateCandidateDetail,
  listCustomers,
  resolveDuplicateCandidateCreate,
  resolvePartyCommandCommit,
} from '@app/party-registry/api/client';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { Effect } from 'effect';
import type { Order } from '../../../../../shared/apis/records.ts';
import { convertOrderCustomer } from '../../../../../shared/order-customer-conversion.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';

const owners = {
  contact: (...args: Parameters<typeof addContactPoint>) => addContactPoint(...args).pipe(Effect.asVoid),
  create: createParty,
  customers: listCustomers({ limit: 500 }),
  detail: (payload: Parameters<typeof executeDuplicateCandidateDetail>[0]) =>
    executeDuplicateCandidateDetail(payload, 'merchandise-order-customer-review'),
  onboard: counterpartyCustomerOnboard,
  recover: (key: string) =>
    resolvePartyCommandCommit(
      { actionKey: 'party.registry.create-party', idempotencyKey: key },
      { correlationId: 'merchandise-order-customer-recovery' },
    ),
  resolve: resolveDuplicateCandidateCreate,
};
type OwnerEffect =
  | ReturnType<Exclude<(typeof owners)[keyof typeof owners], typeof owners.customers>>
  | typeof owners.customers;

/** Runs only after explicit staff confirmation, using that staff member's native grants. */
export const convertStaffOrderCustomer = Effect.fn('Merchandise.convertStaffOrderCustomer')(function* convert(
  order: Order,
  revision: number,
) {
  const customer = yield* convertOrderCustomer<Effect.Error<OwnerEffect>, Effect.Services<OwnerEffect>>(order, owners);
  // Acquire the single-use assertion only after customer writes succeed, immediately before the link.
  // eslint-disable-next-line effect-native/no-sequential-independent-yields
  const referenceCredentials = yield* makeReferenceGatewayCredentials(['party-registry']);
  return yield* executeApplyCommand(
    {
      command: { _tag: 'LinkOrderCustomer', ...customer, expectedPartyId: order.partyId, id: order.id },
      expectedRevision: revision,
    },
    `merchandise-order-customer:${order.id}`,
    {
      // A link rejected by optimistic concurrency can be retried against the new revision without creating a Party.
      idempotencyKey: `merchandise:order-customer:${order.id}:link:${revision}`,
      referenceCredentials,
    },
  );
});
