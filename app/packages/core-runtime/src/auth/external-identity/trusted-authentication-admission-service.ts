import { Context } from 'effect';
import type { Effect } from 'effect';

import type { ExternalIdentityFailure } from './errors.ts';
import type { AuthenticationAdmissionRequest, VerifiedAuthenticationAdmission } from './verifier.ts';

export interface TrustedAuthenticationAdmissionServiceContract {
  readonly verify: (
    input: AuthenticationAdmissionRequest,
  ) => Effect.Effect<VerifiedAuthenticationAdmission, ExternalIdentityFailure>;
}

export class TrustedAuthenticationAdmissionService extends Context.Service<
  TrustedAuthenticationAdmissionService,
  TrustedAuthenticationAdmissionServiceContract
>()(
  '@app/core-runtime/auth/external-identity/trusted-authentication-admission-service/TrustedAuthenticationAdmissionService',
) {}
