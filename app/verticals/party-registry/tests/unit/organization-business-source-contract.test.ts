import { Effect, Exit } from 'effect';
import type { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  OrganizationBusinessSourceProjectionVersion,
  OrganizationBusinessCorrectionPolicyVersion,
  OrganizationBusinessCounterpartyContextReason,
  OrganizationBusinessOnboardTemplateProjectionVersion,
  organizationBusinessOnboardTemplateDigest,
  organizationBusinessRecordInputDigest,
  OrganizationBusinessSourceStatement,
  organizationBusinessSourceInputDigest,
} from '../../shared/apis/organization-record-facts.ts';
import { counterpartyCustomerOnboardRequestIdentity } from '../../shared/domain/native-action-request-identity.ts';
import { fingerprintPartySourceEffect as sharedFingerprint } from '../../shared/domain/source-fingerprint.ts';
import { fingerprintPartySourceEffect as nativeFingerprint } from '../../src/services/party-source-effect.service.ts';

const source = {
  issuer: 'INTERNAL',
  namespace: 'organizations',
  recordType: 'organization',
  routeRef: 'INTERNAL_ROUTE',
};
const input = (operation: 'CREATE' | 'MATCH' = 'CREATE') => ({
  operation,
  payload: {
    candidate: {
      partyType: 'ORGANIZATION',
      businessName: 'INTERNAL business organization',
      validFrom: '2026-01-01T00:00:00.000Z',
      evidenceRefs: [],
      officialIdentifiers: [],
      provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: source.routeRef },
      subjectEvidence: [
        {
          kind: 'CLIENT_SOURCE_ASSERTION',
          observedSubject: 'ORGANIZATION',
          source,
          recordId: 'INTERNAL_RECORD',
          occurrenceId: 'INTERNAL_OCCURRENCE',
          subjectKey: 'INTERNAL_RECORD',
          statement: OrganizationBusinessSourceStatement,
          sourceObservedAt: '2026-01-01T00:00:00.000Z',
        },
      ] as const,
    },
  },
});

it.effect('the accepted source projection hashes canonical native input and preserves its qualified locator', () =>
  Effect.gen(function* canonicalSourceProjection() {
    const value = input();
    const actual = yield* organizationBusinessSourceInputDigest(value);
    const reordered = yield* organizationBusinessSourceInputDigest({
      payload: {
        candidate: {
          ...value.payload.candidate,
          provenance: { source: source.routeRef, method: 'CLIENT_SOURCE_ASSERTION' },
        },
      },
      operation: 'CREATE',
    });
    expect(actual).toEqual(reordered);
    expect(actual.projectionVersion).toBe(OrganizationBusinessSourceProjectionVersion);
    expect(actual.sourceReference).toEqual({
      source,
      recordId: 'INTERNAL_RECORD',
      occurrenceId: 'INTERNAL_OCCURRENCE',
    });
    expect(actual.inputDigest).not.toBe((yield* organizationBusinessSourceInputDigest(input('MATCH'))).inputDigest);
    expect(actual.inputDigest).not.toBe(
      (yield* organizationBusinessSourceInputDigest({
        ...value,
        payload: { candidate: { ...value.payload.candidate, businessName: 'Different organization' } },
      })).inputDigest,
    );
    expect(nativeFingerprint).toBe(sharedFingerprint);
  }),
);

const { candidate } = input().payload;
const [assertion] = candidate.subjectEvidence;
const unsafeCandidates: readonly Schema.Json[] = [
  { ...candidate, partyType: 'PERSON' },
  { ...candidate, firstName: 'Personal value' },
  { ...candidate, lastName: 'Personal value' },
  { ...candidate, email: 'unwanted@example.invalid' },
  { ...candidate, evidenceRefs: ['unbounded-evidence'] },
  { ...candidate, officialIdentifiers: [{ identifierType: 'ICO', value: '27074358' }] },
  { ...candidate, provenance: { ...candidate.provenance, method: 'SIGNED_CONTRACT' } },
  { ...candidate, provenance: { ...candidate.provenance, source: 'arbitrary text' } },
  { ...candidate, provenance: { ...candidate.provenance, externalEvidence: {} } },
  { ...candidate, subjectEvidence: [{ ...assertion, observedSubject: 'PERSON' }] },
  { ...candidate, subjectEvidence: [{ ...assertion, statement: 'Arbitrary source text' }] },
  { ...candidate, subjectEvidence: [{ ...assertion, subjectKey: 'OTHER_RECORD' }] },
  { ...candidate, subjectEvidence: [assertion, assertion] },
];
it.effect('the corporate projection refuses personal values, arbitrary evidence and invented authority', () =>
  Effect.gen(function* rejectUnsafeSourceProjection() {
    for (const unsafe of unsafeCandidates) {
      const exit = yield* organizationBusinessSourceInputDigest({
        operation: 'CREATE',
        payload: { candidate: unsafe },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }
    const priorCase = yield* organizationBusinessSourceInputDigest({
      ...input('MATCH'),
      payload: { ...input().payload, priorCaseRef: {} },
    }).pipe(Effect.exit);
    expect(Exit.isFailure(priorCase)).toBe(true);
  }),
);

const partyRef = {
  moduleId: 'party.registry',
  resourceType: 'party.registry.party',
  tenantId: '761cbd25-4960-40ae-aad0-f725597d296d',
  resourceId: 'bd408021-e445-4584-b84b-c1642aa2dc38',
};
const sourceReference = { source, recordId: assertion.recordId, occurrenceId: assertion.occurrenceId };
const onboardPayload = {
  sourceReference,
  counterpartyProvenance: {
    method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
    source: source.routeRef,
    evidenceReference: assertion.recordId,
    reason: OrganizationBusinessCounterpartyContextReason,
  },
  customerEvidence: {
    method: 'APPROVED_PURCHASING_RELATIONSHIP',
    source: source.routeRef,
    evidenceReference: assertion.recordId,
  },
  validFrom: '2026-01-01T00:00:00.000Z',
};
it.effect('bounded current commands preserve actual native evidence and refuse unsafe compatibility fields', () =>
  Effect.gen(function* boundedRecordProjections() {
    const update = {
      operation: 'UPDATE',
      payload: {
        partyRef,
        expectedRevision: 1,
        businessName: 'INTERNAL company updated',
        provenanceMethod: 'CLIENT_SOURCE_ASSERTION',
        provenanceSource: source.routeRef,
        subjectEvidence: [assertion],
        validFrom: '2026-01-01T00:00:00.000Z',
      },
    };
    const correction = {
      operation: 'CORRECTION',
      payload: {
        partyId: partyRef.resourceId,
        factKind: 'BUSINESS_NAME',
        targetAssertionId: '3063c634-b0c0-4d54-b558-83f53b25e793',
        replacementValue: 'INTERNAL company corrected',
        evidenceRefs: [assertion.recordId],
        evidenceSource: 'SYSTEM_RECONCILIATION',
        policyVersion: OrganizationBusinessCorrectionPolicyVersion,
        reasonCode: 'WRONG_IDENTITY_VALUE',
        provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: source.routeRef },
        subjectEvidence: [assertion],
      },
    };
    const onboard = { operation: 'ONBOARD_COUNTERPARTY_CUSTOMER', payload: { ...onboardPayload, partyRef } };
    for (const command of [update, correction, onboard]) {
      const proof = yield* organizationBusinessRecordInputDigest(command);
      expect(proof.sourceReference).toEqual(sourceReference);
    }
    const unsafe: readonly Schema.Json[] = [
      { ...update, payload: { ...update.payload, firstName: 'Personal' } },
      { ...update, payload: { ...update.payload, provenanceSource: 'arbitrary text' } },
      { ...correction, payload: { ...correction.payload, reasonDetail: 'arbitrary private text' } },
      { ...correction, payload: { ...correction.payload, evidenceRefs: ['unrelated-evidence'] } },
      {
        ...onboard,
        payload: {
          ...onboard.payload,
          customerEvidence: { ...onboardPayload.customerEvidence, method: 'CLIENT_SOURCE_ASSERTION' },
        },
      },
      {
        ...onboard,
        payload: {
          ...onboard.payload,
          counterpartyProvenance: { ...onboardPayload.counterpartyProvenance, evidenceReference: 'different-record' },
        },
      },
    ];
    for (const command of unsafe) {
      expect(Exit.isFailure(yield* organizationBusinessRecordInputDigest(command).pipe(Effect.exit))).toBe(true);
    }
  }),
);
it.effect(
  'deferred onboarding hashes a distinct semantic template and native materialization excludes only its validated witness',
  () =>
    Effect.gen(function* semanticOnboardTemplate() {
      const template = {
        _tag: 'OnboardCounterpartyCustomerFromParty',
        fromPartyEffect: { itemKey: 'company', effectKey: 'party' },
        payload: onboardPayload,
      };
      const semantic = yield* organizationBusinessOnboardTemplateDigest(template);
      expect(semantic.projectionVersion).toBe(OrganizationBusinessOnboardTemplateProjectionVersion);
      const changed = yield* organizationBusinessOnboardTemplateDigest({
        ...template,
        fromPartyEffect: { ...template.fromPartyEffect, effectKey: 'other-party' },
      });
      expect(changed.semanticInputDigest).not.toBe(semantic.semanticInputDigest);
      const witness = {
        originalAdmissionInvocationId: 'f10b5fd2-6865-4699-82da-b865b69890b9',
        effectId: '45bb678f-d35f-4bbb-83c5-ebf27b26e9a4',
        semanticProjectionVersion: semantic.projectionVersion,
        semanticInputDigest: semantic.semanticInputDigest,
      };
      const native = { operation: 'ONBOARD_COUNTERPARTY_CUSTOMER', payload: { ...onboardPayload, partyRef } };
      const withoutWitness = yield* organizationBusinessRecordInputDigest(native);
      const withWitness = yield* organizationBusinessRecordInputDigest({
        ...native,
        payload: { ...native.payload, sourceOrganizationWitness: witness },
      });
      expect(withWitness).toEqual(withoutWitness);
      const nativeWithout = yield* counterpartyCustomerOnboardRequestIdentity(native.payload);
      const nativeWith = yield* counterpartyCustomerOnboardRequestIdentity({
        ...native.payload,
        sourceOrganizationWitness: witness,
      });
      expect(nativeWith.normalizedPayload).toEqual({
        ...nativeWithout.normalizedPayload,
        sourceOrganizationWitness: witness,
      });
      expect(sharedFingerprint(nativeWith.normalizedPayload)).not.toBe(
        sharedFingerprint(nativeWithout.normalizedPayload),
      );

      expect(
        (yield* organizationBusinessRecordInputDigest({
          ...native,
          payload: { ...native.payload, partyRef: { ...partyRef, resourceId: 'aa1e690f-df28-4c3f-beaf-efbe638d3d8c' } },
        })).inputDigest,
      ).not.toBe(withoutWitness.inputDigest);
      for (const payload of [
        { ...onboardPayload, partyRef },
        { ...onboardPayload, sourceOrganizationWitness: witness },
      ]) {
        expect(
          Exit.isFailure(yield* organizationBusinessOnboardTemplateDigest({ ...template, payload }).pipe(Effect.exit)),
        ).toBe(true);
      }
      expect(
        Exit.isFailure(
          yield* organizationBusinessRecordInputDigest({
            ...native,
            payload: { ...native.payload, sourceOrganizationWitness: { ...witness, unsafe: 'hidden personal data' } },
          }).pipe(Effect.exit),
        ),
      ).toBe(true);
    }),
);
