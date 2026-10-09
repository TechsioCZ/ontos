import { Context } from 'effect';
import type { Effect, Redacted } from 'effect';
import type { CommercePortalAuthVerificationRequest } from '../../../shared/portal-auth-verification.ts';
import type { CommercePortalAuthVerificationClientUnavailable } from './client-errors.ts';

export interface CommercePortalAuthVerificationWorkloadAssertionInput {
  readonly request: CommercePortalAuthVerificationRequest;
  readonly requestCorrelation: string;
}

export interface CommercePortalAuthVerificationWorkloadAssertionService {
  readonly acquire: (
    input: CommercePortalAuthVerificationWorkloadAssertionInput,
  ) => Effect.Effect<Redacted.Redacted, CommercePortalAuthVerificationClientUnavailable>;
}

export class CommercePortalAuthVerificationWorkloadAssertion extends Context.Service<
  CommercePortalAuthVerificationWorkloadAssertion,
  CommercePortalAuthVerificationWorkloadAssertionService
>()(
  '@app/commerce-customer-context/api/portal-auth-verification/workload-assertion/CommercePortalAuthVerificationWorkloadAssertion',
) {}
