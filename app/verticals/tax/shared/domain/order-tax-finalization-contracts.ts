import { Schema } from 'effect';

import { FinalOrderTaxHandoffSchema, OrderSubmissionRefSchema } from '../actions/order-tax-finalization.ts';
import { OrderTaxFinalizationRefSchema } from '../resources/order-tax-finalization.ts';
import { TaxRuleRevisionRefSchema } from '../resources/tax-rule-revision.ts';
import { TaxEvaluationEvidenceSchema } from './tax-evaluation-contracts.ts';
import { CustomerSafeTaxProjectionSchema } from './tax-kernel/customer-safe-tax-projection.ts';
import { TaxRuleRevisionRefSchema as GoverningTaxRuleRevisionRefSchema } from './tax-kernel/tax-decision.ts';

const InstantSchema = Schema.DateTimeUtcFromString;

/** The submission identity; Tenant and Selling Legal Entity come from the trusted Operational Scope (#950 F24). */
export const FinalOrderTaxRequestContractSchema = Schema.Struct({ submissionRef: OrderSubmissionRefSchema });

/**
 * Confirmed correction of a governing revision of the stored Decision, derived at read time. It is evidence for the
 * downstream owner only: the stored final is never refreshed, and no cancellation, resubmission or notification
 * follows from TAX (#930 F11, F13, J1-J7).
 */
const GoverningRevisionCorrectionSchema = Schema.Struct({
  confirmedAt: InstantSchema,
  correctingRevisionRef: TaxRuleRevisionRefSchema,
  governingTaxRuleRevisionRef: GoverningTaxRuleRevisionRefSchema,
  wrongRevisionRef: TaxRuleRevisionRefSchema,
});

/** The durable final Launch Order Tax of one submission, recoverable after a lost response (#944 F10, #941 F9). */
export const FinalOrderTaxResponseContractSchema = Schema.Struct({
  customerSafe: CustomerSafeTaxProjectionSchema,
  evidence: TaxEvaluationEvidenceSchema,
  finalizedAt: InstantSchema,
  finalOrderTaxRef: OrderTaxFinalizationRefSchema,
  governingRevisionCorrections: Schema.Array(GoverningRevisionCorrectionSchema),
  handoff: FinalOrderTaxHandoffSchema,
});
