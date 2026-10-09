import { DateTime, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { FrozenOrderCandidateSchema } from '../../shared/actions/order-tax-finalization.ts';
import { OrderCommitmentTimeSchema } from '../../shared/domain/tax-kernel/tax-time.ts';
import {
  decideOrderTaxFinalization,
  finalEvaluationRequest,
  orderTaxIntentFingerprint,
} from '../../src/domain/order-tax-finalization.ts';
import { taxMeaningFingerprint } from '../../src/services/tax-governance-fingerprint.ts';
import { occurrenceInput, purchaseBindingInput } from './tax-domain-fixtures.ts';
import {
  PRICING_RESULT_REF,
  REDUCED_CODE,
  STANDARD_CODE,
  catalogEntry,
  evaluationRequestInput,
  pricingLine,
} from './tax-evaluation-fixtures.ts';
import type { TaxEvaluationRequestInput } from './tax-evaluation-fixtures.ts';

const decodeCandidate = Schema.decodeUnknownSync(FrozenOrderCandidateSchema);
const commitmentTime = (iso: string) => OrderCommitmentTimeSchema.make(DateTime.makeUnsafe(iso));
const T = commitmentTime('2026-06-01T10:00:00.000Z');

const candidateInput = (overrides: Partial<TaxEvaluationRequestInput> = {}) => {
  const { taxRelevantTime: _taxRelevantTime, ...candidate } = evaluationRequestInput(overrides);
  return candidate;
};
const intent = (overrides: Partial<TaxEvaluationRequestInput> = {}, at = T) =>
  orderTaxIntentFingerprint(decodeCandidate(candidateInput(overrides)), at, taxMeaningFingerprint);

describe('Final Order Tax intent (#944 F10-F12, #941 F2-F4)', () => {
  it('the final evaluation request is the frozen candidate at exactly T', () => {
    const request = finalEvaluationRequest(decodeCandidate(candidateInput()), T);

    expect(DateTime.formatIso(request.taxRelevantTime)).toBe('2026-06-01T10:00:00.000Z');
  });

  it('the same frozen intent gives the same fingerprint whatever the input order', () => {
    const reordered = intent({
      catalog: [catalogEntry('o2', REDUCED_CODE), catalogEntry('o1', STANDARD_CODE)],
      pricing: {
        pricingResultRef: PRICING_RESULT_REF,
        publishedLines: [pricingLine('o2', '500.00'), pricingLine('o1', '1000.00')],
      },
      purchase: purchaseBindingInput(['o2', 'o1']),
    });

    expect(reordered).toBe(intent());
  });

  it('#937 F38 traceability-only context is not part of the frozen intent', () => {
    expect(intent({ purchase: purchaseBindingInput(['o1', 'o2'], { traceabilityContext: { channel: 'B2B' } }) })).toBe(
      intent(),
    );
  });

  it('#944 F11 a changed quantity or a different T is a different intent', () => {
    const changedQuantity = intent({
      purchase: purchaseBindingInput(['o1', 'o2'], {
        purchaseDemandOccurrences: [
          { ...occurrenceInput('o1'), quantity: { amount: '2', unitRef: 'piece' } },
          occurrenceInput('o2'),
        ],
      }),
    });

    expect(changedQuantity).not.toBe(intent());
    expect(intent({}, commitmentTime('2026-06-01T10:00:01.000Z'))).not.toBe(intent());
  });

  it('#944 F10-F12 recovers the same intent, conflicts on another, finalizes only without a final', () => {
    expect(decideOrderTaxFinalization(Option.none(), 'a')).toBe('FINALIZE');
    expect(decideOrderTaxFinalization(Option.some('a'), 'a')).toBe('RECOVER');
    expect(decideOrderTaxFinalization(Option.some('a'), 'b')).toBe('CONFLICT');
  });
});
