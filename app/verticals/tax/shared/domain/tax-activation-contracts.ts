import { Schema } from 'effect';

import {
  SellerVatRegimeAtInstantSelectionSchema,
  SellerVatRegimeHistoryResponseContractSchema,
} from './seller-vat-regime-contracts.ts';
import { distinctBy } from './tax-kernel/tax-domain-primitives.ts';

const InstantSchema = Schema.DateTimeUtcFromString;
const ReferenceSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

/**
 * The closed #964 activation item catalogue, as patched by OWNERSHIP-FINAL §7 (#961/#964) and LEGAL-FINAL §7. There
 * is no seller-authority, VIES, ARES, assertion or seller-route item: Launch has no external seller route.
 */
export const TaxActivationItemIdSchema = Schema.Literals([
  'SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION',
  'BILLING_PAYER_DIC_GATE',
  'BILLING_ISSUANCE_GUARD',
  'CATALOG_TAX_PURPOSE_CONTRACT',
  'B2C_GROSS_AMOUNT_BASIS_CONTRACT',
  'D3_CONTRACT_TEXTS_RECONCILED',
  'Q5_LAUNCH_FLOWS_DECIDED',
  'PARTIAL_CREDIT_RULE_APPROVED',
  'LEGAL_L1A',
  'LEGAL_L1B',
  'LEGAL_L2',
  'LEGAL_D3A',
  'LEGAL_L3A',
  'LEGAL_L3B',
  'LEGAL_Q5A',
  'LEGAL_Q5B',
  'LEGAL_Q5C',
  'LEGAL_Q5D',
  'LEGAL_L4',
  'LEGAL_L5',
  'OWNER_ACCEPTANCE_961',
  'OWNER_ACCEPTANCE_962',
  'OWNER_ACCEPTANCE_963',
  'PRODUCTION_SCOPE_INVENTORY',
  'TAX_RULE_COVERAGE',
  'REQUIRED_SOURCE_ROUTES',
  'PERMISSIONS_AND_AUDIT',
  'MUTATION_RECOVERY',
  'PRIVACY_OWNER_INVENTORY',
  'MIGRATION_RECONCILIATION',
  'UNSUPPORTED_CASES_FAIL_CLOSED',
  'OPERATIONAL_SIGNALS',
  'OPERATIONAL_RUNBOOK',
  'DEACTIVATION_PLAN',
]);
export type TaxActivationItemId = typeof TaxActivationItemIdSchema.Type;

/** Whether an item is resolved once for the activation, per activated seller, or per seller that is a VAT payer. */
export const TaxActivationItemScopeSchema = Schema.Literals(['ACTIVATION', 'PER_SELLER', 'PER_PAYER_SELLER']);
export type TaxActivationItemScope = typeof TaxActivationItemScopeSchema.Type;

/** Who must resolve an item. Only TAX items are TAX's to close; every other owner's item stays open until it is. */
export const TaxActivationItemOwnerSchema = Schema.Literals([
  'TAX',
  'TAX_OPERATIONS',
  'BILLING',
  'CATALOG',
  'PRICING_DELIVERY',
  'PRIVACY',
  'PO',
  'LEGAL',
]);
export type TaxActivationItemOwner = typeof TaxActivationItemOwnerSchema.Type;

/** The exact production scope evaluated: one Tenant, the Selling Legal Entities to activate, and the instant. */
export const TaxActivationScopeSchema = Schema.Struct({
  activationAt: InstantSchema,
  sellingLegalEntityRefs: Schema.NonEmptyArray(ReferenceSchema).check(
    distinctBy((ref: string) => ref, 'Each Selling Legal Entity is named once'),
  ),
  tenantRef: ReferenceSchema,
});

/** An item closed by outside evidence: the reference names that evidence; TAX never fabricates it. */
export const TaxActivationResolutionSchema = Schema.Struct({
  evidenceRef: ReferenceSchema,
  itemId: TaxActivationItemIdSchema,
  sellingLegalEntityRef: Schema.optionalKey(ReferenceSchema),
});
export type TaxActivationResolution = typeof TaxActivationResolutionSchema.Type;

/**
 * Activation readiness input (#964). Each seller's declaration timeline is the public Seller VAT Regime history read;
 * every other item is a resolution naming its evidence. A missing declaration entry is never a default.
 */
export const TaxActivationEvidenceSchema = Schema.Struct({
  resolvedItems: Schema.Array(TaxActivationResolutionSchema).check(
    distinctBy(
      ({ itemId, sellingLegalEntityRef }: TaxActivationResolution) => `${itemId}\u0000${sellingLegalEntityRef ?? ''}`,
      'Each item is resolved once per seller',
    ),
  ),
  scope: TaxActivationScopeSchema,
  sellerDeclarations: Schema.Array(
    Schema.Struct({
      history: SellerVatRegimeHistoryResponseContractSchema,
      sellingLegalEntityRef: ReferenceSchema,
    }),
  ).check(
    distinctBy(
      ({ sellingLegalEntityRef }: { readonly sellingLegalEntityRef: string }) => sellingLegalEntityRef,
      'Each seller has one declaration history',
    ),
  ),
});
export type TaxActivationEvidence = typeof TaxActivationEvidenceSchema.Type;

/** One open item, for the activation or for one seller. */
export const TaxActivationBlockerSchema = Schema.Struct({
  itemId: TaxActivationItemIdSchema,
  sellingLegalEntityRef: Schema.optionalKey(ReferenceSchema),
});
export type TaxActivationBlocker = typeof TaxActivationBlockerSchema.Type;

export const TaxActivationReadySchema = Schema.TaggedStruct('READY', {});
export const TaxActivationNotReadySchema = Schema.TaggedStruct('NOT_READY', {
  blockers: Schema.NonEmptyArray(TaxActivationBlockerSchema),
});

/**
 * TAX owner activation readiness of one exact scope. It is NON_PRODUCTION evidence and never an activation: `READY`
 * means only that no item is open; it is not production activation (#964 A) and not e-shop readiness (#964 BDD
 * "TAX is owner ready while full Commerce acceptance remains parked").
 */
export const TaxActivationReadinessSchema = Schema.Struct({
  activationClaim: Schema.Literal('NONE'),
  commerceReadinessClaim: Schema.Literal('NONE'),
  evidenceLabel: Schema.Literal('NON_PRODUCTION'),
  scope: TaxActivationScopeSchema,
  sellers: Schema.Array(
    Schema.Struct({
      atActivation: SellerVatRegimeAtInstantSelectionSchema,
      payerDicRequired: Schema.Boolean,
      sellingLegalEntityRef: ReferenceSchema,
    }),
  ),
  verdict: Schema.Union([TaxActivationReadySchema, TaxActivationNotReadySchema]),
});
export type TaxActivationReadiness = typeof TaxActivationReadinessSchema.Type;

/** Why a resolution cannot count: it is never matched silently. */
export const TaxActivationEvidenceRejectedSchema = Schema.TaggedStruct('ACTIVATION_EVIDENCE_REJECTED', {
  rejections: Schema.NonEmptyArray(
    Schema.Struct({
      itemId: Schema.optionalKey(TaxActivationItemIdSchema),
      reason: Schema.Literals(['COMPUTED_ITEM', 'SELLER_NOT_ALLOWED', 'SELLER_OUT_OF_SCOPE', 'SELLER_REQUIRED']),
      sellingLegalEntityRef: Schema.optionalKey(ReferenceSchema),
    }),
  ),
});
export type TaxActivationEvidenceRejected = typeof TaxActivationEvidenceRejectedSchema.Type;
