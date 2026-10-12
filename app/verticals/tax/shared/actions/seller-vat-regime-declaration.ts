import { Schema } from 'effect';

import { SellerVatRegimeDeclarationRefSchema } from '../resources/seller-vat-regime-declaration.ts';
import {
  SellerVatRegimeEffectiveFromOriginSchema,
  SellerVatRegimeSchema,
} from '../domain/tax-kernel/seller-vat-regime.ts';
import { RevisionSchema } from '../domain/tax-kernel/tax-domain-primitives.ts';

const InstantSchema = Schema.DateTimeUtcFromString;
const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
/** `0` means "nothing declared yet" (F6). */
const ExpectedCurrentRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Merchant-declared Seller VAT Regime for the Selling Legal Entity in scope; never verified (OWNERSHIP §2, LEGAL
 * §1). `expectedCurrentRevision` is the optimistic-concurrency basis (CAS); `confirmReplacesScheduled` must be
 * `true` to accept a declaration that would silently replace an already-live later revision (F5-F6).
 */
export const DeclareSellerVatRegimePayloadSchema = Schema.Struct({
  confirmReplacesScheduled: Schema.optionalKey(Schema.Boolean),
  effectiveFrom: InstantSchema,
  expectedCurrentRevision: ExpectedCurrentRevisionSchema,
  reason: Schema.optionalKey(ReasonSchema),
  regime: SellerVatRegimeSchema,
});
export type DeclareSellerVatRegimePayload = typeof DeclareSellerVatRegimePayloadSchema.Type;

const RevisionRefSchema = Schema.Struct({
  declarationRef: SellerVatRegimeDeclarationRefSchema,
  revision: RevisionSchema,
});

/**
 * `DECLARED` is the stored (or recovered, idempotent-replay) revision. `DECLARATION_REJECTED` is a typed result
 * with nothing stored: either the CAS basis is stale (surfaced instead as `TaxGovernanceStaleBasis`, see F6) or the
 * declaration needs a reason (backdated effect) or confirmation (a live later/scheduled revision exists).
 */
export const DeclareSellerVatRegimeResultSchema = Schema.Union([
  Schema.TaggedStruct('DECLARED', {
    created: Schema.Boolean,
    declarationRef: SellerVatRegimeDeclarationRefSchema,
    replacedScheduledRevisions: Schema.Array(RevisionRefSchema),
    revision: RevisionSchema,
  }),
  Schema.TaggedStruct('DECLARATION_REJECTED', {
    reason: Schema.Literals(['REASON_REQUIRED_FOR_BACKDATED_EFFECT', 'SCHEDULED_REVISION_CONFIRMATION_REQUIRED']),
    scheduledRevisions: Schema.Array(RevisionRefSchema),
  }),
]);
export type DeclareSellerVatRegimeResult = typeof DeclareSellerVatRegimeResultSchema.Type;

/**
 * Strict legacy-content shape for one migrated Seller VAT Regime Declaration fact (#907 Unit 10 D2). Lives in
 * `shared/` so step-9's migration domain (`src/domain`) and the import Action share one canonical decode; `shared/`
 * itself never imports `src/`. Unknown legacy keys fail the strict decode and stay REVIEW_REQUIRED; `regime` is
 * required, so a missing regime is INCOMPLETE rather than silently mapped. `effectiveFrom` is optional: a source
 * holding only the current declared state has no date, and its effect starts at the migration instant (907-Q08).
 */
export const SellerVatRegimeDeclarationMigrationContentSchema = Schema.Struct({
  effectiveFrom: Schema.optionalKey(InstantSchema),
  reason: Schema.optionalKey(ReasonSchema),
  regime: SellerVatRegimeSchema,
});

/** An importer-supplied identifier: of the migration run, or of one source record. */
const SourceReferenceSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed());

/**
 * One existing declaration of the seller in the source system, as the importer maps it (907-Q08). `effectiveFrom`
 * absent means "current-only": the source has no date for it.
 */
export const SellerVatRegimeImportEntrySchema = Schema.Struct({
  ...SellerVatRegimeDeclarationMigrationContentSchema.fields,
  sourceRecordRef: SourceReferenceSchema,
});
export type SellerVatRegimeImportEntry = typeof SellerVatRegimeImportEntrySchema.Type;

/**
 * Imports the Selling Legal Entity's existing declared regime from the source system, without a new merchant
 * confirmation or any external verification (907-Q08). Entries keep their source `effectiveFrom`, past or
 * scheduled. A single current-only entry takes effect at `migrationStartedAt`, the run's stable migration instant,
 * so a retry never shifts it. One call per Selling Legal Entity in scope.
 */
export const ImportSellerVatRegimeDeclarationsPayloadSchema = Schema.Struct({
  declarations: Schema.NonEmptyArray(SellerVatRegimeImportEntrySchema),
  migrationRunRef: SourceReferenceSchema,
  migrationStartedAt: InstantSchema,
});
export type ImportSellerVatRegimeDeclarationsPayload = typeof ImportSellerVatRegimeDeclarationsPayloadSchema.Type;

/**
 * `IMPORTED` lists the seller's imported revisions in revision order; `created: false` is an exact replay of the
 * same run, with no new row and the same start. `IMPORT_REJECTED` stores nothing:
 * - `AMBIGUOUS_SOURCE_HISTORY`: duplicate `effectiveFrom` or `sourceRecordRef`, or a current-only entry mixed with
 *   other entries;
 * - `MIGRATION_RUN_CONFLICT`: the same run already imported different content for the seller;
 * - `SELLER_ALREADY_DECLARED`: the seller already has another revision; later changes use the declare Action.
 */
export const ImportSellerVatRegimeDeclarationsResultSchema = Schema.Union([
  Schema.TaggedStruct('IMPORTED', {
    created: Schema.Boolean,
    revisions: Schema.NonEmptyArray(
      Schema.Struct({
        declarationRef: SellerVatRegimeDeclarationRefSchema,
        effectiveFrom: InstantSchema,
        effectiveFromOrigin: SellerVatRegimeEffectiveFromOriginSchema,
        revision: RevisionSchema,
        sourceRecordRef: SourceReferenceSchema,
      }),
    ),
  }),
  Schema.TaggedStruct('IMPORT_REJECTED', {
    reason: Schema.Literals(['AMBIGUOUS_SOURCE_HISTORY', 'MIGRATION_RUN_CONFLICT', 'SELLER_ALREADY_DECLARED']),
  }),
]);
export type ImportSellerVatRegimeDeclarationsResult = typeof ImportSellerVatRegimeDeclarationsResultSchema.Type;
