import { Context } from 'effect';
import type { Effect } from 'effect';

import type { ExternalIdentityFailure } from './errors.ts';
import type { ExternalSubjectAdmissionRequest, VerifiedExternalSubjectAdmission } from './verifier.ts';

export interface TrustedExternalSubjectAdmissionServiceContract {
  readonly admit: (
    input: ExternalSubjectAdmissionRequest,
  ) => Effect.Effect<VerifiedExternalSubjectAdmission, ExternalIdentityFailure>;
}

export class TrustedExternalSubjectAdmissionService extends Context.Service<
  TrustedExternalSubjectAdmissionService,
  TrustedExternalSubjectAdmissionServiceContract
>()(
  '@app/core-runtime/auth/external-identity/trusted-external-subject-admission-service/TrustedExternalSubjectAdmissionService',
) {}
