import { inspect } from 'node:util';

import { DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { withCause } from '../../api/portal-auth/problems-support.ts';
import { ledgerProbeOver } from '../../api/portal-auth/provider/communications-ledger-probe.ts';
import { CommercePortalAuthRecoveryUnavailable } from '../../api/portal-auth/provider/recovery/unavailable.ts';
import type { CommercePortalAuthIssuanceLedgerState } from '../../api/portal-auth/provider/recovery/store-service.ts';
import { PORTAL_AUTH_ISSUANCE_STATE, PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow } from '../../shared/portal-auth-communications.ts';
import { CommercePortalAuthCommunicationOutcomeReader } from '../../src/portal-auth/communications/communication-outcome-reader.ts';
import { IssuanceCurrentnessSchema } from '../../src/portal-auth/communications/issuance.ts';
import type { HeldIssuance, IssuanceCurrentness } from '../../src/portal-auth/communications/issuance.ts';
import { PortalAuthIssuanceStateUnavailable } from '../../src/portal-auth/communications/issuance-state-unavailable.ts';
import { issuanceSourceStateOf } from '../../src/portal-auth/communications/owner-facts.ts';
import { OwnerSlotStopReasonSchema } from '../../src/portal-auth/communications/owner-slot-stop.ts';
import { CommercePortalAuthProtectedHandoff } from '../../src/portal-auth/communications/protected-handoff.ts';
import {
  CommercePortalAuthVerificationReplay,
  verificationReplayLayer,
} from '../../src/portal-auth/communications/verification-replay.ts';
import { handoffOverDouble, holdWithRequest } from '../support/portal-auth-communication-store.double.ts';

/**
 * #1406 own-reason stops and OTP state: each lifecycle end of an issuance is its OWN state key (Communications maps each to its own
 * closed history reason), a one-time code's state is read from the real two-factor challenge, a restart stops truthfully and a
 * concurrent replay never issues a second link. Every value is FICTIONAL.
 */

const INVOCATION = '22222222-2222-4222-8222-222222222222';
const PA_OTP_3 = Schema.decodeSync(PortalAuthIssuanceRefSchema)('pa-otp-3');
const ISSUED_AT = DateTime.makeUnsafe('2026-11-19T10:00:00.000Z');
const heldOf = (flow: PortalAuthEmailFlow, ref: string, ledgerToken?: Redacted.Redacted): HeldIssuance => {
  const base = {
    endpoint: Redacted.make('fictional@example.test'),
    issuance: {
      expiresAt: DateTime.add(ISSUED_AT, { minutes: 10 }),
      flow,
      issuanceRef: Schema.decodeSync(PortalAuthIssuanceRefSchema)(ref),
      issuedAt: ISSUED_AT,
      providerSubjectId: 'subject-1',
    },
    secret: Redacted.make('fictional-secret'),
  } satisfies HeldIssuance;
  return ledgerToken === undefined ? base : { ...base, ledgerToken };
};
const OTP_CHALLENGE = Redacted.make('fictional-challenge-id');

/** A store whose three issuance reads answer the scripted real state of Auth's own rows. */
const storeAnswering = (state: CommercePortalAuthIssuanceLedgerState) => {
  const reads: string[] = [];
  const read = (flow: string) => () =>
    Effect.sync(() => {
      reads.push(flow);
      return state;
    });
  return {
    reads,
    store: {
      readEmailVerificationIssuanceState: read('verify-email'),
      readOtpIssuanceState: read('otp'),
      readPasswordResetIssuanceState: read('reset-password'),
    },
  };
};

describe('Portal Auth issuance states and the one-time code state (#1406)', () => {
  it('every lifecycle end is its OWN source state key, and no state is shared or a catch-all', () => {
    const states = (
      [
        'CONSUMED',
        'CURRENT',
        'EXPIRED',
        'NOT_RESUMABLE',
        'REVOKED',
        'SUPERSEDED',
      ] satisfies readonly IssuanceCurrentness[]
    ).map((currentness) => issuanceSourceStateOf(currentness));
    expect(states.filter((state) => state !== PORTAL_AUTH_ISSUANCE_STATE.current)).toContain(
      PORTAL_AUTH_ISSUANCE_STATE.superseded,
    );
    // the ledger's "not offered any more" no longer exists as a state: it could not say which end it was, so it is never mapped to REVOKED
    expect(new Set(states).size).toBe(6);
    expect(IssuanceCurrentnessSchema.literals).not.toContain('NO_LONGER_CURRENT');
    expect(OwnerSlotStopReasonSchema.literals).toContain('SUPERSEDED');
    expect(OwnerSlotStopReasonSchema.literals).not.toContain('NO_LONGER_CURRENT');
  });

  it.effect("the probe reports each REAL state of Auth's rows as its own state and never as revoked", () =>
    Effect.gen(function* realStates() {
      const expected = [
        ['CONSUMED', 'CONSUMED'],
        ['CURRENT', 'CURRENT'],
        ['EXPIRED', 'EXPIRED'],
        ['NOT_LOCATED', 'NOT_RESUMABLE'],
        ['SUPERSEDED', 'SUPERSEDED'],
      ] as const satisfies readonly (readonly [CommercePortalAuthIssuanceLedgerState, IssuanceCurrentness])[];
      for (const flow of ['verify-email', 'reset-password', 'otp'] as const) {
        for (const [state, probed] of expected) {
          const { reads, store } = storeAnswering(state);
          expect(yield* ledgerProbeOver(store)(heldOf(flow, `pa-${flow}`, OTP_CHALLENGE))).toBe(probed);
          // exactly the read of THIS flow was made: the flows never read each other's rows
          expect(reads).toEqual([flow]);
          expect(issuanceSourceStateOf(probed)).not.toBe(PORTAL_AUTH_ISSUANCE_STATE.revoked);
        }
      }
    }),
  );

  it.effect(
    'an issuance without a ledger token was not located: NOT_RESUMABLE, never revoked, and nothing is read',
    () =>
      Effect.gen(function* notLocated() {
        for (const flow of ['verify-email', 'reset-password', 'otp'] as const) {
          const { reads, store } = storeAnswering('CURRENT');
          const state = yield* ledgerProbeOver(store)(heldOf(flow, `pa-${flow}-1`));
          expect(state).toBe('NOT_RESUMABLE');
          expect(issuanceSourceStateOf(state)).toBe(PORTAL_AUTH_ISSUANCE_STATE.notResumable);
          expect(reads).toEqual([]);
        }
      }),
  );

  it.effect('an unreadable ledger is uncertainty carrying only the safe kind of the failure', () =>
    Effect.gen(function* unreadable() {
      const secret = 'fictional-secret';
      const failure = () =>
        Effect.fail(
          withCause(
            new CommercePortalAuthRecoveryUnavailable({
              operation: 'ledger-read',
              reason: 'The ledger is unavailable',
            }),
            new Error(`select ... params: ${secret}`),
          ),
        );
      const failing = {
        readEmailVerificationIssuanceState: failure,
        readOtpIssuanceState: failure,
        readPasswordResetIssuanceState: failure,
      };
      for (const flow of ['verify-email', 'reset-password', 'otp'] as const) {
        const unavailable = yield* Effect.flip(ledgerProbeOver(failing)(heldOf(flow, `pa-${flow}-2`, OTP_CHALLENGE)));
        expect(Schema.is(PortalAuthIssuanceStateUnavailable)(unavailable)).toBe(true);
        expect(inspect(unavailable, { depth: 8, showHidden: true })).not.toContain(secret);
      }
    }),
  );

  it.effect('a handoff over a store that never recorded the issuance is NOT_RESUMABLE and reveals nothing', () =>
    Effect.gen(function* restarted() {
      yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
      const live = yield* Effect.provide(
        Effect.gen(function* hold() {
          const handoff = yield* CommercePortalAuthProtectedHandoff;
          yield* holdWithRequest(handoff, heldOf('otp', 'pa-otp-3', OTP_CHALLENGE), true);
          return yield* handoff.currentness(PA_OTP_3);
        }),
        handoffOverDouble(() => Effect.succeed('CURRENT')),
      );
      expect(live).toBe('CURRENT');
      // another store (a deployment that never recorded the issuance) answers nothing; one process restarting over the SAME
      // store resumes it, which `portal-auth-protected-handoff.test.ts` and the PostgreSQL suite prove
      const [state, stop] = yield* Effect.provide(
        Effect.gen(function* afterRestart() {
          const handoff = yield* CommercePortalAuthProtectedHandoff;
          return [
            yield* handoff.currentness(PA_OTP_3),
            yield* Effect.flip(handoff.revealSecret({ flow: 'otp', issuanceRef: PA_OTP_3, slot: 'otp_code' })),
          ] as const;
        }),
        handoffOverDouble(() => Effect.succeed('CURRENT')),
      );
      expect(state).toBe('NOT_RESUMABLE');
      expect(stop).toMatchObject({ reason: 'NOT_RESUMABLE' });
      expect(JSON.stringify(stop)).not.toContain('fictional-secret');
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    'CONCURRENT replays of one enrollment operation never issue a second link while its request is held',
    () => {
      const handoff = handoffOverDouble(() => Effect.succeed('CURRENT'));
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
        yield* holdWithRequest(store, heldOf('verify-email', ref), true);
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
