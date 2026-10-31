import { CoreSearchResourceRefSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { getActionServicePreflight } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { consumePurchaseApprovalAction } from '../../src/actions/consume-purchase-approval.action.ts';
import { PurchaseApprovalFinalBindingAuthority } from '../../shared/domain/purchase-approval-currentness-port.ts';
import type { PurchaseApprovalFinalBindingAuthorityService } from '../../shared/domain/purchase-approval-currentness-port.ts';
import {
  ConsumePurchaseApprovalPayloadSchema,
  ConsumePurchaseApprovalRejected,
} from '../../shared/actions/consume-purchase-approval.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const compositionRevision = 'a'.repeat(64);
const resource = (moduleId: string, resourceType: string, resourceId: string) =>
  Schema.decodeUnknownSync(CoreSearchResourceRefSchema)({ moduleId, resourceId, resourceType, tenantId });

const fixture = Effect.fn('ConsumptionPreflightTest.fixture')(function* fixture() {
  const now = yield* DateTime.now;
  const payload = yield* Schema.decodeUnknownEffect(Schema.toType(ConsumePurchaseApprovalPayloadSchema))({
    commitmentCorrelationId: 'exact-owner-attempt',
    committedAt: now,
    counterpartyRef: resource('party.registry', 'party.registry.counterparty', 'counterparty'),
    decisionBundleHash: 'b'.repeat(64),
    decisionBundleVersion: 'approval-decision-bundle.v1',
    finalBinding: {
      attemptRef: resource('commerce.order', 'commerce.order.commitment-attempt', 'attempt'),
      bundleHash: 'c'.repeat(64),
      bundleRef: resource('commerce.order', 'commerce.order.final-bundle', 'bundle'),
      bundleVersion: 'final-order.v1',
    },
    idempotencyKey: 'exact-owner-consumption',
    orderRef: resource('commerce.order', 'commerce.order.order', 'order'),
    proposalRevisionRef: resource(
      'commerce.customer-context',
      'commerce.customer-context.purchase-proposal-revision',
      'proposal',
    ),
    requestRef: resource('commerce.customer-context', 'commerce.customer-context.purchase-approval-request', 'request'),
    revalidationRef: resource('commerce.customer-context', 'commerce.customer-context.approval-revalidation', 'proof'),
    storefrontId: 'storefront',
  });
  const scope = trustVerifiedGatewayPrincipalContext(
    {
      authBindingId: '30000000-0000-4000-8000-000000000001',
      authContextRef: 'better-auth-api-key:exact-final-order',
      authMethod: 'api_key',
      correlationId: 'exact-final-order',
      legalEntityId,
      principalId: '40000000-0000-4000-8000-000000000001',
      tenantId,
      trustedStorefrontId: 'storefront',
    },
    compositionRevision,
  );
  const context = {
    actionInvocationId: '50000000-0000-4000-8000-000000000001',
    compositionRevision,
    scope,
    transaction: () => Effect.die('Immutable Order observation must not open a SQL transaction'),
  };
  const preflight = getActionServicePreflight(consumePurchaseApprovalAction);
  if (preflight === undefined || payload.finalBinding === undefined || payload.revalidationRef === undefined) {
    return yield* Effect.die('Consumption must register its preparation and this fixture must name the exact proof');
  }
  const commitment = {
    bindingEvidence: {
      binding: payload.finalBinding,
      observedAt: now,
      provenance: 'TEST_EXACT_FINAL_OWNER_OBSERVATION',
      validUntil: DateTime.add(now, { seconds: 30 }),
    },
    orderRef: payload.orderRef,
    revalidationRef: payload.revalidationRef,
  };
  return { commitment, context, now, payload, preflight };
});

it.effect('observes the exact final owner before SQL and keeps legacy replay free of remote authority', () =>
  Effect.gen(function* releasedObservation() {
    const test = yield* fixture();
    let calls = 0;
    const authority: PurchaseApprovalFinalBindingAuthorityService = {
      verifyConsumption: ({ claimed, scope }) => {
        expect(claimed).toEqual(test.payload);
        expect(scope).toBe(test.context.scope);
        calls += 1;
        return Effect.succeed(test.commitment);
      },
      verifyRevalidation: () => Effect.die('Consumption must not acquire a revalidation proof'),
    };
    expect(
      yield* test
        .preflight(test.payload, test.context)
        .pipe(Effect.provideService(PurchaseApprovalFinalBindingAuthority, authority)),
    ).toBeDefined();
    expect(calls).toBe(1);
    const { finalBinding: ignoredBinding, revalidationRef: ignoredRef, ...legacy } = test.payload;
    expect(ignoredBinding).toBeDefined();
    expect(ignoredRef).toBeDefined();
    expect(
      yield* test
        .preflight(legacy, test.context)
        .pipe(Effect.provideService(PurchaseApprovalFinalBindingAuthority, authority)),
    ).toBeDefined();
    expect(calls).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect('rejects missing authority, untrusted actors and wrong or expired owner proof without opening SQL', () =>
  Effect.gen(function* failedObservation() {
    const test = yield* fixture();
    expect((yield* test.preflight(test.payload, test.context).pipe(Effect.flip)).code).toBe(
      'CURRENT_STATE_INDETERMINATE',
    );
    expect(
      (yield* test.preflight(test.payload, { ...test.context, scope: { ...test.context.scope } }).pipe(Effect.flip))
        .code,
    ).toBe('PERMISSION_DENIED');
    const invalid = [
      { ...test.commitment, orderRef: { ...test.commitment.orderRef, resourceId: 'other-order' } },
      { ...test.commitment, revalidationRef: { ...test.commitment.revalidationRef, resourceId: 'other-proof' } },
      {
        ...test.commitment,
        bindingEvidence: {
          ...test.commitment.bindingEvidence,
          binding: { ...test.commitment.bindingEvidence.binding, bundleHash: 'd'.repeat(64) },
        },
      },
      { ...test.commitment, bindingEvidence: { ...test.commitment.bindingEvidence, validUntil: test.now } },
      {
        ...test.commitment,
        bindingEvidence: { ...test.commitment.bindingEvidence, observedAt: DateTime.add(test.now, { minutes: 1 }) },
      },
    ];
    for (const [index, commitment] of invalid.entries()) {
      const failure = yield* test.preflight(test.payload, test.context).pipe(
        Effect.provideService(PurchaseApprovalFinalBindingAuthority, {
          verifyConsumption: () => Effect.succeed(commitment),
          verifyRevalidation: () => Effect.die('Unexpected authority operation'),
        }),
        Effect.flip,
      );
      expect(Schema.is(ConsumePurchaseApprovalRejected)(failure)).toBe(true);
      expect(failure.code).toBe(index < 3 ? 'PERMISSION_DENIED' : 'CURRENT_STATE_INDETERMINATE');
    }
  }).pipe(Effect.provide(TestClock.layer())),
);
