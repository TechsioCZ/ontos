import { DateTime, Option, Result, Schema } from 'effect';

import {
  AresIsoTimestampSchema,
  AresRegisteredAddressSchema,
  AresSubjectEvidenceSchema,
} from './ares-evidence.ts';
import type {
  AresRegisteredAddress,
  AresSubjectEvidence,
} from './ares-evidence.ts';
import type { StructuredAddress } from './contact-point.ts';
import type { PartyCandidate } from './identity-contracts.ts';

export const AresCanonicalRouteSchema = Schema.Literals([
  'PARTY_UPDATE',
  'IDENTIFIER_ADD',
  'CONTACT_POINT_ADD',
  'PARTY_CORRECTION',
]);

const AresApplyOutcomeSchema = Schema.Literals([
  'PREFILL_ONLY',
  'APPLY_ENRICHMENT',
  'NO_CHANGE',
  'NEEDS_CONFIRMATION',
  'CORRECTION_CANDIDATE',
  'IDENTITY_AMBIGUITY',
]);
type AresApplyOutcome = typeof AresApplyOutcomeSchema.Type;

const AresSelectedFactSchema = Schema.Literals([
  'BUSINESS_NAME',
  'ICO',
  'REGISTERED_ADDRESS',
  'PARTY_CANDIDATE',
]);
type AresSelectedFact = typeof AresSelectedFactSchema.Type;

const decisionEvidence = {
  authorityPolicyKey: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
    Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)
  ),
  authorityPolicyVersion: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100)
  ),
  reasonCode: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.isPattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u)
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
        application.factDecisions.some(
          (decision) =>
            decision.outcome === 'APPLY_ENRICHMENT' && decision.route !== null
        )
        ? undefined
        : 'V1 enrichment requires explicit user confirmation and a standard Party Action route';
    }
    return application.factDecisions.length > 0 &&
      application.factDecisions.every((decision) => decision.route === null) &&
      application.factDecisions.some(
        (decision) => decision.outcome === application.outcome
      )
      ? undefined
      : 'non-applying ARES outcomes require fact-specific evidence decisions without mutation routes';
  })
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
  evidenceRef: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200)
  ),
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
  readonly externalEvidence:
    | AresAppliedEvidence
    | typeof AresAppliedEvidenceSchema.Encoded
    | null;
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
  observed: AresRegisteredAddress | typeof AresRegisteredAddressSchema.Encoded,
  current: StructuredAddress
): boolean => {
  const address = Schema.is(AresRegisteredAddressSchema)(observed)
    ? observed
    : Result.getOrThrow(
        Schema.decodeResult(AresRegisteredAddressSchema)(observed)
      );
  const houseNumber = [
    Option.getOrNull(address.buildingNumber),
    Option.getOrNull(address.orientationNumber),
  ]
    .filter(Boolean)
    .join('/');
  const line = [Option.getOrNull(address.street), houseNumber]
    .filter(Boolean)
    .join(' ');
  const countryCode = Option.getOrNull(address.countryCode);
  // A formatted presentation string is not a structural address. Missing structure never proves equality.
  return (
    line.length > 0 &&
    countryCode !== null &&
    normalizeText(current.addressLine1) === normalizeText(line) &&
    normalizeText(current.addressLine2) ===
      normalizeText(Option.getOrNull(address.municipalityPart)) &&
    normalizeText(current.city) ===
      normalizeText(Option.getOrNull(address.municipality)) &&
    normalizeText(current.countryCode) === normalizeText(countryCode) &&
    normalizeText(current.postalCode).replaceAll(' ', '') ===
      normalizeText(Option.getOrNull(address.postalCode)).replaceAll(' ', '') &&
    normalizeText(current.region) === ''
  );
};

export interface AresDecisionInput {
  readonly canonical: AresCanonicalSnapshot | null;
  readonly decidedAt: typeof AresIsoTimestampSchema.Encoded;
  readonly evidence: typeof AresSubjectEvidenceSchema.Encoded;
  readonly selectedFacts: readonly AresSelectedFact[];
  readonly userConfirmed: boolean;
}

const SupportedAddressSchema = AresRegisteredAddressSchema.check(
  Schema.makeFilter((address) =>
    Option.contains(address.countryCode, 'CZ') &&
    (Option.isSome(address.street) || Option.isSome(address.buildingNumber))
      ? undefined
      : 'address must be a structured Czech address'
  )
);
const isSupportedAddress = Schema.is(SupportedAddressSchema);
const SupportedBusinessNameSchema = Schema.String.check(
  Schema.isMaxLength(300)
);
const isSupportedBusinessName = Schema.is(SupportedBusinessNameSchema);
const epochMillisFromString = (value: string): number =>
  Option.match(DateTime.make(value), {
    onNone: () => Number.NaN,
    onSome: DateTime.toEpochMillis,
  });

/** A bounded proposal only. An explicit evidence-backed Matching/Create flow owns acceptance. */
export const prefillPartyCandidateFromAres = (
  input: typeof AresSubjectEvidenceSchema.Encoded
): PartyCandidate => {
  const evidence = Result.getOrThrow(
    Schema.decodeResult(AresSubjectEvidenceSchema)(input)
  );
  const candidate: PartyCandidate = {
    evidenceRefs: [
      `ares:${evidence.queryIco}:${DateTime.formatIso(evidence.observedAt)}`,
    ],
    officialIdentifiers: [
      {
        identifierType: 'ICO',
        value: evidence.subject.ico,
        verification: 'UNVERIFIED',
      },
    ],
    partyType: 'UNRESOLVED',
    provenance: {
      method: 'PROVIDER_OBSERVATION',
      source: 'ARES_CANDIDATE_PREFILL',
    },
    subjectEvidence: [],
    validFrom: evidence.observedAt,
  };
  const businessName = Option.getOrUndefined(evidence.subject.businessName);
  if (businessName !== undefined && isSupportedBusinessName(businessName)) {
    return { ...candidate, displayName: businessName };
  }
  return candidate;
};

const acceptedObservationMatches = (
  accepted: AresAppliedEvidence,
  evidence: AresSubjectEvidence,
  validFrom: string
): boolean =>
  (Option.isNone(accepted.providerRecordRef) ||
    Option.isNone(evidence.providerRecordRef) ||
    Option.getOrNull(accepted.providerRecordRef) ===
      Option.getOrNull(evidence.providerRecordRef)) &&
  DateTime.toEpochMillis(accepted.observedAt) <=
    epochMillisFromString(validFrom) &&
  epochMillisFromString(validFrom) <=
    DateTime.toEpochMillis(evidence.observedAt);

const acceptedEvidenceConflicts = (
  assertion: AresCanonicalFactEvidence,
  evidence: AresSubjectEvidence,
  fact: 'BUSINESS_NAME' | 'ICO'
): boolean => {
  const acceptedInput = assertion.externalEvidence;
  const accepted =
    acceptedInput === null ||
    Schema.is(AresAppliedEvidenceSchema)(acceptedInput)
      ? acceptedInput
      : Result.getOrUndefined(
          Schema.decodeResult(AresAppliedEvidenceSchema)(acceptedInput)
        );
  return (
    accepted !== null &&
    accepted !== undefined &&
    accepted.fact === fact &&
    accepted.outcome === 'APPLY_ENRICHMENT' &&
    accepted.queryIco === evidence.queryIco &&
    Option.contains(
      accepted.providerChangedOn,
      Option.getOrThrow(evidence.providerChangedOn)
    ) &&
    acceptedObservationMatches(accepted, evidence, assertion.validFrom)
  );
};

const historicalConflict = (
  canonical: AresCanonicalSnapshot,
  evidence: AresSubjectEvidence,
  fact: 'BUSINESS_NAME' | 'ICO'
): AresCanonicalFactEvidence | undefined => {
  const observedValue =
    fact === 'ICO'
      ? evidence.subject.ico
      : Option.getOrNull(evidence.subject.businessName);
  if (
    observedValue === null ||
    Option.isNone(evidence.providerChangedOn) ||
    (fact === 'BUSINESS_NAME' && !isSupportedBusinessName(observedValue))
  ) {
    return undefined;
  }
  const assertions = (canonical.factEvidence ?? []).filter(
    (assertion) =>
      assertion.fact === fact &&
      (fact === 'BUSINESS_NAME'
        ? normalizeText(assertion.value) ===
          normalizeText(canonical.displayName)
        : canonical.icoValues.includes(assertion.value)) &&
      normalizeText(assertion.value) !== normalizeText(observedValue) &&
      acceptedEvidenceConflicts(assertion, evidence, fact)
  );
  // Multiple current assertions are an unresolved conflict, never an arbitrary review target.
  return assertions.length === 1 ? assertions[0] : undefined;
};

const blocked = (
  fact: AresSelectedFact,
  outcome: Exclude<AresApplyOutcome, 'APPLY_ENRICHMENT'>,
  reasonCode: string
): AresFactDecision => ({
  ...ownerPolicy,
  fact,
  outcome,
  reasonCode,
  route: null,
});

const businessNameDecision = (
  canonical: AresCanonicalSnapshot,
  evidence: AresSubjectEvidence
): AresFactDecision | undefined => {
  const fact = 'BUSINESS_NAME';
  const businessName = Option.getOrNull(evidence.subject.businessName);
  if (businessName === null || !isSupportedBusinessName(businessName)) {
    return blocked(fact, 'NO_CHANGE', 'provider_fact_absent_or_unsupported');
  }
  if (normalizeText(canonical.displayName) === normalizeText(businessName)) {
    return blocked(fact, 'NO_CHANGE', 'canonical_fact_equal');
  }
  if (canonical.displayName !== null) {
    return blocked(fact, 'NEEDS_CONFIRMATION', 'canonical_fact_conflict');
  }
  return undefined;
};

const addressDecision = (
  canonical: AresCanonicalSnapshot,
  evidence: AresSubjectEvidence
): AresFactDecision | undefined => {
  const fact = 'REGISTERED_ADDRESS';
  const address = Option.getOrUndefined(evidence.subject.registeredAddress);
  if (address === undefined || !isSupportedAddress(address)) {
    return blocked(fact, 'NO_CHANGE', 'provider_fact_absent_or_unsupported');
  }
  if (
    canonical.registeredAddresses.some((current) =>
      aresRegisteredAddressMatches(address, current)
    )
  ) {
    return blocked(fact, 'NO_CHANGE', 'canonical_fact_equal');
  }
  if (canonical.registeredAddresses.length > 0) {
    return blocked(fact, 'NEEDS_CONFIRMATION', 'canonical_fact_conflict');
  }
  return undefined;
};

const identityDecision = (
  fact: AresSelectedFact,
  canonical: AresCanonicalSnapshot,
  evidence: AresSubjectEvidence
): AresFactDecision | undefined => {
  const conflictingIco = canonical.icoValues.some(
    (value) => value !== evidence.subject.ico
  );
  const historical =
    fact === 'BUSINESS_NAME' || fact === 'ICO'
      ? historicalConflict(canonical, evidence, fact)
      : undefined;
  if (
    conflictingIco &&
    (fact !== 'ICO' ||
      historical === undefined ||
      canonical.icoValues.length !== 1)
  ) {
    return blocked(fact, 'IDENTITY_AMBIGUITY', 'canonical_identity_conflict');
  }
  if (historical !== undefined) {
    return blocked(
      fact,
      'CORRECTION_CANDIDATE',
      'unchanged_provider_revision_conflicts_with_accepted_assertion'
    );
  }
  return undefined;
};

const applyFactDecision = (
  fact: Exclude<AresSelectedFact, 'PARTY_CANDIDATE'>,
  canonical: AresCanonicalSnapshot,
  userConfirmed: boolean
): AresFactDecision => {
  // Only ORGANIZATION ICO assertions qualify for the current authoritative claim rule.
  if (fact === 'ICO' && canonical.partyType !== 'ORGANIZATION') {
    return blocked(
      fact,
      'NEEDS_CONFIRMATION',
      'party_type_not_supported_for_authoritative_ico'
    );
  }
  if (!userConfirmed) {
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
};

const selectedFactDecision = (
  fact: Exclude<AresSelectedFact, 'PARTY_CANDIDATE'>,
  canonical: AresCanonicalSnapshot,
  evidence: AresSubjectEvidence,
  userConfirmed: boolean
): AresFactDecision => {
  const conflict = identityDecision(fact, canonical, evidence);
  if (conflict !== undefined) {
    return conflict;
  }
  if (fact === 'BUSINESS_NAME') {
    const decision = businessNameDecision(canonical, evidence);
    if (decision !== undefined) {
      return decision;
    }
  }
  if (fact === 'REGISTERED_ADDRESS') {
    const decision = addressDecision(canonical, evidence);
    if (decision !== undefined) {
      return decision;
    }
  }
  if (fact === 'ICO' && canonical.icoValues.includes(evidence.subject.ico)) {
    return blocked(fact, 'NO_CHANGE', 'canonical_fact_equal');
  }
  return applyFactDecision(fact, canonical, userConfirmed);
};

/** Policy is closed owner code, never a caller-supplied outcome, route or authority assertion. */
export const deriveAresEvidenceApplication = (
  input: AresDecisionInput
): AresEvidenceApplication => {
  const evidence = Result.getOrThrow(
    Schema.decodeResult(AresSubjectEvidenceSchema)(input.evidence)
  );
  const decidedAt = Result.getOrThrow(
    Schema.decodeResult(AresIsoTimestampSchema)(input.decidedAt)
  );
  const selectedFacts = Result.getOrThrow(
    Schema.decodeResult(
      Schema.Array(AresSelectedFactSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(4),
        Schema.makeFilter((facts) =>
          new Set(facts).size === facts.length
            ? undefined
            : 'ARES selected facts must be unique'
        )
      )
    )(input.selectedFacts)
  );
  const { canonical } = input;
  const decidedAtEpochMillis = DateTime.toEpochMillis(decidedAt);
  const age =
    decidedAtEpochMillis - DateTime.toEpochMillis(evidence.observedAt);
  const fresh =
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 300_000 &&
    decidedAtEpochMillis >= DateTime.toEpochMillis(evidence.servedAt);
  const decisions = selectedFacts.map((fact): AresFactDecision => {
    if (evidence.subject.ico !== evidence.queryIco) {
      return blocked(
        fact,
        'IDENTITY_AMBIGUITY',
        'provider_subject_does_not_match_query'
      );
    }
    if (canonical === null) {
      return blocked(fact, 'PREFILL_ONLY', 'candidate_prefill_only');
    }
    if (fact === 'PARTY_CANDIDATE') {
      return blocked(
        fact,
        'NEEDS_CONFIRMATION',
        'candidate_has_existing_target'
      );
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
    return selectedFactDecision(fact, canonical, evidence, input.userConfirmed);
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
    priority.find((candidate) =>
      decisions.some((decision) => decision.outcome === candidate)
    ) ?? 'NO_CHANGE';
  return Result.getOrThrow(
    Schema.decodeResult(Schema.toType(AresEvidenceApplicationSchema))({
      decidedAt,
      evidence,
      factDecisions: decisions,
      outcome,
      userConfirmed: input.userConfirmed,
    })
  );
};

export const makeAresAppliedEvidence = (
  application: AresEvidenceApplication,
  decision: AresFactDecision
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
    })
  );
};

/** Nominates one exact accepted assertion; the reviewer still supplies the Correction command. */
export const deriveAresCorrectionReviewHandoffs = (
  application: AresEvidenceApplication,
  canonical: AresCanonicalSnapshot
): readonly AresCorrectionReviewHandoff[] =>
  application.factDecisions.flatMap((decision) => {
    if (
      decision.outcome !== 'CORRECTION_CANDIDATE' ||
      (decision.fact !== 'BUSINESS_NAME' && decision.fact !== 'ICO')
    ) {
      return [];
    }
    const assertion = historicalConflict(
      canonical,
      application.evidence,
      decision.fact
    );
    const observedValue =
      decision.fact === 'ICO'
        ? application.evidence.subject.ico
        : Option.getOrNull(application.evidence.subject.businessName);
    return assertion === undefined || observedValue === null
      ? []
      : [
          {
            evidence: makeAresAppliedEvidence(application, decision),
            fact: decision.fact,
            observedValue,
            reasonCode:
              'unchanged_provider_revision_conflicts_with_accepted_assertion' as const,
            targetAssertionId: assertion.assertionId,
          },
        ];
  });
