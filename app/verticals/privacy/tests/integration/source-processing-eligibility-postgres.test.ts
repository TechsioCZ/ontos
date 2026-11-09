import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { privacyRegistration } from '../../vertical.registration.ts';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Crypto, DateTime, Effect, Option, Schema } from 'effect';
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
import type { SourceProcessingEligibilityRequest } from '../../shared/apis/source-processing-eligibility.ts';
import { SourceProcessingContextSchema } from '../../shared/apis/source-processing-eligibility.ts';
import {
  PrivacyApplicabilityPolicySchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyLegalBasisAssignmentSchema } from '../../shared/domain/privacy-legal-basis.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';
import { makeSourceProcessingFixture } from '../support/source-processing-fixture.ts';

it.live('checks exact current source processing through governed Read and native Privacy ledgers', () =>
  Effect.gen(function* nativeSourceProcessing() {
    yield* TestClock.setTime(new Date('2026-11-07T12:00:00.000Z').getTime());
    const native = yield* makeNativeReadTestContext({
      access: 'allowed',
      contextPermissions: ['privacy.core.source-processing-eligibility.read'],
      moduleId: 'privacy.core',
      ownerFixtureRetention: 'retain-complete-context',
    }).pipe(Effect.provideService(NativeReadTestOwnerRegistration, privacyRegistration));
    const crypto = yield* Crypto.Crypto;
    const nextId = () => crypto.randomUUIDv4();
    const { tenantId } = native.principal;
    const { principalId } = native.principal;
    const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(native.principal.legalEntityId));
    const fixture = yield* native
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* setupPrivacyFacts() {
          const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
          const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
          const purpose = yield* purposes.create(tenantId, legalEntityId, yield* nextId(), {
            businessCode: 'SOURCE_PROCESSING_NATIVE',
            effectiveFrom: '2026-11-01T00:00:00.000Z',
            governanceOwnerId: principalId,
            meaning: 'Explicit internal source ingestion fixture without synthetic consent',
          });
          const firstVersion = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));
          const facts = makeSourceProcessingFixture({
            authMethod: native.principal.authMethod,
            evaluatedAt: DateTime.formatIso(yield* DateTime.now),
            legalEntityId,
            principalId,
            purposeId: purpose.purposeRef.resourceId,
            subjectId: yield* nextId(),
            tenantId,
            versionId: firstVersion.versionId,
          });
          yield* repository.createSubject(
            { legalEntityId, tenantId },
            {
              actionInvocationId: yield* nextId(),
              subject: {
                createdAt: facts.from,
                subject: { kind: 'SOURCE_ASSERTED', source: facts.request.source },
                subjectRef: facts.context.intendedScope.subjectRef,
                updatedAt: facts.from,
              },
            },
          );
          const collided = yield* Effect.flip(
            repository.createSubject(
              { legalEntityId, tenantId },
              {
                actionInvocationId: yield* nextId(),
                subject: {
                  createdAt: facts.from,
                  subject: { kind: 'SOURCE_ASSERTED', source: facts.request.source },
                  subjectRef: { ...facts.context.intendedScope.subjectRef, resourceId: yield* nextId() },
                  updatedAt: facts.from,
                },
              },
            ),
          );
          expect(collided.code).toBe('privacy_operation_conflict');
          const substituted = yield* Effect.flip(
            repository.createSubject(
              { legalEntityId, tenantId },
              {
                actionInvocationId: yield* nextId(),
                subject: {
                  createdAt: facts.from,
                  subject: { kind: 'SOURCE_ASSERTED', source: { ...facts.request.source, issuer: 'foreign:issuer' } },
                  subjectRef: facts.context.intendedScope.subjectRef,
                  updatedAt: facts.from,
                },
              },
            ),
          );
          expect(substituted.code).toBe('privacy_operation_conflict');
          yield* repository.recordApplicabilityPolicy(tenantId, legalEntityId, yield* nextId(), facts.policy);
          yield* repository.recordApplicability(
            tenantId,
            legalEntityId,
            yield* nextId(),
            facts.context.applicabilityAuthority.decisionRef,
            facts.decision,
          );
          const assignment = Schema.decodeUnknownSync(PrivacyLegalBasisAssignmentSchema)({
            actor: { principalId, tenantId },
            applicabilityDecision: facts.decision,
            assignmentRef: {
              moduleId: 'privacy.core',
              resourceId: yield* nextId(),
              resourceType: 'privacy.core.legal-basis-assignment',
              tenantId,
            },
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
              controllerRef: facts.context.intendedScope.controllerRef,
              operation: facts.request.operation,
              processingScopeRef: facts.context.intendedScope.processingScopeRef,
              purposeRef: purpose.purposeRef,
              purposeVersionId: firstVersion.versionId,
            },
          });
          yield* repository.assignLegalBasis(tenantId, legalEntityId, yield* nextId(), assignment);
          return { ...facts, assignment };
        }),
      )
      .pipe(Effect.provide(native.layer));
    const read = (contexts = [fixture.context], input: SourceProcessingEligibilityRequest = fixture.request) =>
      native.runtime
        .runRead({
          input,
          principal: native.principal,
          registration: sourceProcessingEligibilityRead,
          transport: { correlationId: `source-processing:${input.source?.occurrenceId ?? 'native-owner'}` },
        })
        .pipe(
          Effect.provide(native.layer),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: JSON.stringify(contexts) }),
          ),
        );
    expect((yield* read()).outcome).toBe('ALLOWED');
    const foreignRequest = { ...fixture.request, source: { ...fixture.request.source, issuer: 'foreign:issuer' } };
    expect((yield* read([{ ...fixture.context, request: foreignRequest }], foreignRequest)).outcome).toBe('DENIED');
    const partyRequest = { ...fixture.request, target: { kind: 'PARTY' as const, resourceId: 'fixture:party-target' } };
    expect(
      (yield* read(
        [{ ...fixture.context, request: partyRequest, resourceRefs: ['fixture:party-target'] }],
        partyRequest,
      )).outcome,
    ).toBe('DENIED');

    const readContext = yield* native
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* readRequiresItsOwnLegalBasis() {
          const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
          const policy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
            ...fixture.policy,
            policyKey: `${fixture.policy.policyKey}:read`,
            scopeKey: fixture.policy.scopeKey.replace(/:CREATE$/u, ':READ'),
          });
          const authority = fixture.context.applicabilityAuthority;
          const applicabilityScope = { ...authority.scope, operation: 'READ' };
          const decision = resolvePrivacyApplicability({
            authority: authority.authority,
            authorityEvidenceRefs: authority.evidenceRefs,
            authorityReceiptRef: authority.receiptRef,
            evaluatedAt: fixture.from,
            policies: [policy],
            proposedActivity: true,
            scope: applicabilityScope,
          });
          const decisionRef = `fixture:read-applicability:${tenantId}`;
          yield* repository.recordApplicabilityPolicy(tenantId, legalEntityId, yield* nextId(), policy);
          yield* repository.recordApplicability(tenantId, legalEntityId, yield* nextId(), decisionRef, decision);
          return Schema.decodeUnknownSync(SourceProcessingContextSchema)({
            ...fixture.context,
            applicabilityAuthority: { ...authority, decisionRef, scope: applicabilityScope },
            intendedScope: { ...fixture.context.intendedScope, operation: 'READ' },
            request: { ...fixture.request, operation: 'READ' },
          });
        }),
      )
      .pipe(Effect.provide(native.layer));
    expect(yield* read([readContext], { ...fixture.request, operation: 'READ' })).toMatchObject({
      outcome: 'DENIED',
      reason: 'PROCESSING_NOT_ALLOWED',
    });

    expect((yield* read([], fixture.request)).outcome).toBe('DENIED');
    expect(
      (yield* read([fixture.context], {
        ...fixture.request,
        source: { ...fixture.request.source, issuer: 'foreign:issuer' },
      })).outcome,
    ).toBe('DENIED');
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
              scope: fixture.context.intendedScope,
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
    yield* native
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* resolveRestrictionAndRejectBasis() {
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
              scope: fixture.context.intendedScope,
              status: 'RESOLVED',
            },
            legalEntityId,
            receiptRef: 'fixture:restriction-resolution-receipt',
            tenantId,
          });
        }),
      )
      .pipe(Effect.provide(native.layer));
    expect((yield* read()).outcome).toBe('ALLOWED');
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
      contentScopeRefs: fixture.context.contentScopeRefs,
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
      resourceRefs: fixture.context.resourceRefs,
      right: 'ERASURE' as const,
      sourceDecisionRef: 'fixture:erasure-decision',
      sourceDecisionRevision: 1,
      subjectRef: fixture.context.intendedScope.subjectRef.resourceId,
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
    expect(yield* read([{ ...fixture.context, resourceRefs: ['newly-configured:source-resource'] }])).toMatchObject({
      outcome: 'DENIED',
      reason: 'PROTECTED_MATERIAL',
    });
    expect(yield* read([{ ...fixture.context, contentScopeRefs: ['renamed:new-source-projection'] }])).toMatchObject({
      outcome: 'DENIED',
      reason: 'PROTECTED_MATERIAL',
    });
    const nextOccurrence = {
      ...fixture.request,
      source: { ...fixture.request.source, occurrenceId: 'occurrence:two' },
    };
    expect(yield* read([{ ...fixture.context, request: nextOccurrence }], nextOccurrence)).toMatchObject({
      outcome: 'DENIED',
      reason: 'PROTECTED_MATERIAL',
    });
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
                occurrenceId: fixture.request.source.occurrenceId,
                sourceSubjectRef: fixture.context.intendedScope.subjectRef,
              },
            },
            subjectRef: { ...fixture.context.intendedScope.subjectRef, resourceId: dataSubjectId },
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
          const preTarget = yield* readSourceProtections(
            transaction,
            scope,
            fixture.context.intendedScope.subjectRef.resourceId,
            fixture.request,
          );
          const incoming = {
            ...fixture.request,
            source: { ...fixture.request.source, recordId: 'alias:new-source-record' },
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
      expect(lookup.sourceSubjectRefs).toContain(fixture.context.intendedScope.subjectRef.resourceId);
      expect(lookup.items.map((item) => item.protectionId)).toContain(protection.protectionId);
    }
    expect(sourceBridge.preTarget.sourceSubjectRefs).toContain(sourceBridge.dataSubjectId);
    expect(sourceBridge.preTarget.items.map((item) => item.protectionId)).toContain(
      sourceBridge.admittedProtection.protectionId,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer), Effect.provide(TestClock.layer())),
);
