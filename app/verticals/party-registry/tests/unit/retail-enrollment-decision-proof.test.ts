import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { RetailEnrollmentEvidenceSchema } from '../../shared/actions/accept-retail-enrollment-evidence.ts';
import {
  PartyCandidateSchema,
  PartyEvidenceEvaluationSchema,
  PartySubjectEligibilityVersion,
  PartyTypeRuleVersion,
} from '../../shared/domain/identity-contracts.ts';
import { evaluatePartySubjectEvidence } from '../../src/policies/create-party-without-strong-identifier.policy.ts';
import { acceptsRetailEnrollmentDecision } from '../../src/policies/retail-enrollment-evidence.policy.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const otherId = '90000000-0000-4000-8000-000000000001';
const evidence = Schema.decodeSync(RetailEnrollmentEvidenceSchema)({
  authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
  candidateEvidenceRef: '30000000-0000-4000-8000-000000000001',
  emailOwnership: 'VERIFIED',
  enrollmentAttemptId: '40000000-0000-4000-8000-000000000001',
  journey: 'RETAIL_SELF_ENROLLMENT',
  providerOwnerInvocationId: '50000000-0000-4000-8000-000000000001',
  providerSubjectId: 'exact-provider-subject',
  sellingLegalEntityId: legalEntityId,
  tenantId,
});
const scope = { legalEntityId, tenantId };
const attestation = {
  basis: 'DIRECT_INTERACTION',
  evidenceRef: evidence.candidateEvidenceRef,
  kind: 'ACTOR_ATTESTATION',
  observedSubject: 'PERSON',
  statement: 'This exact provider subject completed retail enrollment',
  subjectKey: evidence.providerSubjectId,
};
const candidateInput = {
  evidenceRefs: [evidence.candidateEvidenceRef],
  firstName: 'Retail',
  lastName: 'Customer',
  officialIdentifiers: [],
  partyType: 'PERSON',
  provenance: {
    method: 'commerce.portal-enrollment.self-enrollment',
    source: 'commerce.customer-context',
  },
  subjectEvidence: [attestation],
  validFrom: '2026-11-20T00:00:00.000Z',
};
const nativeEvaluation = (overrides: Schema.JsonObject = {}) =>
  evaluatePartySubjectEvidence(Schema.decodeUnknownSync(PartyCandidateSchema)({ ...candidateInput, ...overrides }));
const evaluation = nativeEvaluation();
const persistedEvaluation = (overrides: Schema.JsonObject = {}) =>
  Schema.decodeUnknownSync(PartyEvidenceEvaluationSchema)({
    ...Schema.encodeSync(PartyEvidenceEvaluationSchema)(evaluation),
    ...overrides,
  });
const manualDeclaration = {
  kind: 'MANUAL_DECLARATION',
  observedSubject: 'PERSON',
  statement: 'A person was manually declared',
  subjectKey: evidence.providerSubjectId,
};
const clientSourceAssertion = {
  kind: 'CLIENT_SOURCE_ASSERTION',
  observedSubject: 'PERSON',
  occurrenceId: 'source-occurrence',
  recordId: 'source-record',
  source: {
    issuer: 'client',
    namespace: 'client.records',
    recordType: 'customer',
    routeRef: 'source-route',
  },
  sourceObservedAt: '2026-11-20T00:00:00.000Z',
  statement: 'A source record asserted a person',
  subjectKey: evidence.providerSubjectId,
};

// Native commitment, action identity and ownership are checked by the caller. These
// tests exercise only the persisted subject decision's narrower retail proof.
it('accepts the native current actor-attestation decision for verified retail enrollment', () => {
  expect(evaluation).toMatchObject({
    subjectEligibilityVersion: PartySubjectEligibilityVersion,
    subjectEligible: true,
    typeRuleVersion: PartyTypeRuleVersion,
    typeSupported: true,
  });
  expect(acceptsRetailEnrollmentDecision(persistedEvaluation(), evidence, scope)).toBe(true);
});

it('accepts an existing-account journey with the same persisted subject proof', () => {
  const restart = Schema.decodeUnknownSync(RetailEnrollmentEvidenceSchema)({
    ...evidence,
    journey: 'EXISTING_ACCOUNT',
  });
  expect(acceptsRetailEnrollmentDecision(persistedEvaluation(), restart, scope)).toBe(true);
});

it('accepts multiple direct person attestations only when each binds the same provider and evidence', () => {
  const multiple = nativeEvaluation({
    subjectEvidence: [attestation, { ...attestation, statement: 'The same subject confirmed enrollment' }],
  });
  expect(acceptsRetailEnrollmentDecision(multiple, evidence, scope)).toBe(true);
});

it.each([
  { field: 'subjectEligible', overrides: { subjectEligible: false } },
  { field: 'typeSupported', overrides: { typeSupported: false } },
])('rejects a native decision with $field false', ({ overrides }) => {
  expect(acceptsRetailEnrollmentDecision(persistedEvaluation(overrides), evidence, scope)).toBe(false);
});

it('rejects an empty proof even when its stored eligibility flags claim success', () => {
  expect(acceptsRetailEnrollmentDecision(persistedEvaluation({ evidence: [] }), evidence, scope)).toBe(false);
});

it.each([
  { label: 'manual declaration', subjectEvidence: [manualDeclaration] },
  { label: 'client source assertion', subjectEvidence: [clientSourceAssertion] },
])('rejects a native eligible $label decision', ({ subjectEvidence }) => {
  const declared = nativeEvaluation({ subjectEvidence });
  expect(declared.subjectEligible).toBe(true);
  expect(declared.typeSupported).toBe(true);
  expect(acceptsRetailEnrollmentDecision(declared, evidence, scope)).toBe(false);
});

it.each([
  { label: 'manual declaration', entry: manualDeclaration },
  { label: 'client source assertion', entry: clientSourceAssertion },
])('rejects $label even if stored flags and actor versions claim eligibility', ({ entry }) => {
  expect(acceptsRetailEnrollmentDecision(persistedEvaluation({ evidence: [entry] }), evidence, scope)).toBe(false);
});

it('rejects a guest-bound actor attestation even for the same tenant and company', () => {
  const guest = nativeEvaluation({
    subjectEvidence: [
      {
        ...attestation,
        guestBinding: {
          correlationRoot: 'guest-checkout',
          legalEntityRef: {
            moduleId: 'core.identity',
            resourceId: legalEntityId,
            resourceType: 'core.identity.legal-entity',
            tenantId,
          },
        },
      },
    ],
  });
  expect(guest.subjectEligible).toBe(true);
  expect(acceptsRetailEnrollmentDecision(guest, evidence, scope)).toBe(false);
});

it('rejects a source-input fingerprint attached to an otherwise valid actor decision', () => {
  expect(
    acceptsRetailEnrollmentDecision(persistedEvaluation({ sourceInputFingerprint: 'a'.repeat(64) }), evidence, scope),
  ).toBe(false);
});

it('rejects reviewed-document evidence even when native subject and type evaluation succeeds', () => {
  const reviewed = nativeEvaluation({ subjectEvidence: [{ ...attestation, basis: 'REVIEWED_DOCUMENT' }] });
  expect(reviewed.subjectEligible).toBe(true);
  expect(reviewed.typeSupported).toBe(true);
  expect(acceptsRetailEnrollmentDecision(reviewed, evidence, scope)).toBe(false);
});

it.each(['ORGANIZATION', 'CONCRETE_SUBJECT', 'TECHNICAL_RECORD', 'MANAGED_LEGAL_ENTITY'])(
  'rejects observed subject %s despite stored success flags',
  (observedSubject) => {
    expect(
      acceptsRetailEnrollmentDecision(
        persistedEvaluation({ evidence: [{ ...attestation, observedSubject }] }),
        evidence,
        scope,
      ),
    ).toBe(false);
  },
);

it.each([
  { label: 'manual after actor', entries: [attestation, manualDeclaration] },
  { label: 'manual before actor', entries: [manualDeclaration, attestation] },
  { label: 'client source after actor', entries: [attestation, clientSourceAssertion] },
  { label: 'reviewed document after actor', entries: [attestation, { ...attestation, basis: 'REVIEWED_DOCUMENT' }] },
  { label: 'non-person after actor', entries: [attestation, { ...attestation, observedSubject: 'ORGANIZATION' }] },
  { label: 'wrong provider after actor', entries: [attestation, { ...attestation, subjectKey: 'another-subject' }] },
  { label: 'wrong reference after actor', entries: [attestation, { ...attestation, evidenceRef: otherId }] },
])('rejects mixed persisted evidence: $label', ({ entries }) => {
  expect(acceptsRetailEnrollmentDecision(persistedEvaluation({ evidence: entries }), evidence, scope)).toBe(false);
});

it.each([
  { label: 'provider subject', overrides: { providerSubjectId: 'another-subject' } },
  { label: 'candidate evidence reference', overrides: { candidateEvidenceRef: otherId } },
  { label: 'evidence tenant', overrides: { tenantId: otherId } },
  { label: 'evidence company', overrides: { sellingLegalEntityId: otherId } },
])('rejects a mismatched $label', ({ overrides }) => {
  const mismatched = Schema.decodeUnknownSync(RetailEnrollmentEvidenceSchema)({ ...evidence, ...overrides });
  expect(acceptsRetailEnrollmentDecision(persistedEvaluation(), mismatched, scope)).toBe(false);
});

it.each([
  { label: 'foreign tenant', trustedScope: { legalEntityId, tenantId: otherId } },
  { label: 'foreign company', trustedScope: { legalEntityId: otherId, tenantId } },
  { label: 'absent required company', trustedScope: { tenantId } },
])('rejects trusted scope with $label', ({ trustedScope }) => {
  expect(acceptsRetailEnrollmentDecision(persistedEvaluation(), evidence, trustedScope)).toBe(false);
});

it.each([
  { label: 'unknown subject rule', overrides: { subjectEligibilityVersion: 'party-concrete-subject.v999' } },
  { label: 'unknown type rule', overrides: { typeRuleVersion: 'party-subject-type.v999' } },
  { label: 'declared subject rule', overrides: { subjectEligibilityVersion: 'party-concrete-subject.v2' } },
  { label: 'declared type rule', overrides: { typeRuleVersion: 'party-subject-type.v2' } },
  { label: 'missing subject version', overrides: { subjectEligibilityVersion: '' } },
  { label: 'missing type version', overrides: { typeRuleVersion: '' } },
])('rejects $label even on an otherwise valid actor proof', ({ overrides }) => {
  expect(acceptsRetailEnrollmentDecision(persistedEvaluation(overrides), evidence, scope)).toBe(false);
});

it.each([
  { label: 'unverified email', overrides: { emailOwnership: 'UNVERIFIED' } },
  { label: 'another authentication namespace', overrides: { authenticationNamespaceId: 'another-provider' } },
  { label: 'guest journey', overrides: { journey: 'GUEST_CHECKOUT' } },
])('rejects $label at the public enrollment schema boundary', ({ overrides }) => {
  expect(() => Schema.decodeUnknownSync(RetailEnrollmentEvidenceSchema)({ ...evidence, ...overrides })).toThrow();
});
