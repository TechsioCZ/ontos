import { Schema } from 'effect';
import type { TrustedPrincipalContext } from '../../src/actions/principal-context.ts';
import {
  RegisteredGatewayOrganizationGovernanceReadSchema,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';

/** Core infrastructure fixture; production obtains the marker only after official audience verification/redemption. */
export const organizationGovernanceReadPrincipal = (principal: TrustedPrincipalContext, requestHash: string) => {
  if (principal.legalEntityId === undefined) {
    throw new Error('Organization governance requires the actual selected company');
  }
  return trustVerifiedGatewayPrincipalContext(
    principal,
    'a'.repeat(64),
    undefined,
    { appId: 'privacy', buildMarker: 'privacy-fixture-build', principalId: '00000000-0000-4000-8000-000000000010' },
    undefined,
    undefined,
    undefined,
    Schema.decodeSync(RegisteredGatewayOrganizationGovernanceReadSchema)({
      governanceLegalEntityId: principal.legalEntityId,
      principalId: principal.principalId,
      requestHash,
      tenantId: principal.tenantId,
    }),
  );
};
