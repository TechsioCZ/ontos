/*
 * Wire contracts of the Tax correction preview: the published schemas of Accepted Tax Terms, the Billing-owned
 * Accepted Cumulative Correction State, the Tax Correction Delta and the declared-purpose outcomes. They are
 * schema-only (shared/domain/tax-kernel); TAX's calculation stays owner-local in src/domain (ADR-0016).
 */
export {
  DeclaredTaxPurposeOutcomeSchema as TaxCorrectionPreviewResponseContractSchema,
  DeclaredTaxPurposeRequestSchema as TaxCorrectionPreviewRequestContractSchema,
} from './tax-kernel/tax-declared-purpose.ts';
