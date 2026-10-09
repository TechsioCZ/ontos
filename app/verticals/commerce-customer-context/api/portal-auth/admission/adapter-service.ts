import { Context } from 'effect';
import type { Clock, Effect } from 'effect';

import type {
  AuthenticationNamespaceRegistry,
  TrustedAdmissionObservation,
  VerifiedAuthenticationAdmission,
} from '@app/core-runtime/auth/external-identity-admission';
import type { ExternalOperationAuthenticationRequest } from '@app/core-runtime/operations/external-authentication';
import type { OperationAuthenticationRequired, OperationContextUnavailable } from '@app/core-runtime';

export interface CommercePortalAuthAdmissionAdapterService {
  readonly verify: (
    input: ExternalOperationAuthenticationRequest,
  ) => Effect.Effect<
    VerifiedAuthenticationAdmission,
    OperationAuthenticationRequired | OperationContextUnavailable,
    AuthenticationNamespaceRegistry | Clock.Clock | TrustedAdmissionObservation
  >;
}

export class CommercePortalAuthAdmissionAdapter extends Context.Service<
  CommercePortalAuthAdmissionAdapter,
  CommercePortalAuthAdmissionAdapterService
>()('@app/commerce-customer-context/api/portal-auth/admission/adapter-service/CommercePortalAuthAdmissionAdapter') {}
