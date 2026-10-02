import { TrustedPrincipalContextSchema, scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeCurrentPricingDecisionReadServiceFactory } from '../../src/api/current-pricing-decision.read.ts';
import type { PricingOwnerMaterialEvidenceFenceGateway } from '../../src/integrations/material-evidence-owner-final-fence.ts';
import { CurrentPricingDecisionEvaluationFactory } from '../../src/services/current-pricing-decision-evaluation.service.ts';
import type { CurrentPricingDecisionWholeEvaluationPort } from '../../src/services/current-pricing-decision-evaluation.service.ts';
import { CurrentPricingDecisionSubjectAuthority } from '../../src/services/current-pricing-decision-subject-authority.service.ts';
import {
  PricingExternalOwnerEvidenceValidation,
  makePricingExternalOwnerEvidenceValidationService,
} from '../../src/services/external-owner-evidence-validation.service.ts';

describe('Current Pricing Decision scoped final fence wiring (#790)', () => {
  it.effect('passes the transaction-scoped Pricing gateway into the evaluator publication factory', () =>
    Effect.gen(function* scopedPricingGateway() {
      const legalEntityId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const scope = {
        ...(yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
          authBindingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          authContextRef: 'session:790-scoped-fence',
          authMethod: 'session',
          legalEntityId,
          principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        })),
        correlationId: 'correlation:790-scoped-fence',
      } satisfies OperationalScope;
      // SAFETY: The test observes this inert transaction by identity; no database capability is invoked.
      const transaction = scopedRoutineInvokerFromTransaction(() => Effect.succeed([]), {
        legalEntityId,
        tenantId: scope.tenantId,
      }) as unknown as ScopedTransactionExecutor;
      const source = {
        loadFresh: () => Effect.die('This test stops before evaluation'),
      } satisfies CurrentPricingDecisionWholeEvaluationPort;
      const gateway = {
        confirmObservedGenerationsThrough: () => Effect.die('This test stops before owner verification'),
        verifyOpaqueProofsAgainstCurrentState: () => Effect.die('This test stops before owner verification'),
      } satisfies PricingOwnerMaterialEvidenceFenceGateway;
      let observedTransaction: unknown;
      let observedScope: OperationalScope | undefined;
      let observedGateway: PricingOwnerMaterialEvidenceFenceGateway | undefined;
      let observedRevision: string | undefined;
      let publishedSource: CurrentPricingDecisionWholeEvaluationPort | undefined;
      const serviceFactory = makeCurrentPricingDecisionReadServiceFactory(
        () => Effect.succeed(source),
        (candidateTransaction, candidateScope) => {
          observedTransaction = candidateTransaction;
          observedScope = candidateScope;
          return Effect.succeed(gateway);
        },
      );

      yield* serviceFactory(transaction, scope, 'revision:790').pipe(
        Effect.provideService(CurrentPricingDecisionEvaluationFactory, {
          make: (candidateSource, candidateGateway, revision) => {
            observedRevision = revision;
            publishedSource = candidateSource;
            observedGateway = candidateGateway;
            return { evaluate: () => Effect.die('This test stops before evaluation') };
          },
        }),
        Effect.provideService(CurrentPricingDecisionSubjectAuthority, {
          verify: () => Effect.die('This test stops before subject verification'),
        }),
      );

      expect(observedTransaction).toBe(transaction);
      expect(observedScope).toEqual(scope);
      expect(observedGateway).toBe(gateway);
      expect(publishedSource).toBe(source);
      expect(observedRevision).toBe('revision:790');
    }).pipe(
      Effect.provideService(
        PricingExternalOwnerEvidenceValidation,
        makePricingExternalOwnerEvidenceValidationService(),
      ),
    ),
  );
});
