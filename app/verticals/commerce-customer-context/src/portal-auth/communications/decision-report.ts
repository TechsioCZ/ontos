import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import { PortalAuthIssuanceRefSchema } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthSubmission } from './communication-request-submitter.ts';
import type { PortalAuthCommunicationUnavailable } from './communication-unavailable.ts';
import { CommercePortalAuthCommunicationStore } from './communication-store.ts';
import { encodeOutcome, leavesNoMessage } from './request-relay.ts';

/**
 * The completion callback of the Portal Auth relay path (#1406 D4). The relay hands a committed request on as RELAYED; the
 * decision is taken later, when the module's source worker submits the request to Communications. The worker reports that
 * decision back here, and it ends the Auth-local outbox row exactly as the relay ends a row it decided itself: the same safe
 * summary (identities and closed codes only, never an address, token, link or code) and the same rule for the protected value.
 * A decision that leaves no message (NO_MESSAGE, a conflict, only stopped or suppressed intents) erases the issuance's sealed
 * value now instead of at its expiry, because nothing will ever ask for it.
 *
 * It is idempotent and replay-safe: the same decision reported again (a redelivery, a replayed stored decision) changes nothing
 * further, a row that already ended keeps its first outcome, and erasing an erased value is a no-op.
 */
export interface CommunicationDecisionReporterService {
  readonly decided: (
    request: CommunicationRequestEncoded,
    submission: PortalAuthSubmission,
  ) => Effect.Effect<void, PortalAuthCommunicationUnavailable>;
  /**
   * Communications refused the request itself for good (#1406 D5): the row ends REFUSED with the closed refusal code and the
   * sealed value is erased now, because no message can ever leave for it.
   */
  readonly refused: (
    request: CommunicationRequestEncoded,
    code: string,
  ) => Effect.Effect<void, PortalAuthCommunicationUnavailable>;
}

export class CommercePortalAuthCommunicationDecisionReporter extends Context.Service<
  CommercePortalAuthCommunicationDecisionReporter,
  CommunicationDecisionReporterService
>()(
  '@app/commerce-customer-context/portal-auth/communications/decision-report/CommercePortalAuthCommunicationDecisionReporter',
) {}

const decodeIssuanceRef = Schema.decodeUnknownOption(PortalAuthIssuanceRefSchema);
/** The safe summary of a refused request: the closed code Communications refused it with, nothing else. */
const encodeRefusal = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String, outcome: Schema.Literal('REFUSED') })),
);

/** The callback over Auth's own store. */
export const communicationDecisionReporterLayer = Layer.effect(
  CommercePortalAuthCommunicationDecisionReporter,
  Effect.gen(function* communicationDecisionReporter() {
    const store = yield* CommercePortalAuthCommunicationStore;
    return {
      decided: Effect.fn('CommercePortalAuthCommunicationDecisionReporter.decided')(function* decided(
        request: CommunicationRequestEncoded,
        submission: PortalAuthSubmission,
      ) {
        // the occurrence of a Portal Auth request IS its issuance; a request naming none has nothing to end
        const issuanceRef = decodeIssuanceRef(request.occurrence.occurrenceId);
        if (Option.isNone(issuanceRef)) {
          return;
        }
        yield* store.recordDecision({
          forget: leavesNoMessage(submission),
          issuanceRef: issuanceRef.value,
          now: yield* DateTime.now,
          outcome: yield* encodeOutcome(submission).pipe(Effect.option),
          state: submission.outcome,
        });
      }),
      refused: Effect.fn('CommercePortalAuthCommunicationDecisionReporter.refused')(function* refused(
        request: CommunicationRequestEncoded,
        code: string,
      ) {
        const issuanceRef = decodeIssuanceRef(request.occurrence.occurrenceId);
        if (Option.isNone(issuanceRef)) {
          return;
        }
        yield* store.recordDecision({
          forget: true,
          issuanceRef: issuanceRef.value,
          now: yield* DateTime.now,
          outcome: yield* encodeRefusal({ code, outcome: 'REFUSED' }).pipe(Effect.option),
          state: 'REFUSED',
        });
      }),
    };
  }),
);

/**
 * A worker host without the Portal Auth relay: there is no Auth store to report to, so nothing is recorded and a protected
 * value is cleared at its expiry as before.
 */
export const unreportedCommunicationDecisionLayer = Layer.succeed(CommercePortalAuthCommunicationDecisionReporter, {
  decided: () => Effect.void,
  refused: () => Effect.void,
});
