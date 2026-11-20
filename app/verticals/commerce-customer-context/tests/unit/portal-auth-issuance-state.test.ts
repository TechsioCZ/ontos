import { DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { ledgerProbeOver } from '../../api/portal-auth/provider/communications-ledger-probe.ts';
import { COMMERCE_PORTAL_AUTH_MFA_POLICY } from '../../api/portal-auth/provider/mfa/plugin.ts';
import { PORTAL_AUTH_ISSUANCE_STATE, PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow } from '../../shared/portal-auth-communications.ts';
import { CommercePortalAuthCommunicationOutcomeReader } from '../../src/portal-auth/communications/communication-outcome-reader.ts';
import type { HeldIssuance, IssuanceCurrentness } from '../../src/portal-auth/communications/issuance.ts';
import { issuanceSourceStateOf } from '../../src/portal-auth/communications/owner-facts.ts';
import { OwnerSlotStopReasonSchema } from '../../src/portal-auth/communications/owner-slot-stop.ts';
import {
  CommercePortalAuthProtectedHandoff,
  protectedHandoffLayer,
} from '../../src/portal-auth/communications/protected-handoff.ts';
import {
  CommercePortalAuthVerificationReplay,
  verificationReplayLayer,
} from '../../src/portal-auth/communications/verification-replay.ts';

/**
 * #1406 own-reason stops and OTP state: each lifecycle end of an issuance is its OWN state key (Communications maps each to its own
 * closed history reason), a one-time code's state is read from the real two-factor challenge, a restart stops truthfully and a
 * concurrent replay never issues a second link. Every value is FICTIONAL.
 */

const INVOCATION = '22222222-2222-4222-8222-222222222222';
const PA_OTP_3 = Schema.decodeSync(PortalAuthIssuanceRefSchema)('pa-otp-3');
const ISSUED_AT = DateTime.makeUnsafe('2026-11-19T10:00:00.000Z');
const heldOf = (flow: PortalAuthEmailFlow, ref: string, withToken = true): HeldIssuance => ({
  endpoint: Redacted.make('fictional@example.test'),
  issuance: {
    expiresAt: DateTime.add(ISSUED_AT, { minutes: 10 }),
    flow,
    issuanceRef: Schema.decodeSync(PortalAuthIssuanceRefSchema)(ref),
    issuedAt: ISSUED_AT,
    providerSubjectId: 'subject-1',
  },
  ...(withToken ? { ledgerToken: Redacted.make('2fa-otp-fictional-key') } : {}),
  secret: Redacted.make('fictional-secret'),
});

const storeOver = (challenge: Option.Option<{ attempts: number }>) => ({
  peekEmailVerificationLedger: () => Effect.succeed(Option.none()),
  peekPasswordResetLedger: () => Effect.succeed(Option.none()),
  readOtpChallenge: ({ challenge: key }: { challenge: Redacted.Redacted }) =>
    Effect.succeed(
      Option.map(challenge, ({ attempts }) => ({
        attempts,
        challenge: key,
        expiresAt: new Date('2026-11-19T10:10:00Z'),
      })),
    ),
});

describe('Portal Auth issuance states and the one-time code state (#1406)', () => {
  it('every lifecycle end is its OWN source state key, and every owner-slot stop reason is distinct', () => {
    const states = (
      [
        'CONSUMED',
        'CURRENT',
        'EXPIRED',
        'NO_LONGER_CURRENT',
        'NOT_RESUMABLE',
        'REVOKED',
        'SUPERSEDED',
      ] satisfies readonly IssuanceCurrentness[]
    ).map(issuanceSourceStateOf);
    expect(states.filter((state) => state !== PORTAL_AUTH_ISSUANCE_STATE.current)).toContain(
      PORTAL_AUTH_ISSUANCE_STATE.superseded,
    );
    // NO_LONGER_CURRENT is the ledger's own "not offered any more" (it cannot say which): it shares REVOKED's key, nothing else shares one
    expect(new Set(states).size).toBe(6);
    expect(OwnerSlotStopReasonSchema.literals).toContain('SUPERSEDED');
  });

  it.effect(
    'a one-time code is CURRENT only while its two-factor challenge exists below the plugin failed-attempt limit',
    () =>
      Effect.gen(function* otpState() {
        const held = heldOf('otp', 'pa-otp-1');
        const limit = COMMERCE_PORTAL_AUTH_MFA_POLICY.maxFailedAttempts;
        expect(yield* ledgerProbeOver(storeOver(Option.some({ attempts: 0 })))(held)).toBe('CURRENT');
        expect(yield* ledgerProbeOver(storeOver(Option.some({ attempts: limit - 1 })))(held)).toBe('CURRENT');
        // exhausted: the plugin refuses it, so it is never sent as a valid code
        expect(yield* ledgerProbeOver(storeOver(Option.some({ attempts: limit })))(held)).toBe('CONSUMED');
        // consumed by a verification (the plugin deletes the challenge) or spent
        expect(yield* ledgerProbeOver(storeOver(Option.none()))(held)).toBe('CONSUMED');
        // a code whose challenge was never located has nothing to be current against
        expect(yield* ledgerProbeOver(storeOver(Option.some({ attempts: 0 })))(heldOf('otp', 'pa-otp-2', false))).toBe(
          'NO_LONGER_CURRENT',
        );
      }),
  );

  it.effect('a restart (a fresh handoff that never held the issuance) is NOT_RESUMABLE and reveals nothing', () =>
    Effect.gen(function* restarted() {
      yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
      const live = yield* Effect.provide(
        Effect.gen(function* hold() {
          const handoff = yield* CommercePortalAuthProtectedHandoff;
          yield* handoff.hold(heldOf('otp', 'pa-otp-3'), { supersede: true });
          return yield* handoff.currentness(PA_OTP_3);
        }),
        protectedHandoffLayer(() => Effect.succeed('CURRENT')),
      );
      expect(live).toBe('CURRENT');
      // the process is gone: its handoff is a new instance that was never given the issuance
      const [state, stop] = yield* Effect.provide(
        Effect.gen(function* afterRestart() {
          const handoff = yield* CommercePortalAuthProtectedHandoff;
          return [
            yield* handoff.currentness(PA_OTP_3),
            yield* Effect.flip(handoff.revealSecret({ flow: 'otp', issuanceRef: PA_OTP_3, slot: 'otp_code' })),
          ] as const;
        }),
        protectedHandoffLayer(() => Effect.succeed('CURRENT')),
      );
      expect(state).toBe('NOT_RESUMABLE');
      expect(stop).toMatchObject({ reason: 'NOT_RESUMABLE' });
      expect(JSON.stringify(stop)).not.toContain('fictional-secret');
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    'CONCURRENT replays of one enrollment operation never issue a second link while its request is held',
    () => {
      const handoff = protectedHandoffLayer(() => Effect.succeed('CURRENT'));
      const reader = Layer.succeed(CommercePortalAuthCommunicationOutcomeReader, {
        outcomeOf: () => Effect.succeed('NOT_SUBMITTED' as const),
      });
      const world = Layer.mergeAll(
        handoff,
        verificationReplayLayer.pipe(
          Layer.provide(Layer.mergeAll(handoff, reader, commercePortalAuthPlatformCryptoLive)),
        ),
      );
      return Effect.gen(function* concurrent() {
        yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
        const replay = yield* CommercePortalAuthVerificationReplay;
        const store = yield* CommercePortalAuthProtectedHandoff;
        const begin = replay.begin({ ownerInvocationId: INVOCATION, providerSubjectId: 'subject-1', replay: true });
        const first = yield* begin;
        // the first creation held its issuance and submitted; the replays now race while the answer is lost
        const ref = Option.getOrThrow(yield* store.takeReservation('verify-email', 'subject-1')).issuanceRef;
        yield* store.hold(heldOf('verify-email', ref, false), { supersede: true });
        const results = yield* Effect.all(
          Array.from({ length: 8 }, () => begin),
          { concurrency: 'unbounded' },
        );
        expect(first).toBe('ISSUE');
        expect(results.every((decision) => decision === 'NO_NEW_ISSUANCE')).toBe(true);
        expect(Option.isNone(yield* store.takeReservation('verify-email', 'subject-1'))).toBe(true);
      }).pipe(Effect.provide(world), Effect.provide(TestClock.layer()));
    },
  );
});
