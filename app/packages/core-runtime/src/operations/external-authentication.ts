import { Context } from 'effect';
import type { Effect } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type {
  AuthenticationAdmissionMatch,
  VerifiedAuthenticationAdmission,
} from '../auth/external-identity/verifier.ts';
import type { OperationAuthenticationRequired, OperationContextUnavailable } from './errors.ts';

/** Fresh receiver input shared by owner adapters and the Core admission gate. */
export interface ExternalOperationAuthenticationRequest extends Omit<AuthenticationAdmissionMatch, 'bindingRevision'> {
  /** The principal is retained for adapters that bind workload/Tenant authority. */
  readonly principal: TrustedPrincipalContext;
  /** The subject kind is supplied by trusted Core context, never by request payload. */
  readonly subjectType: 'user' | 'api_key';
}

/**
 * Composition installs this service only for namespaces whose registration
 * requires operation admission. Its result is an opaque, operation-bound
 * capability; a decoded wire observation is not accepted as this result.
 */
export class ExternalOperationAuthentication extends Context.Service<
  ExternalOperationAuthentication,
  {
    readonly verify: (
      input: ExternalOperationAuthenticationRequest,
    ) => Effect.Effect<VerifiedAuthenticationAdmission, OperationAuthenticationRequired | OperationContextUnavailable>;
  }
>()('@app/core-runtime/operations/external-authentication/ExternalOperationAuthentication') {}
