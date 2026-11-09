import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Schema } from 'effect';

import { PaymentExecutionBindingSchema, PaymentGatewayAccountBindingSchema } from './payment-execution-binding.ts';
import {
  PaymentDeliveryOfferRefSchema,
  PaymentEvidenceRefSchema,
  PaymentPickupCapabilityRefSchema,
  PaymentRevisionSchema,
} from './payment-identifiers.ts';
import { PaymentMethodSchema } from './payment-vocabulary.ts';
import type { PaymentApplicabilityOutcome } from './payment-vocabulary.ts';

/**
 * Public applicability contract (#1147). One evaluation covers the exact method branches the caller
 * asks about; each branch is decided only on its own required evidence (H1094-01=A) and nothing is
 * ever selected for the customer.
 */

/**
 * The exact method-specific selection of one branch. A missing selection is representable on purpose:
 * it yields `MISSING_REQUIRED_INPUT` instead of a fallback (row order or a provider label never selects).
 */
export const PaymentOnlineGatewaySelectionSchema = Schema.Struct({
  method: Schema.Literal('ONLINE_GATEWAY'),
  selectedBinding: Schema.optionalKey(PaymentGatewayAccountBindingSchema),
});
export const PaymentBankTransferAdvanceSelectionSchema = Schema.Struct({
  method: Schema.Literal('BANK_TRANSFER_ADVANCE'),
});
export const PaymentCashOnDeliverySelectionSchema = Schema.Struct({
  deliveryOfferRef: Schema.optionalKey(PaymentDeliveryOfferRefSchema),
  method: Schema.Literal('CASH_ON_DELIVERY'),
});
export const PaymentDeferredInvoiceSelectionSchema = Schema.Struct({
  method: Schema.Literal('DEFERRED_INVOICE'),
});
export const PaymentPickupOrOnSiteSelectionSchema = Schema.Struct({
  method: Schema.Literal('PAY_ON_PICKUP_OR_ON_SITE'),
  pickupCapabilityRef: Schema.optionalKey(PaymentPickupCapabilityRefSchema),
});
export const PaymentMethodBranchSelectionSchema = Schema.Union([
  PaymentOnlineGatewaySelectionSchema,
  PaymentBankTransferAdvanceSelectionSchema,
  PaymentCashOnDeliverySelectionSchema,
  PaymentDeferredInvoiceSelectionSchema,
  PaymentPickupOrOnSiteSelectionSchema,
]);
export type PaymentMethodBranchSelection = typeof PaymentMethodBranchSelectionSchema.Type;

const distinctMethods = Schema.makeFilter((selections: readonly PaymentMethodBranchSelection[]) =>
  new Set(selections.map((selection) => selection.method)).size === selections.length
    ? undefined
    : 'Each Payment Method branch may be evaluated once',
);

/** One to five distinct method branches, evaluated and answered in request order. */
export const PaymentMethodBranchSelectionsSchema = Schema.NonEmptyArray(PaymentMethodBranchSelectionSchema).check(
  Schema.isMaxLength(5),
  distinctMethods,
);

/** Which required fact a finding is about. */
export const PAYMENT_APPLICABILITY_CHECKS = [
  'METHOD_SELECTION',
  'METHOD_ENABLEMENT',
  'PAYMENT_TERM',
  'GATEWAY_BINDING',
  'DELIVERY_CAPABILITY',
  'PICKUP_CAPABILITY',
] as const;
export const PaymentApplicabilityCheckSchema = Schema.Literals(PAYMENT_APPLICABILITY_CHECKS);
export type PaymentApplicabilityCheck = typeof PaymentApplicabilityCheckSchema.Type;

/**
 * Why a check did not pass. Owner reasons are carried verbatim from the owner public contracts;
 * `EVIDENCE_UNAVAILABLE` is an outage of required evidence, never absence or a negative fact.
 */
export const PAYMENT_APPLICABILITY_REASONS = [
  'SELECTION_MISSING',
  'NOT_CONFIGURED',
  'DISABLED',
  'DUPLICATE_CONFIGURATION',
  'EVIDENCE_UNAVAILABLE',
  'EVIDENCE_SUBJECT_MISMATCH',
  'FOREIGN_TERM_REFERENCE',
  'TERM_NOT_DEFERRABLE',
  'TERM_NOT_FOUND',
  'TERM_RETIRED',
  'TERM_SEMANTICS_INCOMPATIBLE',
  'ENTITLEMENT_NOT_CURRENT',
  'POLICY_DENIED',
  'BINDING_NOT_ENABLED',
  'OFFER_NOT_CURRENT',
  'OFFER_NOT_COD_CAPABLE',
  'AMOUNT_OUTSIDE_COD_CONSTRAINTS',
  'CAPABILITY_NOT_CURRENT',
  'COLLECTION_NOT_SUPPORTED',
  'AMOUNT_OUTSIDE_COLLECTION_CONSTRAINTS',
] as const;
export const PaymentApplicabilityReasonSchema = Schema.Literals(PAYMENT_APPLICABILITY_REASONS);
export type PaymentApplicabilityReason = typeof PaymentApplicabilityReasonSchema.Type;

/** Non-available outcomes; every one carries the findings that produced it. */
export const PAYMENT_NOT_AVAILABLE_OUTCOMES = [
  'NOT_ENABLED',
  'INCOMPATIBLE_TERM',
  'UNSUPPORTED_CAPABILITY',
  'MISSING_REQUIRED_INPUT',
  'UNAVAILABLE_TO_VERIFY',
  'CONFLICTING_CONFIGURATION',
] as const satisfies readonly Exclude<PaymentApplicabilityOutcome, 'AVAILABLE'>[];
export const PaymentNotAvailableApplicabilityOutcomeSchema = Schema.Literals(PAYMENT_NOT_AVAILABLE_OUTCOMES);
export type PaymentNotAvailableApplicabilityOutcome = typeof PaymentNotAvailableApplicabilityOutcomeSchema.Type;

export const PaymentApplicabilityFindingSchema = Schema.Struct({
  check: PaymentApplicabilityCheckSchema,
  outcome: PaymentNotAvailableApplicabilityOutcomeSchema,
  reason: PaymentApplicabilityReasonSchema,
});
export type PaymentApplicabilityFinding = typeof PaymentApplicabilityFindingSchema.Type;

/**
 * The exact owner term evidence an AVAILABLE branch was decided on. The resolved `PaymentTermRef` is
 * returned unchanged (method choice never replaces it); no invoice issue or due DATE exists here.
 */
export const PaymentApplicabilityTermEvidenceSchema = Schema.Struct({
  entitlementEvidenceRef: PaymentEvidenceRefSchema,
  paymentTermRef: PaymentTermRefSchema,
  semanticSnapshot: PaymentTermDefinitionSnapshotSchema,
});
export type PaymentApplicabilityTermEvidence = typeof PaymentApplicabilityTermEvidenceSchema.Type;

export const PaymentAvailableBranchSchema = Schema.Struct({
  enablementRevision: PaymentRevisionSchema,
  executionBinding: PaymentExecutionBindingSchema,
  method: PaymentMethodSchema,
  outcome: Schema.Literal('AVAILABLE'),
  term: PaymentApplicabilityTermEvidenceSchema,
});
export type PaymentAvailableBranch = typeof PaymentAvailableBranchSchema.Type;

export const PaymentNotAvailableBranchSchema = Schema.Struct({
  findings: Schema.NonEmptyArray(PaymentApplicabilityFindingSchema),
  method: PaymentMethodSchema,
  outcome: PaymentNotAvailableApplicabilityOutcomeSchema,
});
export type PaymentNotAvailableBranch = typeof PaymentNotAvailableBranchSchema.Type;

/** One typed outcome per evaluated branch (#1147 "Typed outcomes remain"). */
export const PaymentMethodBranchApplicabilitySchema = Schema.Union([
  PaymentAvailableBranchSchema,
  PaymentNotAvailableBranchSchema,
]);
export type PaymentMethodBranchApplicability = typeof PaymentMethodBranchApplicabilitySchema.Type;

/** Current merchant enablement of one method for one Customer Configuration in the Selling Legal Entity. */
export const PaymentMethodEnablementStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  method: PaymentMethodSchema,
  revision: PaymentRevisionSchema,
});
export type PaymentMethodEnablementState = typeof PaymentMethodEnablementStateSchema.Type;
