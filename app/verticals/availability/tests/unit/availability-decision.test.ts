import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  AvailabilityInventoryPositionEvidenceSchema,
  AvailabilityStockInputSchema,
} from '../../shared/domain/availability-source-authority.ts';
import { AvailabilitySubjectSchema } from '../../shared/domain/availability-subject.ts';
import type { AvailabilityEvaluationInput } from '../../shared/domain/availability-decision.ts';
import { availabilityEvaluationService } from '../../src/services/availability-evaluation.service.ts';
import { position, stockInput, subject } from '../support/availability-decision.ts';

const boundary = {
  kind: 'INFORMATIONAL' as const,
  requiredAt: subject.purchasingContext.contextVerification.request.operationTime,
};
const complete = {
  _tag: 'COMPLETE' as const,
  evidence: Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)({
    observedAt: '2026-10-05T12:00:00.000Z',
    ownerRevision: 'set-revision-1',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'owner-predicate-1' },
  }),
  predicateRef: 'owner-predicate-1',
};
const makeInput = (amounts: readonly string[], requested = '10'): AvailabilityEvaluationInput => {
  const exactSubject = { ...subject, quantity: { ...subject.quantity, amount: requested } };
  const stock = Schema.decodeUnknownSync(AvailabilityStockInputSchema)({
    ...stockInput,
    positions: amounts.map((amount, index) => {
      const onHand = {
        ...position.position.onHand,
        _tag: 'CURRENT' as const,
        evidenceRef: `proof-${index}`,
        observedAt: subject.purchasingContext.contextVerification.request.operationTime,
        quantity: { amount, unitRef: subject.quantity.unitRef },
      };
      return {
        ...position,
        position: {
          ...position.position,
          onHand,
          ref: { ...position.position.ref, resourceId: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}` },
        },
        sourceEvidence: { ...position.sourceEvidence, _tag: 'OWNER_MANAGED' as const, onHand },
      };
    }),
  });
  return {
    ownerQualification: {
      currentness: 'CURRENT',
      positions: stock.positions.map((entry, index) => ({
        constraintSupport: 'RESOLVED',
        positionRef: entry.position.ref,
        reusableQuantity: {
          _tag: 'PROVEN',
          quantity: { amount: amounts[index] ?? '0', unitRef: subject.quantity.unitRef },
        },
        usability: 'USABLE',
      })),
      set: complete,
      stockInput: stock,
      subject: exactSubject,
      useBoundary: boundary,
    },
    policy: {
      kind: 'LAUNCH_EXACT_QUANTITY',
      owner: 'AVAILABILITY',
      revisionRef: 'LAUNCH_EXACT_QUANTITY_V1',
      subject: exactSubject,
      useBoundary: boundary,
    },
    stockInput: stock,
    subject: exactSubject,
    useBoundary: boundary,
  };
};
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
  it.effect('covers 6 + 4 without allocating and respects quantity 2 versus 5', () =>
    Effect.gen(function* checkCoverage() {
      yield* check(makeInput(['6', '4']), 'AVAILABLE');
      yield* check(makeInput(['3'], '2'), 'AVAILABLE');
      yield* check(makeInput(['3'], '5'), 'UNAVAILABLE', 'INSUFFICIENT_REUSABLE_QUANTITY');
      yield* check(makeInput(['0']), 'UNAVAILABLE', 'CURRENT_ZERO');
      yield* check(makeInput([]), 'UNAVAILABLE', 'COMPLETE_EMPTY_SET');
      yield* check(makeInput(['0.1', '0.2'], '0.3'), 'AVAILABLE');
    }),
  );
  it.effect('incomplete sets cannot establish positive or negative', () =>
    Effect.gen(function* checkIncomplete() {
      for (const amounts of [['100'], ['0'], []]) {
        const input = makeInput(amounts);
        yield* check(
          { ...input, ownerQualification: { ...input.ownerQualification, set: { _tag: 'UNPROVEN' } } },
          'INDETERMINATE',
          'SET_COMPLETENESS_UNPROVEN',
        );
      }
    }),
  );
  it.effect('never derives reusable quantity from ON_HAND minus RESERVED', () => {
    const input = makeInput(['100']);
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
      const input = makeInput(['100']);
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
      const input = makeInput(['100']);
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
    const input = makeInput(['6']);
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
      const input = makeInput(['10']);
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
      yield* check(makeInput(['6'], '10'), 'UNAVAILABLE');
    }),
  );
  it.effect('UNKNOWN, MISSING, STALE and INDETERMINATE never become zero', () =>
    Effect.gen(function* checkEvidenceStates() {
      for (const tag of ['UNKNOWN', 'MISSING', 'INDETERMINATE', 'STALE'] as const) {
        const input = makeInput(['10']);
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
        const stock = { ...input.stockInput, positions };
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
    const input = makeInput(['10']);
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
    const input = makeInput(['6', '4']);
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
        const input = makeInput([amount], '5');
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
      yield* check(makeInput(['3'], '5'), 'UNAVAILABLE');
    }),
  );
});
