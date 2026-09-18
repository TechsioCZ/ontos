import { Context } from 'effect';

export interface CommercePortalAuthTrustedAdmissionConfiguration {
  readonly attesterPrincipalId: string;
  readonly maxAdmissionWindowMillis: number;
}

export class CommercePortalAuthTrustedAdmissionConfigurationService extends Context.Service<
  CommercePortalAuthTrustedAdmissionConfigurationService,
  CommercePortalAuthTrustedAdmissionConfiguration
>()(
  '@app/commerce-customer-context/api/portal-auth/admission/trusted-config/CommercePortalAuthTrustedAdmissionConfigurationService',
) {}
