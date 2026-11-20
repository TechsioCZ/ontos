import { Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';

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
import { CommercePortalAuthRawEmailDeliveryService } from './raw-email-delivery-service.ts';
import { CommercePortalAuthRecoveryStoreService } from './recovery/store-service.ts';
import type { CommercePortalAuthRecoveryStore } from './recovery/store-service.ts';

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

const ISSUANCE_REFERENCE_OPERATION = 'issuance-reference';
const decodeIssuanceRef = Schema.decodeUnknownEffect(PortalAuthIssuanceRefSchema);

/** A new verification link or code replaces the earlier one of the subject; every unexpired reset link stays valid, as in the provider. */
const supersedesEarlierIssuance = (flow: PortalAuthEmailFlow): boolean => flow !== 'reset-password';

/**
 * What Auth itself STORED about the issuance it was just handed: its real expiry, and for a one-time code the two-factor
 * challenge Better Auth keeps it under (the key of its real consumed/exhausted state). Never a callback time plus a policy
 * lifetime: the request states the expiry Auth enforces. An issuance whose stored facts cannot be read is not submitted.
 */
interface StoredIssuanceFacts {
  readonly expiresAt: DateTime.Utc;
  readonly ledgerToken: Option.Option<Redacted.Redacted>;
}

const STORED_FACTS_OPERATION = 'stored-issuance-facts';

const storedFactsOf = Effect.fn('CommercePortalAuthCommunicationsEmail.storedFacts')(function* storedFacts(
  store: Pick<
    CommercePortalAuthRecoveryStore,
    'locateOtpChallenge' | 'peekEmailVerificationLedger' | 'peekPasswordResetLedger'
  >,
  issued: IssuedSecret,
): Effect.fn.Return<StoredIssuanceFacts, PortalAuthCommunicationUnavailable> {
  const unavailable = (cause?: unknown) =>
    withCause(new PortalAuthCommunicationUnavailable({ operation: STORED_FACTS_OPERATION }), cause);
  if (issued.flow === 'otp') {
    const challenge = yield* store.locateOtpChallenge({ otp: issued.secret }).pipe(Effect.mapError(unavailable));
    return yield* Option.match(challenge, {
      onNone: () => Effect.fail(unavailable()),
      onSome: (found) =>
        Effect.succeed({
          expiresAt: DateTime.fromDateUnsafe(found.expiresAt),
          ledgerToken: Option.some(found.challenge),
        }),
    });
  }
  const peek = issued.flow === 'verify-email' ? store.peekEmailVerificationLedger : store.peekPasswordResetLedger;
  const binding = yield* Option.match(issued.ledgerToken, {
    onNone: () => Effect.fail(unavailable()),
    onSome: (token) => peek({ token }).pipe(Effect.mapError(unavailable)),
  });
  const expiresAt = Option.flatMapNullishOr(binding, ({ expiresAt: stored }) => stored);
  return yield* Option.match(expiresAt, {
    onNone: () => Effect.fail(unavailable()),
    onSome: (stored) => Effect.succeed({ expiresAt: DateTime.fromDateUnsafe(stored), ledgerToken: issued.ledgerToken }),
  });
});

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
  expiresAt: DateTime.Utc,
) {
  const issuedAt = yield* DateTime.now;
  const issuanceRef = yield* Option.match(reservation, {
    onNone: () =>
      Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(Effect.flatMap((id) => decodeIssuanceRef(`pa-${id}`))),
    onSome: ({ issuanceRef: reserved }) => Effect.succeed(reserved),
  });
  const base = {
    expiresAt,
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
    const store = yield* CommercePortalAuthRecoveryStoreService;
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
      // Auth's own stored facts first: an issuance whose real expiry cannot be read is never submitted
      const stored = yield* storedFactsOf(store, issued);
      const issuance = yield* issuanceOf(issued, reservation, stored.expiresAt).pipe(
        Effect.provideContext(context),
        Effect.mapError((cause) =>
          withCause(new PortalAuthCommunicationUnavailable({ operation: ISSUANCE_REFERENCE_OPERATION }), cause),
        ),
      );
      // the request is validated against the published contract BEFORE the secret is held, so a refused request leaves nothing behind
      const request = yield* portalAuthCommunicationRequest(issuance, scope);
      yield* handoff.hold(heldOf({ ...issued, ledgerToken: stored.ledgerToken }, issuance), {
        supersede: supersedesEarlierIssuance(issued.flow),
      });
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
