import { Context, Crypto, DateTime, Effect, Layer, Option, Schema } from 'effect';
import type { PlatformError } from 'effect';

import { withCause } from '../../../api/portal-auth/problems-support.ts';
import { PortalAuthIssuanceRefSchema } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuanceRef } from '../../../shared/portal-auth-communications.ts';
import { CommercePortalAuthCommunicationOutcomeReader } from './communication-outcome-reader.ts';
import { CommercePortalAuthProtectedHandoff } from './protected-handoff.ts';
import { VerificationReplayUnavailable } from './verification-replay-unavailable.ts';

/**
 * The enrollment replay rule of the verification e-mail (#1406 D.9, AUTH-COM-09). One enrollment operation (the
 * `ownerInvocationId`) causes ONE verification issuance; the issuance has its own identity, derived from the invocation
 * under a fixed namespace, so a replay of the same invocation names the SAME issuance and therefore the same Communication
 * Request, intent and last outcome. A replay may never send a second message or issue a second link on mere uncertainty:
 *
 * - NOT_SUBMITTED: Communications has NO request for the issuance (any ADMITTED request is never NOT_SUBMITTED, whatever the
 *   caller saw: a timeout does not un-admit it) and Auth holds no issuance for it, so nothing was ever sent; the same
 *   issuance is issued. A held issuance has a committed request in the Auth-local outbox: owed, not NOT_SUBMITTED, while
 *   it is usable. A held issuance that EXPIRED while Communications still holds no request for it can never be sent any
 *   more (the relay closes its row EXPIRED unsubmitted, and Communications stops any handoff past the request's
 *   `validUntil`), so the replay stops truthfully instead of claiming a message is owed; it never issues the same
 *   deterministic issuance again (that identity is already spent);
 * - IN_PROGRESS, ACCEPTED, UNCERTAIN, NON_ACCEPTANCE_PROVEN: a message exists or is being continued under the approved
 *   recovery rule of the SAME intent; the replay sends nothing and issues nothing (an uncertain effect is reconciled, a
 *   proven non-acceptance continues the same intent, never a new link);
 * - STOPPED: Communications decided no message leaves; the replay does not repair it by issuing another one;
 * - the outcome cannot be established: nothing is sent either.
 *
 * Only Auth itself issues a new issuance (a user-initiated resend through the provider), never a replay.
 */
export const VerificationReplayDecisionSchema = Schema.Literals(['ISSUE', 'NO_NEW_ISSUANCE']);
export type VerificationReplayDecision = typeof VerificationReplayDecisionSchema.Type;

export interface VerificationReplayService {
  /**
   * Asks, before the provider issues the verification link of one enrollment operation, whether it may. `ISSUE` has
   * reserved the deterministic issuance for the provider callback; `NO_NEW_ISSUANCE` means a message already exists or
   * is owed to the previous issuance, so the caller must send nothing and issue nothing.
   */
  readonly begin: (input: {
    readonly ownerInvocationId: string;
    readonly providerSubjectId: string;
    readonly replay: boolean;
  }) => Effect.Effect<VerificationReplayDecision, VerificationReplayUnavailable>;
  /** Drops the reservation once the provider call is over, so a later issuance of the same subject (a user-initiated resend) can never borrow it. */
  readonly release: (input: { readonly providerSubjectId: string }) => Effect.Effect<void>;
}

export class CommercePortalAuthVerificationReplay extends Context.Service<
  CommercePortalAuthVerificationReplay,
  VerificationReplayService
>()(
  '@app/commerce-customer-context/portal-auth/communications/verification-replay/CommercePortalAuthVerificationReplay',
) {}

const decodeIssuanceRef = Schema.decodeUnknownEffect(PortalAuthIssuanceRefSchema);
const VERIFY_EMAIL = 'verify-email' as const;
const ISSUE = 'ISSUE' as const;
const NO_NEW_ISSUANCE = 'NO_NEW_ISSUANCE' as const;
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The deterministic issuance of one enrollment operation: namespaced, one-way and distinct from the invocation identity itself. */
export const enrollmentVerificationIssuanceRef = (
  ownerInvocationId: string,
): Effect.Effect<PortalAuthIssuanceRef, PlatformError.PlatformError | Schema.SchemaError, Crypto.Crypto> =>
  Crypto.Crypto.use((crypto) =>
    crypto.digest('SHA-256', new TextEncoder().encode(`portal-auth.verify-email.enrollment|${ownerInvocationId}`)),
  ).pipe(Effect.flatMap((digest) => decodeIssuanceRef(`pae-${hex(digest).slice(0, 40)}`)));

const unavailable = (cause: unknown) =>
  withCause(new VerificationReplayUnavailable({ reason: 'OUTCOME_UNAVAILABLE' }), cause);

export const makeVerificationReplay = Effect.fn('CommercePortalAuthVerificationReplay.make')(
  function* makeVerificationReplayEffect() {
    const handoff = yield* CommercePortalAuthProtectedHandoff;
    const outcomes = yield* CommercePortalAuthCommunicationOutcomeReader;
    const context = yield* Effect.context<Crypto.Crypto>();
    const issuanceRefOf = (ownerInvocationId: string) =>
      enrollmentVerificationIssuanceRef(ownerInvocationId).pipe(
        Effect.provideContext(context),
        Effect.mapError(unavailable),
      );
    const reserve = Effect.fn('CommercePortalAuthVerificationReplay.reserve')(function* reserveIssuance(input: {
      readonly issuanceRef: PortalAuthIssuanceRef;
      readonly ownerInvocationId: string;
      readonly providerSubjectId: string;
    }) {
      yield* handoff.reserve({
        flow: VERIFY_EMAIL,
        providerSubjectId: input.providerSubjectId,
        reservation: { enrollmentOwnerInvocationId: input.ownerInvocationId, issuanceRef: input.issuanceRef },
      });
      return ISSUE;
    });
    const begin: VerificationReplayService['begin'] = Effect.fn('CommercePortalAuthVerificationReplay.begin')(
      function* beginIssuance({ ownerInvocationId, providerSubjectId, replay }) {
        const issuanceRef = yield* issuanceRefOf(ownerInvocationId);
        if (!replay) {
          return yield* reserve({ issuanceRef, ownerInvocationId, providerSubjectId });
        }
        const outcome = yield* outcomes.outcomeOf({ flow: VERIFY_EMAIL, issuanceRef });
        if (outcome === 'NOT_SUBMITTED') {
          // A held issuance was committed together with its request in the Auth-local outbox, so its request exists and the relay
          // submits it (or already has, with a lost answer that `NOT_SUBMITTED` cannot yet show). That is a request owed to the
          // previous issuance, never proof that nothing was submitted.
          const held = yield* handoff.issuanceOf(issuanceRef).pipe(Effect.mapError(unavailable));
          if (Option.isNone(held)) {
            return yield* reserve({ issuanceRef, ownerInvocationId, providerSubjectId });
          }
          const now = yield* DateTime.now;
          if (!DateTime.isGreaterThan(held.value.expiresAt, now)) {
            // never submitted and no longer usable: nothing is owed and nothing can be sent for it any more
            return yield* new VerificationReplayUnavailable({ reason: 'PREVIOUS_ISSUANCE_EXPIRED' });
          }
          return NO_NEW_ISSUANCE;
        }
        if (outcome === 'STOPPED') {
          // nothing leaves for this issuance and a replay never repairs it: the Attempt stays retryable, truthfully unfinished
          return yield* new VerificationReplayUnavailable({ reason: 'PREVIOUS_ISSUANCE_STOPPED' });
        }
        return NO_NEW_ISSUANCE;
      },
    );
    const release: VerificationReplayService['release'] = ({ providerSubjectId }) =>
      handoff.takeReservation(VERIFY_EMAIL, providerSubjectId).pipe(Effect.asVoid);
    return { begin, release } satisfies VerificationReplayService;
  },
);

export const verificationReplayLayer = Layer.effect(CommercePortalAuthVerificationReplay, makeVerificationReplay());
