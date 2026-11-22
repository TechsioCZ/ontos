import { DateTime, Effect, Layer, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import type { PortalAuthSubmission } from '../../src/portal-auth/communications/communication-request-submitter.ts';
import { CommercePortalAuthCommunicationStore } from '../../src/portal-auth/communications/communication-store.ts';
import {
  CommercePortalAuthCommunicationDecisionReporter,
  communicationDecisionReporterLayer,
} from '../../src/portal-auth/communications/decision-report.ts';
import type { PortalAuthIssuance } from '../../src/portal-auth/communications/issuance.ts';
import { portalAuthCommunicationRequest, storedRequestOf } from '../../src/portal-auth/communications/request.ts';
import { makeCommunicationStoreDouble } from '../support/portal-auth-communication-store.double.ts';

/**
 * #1406 D4: the completion callback of the relay path. When the module's source worker learns Communications' decision, it
 * reports it back and Auth ends its outbox row with the safe summary; a decision that leaves no message erases the issuance's
 * sealed value now, not at its expiry. The store is the labelled double; every value is FICTIONAL.
 */

const TENANT = '7e000000-0000-4000-8000-0000000000f1';
const ISSUED_AT = DateTime.makeUnsafe('2026-11-22T10:00:00.000Z');
const SEALED = 'v1.fictional-sealed-value';

const issuanceOf = (name: string): PortalAuthIssuance => ({
  expiresAt: DateTime.add(ISSUED_AT, { minutes: 30 }),
  flow: 'otp',
  issuanceRef: Schema.decodeSync(PortalAuthIssuanceRefSchema)(name),
  issuedAt: ISSUED_AT,
  providerSubjectId: 'subject-decision-report',
});

const decided = (
  decision: Extract<PortalAuthSubmission, { outcome: 'DECIDED' }>['decision'],
): PortalAuthSubmission => ({
  decision,
  decisionId: '5d000000-0000-4000-8000-0000000000f1',
  outcome: 'DECIDED',
  replayed: false,
  requestId: '5d000000-0000-4000-8000-0000000000f2',
});
const intent = (status: 'NOT_SENT' | 'PENDING_HANDOFF' | 'SUPPRESSED') => ({
  intentId: '5d000000-0000-4000-8000-0000000000f3',
  status,
});

/** One issuance committed and relayed, then the given answer reported back (twice, as a redelivery would). */
const reportedAfterRelay = Effect.fn('PortalAuthDecisionReportTest.run')(function* run(
  name: string,
  answer: PortalAuthSubmission | { readonly refused: string },
) {
  const store = makeCommunicationStoreDouble();
  const issuance = issuanceOf(name);
  const request = yield* portalAuthCommunicationRequest(issuance, { tenantId: TENANT });
  yield* store.service.record({
    issuance,
    now: ISSUED_AT,
    request: yield* storedRequestOf(request),
    sealedValue: SEALED,
    supersede: false,
    tenantId: TENANT,
  });
  // the relay handed the row on: RELAYED, decided later by Communications
  yield* store.service.claimDue({
    leaseMillis: 30_000,
    leaseOwner: 'relay',
    limit: 8,
    now: ISSUED_AT,
    tenantId: TENANT,
  });
  yield* store.service.complete({
    forget: false,
    issuanceRef: issuance.issuanceRef,
    leaseOwner: 'relay',
    now: ISSUED_AT,
    outcome: Option.some('{"outcome":"RELAYED"}'),
    state: 'RELAYED',
  });
  const reporter = yield* CommercePortalAuthCommunicationDecisionReporter.pipe(
    Effect.provide(
      communicationDecisionReporterLayer.pipe(
        Layer.provide(Layer.succeed(CommercePortalAuthCommunicationStore, store.service)),
      ),
    ),
  );
  const report = 'refused' in answer ? reporter.refused(request, answer.refused) : reporter.decided(request, answer);
  yield* report;
  const first = (yield* Ref.get(store.outbox)).get(name);
  // the same answer again, as a redelivery or a replayed submission returns it
  yield* report;
  return {
    first,
    row: (yield* Ref.get(store.outbox)).get(name),
    sealed: (yield* Ref.get(store.issuances)).get(name)?.sealedValue ?? Option.none(),
  };
});

describe('The Portal Auth relay completion callback (#1406 D4)', () => {
  it.effect('a NO_MESSAGE decision ends the row with its safe summary and erases the sealed value now', () =>
    Effect.gen(function* noMessage() {
      const { row, sealed } = yield* reportedAfterRelay(
        'pa-report-1',
        decided({ kind: 'NO_MESSAGE', reason: 'NO_TYPE' }),
      );
      expect(row?.state).toBe('DECIDED');
      expect(Option.getOrUndefined(row?.outcome ?? Option.none())).toBe(
        '{"decision":{"kind":"NO_MESSAGE","reason":"NO_TYPE"},"decisionId":"5d000000-0000-4000-8000-0000000000f1","outcome":"DECIDED","replayed":false,"requestId":"5d000000-0000-4000-8000-0000000000f2"}',
      );
      expect(Option.isNone(sealed)).toBe(true);
      expect(JSON.stringify(row)).not.toContain(SEALED);
    }),
  );

  it.effect('a decision whose intents are only suppressed or not sent erases the sealed value now', () =>
    Effect.gen(function* suppressed() {
      const { row, sealed } = yield* reportedAfterRelay(
        'pa-report-2',
        decided({ intents: [intent('SUPPRESSED'), intent('NOT_SENT')], kind: 'MESSAGE_INTENTS' }),
      );
      expect(row?.state).toBe('DECIDED');
      expect(Option.isNone(sealed)).toBe(true);
    }),
  );

  it.effect('a conflict leaves no message either, so its sealed value is erased now', () =>
    Effect.gen(function* conflict() {
      const { row, sealed } = yield* reportedAfterRelay('pa-report-3', {
        originalDecisionId: '5d000000-0000-4000-8000-0000000000f4',
        outcome: 'CONFLICT',
        requestId: '5d000000-0000-4000-8000-0000000000f2',
      });
      expect(row?.state).toBe('CONFLICT');
      expect(Option.isNone(sealed)).toBe(true);
    }),
  );

  it.effect('a message still on its way keeps the sealed value for its owner slot', () =>
    Effect.gen(function* pending() {
      const { row, sealed } = yield* reportedAfterRelay(
        'pa-report-4',
        decided({ intents: [intent('PENDING_HANDOFF'), intent('SUPPRESSED')], kind: 'MESSAGE_INTENTS' }),
      );
      expect(row?.state).toBe('DECIDED');
      expect(Option.contains(sealed, SEALED)).toBe(true);
    }),
  );

  it.effect('a repeated report of the same decision changes nothing further: the row keeps its first outcome', () =>
    Effect.gen(function* replay() {
      const { first, row } = yield* reportedAfterRelay(
        'pa-report-5',
        decided({ kind: 'NO_MESSAGE', reason: 'NO_TYPE' }),
      );
      expect(row).toStrictEqual(first);
    }),
  );

  it.effect('D5: a final refusal ends the row REFUSED with its closed code only and erases the sealed value now', () =>
    Effect.gen(function* refused() {
      const { first, row, sealed } = yield* reportedAfterRelay('pa-report-6', {
        refused: 'communication_request_invalid',
      });
      expect(row?.state).toBe('REFUSED');
      expect(Option.getOrUndefined(row?.outcome ?? Option.none())).toBe(
        '{"code":"communication_request_invalid","outcome":"REFUSED"}',
      );
      expect(Option.isNone(sealed)).toBe(true);
      expect(row).toStrictEqual(first);
    }),
  );
});
