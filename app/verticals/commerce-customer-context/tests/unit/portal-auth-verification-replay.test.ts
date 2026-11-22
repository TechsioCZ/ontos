import { DateTime, Effect, Layer, Option, Redacted } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import {
  CommercePortalAuthCommunicationOutcomeReader,
  unavailableCommunicationOutcomeReaderLayer,
} from '../../src/portal-auth/communications/communication-outcome-reader.ts';
import type { PortalAuthSourceOutcome } from '../../src/portal-auth/communications/communication-outcome-reader.ts';
import { CommercePortalAuthProtectedHandoff } from '../../src/portal-auth/communications/protected-handoff.ts';
import {
  CommercePortalAuthVerificationReplay,
  enrollmentVerificationIssuanceRef,
  verificationReplayLayer,
} from '../../src/portal-auth/communications/verification-replay.ts';
import { handoffOverDouble, holdWithRequest } from '../support/portal-auth-communication-store.double.ts';

/**
 * #1406 AUTH-COM-09, D.2 and D.9: one enrollment operation causes ONE verification issuance with its OWN identity, and a replay
 * of the same operation sends nothing and issues nothing on uncertainty. The outcomes below are scripted; the end-to-end suite
 * reads the real outcome from Communications' history.
 */

const INVOCATION = '22222222-2222-4222-8222-222222222222';
const SUBJECT = 'subject-1';

const replayWith = (outcome: PortalAuthSourceOutcome) => {
  const handoff = handoffOverDouble(() => Effect.succeed('CURRENT'));
  const reader = Layer.succeed(CommercePortalAuthCommunicationOutcomeReader, {
    outcomeOf: () => Effect.succeed(outcome),
  });
  return Layer.mergeAll(
    handoff,
    verificationReplayLayer.pipe(Layer.provide(Layer.mergeAll(handoff, reader, commercePortalAuthPlatformCryptoLive))),
  );
};

const replayOutcome = (layer: ReturnType<typeof replayWith>) =>
  Effect.gen(function* decide() {
    const replay = yield* CommercePortalAuthVerificationReplay;
    const handoff = yield* CommercePortalAuthProtectedHandoff;
    const decision = yield* Effect.result(
      replay.begin({ ownerInvocationId: INVOCATION, providerSubjectId: SUBJECT, replay: true }),
    );
    const reserved = yield* handoff.takeReservation('verify-email', SUBJECT);
    return { decision, reserved };
  }).pipe(Effect.provide(layer));

describe('The enrollment verification issuance and its replay (#1406)', () => {
  it.effect(
    'the issuance identity derives from the operation under a fixed namespace: stable, one-way, and never the invocation itself',
    () =>
      Effect.gen(function* identity() {
        const first = yield* enrollmentVerificationIssuanceRef(INVOCATION);
        const again = yield* enrollmentVerificationIssuanceRef(INVOCATION);
        const other = yield* enrollmentVerificationIssuanceRef('33333333-3333-4333-8333-333333333333');
        expect(first).toBe(again);
        expect(first).not.toBe(other);
        expect(first).toMatch(/^pae-[0-9a-f]{40}$/u);
        expect(first).not.toContain(INVOCATION);
      }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
  );

  it.effect('the first creation of an operation reserves its issuance for the provider callback', () =>
    Effect.gen(function* firstCreation() {
      const replay = yield* CommercePortalAuthVerificationReplay;
      const handoff = yield* CommercePortalAuthProtectedHandoff;
      expect(yield* replay.begin({ ownerInvocationId: INVOCATION, providerSubjectId: SUBJECT, replay: false })).toBe(
        'ISSUE',
      );
      const reserved = Option.getOrThrow(yield* handoff.takeReservation('verify-email', SUBJECT));
      expect(reserved.enrollmentOwnerInvocationId).toBe(INVOCATION);
      expect(reserved.issuanceRef).toBe(yield* enrollmentVerificationIssuanceRef(INVOCATION));
      // release drops a reservation nobody took, so a user-initiated resend can never borrow it
      yield* replay.begin({ ownerInvocationId: INVOCATION, providerSubjectId: SUBJECT, replay: false });
      yield* replay.release({ providerSubjectId: SUBJECT });
      expect(Option.isNone(yield* handoff.takeReservation('verify-email', SUBJECT))).toBe(true);
    }).pipe(Effect.provide(replayWith('NOT_SUBMITTED')), Effect.provide(commercePortalAuthPlatformCryptoLive)),
  );

  it.effect('a replay issues only when Communications has NO request for the issuance', () =>
    Effect.gen(function* notSubmitted() {
      const { decision, reserved } = yield* replayOutcome(replayWith('NOT_SUBMITTED'));
      expect(decision).toMatchObject({ success: 'ISSUE' });
      expect(Option.isSome(reserved)).toBe(true);
    }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
  );

  it.effect(
    'REGRESSION: a request this process submitted whose answer was lost is never NOT_SUBMITTED: a replay issues no second link',
    () =>
      Effect.gen(function* lostAnswer() {
        const handoff = yield* CommercePortalAuthProtectedHandoff;
        const replay = yield* CommercePortalAuthVerificationReplay;
        const issuanceRef = yield* enrollmentVerificationIssuanceRef(INVOCATION);
        const issuedAt = DateTime.makeUnsafe('2026-11-19T10:00:00.000Z');
        // the first creation held the issuance with its request; Communications may have admitted it with a lost answer
        yield* holdWithRequest(
          handoff,
          {
            endpoint: Redacted.make('fictional@example.test'),
            issuance: {
              expiresAt: DateTime.add(issuedAt, { hours: 1 }),
              flow: 'verify-email',
              issuanceRef,
              issuedAt,
              providerSubjectId: SUBJECT,
            },
            secret: Redacted.make('https://fictional.example.test/verify'),
          },
          true,
        );
        const decision = yield* replay.begin({
          ownerInvocationId: INVOCATION,
          providerSubjectId: SUBJECT,
          replay: true,
        });
        expect(decision).toBe('NO_NEW_ISSUANCE');
        expect(Option.isNone(yield* handoff.takeReservation('verify-email', SUBJECT))).toBe(true);
      }).pipe(Effect.provide(replayWith('NOT_SUBMITTED')), Effect.provide(commercePortalAuthPlatformCryptoLive)),
  );

  for (const outcome of ['IN_PROGRESS', 'ACCEPTED', 'UNCERTAIN', 'NON_ACCEPTANCE_PROVEN'] as const) {
    it.effect(
      `[${outcome}] a replay sends nothing and issues nothing: the message exists or continues under its own recovery rule`,
      () =>
        Effect.gen(function* noNewIssuance() {
          const { decision, reserved } = yield* replayOutcome(replayWith(outcome));
          expect(decision).toMatchObject({ success: 'NO_NEW_ISSUANCE' });
          expect(Option.isNone(reserved)).toBe(true);
        }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
    );
  }

  it.effect('[STOPPED] a replay never repairs a stopped message by issuing another link', () =>
    Effect.gen(function* stopped() {
      const { decision, reserved } = yield* replayOutcome(replayWith('STOPPED'));
      expect(decision).toMatchObject({
        failure: { _tag: 'VerificationReplayUnavailable', reason: 'PREVIOUS_ISSUANCE_STOPPED' },
      });
      expect(Option.isNone(reserved)).toBe(true);
    }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
  );

  it.effect('an unavailable outcome Read (the production default) sends nothing and issues nothing', () => {
    const handoff = handoffOverDouble(() => Effect.succeed('CURRENT'));
    const layer = Layer.mergeAll(
      handoff,
      verificationReplayLayer.pipe(
        Layer.provide(
          Layer.mergeAll(handoff, unavailableCommunicationOutcomeReaderLayer, commercePortalAuthPlatformCryptoLive),
        ),
      ),
    );
    return Effect.gen(function* unavailable() {
      const { decision, reserved } = yield* replayOutcome(layer);
      expect(decision).toMatchObject({
        failure: { _tag: 'VerificationReplayUnavailable', reason: 'OUTCOME_UNAVAILABLE' },
      });
      expect(Option.isNone(reserved)).toBe(true);
    }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive));
  });
});
