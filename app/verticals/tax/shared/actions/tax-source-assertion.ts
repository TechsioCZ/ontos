import { DateTime, Schema } from 'effect';

import { TaxSourceAssertionRefSchema } from '../resources/tax-source-assertion.ts';
import { TaxSourceConflictRefSchema } from '../resources/tax-source-conflict.ts';
import { TaxFactFamilySchema } from './tax-governance.ts';

const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ProvenanceRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const InstantSchema = Schema.DateTimeUtcFromString;
/** Provider/system identity in the same vocabulary as authority `systemOfRecordRef` and `evidenceSourceRefs`. */
const OwnerReferenceSchema = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
/** Immutable assertion identity issued by the source; distinct from record correlation and fact identity (#958 F1-F8). */
export const TaxSourceAssertionKeySchema = OwnerReferenceSchema.pipe(
  Schema.brand('TaxSourceAssertionKey'),
  Schema.decodeTo(Schema.String),
);

/**
 * Value meaning asserted by the source. `ENDED` and `NON_REGISTERED` are both negative, but the source wording is
 * kept so the evidence stays explainable (#958 F25).
 */
export const TaxSourceRegistrationMeaningSchema = Schema.Literals(['REGISTERED', 'ENDED', 'NON_REGISTERED']);
export type TaxSourceRegistrationMeaning = typeof TaxSourceRegistrationMeaningSchema.Type;

/**
 * Stored eligibility of one assertion, decided once at recording from checks that hold at every instant. The payload
 * schema already fixes the exact subject and scope, so the only ineligibility left is a missing declared business
 * validity: it is never derived from source times (#957 F21, #958 F14-F16, F26). Eligibility is the resolution input,
 * not the #957 acceptance outcome.
 */
export const TaxSourceEligibilitySchema = Schema.Literals(['ELIGIBLE', 'VALIDITY_UNKNOWN']);
export type TaxSourceEligibility = typeof TaxSourceEligibilitySchema.Type;

/**
 * Typed #957 source acceptance outcome; non-accepted outcomes are results, never errors (#957 F25-F29). It is never
 * stored: it is evaluated over the assertion's own claimed business validity under the current Tax Fact Authority
 * Contract revisions, judging the source's role per business instant (#957 H, F12, #959 F8, F25).
 */
export const TaxSourceAcceptanceOutcomeSchema = Schema.Literals([
  'ACCEPTED',
  'REJECTED',
  'NEEDS_REVIEW',
  'UNVERIFIABLE',
]);
export type TaxSourceAcceptanceOutcome = typeof TaxSourceAcceptanceOutcomeSchema.Type;

/**
 * Stable reason paired with the acceptance outcome: `ACCEPTED`; `REJECTED` with `SOURCE_NOT_PERMITTED` or
 * `ASSERTION_IDENTITY_CONFLICT`; `NEEDS_REVIEW` with `AUTHORITY_CONFIGURATION_CONFLICT`; `UNVERIFIABLE` with
 * `AUTHORITY_MISSING` or `VALIDITY_UNKNOWN`.
 */
export const TaxSourceAcceptanceReasonSchema = Schema.Literals([
  'ACCEPTED',
  'SOURCE_NOT_PERMITTED',
  'ASSERTION_IDENTITY_CONFLICT',
  'AUTHORITY_CONFIGURATION_CONFLICT',
  'AUTHORITY_MISSING',
  'VALIDITY_UNKNOWN',
]);
export type TaxSourceAcceptanceReason = typeof TaxSourceAcceptanceReasonSchema.Type;

/**
 * Role of a source under one authority contract revision (#957 F12-F13). Stored on an assertion it is recording-time
 * provenance only: resolution re-derives the role from the revision covering each evaluated instant (#959 F8, F25).
 */
export const TaxSourceAuthorityRoleSchema = Schema.Literals(['SYSTEM_OF_RECORD', 'EVIDENCE', 'NONE']);
export type TaxSourceAuthorityRole = typeof TaxSourceAuthorityRoleSchema.Type;

/** Conflicts detected while recording; they stay `OPEN` until a later governed resolution. */
export const TaxSourceConflictKindSchema = Schema.Literals([
  'ASSERTION_INTEGRITY',
  'EVIDENCE_DISAGREEMENT',
  'INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS',
  'AUTHORITY_CONFIGURATION',
]);
export type TaxSourceConflictKind = typeof TaxSourceConflictKindSchema.Type;

/**
 * One immutable source assertion about the Selling Legal Entity VAT Registration of the trusted seller scope.
 * Source Record Reference, assertion key and provider identity are three distinct identities (#958 F1-F8). Every
 * source time is optional and never derived from another timestamp (#958 F12-F16, F26); validity is the declared
 * business period `[validFrom, validTo)`.
 */
export const RecordTaxSourceAssertionPayloadSchema = Schema.Struct({
  deliveryRef: Schema.optionalKey(OwnerReferenceSchema),
  factFamily: TaxFactFamilySchema,
  issuedAt: Schema.optionalKey(InstantSchema),
  jurisdiction: Schema.Literal('CZ_DOMESTIC'),
  observedAt: Schema.optionalKey(InstantSchema),
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  registrationMeaning: TaxSourceRegistrationMeaningSchema,
  sourceAssertionKey: TaxSourceAssertionKeySchema,
  sourceRecordRef: OwnerReferenceSchema,
  sourceRef: OwnerReferenceSchema,
  validFrom: Schema.optionalKey(InstantSchema),
  validTo: Schema.optionalKey(InstantSchema),
}).check(
  Schema.makeFilter(
    ({ validFrom, validTo }) =>
      validFrom === undefined ||
      validTo === undefined ||
      DateTime.isLessThan(validFrom, validTo) ||
      'A source assertion validity period must end after it starts',
  ),
);
export type RecordTaxSourceAssertionPayload = typeof RecordTaxSourceAssertionPayloadSchema.Type;

/**
 * `created` is true only when this invocation recorded new durable evidence (an assertion or an integrity
 * conflict). Every replay echoes the stored eligibility, recording-time role and first conflict with
 * `created: false` (#959 F4-F5), while the acceptance is evaluated afresh against the current authority contract
 * revisions: a changed authoritative state is a new evaluation, never a rewritten record (#959 F25).
 */
export const RecordTaxSourceAssertionResultSchema = Schema.Struct({
  /**
   * #957 acceptance evaluated over the assertion's claimed validity under the current contract revisions:
   * `ACCEPTED` when the source is System of Record or listed evidence at some claimed instant.
   */
  acceptanceOutcome: TaxSourceAcceptanceOutcomeSchema,
  acceptanceReason: TaxSourceAcceptanceReasonSchema,
  /**
   * The recorded assertion. With `ASSERTION_IDENTITY_CONFLICT` nothing was recorded: it names the conflicting
   * stored assertion that already holds the delivered identity (#958 F11).
   */
  assertionRef: TaxSourceAssertionRefSchema,
  /**
   * Role under the single revision covering the trusted operation time, `NONE` without exactly one. Provenance only:
   * it never decides; acceptance and resolution judge the role per business instant.
   */
  authorityRole: TaxSourceAuthorityRoleSchema,
  /**
   * First conflict detected when the assertion was recorded, echoed on every replay. Always present with
   * `ASSERTION_IDENTITY_CONFLICT`, where it names the integrity conflict itself (#958 F11, #959 F4-F6).
   */
  conflictRef: Schema.optionalKey(TaxSourceConflictRefSchema),
  created: Schema.Boolean,
  /** Stored eligibility of the recorded assertion; absent with `ASSERTION_IDENTITY_CONFLICT`, which records none. */
  eligibility: Schema.optionalKey(TaxSourceEligibilitySchema),
});
