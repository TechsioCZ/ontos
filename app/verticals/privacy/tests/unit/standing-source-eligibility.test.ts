import { RegisteredGatewayWorkloadSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import { trustVerifiedGatewayPrincipalContext, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { SourceProcessingEligibilityRequestSchema } from '@app/privacy-contracts/source-processing-eligibility';
import type { SourceProcessingEligibilityRequest } from '@app/privacy-contracts/source-processing-eligibility';
import {
  evaluateSourceProcessingEligibility,
  sourceSubjectMatchesRequest,
} from '../../src/api/source-processing-eligibility.read.ts';
import type { SourceProcessingEligibilityServices } from '../../src/api/source-processing-eligibility.read.ts';
import { evaluatePrivacyEligibility } from '../../shared/domain/privacy-processing-eligibility.ts';
import type {
  IntendedProcessingScope,
  ResolvePrivacyEligibilityInputsInput,
} from '../../shared/domain/privacy-processing-eligibility.ts';
import {
  AdmitSourceProcessingSubjectPayloadSchema,
  CreateSourceProcessingAuthorizationPayloadSchema,
  SourceProcessingGrantSchema,
  sourceIsOnRoute,
  sourceProcessingIntendedScope,
} from '../../shared/domain/privacy-source-processing-authorization.ts';
import type { SourceProcessingAuthorization } from '../../shared/domain/privacy-source-processing-authorization.ts';
import { CreatePrivacySubjectPayloadSchema } from '../../shared/actions/create-privacy-subject.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import { AntiResurrectionProtectionSchema } from '../../shared/domain/anti-resurrection.ts';
import { makeStandingSourceFixture } from '../support/standing-source-fixture.ts';

const ids = {
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  principalId: '10000000-0000-4000-8000-000000000003',
  tenantId: '10000000-0000-4000-8000-000000000001',
};
const fixture = makeStandingSourceFixture(ids);
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    ...ids,
    authBindingId: '10000000-0000-4000-8000-000000000004',
    authContextRef: 'fixture:source-processing',
    authenticationNamespaceId: 'core.staff',
    authMethod: 'api_key',
  }),
  correlationId: 'fixture:source-processing',
};
const currentness = { authoritative: true, observedAt: fixture.from, revision: '1', sourceRef: 'fixture:owner-ledger' };
/** The ledgers resolve for whichever subject the request resolved to; nothing here names a configured subject. */
const trustedInputs = (intendedScope: IntendedProcessingScope): ResolvePrivacyEligibilityInputsInput => ({
  ...ids,
  applicability: fixture.decision,
  applicabilityCurrentness: currentness,
  applicabilityScope: fixture.decision.evaluatedScope,
  asOf: fixture.evaluatedAt,
  consent: null,
  consentCurrentness: null,
  intendedScope,
  legalBasis: {
    basisRef: 'legal-basis:contract',
    basisVersion: 'fixture:explicit:1',
    currentness,
    scope: intendedScope,
  },
  objection: { currentness, objectionRef: 'fixture:objection:absent', scope: intendedScope, status: 'ABSENT' },
  restriction: { currentness, restrictionRef: 'fixture:restriction:absent', scope: intendedScope, status: 'ABSENT' },
});
/** Each admitted source record resolves to its own subject; no subject is configured or shared. */
const admitted = new Map([
  ['client:one', '20000000-0000-4000-8000-000000000001'],
  ['client:two', '20000000-0000-4000-8000-000000000002'],
]);
const services = (
  authorizations: readonly SourceProcessingAuthorization[] = [fixture.authorization],
  inputs: (intendedScope: IntendedProcessingScope) => ResolvePrivacyEligibilityInputsInput = trustedInputs,
): SourceProcessingEligibilityServices => ({
  authorizations: (source) =>
    Effect.succeed(authorizations.filter((authorization) => sourceIsOnRoute(authorization.source, source))),
  contexts: [],
  protections: (subjectRef) => Effect.succeed({ items: [], sourceSubjectRefs: [subjectRef] }),
  purposes: { get: () => Effect.succeed(Option.some(fixture.purpose)) },
  repository: {
    listApplicabilityDecisions: () => Effect.succeed([fixture.decision]),
    listApplicabilityPolicies: () => Effect.succeed([fixture.policy]),
    listResponsibilities: () => Effect.succeed([fixture.controller]),
    resolveEligibilityInputs: (_tenant, _legalEntity, intendedScope) =>
      Effect.succeed({ authoritativeReferences: [], input: inputs(intendedScope), policyRevisions: [] }),
  },
  resolveSubject: (request) =>
    Effect.succeed(
      Option.map(Option.fromNullishOr(admitted.get(request.source?.recordId ?? '')), (subjectId) => ({
        admittedAs: 'SUBJECT' as const,
        subjectId,
      })),
    ),
  subjectExists: () => Effect.succeed(true),
});
const subjectRefOne = {
  moduleId: 'privacy.core' as const,
  resourceId: admitted.get('client:one') ?? '',
  resourceType: 'privacy.core.privacy-subject' as const,
  tenantId: ids.tenantId,
};
const intendedScope = sourceProcessingIntendedScope(fixture.authorization.scopeTemplate, subjectRefOne);
const oneSource = { ...fixture.route, occurrenceId: 'occurrence:one', recordId: 'client:one' };
const delegated = (appId: string) =>
  trustVerifiedGatewayPrincipalContext({ ...scope }, 'e'.repeat(64), undefined, {
    appId,
    buildMarker: 'fixture',
    principalId: ids.principalId,
  });
const worker = (sourceAppId: string) =>
  trustVerifiedGatewayPrincipalContext(
    {
      ...ids,
      authContextRef: `job:integration.symmy.execute-symmy-job:run:${ids.principalId}`,
      authMethod: 'system' as const,
      correlationId: scope.correlationId,
    },
    'e'.repeat(64),
    undefined,
    undefined,
    Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema)({
      admissionInvocationId: ids.principalId,
      bindingIncarnation: ids.principalId,
      declarationKey: 'privacy.core.source-processing-eligibility.read',
      entrypointKey: 'privacy.core.api.source-processing-eligibility',
      jobKey: 'integration.symmy.execute-symmy-job',
      legalEntityId: ids.legalEntityId,
      legalEntityScope: 'required',
      originalOwnerBindingIncarnation: ids.principalId,
      originalPrincipalId: ids.principalId,
      originalWorkloadBindingIncarnation: ids.principalId,
      originalWorkloadKey: 'integration.symmy-admit',
      runReference: ids.principalId,
      schemaVersion: '1',
      sourceAppId,
      sourceBuildMarker: 'fixture',
      sourceMode: 'worker',
      workloadKey: 'privacy.core.source-processing-check',
    }),
  );
const run = (value = services(), request: SourceProcessingEligibilityRequest = fixture.request) =>
  evaluateSourceProcessingEligibility(
    request,
    delegated(
      request.consumerModuleId === 'commerce.customer-context' ? 'commerce-customer-context' : 'party-registry',
    ),
    value,
    fixture.evaluatedAt,
  );
const subjectOf = (result: Effect.Success<ReturnType<typeof run>>) =>
  result.outcome === 'ALLOWED' ? result.evidence.evaluatedScope.subjectRef.resourceId : undefined;
const protectionFor = (subjectRef: string, resourceRefs: readonly string[]) =>
  Schema.decodeUnknownSync(AntiResurrectionProtectionSchema)({
    contentScopeRefs: ['party:name'],
    enforcementReceipt: {
      authorityRef: 'fixture:enforcement',
      contentScopeRefs: ['party:name'],
      evidenceRefs: ['fixture:owner-enforced'],
      measure: 'DELETE',
      operations: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
      ownerModuleId: 'party.registry',
      receiptRef: 'fixture:enforced',
      resourceRefs,
      subjectRef,
      taskId: 'fixture:task',
      tenantId: ids.tenantId,
    },
    evidenceRefs: ['fixture:deletion'],
    measure: 'DELETE',
    outcomeStatus: 'SUCCEEDED',
    ownerExecutionOutcomeRef: 'fixture:deleted',
    protectedAt: fixture.from,
    protectionId: 'fixture:protection',
    resourceRefs,
    sourceDecisionRef: 'fixture:decision',
    sourceDecisionRevision: 1,
    subjectRef,
    tenantId: ids.tenantId,
  });

describe('standing source processing authorization', () => {
  it.effect('checks both verified owner transports, rejecting ambiguous, missing or wrong provenance', () =>
    Effect.gen(function* callerCases() {
      for (const [consumer, app, other] of [
        ['party.registry', 'party-registry', 'commerce-customer-context'],
        ['commerce.customer-context', 'commerce-customer-context', 'party-registry'],
      ] as const) {
        const request = { ...fixture.request, consumerModuleId: consumer };
        const authorization = {
          ...fixture.authorization,
          grants: fixture.authorization.grants.map((grant) => ({ ...grant, consumerModuleId: consumer })),
          principals: [
            ...fixture.authorization.principals,
            { authMethod: 'system' as const, principalId: ids.principalId },
          ],
        };
        for (const [caller, allowed] of [
          [delegated(app), true],
          [worker(app), true],
          [delegated(other), false],
          [worker(other), false],
          [scope, false],
          [{ ...scope, authMethod: 'system' as const }, false],
        ] as const) {
          expect(
            (yield* evaluateSourceProcessingEligibility(
              request,
              caller,
              services([authorization]),
              fixture.evaluatedAt,
            )).outcome,
            `${consumer} ${caller.authMethod} ${allowed}`,
          ).toBe(allowed ? 'ALLOWED' : 'DENIED');
        }
      }
    }),
  );
  it.effect('expires with its sole controller while the purpose, policy, basis and grant remain active', () =>
    Effect.gen(function* expired() {
      const s = services();
      const at = fixture.evaluatedAt;
      const c = { ...fixture.controller, effectiveTo: Option.some(at) };
      for (const assignments of [
        [c],
        [
          fixture.controller,
          {
            ...fixture.controller,
            assignmentRef: { ...fixture.controller.assignmentRef, resourceId: ids.principalId },
          },
        ],
      ]) {
        expect(
          (yield* run({
            ...s,
            repository: { ...s.repository, listResponsibilities: () => Effect.succeed(assignments) },
          })).outcome,
        ).toBe('DENIED');
      }
    }),
  );
  it.effect('admits two customers sent under two idempotency keys with one authorization and no setting', () =>
    Effect.gen(function* twoCustomers() {
      const first = yield* run(services(), fixture.requestFor('client:one', 'occurrence:key-one:customer-0'));
      const second = yield* run(services(), fixture.requestFor('client:two', 'occurrence:key-two:customer-0'));
      expect(first.outcome).toBe('ALLOWED');
      expect(second.outcome).toBe('ALLOWED');
      expect(subjectOf(first)).toBe(admitted.get('client:one'));
      expect(subjectOf(second)).toBe(admitted.get('client:two'));
      expect(first).toMatchObject({
        authorityIncarnation: fixture.authorization.authorizationRef.resourceId,
        authorityRevision: '1',
      });
    }),
  );
  it.effect('keeps a replay of the same occurrence stable', () =>
    Effect.gen(function* replay() {
      const request = fixture.requestFor('client:one', 'occurrence:replayed');
      const original = yield* run(services(), request);
      const replayed = yield* run(services(), request);
      expect(original.outcome).toBe('ALLOWED');
      expect(replayed).toEqual(original);
    }),
  );
  it.effect('denies a wrong route, an unlisted record kind, issuer or principal before resolving any subject', () =>
    Effect.gen(function* wrongRoute() {
      const strict = {
        ...services(),
        resolveSubject: () => Effect.die('A request outside the authorization must not resolve a subject'),
      };
      for (const source of [
        { ...oneSource, routeRef: 'route:other' },
        { ...oneSource, recordType: 'supplier' },
        { ...oneSource, issuer: 'internal:other' },
      ]) {
        expect(yield* run(strict, { ...fixture.request, source })).toMatchObject({
          outcome: 'DENIED',
          reason: 'AUTHORITY_NOT_CURRENT',
        });
      }
      expect(yield* run(strict, { ...fixture.request, operation: 'MATCH' })).toMatchObject({ outcome: 'DENIED' });
      expect(
        yield* evaluateSourceProcessingEligibility(
          fixture.request,
          { ...scope, principalId: '10000000-0000-4000-8000-000000000099' },
          strict,
          fixture.evaluatedAt,
        ),
      ).toMatchObject({ outcome: 'DENIED', reason: 'AUTHORITY_NOT_CURRENT' });
    }),
  );
  it.effect('denies every request once the authorization has ended', () =>
    run(services([fixture.ended])).pipe(
      Effect.map((result) => expect(result).toMatchObject({ outcome: 'DENIED', reason: 'AUTHORITY_NOT_CURRENT' })),
    ),
  );
  it.effect('denies a source record the route never admitted and a native request without a route', () =>
    Effect.gen(function* unadmitted() {
      expect((yield* run(services(), fixture.requestFor('client:unknown', 'occurrence:one'))).outcome).toBe('DENIED');
      expect(
        (yield* run(services(), { ...fixture.request, source: null, target: { kind: 'PARTY', resourceId: 'p' } }))
          .outcome,
      ).toBe('DENIED');
    }),
  );
  it.effect('blocks the protected material of one subject without touching another customer', () =>
    Effect.gen(function* protectedSubject() {
      const protectedId = admitted.get('client:one') ?? '';
      const protectedServices: SourceProcessingEligibilityServices = {
        ...services(),
        protections: (subjectRef) =>
          Effect.succeed({
            items: subjectRef === protectedId ? [protectionFor(protectedId, [protectedId])] : [],
            sourceSubjectRefs: [subjectRef],
          }),
      };
      expect(yield* run(protectedServices, fixture.requestFor('client:one', 'occurrence:later'))).toMatchObject({
        outcome: 'DENIED',
        reason: 'PROTECTED_MATERIAL',
      });
      expect((yield* run(protectedServices, fixture.requestFor('client:two', 'occurrence:later'))).outcome).toBe(
        'ALLOWED',
      );
    }),
  );
  it.effect(
    'denies missing legal basis, an active restriction and a changed policy under an active authorization',
    () =>
      Effect.gen(function* governance() {
        expect(
          (yield* run(services(undefined, (intended) => ({ ...trustedInputs(intended), legalBasis: null })))).outcome,
        ).toBe('DENIED');
        expect(
          (yield* run(
            services(undefined, (intended) => ({
              ...trustedInputs(intended),
              restriction: {
                currentness,
                restrictionRef: 'fixture:restriction:active',
                scope: intended,
                status: 'ACTIVE',
              },
            })),
          )).outcome,
        ).toBe('DENIED');
        const noPolicy = services();
        expect(
          (yield* run({
            ...noPolicy,
            repository: { ...noPolicy.repository, listApplicabilityPolicies: () => Effect.succeed([]) },
          })).outcome,
        ).toBe('DENIED');
      }),
  );
  it.effect('admits the Retail profile Party only through the granted current source person admission', () =>
    Effect.gen(function* profileCreation() {
      const partySourceReference = {
        occurrenceId: 'party-create:one',
        recordId: 'client:one',
        source: fixture.route,
      };
      const grant = Schema.decodeUnknownSync(SourceProcessingGrantSchema)({
        allowTargetless: false,
        consumerModuleId: 'commerce.customer-context',
        operation: 'PROFILE_CREATE',
        organizationBusinessUses: [],
        targetAdmission: 'CURRENT_SOURCE_PERSON',
        targetKinds: ['PARTY'],
      });
      const authorization = { ...fixture.authorization, grants: [...fixture.authorization.grants, grant] };
      const request: SourceProcessingEligibilityRequest = {
        consumerModuleId: 'commerce.customer-context',
        operation: 'PROFILE_CREATE',
        partySourceReference,
        source: fixture.request.source,
        target: { kind: 'PARTY', resourceId: '20000000-0000-4000-8000-000000000025' },
      };
      const observed: unknown[] = [];
      const profileServices: SourceProcessingEligibilityServices = {
        ...services([authorization]),
        subjectExists: (_subject, _request, mode) => Effect.sync(() => observed.push(mode)).pipe(Effect.as(true)),
      };
      expect((yield* run(profileServices, request)).outcome).toBe('ALLOWED');
      expect(observed).toEqual(['CURRENT_SOURCE_PERSON']);
      expect((yield* run(services(), request)).outcome).toBe('DENIED');
      expect(
        (yield* run(profileServices, {
          ...request,
          partySourceReference: { ...partySourceReference, source: { ...fixture.route, routeRef: 'route:other' } },
        })).outcome,
      ).toBe('DENIED');
    }),
  );
  it.effect('binds a recovery hash to the decoded native request and rejects extra control fields', () =>
    Effect.gen(function* normalizedRecoveryInput() {
      const decode = Schema.decodeUnknownEffect(SourceProcessingEligibilityRequestSchema, {
        onExcessProperty: 'error',
      });
      const decodedInput = yield* decode(fixture.request);
      expect(computeCanonicalValueHash(decodedInput)).not.toBe(computeCanonicalValueHash({ payload: decodedInput }));
      const rejected = yield* decode({ ...fixture.request, principalId: ids.principalId }).pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
    }),
  );
  it('never infers consent and keeps child records on their subject route', () => {
    const decodeCreate = Schema.decodeUnknownResult(CreateSourceProcessingAuthorizationPayloadSchema);
    const decodeAdmit = Schema.decodeUnknownResult(AdmitSourceProcessingSubjectPayloadSchema);
    const { recordType, ...route } = fixture.route;
    const payload = {
      applicabilityDecisionId: 'decision:one',
      authorizationId: '10000000-0000-4000-8000-000000000030',
      dataCategoryRefs: ['party:name'],
      grants: fixture.authorization.grants,
      legalBasis: {
        assignmentId: '10000000-0000-4000-8000-000000000031',
        basis: 'CONTRACT',
        basisVersion: 'v1',
        evidenceRefs: ['contract:symmy-integration'],
        policyRef: 'source:internal-test',
        policyVersion: '1',
        reason: 'Contract with the ERP customer',
      },
      principals: fixture.authorization.principals,
      proposedActivity: true,
      purposeRef: fixture.purpose.purposeRef,
      purposeVersionId: '10000000-0000-4000-8000-000000000011',
      responsibilityAssignmentRefs: fixture.authorization.responsibilityAssignmentRefs,
      source: { ...route, recordTypes: [recordType] },
    };
    expect(Result.isSuccess(decodeCreate(payload))).toBe(true);
    expect(
      Result.isFailure(decodeCreate({ ...payload, legalBasis: { ...payload.legalBasis, basis: 'CONSENT' } })),
    ).toBe(true);
    const customer = { ...fixture.route, recordId: 'client:one' };
    expect(
      Result.isSuccess(decodeAdmit({ childSources: [{ ...customer, recordId: 'contact:one' }], source: customer })),
    ).toBe(true);
    expect(
      Result.isFailure(
        decodeAdmit({
          childSources: [{ ...customer, recordId: 'contact:one', routeRef: 'route:other' }],
          source: customer,
        }),
      ),
    ).toBe(true);
    expect(Result.isFailure(decodeAdmit({ childSources: [customer], source: customer }))).toBe(true);
  });
  it('never uses the company ICO applicability marker as permission for personal processing', () => {
    const outcome = evaluatePrivacyEligibility({
      ...trustedInputs(intendedScope),
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
      ...trustedInputs(intendedScope),
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
        subjectRef: subjectRefOne,
        updatedAt: fixture.from,
      });
      expect(sourceSubjectMatchesRequest(record, fixture.request)).toBe(true);
      expect(
        sourceSubjectMatchesRequest(record, {
          ...fixture.request,
          source: { ...oneSource, recordId: 'other' },
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
      subjectRef: subjectRefOne,
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
    const source = { ...oneSource, recordId: 'fixture:independently-enrolled-alias' };
    const alias = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
      createdAt: fixture.from,
      subject: { kind: 'SOURCE_ASSERTED', source },
      subjectRef: subjectRefOne,
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
  it('lets an admitted child record stand for its subject and nothing else', () => {
    const record = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
      createdAt: fixture.from,
      subject: { kind: 'SOURCE_ASSERTED', source: { ...fixture.route, recordId: 'client:one' } },
      subjectRef: {
        moduleId: 'privacy.core',
        resourceId: admitted.get('client:one'),
        resourceType: 'privacy.core.privacy-subject',
        tenantId: ids.tenantId,
      },
      updatedAt: fixture.from,
    });
    const contact = fixture.requestFor('contact:one', 'occurrence:contact');
    expect(sourceSubjectMatchesRequest(record, contact)).toBe(false);
    expect(sourceSubjectMatchesRequest(record, contact, undefined, 'CHILD')).toBe(true);
  });
});
