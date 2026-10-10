import { Schema } from 'effect';

import { SellerVatRegimeDeclarationRefSchema } from '../resources/seller-vat-regime-declaration.ts';
import {
  SellerVatRegimeDeclarationProvenanceSchema,
  SellerVatRegimeDeclarationRevisionRefSchema,
  SellerVatRegimeSchema,
} from './tax-kernel/seller-vat-regime.ts';
import { RevisionSchema } from './tax-kernel/tax-domain-primitives.ts';
import { UtcInstantSchema } from './tax-kernel/tax-time.ts';

const InstantSchema = Schema.DateTimeUtcFromString;
const FingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const RowCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const HeadRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A completeness token over the whole declaration timeline, never a single "current" row (#929 F17 precedent). */
const CompletenessSchema = Schema.Struct({ rowCount: RowCountSchema, setFingerprint: FingerprintSchema });

/** The seller comes from the trusted Operational Scope, never the payload (#950 F24). */
export const SellerVatRegimeHistoryRequestContractSchema = Schema.Struct({});

/** Every declaration revision for the seller, in revision order, with its full attribution (tax.evidence.read). */
export const SellerVatRegimeHistoryResponseContractSchema = Schema.Struct({
  completeness: CompletenessSchema,
  revisions: Schema.Array(
    Schema.Struct({
      declarationRef: SellerVatRegimeDeclarationRefSchema,
      declaredBy: Schema.String.check(Schema.isUUID()),
      effectiveFrom: InstantSchema,
      provenance: SellerVatRegimeDeclarationProvenanceSchema,
      reason: Schema.OptionFromNullOr(ReasonSchema),
      recordedAt: InstantSchema,
      regime: SellerVatRegimeSchema,
      replacesScheduled: Schema.Boolean,
      revision: RevisionSchema,
    }),
  ),
});
export type SellerVatRegimeHistoryResponseContract = typeof SellerVatRegimeHistoryResponseContractSchema.Type;

export const SellerVatRegimeAtInstantRequestContractSchema = Schema.Struct({ instant: UtcInstantSchema });
export type SellerVatRegimeAtInstantRequestContract = typeof SellerVatRegimeAtInstantRequestContractSchema.Type;

/** The read-side selection: `DECLARED` carries the revision's `effectiveFrom` and `provenance` alongside the regime. */
export const SellerVatRegimeAtInstantSelectionSchema = Schema.Union([
  Schema.TaggedStruct('DECLARED', {
    declarationRevisionRef: SellerVatRegimeDeclarationRevisionRefSchema,
    effectiveFrom: InstantSchema,
    provenance: SellerVatRegimeDeclarationProvenanceSchema,
    regime: SellerVatRegimeSchema,
  }),
  Schema.TaggedStruct('NOT_DECLARED', {}),
]);
export type SellerVatRegimeAtInstantSelection = typeof SellerVatRegimeAtInstantSelectionSchema.Type;

/** The timeline rule's answer at one instant (`tax.governed.read`); `headRevision` is 0 when nothing is declared. */
export const SellerVatRegimeAtInstantResponseContractSchema = Schema.Struct({
  completeness: CompletenessSchema,
  headRevision: HeadRevisionSchema,
  instant: InstantSchema,
  selection: SellerVatRegimeAtInstantSelectionSchema,
});
export type SellerVatRegimeAtInstantResponseContract = typeof SellerVatRegimeAtInstantResponseContractSchema.Type;
