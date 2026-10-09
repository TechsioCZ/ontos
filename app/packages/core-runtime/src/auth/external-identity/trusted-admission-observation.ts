import { Context } from 'effect';
import type { Effect } from 'effect';

import type {
  AuthenticationAdmissionObservation,
  ExternalSubjectAdmissionObservation,
} from '../external-identity-contracts.ts';
import type { AuthenticationAdmissionRequest, ExternalSubjectAdmissionMatch } from './verifier.ts';
import type { ExternalIdentityFailure } from './errors.ts';

/**
 * The owner boundary observes provider state. Core receives only a decoded,
 * operation-bound observation from this composed service; callers cannot pass
 * an observation callback to the verifier or mint a capability from wire data.
 */
export interface TrustedAdmissionObservationService {
  readonly observeAuthentication: (
    input: AuthenticationAdmissionRequest,
  ) => Effect.Effect<AuthenticationAdmissionObservation, ExternalIdentityFailure>;
  readonly observeExternalSubject: (
    input: ExternalSubjectAdmissionMatch,
  ) => Effect.Effect<ExternalSubjectAdmissionObservation, ExternalIdentityFailure>;
}

export class TrustedAdmissionObservation extends Context.Service<
  TrustedAdmissionObservation,
  TrustedAdmissionObservationService
>()('@app/core-runtime/auth/external-identity/trusted-admission-observation/TrustedAdmissionObservation') {}
