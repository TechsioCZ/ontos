/*
 * Wire contracts of the Tax correction preview. They are the TAX domain schemas themselves (Accepted Tax Terms, the
 * Billing-owned Accepted Cumulative Correction State, the Tax Correction Delta and the declared-purpose outcomes), so
 * the published contract cannot drift from the arithmetic that checks it.
 */
export { AcceptedTaxTermsSchema as AcceptedTaxTermsContractSchema } from '../../src/domain/accepted-tax-terms.ts';
export {
  DeclaredTaxPurposeOutcomeSchema as TaxCorrectionPreviewResponseContractSchema,
  DeclaredTaxPurposeRequestSchema as TaxCorrectionPreviewRequestContractSchema,
} from '../../src/domain/tax-declared-purpose.ts';
