import { Context } from 'effect';
import type { Effect, Schema } from 'effect';

import type {
  CommercePortalAuthStepUpIssueInputSchema,
  CommercePortalAuthStepUpRequired,
  CommercePortalAuthStepUpVerificationResult,
  CommercePortalAuthStepUpVerifyInputSchema,
} from './contracts.ts';
import type { CommercePortalAuthSessionFailure } from '../../session/lifecycle-service.ts';
import type { CommercePortalAuthStepUpInvalidRequest } from './invalid-request.ts';
import type { CommercePortalAuthStepUpRejected } from './rejected.ts';
import type { CommercePortalAuthStepUpUnavailable } from './unavailable.ts';

export interface CommercePortalAuthStepUp {
  readonly issue: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthStepUpIssueInputSchema>,
  ) => Effect.Effect<CommercePortalAuthStepUpRequired, CommercePortalAuthStepUpFailure>;
  /** `headers` stays inside the provider adapter and is never part of the public schema. */
  readonly verify: (
    input: Schema.Codec.Encoded<typeof CommercePortalAuthStepUpVerifyInputSchema> & {
      readonly headers: Headers;
    },
  ) => Effect.Effect<CommercePortalAuthStepUpVerificationResult, CommercePortalAuthStepUpFailure>;
}

export type CommercePortalAuthStepUpFailure =
  | CommercePortalAuthStepUpInvalidRequest
  | CommercePortalAuthStepUpRejected
  | CommercePortalAuthStepUpUnavailable
  | CommercePortalAuthSessionFailure;

export class CommercePortalAuthStepUpService extends Context.Service<
  CommercePortalAuthStepUpService,
  CommercePortalAuthStepUp
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/step-up/step-up-service/CommercePortalAuthStepUpService',
) {}
