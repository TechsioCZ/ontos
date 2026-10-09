import { Option, Result, Schema } from 'effect';

import type { FrozenOrderCandidate } from '../../shared/actions/order-tax-finalization.ts';
import { TaxEvaluationRequestSchema } from '../../shared/domain/tax-evaluation-contracts.ts';
import type { TaxEvaluationRequest } from '../../shared/domain/tax-evaluation-contracts.ts';
import type { OrderCommitmentTime } from '../../shared/domain/tax-kernel/tax-time.ts';
import type { TaxMeaningFingerprint } from './tax-evaluation.ts';
import { finalLaunchOrderTaxRelevantTime } from './tax-time.ts';

export { FrozenOrderCandidateSchema, OrderSubmissionRefSchema } from '../../shared/actions/order-tax-finalization.ts';
export type { FrozenOrderCandidate, OrderSubmissionRef } from '../../shared/actions/order-tax-finalization.ts';

/** The evaluation request of the final determination: the frozen candidate at T. */
export const finalEvaluationRequest = (
  candidate: FrozenOrderCandidate,
  orderCommitmentTime: OrderCommitmentTime,
): TaxEvaluationRequest => ({ ...candidate, taxRelevantTime: finalLaunchOrderTaxRelevantTime(orderCommitmentTime) });

const encodeRequest = Schema.encodeResult(TaxEvaluationRequestSchema);
const byText = (left: string, right: string) => left.localeCompare(right, 'en');
const byOccurrence = <Entry extends Readonly<{ occurrenceId: string }>>(entries: readonly Entry[]) =>
  entries.toSorted((left, right) => byText(left.occurrenceId, right.occurrenceId));

/**
 * Canonical frozen intent of one submission: the whole candidate at T in identity order, without traceability-only
 * context (#937 F38). Equal fingerprints mean the same submitted intent; a different one under the same submission
 * identity is a conflict, never a second result (#944 F11).
 */
export const orderTaxIntentFingerprint = (
  candidate: FrozenOrderCandidate,
  orderCommitmentTime: OrderCommitmentTime,
  fingerprint: TaxMeaningFingerprint,
): string => {
  const encoded = Result.getOrThrow(encodeRequest(finalEvaluationRequest(candidate, orderCommitmentTime)));
  const { traceabilityContext: _traceability, ...purchase } = encoded.purchase;
  return fingerprint({
    ...encoded,
    catalog: byOccurrence(encoded.catalog),
    pricing: { ...encoded.pricing, publishedLines: byOccurrence(encoded.pricing.publishedLines) },
    purchase: { ...purchase, purchaseDemandOccurrences: byOccurrence(purchase.purchaseDemandOccurrences) },
    setSupplyMeanings: byOccurrence(encoded.setSupplyMeanings ?? []),
    shipping:
      encoded.shipping === undefined
        ? null
        : {
            ...encoded.shipping,
            affectedOccurrenceIds: encoded.shipping.affectedOccurrenceIds.toSorted(byText),
            allocationWeights:
              encoded.shipping.allocationWeights === undefined
                ? null
                : {
                    ...encoded.shipping.allocationWeights,
                    weights: byOccurrence(encoded.shipping.allocationWeights.weights),
                  },
          },
  });
};

/** What a finalization request does for its submission identity (#944 F10-F12, #941 F9). */
export const OrderTaxFinalizationStepSchema = Schema.Literals(['RECOVER', 'CONFLICT', 'FINALIZE']);
export type OrderTaxFinalizationStep = typeof OrderTaxFinalizationStepSchema.Type;

/**
 * A durable final for the submission is recovered unchanged for the same frozen intent, without any rule or source
 * read; a different intent conflicts; only a submission without a final is evaluated (#944 F10-F12, #942 H).
 */
export const decideOrderTaxFinalization = (
  existingIntentFingerprint: Option.Option<string>,
  intentFingerprint: string,
): OrderTaxFinalizationStep =>
  Option.match(existingIntentFingerprint, {
    onNone: () => 'FINALIZE',
    onSome: (existing) => (existing === intentFingerprint ? 'RECOVER' : 'CONFLICT'),
  });
