import type { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { Context } from 'effect';

import type { CatalogSelectionGatewayCredentialIssuer } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import type {
  CurrentPricingDecisionExternalOwnerEvidencePort,
  CurrentPricingDecisionWholeCompositionPort,
} from '../../src/services/current-pricing-decision-whole-evaluation.service.ts';

export type JoinedObservation1225 = Parameters<
  CurrentPricingDecisionWholeCompositionPort['buildMaterialEvidenceRequest']
>[0];

export class JoinedPrerequisites1225 extends Context.Service<
  JoinedPrerequisites1225,
  {
    readonly catalogIssuer: CatalogSelectionGatewayCredentialIssuer;
    readonly external: CurrentPricingDecisionExternalOwnerEvidencePort;
    readonly observe: (input: JoinedObservation1225) => void;
    readonly purchaseContextEvidence: typeof PricingPurchaseContextVerificationEvidenceSchema.Type;
  }
>()('@app/pricing/tests/support/joined-prerequisites-1225/JoinedPrerequisites1225') {}
