// Immutable analyzer fixture: the owner ARES data contracts and decoder.
import { DateTime, Option, Result, Schema } from 'effect';
import { AresIsoTimestampSchema, AresRegisteredAddressSchema, AresSubjectEvidenceSchema } from './ares-snapshot-evidence.ts';

const AresApplyOutcomeSchema = Schema.Literals([
  'PREFILL_ONLY',
  'APPLY_ENRICHMENT',
  'NO_CHANGE',
  'NEEDS_CONFIRMATION',
  'CORRECTION_CANDIDATE',
  'IDENTITY_AMBIGUITY',
]);
type AresApplyOutcome = typeof AresApplyOutcomeSchema.Type;

const AresSelectedFactSchema = Schema.Literals(['BUSINESS_NAME', 'ICO', 'REGISTERED_ADDRESS', 'PARTY_CANDIDATE']);
type AresSelectedFact = typeof AresSelectedFactSchema.Type;

const decisionEvidence = {
  authorityPolicyKey: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
    Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
  ),
  authorityPolicyVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  reasonCode: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.isPattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u),
  ),
} as const;

const AresFactDecisionSchema = Schema.Union([
  Schema.Struct({
    ...decisionEvidence,
    fact: Schema.Literal('BUSINESS_NAME'),
    outcome: Schema.Literal('APPLY_ENRICHMENT'),
    route: Schema.Literal('PARTY_UPDATE'),
  }),
  Schema.Struct({
    ...decisionEvidence,
    fact: Schema.Literal('ICO'),
    outcome: Schema.Literal('APPLY_ENRICHMENT'),
    route: Schema.Literal('IDENTIFIER_ADD'),
  }),
  Schema.Struct({
    ...decisionEvidence,
    fact: Schema.Literal('REGISTERED_ADDRESS'),
    outcome: Schema.Literal('APPLY_ENRICHMENT'),
    route: Schema.Literal('CONTACT_POINT_ADD'),
  }),
  Schema.Struct({
    ...decisionEvidence,
    fact: AresSelectedFactSchema,
    outcome: Schema.Literals([
      'PREFILL_ONLY',
      'NO_CHANGE',
      'NEEDS_CONFIRMATION',
      'CORRECTION_CANDIDATE',
      'IDENTITY_AMBIGUITY',
    ]),
    route: Schema.Null,
  }),
]);
export type AresFactDecision = typeof AresFactDecisionSchema.Type;

export const AresEvidenceApplicationSchema = Schema.Struct({
  decidedAt: AresIsoTimestampSchema,
  evidence: AresSubjectEvidenceSchema,
  factDecisions: Schema.Array(AresFactDecisionSchema),
  outcome: AresApplyOutcomeSchema,
  userConfirmed: Schema.Boolean,
}).check(
  Schema.makeFilter((application) => {
    if (application.outcome === 'APPLY_ENRICHMENT') {
      return application.userConfirmed &&
        application.factDecisions.some((decision) => decision.outcome === 'APPLY_ENRICHMENT' && decision.route !== null)
        ? undefined
        : 'V1 enrichment requires explicit user confirmation and a standard Party Action route';
    }
    return application.factDecisions.length > 0 &&
      application.factDecisions.every((decision) => decision.route === null) &&
      application.factDecisions.some((decision) => decision.outcome === application.outcome)
      ? undefined
      : 'non-applying ARES outcomes require fact-specific evidence decisions without mutation routes';
  }),
);
export type AresEvidenceApplication = typeof AresEvidenceApplicationSchema.Type;

/** Persisted by the standard owner Action alongside its trusted actor and assertion identifier.
 * For a confirmed coordinator delivery, decidedAt is the logical as-of time of the original
 * confirmation envelope; assertion recordedAt is the trusted actual acceptance time. */
export const AresAppliedEvidenceSchema = Schema.Struct({
  ...decisionEvidence,
  authorityPolicyKey: Schema.Literal('party_registry.ares_enrichment'),
  authorityPolicyVersion: Schema.Literal('1'),
  cacheAgeSeconds: AresSubjectEvidenceSchema.fields.cacheAgeSeconds,
  decidedAt: AresIsoTimestampSchema,
  evidenceRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  fact: AresSelectedFactSchema,
  observedAt: AresIsoTimestampSchema,
  outcome: AresApplyOutcomeSchema,
  provider: Schema.Literal('ares'),
  providerChangedOn: AresSubjectEvidenceSchema.fields.providerChangedOn,
  providerRecordRef: AresSubjectEvidenceSchema.fields.providerRecordRef,
  queryIco: AresSubjectEvidenceSchema.fields.queryIco,
  servedAt: AresIsoTimestampSchema,
});
export type AresAppliedEvidence = typeof AresAppliedEvidenceSchema.Type;

const SupportedAddressSchema = AresRegisteredAddressSchema.check(
  Schema.makeFilter((address) =>
    Option.contains(address.countryCode, 'CZ') &&
    (Option.isSome(address.street) || Option.isSome(address.buildingNumber))
      ? undefined
      : 'address must be a structured Czech address',
  ),
);
const isSupportedAddress = Schema.is(SupportedAddressSchema);
const SupportedBusinessNameSchema = Schema.String.check(Schema.isMaxLength(300));
const isSupportedBusinessName = Schema.is(SupportedBusinessNameSchema);

export const makeAresAppliedEvidence = (
  application: AresEvidenceApplication,
  decision: AresFactDecision,
): AresAppliedEvidence => {
  const { evidence } = application;
  return Result.getOrThrow(
    Schema.decodeUnknownResult(Schema.toType(AresAppliedEvidenceSchema))({
      ...decision,
      cacheAgeSeconds: evidence.cacheAgeSeconds,
      decidedAt: application.decidedAt,
      evidenceRef: `ares:${evidence.queryIco}:${DateTime.formatIso(evidence.observedAt)}:${DateTime.formatIso(application.decidedAt)}:${decision.fact}`,
      observedAt: evidence.observedAt,
      provider: evidence.provider,
      providerChangedOn: evidence.providerChangedOn,
      providerRecordRef: evidence.providerRecordRef,
      queryIco: evidence.queryIco,
      servedAt: evidence.servedAt,
    }),
  );
};

