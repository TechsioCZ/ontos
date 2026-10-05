import { CurrentRelevantStockPositionSetResponseSchema } from '@app/inventory/api/current-relevant-stock-position-set';
import { Effect, Match, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { AvailabilityEvaluationInput } from '../../shared/domain/availability-decision.ts';
import {
  AvailabilityInventoryPositionEvidenceSchema,
  AvailabilityStockInputSchema,
} from '../../shared/domain/availability-source-authority.ts';
import { AvailabilitySubjectSchema } from '../../shared/domain/availability-subject.ts';
import { validateAvailabilitySourceAuthority } from '../../src/domain/availability-source-authority.ts';
import { availabilityEvaluationService } from '../../src/services/availability-evaluation.service.ts';
import { availabilityPromisePolicyService } from '../../src/services/availability-promise-policy.service.ts';
import { makeCurrentnessInput, makeRichExternalCurrentnessInput } from '../support/availability-currentness.ts';

const evaluate = (input: AvailabilityEvaluationInput) =>
  Effect.gen(function* evaluateWithLaunchPolicy() {
    const policy = yield* availabilityPromisePolicyService.resolveCurrent(input);
    return yield* availabilityEvaluationService({ ...input, policy });
  });
const uncertainOnHand = (tag: 'STALE' | 'MISSING' | 'UNKNOWN' | 'INDETERMINATE') => {
  const input = makeCurrentnessInput(['10'], '2');
  const positions = input.stockInput.positions.map((entry) => {
    const common = { meaning: 'ON_HAND', ownerConfigurationRef: entry.position.onHand.ownerConfigurationRef };
    const onHand = Schema.decodeUnknownSync(AvailabilityInventoryPositionEvidenceSchema.fields.position.fields.onHand)(
      tag === 'STALE'
        ? {
            ...common,
            _tag: tag,
            evidenceRef: 'last-known-ten',
            lastKnownQuantity: { amount: '10', unitRef: input.subject.quantity.unitRef },
            lastObservedAt: input.useBoundary.requiredAt,
          }
        : { ...common, _tag: tag, unitRef: input.subject.quantity.unitRef },
    );
    return {
      ...entry,
      position: { ...entry.position, onHand },
      sourceEvidence: { ...entry.sourceEvidence, _tag: 'OWNER_MANAGED' as const, onHand },
    };
  });
  const stockInput = { ...input.stockInput, positions };
  return { ...input, ownerQualification: { ...input.ownerQualification, stockInput }, stockInput };
};

describe('Availability owner acceptance: exact subject, authority and truthful quantity', () => {
  it('scenario 1: Product-only and SKU-only inputs cannot form an authoritative subject', () => {
    const input = makeCurrentnessInput(['3'], '2');
    for (const candidate of [
      { productRef: input.subject.selection.productRef },
      { quantity: '2', sku: 'SKU-1' },
      { quantity: input.subject.quantity, selection: input.subject.selection },
    ]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(AvailabilitySubjectSchema)(candidate))).toBe(true);
    }
  });
  it.effect('scenario 2: the same exact Selection supports 2 but truthfully refuses 5', () =>
    Effect.gen(function* compareExactRequests() {
      const two = yield* evaluate(makeCurrentnessInput(['3'], '2'));
      const five = yield* evaluate(makeCurrentnessInput(['3'], '5'));
      expect(two.outcome).toBe('AVAILABLE');
      expect(five.outcome).toBe('UNAVAILABLE');
      expect(two.subject.selection).toEqual(five.subject.selection);
      expect(two.subject.quantity.amount).toBe('2');
      expect(five.subject.quantity.amount).toBe('5');
      expect(two.subject.purchasingContext).toEqual(five.subject.purchasingContext);
    }),
  );
  it.effect(
    'scenario 3: independent Catalog readiness or Assortment eligibility cannot fill missing Availability proof',
    () =>
      Effect.gen(function* requireOwnAuthority() {
        const input = makeCurrentnessInput(['100'], '2');
        // Consumer labels are deliberately not owner-issued Assortment evidence or an Availability input.
        const consumerLabels = { assortment: 'ELIGIBLE', catalog: 'READY' };
        const result = yield* evaluate({
          ...input,
          ownerQualification: { ...input.ownerQualification, set: { _tag: 'UNPROVEN' } },
        });
        expect(consumerLabels).toEqual({ assortment: 'ELIGIBLE', catalog: 'READY' });
        expect(result.outcome).toBe('INDETERMINATE');
        expect(result.reasons).toContain('SET_COMPLETENESS_UNPROVEN');
      }),
  );
  it.effect('scenario 4: authoritative Current zero remains distinct from unknown stock', () =>
    Effect.gen(function* preserveZero() {
      const result = yield* evaluate(makeCurrentnessInput(['0'], '2'));
      expect(result.outcome).toBe('UNAVAILABLE');
      expect(result.reasons).toContain('CURRENT_ZERO');
      expect(result.evidence.stockInput.positions[0]?.position.onHand).toEqual(
        makeCurrentnessInput(['0'], '2').stockInput.positions[0]?.position.onHand,
      );
      expect(result.reasons).not.toContain('MISSING');
      expect(result.reasons).not.toContain('UNKNOWN');
    }),
  );
  it.effect('scenario 5: STALE last-known ten becomes neither Current ten nor Current zero', () =>
    Effect.gen(function* preserveStale() {
      const input = uncertainOnHand('STALE');
      const result = yield* evaluate(input);
      expect(result.outcome).toBe('INDETERMINATE');
      expect(result.reasons).toContain('STALE');
      expect(result.reasons).not.toContain('CURRENT_ZERO');
      expect(result.evidence.stockInput).toEqual(input.stockInput);
    }),
  );
  it.effect('scenario 6: MISSING and UNKNOWN stay uncertain rather than authoritative negatives', () =>
    Effect.gen(function* preserveMissing() {
      for (const tag of ['MISSING', 'UNKNOWN'] as const) {
        const input = uncertainOnHand(tag);
        const result = yield* evaluate(input);
        expect(result.outcome).toBe('INDETERMINATE');
        expect(result.reasons).toContain(tag);
        expect(result.evidence.stockInput).toEqual(input.stockInput);
      }
    }),
  );
  it.effect('scenario 7: conflicting owner facts never select an arbitrary winner', () =>
    Effect.gen(function* preserveConflict() {
      const input = uncertainOnHand('INDETERMINATE');
      const result = yield* evaluate({
        ...input,
        ownerQualification: {
          ...input.ownerQualification,
          positions: input.ownerQualification.positions.map((entry) => ({
            ...entry,
            uncertaintyReasons: ['CONFLICT'],
          })),
        },
      });
      expect(result.outcome).toBe('INDETERMINATE');
      expect(result.reasons).toContain('CONFLICT');
      expect(result.reasons).toContain('INDETERMINATE');
    }),
  );
  it.effect(
    'scenario 8: unresolved Reservation effects forbid deriving reusable stock from ON_HAND minus RESERVED',
    () =>
      Effect.gen(function* preserveEffects() {
        const input = makeRichExternalCurrentnessInput();
        const result = yield* evaluate({
          ...input,
          ownerQualification: {
            ...input.ownerQualification,
            positions: input.ownerQualification.positions.map((entry) => ({
              ...entry,
              constraintSupport: 'INDETERMINATE',
              reusableQuantity: { _tag: 'UNPROVEN' },
            })),
          },
        });
        expect(result.outcome).toBe('INDETERMINATE');
        expect(result.reasons).toContain('UNRESOLVED_RESERVATION_EFFECT');
        expect(result.reasons).toContain('SOURCE_COVERAGE_UNCERTAIN');
        expect(result.reasons).toContain('REUSABLE_QUANTITY_UNPROVEN');
        expect(result.evidence.stockInput).toEqual(input.stockInput);
        expect(result.evidence.stockInput.positions[0]?.unresolvedReservationEffectConstraints).toHaveLength(1);
        expect(result.evidence.stockInput.positions[0]?.committedObligations).toHaveLength(1);
      }),
  );
  it.effect('scenario 9: two usable Positions cover the request without Allocation or Reservation', () =>
    Effect.gen(function* coverWithoutWrite() {
      const result = yield* evaluate(makeCurrentnessInput(['6', '4'], '10'));
      expect(result.outcome).toBe('AVAILABLE');
      expect(result).not.toHaveProperty('allocations');
      expect(result).not.toHaveProperty('reservation');
      expect(result).not.toHaveProperty('reservationConfirmation');
      expect(result).not.toHaveProperty('commitmentProtection');
      expect(result.evidence.stockInput.positions.map((entry) => entry.provisionalReserved)).toEqual(
        makeCurrentnessInput(['6', '4'], '10').stockInput.positions.map((entry) => entry.provisionalReserved),
      );
    }),
  );
  it.effect('scenario 9: duplicated Position identities cannot double-count apparent support', () =>
    Effect.gen(function* rejectDoubleCounting() {
      const input = makeCurrentnessInput(['6'], '10');
      const stockInput = {
        ...input.stockInput,
        positions: [...input.stockInput.positions, ...input.stockInput.positions],
      };
      const result = yield* evaluate({
        ...input,
        ownerQualification: {
          ...input.ownerQualification,
          positions: [...input.ownerQualification.positions, ...input.ownerQualification.positions],
          stockInput,
        },
        stockInput,
      });
      expect(result.outcome).toBe('INDETERMINATE');
      expect(result.reasons).toContain('DUPLICATE_POSITION');
    }),
  );
  it.effect('scenario 10: known rows or an empty result never prove relevant-set completeness', () =>
    Effect.gen(function* rejectQueryCompleteness() {
      for (const amounts of [['3'], []]) {
        const input = makeCurrentnessInput(amounts, '5');
        const result = yield* evaluate({
          ...input,
          ownerQualification: { ...input.ownerQualification, set: { _tag: 'UNPROVEN' } },
        });
        expect(result.outcome).toBe('INDETERMINATE');
        expect(result.reasons).toContain('SET_COMPLETENESS_UNPROVEN');
      }
    }),
  );
  it.effect('scenario 11: safe quantity three refuses exact five without an automatic partial offer', () =>
    Effect.gen(function* refusePartial() {
      const input = makeCurrentnessInput(['3'], '5');
      const result = yield* evaluate(input);
      expect(result.outcome).toBe('UNAVAILABLE');
      expect(result.subject).toEqual(input.subject);
      expect(result.reasons).toContain('INSUFFICIENT_REUSABLE_QUANTITY');
      for (const property of ['partialQuantity', 'backorder', 'preorder', 'supplierPromise']) {
        expect(result).not.toHaveProperty(property);
      }
    }),
  );
  it.effect('scenario 12: a missing selected ERP assertion does not permit an alternate backend', () =>
    Effect.gen(function* refuseFallback() {
      const input = makeRichExternalCurrentnessInput();
      const stockInput = Schema.decodeUnknownSync(AvailabilityStockInputSchema)({
        ...input.stockInput,
        positions: input.stockInput.positions.map((entry) => ({
          ...entry,
          sourceEvidence: {
            _tag: 'MISSING',
            meaning: 'EXTERNAL_SOURCE_ASSERTION',
            onHand: entry.position.onHand,
            ownerConfiguration: input.stockInput.selectedBackendConfiguration,
            physicalOnHandReusableProof: 'NOT_PROVIDED',
          },
        })),
      });
      const result = yield* evaluate({
        ...input,
        ownerQualification: {
          ...input.ownerQualification,
          positions: input.ownerQualification.positions.map((entry) => ({ ...entry, constraintSupport: 'RESOLVED' })),
          stockInput,
        },
        stockInput,
      });
      expect(result.outcome).toBe('INDETERMINATE');
      expect(result.reasons).toContain('SOURCE_UNAVAILABLE');
      const alternate = {
        ...stockInput,
        selectedBackendConfiguration: {
          ...stockInput.selectedBackendConfiguration,
          selection: { ...stockInput.selectedBackendConfiguration.selection, backendId: 'alternate-erp' },
        },
      };
      const rejected = yield* validateAvailabilitySourceAuthority(
        Schema.decodeUnknownSync(Schema.toType(AvailabilityStockInputSchema))(alternate),
        {
          configuration: stockInput.selectedBackendConfiguration,
          subject: input.subject,
        },
      ).pipe(Effect.flip);
      expect(rejected.reason).toBe('SELECTED_AUTHORITY_MISMATCH');
      expect(result.evidence.stockInput.selectedBackendConfiguration.selection.backendId).toBe('erp');
      expect(result.evidence.stockInput.fallbackApplied).toBe(false);
    }),
  );
  it('scenario 12: direct EBS and raw provider transport are excluded from the authority contract', () => {
    const input = makeRichExternalCurrentnessInput();
    for (const candidate of [
      { ...input.stockInput, authorityPath: 'DIRECT_EBS' },
      { ...input.stockInput, fallbackApplied: true },
      { ...input.stockInput, rawProviderPayload: { available: true } },
      { body: { quantity: 100 }, status: 200 },
    ]) {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(AvailabilityStockInputSchema, { onExcessProperty: 'error' })(candidate),
        ),
      ).toBe(true);
    }
  });
  it.effect('scenario 23: public Inventory completeness envelope permits the qualified multi-Position decision', () =>
    Effect.gen(function* consumePublishedOwnerContract() {
      const input = makeCurrentnessInput(['6', '4'], '10');
      const completeness = Match.value(input.ownerQualification.set).pipe(
        Match.tag('COMPLETE', (set) => set.evidence),
        Match.tag('UNPROVEN', () => {}),
        Match.exhaustive,
      );
      const ownerResponse = Schema.decodeUnknownSync(Schema.toType(CurrentRelevantStockPositionSetResponseSchema))({
        completeness,
        outcome: 'COMPLETE',
        positionRefs: input.stockInput.positions.map((entry) => entry.position.ref),
        previousProof: 'NOT_REQUESTED',
        sharingEligibility: 'OWNER_VERIFIED',
        verificationRule: 'OWNER_REVALIDATION_REQUIRED_AT_EACH_USE',
      });
      const producer = Schema.decodeUnknownSync(CurrentRelevantStockPositionSetResponseSchema)(
        Schema.encodeSync(CurrentRelevantStockPositionSetResponseSchema)(ownerResponse),
      );
      expect(producer.outcome).toBe('COMPLETE');
      yield* Match.value(producer).pipe(
        Match.when({ outcome: 'COMPLETE' }, (complete) =>
          Effect.gen(function* verifyComplete() {
            const result = yield* evaluate({
              ...input,
              ownerQualification: {
                ...input.ownerQualification,
                set: {
                  _tag: 'COMPLETE',
                  evidence: complete.completeness,
                  predicateRef: complete.completeness.scope.predicateRef,
                },
              },
            });
            expect(result.outcome).toBe('AVAILABLE');
            expect(complete.positionRefs).toEqual(
              result.evidence.stockInput.positions.map((entry) => entry.position.ref),
            );
          }),
        ),
        Match.when({ outcome: 'UNPROVEN' }, () =>
          Effect.sync(() => expect.fail('Controlled owner set must be complete')),
        ),
        Match.exhaustive,
      );
    }),
  );
  it.effect('scenario 24: a missing or non-current completeness qualification forbids negative authority', () =>
    Effect.gen(function* requireCurrentSetProof() {
      const input = makeCurrentnessInput(['3'], '5');
      for (const ownerQualification of [
        { ...input.ownerQualification, set: { _tag: 'UNPROVEN' as const } },
        { ...input.ownerQualification, currentness: 'STALE' as const },
      ]) {
        const result = yield* evaluate({ ...input, ownerQualification });
        expect(result.outcome).toBe('INDETERMINATE');
      }
    }),
  );
  it.effect('independent reusable evidence proves only a positive lower bound, preserving uncertainty', () =>
    Effect.gen(function* compareIndependentBound() {
      const input = makeRichExternalCurrentnessInput();
      const supported = yield* evaluate(input);
      const subject = { ...input.subject, quantity: { ...input.subject.quantity, amount: '5' } };
      const uncertain = yield* evaluate({
        ...input,
        ownerQualification: { ...input.ownerQualification, subject },
        subject,
      });
      expect(supported.outcome).toBe('AVAILABLE');
      expect(uncertain.outcome).toBe('INDETERMINATE');
      expect(uncertain.reasons).toContain('INDEPENDENT_SUPPORT_INSUFFICIENT');
      expect(supported.reasons).toContain('SOURCE_COVERAGE_UNCERTAIN');
      expect(supported.reasons).toContain('UNRESOLVED_RESERVATION_EFFECT');
      expect(supported.evidence.stockInput).toEqual(input.stockInput);
    }),
  );
  it.effect('exact decimals have no rounding, safety buffer or Unit substitution', () =>
    Effect.gen(function* preserveDecimalRequest() {
      const input = makeCurrentnessInput(['0.1', '0.2'], '0.300');
      const result = yield* evaluate(input);
      expect(result.outcome).toBe('AVAILABLE');
      expect(result.subject.quantity).toEqual(input.subject.quantity);
      const unitRef = { ...input.subject.quantity.unitRef, resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
      const mismatched = yield* evaluate({
        ...input,
        ownerQualification: {
          ...input.ownerQualification,
          positions: input.ownerQualification.positions.map((entry) => ({
            ...entry,
            reusableQuantity: { _tag: 'PROVEN', quantity: { amount: '10', unitRef } },
          })),
        },
      });
      expect(mismatched.outcome).toBe('INDETERMINATE');
      expect(mismatched.reasons).toContain('POSITION_SCOPE_MISMATCH');
    }),
  );
});
