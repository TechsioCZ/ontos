import {
  ActiveApplicationCompositionService,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import type { VerifiedGatewayActor } from '@app/core-runtime/auth/system-principal-context-provenance';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { CommittedOrderApprovalEvidenceResponseSchema } from '@app/commerce-order-contracts/committed-order-approval-evidence';
import { Cause, ConfigProvider, Crypto, DateTime, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { getActionServicePreflight } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';
import {
  insideDatabaseTransaction,
  refuseInsideDatabaseTransaction,
} from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { consumeOrderPurchaseApprovalAction } from '../../src/actions/consume-order-purchase-approval.action.ts';
import { ConsumeOrderPurchaseApprovalPayloadSchema } from '../../shared/actions/consume-order-purchase-approval.ts';
import { orderFinalizationSnapshotFixture } from './order-finalization-fixtures.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const authenticationNamespaceId = 'ontos.shell.better-auth.v1';
const configuration = Layer.merge(
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ONTOS_COMMERCE_ORDER_API_BASE_URL: 'https://order.example.test/commerce-order-api',
      ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
    }),
  ),
  Layer.effectDiscard(
    holdTestModuleCredentials({ 'commerce-customer-context': 'test-only-customer-context-module-key' }),
  ),
);
const moduleActor = (appId: string): VerifiedGatewayActor => ({
  appId,
  buildMarker: `${appId}-build-fixture`,
  principalId: '70000000-0000-4000-8000-000000000001',
});
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => new Uint8Array(size).fill(7),
});

const fixture = Effect.fn('OrderConsumptionPreflightTest.fixture')(function* fixture() {
  const snapshot = yield* makeApplicationCompositionSnapshotFixture();
  const compositionRevision = snapshot.composition.revision;
  const now = yield* DateTime.now;
  const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
    moduleId,
    resourceId,
    resourceType,
    tenantId,
  });
  const payload = yield* Schema.decodeUnknownEffect(Schema.toType(ConsumeOrderPurchaseApprovalPayloadSchema))({
    finalBinding: {
      attemptRef: ref('commerce.order', 'commerce.order.commitment-attempt', 'attempt'),
      bundleHash: 'c'.repeat(64),
      bundleRef: ref('commerce.order', 'commerce.order.acceptance-bundle', 'bundle'),
      bundleVersion: 'order-acceptance-bundle.v1',
    },
    idempotencyKey: 'exact-order-consumption',
    orderRef: ref('commerce.order', 'commerce.order.order', 'order'),
    revalidationRef: ref('commerce.customer-context', 'commerce.customer-context.approval-revalidation', 'proof'),
  });
  const retained = orderFinalizationSnapshotFixture.request;
  // The subject is the approval's buyer; the Order module is the actor the Shell signed.
  const subject = {
    authBindingId: '30000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:buyer',
    authenticationNamespaceId,
    authMethod: 'session',
    legalEntityId,
    principalId: retained.proposal.identity.buyer.principalId,
    tenantId,
  };
  const scopeAssertion = {
    assertion: Redacted.make('test-only-source-assertion'),
    audience: 'commerce-customer-context',
  };
  const scopeActingAs = (actor?: VerifiedGatewayActor, overrides: Readonly<Record<string, string>> = {}) =>
    trustVerifiedGatewayPrincipalContext(
      {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({ ...subject, ...overrides }),
        correlationId: 'order-consumption-preflight',
      },
      compositionRevision,
      scopeAssertion,
      actor,
    );
  const scope = scopeActingAs(moduleActor('commerce-order'));
  const preflight = getActionServicePreflight(consumeOrderPurchaseApprovalAction);
  if (preflight === undefined) {
    return yield* Effect.die('The Order consumption Action must register preparation');
  }
  const context = {
    actionInvocationId: '50000000-0000-4000-8000-000000000001',
    compositionRevision,
    evaluatePolicy: () => Effect.die('Order evidence preparation does not evaluate execution Policies'),
    scope,
    transaction: () => Effect.die('Immutable Order selectors must not open SQL during preparation'),
  } satisfies Parameters<typeof preflight>[1];
  const evidence = yield* Schema.decodeUnknownEffect(Schema.toType(CommittedOrderApprovalEvidenceResponseSchema))({
    ...payload,
    buyerPrincipalId: retained.proposal.identity.buyer.principalId,
    commitmentCorrelationId: 'exact-committed-attempt',
    committedAt: now,
    consumptionIntent: payload.idempotencyKey,
    counterpartyRef: retained.proposal.identity.counterpartyRef,
    decisionBundleHash: 'b'.repeat(64),
    decisionBundleVersion: 'approval-decision-bundle.v1',
    legalEntityId,
    observedAt: now,
    proposalHash: retained.proposal.canonicalHash,
    proposalRevisionRef: retained.proposal.proposalRevisionRef,
    provenance: 'commerce.order.committed-approval-evidence.v1',
    requestRef: retained.requestRef,
    storefrontId: retained.proposal.context.storefrontId,
    tenantId,
    validUntil: DateTime.add(now, { seconds: 30 }),
  });
  const requests: Request[] = [];
  const responses: unknown[] = [];
  const fakeFetch: typeof fetch = (target, init) => {
    requests.push(new Request(target, init));
    return Promise.resolve(Response.json(responses.shift()));
  };
  const gatewayResponse = {
    apiBaseUrl: '/commerce-order-api',
    compositionRevision,
    expiresAt: Math.floor(DateTime.toEpochMillis(now) / 1000) + 30,
    token: 'test-only-gateway-assertion',
  };
  const dependencies = Layer.mergeAll(
    configuration,
    Layer.succeed(ActiveApplicationCompositionService, {
      load: refuseInsideDatabaseTransaction('module-transport', 'composition').pipe(Effect.as(snapshot)),
    }),
    Layer.succeed(Crypto.Crypto, crypto),
    Layer.succeed(FetchHttpClient.Fetch, fakeFetch),
  );
  return {
    context,
    dependencies,
    evidence,
    gatewayResponse,
    now,
    payload,
    preflight,
    requests,
    responses,
    scopeActingAs,
  };
});

it.effect('prepares committed Order evidence through real clients with SQL released', () =>
  Effect.gen(function* releasedOrderObservation() {
    const test = yield* fixture();
    test.responses.push(
      test.gatewayResponse,
      yield* Schema.encodeEffect(CommittedOrderApprovalEvidenceResponseSchema)(test.evidence),
    );
    expect(yield* test.preflight(test.payload, test.context).pipe(Effect.provide(test.dependencies))).toBeDefined();
    expect(test.requests.map((request) => request.url)).toEqual([
      'https://shell.example.test/shell-super-app-api/auth/delegated/gateway-context',
      'https://order.example.test/commerce-order-api/reads/committed-order-approval-evidence',
    ]);
    // Customer Context authenticates with its own module credential and delegates the buyer's verified assertion.
    expect(test.requests[0].headers.get('x-api-key')).toBe('test-only-customer-context-module-key');
    expect(yield* Effect.promise(() => test.requests[0].json())).toMatchObject({
      audience: 'commerce-order',
      legalEntityScope: 'subject',
      subject: { _tag: 'Assertion', sourceAssertion: 'test-only-source-assertion' },
    });
    expect(yield* Effect.promise(() => test.requests[1].json())).toEqual({
      finalBinding: test.payload.finalBinding,
      orderRef: test.payload.orderRef,
      revalidationRef: test.payload.revalidationRef,
    });
    expect(test.requests[1].headers.get('authorization')).toBe('Bearer test-only-gateway-assertion');
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect('rejects wrong owner bindings and expired observations before opening SQL', () =>
  Effect.gen(function* invalidOrderObservation() {
    const test = yield* fixture();
    const invalid = [
      { ...test.evidence, orderRef: { ...test.evidence.orderRef, resourceId: 'foreign-order' } },
      { ...test.evidence, consumptionIntent: 'foreign-consumption' },
      { ...test.evidence, legalEntityId: '90000000-0000-4000-8000-000000000001' },
      { ...test.evidence, validUntil: test.now },
      { ...test.evidence, observedAt: DateTime.add(test.now, { seconds: 1 }) },
      { ...test.evidence, validUntil: DateTime.add(test.now, { seconds: 31 }) },
    ];
    for (const evidence of invalid) {
      test.responses.push(
        test.gatewayResponse,
        yield* Schema.encodeEffect(CommittedOrderApprovalEvidenceResponseSchema)(evidence),
      );
      const failure = yield* test
        .preflight(test.payload, test.context)
        .pipe(Effect.provide(test.dependencies), Effect.flip);
      expect(failure.code).toBe('COMMIT_CONFLICT');
    }
    expect(test.requests).toHaveLength(invalid.length * 2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect('admits only the verified Order module acting for an unimpersonated subject', () =>
  Effect.gen(function* actorAdmission() {
    const test = yield* fixture();
    const scopes = [
      // The same fields without Core's provenance are a raw request, not a verified actor.
      { ...test.context.scope },
      // A verified subject without a calling module is a person, not the Order service.
      test.scopeActingAs(),
      // Any other module, even a verified one, may not consume an Order approval.
      test.scopeActingAs(moduleActor('pricing')),
      test.scopeActingAs(moduleActor('commerce-cart')),
      test.scopeActingAs(moduleActor('commerce-order'), {
        authMethod: 'support_impersonation',
        impersonatedByPrincipalId: '80000000-0000-4000-8000-000000000001',
      }),
    ];
    for (const scope of scopes) {
      const failure = yield* test
        .preflight(test.payload, { ...test.context, scope })
        .pipe(Effect.provide(test.dependencies), Effect.flip);
      expect(failure.code).toBe('PERMISSION_DENIED');
    }
    expect(test.requests).toHaveLength(0);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect('keeps the transaction guard effective against an in-SQL preparation call', () =>
  Effect.gen(function* guardedNegativeControl() {
    const test = yield* fixture();
    const exit = yield* test
      .preflight(test.payload, test.context)
      .pipe(
        insideDatabaseTransaction('commerce.customer-context.consume-order-purchase-approval'),
        Effect.provide(test.dependencies),
        Effect.exit,
      );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain('IoInsideDatabaseTransaction');
    }
    expect(test.requests).toHaveLength(0);
  }).pipe(Effect.provide(TestClock.layer())),
);
