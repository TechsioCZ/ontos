import { Order, Result, Schema } from 'effect';

import type { FrozenOrderCandidate } from '../../shared/actions/order-tax-finalization.ts';
import { TaxEvaluationRequestSchema } from '../../shared/domain/tax-evaluation-contracts.ts';
import type { TaxEvaluationRequest } from '../../shared/domain/tax-evaluation-contracts.ts';
import type { OrderCommitmentTime } from '../../shared/domain/tax-kernel/tax-time.ts';
import type { TaxMeaningFingerprint } from './tax-evaluation.ts';
import { finalLaunchOrderTaxRelevantTime } from './tax-time.ts';

export { OrderSubmissionRefSchema } from '../../shared/actions/order-tax-finalization.ts';
export type { FrozenOrderCandidate } from '../../shared/actions/order-tax-finalization.ts';

/** The evaluation request of the final determination: the frozen candidate at T. */
export const finalEvaluationRequest = (
  candidate: FrozenOrderCandidate,
  orderCommitmentTime: OrderCommitmentTime,
): TaxEvaluationRequest => ({ ...candidate, taxRelevantTime: finalLaunchOrderTaxRelevantTime(orderCommitmentTime) });

const encodeRequest = Schema.encodeResult(TaxEvaluationRequestSchema);
/** Exact code-unit order: distinct identifiers never collate equal, so input order never leaks into the intent. */
const byText = Order.String;
const byOccurrence = <Entry extends Readonly<{ occurrenceId: string }>>(entries: readonly Entry[]) =>
  entries.toSorted((left, right) => byText(left.occurrenceId, right.occurrenceId));
type EncodedContribution = Readonly<{
  amount: Readonly<{ amount: Readonly<{ denominator: string; numerator: string }>; currency: string }>;
  contributionFamily: string;
  contributionRef: string;
}>;

/** Total order of Pricing contributions; identical records are interchangeable, so duplicates stay harmless. */
const byContribution = <Contribution extends EncodedContribution>(breakdown: readonly Contribution[]) =>
  breakdown.toSorted(
    Order.combineAll([
      Order.mapInput(byText, ({ contributionRef }: Contribution) => contributionRef),
      Order.mapInput(byText, ({ contributionFamily }: Contribution) => contributionFamily),
      Order.mapInput(byText, ({ amount }: Contribution) => amount.currency),
      Order.mapInput(byText, ({ amount }: Contribution) => amount.amount.numerator),
      Order.mapInput(byText, ({ amount }: Contribution) => amount.amount.denominator),
    ]),
  );
const byCatalogFact = <Evidence extends Readonly<{ catalogFactRef: string }>>(evidence: readonly Evidence[]) =>
  evidence.toSorted((left, right) => byText(left.catalogFactRef, right.catalogFactRef));

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
    catalog: byOccurrence(encoded.catalog).map((entry) => ({
      ...entry,
      classificationInput: {
        ...entry.classificationInput,
        materialCatalogEvidence: byCatalogFact(entry.classificationInput.materialCatalogEvidence),
      },
    })),
    pricing: {
      ...encoded.pricing,
      publishedLines: byOccurrence(encoded.pricing.publishedLines).map((line) => ({
        ...line,
        breakdown: byContribution(line.breakdown),
      })),
    },
    purchase: { ...purchase, purchaseDemandOccurrences: byOccurrence(purchase.purchaseDemandOccurrences) },
    setSupplyMeanings: byOccurrence(encoded.setSupplyMeanings ?? []),
    shipping:
      encoded.shipping === undefined
        ? null
        : {
            ...encoded.shipping,
            affectedOccurrenceIds: encoded.shipping.affectedOccurrenceIds.toSorted(byText),
          },
  });
};
