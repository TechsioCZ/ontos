import { Context } from 'effect';

export interface CommercePortalAuthVerificationClientConfiguration {
  readonly baseUrl: string | URL;
}

export class CommercePortalAuthVerificationClientConfigurationService extends Context.Service<
  CommercePortalAuthVerificationClientConfigurationService,
  CommercePortalAuthVerificationClientConfiguration
>()(
  '@app/commerce-customer-context/api/portal-auth-verification/client-configuration/CommercePortalAuthVerificationClientConfigurationService',
) {}
