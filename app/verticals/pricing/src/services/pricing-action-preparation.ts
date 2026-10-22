import { OperationContextUnavailable } from '@app/core-runtime';
import type { ActionPrepareContext } from '@app/core-runtime';
import { Effect } from 'effect';

import { catalogSelectionAssessmentPortFromEnvironment } from '../integrations/catalog-selection-evidence.ts';
import { commercialContextAssessmentPortFromEnvironment } from '../integrations/commercial-context-evidence.ts';
import { commercialFeeCatalogTargetAssessmentPortFromEnvironment } from '../integrations/commercial-fee-catalog-target-evidence.ts';
import { currentPricingDecisionOwnerStatePerOwnerTransaction } from '../integrations/current-pricing-decision-owner-state.ts';
import { externalPriceSourceAuthorityForScope } from '../persistence/external-price-source-authority-persistence.ts';
import { ExternalPriceInputBoundaryFactory } from './external-price-input-boundary.service.ts';

/** Remote evidence is loaded before BEGIN; intervening owner reads use short admitted transactions. */
export const pricingActionPreparationForScope = Effect.fn('PricingActionPreparation.forScope')(function* forScope(
  context: ActionPrepareContext,
) {
  const { compositionRevision, scope, transaction } = context;
  if (scope.legalEntityId === undefined) {
    return yield* new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Pricing preparation requires a trusted Selling Legal Entity',
    });
  }
  const environment = {
    compositionRevision,
    legalEntityId: scope.legalEntityId,
    requestCorrelation: scope.correlationId,
  };
  const catalog = yield* catalogSelectionAssessmentPortFromEnvironment(environment);
  const commercialContext = yield* commercialContextAssessmentPortFromEnvironment(environment);
  const catalogTarget = yield* commercialFeeCatalogTargetAssessmentPortFromEnvironment(environment);
  const ownerState = currentPricingDecisionOwnerStatePerOwnerTransaction(transaction, scope, compositionRevision);
  return {
    assessCatalogSelection: catalog.assess,
    assessCommercialContext: commercialContext.assess,
    loadCurrencySupport: ownerState.currency.loadCurrent,
    validateCatalogTarget: catalogTarget.validate,
  };
});

export const priceActionPreparationForScope = Effect.fn('PricingActionPreparation.priceForScope')(function* forScope(
  context: ActionPrepareContext,
) {
  const evidence = yield* pricingActionPreparationForScope(context);
  const { scope, transaction } = context;
  const boundaryFactory = yield* ExternalPriceInputBoundaryFactory;
  const authority = {
    assess: (request: Parameters<Parameters<typeof boundaryFactory.make>[0]['assess']>[0]) =>
      transaction((owner) =>
        externalPriceSourceAuthorityForScope(owner, scope).pipe(Effect.flatMap((port) => port.assess(request))),
      ).pipe(
        Effect.catchTags({
          OperationContextUnavailable: () =>
            Effect.succeed({ dependency: 'SOURCE_AUTHORITY' as const, outcome: 'AUTHORITY_UNAVAILABLE' as const }),
          OwnerTransactionUnavailable: () =>
            Effect.succeed({ dependency: 'SOURCE_AUTHORITY' as const, outcome: 'AUTHORITY_UNAVAILABLE' as const }),
        }),
      ),
  };
  return {
    ...evidence,
    assessExternalPriceInput: boundaryFactory.make(authority).assess,
  };
});
