import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  SourceProcessingContextSchema,
  SourceProcessingEligibilityRequestSchema,
} from '../../shared/apis/source-processing-eligibility.ts';
import {
  PrivacyApplicabilityPolicySchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import type { SourceProcessingEligibilityRequest } from '../../shared/apis/source-processing-eligibility.ts';
import {
  evaluateSourceProcessingEligibility,
  sourceCreatedPartyPersonsMatch,
  sourceSubjectMatchesRequest,
} from '../../src/api/source-processing-eligibility.read.ts';
import type { SourceProcessingEligibilityServices } from '../../src/api/source-processing-eligibility.read.ts';
import { evaluatePrivacyEligibility } from '../../shared/domain/privacy-processing-eligibility.ts';
import type { ResolvePrivacyEligibilityInputsInput } from '../../shared/domain/privacy-processing-eligibility.ts';
import { CreatePrivacySubjectPayloadSchema } from '../../shared/actions/create-privacy-subject.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import { AntiResurrectionProtectionSchema } from '../../shared/domain/anti-resurrection.ts';
import { makeSourceProcessingFixture } from '../support/source-processing-fixture.ts';

const ids = {
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  principalId: '10000000-0000-4000-8000-000000000003',
  tenantId: '10000000-0000-4000-8000-000000000001',
};
const fixture = makeSourceProcessingFixture(ids);
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    ...ids,
    authBindingId: '10000000-0000-4000-8000-000000000004',
    authContextRef: 'fixture:source-processing',
    authenticationNamespaceId: 'core.staff',
    authMethod: 'session',
  }),
  correlationId: 'fixture:source-processing',
};
const currentness = { authoritative: true, observedAt: fixture.from, revision: '1', sourceRef: 'fixture:owner-ledger' };
const trustedInputs: ResolvePrivacyEligibilityInputsInput = {
  ...ids,
  applicability: fixture.decision,
  applicabilityCurrentness: currentness,
  applicabilityScope: fixture.context.applicabilityAuthority.scope,
  asOf: fixture.evaluatedAt,
  consent: null,
  consentCurrentness: null,
  intendedScope: fixture.context.intendedScope,
  legalBasis: {
    basisRef: 'legal-basis:contract',
    basisVersion: 'fixture:explicit:1',
    currentness,
    scope: fixture.context.intendedScope,
  },
  objection: {
    currentness,
    objectionRef: 'fixture:objection:absent',
    scope: fixture.context.intendedScope,
    status: 'ABSENT',
  },
  restriction: {
    currentness,
    restrictionRef: 'fixture:restriction:absent',
    scope: fixture.context.intendedScope,
    status: 'ABSENT',
  },
};
const services = (input = trustedInputs): SourceProcessingEligibilityServices => ({
  contexts: [fixture.context],
  protections: () =>
    Effect.succeed({ items: [], sourceSubjectRefs: [fixture.context.intendedScope.subjectRef.resourceId] }),
  purposes: { get: () => Effect.succeed(Option.some(fixture.purpose)) },
  repository: {
    listApplicabilityDecisions: () => Effect.succeed([fixture.decision]),
    listApplicabilityPolicies: () => Effect.succeed([fixture.policy]),
    resolveEligibilityInputs: () => Effect.succeed({ authoritativeReferences: [], input, policyRevisions: [] }),
  },
  subjectExists: () => Effect.succeed(true),
});
const run = (
  value = services(),
  request: SourceProcessingEligibilityRequest = fixture.request,
  callerAppId?: string,
  requestScope: typeof scope = scope,
) => evaluateSourceProcessingEligibility(request, requestScope, value, fixture.evaluatedAt, callerAppId);

/** Party Registry's recovery context for the original create of the fixture's exact source occurrence. */
const sourceCreatedPartyRecovery = () => {
  const recoveryRequest: SourceProcessingEligibilityRequest = { ...fixture.request, operation: 'RECOVER_CREATE' };
  const intendedScope = { ...fixture.context.intendedScope, operation: 'RECOVER_CREATE' };
  const authority = fixture.context.applicabilityAuthority;
  const applicabilityScope = { ...authority.scope, operation: intendedScope.operation };
  const policy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
    ...fixture.policy,
    policyKey: 'source:internal-recovery',
    scopeKey: fixture.policy.scopeKey.replace(/:CREATE$/u, ':RECOVER_CREATE'),
  });
  const decision = resolvePrivacyApplicability({
    authority: authority.authority,
    authorityEvidenceRefs: authority.evidenceRefs,
    authorityReceiptRef: authority.receiptRef,
    evaluatedAt: fixture.from,
    policies: [policy],
    proposedActivity: true,
    scope: applicabilityScope,
  });
  const context = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
    ...fixture.context,
    applicabilityAuthority: { ...authority, scope: applicabilityScope },
    authorityIncarnation: 'fixture:incarnation:recovery',
    intendedScope,
    request: recoveryRequest,
    targetAdmission: 'SOURCE_CREATED_PARTY',
  });
  const inputs: ResolvePrivacyEligibilityInputsInput = {
    ...trustedInputs,
    applicability: decision,
    applicabilityScope,
    intendedScope,
    legalBasis: {
      basisRef: 'legal-basis:contract',
      basisVersion: 'fixture:recovery',
      currentness,
      scope: intendedScope,
    },
    objection: { currentness, objectionRef: 'fixture:recovery-objection', scope: intendedScope, status: 'ABSENT' },
    restriction: {
      currentness,
      restrictionRef: 'fixture:recovery-restriction',
      scope: intendedScope,
      status: 'ABSENT',
    },
  };
  const sourceSubject = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
    createdAt: fixture.from,
    subject: { kind: 'SOURCE_ASSERTED', source: fixture.request.source },
    subjectRef: fixture.context.intendedScope.subjectRef,
    updatedAt: fixture.from,
  });
  const value: SourceProcessingEligibilityServices = {
    ...services(inputs),
    contexts: [fixture.context, context],
    repository: {
      ...services(inputs).repository,
      listApplicabilityDecisions: () => Effect.succeed([fixture.decision, decision]),
      listApplicabilityPolicies: () => Effect.succeed([fixture.policy, policy]),
    },
    // The stored subject is the exact source-asserted one; the real rule decides whether it may serve this request.
    subjectExists: (_subject, observed, mode) =>
      Effect.succeed(sourceSubjectMatchesRequest(sourceSubject, observed, mode)),
  };
  return { context, recoveryRequest, sourceSubject, value };
};

describe('current exact source processing eligibility', () => {
  it.effect('binds a recovery hash to the decoded native request and rejects extra control fields', () =>
    Effect.gen(function* normalizedRecoveryInput() {
      const decode = Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema, {
        onExcessProperty: 'error',
      });
      const decodedInput = yield* decode(fixture.request);
      expect(computeCanonicalValueHash(decodedInput)).not.toBe(computeCanonicalValueHash({ payload: decodedInput }));
      const injected = { ...fixture.request, principalId: ids.principalId };
      const rejected = yield* decode(injected).pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
    }),
  );
  it.effect('binds an unknown Retail creation target only through its explicit original Party source receipt', () =>
    Effect.gen(function* profileCreationSelector() {
      const partySourceReference = {
        occurrenceId: 'party-create:one',
        recordId: 'party-record:one',
        source: { ...fixture.request.source, namespace: 'party-records' },
      };
      const { occurrenceId: _occurrenceId, recordId: _recordId, ...partySource } = partySourceReference.source;
      const reference = { ...partySourceReference, source: partySource };
      const planRequest: SourceProcessingEligibilityRequest = {
        consumerModuleId: 'commerce.customer-context',
        operation: 'PROFILE_CREATE',
        partySourceReference: reference,
        source: fixture.request.source,
        target: null,
      };
      const intendedScope = { ...fixture.context.intendedScope, operation: 'PROFILE_CREATE' };
      const applicabilityScope = {
        ...fixture.context.applicabilityAuthority.scope,
        operation: intendedScope.operation,
      };
      const policy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
        ...fixture.policy,
        scopeKey: fixture.policy.scopeKey.replace(/:CREATE$/u, ':PROFILE_CREATE'),
      });
      const authority = fixture.context.applicabilityAuthority;
      const decision = resolvePrivacyApplicability({
        authority: authority.authority,
        authorityEvidenceRefs: authority.evidenceRefs,
        authorityReceiptRef: authority.receiptRef,
        evaluatedAt: fixture.from,
        policies: [policy],
        proposedActivity: true,
        scope: applicabilityScope,
      });
      const context = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
        ...fixture.context,
        applicabilityAuthority: { ...authority, scope: applicabilityScope },
        intendedScope,
        request: planRequest,
        targetAdmission: 'CURRENT_SOURCE_PERSON',
      });
      const inputs: ResolvePrivacyEligibilityInputsInput = {
        ...trustedInputs,
        applicability: decision,
        applicabilityScope,
        intendedScope,
        legalBasis: {
          basisRef: 'legal-basis:contract',
          basisVersion: 'fixture:explicit-profile-basis',
          currentness,
          scope: intendedScope,
        },
        objection: {
          currentness,
          objectionRef: 'fixture:profile-objection:absent',
          scope: intendedScope,
          status: 'ABSENT',
        },
        restriction: {
          currentness,
          restrictionRef: 'fixture:profile-restriction:absent',
          scope: intendedScope,
          status: 'ABSENT',
        },
      };
      const partyId = '20000000-0000-4000-8000-000000000025';
      const request: SourceProcessingEligibilityRequest = {
        ...planRequest,
        target: { kind: 'PARTY', resourceId: partyId },
      };
      const profileServices: SourceProcessingEligibilityServices = {
        ...services(inputs),
        contexts: [context],
        repository: {
          ...services(inputs).repository,
          listApplicabilityDecisions: () => Effect.succeed([decision]),
          listApplicabilityPolicies: () => Effect.succeed([policy]),
        },
        subjectExists: (_subject, observed, mode) =>
          Effect.sync(() => {
            expect(mode).toBe('CURRENT_SOURCE_PERSON');
            expect(observed.partySourceReference).toEqual(reference);
            return observed.target?.resourceId === partyId;
          }),
      };
      expect((yield* run(profileServices, request)).outcome).toBe('ALLOWED');
      expect(
        (yield* run(profileServices, {
          ...request,
          target: { kind: 'PARTY', resourceId: '20000000-0000-4000-8000-000000000026' },
        })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* run(profileServices, { ...request, source: { ...fixture.request.source, occurrenceId: 'different' } }))
          .outcome,
      ).toBe('DENIED');
      expect(
        (yield* run(profileServices, { ...request, partySourceReference: { ...reference, occurrenceId: 'different' } }))
          .outcome,
      ).toBe('DENIED');
      expect((yield* run({ ...profileServices, contexts: [] }, request)).outcome).toBe('DENIED');
      const targetSubject = '20000000-0000-4000-8000-000000000027';
      const targetProtection = Schema.decodeUnknownSync(AntiResurrectionProtectionSchema)({
        contentScopeRefs: context.contentScopeRefs,
        enforcementReceipt: {
          authorityRef: 'fixture:target-enforcement',
          contentScopeRefs: context.contentScopeRefs,
          evidenceRefs: ['fixture:target-owner-enforced'],
          measure: 'DELETE',
          operations: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
          ownerModuleId: 'party.registry',
          receiptRef: 'fixture:target-enforced',
          resourceRefs: [partyId],
          subjectRef: targetSubject,
          taskId: 'fixture:target-task',
          tenantId: ids.tenantId,
        },
        evidenceRefs: ['fixture:target-deletion'],
        measure: 'DELETE',
        outcomeStatus: 'SUCCEEDED',
        ownerExecutionOutcomeRef: 'fixture:target-deleted',
        protectedAt: fixture.from,
        protectionId: 'fixture:target-protection',
        resourceRefs: [partyId],
        sourceDecisionRef: 'fixture:target-decision',
        sourceDecisionRevision: 1,
        subjectRef: targetSubject,
        tenantId: ids.tenantId,
      });
      expect(
        yield* run(
          {
            ...profileServices,
            protections: () =>
              Effect.succeed({
                items: [targetProtection],
                sourceSubjectRefs: [context.intendedScope.subjectRef.resourceId],
              }),
          },
          request,
        ),
      ).toMatchObject({ outcome: 'DENIED', reason: 'PROTECTED_MATERIAL' });
    }),
  );
  it('never uses the company ICO applicability marker as permission for personal processing', () => {
    const outcome = evaluatePrivacyEligibility({
      ...trustedInputs,
      applicability: {
        ...fixture.decision,
        nonPersonalApplicability: {
          allowedFields: ['normalizedValue'],
          fieldContractVersion: 'party.registry.organization-ico-business-fields.v1',
          holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
          kind: 'ORGANIZATION_ICO_ONLY',
        },
      },
    });
    expect(outcome.outcome).not.toBe('ALLOWED');
  });

  it('never uses an accepted organization business source classification as personal processing permission', () => {
    const outcome = evaluatePrivacyEligibility({
      ...trustedInputs,
      applicability: {
        ...fixture.decision,
        nonPersonalApplicability: {
          allowedFields: ['candidate.businessName'],
          classification: 'SOURCE_ASSERTED_ORGANIZATION',
          consumerModuleId: 'party.registry',
          holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
          kind: 'ORGANIZATION_BUSINESS_ONLY',
          operation: 'CREATE',
          projectionVersion: 'party.registry.organization-business-source-fields.v1',
        },
      },
    });
    expect(outcome.outcome).not.toBe('ALLOWED');
  });

  it.effect('keeps source subjects truthful and exact without Party identity or anonymous-session substitution', () =>
    Effect.gen(function* test() {
      const record = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
        createdAt: fixture.from,
        subject: { kind: 'SOURCE_ASSERTED', source: fixture.request.source },
        subjectRef: fixture.context.intendedScope.subjectRef,
        updatedAt: fixture.from,
      });
      expect(sourceSubjectMatchesRequest(record, fixture.request)).toBe(true);
      expect(
        sourceSubjectMatchesRequest(record, {
          ...fixture.request,
          source: { ...fixture.request.source, recordId: 'other' },
        }),
      ).toBe(false);
      expect(
        sourceSubjectMatchesRequest(record, {
          ...fixture.request,
          target: { kind: 'PARTY', resourceId: 'party:other' },
        }),
      ).toBe(false);
      const wire = { subject: record.subject, subjectRef: record.subjectRef };
      const decoded = yield* Schema.decodeUnknownEffect(CreatePrivacySubjectPayloadSchema)(wire);
      expect(yield* Schema.encodeEffect(CreatePrivacySubjectPayloadSchema)(decoded)).toEqual(wire);
      const anonymous = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
        ...record,
        subject: {
          anonymousContext: {
            addressability: 'SESSION',
            contextRef: 'session:actual',
            createdAt: fixture.from,
            expiresAt: fixture.until,
            kind: 'ANONYMOUS_PRIVACY_CONTEXT',
            provenance: { method: 'SESSION', source: 'test' },
          },
          kind: 'ANONYMOUS',
        },
      });
      expect(sourceSubjectMatchesRequest(anonymous, fixture.request)).toBe(false);
    }),
  );
  it('binds Party inventory to the actual Data Subject Party reference', () => {
    const record = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
      createdAt: fixture.from,
      subject: {
        kind: 'DATA_SUBJECT',
        partyRef: {
          moduleId: 'party.registry',
          resourceId: '20000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.party',
          tenantId: ids.tenantId,
        },
      },
      subjectRef: fixture.context.intendedScope.subjectRef,
      updatedAt: fixture.from,
    });
    const request: SourceProcessingEligibilityRequest = {
      ...fixture.request,
      source: null,
      target: { kind: 'PARTY', resourceId: '20000000-0000-4000-8000-000000000001' },
    };
    expect(sourceSubjectMatchesRequest(record, request)).toBe(true);
    expect(
      sourceSubjectMatchesRequest(record, {
        ...request,
        target: { kind: 'PARTY', resourceId: '20000000-0000-4000-8000-000000000002' },
      }),
    ).toBe(false);
  });
  it('does not let an independently enrolled intake source claim a concrete personal target', () => {
    const source = { ...fixture.request.source, recordId: 'fixture:independently-enrolled-alias' };
    const alias = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
      createdAt: fixture.from,
      subject: { kind: 'SOURCE_ASSERTED', source },
      subjectRef: fixture.context.intendedScope.subjectRef,
      updatedAt: fixture.from,
    });
    const request = Schema.decodeUnknownSync(SourceProcessingEligibilityRequestSchema)({
      consumerModuleId: 'integration.symmy',
      operation: 'CUSTOMER_SOURCE_INTAKE',
      source,
      target: null,
    });
    expect(sourceSubjectMatchesRequest(alias, request)).toBe(true);
    for (const kind of [
      'RETAIL_CUSTOMER_PROFILE',
      'COUNTERPARTY_PURCHASING_PROFILE',
      'PARTY_CONTACT_POINT',
      'COUNTERPARTY',
    ] as const) {
      expect(sourceSubjectMatchesRequest(alias, { ...request, target: { kind, resourceId: 'existing-target' } })).toBe(
        false,
      );
    }
  });
  it.effect('admits Party Registry recovering the Party its exact source occurrence created, and nothing wider', () =>
    Effect.gen(function* sourceCreatedParty() {
      const { context, recoveryRequest, value } = sourceCreatedPartyRecovery();
      const partyId = '20000000-0000-4000-8000-000000000031';
      const request: SourceProcessingEligibilityRequest = {
        ...recoveryRequest,
        target: { kind: 'PARTY', resourceId: partyId },
      };
      const caller = 'party-registry';
      expect((yield* run(value, request, caller)).outcome).toBe('ALLOWED');
      const signedCaller = { appId: caller };
      const refused = (
        variant: SourceProcessingEligibilityRequest,
        recoveryServices: SourceProcessingEligibilityServices = value,
        callerAppId: { readonly appId: string | undefined } = signedCaller,
        requestScope: typeof scope = scope,
      ) => run(recoveryServices, variant, callerAppId.appId, requestScope).pipe(Effect.map(({ outcome }) => outcome));
      // Another source: another occurrence, record or issuer of the same route.
      for (const source of [
        { ...fixture.request.source, occurrenceId: 'occurrence:two' },
        { ...fixture.request.source, recordId: 'client:two' },
        { ...fixture.request.source, issuer: 'internal:other-issuer' },
      ]) {
        expect(yield* refused({ ...request, source })).toBe('DENIED');
      }
      // A native request has no source occurrence to recover.
      expect(yield* refused({ ...request, source: null })).toBe('DENIED');
      // Another tenant.
      const foreignScope = {
        ...scope,
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          ...ids,
          authBindingId: '10000000-0000-4000-8000-000000000004',
          authContextRef: 'fixture:source-processing',
          authenticationNamespaceId: 'core.staff',
          authMethod: 'session',
          tenantId: '10000000-0000-4000-8000-000000000099',
        }),
      };
      expect(yield* refused(request, value, signedCaller, foreignScope)).toBe('DENIED');
      // Another consumer module: neither its word nor its signed calling module may use the admission.
      expect(yield* refused({ ...request, consumerModuleId: 'commerce.customer-context' })).toBe('DENIED');
      for (const appId of ['commerce-customer-context', 'symmy-integration', undefined]) {
        expect(yield* refused(request, value, { appId })).toBe('DENIED');
      }
      // Another operation with the same Party target, and a duplicate-candidate target.
      for (const operation of ['CREATE', 'EVIDENCE_READ', 'MATCH', 'PROFILE_EXPORT']) {
        expect(yield* refused({ ...request, operation })).toBe('DENIED');
      }
      expect(yield* refused({ ...request, target: { kind: 'DUPLICATE_CANDIDATE', resourceId: partyId } })).toBe(
        'DENIED',
      );
      // Privacy's own record of the original create must exist for the same subject and principal.
      expect(yield* refused(request, { ...value, contexts: [context] })).toBe('DENIED');
      const otherSubject = {
        ...fixture.context,
        intendedScope: {
          ...fixture.context.intendedScope,
          subjectRef: {
            ...fixture.context.intendedScope.subjectRef,
            resourceId: '10000000-0000-4000-8000-000000000099',
          },
        },
      };
      expect(yield* refused(request, { ...value, contexts: [otherSubject, context] })).toBe('DENIED');
      const otherPrincipal = { ...fixture.context, principalId: '10000000-0000-4000-8000-000000000098' };
      expect(yield* refused(request, { ...value, contexts: [otherPrincipal, context] })).toBe('DENIED');
      // A Party whose persons Privacy did not admit from this exact source subject.
      expect(yield* refused(request, { ...value, subjectExists: () => Effect.succeed(false) })).toBe('DENIED');
    }),
  );
  it('binds the source created Party admission to the exact source-asserted subject and its own persons', () => {
    const { recoveryRequest, sourceSubject } = sourceCreatedPartyRecovery();
    const partyRef = {
      moduleId: 'party.registry',
      resourceId: '20000000-0000-4000-8000-000000000031',
      resourceType: 'party.registry.party',
      tenantId: ids.tenantId,
    };
    const request: SourceProcessingEligibilityRequest = {
      ...recoveryRequest,
      target: { kind: 'PARTY', resourceId: partyRef.resourceId },
    };
    expect(sourceSubjectMatchesRequest(sourceSubject, request, 'SOURCE_CREATED_PARTY')).toBe(true);
    const otherSource = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
      ...sourceSubject,
      subject: { kind: 'SOURCE_ASSERTED', source: { ...fixture.request.source, recordId: 'client:two' } },
    });
    const anonymous = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
      ...sourceSubject,
      subject: {
        anonymousContext: {
          addressability: 'SESSION',
          contextRef: 'session:actual',
          createdAt: fixture.from,
          expiresAt: fixture.until,
          kind: 'ANONYMOUS_PRIVACY_CONTEXT',
          provenance: { method: 'SESSION', source: 'test' },
        },
        kind: 'ANONYMOUS',
      },
    });
    const dataSubject = (sourceSubjectId: string) =>
      Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
        ...sourceSubject,
        subject: {
          kind: 'DATA_SUBJECT',
          partyRef,
          sourceAdmission: {
            occurrenceId: 'occurrence:one',
            sourceSubjectRef: { ...sourceSubject.subjectRef, resourceId: sourceSubjectId },
          },
        },
        subjectRef: { ...sourceSubject.subjectRef, resourceId: '10000000-0000-4000-8000-000000000041' },
      });
    for (const subject of [otherSource, anonymous, dataSubject(sourceSubject.subjectRef.resourceId)]) {
      expect(sourceSubjectMatchesRequest(subject, request, 'SOURCE_CREATED_PARTY')).toBe(false);
    }
    for (const variant of [
      { ...request, consumerModuleId: 'commerce.customer-context' as const },
      { ...request, operation: 'EVIDENCE_READ' },
      { ...request, target: { kind: 'DUPLICATE_CANDIDATE' as const, resourceId: partyRef.resourceId } },
      { ...request, target: null },
    ]) {
      expect(sourceSubjectMatchesRequest(sourceSubject, variant, 'SOURCE_CREATED_PARTY')).toBe(false);
    }
    // Privacy's own persons on the Party: none yet, or only those admitted from this exact source subject.
    expect(sourceCreatedPartyPersonsMatch([], sourceSubject.subjectRef)).toBe(true);
    expect(
      sourceCreatedPartyPersonsMatch([dataSubject(sourceSubject.subjectRef.resourceId)], sourceSubject.subjectRef),
    ).toBe(true);
    expect(
      sourceCreatedPartyPersonsMatch(
        [dataSubject(sourceSubject.subjectRef.resourceId), dataSubject('10000000-0000-4000-8000-000000000042')],
        sourceSubject.subjectRef,
      ),
    ).toBe(false);
    // The ordinary Party-target rule is unchanged: without the admission only a linked Data Subject serves it.
    expect(sourceSubjectMatchesRequest(sourceSubject, request)).toBe(false);
    expect(sourceSubjectMatchesRequest(dataSubject(sourceSubject.subjectRef.resourceId), request)).toBe(true);
    expect(
      sourceSubjectMatchesRequest(dataSubject(sourceSubject.subjectRef.resourceId), {
        ...request,
        target: { kind: 'PARTY', resourceId: '20000000-0000-4000-8000-000000000032' },
      }),
    ).toBe(false);
  });
  it('limits the source created Party admission to Party Registry recovering one exact source create', () => {
    const { context } = sourceCreatedPartyRecovery();
    const decode = Schema.decodeUnknownResult(SourceProcessingContextSchema);
    const encoded = Schema.encodeSync(SourceProcessingContextSchema)(context);
    expect(Result.isSuccess(decode(encoded))).toBe(true);
    for (const request of [
      { ...encoded.request, consumerModuleId: 'commerce.customer-context' },
      { ...encoded.request, operation: 'EVIDENCE_READ' },
      { ...encoded.request, target: { kind: 'PARTY', resourceId: 'party:fixed' } },
      { ...encoded.request, source: null },
    ]) {
      expect(Result.isFailure(decode({ ...encoded, request }))).toBe(true);
    }
    expect(
      Result.isFailure(decode({ ...encoded, intendedScope: { ...encoded.intendedScope, operation: 'CREATE' } })),
    ).toBe(true);
  });
  it.effect('evaluates explicit current owner facts without fabricating consent', () =>
    run().pipe(Effect.map((result) => expect(result.outcome).toBe('ALLOWED'))),
  );
  it.effect('accepts an exact native owner context without inventing an external issuer', () => {
    const request: SourceProcessingEligibilityRequest = {
      ...fixture.request,
      source: null,
      target: { kind: 'PARTY', resourceId: 'fixture:party' },
    };
    const context = { ...fixture.context, request, resourceRefs: ['fixture:party'] };
    return run({ ...services(), contexts: [context] }, request).pipe(
      Effect.map((result) => expect(result.outcome).toBe('ALLOWED')),
    );
  });
  it.effect('denies absent subjects, mismatched targets and ambiguous current contexts', () =>
    Effect.gen(function* test() {
      expect((yield* run({ ...services(), subjectExists: () => Effect.succeed(false) })).outcome).toBe('DENIED');
      expect(
        (yield* run({ ...services(), contexts: [fixture.context, { ...fixture.context, authorityRevision: 'other' }] }))
          .outcome,
      ).toBe('DENIED');
      expect(
        (yield* run(services(), { ...fixture.request, target: { kind: 'PARTY', resourceId: 'unbound:party' } }))
          .outcome,
      ).toBe('DENIED');
    }),
  );
  it.effect('revokes immediately when the current configuration removes the binding', () =>
    run({ ...services(), contexts: [] }).pipe(Effect.map((result) => expect(result.outcome).toBe('DENIED'))),
  );
  it.effect('denies changed occurrences and foreign issuers before resolving subject details', () =>
    Effect.gen(function* test() {
      for (const source of [
        { ...fixture.request.source, occurrenceId: 'other' },
        { ...fixture.request.source, issuer: 'other' },
      ]) {
        const result = yield* run(
          {
            ...services(),
            repository: {
              ...services().repository,
              listApplicabilityDecisions: () => Effect.die('must not resolve details'),
            },
          },
          { ...fixture.request, source },
        );
        expect(result.outcome).toBe('DENIED');
      }
    }),
  );
  it.effect('denies expired context, changed current policy and superseding unresolved decisions', () =>
    Effect.gen(function* test() {
      const expired = yield* run({
        ...services(),
        contexts: [{ ...fixture.context, validUntil: fixture.evaluatedAt }],
      });
      expect(expired.outcome).toBe('DENIED');
      const noPolicy = yield* run({
        ...services(),
        repository: { ...services().repository, listApplicabilityPolicies: () => Effect.succeed([]) },
      });
      expect(noPolicy.outcome).toBe('DENIED');
      const newer = yield* run({
        ...services(),
        repository: {
          ...services().repository,
          listApplicabilityDecisions: () =>
            Effect.succeed([
              fixture.decision,
              { ...fixture.decision, evaluatedAt: fixture.evaluatedAt, outcome: 'UNRESOLVED' },
            ]),
        },
      });
      expect(newer.outcome).toBe('DENIED');
    }),
  );
  it.effect('denies active restriction and missing legal basis under an otherwise current source binding', () =>
    Effect.gen(function* test() {
      for (const inputs of [
        { ...trustedInputs, legalBasis: null },
        {
          ...trustedInputs,
          restriction: {
            currentness,
            restrictionRef: 'fixture:restriction:active',
            scope: fixture.context.intendedScope,
            status: 'ACTIVE' as const,
          },
        },
      ]) {
        expect((yield* run(services(inputs))).outcome).toBe('DENIED');
      }
    }),
  );
  it.effect('blocks erased protected material on source replay', () => {
    const protection = Schema.decodeUnknownSync(AntiResurrectionProtectionSchema)({
      contentScopeRefs: ['party:name'],
      enforcementReceipt: {
        authorityRef: 'fixture:enforcement',
        contentScopeRefs: ['party:name'],
        evidenceRefs: ['fixture:owner-enforced'],
        measure: 'DELETE',
        operations: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
        ownerModuleId: 'party.registry',
        receiptRef: 'fixture:enforced',
        resourceRefs: fixture.context.resourceRefs,
        subjectRef: fixture.context.intendedScope.subjectRef.resourceId,
        taskId: 'fixture:task',
        tenantId: ids.tenantId,
      },
      evidenceRefs: ['fixture:deletion'],
      measure: 'DELETE',
      outcomeStatus: 'SUCCEEDED',
      ownerExecutionOutcomeRef: 'fixture:deleted',
      protectedAt: fixture.from,
      protectionId: 'fixture:protection',
      resourceRefs: fixture.context.resourceRefs,
      sourceDecisionRef: 'fixture:decision',
      sourceDecisionRevision: 1,
      subjectRef: fixture.context.intendedScope.subjectRef.resourceId,
      tenantId: ids.tenantId,
    });
    const protectedServices = {
      ...services(),
      protections: () =>
        Effect.succeed({
          items: [protection],
          sourceSubjectRefs: [fixture.context.intendedScope.subjectRef.resourceId],
        }),
      subjectExists: () => Effect.die('Protected material must not be sent for live Party proof'),
    };
    return Effect.all([
      run(protectedServices),
      run({
        ...protectedServices,
        contexts: [{ ...fixture.context, contentScopeRefs: ['renamed:new-source-projection'] }],
      }),
    ]).pipe(
      Effect.map((results) => {
        for (const result of results) {
          expect(result).toMatchObject({ outcome: 'DENIED', reason: 'PROTECTED_MATERIAL' });
        }
        return results;
      }),
    );
  });
});
