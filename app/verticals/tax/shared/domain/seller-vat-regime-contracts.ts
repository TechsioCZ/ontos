import { Schema } from 'effect';

import { SellerVatRegimeDeclarationRefSchema } from '../resources/seller-vat-regime-declaration.ts';
import {
  SellerVatRegimeDeclarationProvenanceSchema,
  SellerVatRegimeDeclarationRevisionRefSchema,
  SellerVatRegimeEffectiveFromOriginSchema,
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

const SourceReferenceSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed());

/**
 * How one revision was obtained and where its effect comes from (907-Q08/Q09). Provenance is never a trust level and
 * no revision is ever "verified". `MIGRATION_START` is the start of usability in OntOS, not the historical
 * registration date. `migrationRunRef` and `sourceRecordRef` are present exactly on `MIGRATED` revisions.
 */
const DeclarationOriginFields = {
  effectiveFromOrigin: SellerVatRegimeEffectiveFromOriginSchema,
  migrationRunRef: Schema.optionalKey(SourceReferenceSchema),
  provenance: SellerVatRegimeDeclarationProvenanceSchema,
  sourceRecordRef: Schema.optionalKey(SourceReferenceSchema),
};

/** The seller comes from the trusted Operational Scope, never the payload (#950 F24). */
export const SellerVatRegimeHistoryRequestContractSchema = Schema.Struct({});

/**
 * Which VAT changes the reading person may run in this company now, decided by Tax's gate on the very Actions: a
 * screen offers only those. Advisory: each Action decides again when it runs, and a proposal is no permission.
 */
export const VatChangeRightsSchema = Schema.Struct({
  createRevision: Schema.Boolean,
  createRule: Schema.Boolean,
  declareRegime: Schema.Boolean,
  endRevision: Schema.Boolean,
});
export type VatChangeRights = typeof VatChangeRightsSchema.Type;

/** Every declaration revision for the seller, in revision order, with its full attribution (tax.evidence.read). */
export const SellerVatRegimeTimelineContractSchema = Schema.Struct({
  completeness: CompletenessSchema,
  revisions: Schema.Array(
    Schema.Struct({
      declarationRef: SellerVatRegimeDeclarationRefSchema,
      declaredBy: Schema.String.check(Schema.isUUID()),
      effectiveFrom: InstantSchema,
      ...DeclarationOriginFields,
      reason: Schema.OptionFromNullOr(ReasonSchema),
      recordedAt: InstantSchema,
      regime: SellerVatRegimeSchema,
      replacesScheduled: Schema.Boolean,
      revision: RevisionSchema,
    }),
  ),
});
export type SellerVatRegimeTimelineContract = typeof SellerVatRegimeTimelineContractSchema.Type;

/** The timeline, and which VAT changes the reading person may make (the DPH page reads it as that person). */
export const SellerVatRegimeHistoryResponseContractSchema = Schema.Struct({
  ...SellerVatRegimeTimelineContractSchema.fields,
  changeRights: VatChangeRightsSchema,
});
export type SellerVatRegimeHistoryResponseContract = typeof SellerVatRegimeHistoryResponseContractSchema.Type;

export const SellerVatRegimeAtInstantRequestContractSchema = Schema.Struct({ instant: UtcInstantSchema });
export type SellerVatRegimeAtInstantRequestContract = typeof SellerVatRegimeAtInstantRequestContractSchema.Type;

/** The read-side selection: `DECLARED` carries the revision's `effectiveFrom` and origin alongside the regime. */
export const SellerVatRegimeAtInstantSelectionSchema = Schema.Union([
  Schema.TaggedStruct('DECLARED', {
    declarationRevisionRef: SellerVatRegimeDeclarationRevisionRefSchema,
    effectiveFrom: InstantSchema,
    ...DeclarationOriginFields,
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
