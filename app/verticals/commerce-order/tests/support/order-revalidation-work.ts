import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';

import { RevalidateOrderCommitmentPayloadSchema } from '../../shared/actions/revalidate-order-commitment.ts';
import { revalidateOrderCommitmentAction } from '../../src/actions/revalidate-order-commitment.action.ts';
import type { OrderCommitmentServices } from '../../src/services/order-commitment.service.ts';
import { commerceOrderRegistration } from '../../vertical.registration.ts';

export const orderTenantId = '40000000-0000-4000-8000-000000000001';
export const orderLegalEntityId = '30000000-0000-4000-8000-000000000001';
/** The fixed composition revision the in-memory Core Action harness admits. */
export const harnessAdmittedRevision = 'a'.repeat(64);
export const orderProofRequestRef = {
  moduleId: 'commerce.order',
  resourceId: 'proof-request',
  resourceType: 'commerce.order.proof-request',
  tenantId: orderTenantId,
} as const;

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:order-finalization-completion',
  authMethod: 'session',
  legalEntityId: orderLegalEntityId,
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: orderTenantId,
} as const;
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.order',
  resourceId,
  resourceType,
  tenantId: orderTenantId,
});
const payload = Schema.decodeUnknownSync(RevalidateOrderCommitmentPayloadSchema)({
  binding: {
    attemptRef: ref('commerce.order.commitment-attempt', 'attempt'),
    bundleHash: 'b'.repeat(64),
    bundleRef: ref('commerce.order.acceptance-bundle', 'bundle'),
    bundleVersion: 'order-acceptance-bundle.v1',
  },
  idempotencyKey: 'revalidate:1',
});
const unreachable = () => Effect.die('Only Order revalidation is exercised');

/**
 * Runs the registered revalidation Action and its real handler through Core's Action harness.
 * Only owner persistence is substituted. Prepare, commit and reconcile enqueue through the same
 * helper, but need the genuine multi-owner Bundle or tax candidate to run.
 */
export const runOrderRevalidation = Effect.fn('OrderRevalidationWork.run')(function* runOrderRevalidation(
  status: 'FAILED' | 'PROOFS_PENDING',
) {
  const services: OrderCommitmentServices = {
    cancel: unreachable,
    commit: unreachable,
    completeConsumption: unreachable,
    completePreparation: unreachable,
    loadWork: unreachable,
    prepare: unreachable,
    reconcile: unreachable,
    recordPrecommitFailure: unreachable,
    recordProofSet: unreachable,
    revalidate: () =>
      Effect.succeed({
        binding: payload.binding,
        intentRef: orderProofRequestRef,
        revalidationRef: null,
        status,
        validUntil: null,
      }),
  };
  const harness = yield* makeActionTestHarness({
    actionPermission: 'allowed',
    legalEntityPermission: 'allowed',
    ownerRegistration: commerceOrderRegistration,
    services: [bindActionTestServices(revalidateOrderCommitmentAction, services)],
    tenantPermission: 'allowed',
  });
  yield* harness.runtime
    .runAction({
      payload,
      principal,
      registration: revalidateOrderCommitmentAction,
      transport: { correlationId: 'order-finalization-completion', idempotencyKey: 'transport:1' },
    })
    .pipe(Effect.provide(NodeCrypto.layer));
  return harness.snapshot().committed;
});
