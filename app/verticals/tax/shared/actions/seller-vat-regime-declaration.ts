import { Schema } from 'effect';

import { SellerVatRegimeDeclarationRefSchema } from '../resources/seller-vat-regime-declaration.ts';
import { SellerVatRegimeSchema } from '../domain/tax-kernel/seller-vat-regime.ts';
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
 * `shared/` so step-9's migration domain (`src/domain`) and any future caller share one canonical decode; `shared/`
 * itself never imports `src/`. Unknown legacy keys fail the strict decode and stay REVIEW_REQUIRED; `regime` is
 * required, so a missing regime is INCOMPLETE rather than silently mapped.
 */
export const SellerVatRegimeDeclarationMigrationContentSchema = Schema.Struct({
  effectiveFrom: InstantSchema,
  reason: Schema.optionalKey(ReasonSchema),
  regime: SellerVatRegimeSchema,
});
export type SellerVatRegimeDeclarationMigrationContent = typeof SellerVatRegimeDeclarationMigrationContentSchema.Type;
