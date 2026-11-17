import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  AvailabilityInventoryPositionEvidenceSchema,
  AvailabilityStockInputSchema,
} from '../../shared/domain/availability-source-authority.ts';
import { AvailabilitySubjectSchema } from '../../shared/domain/availability-subject.ts';
import { AvailabilityOwnerQualificationSchema } from '../../shared/domain/availability-decision.ts';
import type { AvailabilityEvaluationInput } from '../../shared/domain/availability-decision.ts';
import { availabilityEvaluationService } from '../../src/services/availability-evaluation.service.ts';
import { boundary, complete, makeCurrentnessInput } from '../support/availability-currentness.ts';
import { configuration, subject } from '../support/availability-decision.ts';

const check = (input: AvailabilityEvaluationInput, outcome: string, reason?: string) =>
  Effect.gen(function* verifyDecision() {
    const result = yield* availabilityEvaluationService(input);
    expect(result.outcome).toBe(outcome);
    expect(result.subject).toEqual(input.subject);
    expect(result.evidence.stockInput).toEqual(input.stockInput);
    expect(result).not.toHaveProperty('allocations');
    expect(result).not.toHaveProperty('reservation');
    if (reason !== undefined) {
      expect(result.reasons).toContain(reason);
    }
  });

describe('exact owner-qualified Availability decision', () => {
  it('requires separate owner-qualified backend authority in the contract', () => {
    const qualification = makeCurrentnessInput(['3'], '2').ownerQualification;
    const decode = Schema.decodeUnknownSync(Schema.toType(AvailabilityOwnerQualificationSchema));
    expect(decode(qualification)).toEqual(qualification);
    const unproven = { ...qualification, selectedBackendAuthority: { _tag: 'UNPROVEN' } };
    expect(decode(unproven)).toEqual(unproven);
    const missing = Object.fromEntries(
      Object.entries(qualification).filter(([key]) => key !== 'selectedBackendAuthority'),
    );
    expect(() => decode(missing)).toThrow();
    expect(() =>
      decode({ ...qualification, selectedBackendAuthority: { _tag: 'PROVEN', configuration: {} } }),
    ).toThrow();
  });

  it.effect('covers 6 + 4 without allocating and respects quantity 2 versus 5', () =>
    Effect.gen(function* checkCoverage() {
      yield* check(makeCurrentnessInput(['6', '4']), 'AVAILABLE');
      yield* check(makeCurrentnessInput(['3'], '2'), 'AVAILABLE');
      yield* check(makeCurrentnessInput(['3'], '5'), 'UNAVAILABLE', 'INSUFFICIENT_REUSABLE_QUANTITY');
      yield* check(makeCurrentnessInput(['0']), 'UNAVAILABLE', 'CURRENT_ZERO');
      yield* check(makeCurrentnessInput([]), 'UNAVAILABLE', 'COMPLETE_EMPTY_SET');
      yield* check(makeCurrentnessInput(['0.1', '0.2'], '0.3'), 'AVAILABLE');
    }),
  );
  it.effect('rejects a coherent alternate backend against independently selected authority', () => {
    const input = makeCurrentnessInput(['3'], '2');
    const alternate = { ...configuration, configurationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
    const positions = input.stockInput.positions.map((entry) => {
      const onHand = {
        ...entry.position.onHand,
        ownerConfigurationRef: {
          ...entry.position.onHand.ownerConfigurationRef,
          resourceId: alternate.configurationId,
        },
      };
      return {
        ...entry,
        position: { ...entry.position, onHand },
        sourceEvidence: { ...entry.sourceEvidence, onHand, ownerConfiguration: alternate },
      };
    });
    const stock = Schema.decodeUnknownSync(Schema.toType(AvailabilityStockInputSchema))({
      ...input.stockInput,
      positions,
      selectedBackendConfiguration: alternate,
    });
    return check(
      {
        ...input,
        ownerQualification: { ...input.ownerQualification, stockInput: stock },
        stockInput: stock,
      },
      'INDETERMINATE',
      'SELECTED_AUTHORITY_MISMATCH',
    );
  });

  it.effect('does not label constrained reusable zero or unusable Positions as physical Current zero', () =>
    Effect.gen(function* constrainedZero() {
      const input = makeCurrentnessInput(['10'], '2');
      const constrained = {
        ...input,
        ownerQualification: {
          ...input.ownerQualification,
          positions: input.ownerQualification.positions.map((entry) => ({
            ...entry,
            reusableQuantity: { _tag: 'PROVEN' as const, quantity: { amount: '0', unitRef: subject.quantity.unitRef } },
          })),
        },
      };
      const result = yield* availabilityEvaluationService(constrained);
      expect(result.outcome).toBe('UNAVAILABLE');
      expect(result.reasons).toContain('INSUFFICIENT_REUSABLE_QUANTITY');
      expect(result.reasons).not.toContain('CURRENT_ZERO');
      const unusable = yield* availabilityEvaluationService({
        ...input,
        ownerQualification: {
          ...input.ownerQualification,
          positions: input.ownerQualification.positions.map((entry) => ({ ...entry, usability: 'UNUSABLE' as const })),
        },
      });
      expect(unusable.outcome).toBe('UNAVAILABLE');
      expect(unusable.reasons).not.toContain('CURRENT_ZERO');
    }),
  );

  it.effect('distinguishes unproven selected authority from actual Position scope mismatch', () =>
    Effect.gen(function* authorityReasons() {
      const input = makeCurrentnessInput(['3'], '2');
      yield* check(
        {
          ...input,
          ownerQualification: { ...input.ownerQualification, selectedBackendAuthority: { _tag: 'UNPROVEN' } },
        },
        'INDETERMINATE',
        'SELECTED_AUTHORITY_UNPROVEN',
      );
      const positions = input.stockInput.positions.map((entry) => ({
        ...entry,
        binding: {
          ...entry.binding,
          catalogSelection: {
            ...entry.binding.catalogSelection,
            variantRef: { ...subject.selection.variantRef, resourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
          },
        },
      }));
      const stock = Schema.decodeUnknownSync(Schema.toType(AvailabilityStockInputSchema))({
        ...input.stockInput,
        positions,
      });
      yield* check(
        { ...input, ownerQualification: { ...input.ownerQualification, stockInput: stock }, stockInput: stock },
        'INDETERMINATE',
        'POSITION_SCOPE_MISMATCH',
      );
    }),
  );

  it.effect('incomplete sets cannot establish positive or negative', () =>
    Effect.gen(function* checkIncomplete() {
      for (const amounts of [['100'], ['0'], []]) {
        const input = makeCurrentnessInput(amounts);
        yield* check(
          { ...input, ownerQualification: { ...input.ownerQualification, set: { _tag: 'UNPROVEN' } } },
          'INDETERMINATE',
          'SET_COMPLETENESS_UNPROVEN',
        );
      }
    }),
  );
  it.effect('never derives reusable quantity from ON_HAND minus RESERVED', () => {
    const input = makeCurrentnessInput(['100']);
    return check(
      {
        ...input,
        ownerQualification: {
          ...input.ownerQualification,
          positions: input.ownerQualification.positions.map((entry) => ({
            ...entry,
            reusableQuantity: { _tag: 'UNPROVEN' },
          })),
        },
      },
      'INDETERMINATE',
      'REUSABLE_QUANTITY_UNPROVEN',
    );
  });
  it.effect('preserves stale, uncertain currentness and unresolved constraint reasons', () =>
    Effect.gen(function* checkUncertainty() {
      const input = makeCurrentnessInput(['100']);
      for (const currentness of ['STALE', 'INDETERMINATE'] as const) {
        yield* check(
          { ...input, ownerQualification: { ...input.ownerQualification, currentness } },
          'INDETERMINATE',
          currentness,
        );
      }
      yield* check(
        {
          ...input,
          ownerQualification: {
            ...input.ownerQualification,
            positions: input.ownerQualification.positions.map((entry) => ({
              ...entry,
              constraintSupport: 'INDETERMINATE',
            })),
          },
        },
        'INDETERMINATE',
        'UNRESOLVED_RESERVATION_EFFECT',
      );
      yield* check(
        {
          ...input,
          ownerQualification: {
            ...input.ownerQualification,
            positions: input.ownerQualification.positions.map((entry) => ({ ...entry, usability: 'INDETERMINATE' })),
          },
        },
        'INDETERMINATE',
        'POSITION_USABILITY_UNCERTAIN',
      );
    }),
  );
  it.effect('binds proof to exact subject, boundary, source snapshot and predicate', () =>
    Effect.gen(function* checkProofBinding() {
      const input = makeCurrentnessInput(['100']);
      yield* check(
        {
          ...input,
          ownerQualification: {
            ...input.ownerQualification,
            subject: { ...input.subject, quantity: { ...input.subject.quantity, amount: '2' } },
          },
        },
        'INDETERMINATE',
        'OWNER_QUALIFICATION_MISMATCH',
      );
      yield* check(
        {
          ...input,
          ownerQualification: { ...input.ownerQualification, set: { ...complete, predicateRef: 'different' } },
        },
        'INDETERMINATE',
        'SET_SCOPE_MISMATCH',
      );
      yield* check(
        {
          ...input,
          ownerQualification: { ...input.ownerQualification, useBoundary: { ...boundary, kind: 'ORDER_COMMITMENT' } },
        },
        'INDETERMINATE',
        'OWNER_QUALIFICATION_MISMATCH',
      );
    }),
  );
  it.effect('rejects duplicate counting even if quantities seem sufficient', () => {
    const input = makeCurrentnessInput(['6']);
    const doubled = { ...input.stockInput, positions: [...input.stockInput.positions, ...input.stockInput.positions] };
    return check(
      {
        ...input,
        ownerQualification: {
          ...input.ownerQualification,
          positions: [...input.ownerQualification.positions, ...input.ownerQualification.positions],
          stockInput: doubled,
        },
        stockInput: doubled,
      },
      'INDETERMINATE',
      'DUPLICATE_POSITION',
    );
  });
  it.effect('owner uncertainty reasons remain distinct and independent proven support is usable', () =>
    Effect.gen(function* checkOwnerUncertainty() {
      const input = makeCurrentnessInput(['10']);
      for (const reason of ['CONFLICT', 'SOURCE_COVERAGE_UNCERTAIN', 'UNRESOLVED_RESERVATION_EFFECT'] as const) {
        const positions = input.ownerQualification.positions.map((entry) => ({
          ...entry,
          uncertaintyReasons: [reason],
        }));
        yield* check(
          { ...input, ownerQualification: { ...input.ownerQualification, positions } },
          'INDETERMINATE',
          reason,
        );
        yield* check(
          {
            ...input,
            ownerQualification: {
              ...input.ownerQualification,
              positions: positions.map((entry) => ({ ...entry, constraintSupport: 'INDEPENDENTLY_PROVEN' })),
            },
          },
          'AVAILABLE',
        );
      }
      yield* check(makeCurrentnessInput(['6'], '10'), 'UNAVAILABLE');
    }),
  );
  it.effect('UNKNOWN, MISSING, STALE and INDETERMINATE never become zero', () =>
    Effect.gen(function* checkEvidenceStates() {
      for (const tag of ['UNKNOWN', 'MISSING', 'INDETERMINATE', 'STALE'] as const) {
        const input = makeCurrentnessInput(['10']);
        const positions = input.stockInput.positions.map((entry) => {
          const onHand = Schema.decodeUnknownSync(
            AvailabilityInventoryPositionEvidenceSchema.fields.position.fields.onHand,
          )(
            tag === 'STALE'
              ? {
                  _tag: tag,
                  evidenceRef: 'old',
                  lastKnownQuantity: { amount: '10', unitRef: subject.quantity.unitRef },
                  lastObservedAt: '2026-10-05T12:00:00.000Z',
                  meaning: 'ON_HAND',
                  ownerConfigurationRef: entry.position.onHand.ownerConfigurationRef,
                }
              : {
                  _tag: tag,
                  meaning: 'ON_HAND',
                  ownerConfigurationRef: entry.position.onHand.ownerConfigurationRef,
                  unitRef: subject.quantity.unitRef,
                },
          );
          return {
            ...entry,
            position: { ...entry.position, onHand },
            sourceEvidence: { ...entry.sourceEvidence, _tag: 'OWNER_MANAGED' as const, onHand },
          };
        });
        const stock = Schema.decodeUnknownSync(Schema.toType(AvailabilityStockInputSchema))({
          ...input.stockInput,
          positions,
        });
        yield* check(
          { ...input, ownerQualification: { ...input.ownerQualification, stockInput: stock }, stockInput: stock },
          'INDETERMINATE',
          tag,
        );
        const independent = {
          ...input,
          ownerQualification: {
            ...input.ownerQualification,
            positions: input.ownerQualification.positions.map((entry) => ({
              ...entry,
              constraintSupport: 'INDEPENDENTLY_PROVEN' as const,
            })),
            stockInput: stock,
          },
          stockInput: stock,
        };
        yield* check(independent, 'AVAILABLE', tag);
        const largerSubject = { ...input.subject, quantity: { ...input.subject.quantity, amount: '11' } };
        yield* check(
          {
            ...independent,
            ownerQualification: { ...independent.ownerQualification, subject: largerSubject },
            policy: { ...independent.policy, subject: largerSubject },
            subject: largerSubject,
          },
          'INDETERMINATE',
          tag,
        );
      }
    }),
  );
  it.effect('a different Unit is uncertainty rather than conversion or substitution', () => {
    const input = makeCurrentnessInput(['10']);
    const otherUnit = Schema.decodeUnknownSync(AvailabilitySubjectSchema.fields.quantity.fields.unitRef)({
      ...subject.quantity.unitRef,
      resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    return check(
      {
        ...input,
        ownerQualification: {
          ...input.ownerQualification,
          positions: input.ownerQualification.positions.map((entry) => ({
            ...entry,
            reusableQuantity: { _tag: 'PROVEN', quantity: { amount: '10', unitRef: otherUnit } },
          })),
        },
      },
      'INDETERMINATE',
      'POSITION_SCOPE_MISMATCH',
    );
  });
  it.effect('safely broader Inventory completeness uses the canonical envelope', () => {
    const input = makeCurrentnessInput(['6', '4']);
    const evidence = Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)({
      observedAt: '2026-10-05T12:00:00.000Z',
      ownerRevision: 'broader-owner-revision',
      scope: {
        declaredScopeRef: 'owner-configuration-scope',
        kind: 'SAFELY_BROADER_SCOPE',
        predicateRef: 'owner-predicate-1',
      },
    });
    return check(
      { ...input, ownerQualification: { ...input.ownerQualification, set: { ...complete, evidence } } },
      'AVAILABLE',
    );
  });
  it.effect('independent support is a positive lower bound and never an uncertain negative', () =>
    Effect.gen(function* checkIndependentBound() {
      for (const amount of ['3', '5', '6']) {
        const input = makeCurrentnessInput([amount], '5');
        const positions = input.ownerQualification.positions.map((entry) => ({
          ...entry,
          constraintSupport: 'INDEPENDENTLY_PROVEN' as const,
          uncertaintyReasons: ['CONFLICT', 'SOURCE_COVERAGE_UNCERTAIN', 'UNRESOLVED_RESERVATION_EFFECT'] as const,
        }));
        yield* check(
          { ...input, ownerQualification: { ...input.ownerQualification, positions } },
          amount === '3' ? 'INDETERMINATE' : 'AVAILABLE',
          'SOURCE_COVERAGE_UNCERTAIN',
        );
      }
      yield* check(makeCurrentnessInput(['3'], '5'), 'UNAVAILABLE');
    }),
  );
});
