import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import { EnrollmentEvidenceReferenceSchema } from '../../../shared/enrollment-contracts.ts';
import type { CounterpartyAccessDomainError } from '../../../shared/domain/access-error.ts';
import type { CounterpartyAccessPortService } from '../../../shared/domain/access-port.ts';
import { CounterpartyAccessInvitationSchema } from '../../../shared/domain/invitation-contract.ts';
import type {
  CommerceEnrollmentOwnerReconciliationInput,
  CommerceEnrollmentOwnerTransition,
} from '../orchestration/owner-transition-driver.ts';

/**
 * Owner-local seam between the Counterparty invitation journey and the existing
 * `claim-counterparty-access-invitation` Action.
 *
 * Everything secret or owner-private — the one-time claim proof reference, the Legal Entity scope
 * and the Action transport — lives behind this seam, so the journey composes owner transitions
 * without ever holding a claim proof.  `claim` must dispatch the exact Action invocation named by
 * the transition, and `observe` must look the result up by that same original owner invocation:
 * a lost claim response is resolved by reading what that invocation did, never by claiming again.
 */

/** The claim Action's own outcome union, reused rather than restated. */
export type CounterpartyInvitationClaimDispatchResult = Effect.Success<
  ReturnType<CounterpartyAccessPortService['claimInvitation']>
>;

/**
 * Authoritative answer to "what did this exact owner invocation do to the invitation?".  The
 * evidence reference is emitted by the owner lookup and must differ from the original owner
 * invocation, so an Attempt cannot present its own request as proof of its own effect.
 */
export const CounterpartyInvitationClaimObservationSchema = Schema.Union([
  Schema.Struct({
    evidenceRef: EnrollmentEvidenceReferenceSchema,
    outcome: Schema.Literal('NOT_CLAIMED'),
  }),
  Schema.Struct({
    evidenceRef: EnrollmentEvidenceReferenceSchema,
    invitation: CounterpartyAccessInvitationSchema,
    outcome: Schema.Literal('CLAIMED'),
  }),
]).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CounterpartyInvitationClaimObservation = typeof CounterpartyInvitationClaimObservationSchema.Type;

export interface CounterpartyInvitationClaimGatewayService {
  readonly claim: (
    input: CommerceEnrollmentOwnerTransition,
  ) => Effect.Effect<CounterpartyInvitationClaimDispatchResult, CounterpartyAccessDomainError>;
  readonly observe: (
    input: CommerceEnrollmentOwnerReconciliationInput,
  ) => Effect.Effect<CounterpartyInvitationClaimObservation, CounterpartyAccessDomainError>;
}

export class CounterpartyInvitationClaimGateway extends Context.Service<
  CounterpartyInvitationClaimGateway,
  CounterpartyInvitationClaimGatewayService
>()(
  '@app/commerce-customer-context/enrollment/journeys/counterparty-invitation-claim-gateway/CounterpartyInvitationClaimGateway',
) {}
