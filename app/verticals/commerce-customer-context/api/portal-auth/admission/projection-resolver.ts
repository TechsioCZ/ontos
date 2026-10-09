import { Context } from 'effect';
import type { Schema } from 'effect';

import type { AuthenticationAdmissionRequest } from '@app/core-runtime/auth/external-identity-admission';
import type { ExternalOperationAuthenticationRequest } from '@app/core-runtime/operations/external-authentication';
import type { CommerceSessionReferenceSchema } from '../../../shared/portal-auth-contracts.ts';

export interface CommercePortalAuthBindingProjection {
  readonly bindingRevision: number;
  readonly providerSubjectId: string;
  readonly sessionRef: Schema.Schema.Type<typeof CommerceSessionReferenceSchema>;
}

export interface CommercePortalAuthBindingProjectionResolverService {
  readonly resolve: (
    input: AuthenticationAdmissionRequest | ExternalOperationAuthenticationRequest,
  ) => CommercePortalAuthBindingProjection | undefined;
}

export class CommercePortalAuthBindingProjectionResolver extends Context.Service<
  CommercePortalAuthBindingProjectionResolver,
  CommercePortalAuthBindingProjectionResolverService
>()(
  '@app/commerce-customer-context/api/portal-auth/admission/projection-resolver/CommercePortalAuthBindingProjectionResolver',
) {}
