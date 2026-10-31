import { consentSelfServiceAction, handleConsentSelfService } from '../../src/actions/consent-self-service.action.ts';
import { describe, expect, it } from 'effect-rstest';
import { Clock, DateTime, Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  ConsentSelfServicePayloadSchema,
  ConsentSelfServiceResultSchema,
} from '../../shared/actions/consent-self-service.ts';
import {
  ConsentSelfServiceAuthorizationError,
  ConsentSelfServiceRequestSchema,
} from '../../shared/domain/privacy-consent-self-service.ts';
import type {
  ConsentSelfServiceAuthorityPorts,
  TrustedOperationConsentAuthorityFact,
  TrustedPortalConsentAuthorityFact,
  TrustedSupportConsentAuthorityFact,
} from '../../shared/domain/privacy-consent-self-service.ts';
import type { ConsentScope } from '../../shared/domain/privacy-consent-scope.ts';
import type { ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import {
  ConsentSelfServiceAuthority,
  consentSelfServiceAuthorityForScope,
  consentSelfServiceAuthorityUnavailable,
} from '../../src/actions/consent-self-service-authority.ts';
import type {
  ConsentSelfServiceAuthorityService,
  ConsentSelfServiceServices,
} from '../../src/actions/consent-self-service-authority.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';
import {
  consentSelfServicePreparationScopeMatches,
  checkPreparedConsentAuthorityObservation,
  loadConsentSelfServiceSnapshot,
  observeConsentSelfServicePreparation,
  preparedConsentSelfServicePorts,
  preparedConsentSelfServiceServices,
} from '../../src/services/consent-self-service-preparation.ts';
import { PrivacySubjectRecordSchema, PrivacySubjectOwnerEvidenceSchema } from '../../shared/domain/privacy-subject.ts';
import type { ConsentSelfServicePayload } from '../../shared/actions/consent-self-service.ts';

const tenantId = '00000000-0000-4000-8000-000000000101';
const principalId = '00000000-0000-4000-8000-000000000102';
const legalEntityId = '00000000-0000-4000-8000-000000000103';
const actionInvocationId = '00000000-0000-4000-8000-000000000104';
const subjectRef = {
  moduleId: 'privacy.core',
  resourceId: 'subject:action-test',
  resourceType: 'privacy.core.privacy-subject',
  tenantId,
} as const;
const consentScope: ConsentScope = {
  controllerRef: 'controller:action-test',
  materialDimensions: [],
  privacySubjectRef: subjectRef,
  processingPurposeRef: {
    moduleId: 'privacy.core',
    resourceId: 'purpose:action-test',
    resourceType: 'privacy.core.processing-purpose',
    tenantId,
  },
  purposeMeaning: 'Self-service consent management',
  purposeVersionRef: '00000000-0000-4000-8000-000000000105',
  scopeRef: 'scope:action-test',
};

const portalPath = {
  kind: 'CURRENT_PROFILE_BINDING' as const,
  operation: 'CONSENT_WITHDRAW' as const,
  operationRef: 'operation:portal-action-test',
  profileRef: 'profile:action-test',
  requestRef: 'request:portal-action-test',
  scopeRef: consentScope.scopeRef,
  subjectRef,
};
const operationPath = {
  credentialRef: 'credential:operation-action-test',
  kind: 'OPERATION_SCOPED' as const,
  operation: 'CONSENT_WITHDRAW' as const,
  operationRef: 'operation:operation-action-test',
  requestRef: 'request:operation-action-test',
  scopeRef: consentScope.scopeRef,
  subjectRef,
};

const portalRequest = Schema.decodeUnknownSync(ConsentSelfServiceRequestSchema)({
  decision: 'WITHDRAWN',
  noticeEvidenceRefs: ['notice:action-test'],
  path: portalPath,
  scope: consentScope,
});
const operationRequest = Schema.decodeUnknownSync(ConsentSelfServiceRequestSchema)({
  decision: 'WITHDRAWN',
  noticeEvidenceRefs: ['notice:action-test'],
  path: operationPath,
  scope: consentScope,
});

const current = (sourceModuleId: string) => ({
  observedAt: '2026-09-15T10:00:00Z' as const,
  revision: 'revision:action-test',
  sourceModuleId,
  status: 'CURRENT' as const,
});

const portalFact: TrustedPortalConsentAuthorityFact = {
  actorPrincipalRef: { principalId, tenantId },
  authorizedScope: consentScope,
  binding: {
    bindingRef: 'binding:action-test',
    principalRef: { principalId, tenantId },
    profileRef: {
      kind: 'RETAIL',
      moduleId: 'commerce.customer-context',
      resourceId: portalPath.profileRef,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId,
    },
    state: 'ACTIVE',
  },
  bindingFreshness: current('commerce.customer-context'),
  evidenceRefs: ['evidence:portal-action-test'],
  kind: 'CURRENT_PROFILE_BINDING',
  operation: portalPath.operation,
  operationRef: portalPath.operationRef,
  permissionFreshness: current('core.authorization'),
  permissions: ['retail.consent.manage'],
  scopeRef: consentScope.scopeRef,
  status: 'CURRENT',
  subjectRef,
};

const operationFact: TrustedOperationConsentAuthorityFact = {
  authorizedScope: consentScope,
  decisionReceipt: {
    acknowledgedAt: '1961-01-01T00:00:00Z',
    decision: operationRequest.decision,
    requestRef: operationPath.requestRef,
  },
  evidenceRefs: ['evidence:operation-action-test'],
  expiresAt: '2099-01-01T00:00:00Z',
  kind: 'OPERATION_SCOPED',
  operation: operationPath.operation,
  operationRef: operationPath.operationRef,
  proofRef: operationPath.credentialRef,
  scopeRef: consentScope.scopeRef,
  status: 'CURRENT',
  subjectRef,
  verifiedAt: '1960-01-01T00:00:00Z',
};

const authority = (ports: ConsentSelfServiceAuthorityPorts): ConsentSelfServiceAuthorityService => ({ ports });

const makeConsentDecisionServices = (
  recorded: ConsentDecision[],
  requiredConsentDimensions: readonly ('COMMUNICATION_CHANNEL' | 'SITE')[] = [],
) => ({
  get: () =>
    Effect.succeed(
      Option.some({
        businessCode: 'SELF_SERVICE' as const,
        createdAt: '2026-01-01T00:00:00Z' as const,
        governanceOwnerId: '00000000-0000-4000-8000-000000000106',
        legalEntityId,
        lifecycle: 'ACTIVE' as const,
        purposeRef: consentScope.processingPurposeRef,
        retiredAt: null,
        versions: [
          {
            effectiveFrom: '1960-01-01T00:00:00Z' as const,
            effectiveTo: '2099-01-01T00:00:00Z',
            materialChangeAssessment: null,
            meaning: consentScope.purposeMeaning,
            recordedAt: '1960-01-01T00:00:00Z' as const,
            requiredConsentDimensions,
            versionId: consentScope.purposeVersionRef,
            versionNumber: 1,
          },
        ],
      }),
    ),
  recordConsentDecision: (
    _tenantId: string,
    _legalEntityId: string,
    _invocationId: string,
    decision: ConsentDecision,
  ) => {
    recorded.push(decision);
    return Effect.succeed(decision);
  },
});

const contextFor = (
  services: Pick<ConsentSelfServiceServices, 'authority'>,
  recorded: ConsentDecision[] = [],
  requiredConsentDimensions: readonly ('COMMUNICATION_CHANNEL' | 'SITE')[] = [],
) => {
  const collector = createActionCollector(
    consentSelfServiceAction.descriptor.domainEvents,
    'privacy.core',
    consentSelfServiceAction.descriptor.accessEvidencePolicy,
    consentSelfServiceAction.descriptor.auditEvidenceSchema,
  );
  return {
    actionInvocationId,
    addDomainEvent: collector.addDomainEvent,
    addOutboxMessage: collector.addOutboxMessage,
    compositionRevision: 'test-composition',
    recordAuditEvidence: collector.recordAuditEvidence,
    recordDataAccess: collector.recordDataAccess,
    scope: {
      authMethod: 'session' as const,
      correlationId: 'privacy-consent-self-service-action-test',
      legalEntityId,
      principalId,
      tenantId,
    },
    services: { ...services, consentDecision: makeConsentDecisionServices(recorded, requiredConsentDimensions) },
  };
};

const portsFor = (facts: {
  readonly operation?: TrustedOperationConsentAuthorityFact;
  readonly portal?: TrustedPortalConsentAuthorityFact;
  readonly support?: TrustedSupportConsentAuthorityFact;
}): ConsentSelfServiceAuthorityPorts => ({
  resolveCurrentRetailPortalProfileBinding: () =>
    facts.portal === undefined
      ? Effect.fail(
          new ConsentSelfServiceAuthorizationError({
            code: 'AUTHORITY_UNAVAILABLE',
            reason: 'Commerce authority unavailable',
          }),
        )
      : Effect.succeed(facts.portal),
  resolveSupportAuthority: () =>
    facts.support === undefined
      ? Effect.fail(
          new ConsentSelfServiceAuthorizationError({
            code: 'AUTHORITY_UNAVAILABLE',
            reason: 'Support authority unavailable',
          }),
        )
      : Effect.succeed(facts.support),
  verifyOperationCredential: () =>
    facts.operation === undefined
      ? Effect.fail(
          new ConsentSelfServiceAuthorizationError({
            code: 'AUTHORITY_UNAVAILABLE',
            reason: 'Operation credential unavailable',
          }),
        )
      : Effect.succeed(facts.operation),
});

const preparedFixture = Effect.fn('ConsentSelfServiceUnit.preparedFixture')(function* preparedFixture(
  request: ConsentSelfServicePayload = operationRequest,
  owner: ConsentSelfServiceAuthorityService = authority(portsFor({ operation: operationFact })),
  writeDelay = 0,
) {
  const capturedRequest = structuredClone(request);
  const recorded: ConsentDecision[] = [];
  const context = contextFor({ authority: owner }, recorded);
  const purposeServices = makeConsentDecisionServices(recorded);
  const at = DateTime.formatIso(yield* DateTime.now);
  const subject = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
    createdAt: at,
    subject: {
      kind: 'DATA_SUBJECT',
      partyRef: {
        moduleId: 'party.registry',
        resourceId: '00000000-0000-4000-8000-000000000109',
        resourceType: 'party.registry.party',
        tenantId,
      },
    },
    subjectRef,
    updatedAt: at,
  });
  let subjectReads = 0;
  const repositories = {
    operations: {
      listSubjects: () =>
        Effect.sync(() => {
          subjectReads += 1;
          return [subject];
        }),
      readCurrentConsent: () => Effect.succeed({ outcome: 'ABSENT' as const }),
      recordConsentDecision: (...args: Parameters<typeof purposeServices.recordConsentDecision>) =>
        purposeServices.recordConsentDecision(...args).pipe(Effect.tap(() => TestClock.adjust(writeDelay))),
    },
    purposes: purposeServices,
  };
  const deadline = (yield* Clock.currentTimeMillis) + 30_000;
  const snapshot = yield* loadConsentSelfServiceSnapshot(capturedRequest, context, repositories);
  const prepared = yield* observeConsentSelfServicePreparation({
    context: {
      actionInvocationId,
      compositionRevision: context.compositionRevision,
      scope: context.scope,
    },
    deadline,
    payload: capturedRequest,
    snapshot,
  }).pipe(Effect.provideService(ConsentSelfServiceAuthority, owner));
  return { context, prepared, recorded, repositories, subject, subjectReads: () => subjectReads };
});

describe('Consent self-service governed Action', () => {
  it.effect(
    'uses an exclusive thirty-second deadline for profile and support facts, including a persistence wait',
    () =>
      Effect.gen(function* preparedCurrentnessDeadline() {
        const supportRequest = Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)({
          ...portalRequest,
          path: {
            kind: 'SUPPORT_ASSISTED',
            operation: portalPath.operation,
            operationRef: portalPath.operationRef,
            representationRef: 'representation:unit',
            requestRef: 'request:support',
            scopeRef: consentScope.scopeRef,
            subjectRef,
            verificationRef: 'verification:unit',
          },
        });
        const support: TrustedSupportConsentAuthorityFact = {
          actorPrincipalRef: { principalId, tenantId },
          authorizedScope: consentScope,
          evidenceRefs: ['support:actual-unit-authority'],
          kind: 'SUPPORT_ASSISTED',
          operation: portalPath.operation,
          operationRef: portalPath.operationRef,
          representationRef: 'representation:unit',
          representationStatus: 'CURRENT',
          scopeRef: consentScope.scopeRef,
          status: 'CURRENT',
          subjectRef,
          verificationRef: 'verification:unit',
          verificationStatus: 'CURRENT',
        };
        for (const selected of [
          { owner: authority(portsFor({ portal: portalFact })), request: portalRequest },
          { owner: authority(portsFor({ support })), request: supportRequest },
        ]) {
          const at = Date.parse('2026-09-15T10:00:00.000Z');
          yield* TestClock.setTime(at);
          const before = yield* preparedFixture(selected.request, selected.owner);
          yield* TestClock.adjust(29_999);
          yield* checkPreparedConsentAuthorityObservation(before.prepared);
          yield* TestClock.adjust(1);
          expect((yield* checkPreparedConsentAuthorityObservation(before.prepared).pipe(Effect.flip)).code).toBe(
            'privacy_operation_persistence_unavailable',
          );
          expect(before.recorded).toHaveLength(0);
          yield* TestClock.setTime(at);
          const during = yield* preparedFixture(selected.request, selected.owner, 30_000);
          const error = yield* handleConsentSelfService(selected.request, {
            ...during.context,
            services: preparedConsentSelfServiceServices(during.prepared, during.repositories),
          }).pipe(Effect.flip);
          expect(error.code).toBe('privacy_operation_persistence_unavailable');
          expect(during.recorded).toHaveLength(1);
        }
      }),
  );

  it.effect('copies selectors and owner facts instead of retaining mutable caller or provider references', () =>
    Effect.gen(function* immutablePreparedSelectors() {
      const request = structuredClone(operationRequest);
      const fact = structuredClone(operationFact);
      const owner: ConsentSelfServiceAuthorityService = {
        ports: {
          ...consentSelfServiceAuthorityUnavailable.ports,
          verifyOperationCredential: (input) =>
            Effect.sync(() => {
              Reflect.set(input.request.path, 'requestRef', 'provider-mutated-selector');
              return fact;
            }),
        },
      };
      const unit = yield* preparedFixture(request, owner);
      Reflect.set(request.path, 'requestRef', 'caller-mutated-selector');
      Reflect.set(fact.decisionReceipt, 'requestRef', 'provider-mutated-receipt');
      expect(unit.prepared.payload).toEqual(operationRequest);
      expect(unit.prepared.fact).toEqual(operationFact);
      const services = preparedConsentSelfServiceServices(unit.prepared, unit.repositories);
      const result = yield* handleConsentSelfService(operationRequest, { ...unit.context, services });
      expect(result.authorization.allowed).toBe(true);
      expect((yield* handleConsentSelfService(request, { ...unit.context, services }).pipe(Effect.flip)).code).toBe(
        'privacy_action_rejected',
      );
    }),
  );

  it.effect(
    'prepares configured owner observations over immutable local snapshots and commits without live owner calls',
    () =>
      Effect.gen(function* preparedOwnerAuthority() {
        yield* TestClock.setTime(Date.parse('2026-09-15T10:00:00.000Z'));
        let authorityCalls = 0;
        let businessPhase = false;
        const owner: ConsentSelfServiceAuthorityService = {
          forScope: (input) => ({
            ...consentSelfServiceAuthorityUnavailable.ports,
            resolveCurrentRetailPortalProfileBinding: () =>
              Effect.gen(function* observeImmutableLocalData() {
                expect(businessPhase).toBe(false);
                expect(input.compositionRevision).toBe('test-composition');
                authorityCalls += 1;
                const first = yield* input.subjects.listSubjects(tenantId, legalEntityId);
                const second = yield* input.subjects.listSubjects(tenantId, legalEntityId);
                expect(second).toEqual(first);
                expect(
                  yield* input.subjects.readCurrentConsent(tenantId, legalEntityId, consentScope.scopeRef),
                ).toEqual({ outcome: 'ABSENT' });
                return portalFact;
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ConsentSelfServiceAuthorizationError({
                      code: 'AUTHORITY_UNAVAILABLE',
                      reason: cause.reason,
                    }),
                ),
              ),
          }),
          ports: consentSelfServiceAuthorityUnavailable.ports,
        };
        const unit = yield* preparedFixture(portalRequest, owner);
        expect(unit.subjectReads()).toBe(1);
        businessPhase = true;
        const result = yield* handleConsentSelfService(portalRequest, {
          ...unit.context,
          services: preparedConsentSelfServiceServices(unit.prepared, unit.repositories),
        });
        expect(result.authorization.allowed).toBe(true);
        expect(unit.recorded).toEqual([result.decision]);
        expect(unit.subjectReads()).toBe(2);
        expect(authorityCalls).toBe(1);
      }),
  );

  it.effect('refuses changed Subject, current Consent or Purpose facts before the prepared write', () =>
    Effect.gen(function* changedPreparedOwnerState() {
      const unit = yield* preparedFixture();
      const retainedDecision: ConsentDecision = {
        actorEvidence: null,
        decision: 'GRANTED',
        decisionId: 'decision:concurrent',
        effectiveAt: '1961-01-01T00:00:00Z',
        flowEvidenceRefs: [],
        noticeEvidenceRefs: ['notice:action-test'],
        provenanceRefs: ['decision:source'],
        recordedAt: '1961-01-01T00:00:00Z',
        scope: consentScope,
      };
      const changedRepositories = [
        {
          ...unit.repositories,
          operations: {
            ...unit.repositories.operations,
            listSubjects: () => Effect.succeed([{ ...unit.subject, updatedAt: '2026-10-01T00:00:00Z' }]),
          },
        },
        {
          ...unit.repositories,
          operations: {
            ...unit.repositories.operations,
            readCurrentConsent: () => Effect.succeed({ decision: retainedDecision, outcome: 'CURRENT' as const }),
          },
        },
        {
          ...unit.repositories,
          purposes: {
            get: () =>
              unit.repositories.purposes.get().pipe(
                Effect.map(
                  Option.map((purpose) => ({
                    ...purpose,
                    governanceOwnerId: '00000000-0000-4000-8000-000000000199',
                  })),
                ),
              ),
          },
        },
      ];
      for (const repositories of changedRepositories) {
        const services = preparedConsentSelfServiceServices(unit.prepared, repositories);
        const error = yield* handleConsentSelfService(operationRequest, { ...unit.context, services }).pipe(
          Effect.flip,
        );
        expect(error.code).toBe('privacy_action_rejected');
        expect(unit.recorded).toHaveLength(0);
      }
    }),
  );

  it.effect('binds prepared authority to the exact request, principal and credential without live fallback', () =>
    Effect.gen(function* preparedSelectorBindings() {
      yield* TestClock.setTime(Date.parse('2026-09-15T10:00:00.000Z'));
      const unit = yield* preparedFixture();
      const ports = preparedConsentSelfServicePorts(unit.prepared);
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const changed of [
        { credentialRef: 'another-credential', now, request: operationRequest },
        {
          credentialRef: operationPath.credentialRef,
          now,
          request: { ...operationRequest, decision: 'GRANTED' as const },
        },
        {
          credentialRef: operationPath.credentialRef,
          now,
          request: { ...operationRequest, path: { ...operationPath, requestRef: 'another-request' } },
        },
      ]) {
        expect((yield* ports.verifyOperationCredential(changed).pipe(Effect.flip)).code).toBe('AUTHORITY_CONFLICT');
      }
      const portal = yield* preparedFixture(portalRequest, authority(portsFor({ portal: portalFact })));
      expect(
        (yield* preparedConsentSelfServicePorts(portal.prepared)
          .resolveCurrentRetailPortalProfileBinding({
            principalRef: { principalId: 'another-principal', tenantId },
            profileRef: portalPath.profileRef,
            request: portalRequest,
          })
          .pipe(Effect.flip)).code,
      ).toBe('AUTHORITY_CONFLICT');
      const services = preparedConsentSelfServiceServices(unit.prepared, unit.repositories);
      expect(
        (yield* handleConsentSelfService(operationRequest, {
          ...unit.context,
          actionInvocationId: 'another-invocation',
          services,
        }).pipe(Effect.flip)).code,
      ).toBe('privacy_action_rejected');
      for (const changed of [
        { ...unit.context.scope, legalEntityId: 'another-entity' },
        { ...unit.context.scope, principalId: 'another-principal' },
        { ...unit.context.scope, tenantId: 'another-tenant' },
        { ...unit.context.scope, authBindingId: 'another-binding' },
        { ...unit.context.scope, authContextRef: 'another-session' },
        { ...unit.context.scope, authenticationNamespaceId: 'another-namespace' },
        { ...unit.context.scope, correlationId: 'another-correlation' },
        { ...unit.context.scope, traceId: 'another-trace' },
        { ...unit.context.scope, audience: 'another-audience' },
      ]) {
        expect(
          consentSelfServicePreparationScopeMatches(unit.prepared, changed, unit.context.compositionRevision),
        ).toBe(false);
      }
      expect(consentSelfServicePreparationScopeMatches(unit.prepared, unit.context.scope, 'another-composition')).toBe(
        false,
      );
      expect(unit.recorded).toHaveLength(0);
    }),
  );

  it.effect('rechecks the actual operation expiry before and after the original persistence call', () =>
    Effect.gen(function* preparedOperationExpiry() {
      const at = '2026-09-15T10:00:00.000Z';
      const owner = authority(
        portsFor({
          operation: { ...operationFact, expiresAt: '2026-09-15T10:00:01.000Z' },
        }),
      );
      yield* TestClock.setTime(Date.parse(at));
      const expiredBefore = yield* preparedFixture(operationRequest, owner);
      yield* TestClock.adjust(1000);
      const beforeError = yield* handleConsentSelfService(operationRequest, {
        ...expiredBefore.context,
        services: preparedConsentSelfServiceServices(expiredBefore.prepared, expiredBefore.repositories),
      }).pipe(Effect.flip);
      expect(beforeError.code).toBe('privacy_action_rejected');
      expect(expiredBefore.recorded).toHaveLength(0);
      yield* TestClock.setTime(Date.parse(at));
      const expiredAfter = yield* preparedFixture(operationRequest, owner, 1000);
      const afterError = yield* handleConsentSelfService(operationRequest, {
        ...expiredAfter.context,
        services: preparedConsentSelfServiceServices(expiredAfter.prepared, expiredAfter.repositories),
      }).pipe(Effect.flip);
      expect(afterError.code).toBe('privacy_action_rejected');
      // The in-memory port records the attempted write. Core's SQL rollback is a native proof.
      expect(expiredAfter.recorded).toHaveLength(1);
    }),
  );

  it.effect('retains actual Party validity from the configured owner and refuses expiry after persistence', () =>
    Effect.gen(function* preparedPartyExpiry() {
      const at = '2026-09-15T10:00:00.000Z';
      yield* TestClock.setTime(Date.parse(at));
      const party = Schema.decodeUnknownSync(PrivacySubjectOwnerEvidenceSchema)({
        observedAt: at,
        ownerRevision: 1,
        partyRef: {
          moduleId: 'party.registry',
          resourceId: '00000000-0000-4000-8000-000000000109',
          resourceType: 'party.registry.party',
          tenantId,
        },
        typeAssertions: [{ assertionId: 'party:person', validFrom: at, validTo: '2026-09-15T10:00:01.000Z' }],
      });
      const owner: ConsentSelfServiceAuthorityService = {
        forScope: (input) => ({
          ...consentSelfServiceAuthorityUnavailable.ports,
          resolveCurrentRetailPortalProfileBinding: () =>
            Effect.sync(() => {
              input.observePartyEvidence?.(party);
              return portalFact;
            }),
        }),
        ports: consentSelfServiceAuthorityUnavailable.ports,
      };
      const unit = yield* preparedFixture(portalRequest, owner, 1000);
      expect(unit.prepared.partyEvidence).toEqual([party]);
      const error = yield* handleConsentSelfService(portalRequest, {
        ...unit.context,
        services: preparedConsentSelfServiceServices(unit.prepared, unit.repositories),
      }).pipe(Effect.flip);
      expect(error.code).toBe('privacy_operation_persistence_unavailable');
      expect(unit.recorded).toHaveLength(1);
    }),
  );

  it.effect('does not turn an acknowledged grant into a newer decision when retried after withdrawal', () =>
    Effect.gen(function* delayedAcknowledgedGrant() {
      yield* TestClock.setTime(new Date('2026-10-23T12:00:00.000Z').getTime());
      const recorded: ConsentDecision[] = [];
      const acknowledgedAt = DateTime.formatIso(yield* DateTime.now);
      const grant = Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)({
        ...operationRequest,
        decision: 'GRANTED',
        path: { ...operationPath, operation: 'CONSENT_WRITE', operationRef: 'grant:A', requestRef: 'grant:A' },
      });
      // The receipt exists at the owner, but the first Privacy call never executes successfully.
      yield* Effect.flip(
        handleConsentSelfService(grant, contextFor({ authority: consentSelfServiceAuthorityUnavailable }, recorded)),
      );
      expect(recorded).toHaveLength(0);
      yield* TestClock.adjust('1 second');
      const withdrawnAt = DateTime.formatIso(yield* DateTime.now);
      const withdrawFact = {
        ...operationFact,
        decisionReceipt: {
          acknowledgedAt: withdrawnAt,
          decision: 'WITHDRAWN' as const,
          requestRef: operationPath.requestRef,
        },
      };
      yield* handleConsentSelfService(
        operationRequest,
        contextFor({ authority: authority(portsFor({ operation: withdrawFact })) }, recorded),
      );
      yield* TestClock.adjust('1 second');
      const grantFact = {
        ...operationFact,
        decisionReceipt: { acknowledgedAt, decision: 'GRANTED' as const, requestRef: grant.path.requestRef },
        operation: grant.path.operation,
        operationRef: grant.path.operationRef,
      };
      const retried = yield* handleConsentSelfService(
        grant,
        contextFor({ authority: authority(portsFor({ operation: grantFact })) }, recorded),
      );
      expect(retried.decision.effectiveAt).toBe(acknowledgedAt);
      expect(recorded[0]?.effectiveAt).toBe(withdrawnAt);
      expect(retried.decision.recordedAt).toBe(DateTime.formatIso(yield* DateTime.now));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    'builds configured authority with the trusted Action scope and owner resolvers before invoking the handler',
    () =>
      Effect.gen(function* scopedAuthorityAssembly() {
        const recorded: ConsentDecision[] = [];
        const context = contextFor({ authority: consentSelfServiceAuthorityUnavailable }, recorded);
        const subjects = {
          listSubjects: () => Effect.succeed([]),
          readCurrentConsent: () => Effect.succeed({ outcome: 'ABSENT' as const }),
        };
        let assembled = 0;
        const authorityService: ConsentSelfServiceAuthorityService = {
          forScope: (input) => {
            assembled += 1;
            expect(input.scope).toBe(context.scope);
            expect(input.subjects).toBe(subjects);
            return portsFor({ portal: portalFact });
          },
          ports: consentSelfServiceAuthorityUnavailable.ports,
        };
        const selected = yield* consentSelfServiceAuthorityForScope({ scope: context.scope, subjects }).pipe(
          Effect.provideService(ConsentSelfServiceAuthority, authorityService),
        );
        const result = yield* handleConsentSelfService(portalRequest, {
          ...context,
          services: { ...context.services, authority: selected },
        });
        expect(assembled).toBe(1);
        expect(result.authorization.allowed).toBe(true);
        expect(recorded).toEqual([result.decision]);
        expect(
          (yield* consentSelfServiceAuthorityForScope({ scope: context.scope, subjects }).pipe(
            Effect.provideService(ConsentSelfServiceAuthority, consentSelfServiceAuthorityUnavailable),
          )).ports,
        ).toBe(consentSelfServiceAuthorityUnavailable.ports);
      }),
  );

  it.effect('keeps configured authority failure closed before any Consent write', () =>
    Effect.gen(function* deniedScopedAuthority() {
      const recorded: ConsentDecision[] = [];
      const context = contextFor({ authority: consentSelfServiceAuthorityUnavailable }, recorded);
      const selected = yield* consentSelfServiceAuthorityForScope({
        scope: context.scope,
        subjects: {
          listSubjects: () => Effect.succeed([]),
          readCurrentConsent: () => Effect.succeed({ outcome: 'ABSENT' }),
        },
      }).pipe(
        Effect.provideService(ConsentSelfServiceAuthority, {
          forScope: () => consentSelfServiceAuthorityUnavailable.ports,
          ports: portsFor({ portal: portalFact }),
        }),
      );
      const error = yield* handleConsentSelfService(portalRequest, {
        ...context,
        services: { ...context.services, authority: selected },
      }).pipe(Effect.flip);
      expect(error.code).toBe('privacy_operation_persistence_unavailable');
      expect(recorded).toEqual([]);
    }),
  );

  it.effect('retains the real self-service withdrawal time after its original V1 period ends', () =>
    Effect.gen(function* endedPurposeSelfService() {
      const at = '2026-09-15T10:00:00.000Z';
      yield* TestClock.setTime(Date.parse(at));
      const recorded: ConsentDecision[] = [];
      // The owner acknowledged the withdrawal at the same instant it reaches Privacy.
      const withdrawFact = {
        ...operationFact,
        decisionReceipt: { ...operationFact.decisionReceipt, acknowledgedAt: at },
      };
      const context = contextFor({ authority: authority(portsFor({ operation: withdrawFact })) }, recorded);
      const services = context.services.consentDecision;
      const result = yield* handleConsentSelfService(operationRequest, {
        ...context,
        services: {
          ...context.services,
          consentDecision: {
            ...services,
            get: () =>
              services.get().pipe(
                Effect.map(
                  Option.map((purpose) => ({
                    ...purpose,
                    versions: purpose.versions.map((version) => ({ ...version, effectiveTo: '2026-02-01T00:00:00Z' })),
                  })),
                ),
              ),
          },
        },
      });
      expect(result.decision.effectiveAt).toBe(at);
      expect(result.decision.recordedAt).toBe(at);
      expect(result.decision.scope).toEqual(consentScope);
      expect(recorded).toEqual([result.decision]);
    }),
  );

  it.effect('runs portal authority resolution through the public Action handler', () =>
    Effect.gen(function* runsPortalAction() {
      const result = yield* handleConsentSelfService(
        Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(portalRequest),
        contextFor({ authority: authority(portsFor({ portal: portalFact })) }),
      );

      expect(Schema.encodeUnknownSync(ConsentSelfServiceResultSchema)(result).decision).toMatchObject({
        decision: 'WITHDRAWN',
        flowEvidenceTrust: 'TRUSTED_OPERATION_CONTEXT',
        noticeEvidenceRefs: ['notice:action-test'],
      });
    }),
  );

  it.effect('runs non-account operation proof resolution through the public Action handler', () =>
    Effect.gen(function* runsOperationAction() {
      const result = yield* handleConsentSelfService(
        Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(operationRequest),
        contextFor({ authority: authority(portsFor({ operation: operationFact })) }),
      );

      expect(result.authorization).toMatchObject({ allowed: true, authority: 'CONSENT_ONLY' });
      expect(result.decision.flowEvidenceRefs).toEqual(['evidence:operation-action-test']);
    }),
  );

  it.effect('records the authorized Consent Decision through the owner repository', () =>
    Effect.gen(function* recordsConsent() {
      const recorded: ConsentDecision[] = [];
      const result = yield* handleConsentSelfService(
        Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(operationRequest),
        contextFor({ authority: authority(portsFor({ operation: operationFact })) }, recorded),
      );

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toEqual(result.decision);
      expect(result.decision.decisionId).toBe(`consent-self-service:${operationPath.requestRef}`);
    }),
  );

  it.effect('does not persist or emit success evidence when authoritative authorization is denied', () =>
    Effect.gen(function* rejectsDeniedAuthorization() {
      const recorded: ConsentDecision[] = [];
      const error = yield* Effect.flip(
        handleConsentSelfService(
          Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(portalRequest),
          contextFor(
            {
              authority: authority(portsFor({ portal: { ...portalFact, permissions: [] } })),
            },
            recorded,
          ),
        ),
      );

      expect(error.code).toBe('privacy_action_rejected');
      expect(recorded).toHaveLength(0);
    }),
  );

  it.effect('fails closed through the Action handler when authority is unavailable', () =>
    Effect.gen(function* rejectsUnavailableAuthority() {
      const error = yield* Effect.flip(
        handleConsentSelfService(
          Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(portalRequest),
          contextFor({ authority: consentSelfServiceAuthorityUnavailable }),
        ),
      );

      expect(error).toBeInstanceOf(PrivacyOperationPersistenceError);
      expect(error.code).toBe('privacy_operation_persistence_unavailable');
    }),
  );

  it.effect('rejects a self-service Purpose reference from another tenant', () =>
    Effect.gen(function* rejectsCrossTenantPurpose() {
      const request = Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)({
        ...operationRequest,
        scope: {
          ...operationRequest.scope,
          processingPurposeRef: {
            ...operationRequest.scope.processingPurposeRef,
            tenantId: '00000000-0000-4000-8000-000000000199',
          },
        },
      });
      const error = yield* Effect.flip(
        handleConsentSelfService(request, contextFor({ authority: authority(portsFor({ operation: operationFact })) })),
      );

      expect(error).toMatchObject({
        code: 'privacy_action_rejected',
        reason: 'Consent self-service authorization denied: OPERATION_CONTEXT_REQUIRED',
      });
    }),
  );

  it.effect('rejects an omitted authoritative required consent dimension', () =>
    Effect.gen(function* rejectsOmittedRequiredDimension() {
      const error = yield* Effect.flip(
        handleConsentSelfService(
          Schema.decodeUnknownSync(ConsentSelfServicePayloadSchema)(operationRequest),
          contextFor({ authority: authority(portsFor({ operation: operationFact })) }, [], ['COMMUNICATION_CHANNEL']),
        ),
      );

      expect(error).toMatchObject({
        code: 'privacy_action_rejected',
        reason: 'Missing material consent dimension: COMMUNICATION_CHANNEL',
      });
    }),
  );
});
