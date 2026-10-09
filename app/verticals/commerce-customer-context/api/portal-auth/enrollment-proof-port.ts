import type { ExternalUserSubject, VerifyExternalAuthenticationResult } from '../../shared/portal-auth-contracts.ts';
import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CommerceEnrollmentProofRejected } from './enrollment-proof-rejected.ts';
import type { CommerceEnrollmentProofUnavailable } from './enrollment-proof-unavailable.ts';

export { CommerceEnrollmentProofRejected } from './enrollment-proof-rejected.ts';
export { CommerceEnrollmentProofUnavailable } from './enrollment-proof-unavailable.ts';

export type CommerceEnrollmentProof = NonNullable<
  Extract<VerifyExternalAuthenticationResult, { readonly outcome: 'ALLOWED' }>['enrollmentProof']
>;

/** Owner-local read of the durable Attempt, never an attestation supplied by the browser. */
export class CommerceEnrollmentProofService extends Context.Service<
  CommerceEnrollmentProofService,
  {
    readonly authorizeAccountCreation: (input: {
      readonly enrollmentAttemptId: string;
      readonly ownerInvocationId: string;
      readonly tenantId: string;
    }) => Effect.Effect<
      { readonly evidenceRef: string; readonly revision: number },
      CommerceEnrollmentProofRejected | CommerceEnrollmentProofUnavailable
    >;
    readonly verify: (
      input: ExternalUserSubject & { readonly enrollmentAttemptId: string; readonly tenantId: string },
    ) => Effect.Effect<CommerceEnrollmentProof, CommerceEnrollmentProofRejected | CommerceEnrollmentProofUnavailable>;
  }
>()('@app/commerce-customer-context/api/portal-auth/enrollment-proof-port/CommerceEnrollmentProofService') {}
