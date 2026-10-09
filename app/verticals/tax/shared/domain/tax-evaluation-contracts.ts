import { Schema } from 'effect';

import {
  CustomerSafeTaxDecompositionNeedSchema,
  CustomerSafeTaxProjectionSchema,
} from './tax-kernel/customer-safe-tax-projection.ts';
import {
  PricingResultRefSchema,
  PurchaseDemandOccurrenceIdSchema,
  TaxPurchaseBindingSchema,
} from './tax-kernel/purchase-binding.ts';
import { ShippingSourceObservationSchema } from './tax-kernel/shipping-allocation.ts';
import { TaxClassificationInputSchema } from './tax-kernel/tax-classification.ts';
import { TaxDecisionIdSchema } from './tax-kernel/tax-decision.ts';
import { BoundedIdentifierSchema, distinctBy } from './tax-kernel/tax-domain-primitives.ts';
import { NonNegativeTaxExactRationalSchema } from './tax-kernel/tax-exact-rational.ts';
import { TaxJurisdictionInputSchema } from './tax-kernel/tax-jurisdiction.ts';
import { TaxOutcomeSchema } from './tax-kernel/tax-outcome.ts';
import { TaxEvaluationTimeSchema, TaxRelevantTimeSchema } from './tax-kernel/tax-time.ts';
import { PublishedPricingLineSchema } from './tax-kernel/taxable-basis.ts';
import { TaxSourceAssertionRefSchema } from '../resources/tax-source-assertion.ts';
import { ApplicableTaxRuleSetResponseContractSchema } from './tax-governed-read-contracts.ts';
import {
  SellingLegalEntityVatRegistrationStateContractSchema,
  TaxFactAuthorityOutcomeSchema,
  TaxSourceRegistrationResolutionReasonSchema,
} from './tax-source-read-contracts.ts';

const FingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const distinctOccurrenceIds = distinctBy(
  ({ occurrenceId }: Readonly<{ occurrenceId: string }>) => occurrenceId,
  'Each Purchase Demand Occurrence appears once',
);

/** Owner-issued Catalog classification evidence of one exact occurrence (#926 F6, #937 F13). */
const OccurrenceCatalogEvidenceSchema = Schema.Struct({
  classificationInput: TaxClassificationInputSchema,
  occurrenceId: PurchaseDemandOccurrenceIdSchema,
});

/** Explicit Tax legal supply meaning of a Set occurrence; an ordinary occurrence declares none (#934, #920 F25-F30). */
const SetSupplyMeaningDeclarationSchema = Schema.Struct({
  meaning: Schema.Literals(['WHOLE_TREATMENT_SET', 'MULTI_SUPPLY_SET']),
  occurrenceId: PurchaseDemandOccurrenceIdSchema,
});

/**
 * Owner-issued Shipping of the exact purchase with the occurrences it relates to and, when several share it, the
 * explicit owner-approved weights keyed by occurrence; TAX maps them to its own Taxable Supply Units (#933 F12-F18,
 * PO decision D3 default, pending on #907).
 */
const ShippingEvaluationInputSchema = Schema.Struct({
  affectedOccurrenceIds: Schema.NonEmptyArray(PurchaseDemandOccurrenceIdSchema).check(
    distinctBy((occurrenceId: string) => occurrenceId, 'Each affected occurrence appears once'),
  ),
  allocationWeights: Schema.optionalKey(
    Schema.Struct({
      approvalEvidenceRef: BoundedIdentifierSchema,
      weights: Schema.NonEmptyArray(
        Schema.Struct({ occurrenceId: PurchaseDemandOccurrenceIdSchema, weight: NonNegativeTaxExactRationalSchema }),
      ).check(distinctOccurrenceIds),
    }),
  ),
  source: ShippingSourceObservationSchema,
});

/**
 * Prospective Tax evaluation request for one exact purchase at a caller-declared Tax-Relevant Time (#941 F6). Foreign
 * owner facts (Pricing, Catalog, Shipping, places) arrive as owner-issued evidence the server-side caller holds;
 * Tenant and Selling Legal Entity are checked against the trusted Operational Scope, never trusted from here.
 */
export const TaxEvaluationRequestSchema = Schema.Struct({
  catalog: Schema.NonEmptyArray(OccurrenceCatalogEvidenceSchema).check(distinctOccurrenceIds),
  decompositionNeed: CustomerSafeTaxDecompositionNeedSchema,
  places: TaxJurisdictionInputSchema,
  pricing: Schema.Struct({
    pricingResultRef: PricingResultRefSchema,
    publishedLines: Schema.Array(PublishedPricingLineSchema),
  }),
  purchase: TaxPurchaseBindingSchema,
  setSupplyMeanings: Schema.optionalKey(Schema.Array(SetSupplyMeaningDeclarationSchema).check(distinctOccurrenceIds)),
  shipping: Schema.optionalKey(ShippingEvaluationInputSchema),
  taxRelevantTime: TaxRelevantTimeSchema,
});
export type TaxEvaluationRequest = typeof TaxEvaluationRequestSchema.Type;

/**
 * Why a request is not one structurally bound purchase. These are request rejections, never Tax Outcomes: the closed
 * #938 outcome set describes evaluated purchases only.
 */
export const TaxEvaluationRequestRejectionReasonSchema = Schema.Literals([
  'STRUCTURAL_BINDING_INVALID',
  'SET_MEANING_UNDECLARED',
  'FUTURE_TAX_RELEVANT_TIME',
]);
export type TaxEvaluationRequestRejectionReason = typeof TaxEvaluationRequestRejectionReasonSchema.Type;

/** Why an evaluation candidate was discarded before publication (#942 F17-F18). */
export const TaxEvaluationDiscardReasonSchema = Schema.Literals(['RULE_SET_CHANGED', 'SELLER_STATE_CHANGED']);
export type TaxEvaluationDiscardReason = typeof TaxEvaluationDiscardReasonSchema.Type;

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

const RowCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const AttemptSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * Where the Pricing, Catalog, Shipping and place facts of an evaluation came from. Until #892 TAX cannot fetch them
 * from their owners, so they are owner-issued evidence supplied by the server-side caller and checked only for
 * permission and structural binding (human decision A on #907, step 5).
 */
export const TaxForeignEvidenceOriginSchema = Schema.Literal('CALLER_SUPPLIED_UNVERIFIED');

export const TaxEvaluationRequestContractSchema = TaxEvaluationRequestSchema;

/** Completeness evidence of one decisive rule predicate actually used (#942 F16, #937 F31, F36-F37). */
const RuleSetEvidenceSchema = Schema.Struct({
  outcome: ApplicableTaxRuleSetResponseContractSchema.fields.outcome,
  predicateFingerprint: FingerprintSchema,
  rowCount: RowCountSchema,
  setFingerprint: FingerprintSchema,
  taxClassificationCode: Schema.String,
});

/** Selling Legal Entity VAT Registration evidence actually used at Tax Evaluation Time (#942 F5, F16). */
const SellerRegistrationEvidenceSchema = Schema.Struct({
  authorityOutcome: TaxFactAuthorityOutcomeSchema,
  basisAssertionRefs: Schema.Array(TaxSourceAssertionRefSchema),
  reason: TaxSourceRegistrationResolutionReasonSchema,
  setFingerprint: FingerprintSchema,
  state: SellingLegalEntityVatRegistrationStateContractSchema,
});

/** Explainable evidence of one evaluation: times, attempts and the TAX own state tokens it rests on (#942 F16). */
export const TaxEvaluationEvidenceSchema = Schema.Struct({
  attempts: AttemptSchema,
  discarded: Schema.Array(
    Schema.Struct({ attempt: AttemptSchema, discardedBecause: TaxEvaluationDiscardReasonSchema }),
  ),
  exhausted: Schema.optionalKey(Schema.Literal('EVALUATION_RACE_UNRESOLVED')),
  foreignEvidenceOrigin: TaxForeignEvidenceOriginSchema,
  ruleSets: Schema.Array(RuleSetEvidenceSchema),
  sellerRegistration: SellerRegistrationEvidenceSchema,
  taxEvaluationTime: TaxEvaluationTimeSchema,
  taxRelevantTime: TaxRelevantTimeSchema,
});

/**
 * Prospective evaluation response: a Tax Outcome with its customer-safe projection and evidence, or a request
 * rejection that is not a Tax Outcome. Nothing is persisted; a prospective result is never final Order Tax (#941 F6).
 */
export const TaxEvaluationResponseContractSchema = Schema.Union([
  Schema.TaggedStruct('EVALUATED', {
    customerSafe: CustomerSafeTaxProjectionSchema,
    evidence: TaxEvaluationEvidenceSchema,
    outcome: TaxOutcomeSchema,
  }),
  Schema.TaggedStruct('TAX_EVALUATION_REQUEST_REJECTED', {
    reasons: Schema.NonEmptyArray(TaxEvaluationRequestRejectionReasonSchema),
  }),
]);

/** Exact old and new Tax meanings of one purchase/use; no Bundle, Attempt or approval identity (#943 F11-F13). */
export const TaxMaterialityComparisonRequestContractSchema = Schema.Struct({
  current: TaxOutcomeSchema,
  declaredUse: TaxMaterialityDeclaredUseSchema,
  previous: TaxOutcomeSchema,
});

/** TAX-owned materiality conclusion (#943 F1-F10). */
export const TaxMaterialityComparisonResponseContractSchema = TaxMaterialityConclusionSchema;
