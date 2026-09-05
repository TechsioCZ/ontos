import { Schema } from 'effect';
import { AresIsoTimestampSchema, AresSubjectEvidenceSchema } from './ares-evidence.ts';
import type { AresRegisteredAddress, AresSubjectEvidence } from './ares-evidence.ts';
import type { StructuredAddress } from './contact-point.ts';
import type { PartyCandidate } from './identity-contracts.ts';

export const AresCanonicalRouteSchema = Schema.Literals([
  'PARTY_UPDATE',
  'IDENTIFIER_ADD',
  'CONTACT_POINT_ADD',
  'PARTY_CORRECTION',
]);
export type AresCanonicalRoute = typeof AresCanonicalRouteSchema.Type;

export const AresApplyOutcomeSchema = Schema.Literals([
  'PREFILL_ONLY',
  'APPLY_ENRICHMENT',
  'NO_CHANGE',
  'NEEDS_CONFIRMATION',
  'CORRECTION_CANDIDATE',
  'IDENTITY_AMBIGUITY',
]);
export type AresApplyOutcome = typeof AresApplyOutcomeSchema.Type;

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

export const AresFactDecisionSchema = Schema.Union([
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
    fact: Schema.Literals(['BUSINESS_NAME', 'ICO', 'PARTY_CANDIDATE', 'REGISTERED_ADDRESS']),
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
        application.factDecisions.some(
          (decision) => decision.outcome === 'APPLY_ENRICHMENT' && decision.route !== null,
        )
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

export const AresSelectedFactSchema = Schema.Literals([
  'BUSINESS_NAME',
  'ICO',
  'REGISTERED_ADDRESS',
  'PARTY_CANDIDATE',
]);
export type AresSelectedFact = typeof AresSelectedFactSchema.Type;
const ownerPolicy = {
  authorityPolicyKey: 'party_registry.ares_enrichment',
  authorityPolicyVersion: '1',
} as const;

/** Governed assertion context supports suspicion of an acceptance error, never authorizes correction. */
export interface AresCanonicalFactEvidence {
  readonly assertionId: string;
  readonly fact: 'BUSINESS_NAME' | 'ICO';
  readonly value: string;
  readonly validFrom: string;
  readonly externalEvidence: AresAppliedEvidence | null;
}
export interface AresCorrectionReviewHandoff {
  readonly fact: 'BUSINESS_NAME' | 'ICO';
  readonly targetAssertionId: string;
  readonly observedValue: string;
  readonly reasonCode: 'unchanged_provider_revision_conflicts_with_accepted_assertion';
  readonly evidence: AresAppliedEvidence;
}

/** Supplied only by the owner coordinator after authorized, tenant-scoped public Reads. */
export interface AresCanonicalSnapshot {
  readonly factEvidence?: readonly AresCanonicalFactEvidence[];
  readonly partyType?: 'PERSON' | 'ORGANIZATION' | 'UNRESOLVED';
  readonly archived: boolean;
  readonly displayName: string | null;
  readonly icoValues: readonly string[];
  readonly identityAmbiguous: boolean;
  readonly registeredAddresses: readonly StructuredAddress[];
}

const normalizeText = (value: string | null | undefined): string =>
  (value ?? '').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('cs-CZ');

export const aresRegisteredAddressMatches = (
  observed: AresRegisteredAddress,
  current: StructuredAddress,
): boolean => {
  const houseNumber = [observed.buildingNumber, observed.orientationNumber]
    .filter(Boolean)
    .join('/');
  const line = [observed.street, houseNumber].filter(Boolean).join(' ');
  // A formatted presentation string is not a structural address. Missing structure never proves equality.
  return (
    line.length > 0 &&
    observed.countryCode !== null &&
    normalizeText(current.addressLine1) === normalizeText(line) &&
    normalizeText(current.addressLine2) === normalizeText(observed.municipalityPart) &&
    normalizeText(current.city) === normalizeText(observed.municipality) &&
    normalizeText(current.countryCode) === normalizeText(observed.countryCode) &&
    normalizeText(current.postalCode).replaceAll(' ', '') ===
      normalizeText(observed.postalCode).replaceAll(' ', '') &&
    normalizeText(current.region) === ''
  );
};

export interface AresDecisionInput {
  readonly canonical: AresCanonicalSnapshot | null;
  readonly decidedAt: string;
  readonly evidence: AresSubjectEvidence;
  readonly selectedFacts: readonly AresSelectedFact[];
  readonly userConfirmed: boolean;
}

const supportedAddress = (
  address: AresRegisteredAddress | null,
): address is AresRegisteredAddress =>
  address !== null &&
  address.countryCode === 'CZ' &&
  (address.street !== null || address.buildingNumber !== null);
const supportedBusinessName = (name: string | null): name is string =>
  name !== null && name.length <= 300;

/** A bounded proposal only. An explicit evidence-backed Matching/Create flow owns acceptance. */
export const prefillPartyCandidateFromAres = (input: AresSubjectEvidence): PartyCandidate => {
  const evidence = Schema.decodeUnknownSync(AresSubjectEvidenceSchema)(input);
  const candidate: PartyCandidate = {
    evidenceRefs: [`ares:${evidence.queryIco}:${evidence.observedAt}`],
    officialIdentifiers: [
      { identifierType: 'ICO', value: evidence.subject.ico, verification: 'UNVERIFIED' },
    ],
    partyType: 'UNRESOLVED',
    provenance: { method: 'PROVIDER_OBSERVATION', source: 'ARES_CANDIDATE_PREFILL' },
    subjectEvidence: [],
    validFrom: evidence.observedAt,
  };
  if (supportedBusinessName(evidence.subject.businessName)) {
    return { ...candidate, displayName: evidence.subject.businessName };
  }
  return candidate;
};

const historicalConflict = (
  canonical: AresCanonicalSnapshot,
  evidence: AresSubjectEvidence,
  fact: 'BUSINESS_NAME' | 'ICO',
): AresCanonicalFactEvidence | undefined => {
  const observedValue = fact === 'ICO' ? evidence.subject.ico : evidence.subject.businessName;
  if (
    observedValue === null ||
    evidence.providerChangedOn === null ||
    (fact === 'BUSINESS_NAME' && !supportedBusinessName(observedValue))
  ) {
    return undefined;
  }
  const assertions = (canonical.factEvidence ?? []).filter((assertion) => {
    const accepted = assertion.externalEvidence;
    return (
      assertion.fact === fact &&
      (fact === 'BUSINESS_NAME'
        ? normalizeText(assertion.value) === normalizeText(canonical.displayName)
        : canonical.icoValues.includes(assertion.value)) &&
      normalizeText(assertion.value) !== normalizeText(observedValue) &&
      accepted !== null &&
      accepted.fact === fact &&
      accepted.outcome === 'APPLY_ENRICHMENT' &&
      accepted.queryIco === evidence.queryIco &&
      accepted.providerChangedOn === evidence.providerChangedOn &&
      (accepted.providerRecordRef === null ||
        evidence.providerRecordRef === null ||
        accepted.providerRecordRef === evidence.providerRecordRef) &&
      Date.parse(accepted.observedAt) <= Date.parse(assertion.validFrom) &&
      Date.parse(assertion.validFrom) <= Date.parse(evidence.observedAt)
    );
  });
  // Multiple current assertions are an unresolved conflict, never an arbitrary review target.
  return assertions.length === 1 ? assertions[0] : undefined;
};

/** Policy is closed owner code, never a caller-supplied outcome, route or authority assertion. */
export const deriveAresEvidenceApplication = (
  input: AresDecisionInput,
): AresEvidenceApplication => {
  const evidence = Schema.decodeUnknownSync(AresSubjectEvidenceSchema)(input.evidence);
  const decidedAt = Schema.decodeUnknownSync(AresIsoTimestampSchema)(input.decidedAt);
  const selectedFacts = Schema.decodeUnknownSync(
    Schema.Array(AresSelectedFactSchema).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  )(input.selectedFacts);
  if (new Set(selectedFacts).size !== selectedFacts.length) {
    throw new TypeError('ARES selected facts must be unique');
  }
  const { canonical } = input;
  const age = Date.parse(decidedAt) - Date.parse(evidence.observedAt);
  const fresh =
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 300_000 &&
    Date.parse(decidedAt) >= Date.parse(evidence.servedAt);
  const blocked = (
    fact: AresSelectedFact,
    outcome: Exclude<AresApplyOutcome, 'APPLY_ENRICHMENT'>,
    reasonCode: string,
  ): AresFactDecision => ({ ...ownerPolicy, fact, outcome, reasonCode, route: null });
  // eslint-disable-next-line complexity -- Keep the closed fact precedence and mutation routes in one auditable decision.
  const decisions = selectedFacts.map((fact): AresFactDecision => {
    if (evidence.subject.ico !== evidence.queryIco) {
      return blocked(fact, 'IDENTITY_AMBIGUITY', 'provider_subject_does_not_match_query');
    }
    if (canonical === null) {
      return blocked(fact, 'PREFILL_ONLY', 'candidate_prefill_only');
    }
    if (fact === 'PARTY_CANDIDATE') {
      return blocked(fact, 'NEEDS_CONFIRMATION', 'candidate_has_existing_target');
    }
    if (canonical.identityAmbiguous) {
      return blocked(fact, 'IDENTITY_AMBIGUITY', 'canonical_identity_conflict');
    }
    if (canonical.archived) {
      return blocked(fact, 'NEEDS_CONFIRMATION', 'canonical_party_archived');
    }
    if (!fresh) {
      return blocked(fact, 'NEEDS_CONFIRMATION', 'observation_not_fresh');
    }
    const conflictingIco = canonical.icoValues.some((value) => value !== evidence.subject.ico);
    const historical =
      fact === 'BUSINESS_NAME' || fact === 'ICO'
        ? historicalConflict(canonical, evidence, fact)
        : undefined;
    if (
      conflictingIco &&
      (fact !== 'ICO' || historical === undefined || canonical.icoValues.length !== 1)
    ) {
      return blocked(fact, 'IDENTITY_AMBIGUITY', 'canonical_identity_conflict');
    }
    if (historical !== undefined) {
      return blocked(
        fact,
        'CORRECTION_CANDIDATE',
        'unchanged_provider_revision_conflicts_with_accepted_assertion',
      );
    }
    if (fact === 'BUSINESS_NAME') {
      if (!supportedBusinessName(evidence.subject.businessName)) {
        return blocked(fact, 'NO_CHANGE', 'provider_fact_absent_or_unsupported');
      }
      if (normalizeText(canonical.displayName) === normalizeText(evidence.subject.businessName)) {
        return blocked(fact, 'NO_CHANGE', 'canonical_fact_equal');
      }
      if (canonical.displayName !== null) {
        return blocked(fact, 'NEEDS_CONFIRMATION', 'canonical_fact_conflict');
      }
    }
    if (fact === 'ICO' && canonical.icoValues.includes(evidence.subject.ico)) {
      return blocked(fact, 'NO_CHANGE', 'canonical_fact_equal');
    }
    if (fact === 'REGISTERED_ADDRESS') {
      const address = evidence.subject.registeredAddress;
      if (!supportedAddress(address)) {
        return blocked(fact, 'NO_CHANGE', 'provider_fact_absent_or_unsupported');
      }
      if (
        canonical.registeredAddresses.some((current) =>
          aresRegisteredAddressMatches(address, current),
        )
      ) {
        return blocked(fact, 'NO_CHANGE', 'canonical_fact_equal');
      }
      if (canonical.registeredAddresses.length > 0) {
        return blocked(fact, 'NEEDS_CONFIRMATION', 'canonical_fact_conflict');
      }
    }
    // Only ORGANIZATION ICO assertions qualify for the current authoritative claim rule.
    if (fact === 'ICO' && canonical.partyType !== 'ORGANIZATION') {
      return blocked(fact, 'NEEDS_CONFIRMATION', 'party_type_not_supported_for_authoritative_ico');
    }
    if (!input.userConfirmed) {
      return blocked(fact, 'NEEDS_CONFIRMATION', 'user_confirmation_required');
    }
    const common = {
      ...ownerPolicy,
      outcome: 'APPLY_ENRICHMENT',
      reasonCode: 'selected_missing_fact_confirmed',
    } as const;
    if (fact === 'BUSINESS_NAME') {
      return { ...common, fact, route: 'PARTY_UPDATE' };
    }
    if (fact === 'ICO') {
      return { ...common, fact, route: 'IDENTIFIER_ADD' };
    }
    return { ...common, fact, route: 'CONTACT_POINT_ADD' };
  });
  const priority: readonly AresApplyOutcome[] = [
    'APPLY_ENRICHMENT',
    'IDENTITY_AMBIGUITY',
    'NEEDS_CONFIRMATION',
    'CORRECTION_CANDIDATE',
    'PREFILL_ONLY',
    'NO_CHANGE',
  ];
  const outcome =
    priority.find((candidate) => decisions.some((decision) => decision.outcome === candidate)) ??
    'NO_CHANGE';
  return Schema.decodeUnknownSync(AresEvidenceApplicationSchema)({
    decidedAt,
    evidence,
    factDecisions: decisions,
    outcome,
    userConfirmed: input.userConfirmed,
  });
};

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

export const makeAresAppliedEvidence = (
  application: AresEvidenceApplication,
  decision: AresFactDecision,
): AresAppliedEvidence => {
  const { evidence } = application;
  return Schema.decodeUnknownSync(AresAppliedEvidenceSchema)({
    ...decision,
    cacheAgeSeconds: evidence.cacheAgeSeconds,
    decidedAt: application.decidedAt,
    evidenceRef: `ares:${evidence.queryIco}:${evidence.observedAt}:${application.decidedAt}:${decision.fact}`,
    observedAt: evidence.observedAt,
    provider: evidence.provider,
    providerChangedOn: evidence.providerChangedOn,
    providerRecordRef: evidence.providerRecordRef,
    queryIco: evidence.queryIco,
    servedAt: evidence.servedAt,
  });
};

/** Nominates one exact accepted assertion; the reviewer still supplies the Correction command. */
export const deriveAresCorrectionReviewHandoffs = (
  application: AresEvidenceApplication,
  canonical: AresCanonicalSnapshot,
): readonly AresCorrectionReviewHandoff[] =>
  application.factDecisions.flatMap((decision) => {
    if (
      decision.outcome !== 'CORRECTION_CANDIDATE' ||
      (decision.fact !== 'BUSINESS_NAME' && decision.fact !== 'ICO')
    ) {
      return [];
    }
    const assertion = historicalConflict(canonical, application.evidence, decision.fact);
    const observedValue =
      decision.fact === 'ICO'
        ? application.evidence.subject.ico
        : application.evidence.subject.businessName;
    return assertion === undefined || observedValue === null
      ? []
      : [
          {
            evidence: makeAresAppliedEvidence(application, decision),
            fact: decision.fact,
            observedValue,
            reasonCode: 'unchanged_provider_revision_conflicts_with_accepted_assertion' as const,
            targetAssertionId: assertion.assertionId,
          },
        ];
  });
