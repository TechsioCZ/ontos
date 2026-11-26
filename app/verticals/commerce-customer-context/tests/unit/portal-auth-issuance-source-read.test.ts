import { ReadHandlerUnavailable } from '@app/core-runtime';
import { DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import {
  PortalAuthIssuanceSourceRequestSchema,
  PortalAuthRecipientSubjectIdSchema,
  PortalAuthIssuanceSourceResponseSchema,
} from '@app/portal-auth-contracts/portal-auth-issuance-source';
import { PORTAL_AUTH_ISSUANCE_STATE, PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow } from '../../shared/portal-auth-communications.ts';
import { portalAuthIssuanceSourceAnswer } from '../../src/api/portal-auth-issuance-source.read.ts';
import { PortalAuthIssuanceStateUnavailable } from '../../src/portal-auth/communications/issuance-state-unavailable.ts';
import type { HeldIssuance } from '../../src/portal-auth/communications/issuance.ts';
import {
  CommercePortalAuthProtectedHandoff,
  protectedHandoffLayer,
} from '../../src/portal-auth/communications/protected-handoff.ts';
import type {
  IssuanceLedgerProbe,
  ProtectedHandoffService,
} from '../../src/portal-auth/communications/protected-handoff.ts';
import { portalAuthCommunicationRequest } from '../../src/portal-auth/communications/request.ts';
import {
  communicationStoreLayers,
  makeCommunicationStoreDouble,
} from '../support/portal-auth-communication-store.double.ts';

/**
 * #1394 BR-05 / #1395 BR-03 / #1401 I-07: the owner Read through which Communications asks Portal Auth, at the decision and at
 * the last stoppable handoff, for the issuance state and the Current original-endpoint binding. It answers Auth's own lifecycle
 * and the mask only, and never the address, token, link or code. The store is the labelled in-memory double; every value is
 * FICTIONAL.
 */

const ref = Schema.decodeSync(PortalAuthIssuanceRefSchema);
const SECRET = 'https://portal.example.test/api/portal-auth/verify-email?token=fictional-token';
const ADDRESS = 'holder@example.test';
const LEDGER_TOKEN = 'fictional-ledger-token';
const ISSUED_AT = DateTime.makeUnsafe('2026-11-19T10:00:00.000Z');
const TENANT = '7e000000-0000-4000-8000-000000000001';

const held = (flow: PortalAuthEmailFlow, name: string, subject = 'subject-1'): HeldIssuance => ({
  endpoint: Redacted.make(ADDRESS),
  issuance: {
    expiresAt: DateTime.add(ISSUED_AT, { minutes: 15 }),
    flow,
    issuanceRef: ref(name),
    issuedAt: ISSUED_AT,
    providerSubjectId: subject,
  },
  ledgerToken: Redacted.make(LEDGER_TOKEN),
  secret: Redacted.make(SECRET),
});

type ProbedState = Effect.Success<ReturnType<IssuanceLedgerProbe>>;
const probing = (state: ProbedState) => state;
const offered = { unreadable: false, value: probing('CURRENT') };
const probe: IssuanceLedgerProbe = (entry) =>
  offered.unreadable
    ? Effect.fail(new PortalAuthIssuanceStateUnavailable({ flow: entry.issuance.flow }))
    : Effect.succeed(offered.value);

const withHandoff = Effect.suspend(() => {
  offered.unreadable = false;
  offered.value = probing('CURRENT');
  return Effect.gen(function* handoff() {
    return yield* CommercePortalAuthProtectedHandoff;
  }).pipe(
    Effect.provide(
      protectedHandoffLayer(probe).pipe(
        Layer.provide(communicationStoreLayers(makeCommunicationStoreDouble().service)),
      ),
    ),
  );
});

const holding = (handoff: ProtectedHandoffService, value: HeldIssuance) =>
  portalAuthCommunicationRequest(value.issuance, { tenantId: TENANT }).pipe(
    Effect.flatMap((request) => handoff.hold(value, { request, supersede: true, tenantId: TENANT })),
  );

const answer = (handoff: ProtectedHandoffService, issuanceRef: string, recipientSubjectId?: string) =>
  portalAuthIssuanceSourceAnswer(
    recipientSubjectId === undefined
      ? { issuanceRef: ref(issuanceRef) }
      : {
          issuanceRef: ref(issuanceRef),
          recipientSubjectId: Schema.decodeSync(PortalAuthRecipientSubjectIdSchema)(recipientSubjectId),
        },
    { handoff: Option.some(handoff) },
  );

describe('The Portal Auth issuance source Read (#1394 BR-05, #1395 BR-03)', () => {
  it.effect(
    'answers a Current issuance with its state and, for its own account, the Current original endpoint mask',
    () =>
      Effect.gen(function* currentIssuance() {
        const handoff = yield* withHandoff;
        yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
        yield* holding(handoff, held('verify-email', 'pa-1'));
        expect(yield* answer(handoff, 'pa-1')).toStrictEqual({
          issuanceRef: 'pa-1',
          kind: 'FACTS',
          latestRevision: 1,
          state: PORTAL_AUTH_ISSUANCE_STATE.current,
        });
        expect(yield* answer(handoff, 'pa-1', 'subject-1')).toStrictEqual({
          issuanceRef: 'pa-1',
          kind: 'FACTS',
          latestRevision: 1,
          originalEndpoint: { kind: 'CURRENT', mask: 'h***@example.test' },
          state: PORTAL_AUTH_ISSUANCE_STATE.current,
        });
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect('reports each Auth lifecycle state as its own closed state with no Current endpoint', () =>
    Effect.gen(function* lifecycle() {
      const handoff = yield* withHandoff;
      yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
      yield* holding(handoff, held('verify-email', 'pa-l'));
      const probedStates = [
        ['CONSUMED', PORTAL_AUTH_ISSUANCE_STATE.consumed],
        ['EXPIRED', PORTAL_AUTH_ISSUANCE_STATE.expired],
        ['NOT_RESUMABLE', PORTAL_AUTH_ISSUANCE_STATE.notResumable],
        ['SUPERSEDED', PORTAL_AUTH_ISSUANCE_STATE.superseded],
      ] as const;
      for (const [probed, state] of probedStates) {
        offered.value = probed;
        const reported = yield* answer(handoff, 'pa-l', 'subject-1');
        expect(reported).toStrictEqual({
          issuanceRef: 'pa-l',
          kind: 'FACTS',
          latestRevision: 1,
          originalEndpoint: { kind: 'NOT_CURRENT' },
          state,
        });
      }
      // only Auth's own settlement is a revocation; its row then states the closed reason
      offered.value = probing('CURRENT');
      yield* handoff.settle({ issuanceRef: ref('pa-l'), state: 'REVOKED' });
      expect(yield* answer(handoff, 'pa-l', 'subject-1')).toStrictEqual({
        issuanceRef: 'pa-l',
        kind: 'FACTS',
        latestRevision: 1,
        originalEndpoint: { kind: 'NOT_CURRENT' },
        state: PORTAL_AUTH_ISSUANCE_STATE.revoked,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect('reports an issuance past its expiry as expired, and one Auth no longer holds as not resumable', () =>
    Effect.gen(function* expiry() {
      const handoff = yield* withHandoff;
      yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
      yield* holding(handoff, held('otp', 'pa-x'));
      yield* TestClock.setTime(DateTime.add(ISSUED_AT, { minutes: 16 }).epochMilliseconds);
      expect(yield* answer(handoff, 'pa-x', 'subject-1')).toMatchObject({
        originalEndpoint: { kind: 'NOT_CURRENT' },
        state: PORTAL_AUTH_ISSUANCE_STATE.expired,
      });
      expect(yield* answer(handoff, 'pa-unknown', 'subject-1')).toMatchObject({
        originalEndpoint: { kind: 'NOT_CURRENT' },
        state: PORTAL_AUTH_ISSUANCE_STATE.notResumable,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect('an issuance of ANOTHER account answers nothing, so the same address on two accounts never merges', () =>
    Effect.gen(function* otherAccount() {
      const handoff = yield* withHandoff;
      yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
      yield* holding(handoff, held('reset-password', 'pa-o', 'subject-1'));
      expect(yield* answer(handoff, 'pa-o', 'subject-2')).toStrictEqual({ kind: 'NO_FACTS' });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect('an owner that cannot state the lifecycle is a typed unavailable failure, never a state', () =>
    Effect.gen(function* unreadable() {
      const handoff = yield* withHandoff;
      yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
      yield* holding(handoff, held('verify-email', 'pa-u'));
      offered.unreadable = true;
      const failure = yield* Effect.flip(answer(handoff, 'pa-u', 'subject-1'));
      expect(Schema.is(Schema.instanceOf(ReadHandlerUnavailable))(failure)).toBe(true);
      // a deployment that composes no protected handoff states nothing
      const none = yield* Effect.flip(
        portalAuthIssuanceSourceAnswer({ issuanceRef: ref('pa-u') }, { handoff: Option.none() }),
      );
      expect(Schema.is(Schema.instanceOf(ReadHandlerUnavailable))(none)).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect('no answer can carry the address, the secret, the ledger token or a Redacted value', () =>
    Effect.gen(function* noSecrets() {
      const handoff = yield* withHandoff;
      yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
      yield* holding(handoff, held('verify-email', 'pa-s'));
      const reported = yield* answer(handoff, 'pa-s', 'subject-1');
      const text = JSON.stringify(Schema.encodeUnknownSync(PortalAuthIssuanceSourceResponseSchema)(reported));
      for (const secret of [ADDRESS, SECRET, LEDGER_TOKEN, 'fictional-token']) {
        expect(text).not.toContain(secret);
      }
      // the published schema refuses an extra field, so an owner cannot widen the answer with an address
      expect(() =>
        Schema.decodeUnknownSync(PortalAuthIssuanceSourceResponseSchema, { onExcessProperty: 'error' })({
          issuanceRef: 'pa-s',
          kind: 'FACTS',
          latestRevision: 1,
          originalEndpoint: { address: ADDRESS, kind: 'CURRENT', mask: 'h***@example.test' },
          state: PORTAL_AUTH_ISSUANCE_STATE.current,
        }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(PortalAuthIssuanceSourceRequestSchema, { onExcessProperty: 'error' })({
          issuanceRef: 'pa-s',
          token: SECRET,
        }),
      ).toThrow();
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
