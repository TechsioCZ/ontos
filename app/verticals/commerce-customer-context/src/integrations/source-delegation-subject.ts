import type { OrganizationBusinessApplicabilityRequest } from '@app/privacy/api/organization-business-applicability';
import type { LegacyIcoInventoryRequest } from '@app/party-registry/apis/legacy-ico-inventory';
import type { SourceProcessingEligibilityRequest } from '@app/privacy/api/source-processing-eligibility';
import type { SourcePersonAdmissionRequest } from '@app/party-registry/apis/source-person-admission';
import type { SourceCounterpartyAdmissionRequest } from '@app/party-registry/apis/source-counterparty-admission';
import type { CounterpartyOrganizationIcoFactsRequest } from '@app/party-registry/apis/counterparty-organization-ico-facts';
import type { OrganizationProfileIcoApplicabilityRequest } from '@app/privacy/api/organization-profile-ico-applicability';
import type { ValidatePriceGroupCompatibilityRequest } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import {
  readVerifiedGatewayRecovery,
  readVerifiedGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';

/** The issuer verifies this branch again against the original signed owner admission.
 * Recovery authorizes the exact downstream Read input, never a copied historical decision. */
export const commerceSourceDelegationSubject = (
  scope: TrustedPrincipalContext,
  declarationKey: string,
  decodedReadInput:
    | OrganizationBusinessApplicabilityRequest
    | LegacyIcoInventoryRequest
    | SourceProcessingEligibilityRequest
    | SourcePersonAdmissionRequest
    | SourceCounterpartyAdmissionRequest
    | CounterpartyOrganizationIcoFactsRequest
    | OrganizationProfileIcoApplicabilityRequest
    | ValidatePriceGroupCompatibilityRequest,
  operationRequirementKey: string,
): GatewayDelegationSubject => {
  const recovery = readVerifiedGatewayRecovery(scope);
  if (scope.authMethod !== 'system' && readVerifiedGatewayWorkload(scope) === undefined && recovery === undefined) {
    return { _tag: 'Assertion', scope };
  }
  return recovery === undefined
    ? { _tag: 'RegisteredAssertion', declarationKey, operationRequirementKey, scope }
    : {
        _tag: 'RegisteredAssertion',
        declarationKey,
        operationRequirementKey,
        recoveryRequestHash: computeCanonicalValueHash(decodedReadInput),
        scope,
      };
};
