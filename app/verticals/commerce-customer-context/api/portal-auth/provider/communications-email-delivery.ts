import { Crypto, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from 'effect';

import { PortalAuthIssuanceRefSchema } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow } from '../../../shared/portal-auth-communications.ts';
import { PortalAuthCommunicationNotSent } from '../../../src/portal-auth/communications/communication-not-sent.ts';
import { CommercePortalAuthCommunicationRequestSubmitter } from '../../../src/portal-auth/communications/communication-request-submitter.ts';
import type { PortalAuthSubmission } from '../../../src/portal-auth/communications/communication-request-submitter.ts';
import { PortalAuthCommunicationUnavailable } from '../../../src/portal-auth/communications/communication-unavailable.ts';
import type { HeldIssuance, PortalAuthIssuance } from '../../../src/portal-auth/communications/issuance.ts';
import { CommercePortalAuthProtectedHandoff } from '../../../src/portal-auth/communications/protected-handoff.ts';
import type { IssuanceReservation } from '../../../src/portal-auth/communications/protected-handoff.ts';
import { portalAuthCommunicationRequest } from '../../../src/portal-auth/communications/request.ts';
import { CommercePortalAuthTrustedScope } from '../../../src/portal-auth/communications/trusted-scope.ts';
import type { PortalAuthTrustedScopeUnavailable } from '../../../src/portal-auth/communications/trusted-scope-unavailable.ts';
import { withCause } from '../problems-support.ts';
import type { CommercePortalAuthEmailDelivery } from './auth.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from './config.ts';
import { COMMERCE_PORTAL_AUTH_MFA_POLICY } from './mfa/plugin.ts';
import { CommercePortalAuthRawEmailDeliveryService } from './raw-email-delivery-service.ts';

/**
 * The Communications-routed form of the three Portal Auth e-mail callbacks (#1406). It is the ONLY place where an issued
 * secret meets the Communications contract, and it keeps them apart:
 * - the secret (link, code) and the original address go into Auth's protected handoff, which only Auth's own owner-slot
 *   completion can read;
 * - what Communications receives is a Communication Request built from the issuance alone (its own occurrence identity,
 *   the original subject and endpoint as references, the trusted scope), with an idempotency key that never derives from a
 *   token, link, code or address;
 * - the issuance, its expiry, the binding to the account and the recovery ledger are exactly the provider's: nothing here
 *   issues, extends, reissues or repairs anything.
 *
 * It is installed only by a composition that provides the Communications seams; a deployment that composes none keeps the
 * direct `EmailDeliveryService` delivery and Core and staff Auth run without Communications.
 */

/** The lifetime Auth's own policy gives each issuance. Read from the policy that already governs the provider; never set here. */
const issuanceLifetimeOf = (flow: PortalAuthEmailFlow): Duration.Duration => {
  if (flow === 'verify-email') {
    return Duration.seconds(COMMERCE_PORTAL_AUTH_POLICY.emailVerification.expiresInSeconds);
  }
  return flow === 'otp'
    ? Duration.minutes(COMMERCE_PORTAL_AUTH_MFA_POLICY.otpPeriodMinutes)
    : Duration.seconds(COMMERCE_PORTAL_AUTH_POLICY.password.resetTokenExpiresInSeconds);
};

const ISSUANCE_REFERENCE_OPERATION = 'issuance-reference';
const decodeIssuanceRef = Schema.decodeUnknownEffect(PortalAuthIssuanceRefSchema);

/** A new verification link or code replaces the earlier one of the subject; every unexpired reset link stays valid, as in the provider. */
const supersedesEarlierIssuance = (flow: PortalAuthEmailFlow): boolean => flow !== 'reset-password';

interface IssuedSecret {
  readonly flow: PortalAuthEmailFlow;
  /** The provider token Auth's ledger knows the issuance by; absent for a one-time code. */
  readonly ledgerToken: Option.Option<Redacted.Redacted>;
  readonly secret: Redacted.Redacted;
  readonly user: { readonly email: string; readonly id: string };
}

/** What Communications decided, reduced to whether any message can still leave: a stop is reported, never repaired by reissuing. */
const notSentReasonOf = (submission: PortalAuthSubmission): Option.Option<string> => {
  if (submission.outcome === 'CONFLICT') {
    return Option.some('REQUEST_CONFLICT');
  }
  const { decision } = submission;
  if (decision.kind === 'NO_MESSAGE') {
    return Option.some(decision.reason);
  }
  const pending = decision.intents.some(({ status }) => status === 'PENDING_HANDOFF');
  return pending ? Option.none() : Option.some(decision.intents.at(0)?.reason ?? 'NO_INTENT');
};

const issuanceOf = Effect.fn('CommercePortalAuthCommunicationsEmail.issuance')(function* issuance(
  issued: IssuedSecret,
  reservation: Option.Option<IssuanceReservation>,
) {
  const issuedAt = yield* DateTime.now;
  const issuanceRef = yield* Option.match(reservation, {
    onNone: () =>
      Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(Effect.flatMap((id) => decodeIssuanceRef(`pa-${id}`))),
    onSome: ({ issuanceRef: reserved }) => Effect.succeed(reserved),
  });
  const base = {
    expiresAt: DateTime.addDuration(issuedAt, issuanceLifetimeOf(issued.flow)),
    flow: issued.flow,
    issuanceRef,
    issuedAt,
    providerSubjectId: issued.user.id,
  } satisfies PortalAuthIssuance;
  const owner = Option.flatMapNullishOr(reservation, ({ enrollmentOwnerInvocationId }) => enrollmentOwnerInvocationId);
  return Option.match(owner, {
    onNone: () => base,
    onSome: (enrollmentOwnerInvocationId) => ({ ...base, enrollmentOwnerInvocationId }),
  });
});

const heldOf = (issued: IssuedSecret, issuance: PortalAuthIssuance): HeldIssuance => {
  const held = { endpoint: Redacted.make(issued.user.email), issuance, secret: issued.secret };
  return Option.match(issued.ledgerToken, {
    onNone: () => held,
    onSome: (ledgerToken) => ({ ...held, ledgerToken }),
  });
};

export const CommercePortalAuthCommunicationsEmailLive = Layer.effect(
  CommercePortalAuthRawEmailDeliveryService,
  Effect.gen(function* makeCommercePortalAuthCommunicationsEmail() {
    const handoff = yield* CommercePortalAuthProtectedHandoff;
    const submitter = yield* CommercePortalAuthCommunicationRequestSubmitter;
    const trustedScope = yield* CommercePortalAuthTrustedScope;
    const context = yield* Effect.context<Crypto.Crypto>();
    const runWithContext = Effect.runPromiseWith(context);
    const run: <A, E>(effect: Effect.Effect<A, E>) => ReturnType<typeof runWithContext<A, E>> = runWithContext;

    const issue = Effect.fn('CommercePortalAuthCommunicationsEmail.issue')(function* issueMessage(
      issued: IssuedSecret,
    ): Effect.fn.Return<
      void,
      | PortalAuthCommunicationNotSent
      | PortalAuthCommunicationUnavailable
      | PortalAuthTrustedScopeUnavailable
      | Schema.SchemaError
    > {
      const scope = yield* trustedScope.current;
      const reservation = yield* handoff.takeReservation(issued.flow, issued.user.id);
      const issuance = yield* issuanceOf(issued, reservation).pipe(
        Effect.provideContext(context),
        Effect.mapError((cause) =>
          withCause(new PortalAuthCommunicationUnavailable({ operation: ISSUANCE_REFERENCE_OPERATION }), cause),
        ),
      );
      // the request is validated against the published contract BEFORE the secret is held, so a refused request leaves nothing behind
      const request = yield* portalAuthCommunicationRequest(issuance, scope);
      yield* handoff.hold(heldOf(issued, issuance), { supersede: supersedesEarlierIssuance(issued.flow) });
      // an unavailable intake keeps the held issuance: the request may exist, and its handoff must still find the secret
      const submission = yield* submitter.submit(request);
      // Communications decided that no message leaves: the held secret serves nothing. Auth never reissues to repair a stop.
      yield* Option.match(notSentReasonOf(submission), {
        onNone: () => Effect.void,
        onSome: (reason) =>
          handoff
            .forget(issuance.issuanceRef)
            .pipe(Effect.andThen(Effect.fail(new PortalAuthCommunicationNotSent({ reason })))),
      });
    });

    const sendVerificationEmail = Effect.fnUntraced(function* sendVerificationEmailEffect(
      data: Parameters<CommercePortalAuthEmailDelivery['sendVerificationEmail']>[0],
    ) {
      yield* issue({
        flow: 'verify-email',
        ledgerToken: Option.some(Redacted.make(data.token)),
        secret: Redacted.make(data.url),
        user: data.user,
      });
    }, run);
    const sendResetPassword = Effect.fnUntraced(function* sendResetPasswordEffect(
      data: Parameters<CommercePortalAuthEmailDelivery['sendResetPassword']>[0],
    ) {
      yield* issue({
        flow: 'reset-password',
        ledgerToken: Option.some(Redacted.make(data.token)),
        secret: Redacted.make(data.url),
        user: data.user,
      });
    }, run);
    const sendOTP = Effect.fnUntraced(function* sendOTPEffect(
      data: Parameters<CommercePortalAuthEmailDelivery['sendOTP']>[0],
    ) {
      yield* issue({ flow: 'otp', ledgerToken: Option.none(), secret: Redacted.make(data.otp), user: data.user });
    }, run);
    return { sendOTP, sendResetPassword, sendVerificationEmail } satisfies CommercePortalAuthEmailDelivery;
  }),
);
