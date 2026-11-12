import { DateTime, Effect, Match, Option, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { GatewayCollectRequestSchema } from '../../src/integrations/psp/psp-request.ts';
import type { GatewayExpectedEffect, GatewayLookupRequest } from '../../src/integrations/psp/psp-request.ts';
import { GATEWAY_LAUNCH_CAPABILITIES } from '../../src/integrations/psp/capability-matrix.ts';
import { GatewayProviderResponseInvalid } from '../../src/integrations/psp/psp-errors.ts';
import type { ProviderDispatchResponse, ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import { PROVIDER_EVIDENCE_FACT_KINDS } from '../../shared/domain/psp-vocabulary.ts';
import {
  CONFORMANCE_CLOCK_MS,
  CONFORMANCE_FAMILIES,
  cancelExpected,
  collectExpected,
  refundExpected,
} from '../support/psp-conformance-families.fixture.ts';
import type { FamilyConformance } from '../support/psp-conformance-families.fixture.ts';
import {
  credentialConfig,
  dropAfterWrite,
  recordedGatewayAdapters,
} from '../support/psp-conformance-provider.fixture.ts';
import type { RouteScript } from '../support/psp-conformance-provider.fixture.ts';

/**
 * #1159 level 2 (contract / provider fixture): the Launch capability matrix run as one table across GOPAY,
 * STRIPE and COMGATE through the production `GatewayProviderAdapters` and `GatewayProviderAdapter` contract,
 * with the production `ProviderHttpLive` and `ProviderCredentialStoreLive` over a recorded HttpClient.
 * Answers are documented provider bodies (tests/fixtures). This proves adapter mapping, not provider
 * behaviour: provider sandbox evidence (level 4) is NOT RUN without credentials (plan N13).
 */

const outcomeOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.result(effect).pipe(
    Effect.map((result) =>
      Result.isSuccess(result)
        ? { ok: true as const, value: result.success }
        : { error: result.failure, ok: false as const },
    ),
  );

/** Runs one case with the family's credential document and the conformance clock. */
const caseOf = <A, E>(
  conformance: FamilyConformance,
  routes: RouteScript,
  body: (harness: Effect.Success<ReturnType<typeof recordedGatewayAdapters>>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* conformanceCase() {
    yield* TestClock.setTime(CONFORMANCE_CLOCK_MS);
    const harness = yield* recordedGatewayAdapters(routes);
    return yield* body(harness);
  }).pipe(Effect.provide(credentialConfig(conformance.credentials)));

const adapterOf = (
  conformance: FamilyConformance,
  harness: Effect.Success<ReturnType<typeof recordedGatewayAdapters>>,
) => harness.adapters.forFamily(conformance.family);

const lookupOf = (conformance: FamilyConformance, expected: GatewayExpectedEffect): GatewayLookupRequest => ({
  dispatchedAt: Option.some(DateTime.makeUnsafe(CONFORMANCE_CLOCK_MS)),
  expected,
  target: { _tag: 'PROVIDER_OBJECT', ref: conformance.paymentRef },
});

const factKindOf = (finding: ProviderFindingResult | undefined) =>
  Option.fromUndefinedOr(finding).pipe(
    Option.flatMap(({ evidence }) => evidence),
    Option.map(({ factKind }) => factKind),
  );

const dispatchKindOf = (response: ProviderDispatchResponse) =>
  Match.value(response).pipe(
    Match.tag('ACKNOWLEDGED', () => 'ACKNOWLEDGED' as const),
    Match.tag('REJECTED_BEFORE_EFFECT', () => 'REJECTED_BEFORE_EFFECT' as const),
    Match.exhaustive,
  );

const findingFor = (findings: readonly ProviderFindingResult[], operationId: string) =>
  findings.find((finding) => finding.target.operationId === operationId);

describe('#1159 L2 capability matrix contract', () => {
  it('#1159 L2 the matrix names exactly the three Launch gateway families and five capabilities', () => {
    expect(CONFORMANCE_FAMILIES.map(({ family }) => family)).toEqual(['GOPAY', 'STRIPE', 'COMGATE']);
    expect(new Set(Object.keys(GATEWAY_LAUNCH_CAPABILITIES))).toEqual(new Set(['COMGATE', 'GOPAY', 'STRIPE']));
    for (const row of Object.values(GATEWAY_LAUNCH_CAPABILITIES)) {
      expect(new Set(Object.keys(row))).toEqual(
        new Set(['CANCEL_OR_VOID', 'COLLECT', 'NOTIFICATION', 'REFUND', 'RETRIEVE']),
      );
    }
  });

  it('#1159 L2 manual capture, saved methods, subscriptions and settlement are unreachable from the adapter contract', () => {
    // The collect request carries only the exact one-shot facts; there is no capture mode, saved method,
    // customer, recurrence or off-session field a caller could set.
    expect(new Set(Object.keys(GatewayCollectRequestSchema.fields))).toEqual(
      new Set(['amount', 'correlation', 'issuedAt', 'operationId', 'payerContact', 'paymentId', 'returnToken']),
    );
    // Settlement and remittance are not mapped at Launch (plan N15): no adapter fact kind can express them.
    expect(PROVIDER_EVIDENCE_FACT_KINDS.filter((kind) => /SETTLEMENT|PAYOUT|BALANCE/u.test(kind))).toEqual([]);
  });
});

for (const conformance of CONFORMANCE_FAMILIES) {
  const { family } = conformance;

  describe(`#1159 L2 ${family} conformance through GatewayProviderAdapter`, () => {
    it.effect(`#1159 L2 ${family} adapter is selected by exact family and declares its Launch capabilities`, () =>
      caseOf(conformance, {}, (harness) =>
        Effect.gen(function* selected() {
          const adapter = yield* adapterOf(conformance, harness);
          expect(adapter.family).toBe(family);
          expect(adapter.capabilities).toEqual(GATEWAY_LAUNCH_CAPABILITIES[family]);
          expect(harness.sent).toEqual([]);
        }),
      ),
    );

    it.effect(`#1159 L2 ${family} create: one-shot direct collection, a provider ACK is never EFFECT_CONFIRMED`, () =>
      caseOf(conformance, conformance.scripts.create, (harness) =>
        Effect.gen(function* create() {
          const adapter = yield* adapterOf(conformance, harness);
          const prepared = yield* adapter.prepareCollect(conformance.target, conformance.collectRequest);
          // Preparation is pure: nothing is sent and the same input gives the same bytes.
          expect(harness.sent).toEqual([]);
          const again = yield* adapter.prepareCollect(conformance.target, conformance.collectRequest);
          expect(again.requestHash).toBe(prepared.requestHash);
          const bodyText = new TextDecoder().decode(prepared.body);
          for (const fragment of conformance.forbiddenCollectFragments) {
            expect(bodyText).not.toContain(fragment);
          }
          expect(bodyText).toContain(String(conformance.amount.amountMinor));

          const response = yield* adapter.send(conformance.target, prepared, collectExpected(conformance));
          expect(dispatchKindOf(response)).toBe('ACKNOWLEDGED');
          expect(response.finding.finding).toBe('CUSTOMER_ACTION_REQUIRED');
          expect(response.finding.finding).not.toBe('EFFECT_CONFIRMED');
          expect(factKindOf(response.finding)).not.toEqual(Option.some('COLLECTION_CONFIRMED'));
          expect(Option.isSome(response.finding.customerAction)).toBe(true);
          expect(harness.callsTo(conformance.createRoute)).toHaveLength(1);
          expect(harness.callsTo(conformance.createRoute)[0]?.body).toBe(bodyText);
        }),
      ),
    );

    it.effect(
      `#1159 L2 ${family} retrieve: an exact paid lookup is COLLECTION_CONFIRMED for the expected operation`,
      () =>
        caseOf(conformance, conformance.scripts.lookupPaid, (harness) =>
          Effect.gen(function* retrieve() {
            const adapter = yield* adapterOf(conformance, harness);
            const findings = yield* adapter.lookup(
              conformance.target,
              lookupOf(conformance, collectExpected(conformance)),
            );
            expect(findings.map(({ finding, target }) => [finding, target.operationId])).toEqual([
              ['EFFECT_CONFIRMED', findings[0]?.target.operationId],
            ]);
            const [confirmed] = findings;
            expect(confirmed?.target).toEqual({ operationId: confirmed?.target.operationId, operationKind: 'COLLECT' });
            expect(factKindOf(confirmed)).toEqual(Option.some('COLLECTION_CONFIRMED'));
            const evidence = Option.getOrThrow(
              Option.fromUndefinedOr(confirmed).pipe(Option.flatMap((f) => f.evidence)),
            );
            expect(evidence.discrepancy).toEqual(Option.none());
            expect(evidence.observedAmount).toEqual(Option.some(conformance.amount));
            expect(DateTime.toEpochMillis(evidence.observedAt)).toBe(CONFORMANCE_CLOCK_MS);
            // Reads never mutate.
            expect(harness.sent.every(({ route }) => !route.startsWith('DELETE'))).toBe(true);
          }),
        ),
    );

    it.effect(`#1159 L2 ${family} lookup miss is INDETERMINATE, never NOT_EFFECTED`, () =>
      caseOf(conformance, conformance.scripts.lookupMiss, (harness) =>
        Effect.gen(function* lookupMiss() {
          const adapter = yield* adapterOf(conformance, harness);
          const findings = yield* adapter.lookup(
            conformance.target,
            lookupOf(conformance, collectExpected(conformance)),
          );
          expect(findings.map(({ evidence, finding }) => [finding, Option.isNone(evidence)])).toEqual([
            ['INDETERMINATE', true],
          ]);
        }),
      ),
    );

    it.effect(`#1159 L2 ${family} amount mismatch is a discrepancy, never a confirmation or a recollection`, () =>
      caseOf(conformance, conformance.scripts.lookupMismatch, (harness) =>
        Effect.gen(function* amountMismatch() {
          const adapter = yield* adapterOf(conformance, harness);
          const findings = yield* adapter.lookup(
            conformance.target,
            lookupOf(conformance, collectExpected(conformance)),
          );
          expect(findings.map(({ finding }) => finding)).toEqual(['VERIFICATION_CONFLICT']);
          const evidence = Option.getOrThrow(
            Option.fromUndefinedOr(findings[0]).pipe(Option.flatMap((f) => f.evidence)),
          );
          expect(evidence.discrepancy.pipe(Option.map(({ expected }) => expected))).toEqual(
            Option.some(conformance.amount),
          );
          expect(Option.isSome(evidence.observedAmount)).toBe(true);
          expect(evidence.observedAmount).not.toEqual(Option.some(conformance.amount));
          // Only reads: nothing is resent and no new collection is issued for the missing funds.
          expect(harness.callsTo(conformance.createRoute)).toEqual([]);
        }),
      ),
    );

    it.effect(`#1159 L2 ${family} foreign merchant or environment answer never confirms and carries no evidence`, () =>
      caseOf(conformance, conformance.scripts.lookupForeignMerchant, (harness) =>
        Effect.gen(function* foreignMerchant() {
          const adapter = yield* adapterOf(conformance, harness);
          const result = yield* outcomeOf(
            adapter.lookup(conformance.target, lookupOf(conformance, collectExpected(conformance))),
          );
          if (result.ok) {
            expect(result.value.map(({ evidence, finding }) => [finding, Option.isNone(evidence)])).toEqual([
              ['VERIFICATION_CONFLICT', true],
            ]);
          } else {
            expect(Schema.is(GatewayProviderResponseInvalid)(result.error)).toBe(true);
          }
        }),
      ),
    );

    it.effect(`#1159 L2 ${family} a provider object of another family is never acted on`, () =>
      caseOf(conformance, {}, (harness) =>
        Effect.gen(function* foreignFamilyRef() {
          const adapter = yield* adapterOf(conformance, harness);
          const looked = yield* outcomeOf(
            adapter.lookup(conformance.target, {
              ...lookupOf(conformance, collectExpected(conformance)),
              target: { _tag: 'PROVIDER_OBJECT', ref: conformance.foreignFamilyRef },
            }),
          );
          const refunded = yield* outcomeOf(
            adapter.prepareRefund(conformance.target, {
              ...conformance.refundRequest('REFUNDABLE_ITEMS'),
              providerTarget: conformance.foreignFamilyRef,
            }),
          );
          expect(looked.ok).toBe(false);
          expect(refunded.ok).toBe(false);
          expect(harness.sent).toEqual([]);
        }),
      ),
    );

    it.effect(`#1159 L2 ${family} lost create response is OUTCOME_UNKNOWN and the mutation is never resent`, () =>
      caseOf(conformance, { ...conformance.scripts.lostCreate }, (harness) =>
        Effect.gen(function* lostCreate() {
          const adapter = yield* adapterOf(conformance, harness);
          const prepared = yield* adapter.prepareCollect(conformance.target, conformance.collectRequest);
          const lost = yield* outcomeOf(adapter.send(conformance.target, prepared, collectExpected(conformance)));
          expect(lost).toMatchObject({
            error: { _tag: 'GatewayProviderOutcomeUnknown', family, reason: 'provider_transport_failed' },
            ok: false,
          });
          expect(harness.callsTo(conformance.createRoute)).toHaveLength(1);
        }),
      ),
    );

    it.effect(
      `#1159 L2 ${family} a 5xx create is OUTCOME_UNKNOWN with exactly one attempt (no generic mutating retry)`,
      () =>
        caseOf(conformance, conformance.scripts.unavailableCreate, (harness) =>
          Effect.gen(function* unavailableCreate() {
            const adapter = yield* adapterOf(conformance, harness);
            const prepared = yield* adapter.prepareCollect(conformance.target, conformance.collectRequest);
            const result = yield* outcomeOf(adapter.send(conformance.target, prepared, collectExpected(conformance)));
            expect(result).toMatchObject({ error: { _tag: 'GatewayProviderOutcomeUnknown', family }, ok: false });
            expect(harness.callsTo(conformance.createRoute)).toHaveLength(1);
          }),
        ),
    );

    it.effect(`#1159 L2 ${family} refund: both refund bases send the exact amount and acceptance stays pending`, () =>
      caseOf(conformance, conformance.scripts.refundAccepted, (harness) =>
        Effect.gen(function* refund() {
          const adapter = yield* adapterOf(conformance, harness);
          const byItems = yield* adapter.prepareRefund(
            conformance.target,
            conformance.refundRequest('REFUNDABLE_ITEMS'),
          );
          const byCompensation = yield* adapter.prepareRefund(
            conformance.target,
            conformance.refundRequest('FAILED_COMMITMENT_COMPENSATION'),
          );
          // The basis is Payment-owned: it never alters the provider primitive, and no item list is required.
          expect(byCompensation.requestHash).toBe(byItems.requestHash);
          expect(byCompensation.body).toEqual(byItems.body);
          const bodyText = new TextDecoder().decode(byItems.body);
          expect(bodyText).toContain(String(conformance.refundAmount.amountMinor));
          expect(bodyText).not.toContain('item');

          const response = yield* adapter.send(conformance.target, byItems, refundExpected(conformance));
          expect(dispatchKindOf(response)).toBe('ACKNOWLEDGED');
          expect(response.finding.finding).toBe('ACCEPTED_PENDING');
          expect(factKindOf(response.finding)).toEqual(Option.some('REFUND_PENDING'));
          expect(harness.callsTo(conformance.refundRoute)).toHaveLength(1);
        }),
      ),
    );

    it.effect(`#1159 L2 ${family} lost refund response is OUTCOME_UNKNOWN and the refund is never resent`, () =>
      caseOf(
        conformance,
        { ...conformance.scripts.refundAccepted, [conformance.refundRoute]: [dropAfterWrite] },
        (harness) =>
          Effect.gen(function* lostRefund() {
            const adapter = yield* adapterOf(conformance, harness);
            const prepared = yield* adapter.prepareRefund(
              conformance.target,
              conformance.refundRequest('REFUNDABLE_ITEMS'),
            );
            const lost = yield* outcomeOf(adapter.send(conformance.target, prepared, refundExpected(conformance)));
            expect(lost).toMatchObject({ error: { _tag: 'GatewayProviderOutcomeUnknown', family }, ok: false });
            expect(harness.callsTo(conformance.refundRoute)).toHaveLength(1);
          }),
      ),
    );

    it.effect(
      `#1159 L2 ${family} cancel: supported cancel is confirmed only by the provider, unsupported is typed`,
      () =>
        caseOf(
          conformance,
          Option.getOrElse(conformance.scripts.cancel, () => ({})),
          (harness) =>
            Effect.gen(function* cancel() {
              const adapter = yield* adapterOf(conformance, harness);
              const prepared = yield* outcomeOf(adapter.prepareCancel(conformance.target, conformance.cancelRequest));
              if (GATEWAY_LAUNCH_CAPABILITIES[family].CANCEL_OR_VOID === 'UNSUPPORTED') {
                // A family without a cancel path is typed Unsupported, never a fallback to a refund or another provider.
                expect(prepared).toMatchObject({
                  error: { _tag: 'GatewayProviderUnsupported', capability: 'CANCEL_OR_VOID', family },
                  ok: false,
                });
                expect(harness.sent).toEqual([]);
                return;
              }
              expect(prepared.ok).toBe(true);
              if (!prepared.ok) {
                return;
              }
              const response = yield* adapter.send(conformance.target, prepared.value, cancelExpected(conformance));
              expect(dispatchKindOf(response)).toBe('ACKNOWLEDGED');
              expect(response.finding.target.operationKind).toBe('CANCEL_OR_VOID');
              expect(factKindOf(response.finding)).toEqual(Option.some('CANCEL_CONFIRMED'));
              // A cancel reports only on itself and its collection target, never on another operation.
              expect(findingFor([response.finding], conformance.cancelRequest.operationId)?.target.operationId).toBe(
                conformance.cancelRequest.operationId,
              );
              // Exactly the family's one cancel path, each route once (Comgate and GoPay: one DELETE, then the
              // confirming lookup; the per-family adapter suites pin the order).
              expect(new Set(harness.sent.map(({ route }) => route))).toEqual(
                new Set(Object.keys(Option.getOrElse(conformance.scripts.cancel, () => ({})))),
              );
              expect(harness.sent).toHaveLength(
                Object.keys(Option.getOrElse(conformance.scripts.cancel, () => ({}))).length,
              );
            }),
        ),
    );

    it.effect(
      `#1159 L2 ${family} notification: authentic delivery is a trigger; forged, foreign and wrong-environment deliveries are rejected`,
      () =>
        caseOf(conformance, {}, (harness) =>
          Effect.gen(function* notification() {
            const adapter = yield* adapterOf(conformance, harness);
            const { notifications } = conformance;
            yield* TestClock.setTime(notifications.verifiedAtMs);
            const trigger = yield* adapter.verifyNotification(conformance.target, notifications.valid);
            expect(trigger).toMatchObject({
              actionable: true,
              authenticity: notifications.expectedAuthenticity,
              family,
            });
            // receivedAt (relay) and verifiedAt (Effect clock) are distinct instants; the provider event time is separate.
            expect(DateTime.toEpochMillis(trigger.verifiedAt)).toBe(notifications.verifiedAtMs);
            expect(DateTime.toEpochMillis(trigger.verifiedAt)).not.toBe(
              DateTime.toEpochMillis(notifications.valid.receivedAt),
            );
            // A trigger is never itself a financial fact: no evidence is carried, only provider refs to look up.
            expect(trigger.providerRefs.length).toBeGreaterThan(0);

            for (const [raw, reason] of [
              [notifications.invalid, notifications.invalidReason],
              [notifications.foreignMerchant, notifications.foreignMerchantReason],
              [notifications.wrongEnvironment, 'ENVIRONMENT_MISMATCH'],
            ] as const) {
              const rejected = yield* outcomeOf(adapter.verifyNotification(conformance.target, raw));
              expect(rejected).toMatchObject({
                error: { _tag: 'GatewayNotificationRejected', family, reason },
                ok: false,
              });
            }
            // Verification never calls the provider.
            expect(harness.sent).toEqual([]);
          }),
        ),
    );

    it.effect(`#1159 L2 ${family} settlement and balance deliveries create no Payment operation`, () =>
      caseOf(conformance, {}, (harness) =>
        Effect.gen(function* settlement() {
          const adapter = yield* adapterOf(conformance, harness);
          yield* TestClock.setTime(conformance.notifications.verifiedAtMs);
          for (const raw of conformance.notifications.settlement) {
            const trigger = yield* adapter.verifyNotification(conformance.target, raw);
            expect(trigger.actionable).toBe(false);
            expect(trigger.providerRefs).toEqual([]);
            expect(trigger.providerOccurrenceId).toEqual(Option.none());
          }
          // A family without settlement deliveries maps none (plan N15); the vocabulary has no settlement fact.
          expect(harness.sent).toEqual([]);
        }),
      ),
    );
  });
}
