import { Order, Schema } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import {
  TaxMaterialChangeConclusionSchema,
  TaxMaterialityUnverifiableSchema,
  TaxNonMaterialAttestationSchema,
} from '../../shared/domain/tax-evaluation-contracts.ts';
import type {
  TaxEvidenceDifference,
  TaxMaterialChange,
  TaxMaterialityConclusion,
} from '../../shared/domain/tax-evaluation-contracts.ts';

import {
  isSameExactTaxPurchaseBinding,
  isSameShippingSourceRef,
} from '../../shared/domain/tax-kernel/purchase-binding.ts';
import type { TaxPurchaseBinding } from '../../shared/domain/tax-kernel/purchase-binding.ts';
import { ShippingAllocationBasisSchema } from '../../shared/domain/tax-kernel/shipping-allocation.ts';
import type { ShippingAllocationBasis } from '../../shared/domain/tax-kernel/shipping-allocation.ts';
import { TaxableDecisionUnitSchema } from '../../shared/domain/tax-kernel/tax-decision.ts';
import type { TaxDecisionUnit } from '../../shared/domain/tax-kernel/tax-decision.ts';
import { taxDecisionIdFor } from './tax-evaluation.ts';
import type { TaxMeaningFingerprint } from './tax-evaluation.ts';
import { taxExactFractionOfPercent } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { TaxExactRational } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import { TaxOutcomeSuccessSchema } from './tax-outcome.ts';
import type { TaxOutcome, TaxOutcomeSuccess } from './tax-outcome.ts';
import { TaxOutcomeSuccessSchema as BoundTaxOutcomeSuccessSchema } from '../../shared/domain/tax-kernel/tax-outcome.ts';
import { LineCommercialValueBasisSchema } from '../../shared/domain/tax-kernel/taxable-basis.ts';

type LineCommercialValueBasis = typeof LineCommercialValueBasisSchema.Type;

export {
  TaxMaterialChangeConclusionSchema,
  TaxMaterialityUnverifiableSchema,
  TaxNonMaterialAttestationSchema,
} from '../../shared/domain/tax-evaluation-contracts.ts';
export type { TaxMaterialityConclusion } from '../../shared/domain/tax-evaluation-contracts.ts';

/**
 * Same exact purchase/use for a Tax materiality comparison: Tenant, Selling Legal Entity, Purchasing Subject,
 * currency and the exact occurrence set with Catalog Selection and Quantity + Unit. Candidate, Pricing Result and
 * Shipping source revisions may differ between an approved prospective and a final evaluation; whether that change
 * is material is the comparison's own conclusion (#943 F1, F9, F11-F12; #937 F1-F14, F59-F62).
 */
export const isSamePurchaseIdentity = (left: TaxPurchaseBinding, right: TaxPurchaseBinding): boolean => {
  const { shippingSourceRef: _rightShipping, ...rightWithoutShipping } = right;
  const aligned = {
    ...rightWithoutShipping,
    pricingResultRef: left.pricingResultRef,
    purchaseCandidateRef: left.purchaseCandidateRef,
  };
  return isSameExactTaxPurchaseBinding(
    left,
    left.shippingSourceRef === undefined ? aligned : { ...aligned, shippingSourceRef: left.shippingSourceRef },
  );
};

const isSuccess = Schema.is(TaxOutcomeSuccessSchema);
/** Published binding-only shape: scope is checked on every determined outcome, consistent or not. */
const isDetermined = Schema.is(BoundTaxOutcomeSuccessSchema);
const isLine = Schema.is(LineCommercialValueBasisSchema);
const isTaxableDecisionUnit = Schema.is(TaxableDecisionUnitSchema);
const isShipping = Schema.is(ShippingAllocationBasisSchema);
const exactText = ({ denominator, numerator }: TaxExactRational) => `${numerator}/${denominator}`;
/** Exact code-unit order: locale collation can rank distinct identifiers as equal, so it never orders identities. */
const byText = Order.String;

/**
 * Unambiguous text of a tuple of opaque owner identifiers: each part is length-prefixed, so any content (separators,
 * lone surrogates) stays distinct and the encoding never throws; an absent part is `~`, which no length prefix starts
 * with.
 */
const joinParts = (parts: readonly (number | string | undefined)[]): string =>
  parts.map((part) => (part === undefined ? '~' : `${String(part).length}:${String(part)}`)).join('');

const lineComponents = (unit: TaxDecisionUnit): readonly LineCommercialValueBasis[] =>
  unit.taxableBasisInterpretation.components.flatMap((component) => (isLine(component) ? [component] : []));
const shippingComponents = (unit: TaxDecisionUnit): readonly ShippingAllocationBasis[] =>
  unit.taxableBasisInterpretation.components.flatMap((component) => (isShipping(component) ? [component] : []));

/**
 * Material meaning of one unit; evidence identities are deliberately absent (#943 F2-F7). A non-payer unit has no
 * classification, so a payer-vs-non-payer change is reported through TREATMENT alone (Unit 10 A5).
 */
const unitMeaning = (unit: TaxDecisionUnit) => ({
  applicability: unit.applicability,
  basis: lineComponents(unit)
    .map(({ amount, occurrenceId }) => joinParts([occurrenceId, exactText(amount)]))
    .toSorted(byText),
  classification: isTaxableDecisionUnit(unit) ? unit.taxClassification.classificationCode : 'NONE',
  jurisdiction: unit.jurisdiction.jurisdiction,
  mapping: unit.taxableSupplyUnit.mapping._tag,
  shipping: shippingComponents(unit).map(({ amount }) => exactText(amount)),
  treatment: isTaxableDecisionUnit(unit)
    ? `${unit.treatment._tag}:${exactText(taxExactFractionOfPercent(unit.treatment.ratePercent))}`
    : unit.treatment._tag,
});

/** Material Tax meaning of one successful outcome: per-unit Decision meaning plus the published Result (#943 F2-F5). */
const materialMeaning = ({ decision, result }: TaxOutcomeSuccess) => {
  const published = new Map<string, string>(
    result.units.map(({ publishedTaxAmount, taxableSupplyUnitId }) => [taxableSupplyUnitId, publishedTaxAmount.amount]),
  );
  return {
    currency: result.currency,
    purchaseTaxTotal: result.purchaseTaxTotal.amount,
    roundingPolicyRevision: result.taxRoundingPolicy.revision,
    units: decision.units
      .map((unit) => ({
        ...unitMeaning(unit),
        publishedTaxAmount: published.get(unit.taxableSupplyUnit.unitId) ?? '',
        unitId: unit.taxableSupplyUnit.unitId,
      }))
      .toSorted((left, right) => byText(left.unitId, right.unitId)),
  };
};
type MaterialMeaning = ReturnType<typeof materialMeaning>;
type UnitMaterialMeaning = MaterialMeaning['units'][number];

const unitChecks: readonly (readonly [TaxMaterialChange, (unit: UnitMaterialMeaning) => string])[] = [
  ['APPLICABILITY', (unit) => unit.applicability],
  ['JURISDICTION', (unit) => unit.jurisdiction],
  ['TREATMENT', (unit) => unit.treatment],
  ['CLASSIFICATION', (unit) => unit.classification],
  ['TAXABLE_BASIS', (unit) => joinParts(unit.basis)],
  ['SHIPPING_ALLOCATION', (unit) => joinParts(unit.shipping)],
  ['PUBLISHED_TAX_AMOUNT', (unit) => unit.publishedTaxAmount],
];

/** Every changed material meaning, in a fixed order; a changed unit set is reported alone (#943 F2-F5). */
const materialChanges = (previous: MaterialMeaning, current: MaterialMeaning): readonly TaxMaterialChange[] => {
  const currentById = new Map(current.units.map((unit) => [unit.unitId, unit]));
  const sameUnits =
    previous.units.length === current.units.length &&
    previous.units.every(({ mapping, unitId }) => currentById.get(unitId)?.mapping === mapping);
  if (!sameUnits) {
    return ['TAXABLE_SUPPLY_UNITS'];
  }
  const changedUnitMeanings = unitChecks.flatMap(([change, meaningOf]) =>
    previous.units.some((unit) => {
      const counterpart = currentById.get(unit.unitId);
      return counterpart === undefined || meaningOf(unit) !== meaningOf(counterpart);
    })
      ? [change]
      : [],
  );
  return [
    ...changedUnitMeanings,
    ...(previous.purchaseTaxTotal === current.purchaseTaxTotal ? [] : (['PURCHASE_TAX_TOTAL'] as const)),
    ...(previous.roundingPolicyRevision === current.roundingPolicyRevision ? [] : (['TAX_ROUNDING_POLICY'] as const)),
  ];
};

/**
 * Evidence identities of one unit; fact and line sets are ordered, so array position is never a difference
 * (#937 F7). `governing` is the governing Tax Rule Revision for a taxable unit, or the declaration revision plus
 * legal-basis revision for a non-payer unit; catalog evidence is empty for a non-payer unit (Unit 10 A5).
 */
const unitEvidence = (unit: TaxDecisionUnit) => ({
  catalog: isTaxableDecisionUnit(unit)
    ? joinParts([
        unit.taxClassification.completenessEvidenceRef,
        ...unit.taxClassification.materialCatalogEvidence
          .map(({ catalogFactRef, catalogFactRevisionRef, factKind, factValue, ownerEvidenceRef }) =>
            joinParts([catalogFactRef, catalogFactRevisionRef, factKind, factValue, ownerEvidenceRef]),
          )
          .toSorted(byText),
      ])
    : joinParts([]),
  governing: isTaxableDecisionUnit(unit)
    ? joinParts([unit.governingTaxRuleRevisionRef.taxRuleId, unit.governingTaxRuleRevisionRef.revision])
    : joinParts([unit.governingReference.declarationRevisionRef.revision, unit.governingReference.legalBasis.revision]),
  place: joinParts([
    unit.jurisdiction.placeEvidenceRefs.sellingLegalEntity,
    unit.jurisdiction.placeEvidenceRefs.deliveryDestination,
    unit.jurisdiction.placeEvidenceRefs.invoiceRecipient,
  ]),
  pricingLine: joinParts(
    lineComponents(unit)
      .map(({ pricingLineRef }) => pricingLineRef)
      .toSorted(byText),
  ),
  shippingWeights: joinParts(
    shippingComponents(unit).map(({ allocationWeightsEvidenceRef }) => allocationWeightsEvidenceRef),
  ),
});
type UnitEvidence = ReturnType<typeof unitEvidence>;

const anyUnitDiffers = (
  previous: TaxOutcomeSuccess,
  current: TaxOutcomeSuccess,
  evidenceOf: (evidence: UnitEvidence) => string,
) => {
  const currentById = new Map(current.decision.units.map((unit) => [unit.taxableSupplyUnit.unitId, unit]));
  return previous.decision.units.some((unit) => {
    const counterpart = currentById.get(unit.taxableSupplyUnit.unitId);
    return counterpart === undefined || evidenceOf(unitEvidence(unit)) !== evidenceOf(unitEvidence(counterpart));
  });
};

/** Changed provenance of a materially equal pair; nothing here is fabricated as unchanged (#943 F7, F9, F16). */
const evidenceDifferences = (
  previous: TaxOutcomeSuccess,
  current: TaxOutcomeSuccess,
): readonly TaxEvidenceDifference[] => {
  const left = previous.decision;
  const right = current.decision;
  const checks: readonly (readonly [TaxEvidenceDifference, boolean])[] = [
    ['GOVERNING_TAX_RULE_REVISION', anyUnitDiffers(previous, current, ({ governing }) => governing)],
    ['CATALOG_EVIDENCE', anyUnitDiffers(previous, current, ({ catalog }) => catalog)],
    ['PLACE_EVIDENCE', anyUnitDiffers(previous, current, ({ place }) => place)],
    [
      'PRICING_SOURCE',
      left.purchaseBinding.pricingResultRef.pricingResultId !==
        right.purchaseBinding.pricingResultRef.pricingResultId ||
        left.purchaseBinding.pricingResultRef.revision !== right.purchaseBinding.pricingResultRef.revision ||
        anyUnitDiffers(previous, current, ({ pricingLine }) => pricingLine),
    ],
    [
      'SHIPPING_SOURCE',
      !isSameShippingSourceRef(left.purchaseBinding.shippingSourceRef, right.purchaseBinding.shippingSourceRef) ||
        anyUnitDiffers(previous, current, ({ shippingWeights }) => shippingWeights),
    ],
    ['PURCHASE_CANDIDATE', left.purchaseBinding.purchaseCandidateRef !== right.purchaseBinding.purchaseCandidateRef],
    ['TAX_RELEVANT_TIME', left.taxRelevantTime.epochMilliseconds !== right.taxRelevantTime.epochMilliseconds],
    ['TAX_EVALUATION_TIME', left.taxEvaluationTime.epochMilliseconds !== right.taxEvaluationTime.epochMilliseconds],
    // A later declaration revision alone proves no equivalence of the covered instant (#943 F28 patch).
    [
      'SELLER_VAT_REGIME_DECLARATION_REVISION',
      left.declarationRevisionRef.revision !== right.declarationRevisionRef.revision,
    ],
  ];
  return checks.flatMap(([difference, differs]) => (differs ? [difference] : []));
};

/**
 * A compared successful outcome is visible only to its own Tenant and Selling Legal Entity, taken from the trusted
 * Operational Scope; a non-success carries no purchase (#950 F21-F25).
 */
export const taxOutcomeVisibleInScope = (
  outcome: TaxOutcome,
  scope: Readonly<{ legalEntityId?: string | undefined; tenantId: string }>,
): boolean =>
  !isDetermined(outcome) ||
  (outcome.decision.purchaseBinding.tenantId === scope.tenantId &&
    outcome.decision.purchaseBinding.sellingLegalEntityRef === scope.legalEntityId);

const hasOwnDecisionIdentity = (outcome: TaxOutcomeSuccess, fingerprint: TaxMeaningFingerprint) =>
  taxDecisionIdFor(outcome.decision, fingerprint) === outcome.decision.decisionId;

const materialChange = (
  previous: TaxOutcomeSuccess,
  current: TaxOutcomeSuccess,
  reasons: NonEmptyReadonlyArray<TaxMaterialChange>,
  fingerprint: TaxMeaningFingerprint,
): TaxMaterialityConclusion =>
  TaxMaterialChangeConclusionSchema.make({
    current: { decisionId: current.decision.decisionId, meaningFingerprint: fingerprint(materialMeaning(current)) },
    previous: { decisionId: previous.decision.decisionId, meaningFingerprint: fingerprint(materialMeaning(previous)) },
    reasons,
  });

/**
 * TAX-owned materiality of exact old/new Tax meanings for one exact purchase/use (#943 F1-F12). Pure and stateless:
 * no Bundle, Attempt or approval identity is needed or produced. Equal totals, rates, IDs or timestamps never prove
 * equivalence; every material meaning is compared (#943 F5). Non-materiality is attested only for two verifiable
 * successful outcomes of the same purchase whose material meaning is preserved; anything else is unverifiable, never
 * an implicit attestation (#943 F7-F8).
 */
export const compareTaxMateriality = (
  input: Readonly<{ current: TaxOutcome; previous: TaxOutcome }>,
  fingerprint: TaxMeaningFingerprint,
): TaxMaterialityConclusion => {
  const { current, previous } = input;
  if (!isSuccess(previous) || !isSuccess(current)) {
    return TaxMaterialityUnverifiableSchema.make({ reason: 'NOT_DETERMINED' });
  }
  if (!hasOwnDecisionIdentity(previous, fingerprint) || !hasOwnDecisionIdentity(current, fingerprint)) {
    return TaxMaterialityUnverifiableSchema.make({ reason: 'DECISION_IDENTITY_MISMATCH' });
  }
  if (!isSamePurchaseIdentity(previous.decision.purchaseBinding, current.decision.purchaseBinding)) {
    return TaxMaterialityUnverifiableSchema.make({ reason: 'DIFFERENT_PURCHASE' });
  }
  const preserved = materialMeaning(previous);
  const [firstReason, ...otherReasons] = materialChanges(preserved, materialMeaning(current));
  return firstReason === undefined
    ? TaxNonMaterialAttestationSchema.make({
        currentDecisionId: current.decision.decisionId,
        evidenceDifferences: evidenceDifferences(previous, current),
        preservedMeaningFingerprint: fingerprint(preserved),
        previousDecisionId: previous.decision.decisionId,
      })
    : materialChange(previous, current, [firstReason, ...otherReasons], fingerprint);
};
