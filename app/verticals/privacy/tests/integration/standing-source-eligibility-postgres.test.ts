import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { privacyRegistration } from '../../vertical.registration.ts';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import {
  sourceProcessingEligibilityRead,
  readSourceProtections,
} from '../../src/api/source-processing-eligibility.read.ts';
import {
  AntiResurrectionProtectionSchema,
  createAntiResurrectionProtection,
} from '../../shared/domain/anti-resurrection.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import { antiResurrectionProtections, privacySubjects } from '../../src/database/schema.ts';
import type { SourceProcessingEligibilityRequest } from '@app/privacy-contracts/source-processing-eligibility';
import { sourceProcessingIntendedScope } from '../../shared/domain/privacy-source-processing-authorization.ts';
import { sourceProcessingAuthorizationRepositoryForScope } from '../../src/persistence/source-processing-authorization-postgres-repository.ts';
import { PrivacyLegalBasisAssignmentSchema } from '../../shared/domain/privacy-legal-basis.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';
import { makeStandingSourceFixture } from '../support/standing-source-fixture.ts';

const subjectRefOf = (tenantId: string) => (resourceId: string) => ({
  moduleId: 'privacy.core' as const,
  resourceId,
  resourceType: 'privacy.core.privacy-subject' as const,
  tenantId,
});

it.live('checks standing source-route authorization through governed Read and native Privacy ledgers', () =>
  Effect.gen(function* nativeSourceProcessing() {
    yield* TestClock.setTime(new Date('2026-11-07T12:00:00.000Z').getTime());
    const native = yield* makeNativeReadTestContext({
      access: 'allowed',
      authMethod: 'api_key',
      contextPermissions: ['privacy.core.source-processing-eligibility.read'],
      moduleId: 'privacy.core',
      ownerFixtureRetention: 'retain-complete-context',
    }).pipe(Effect.provideService(NativeReadTestOwnerRegistration, privacyRegistration));
    const crypto = yield* Crypto.Crypto;
    const nextId = () => crypto.randomUUIDv4();
    const { tenantId } = native.principal;
    const { principalId } = native.principal;
    const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(native.principal.legalEntityId));
    const subjectRefOfTenant = subjectRefOf(tenantId);
    const subjectOne = yield* nextId();
    const subjectTwo = yield* nextId();
    const fixture = yield* native
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* setupPrivacyFacts() {
          const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
          const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
          const authorizations = yield* sourceProcessingAuthorizationRepositoryForScope(transaction, scope);
          const purpose = yield* purposes.create(tenantId, legalEntityId, yield* nextId(), {
            businessCode: 'SYMMY_INTEGRATION',
            effectiveFrom: '2026-11-01T00:00:00.000Z',
            governanceOwnerId: principalId,
            meaning: 'Explicit internal source ingestion fixture without synthetic consent',
          });
          const firstVersion = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));
          const facts = makeStandingSourceFixture({
            authorizationId: yield* nextId(),
            evaluatedAt: DateTime.formatIso(yield* DateTime.now),
            legalEntityId,
            principalId,
            purposeId: purpose.purposeRef.resourceId,
            tenantId,
            versionId: firstVersion.versionId,
          });
          const subjects = [
            { recordId: 'client:one', subjectId: subjectOne },
            { recordId: 'client:two', subjectId: subjectTwo },
          ];
          for (const { recordId, subjectId } of subjects) {
            yield* repository.createSubject(
              { legalEntityId, tenantId },
              {
                actionInvocationId: yield* nextId(),
                subject: {
                  createdAt: facts.from,
                  subject: { kind: 'SOURCE_ASSERTED', source: { ...facts.route, recordId } },
                  subjectRef: subjectRefOfTenant(subjectId),
                  updatedAt: facts.from,
                },
              },
            );
          }
          const collided = yield* Effect.flip(
            repository.createSubject(
              { legalEntityId, tenantId },
              {
                actionInvocationId: yield* nextId(),
                subject: {
                  createdAt: facts.from,
                  subject: { kind: 'SOURCE_ASSERTED', source: { ...facts.route, recordId: 'client:one' } },
                  subjectRef: subjectRefOfTenant(yield* nextId()),
                  updatedAt: facts.from,
                },
              },
            ),
          );
          expect(collided.code).toBe('privacy_operation_conflict');
          yield* repository.recordApplicabilityPolicy(tenantId, legalEntityId, yield* nextId(), facts.policy);
          yield* repository.recordApplicability(
            tenantId,
            legalEntityId,
            yield* nextId(),
            facts.authorization.applicability.decisionRef,
            facts.decision,
          );
          const assignment = Schema.decodeUnknownSync(PrivacyLegalBasisAssignmentSchema)({
            actor: { principalId, tenantId },
            applicabilityDecision: facts.decision,
            assignmentRef: facts.authorization.legalBasisAssignmentRef,
            basis: 'CONTRACT',
            basisVersion: 'internal-explicit-contract-fixture:1',
            decision: 'APPROVED',
            effectiveFrom: facts.from,
            effectiveTo: facts.until,
            provenance: {
              decisionEvidenceRefs: ['internal-fixture:governance-decision'],
              policyRef: facts.policy.policyKey,
              policyVersion: facts.policy.policyVersion,
              reason: 'Explicit native internal contract fixture; no production assertion',
              recordedAt: facts.from,
            },
            scope: {
              controllerRef: facts.authorization.scopeTemplate.controllerRef,
              operation: facts.authorization.scopeTemplate.operation,
              processingScopeRef: facts.authorization.scopeTemplate.processingScopeRef,
              purposeRef: purpose.purposeRef,
              purposeVersionId: firstVersion.versionId,
            },
          });
          yield* repository.assignLegalBasis(tenantId, legalEntityId, yield* nextId(), assignment);
          yield* authorizations.create(facts.authorization, yield* nextId());
          for (const { recordId, subjectId } of subjects) {
            yield* authorizations.admit({
              actionInvocationId: yield* nextId(),
              admittedAt: facts.from,
              authorizationId: facts.authorization.authorizationRef.resourceId,
              sources: [
                { role: 'SUBJECT', source: { ...facts.route, recordId } },
                { role: 'CHILD', source: { ...facts.route, recordId: `contact:${recordId}` } },
              ],
              subjectId,
            });
          }
          return { ...facts, assignment };
        }),
      )
      .pipe(Effect.provide(native.layer));
    const intendedScope = sourceProcessingIntendedScope(
      fixture.authorization.scopeTemplate,
      subjectRefOfTenant(subjectOne),
    );
    // The integration acts with its own machine credential; no setting names a context, subject or occurrence.
    const { principal } = native;
    const read = (input: SourceProcessingEligibilityRequest = fixture.request) =>
      native.runtime
        .runRead({
          input,
          principal,
          registration: sourceProcessingEligibilityRead,
          transport: { correlationId: `source-processing:${input.source?.occurrenceId ?? 'native-owner'}` },
        })
        .pipe(Effect.provide(native.layer));
    expect((yield* read()).outcome).toBe('ALLOWED');
    const child = yield* read(fixture.requestFor('contact:client:one', 'occurrence:child'));
    expect(child.outcome === 'ALLOWED' && child.evidence.evaluatedScope.subjectRef.resourceId).toBe(subjectOne);
    const second = yield* read(fixture.requestFor('client:two', 'occurrence:second-idempotency-key'));
    expect(second.outcome).toBe('ALLOWED');
    expect(second.outcome === 'ALLOWED' ? second.evidence.evaluatedScope.subjectRef.resourceId : '').toBe(subjectTwo);
    expect((yield* read(fixture.requestFor('client:unadmitted', 'occurrence:three'))).outcome).toBe('DENIED');
    const oneSource = { ...fixture.route, occurrenceId: 'occurrence:one', recordId: 'client:one' };
    expect((yield* read({ ...fixture.request, source: { ...oneSource, issuer: 'foreign:issuer' } })).outcome).toBe(
      'DENIED',
    );
    expect((yield* read({ ...fixture.request, source: { ...oneSource, routeRef: 'route:other' } })).outcome).toBe(
      'DENIED',
    );
    expect(
      (yield* read({ ...fixture.request, target: { kind: 'PARTY', resourceId: 'fixture:party-target' } })).outcome,
    ).toBe('DENIED');
    expect((yield* read({ ...fixture.request, operation: 'READ' })).outcome).toBe('DENIED');
    yield* native
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* restrictCurrentProcessing() {
          const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
          const actionInvocationId = yield* nextId();
          yield* repository.recordProcessingIntervention(tenantId, legalEntityId, actionInvocationId, {
            actionInvocationId,
            asOf: fixture.from,
            authorityRef: 'fixture:current-restriction-authority',
            evidenceRefs: ['fixture:restriction-decision'],
            intervention: {
              currentness: {
                authoritative: true,
                observedAt: fixture.from,
                revision: 'restriction:1',
                sourceRef: 'fixture:current-restriction-authority',
              },
              interventionRef: `fixture:restriction:${tenantId}`,
              kind: 'RESTRICTION',
              scope: intendedScope,
              status: 'ACTIVE',
            },
            legalEntityId,
            receiptRef: 'fixture:restriction-receipt',
            tenantId,
          });
        }),
      )
      .pipe(Effect.provide(native.layer));
    expect(yield* read()).toMatchObject({ outcome: 'DENIED', reason: 'PROCESSING_NOT_ALLOWED' });
    // A restriction of one subject leaves the other customer of the same route untouched.
    expect((yield* read(fixture.requestFor('client:two', 'occurrence:during-restriction'))).outcome).toBe('ALLOWED');
    yield* native
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* resolveRestriction() {
          const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
          const actionInvocationId = yield* nextId();
          const observedAt = '2026-11-02T00:00:00.000Z';
          yield* repository.recordProcessingIntervention(tenantId, legalEntityId, actionInvocationId, {
            actionInvocationId,
            asOf: observedAt,
            authorityRef: 'fixture:restriction-resolved',
            evidenceRefs: ['fixture:restriction-resolution'],
            intervention: {
              currentness: {
                authoritative: true,
                observedAt,
                revision: 'restriction:2',
                sourceRef: 'fixture:restriction-resolved',
              },
              interventionRef: `fixture:restriction-resolved:${tenantId}`,
              kind: 'RESTRICTION',
              scope: intendedScope,
              status: 'RESOLVED',
            },
            legalEntityId,
            receiptRef: 'fixture:restriction-resolution-receipt',
            tenantId,
          });
        }),
      )
      .pipe(Effect.provide(native.layer));
    const allowed = yield* read();
    expect(allowed.outcome).toBe('ALLOWED');
    expect(yield* read()).toMatchObject({
      authorityIncarnation: fixture.authorization.authorizationRef.resourceId,
      authorityRevision: '1',
      outcome: 'ALLOWED',
    });
    yield* native
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* rejectCurrentBasis() {
          const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
          yield* repository.assignLegalBasis(
            tenantId,
            legalEntityId,
            yield* nextId(),
            Schema.decodeUnknownSync(PrivacyLegalBasisAssignmentSchema)({
              ...fixture.assignment,
              assignmentRef: { ...fixture.assignment.assignmentRef, resourceId: yield* nextId() },
              decision: 'REJECTED',
            }),
          );
        }),
      )
      .pipe(Effect.provide(native.layer));
    expect(yield* read()).toMatchObject({ outcome: 'DENIED', reason: 'PROCESSING_NOT_ALLOWED' });

    // Valid owner-enforcement receipt fixture persisted only inside this owner's native setup.
    const handoff = {
      contentScopeRefs: fixture.authorization.scopeTemplate.dataCategoryRefs,
      controllerObligationRef: 'fixture:erasure-obligation',
      dispositionDecision: 'DELETE' as const,
      expectedEvidenceRefs: ['fixture:owner-erasure-proof'],
      idempotencyKey: `fixture:erasure:${tenantId}`,
      kind: 'DELETE' as const,
      measureId: `fixture:erasure:${tenantId}`,
      owningCapability: 'party.registry',
      preconditionRefs: ['fixture:erasure-authorized'],
      requestedAt: fixture.from,
      requestedResult: 'irreversible disposition',
      resourceRefs: [subjectOne],
      right: 'ERASURE' as const,
      sourceDecisionRef: 'fixture:erasure-decision',
      sourceDecisionRevision: 1,
      subjectRef: subjectOne,
      taskId: `fixture:erase-task:${tenantId}`,
      tenantId,
    };
    const outcome = {
      attempt: 1,
      evidenceRefs: ['fixture:owner-erasure-proof'],
      idempotencyKey: handoff.idempotencyKey,
      includedResourceRefs: handoff.resourceRefs,
      measureId: handoff.measureId,
      occurredAt: fixture.from,
      outcomeId: `fixture:erased:${tenantId}`,
      owningCapability: handoff.owningCapability,
      reason: 'Explicit native erasure-enforcement receipt fixture',
      recordedAt: fixture.from,
      remainingResourceRefs: [],
      sourceDecisionRef: handoff.sourceDecisionRef,
      sourceDecisionRevision: 1,
      status: 'SUCCEEDED' as const,
      taskId: handoff.taskId,
    };
    const protection = yield* createAntiResurrectionProtection({
      authority: {
        authorityRef: 'fixture:owner-erasure-authority',
        contentScopeRefs: handoff.contentScopeRefs,
        evidenceRefs: outcome.evidenceRefs,
        outcome,
        receiptRef: outcome.outcomeId,
        resourceRefs: handoff.resourceRefs,
        subjectRef: handoff.subjectRef,
        tenantId,
      },
      enforcementReceipt: {
        authorityRef: 'fixture:owner-enforcement',
        contentScopeRefs: handoff.contentScopeRefs,
        evidenceRefs: ['fixture:all-recovery-gates'],
        measure: 'DELETE',
        operations: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
        ownerModuleId: handoff.owningCapability,
        receiptRef: 'fixture:all-recovery-enforced',
        resourceRefs: handoff.resourceRefs,
        subjectRef: handoff.subjectRef,
        taskId: handoff.taskId,
        tenantId,
      },
      handoff,
      protectedAt: fixture.from,
      protectionId: `fixture:protection:${tenantId}`,
    });
    yield* native
      .prepareOwner((transaction) =>
        transaction.insert(antiResurrectionProtections).values({
          legalEntityId,
          measure: protection.measure,
          protectedAt: new Date(protection.protectedAt),
          protectionId: protection.protectionId,
          protectionRecord: Schema.encodeSync(AntiResurrectionProtectionSchema)(protection),
          subjectRef: protection.subjectRef,
          tenantId,
        }),
      )
      .pipe(Effect.provide(native.layer));
    expect(yield* read()).toMatchObject({ outcome: 'DENIED', reason: 'PROTECTED_MATERIAL' });
    // Replays and later occurrences of the protected record stay blocked; the protection follows the subject.
    expect(yield* read(fixture.requestFor('client:one', 'occurrence:two'))).toMatchObject({
      outcome: 'DENIED',
      reason: 'PROTECTED_MATERIAL',
    });
    expect(yield* read()).toMatchObject({ outcome: 'DENIED', reason: 'PROTECTED_MATERIAL' });
    // Storage-level negative: a retained DATA_SUBJECT link must preserve its original source
    // tombstone even if a new request names a different source. This does not assert admission.
    const sourceBridge = yield* native
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* originalSourceProtectionBridge() {
          const dataSubjectId = yield* nextId();
          const partyId = yield* nextId();
          const retained = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
            createdAt: fixture.from,
            subject: {
              kind: 'DATA_SUBJECT',
              partyRef: {
                moduleId: 'party.registry',
                resourceId: partyId,
                resourceType: 'party.registry.party',
                tenantId,
              },
              sourceAdmission: {
                occurrenceId: 'occurrence:one',
                sourceSubjectRef: subjectRefOfTenant(subjectOne),
              },
            },
            subjectRef: { ...subjectRefOfTenant(subjectOne), resourceId: dataSubjectId },
            updatedAt: fixture.from,
          });
          yield* transaction.insert(privacySubjects).values({
            createdAt: new Date(fixture.from),
            legalEntityId,
            privacySubjectId: dataSubjectId,
            sourceIdentityKey: null,
            subjectKind: 'DATA_SUBJECT',
            subjectRecord: Schema.encodeSync(PrivacySubjectRecordSchema)(retained),
            tenantId,
            updatedAt: new Date(fixture.from),
          });
          const admittedProtection = Schema.decodeUnknownSync(AntiResurrectionProtectionSchema)({
            ...protection,
            enforcementReceipt: { ...protection.enforcementReceipt, subjectRef: dataSubjectId },
            protectionId: `fixture:admitted-protection:${tenantId}`,
            subjectRef: dataSubjectId,
          });
          yield* transaction.insert(antiResurrectionProtections).values({
            legalEntityId,
            measure: admittedProtection.measure,
            protectedAt: new Date(admittedProtection.protectedAt),
            protectionId: admittedProtection.protectionId,
            protectionRecord: Schema.encodeSync(AntiResurrectionProtectionSchema)(admittedProtection),
            subjectRef: admittedProtection.subjectRef,
            tenantId,
          });
          const preTarget = yield* readSourceProtections(transaction, scope, subjectOne, fixture.request);
          const incoming = {
            ...fixture.request,
            source: { ...fixture.route, occurrenceId: 'occurrence:one', recordId: 'alias:new-source-record' },
            target: { kind: 'PARTY' as const, resourceId: partyId },
          };
          const alias = yield* readSourceProtections(transaction, scope, dataSubjectId, incoming);
          const nativeOwner = yield* readSourceProtections(transaction, scope, dataSubjectId, {
            ...incoming,
            source: null,
          });
          return { admittedProtection, alias, dataSubjectId, nativeOwner, preTarget };
        }),
      )
      .pipe(Effect.provide(native.layer));
    for (const lookup of [sourceBridge.alias, sourceBridge.nativeOwner]) {
      expect(lookup.sourceSubjectRefs).toContain(subjectOne);
      expect(lookup.items.map((item) => item.protectionId)).toContain(protection.protectionId);
    }
    expect(sourceBridge.preTarget.sourceSubjectRefs).toContain(sourceBridge.dataSubjectId);
    expect(sourceBridge.preTarget.items.map((item) => item.protectionId)).toContain(
      sourceBridge.admittedProtection.protectionId,
    );
    yield* native
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* endAuthorization() {
          const authorizations = yield* sourceProcessingAuthorizationRepositoryForScope(transaction, scope);
          yield* authorizations.end(
            {
              ...fixture.authorization,
              endedAt: DateTime.formatIso(yield* DateTime.now),
              endedBy: { principalId, tenantId },
              endReason: 'fixture:integration-removed',
              lifecycle: 'ENDED',
              revision: 2,
            },
            1,
            yield* nextId(),
          );
        }),
      )
      .pipe(Effect.provide(native.layer));
    expect(yield* read(fixture.requestFor('client:two', 'occurrence:after-end'))).toMatchObject({
      outcome: 'DENIED',
      reason: 'AUTHORITY_NOT_CURRENT',
    });
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer), Effect.provide(TestClock.layer())),
);
