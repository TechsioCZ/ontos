import { DateTime, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { RetailEnrollmentEvidenceSchema } from '../../shared/actions/accept-retail-enrollment-evidence.ts';
import type { PartyCandidate } from '../../shared/domain/identity-contracts.ts';
import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import { acceptRetailEnrollmentEvidenceAction } from '../../src/actions/accept-retail-enrollment-evidence.action.ts';
import { acceptsRetailEnrollmentEvidence } from '../../src/policies/retail-enrollment-evidence.policy.ts';
import { decideAtomicCreateWithoutStrongIdentifier } from '../../src/services/party-matching-persistence.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
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
const candidate: PartyCandidate = {
  evidenceRefs: [evidence.candidateEvidenceRef],
  officialIdentifiers: [],
  partyType: 'PERSON',
  provenance: { method: 'commerce.portal-enrollment.self-enrollment', source: 'commerce.customer-context' },
  subjectEvidence: [
    {
      basis: 'DIRECT_INTERACTION',
      evidenceRef: evidence.candidateEvidenceRef,
      kind: 'ACTOR_ATTESTATION',
      observedSubject: 'PERSON',
      statement: 'This exact provider subject enrolled',
      subjectKey: partySubjectKeyFromString(evidence.providerSubjectId),
    },
  ],
  validFrom: DateTime.makeUnsafe('2026-10-01T00:00:00.000Z'),
};
const scope = { legalEntityId, tenantId };

it('accepts verified retail person evidence only when no candidate Party is linked', () => {
  expect(acceptsRetailEnrollmentEvidence(candidate, evidence, scope, [])).toBe(true);
  expect(acceptsRetailEnrollmentEvidence(candidate, evidence, scope, [legalEntityId])).toBe(false);
});

it('does not relax normal no-identifier creation or claim that identity review happened', () => {
  expect(decideAtomicCreateWithoutStrongIdentifier(candidate, false).decision).toBe('REVIEW_REQUIRED');
  expect(acceptRetailEnrollmentEvidenceAction.descriptor.tenantPermission).toBeDefined();
  expect(acceptRetailEnrollmentEvidenceAction.descriptor.entrypoint.authorization).toEqual({
    kind: 'action_execution',
    provisioning: 'explicit',
  });
});

it('rejects another company, tenant, subject, evidence reference, non-person and guest provenance', () => {
  expect(acceptsRetailEnrollmentEvidence(candidate, evidence, { ...scope, tenantId: legalEntityId }, [])).toBe(false);
  expect(acceptsRetailEnrollmentEvidence(candidate, evidence, { ...scope, legalEntityId: tenantId }, [])).toBe(false);
  expect(
    acceptsRetailEnrollmentEvidence(candidate, { ...evidence, providerSubjectId: 'other-subject' }, scope, []),
  ).toBe(false);
  expect(acceptsRetailEnrollmentEvidence(candidate, { ...evidence, candidateEvidenceRef: tenantId }, scope, [])).toBe(
    false,
  );
  expect(acceptsRetailEnrollmentEvidence({ ...candidate, partyType: 'ORGANIZATION' }, evidence, scope, [])).toBe(false);
  expect(
    acceptsRetailEnrollmentEvidence(
      { ...candidate, provenance: { method: 'guest-checkout', source: 'storefront' } },
      evidence,
      scope,
      [],
    ),
  ).toBe(false);
});

it('rejects unverified email and another provider namespace at the public schema boundary', () => {
  expect(() =>
    Schema.decodeUnknownSync(RetailEnrollmentEvidenceSchema)({ ...evidence, emailOwnership: 'UNVERIFIED' }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(RetailEnrollmentEvidenceSchema)({
      ...evidence,
      authenticationNamespaceId: 'other-provider',
    }),
  ).toThrow();
});

it('accepts missing Party work on an existing-account restart without pretending a new provider account was created', () => {
  const restart = Schema.decodeSync(RetailEnrollmentEvidenceSchema)({
    ...evidence,
    journey: 'EXISTING_ACCOUNT',
  });
  expect(acceptsRetailEnrollmentEvidence(candidate, restart, scope, [])).toBe(true);
  expect(acceptsRetailEnrollmentEvidence(candidate, restart, scope, [legalEntityId])).toBe(false);
  expect(acceptsRetailEnrollmentEvidence(candidate, restart, { ...scope, legalEntityId: tenantId }, [])).toBe(false);
  expect(
    acceptsRetailEnrollmentEvidence(candidate, { ...restart, providerSubjectId: 'other-subject' }, scope, []),
  ).toBe(false);
});
