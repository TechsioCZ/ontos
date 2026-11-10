import {
  ActiveApplicationCompositionService,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, ConfigProvider, DateTime, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { getActionServicePreflight } from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  insideDatabaseTransaction,
  refuseInsideDatabaseTransaction,
} from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { TriggerPurchaseApprovalPayloadSchema } from '../../shared/actions/trigger-purchase-approval.ts';
import { PurchaseLimitEvaluationSourceFactory } from '../../shared/domain/purchase-limit-evaluation.ts';
import { PurchaseLimitEvaluationCurrentnessPort } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { PurchaseApprovalTriggerEvidenceSourceFactory } from '../../src/services/purchase-approval-trigger-evidence-source.ts';
import { createPurchaseProposalRevisionAction } from '../../src/actions/create-purchase-proposal-revision.action.ts';
import { preparePurchaseProposalBasisAction } from '../../src/actions/prepare-purchase-proposal-basis.action.ts';
import { submitPurchaseApprovalRequestAction } from '../../src/actions/submit-purchase-approval-request.action.ts';
import { triggerPurchaseApprovalAction } from '../../src/actions/trigger-purchase-approval.action.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../../src/profile-counterparty-role-eligibility.ts';
import { preparePurchaseProposalBasisActionServices } from '../../src/services/purchase-proposal-basis.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const storefrontId = 'storefront:tenant-a-b2b';
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const purchaseValue = {
  monetaryAmount: { amount: '101', currency: 'CZK' },
  roundingRuleRevision: 'pricing-rounding:3',
  sourceRef: 'purchase-proposal:60000000-0000-4000-8000-000000000001',
  sourceRevision: 'proposal:1',
} as const;
const payload = Schema.decodeUnknownSync(TriggerPurchaseApprovalPayloadSchema)({
  counterpartyRef,
  expectedSourceRevisions: [
    { revision: 'counterparty-policy:1', source: 'counterparty-policy' },
    { revision: 'customer-commerce-policy:1', source: 'customer-commerce-policy' },
    { revision: 'principal-override:none:1', source: 'principal-override' },
    { revision: 'proposal:1', source: 'purchase-proposal' },
    { revision: '1', source: 'purchasing-profile' },
    { revision: 'storefront:1', source: 'storefront-context' },
  ],
  profileRef: {
    kind: 'COUNTERPARTY',
    moduleId: 'commerce.customer-context',
    resourceId: '50000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId,
  },
  proposalRevisionRef: purchaseValue.sourceRef,
  purchaseValue,
  storefrontId,
});
const configuration = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    ONTOS_GATEWAY_MODULE_API_KEY: 'test-only-customer-context-module-key',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
  }),
);

it('registers SQL-free preparation for every purchase Action that reads another owner', () => {
  expect(getActionServicePreflight(triggerPurchaseApprovalAction)).toBeDefined();
  expect(getActionServicePreflight(createPurchaseProposalRevisionAction)).toBeDefined();
  expect(getActionServicePreflight(submitPurchaseApprovalRequestAction)).toBeDefined();
  expect(getActionServicePreflight(preparePurchaseProposalBasisAction)).toBe(
    preparePurchaseProposalBasisActionServices,
  );
});

const triggerPreparation = Effect.fn('PurchaseApprovalPreparationTest.trigger')(function* triggerPreparation() {
  const snapshot = yield* makeApplicationCompositionSnapshotFixture();
  const compositionRevision = snapshot.composition.revision;
  const scope = trustVerifiedGatewayPrincipalContext(
    {
      ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: '70000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:purchase-approval-preparation',
        authMethod: 'session',
        legalEntityId,
        principalId,
        tenantId,
        trustedStorefrontId: storefrontId,
      }),
      correlationId: 'purchase-approval-preparation',
    },
    compositionRevision,
    { assertion: Redacted.make('test-only-source-assertion'), audience: 'commerce-customer-context' },
  );
  const preflight = getActionServicePreflight(triggerPurchaseApprovalAction);
  if (preflight === undefined) {
    return yield* Effect.die('The trigger Action must register preparation');
  }
  const now = yield* DateTime.now;
  const paths: string[] = [];
  const fakeFetch: typeof fetch = (target, init) => {
    const request = new Request(target, init);
    const { pathname } = new URL(request.url);
    paths.push(pathname);
    // The Party answer is deliberately unusable: preparation must report it as unavailable, never as allowed.
    return Promise.resolve(
      pathname.endsWith('/auth/delegated/gateway-context')
        ? Response.json({
            apiBaseUrl: '/party-registry-api',
            compositionRevision,
            expiresAt: Math.floor(DateTime.toEpochMillis(now) / 1000) + 30,
            token: 'test-only-gateway-assertion',
          })
        : Response.json({}),
    );
  };
  const dependencies = Layer.mergeAll(
    configuration,
    profileCounterpartyRoleEligibilityResolverFactoryLive.pipe(Layer.provide(NodeCrypto.layer)),
    Layer.succeed(ActiveApplicationCompositionService, {
      load: refuseInsideDatabaseTransaction('module-transport', 'composition').pipe(Effect.as(snapshot)),
    }),
    Layer.succeed(FetchHttpClient.Fetch, fakeFetch),
    Layer.succeed(PurchaseLimitEvaluationCurrentnessPort, {
      prepare: () => Effect.succeed(() => Effect.die('The commit phase is not part of this preparation test')),
      resolveCandidate: () => Effect.die('Preparation must not resolve candidate currentness in SQL'),
      resolveCurrent: () => Effect.die('Preparation must not resolve currentness in SQL'),
    }),
    // Prepared commits never acquire the transaction-bound sources; preparation must not either.
    Layer.succeed(PurchaseApprovalTriggerEvidenceSourceFactory, {
      make: () => Effect.die('Preparation must not acquire transaction-bound approval evidence'),
    }),
    Layer.succeed(PurchaseLimitEvaluationSourceFactory, {
      make: () => Effect.die('Preparation must not acquire transaction-bound purchase limits'),
    }),
  );
  const run = preflight(payload, {
    actionInvocationId: '80000000-0000-4000-8000-000000000001',
    compositionRevision,
    evaluatePolicy: () => Effect.die('Trigger preparation evaluates no Policy'),
    scope,
    transaction: () => Effect.die('Trigger preparation opens no SQL of its own'),
  });
  return { dependencies, paths, run };
});

it.effect('reads the Counterparty role from Party Registry with SQL released', () =>
  Effect.gen(function* releasedRoleRead() {
    const test = yield* triggerPreparation();
    const exit = yield* test.run.pipe(Effect.provide(test.dependencies), Effect.exit);
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '').not.toContain('IoInsideDatabaseTransaction');
    // The Shell delegates the buyer's verified assertion, then the Party read is sent.
    expect(test.paths).toEqual([
      '/shell-super-app-api/auth/delegated/gateway-context',
      expect.stringMatching(/^\/party-registry-api\//u),
    ]);
    // An unusable Party answer stays unavailable.
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect('keeps the transaction guard effective against the same Party read inside SQL', () =>
  Effect.gen(function* guardedNegativeControl() {
    const test = yield* triggerPreparation();
    const exit = yield* test.run.pipe(
      insideDatabaseTransaction('commerce.customer-context.trigger-purchase-approval'),
      Effect.provide(test.dependencies),
      Effect.exit,
    );
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '').toContain('IoInsideDatabaseTransaction');
    expect(test.paths).toEqual([]);
  }).pipe(Effect.provide(TestClock.layer())),
);
