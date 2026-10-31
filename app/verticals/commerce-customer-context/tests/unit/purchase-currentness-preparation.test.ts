import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { PurchaseLimitEvaluationCurrentnessPort } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { PurchaseLimitDependencyUnavailableSchema } from '../../shared/domain/purchase-limit-policy.ts';
import { preparePurchaseLimitCurrentness } from '../../src/services/purchase-currentness-preparation.ts';

const source = { sourceRef: 'independent-owner-source', sourceRevision: 'real-source-r7' };
const context = {
  actionInvocationId: '50000000-0000-4000-8000-000000000001',
  compositionRevision: 'a'.repeat(64),
  scope: {
    authMethod: 'session' as const,
    correlationId: 'exact-source-preparation',
    legalEntityId: '20000000-0000-4000-8000-000000000001',
    principalId: '40000000-0000-4000-8000-000000000001',
    tenantId: '10000000-0000-4000-8000-000000000001',
    trustedStorefrontId: 'storefront',
  },
  transaction: () => Effect.die('Only the configured source may choose its sanctioned SQL snapshot'),
};

it.effect('fails closed without provider preparation and never falls back to live currentness inside SQL', () =>
  Effect.gen(function* unsupportedPreparation() {
    const failure = yield* preparePurchaseLimitCurrentness(context, source).pipe(
      Effect.provideService(PurchaseLimitEvaluationCurrentnessPort, {
        resolveCandidate: () => Effect.die('A candidate read is not a preparation protocol'),
        resolveCurrent: () => Effect.die('A current read is not a preparation protocol'),
      }),
      Effect.flip,
    );
    expect(failure.dependency).toBe('PURCHASE_CURRENTNESS_PREPARATION');
  }),
);

it.effect('delegates the exact invocation and source to its configured owner, preserving native failure', () =>
  Effect.gen(function* configuredPreparation() {
    const original = PurchaseLimitDependencyUnavailableSchema.make({
      code: 'purchase_limit_dependency_unavailable',
      dependency: 'TEST_INDEPENDENT_SOURCE',
      reason: 'The owner could not observe the requested source revision',
    });
    let calls = 0;
    const failure = yield* preparePurchaseLimitCurrentness(context, source).pipe(
      Effect.provideService(PurchaseLimitEvaluationCurrentnessPort, {
        prepare: (actualContext, actualSource) => {
          expect(actualContext).toBe(context);
          expect(actualSource).toBe(source);
          calls += 1;
          return Effect.fail(original);
        },
        resolveCurrent: () => Effect.die('Preparation must not fall back to a live current read'),
      }),
      Effect.flip,
    );
    expect(calls).toBe(1);
    expect(failure).toBe(original);
  }),
);
