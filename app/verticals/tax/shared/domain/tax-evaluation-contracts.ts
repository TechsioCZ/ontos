import { Schema } from 'effect';

import { CustomerSafeTaxProjectionSchema } from '../../src/domain/customer-safe-tax-projection.ts';
import { TaxEvaluationDiscardReasonSchema } from '../../src/domain/tax-evaluation-attempt.ts';
import { TaxEvaluationRequestRejectionReasonSchema } from '../../src/domain/tax-evaluation-request.ts';
import { TaxMaterialityDeclaredUseSchema } from '../../src/domain/tax-materiality.ts';
import { TaxOutcomeSchema } from '../../src/domain/tax-outcome.ts';
import { TaxEvaluationTimeSchema, TaxRelevantTimeSchema } from '../../src/domain/tax-time.ts';
import { TaxSourceAssertionRefSchema } from '../resources/tax-source-assertion.ts';
import { ApplicableTaxRuleSetResponseContractSchema } from './tax-governed-read-contracts.ts';
import {
  SellingLegalEntityVatRegistrationStateContractSchema,
  TaxFactAuthorityOutcomeSchema,
  TaxSourceRegistrationResolutionReasonSchema,
} from './tax-source-read-contracts.ts';

const FingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const RowCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const AttemptSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * Where the Pricing, Catalog, Shipping and place facts of an evaluation came from. Until #892 TAX cannot fetch them
 * from their owners, so they are owner-issued evidence supplied by the server-side caller and checked only for
 * permission and structural binding (human decision A on #907, step 5).
 */
export const TaxForeignEvidenceOriginSchema = Schema.Literal('CALLER_SUPPLIED_UNVERIFIED');

export { TaxEvaluationRequestSchema as TaxEvaluationRequestContractSchema } from '../../src/domain/tax-evaluation-request.ts';

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
export { TaxMaterialityConclusionSchema as TaxMaterialityComparisonResponseContractSchema } from '../../src/domain/tax-materiality.ts';
