import { Schema } from 'effect';

import { TaxFactFamilySchema } from '../actions/tax-governance.ts';
import {
  TaxSourceAcceptanceOutcomeSchema,
  TaxSourceAcceptanceReasonSchema,
  TaxSourceAssertionKeySchema,
  TaxSourceAuthorityRoleSchema,
  TaxSourceConflictKindSchema,
  TaxSourceEligibilitySchema,
  TaxSourceRegistrationMeaningSchema,
} from '../actions/tax-source-assertion.ts';
import { TaxFactAuthorityContractRefSchema } from '../resources/tax-fact-authority-contract.ts';
import { TaxSourceAssertionRefSchema } from '../resources/tax-source-assertion.ts';
import { TaxSourceConflictRefSchema } from '../resources/tax-source-conflict.ts';

const InstantSchema = Schema.DateTimeUtcFromString;
const FingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const OwnerReferenceSchema = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const TextSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const RowCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const brandedId = (brand: string) => OwnerReferenceSchema.pipe(Schema.brand(brand), Schema.decodeTo(Schema.String));
const TaxSourceAssertionIdSchema = brandedId('TaxSourceAssertionId');
const TaxFactAuthorityContractRevisionIdSchema = brandedId('TaxFactAuthorityContractRevisionId');
const CompletenessSchema = Schema.Struct({ rowCount: RowCountSchema, setFingerprint: FingerprintSchema });

/** Authority for the fact family at the instant: zero, exactly one, or competing Systems of Record. */
export const TaxFactAuthorityOutcomeSchema = Schema.Literals([
  'AUTHORITY_ESTABLISHED',
  'AUTHORITY_MISSING',
  'AUTHORITY_CONFLICT',
]);
export type TaxFactAuthorityOutcome = typeof TaxFactAuthorityOutcomeSchema.Type;

/** Why the Selling Legal Entity VAT Registration state was derived; `UNAVAILABLE` is never derived here. */
export const TaxSourceRegistrationResolutionReasonSchema = Schema.Literals([
  'AUTHORITATIVE_POSITIVE',
  'AUTHORITATIVE_NEGATIVE',
  'AUTHORITY_MISSING',
  'AUTHORITY_CONFIGURATION_CONFLICT',
  'INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS',
  'VALIDITY_ELAPSED',
  'NO_AUTHORITATIVE_ASSERTION',
  'NO_COVERING_ASSERTION',
]);
export type TaxSourceRegistrationResolutionReason = typeof TaxSourceRegistrationResolutionReasonSchema.Type;

/**
 * The six evaluation states of Selling Legal Entity VAT Registration; the same vocabulary as the TAX domain kernel
 * (#938 F8-F9, #925 F11-F20). The read derives five of them; a consumer maps a failed read to `UNAVAILABLE`.
 */
export const SellingLegalEntityVatRegistrationStateContractSchema = Schema.Literals([
  'CURRENT_POSITIVE',
  'KNOWN_ENDED_OR_NON_REGISTERED',
  'UNKNOWN',
  'UNAVAILABLE',
  'STALE',
  'UNRESOLVED',
]);

/** The Selling Legal Entity comes from the trusted Operational Scope, never the request (#950 F24). */
export const SellingLegalEntityVatRegistrationStateRequestContractSchema = Schema.Struct({
  evaluationTime: InstantSchema,
});

export const SellingLegalEntityVatRegistrationStateResponseContractSchema = Schema.Struct({
  authority: Schema.Struct({
    contractRef: Schema.OptionFromNullOr(TaxFactAuthorityContractRefSchema),
    outcome: TaxFactAuthorityOutcomeSchema,
    systemOfRecordRef: Schema.OptionFromNullOr(OwnerReferenceSchema),
  }),
  /** Assertions of the System of Record covering the evaluation time, whatever their role when recorded. */
  basisAssertionRefs: Schema.Array(TaxSourceAssertionRefSchema),
  /** Complete owner set the state was derived from; partial or empty observations are never absence (#959 F13-F18). */
  completeness: CompletenessSchema,
  evaluationTime: InstantSchema,
  /** Assertions of a source listed as evidence at the evaluation time that contradict the state there. */
  evidenceDisagreementRefs: Schema.Array(TaxSourceAssertionRefSchema),
  factFamily: TaxFactFamilySchema,
  reason: TaxSourceRegistrationResolutionReasonSchema,
  state: SellingLegalEntityVatRegistrationStateContractSchema,
});

/** Safe conflict detail: identities, keys, fingerprints; never provider payload (#950 F49-F54). */
export const TaxSourceConflictDetailSchema = Schema.Struct({
  assertionId: Schema.optionalKey(TaxSourceAssertionIdSchema),
  contractRevisionIds: Schema.optionalKey(Schema.Array(TaxFactAuthorityContractRevisionIdSchema)),
  deliveredFingerprint: Schema.optionalKey(FingerprintSchema),
  sourceAssertionKey: Schema.optionalKey(TaxSourceAssertionKeySchema),
  sourceRef: Schema.optionalKey(OwnerReferenceSchema),
  storedFingerprint: Schema.optionalKey(FingerprintSchema),
});
export type TaxSourceConflictDetail = typeof TaxSourceConflictDetailSchema.Type;

/**
 * Safe provenance of one immutable source assertion; received time is `recordedAt` (#958 F12). `eligibility` is the
 * stored resolution input; `authorityRole` and `authorityContractRevisionId` are the role and revision at recording
 * time, provenance that never decides (#959 F8, F25).
 */
export const TaxSourceAssertionEvidenceSchema = Schema.Struct({
  assertionRef: TaxSourceAssertionRefSchema,
  authorityContractRevisionId: Schema.OptionFromNullOr(TaxFactAuthorityContractRevisionIdSchema),
  authorityRole: TaxSourceAuthorityRoleSchema,
  deliveryRef: Schema.OptionFromNullOr(OwnerReferenceSchema),
  eligibility: TaxSourceEligibilitySchema,
  factFamily: TaxFactFamilySchema,
  issuedAt: Schema.OptionFromNullOr(InstantSchema),
  jurisdiction: Schema.Literal('CZ_DOMESTIC'),
  observedAt: Schema.OptionFromNullOr(InstantSchema),
  provenanceRef: TextSchema,
  reason: TextSchema,
  recordedAt: InstantSchema,
  registrationMeaning: TaxSourceRegistrationMeaningSchema,
  semanticFingerprint: FingerprintSchema,
  sourceAssertionKey: TaxSourceAssertionKeySchema,
  sourceRecordRef: OwnerReferenceSchema,
  sourceRef: OwnerReferenceSchema,
  validFrom: Schema.OptionFromNullOr(InstantSchema),
  validTo: Schema.OptionFromNullOr(InstantSchema),
});

export const TaxSourceConflictDetailRequestContractSchema = Schema.Struct({ conflictRef: TaxSourceConflictRefSchema });

export const TaxSourceConflictDetailResponseContractSchema = Schema.Struct({
  conflictKind: TaxSourceConflictKindSchema,
  conflictRef: TaxSourceConflictRefSchema,
  detail: TaxSourceConflictDetailSchema,
  detectedAt: InstantSchema,
  factFamily: TaxFactFamilySchema,
  provenanceRef: TextSchema,
  reason: TextSchema,
  relatedAssertion: Schema.OptionFromNullOr(TaxSourceAssertionEvidenceSchema),
  status: Schema.Literal('OPEN'),
  subjectAssertion: Schema.OptionFromNullOr(TaxSourceAssertionEvidenceSchema),
});

export const TaxSourceAssertionHistoryRequestContractSchema = Schema.Struct({ factFamily: TaxFactFamilySchema });

/**
 * One history entry: the stored evidence plus its #957 acceptance, evaluated at read time over the assertion's
 * claimed validity under the current Tax Fact Authority Contract revisions (#957 H, F12, #959 F25).
 */
export const TaxSourceAssertionHistoryEntrySchema = Schema.Struct({
  ...TaxSourceAssertionEvidenceSchema.fields,
  acceptanceOutcome: TaxSourceAcceptanceOutcomeSchema,
  acceptanceReason: TaxSourceAcceptanceReasonSchema,
});

/** Every assertion of the seller and fact family, including non-accepted ones, ordered by identity, never by arrival. */
export const TaxSourceAssertionHistoryResponseContractSchema = Schema.Struct({
  assertions: Schema.Array(TaxSourceAssertionHistoryEntrySchema),
  completeness: CompletenessSchema,
  factFamily: TaxFactFamilySchema,
});
