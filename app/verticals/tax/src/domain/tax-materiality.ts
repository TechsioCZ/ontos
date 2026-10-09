import { Schema } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import { isSamePurchaseIdentity, isSameShippingSourceRef } from './purchase-binding.ts';
import { ShippingAllocationBasisSchema } from './shipping-allocation.ts';
import type { ShippingAllocationBasis } from './shipping-allocation.ts';
import { TaxDecisionIdSchema } from './tax-decision.ts';
import type { TaxDecisionUnit } from './tax-decision.ts';
import { taxDecisionIdFor } from './tax-evaluation.ts';
import type { TaxMeaningFingerprint } from './tax-evaluation.ts';
import { taxExactFractionOfPercent } from './tax-exact-rational.ts';
import type { TaxExactRational } from './tax-exact-rational.ts';
import { TaxOutcomeSuccessSchema } from './tax-outcome.ts';
import type { TaxOutcome, TaxOutcomeSuccess } from './tax-outcome.ts';
import { LineCommercialValueBasisSchema } from './taxable-basis.ts';

type LineCommercialValueBasis = typeof LineCommercialValueBasisSchema.Type;

/** Declared use of the compared meanings; the same states and use give the same conclusion (#943 F10). */
export const TaxMaterialityDeclaredUseSchema = Schema.Literal('LAUNCH_PURCHASE');

/** Tax meaning that changed (#943 F2-F5, #937 F39-F45). */
export const TaxMaterialChangeSchema = Schema.Literals([
  'TAXABLE_SUPPLY_UNITS',
  'APPLICABILITY',
  'JURISDICTION',
  'TREATMENT',
  'CLASSIFICATION',
  'TAXABLE_BASIS',
  'SHIPPING_ALLOCATION',
  'PUBLISHED_TAX_AMOUNT',
  'PURCHASE_TAX_TOTAL',
  'TAX_ROUNDING_POLICY',
]);
export type TaxMaterialChange = typeof TaxMaterialChangeSchema.Type;

/** Provenance/evidence that changed while the material meaning was preserved (#943 F6-F7, F9; #937 F59-F63). */
export const TaxEvidenceDifferenceSchema = Schema.Literals([
  'GOVERNING_TAX_RULE_REVISION',
  'CATALOG_EVIDENCE',
  'PLACE_EVIDENCE',
  'PRICING_SOURCE',
  'SHIPPING_SOURCE',
  'PURCHASE_CANDIDATE',
  'TAX_RELEVANT_TIME',
  'TAX_EVALUATION_TIME',
]);
export type TaxEvidenceDifference = typeof TaxEvidenceDifferenceSchema.Type;

const FingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const ComparedMeaningSchema = Schema.Struct({ decisionId: TaxDecisionIdSchema, meaningFingerprint: FingerprintSchema });

/** TAX cannot attest anything about the pair; consumers must not infer equivalence from it (#943 F8). */
export const TaxMaterialityUnverifiableSchema = Schema.TaggedStruct('UNVERIFIABLE', {
  reason: Schema.Literals(['NOT_DETERMINED', 'DECISION_IDENTITY_MISMATCH', 'DIFFERENT_PURCHASE']),
});

/** At least one material Tax meaning changed (#943 F2-F5, F14). */
export const TaxMaterialChangeConclusionSchema = Schema.TaggedStruct('MATERIAL', {
  current: ComparedMeaningSchema,
  previous: ComparedMeaningSchema,
  reasons: Schema.NonEmptyArray(TaxMaterialChangeSchema),
});

/** Preserved material meaning; changed provenance is named, never fabricated as unchanged (#943 F7, F9, F16). */
export const TaxNonMaterialAttestationSchema = Schema.TaggedStruct('ATTESTED_NON_MATERIAL', {
  currentDecisionId: TaxDecisionIdSchema,
  evidenceDifferences: Schema.Array(TaxEvidenceDifferenceSchema),
  preservedMeaningFingerprint: FingerprintSchema,
  previousDecisionId: TaxDecisionIdSchema,
});

/** TAX-owned materiality conclusion of one exact old/new pair (#943 F1-F10). */
export const TaxMaterialityConclusionSchema = Schema.Union([
  TaxMaterialityUnverifiableSchema,
  TaxMaterialChangeConclusionSchema,
  TaxNonMaterialAttestationSchema,
]);
export type TaxMaterialityConclusion = typeof TaxMaterialityConclusionSchema.Type;

const isSuccess = Schema.is(TaxOutcomeSuccessSchema);
const isLine = Schema.is(LineCommercialValueBasisSchema);
const isShipping = Schema.is(ShippingAllocationBasisSchema);
const exactText = ({ denominator, numerator }: TaxExactRational) => `${numerator}/${denominator}`;
const byText = (left: string, right: string) => left.localeCompare(right, 'en');

/**
 * Unambiguous text of a tuple of opaque owner identifiers: each part is percent-encoded, so no part can contain the
 * `|` separator and distinct tuples never collide; an absent part is a raw space, which encoding never produces.
 */
const joinParts = (parts: readonly (number | string | undefined)[]): string =>
  parts.map((part) => (part === undefined ? ' ' : encodeURIComponent(String(part)))).join('|');

const lineComponents = (unit: TaxDecisionUnit): readonly LineCommercialValueBasis[] =>
  unit.taxableBasisInterpretation.components.flatMap((component) => (isLine(component) ? [component] : []));
const shippingComponents = (unit: TaxDecisionUnit): readonly ShippingAllocationBasis[] =>
  unit.taxableBasisInterpretation.components.flatMap((component) => (isShipping(component) ? [component] : []));

/** Material meaning of one unit; evidence identities are deliberately absent (#943 F2-F7). */
const unitMeaning = (unit: TaxDecisionUnit) => ({
  applicability: unit.applicability,
  basis: lineComponents(unit)
    .map(({ amount, occurrenceId }) => joinParts([occurrenceId, exactText(amount)]))
    .toSorted(byText),
  classification: unit.taxClassification.classificationCode,
  jurisdiction: unit.jurisdiction.jurisdiction,
  mapping: unit.taxableSupplyUnit.mapping._tag,
  shipping: shippingComponents(unit).map(({ amount }) => exactText(amount)),
  treatment: `${unit.treatment._tag}:${exactText(taxExactFractionOfPercent(unit.treatment.ratePercent))}`,
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

const unitEvidence = (unit: TaxDecisionUnit) => ({
  catalog: joinParts([
    unit.taxClassification.completenessEvidenceRef,
    ...unit.taxClassification.materialCatalogEvidence.map(
      ({ catalogFactRef, catalogFactRevisionRef, ownerEvidenceRef }) =>
        joinParts([catalogFactRef, catalogFactRevisionRef, ownerEvidenceRef]),
    ),
  ]),
  place: joinParts([
    unit.jurisdiction.placeEvidenceRefs.sellingLegalEntity,
    unit.jurisdiction.placeEvidenceRefs.deliveryDestination,
    unit.jurisdiction.placeEvidenceRefs.invoiceRecipient,
  ]),
  pricingLine: joinParts(lineComponents(unit).map(({ pricingLineRef }) => pricingLineRef)),
  rule: joinParts([unit.governingTaxRuleRevisionRef.taxRuleId, unit.governingTaxRuleRevisionRef.revision]),
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
    ['GOVERNING_TAX_RULE_REVISION', anyUnitDiffers(previous, current, ({ rule }) => rule)],
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
  !isSuccess(outcome) ||
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
