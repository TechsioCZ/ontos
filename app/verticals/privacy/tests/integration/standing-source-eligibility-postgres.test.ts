import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  evaluateSourceProcessingEligibility,
  readSourceProtections,
  sourceProcessingEligibilityServices,
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
import {
  freshPrivacyLedgerScope,
  inPrivacyLedger,
  privacyLedgerDatabaseLive,
} from '../support/privacy-ledger-scope.ts';
import type { PrivacyLedgerScope } from '../support/privacy-ledger-scope.ts';
import { makeStandingSourceFixture } from '../support/standing-source-fixture.ts';

/**
 * The standing source authorization against Privacy's REAL ledgers in PostgreSQL, through the owner's own repositories
 * and the same owner-local services the governed Read builds. The governed Read runtime and its access gate are a
 * separate seam (they need an approved Application Composition; C14 proves them with the real owners).
 */
const layer = Layer.mergeAll(NodeCrypto.layer, privacyLedgerDatabaseLive);

const subjectRefOf = (tenantId: string) => (resourceId: string) => ({
  moduleId: 'privacy.core' as const,
  resourceId,
  resourceType: 'privacy.core.privacy-subject' as const,
  tenantId,
});

it.live('checks standing source-route authorization against the native Privacy ledgers', () =>
  Effect.gen(function* nativeSourceProcessing() {
    const ledgerScope = yield* freshPrivacyLedgerScope('api_key');
    /** Each step commits in its own owner transaction, as separate governed operations would. */
    const prepareOwner = <Value, Failure, Requirements>(
      body: (
        transaction: ScopedTransactionExecutor,
        scope: PrivacyLedgerScope,
      ) => Effect.Effect<Value, Failure, Requirements>,
    ) => inPrivacyLedger(ledgerScope, (transaction) => body(transaction, ledgerScope));
    const crypto = yield* Crypto.Crypto;
    const nextId = () => crypto.randomUUIDv4();
    const { principalId, tenantId } = ledgerScope;
    const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(ledgerScope.legalEntityId));
    const subjectRefOfTenant = subjectRefOf(tenantId);
    const subjectOne = yield* nextId();
    const subjectTwo = yield* nextId();
    const subjects = [
      { recordId: 'client:one', subjectId: subjectOne },
      { recordId: 'client:two', subjectId: subjectTwo },
    ];
    let fixture = yield* prepareOwner((transaction, scope) =>
      Effect.gen(function* setupPrivacyFacts() {
        const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
        const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
        const purpose = yield* purposes.create(tenantId, legalEntityId, yield* nextId(), {
          businessCode: 'SYMMY_INTEGRATION',
          effectiveFrom: '2026-11-01T00:00:00.000Z',
          governanceOwnerId: principalId,
          meaning: 'Explicit internal source ingestion fixture without synthetic consent',
        });
        const firstVersion = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));
        const facts = makeStandingSourceFixture({
          authorizationId: yield* nextId(),
          legalEntityId,
          principalId,
          purposeId: purpose.purposeRef.resourceId,
          tenantId,
          versionId: firstVersion.versionId,
        });
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
        yield* repository.assignResponsibility(tenantId, legalEntityId, yield* nextId(), facts.controller);
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
        return { ...facts, assignment };
      }),
    );
    const intendedScope = sourceProcessingIntendedScope(
      fixture.authorization.scopeTemplate,
      subjectRefOfTenant(subjectOne),
    );
    // The integration acts with its own machine credential; no setting names a context, subject or occurrence.
    const caller = trustVerifiedGatewayPrincipalContext(ledgerScope, 'e'.repeat(64), undefined, {
      appId: 'party-registry',
      buildMarker: 'fixture',
      principalId,
    });
    const read = (input: SourceProcessingEligibilityRequest = fixture.request) =>
      prepareOwner((transaction, scope) =>
        Effect.flatMap(sourceProcessingEligibilityServices(transaction, scope), (services) =>
          evaluateSourceProcessingEligibility(input, caller, services, fixture.evaluatedAt),
        ),
      );
    const intervention = (
      kind: 'RESTRICTION' | 'OBJECTION',
      status: 'ACTIVE' | 'RESOLVED',
      scopeOfUse = intendedScope,
    ) =>
      prepareOwner((transaction, scope) =>
        Effect.gen(function* recordIntervention() {
          const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
          const actionInvocationId = yield* nextId();
          const asOf = status === 'ACTIVE' ? fixture.from : '2026-11-02T00:00:00.000Z';
          const ref = `fixture:${kind}:${status}:${scopeOfUse.processingScopeRef.scopeId}:${tenantId}`;
          yield* repository.recordProcessingIntervention(tenantId, legalEntityId, actionInvocationId, {
            actionInvocationId,
            asOf,
            authorityRef: ref,
            evidenceRefs: [ref],
            intervention: {
              currentness: {
                authoritative: true,
                observedAt: asOf.replace('.000Z', 'Z'),
                revision: status,
                sourceRef: ref,
              },
              interventionRef: ref,
              kind,
              scope: scopeOfUse,
              status,
            },
            legalEntityId,
            receiptRef: ref,
            tenantId,
          });
        }),
      );
    // No exact source context is configured. Only the original, exact-use interventions are retained.
    const exactScope = {
      ...intendedScope,
      dataCategoryRefs: ['previous:customer-name'],
      operation: fixture.request.operation,
      processingScopeRef: { ...intendedScope.processingScopeRef, scopeId: 'previous:exact' },
      purposeRef: yield* nextId(),
      purposeVersionId: yield* nextId(),
      recipientRefs: ['previous:customer-registry'],
    };
    // This other controller's restriction remains active throughout the test. It cannot govern the first grant.
    yield* intervention('RESTRICTION', 'ACTIVE', {
      ...exactScope,
      controllerRef: 'controller:independent',
      processingScopeRef: { ...exactScope.processingScopeRef, scopeId: 'independent:exact' },
    });
    yield* intervention('RESTRICTION', 'ACTIVE', exactScope);
    yield* prepareOwner((transaction, scope) =>
      Effect.gen(function* firstStandingGrant() {
        const authorizations = yield* sourceProcessingAuthorizationRepositoryForScope(transaction, scope);
        yield* authorizations.create(fixture.authorization, yield* nextId());
        for (const { recordId, subjectId } of subjects) {
          yield* authorizations.admit({
            actionInvocationId: yield* nextId(),
            admittedAt: fixture.from,
            authorizationId: fixture.authorization.authorizationRef.resourceId,
            sources: [
              { role: 'SUBJECT', source: { ...fixture.route, recordId } },
              { role: 'CHILD', source: { ...fixture.route, recordId: `contact:${recordId}` } },
            ],
            subjectId,
          });
        }
      }),
    );
    yield* intervention('RESTRICTION', 'RESOLVED', {
      ...exactScope,
      processingScopeRef: { ...exactScope.processingScopeRef, scopeId: 'another:exact' },
    });
    expect(yield* read()).toMatchObject({ outcome: 'DENIED', reason: 'PROCESSING_NOT_ALLOWED' });
    yield* intervention('OBJECTION', 'ACTIVE', exactScope);
    expect((yield* read(fixture.requestFor('client:two', 'occurrence:cutover'))).outcome).toBe('ALLOWED');
    yield* intervention('RESTRICTION', 'RESOLVED', exactScope);
    expect(yield* read()).toMatchObject({ outcome: 'DENIED', reason: 'PROCESSING_NOT_ALLOWED' });
    yield* intervention('OBJECTION', 'RESOLVED', exactScope);
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
    yield* intervention('OBJECTION', 'ACTIVE');
    yield* intervention('RESTRICTION', 'ACTIVE');
    expect(yield* read()).toMatchObject({ outcome: 'DENIED', reason: 'PROCESSING_NOT_ALLOWED' });
    const other = fixture.requestFor('contact:client:two', 'occurrence:carry-forward');
    expect((yield* read(other)).outcome).toBe('ALLOWED');
    yield* prepareOwner((transaction, scope) =>
      Effect.gen(function* revoke() {
        const a = yield* sourceProcessingAuthorizationRepositoryForScope(transaction, scope);
        yield* a.end(fixture.ended, 1, yield* nextId());
      }),
    );
    expect((yield* read(other)).outcome).toBe('DENIED');
    fixture = yield* prepareOwner((transaction, scope) =>
      Effect.gen(function* replaceGrant() {
        const next = makeStandingSourceFixture({
          authorizationId: yield* nextId(),
          basisId: yield* nextId(),
          evaluatedAt: fixture.evaluatedAt,
          legalEntityId,
          principalId,
          purposeId: fixture.purpose.purposeRef.resourceId,
          responsibilityId: yield* nextId(),
          tenantId,
          versionId: fixture.authorization.scopeTemplate.purposeVersionId,
        });
        const r = yield* privacyOperationRepositoryForScope(transaction, scope);
        const a = yield* sourceProcessingAuthorizationRepositoryForScope(transaction, scope);
        yield* r.assignResponsibility(tenantId, legalEntityId, yield* nextId(), next.controller);
        yield* r.recordApplicabilityPolicy(tenantId, legalEntityId, yield* nextId(), next.policy);
        const assignment = {
          ...fixture.assignment,
          applicabilityDecision: next.decision,
          assignmentRef: next.authorization.legalBasisAssignmentRef,
          scope: {
            ...fixture.assignment.scope,
            processingScopeRef: next.authorization.scopeTemplate.processingScopeRef,
          },
        };
        yield* r.recordApplicability(
          tenantId,
          legalEntityId,
          yield* nextId(),
          next.authorization.applicability.decisionRef,
          next.decision,
        );
        yield* r.assignLegalBasis(tenantId, legalEntityId, yield* nextId(), assignment);
        yield* a.create(next.authorization, yield* nextId());
        return { ...next, assignment };
      }),
    );
    // No record was re-admitted. Only the original subject with active interventions stays blocked.
    expect((yield* read(other)).outcome).toBe('ALLOWED');
    expect((yield* read()).outcome).toBe('DENIED');
    yield* intervention('OBJECTION', 'RESOLVED');
    expect((yield* read()).outcome).toBe('DENIED');
    yield* intervention('RESTRICTION', 'RESOLVED');
    const allowed = yield* read();
    expect(allowed.outcome).toBe('ALLOWED');
    expect(yield* read()).toMatchObject({
      authorityIncarnation: fixture.authorization.authorizationRef.resourceId,
      authorityRevision: '1',
      outcome: 'ALLOWED',
    });
    yield* prepareOwner((transaction, scope) =>
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
    );
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
    yield* prepareOwner((transaction) =>
      transaction.insert(antiResurrectionProtections).values({
        legalEntityId,
        measure: protection.measure,
        protectedAt: new Date(protection.protectedAt),
        protectionId: protection.protectionId,
        protectionRecord: Schema.encodeSync(AntiResurrectionProtectionSchema)(protection),
        subjectRef: protection.subjectRef,
        tenantId,
      }),
    );
    expect(yield* read()).toMatchObject({ outcome: 'DENIED', reason: 'PROTECTED_MATERIAL' });
    // Replays and later occurrences of the protected record stay blocked; the protection follows the subject.
    expect(yield* read(fixture.requestFor('client:one', 'occurrence:two'))).toMatchObject({
      outcome: 'DENIED',
      reason: 'PROTECTED_MATERIAL',
    });
    expect(yield* read()).toMatchObject({ outcome: 'DENIED', reason: 'PROTECTED_MATERIAL' });
    // Storage-level negative: a retained DATA_SUBJECT link must preserve its original source
    // tombstone even if a new request names a different source. This does not assert admission.
    const sourceBridge = yield* prepareOwner((transaction, scope) =>
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
    );
    for (const lookup of [sourceBridge.alias, sourceBridge.nativeOwner]) {
      expect(lookup.sourceSubjectRefs).toContain(subjectOne);
      expect(lookup.items.map((item) => item.protectionId)).toContain(protection.protectionId);
    }
    expect(sourceBridge.preTarget.sourceSubjectRefs).toContain(sourceBridge.dataSubjectId);
    expect(sourceBridge.preTarget.items.map((item) => item.protectionId)).toContain(
      sourceBridge.admittedProtection.protectionId,
    );
    yield* prepareOwner((transaction, scope) =>
      Effect.gen(function* endAuthorization() {
        const authorizations = yield* sourceProcessingAuthorizationRepositoryForScope(transaction, scope);
        yield* authorizations.end(
          {
            ...fixture.authorization,
            endedAt: fixture.evaluatedAt,
            endedBy: { principalId, tenantId },
            endReason: 'fixture:integration-removed',
            lifecycle: 'ENDED',
            revision: 2,
          },
          1,
          yield* nextId(),
        );
      }),
    );
    expect(yield* read(fixture.requestFor('client:two', 'occurrence:after-end'))).toMatchObject({
      outcome: 'DENIED',
      reason: 'AUTHORITY_NOT_CURRENT',
    });
  }).pipe(Effect.provide(layer)),
);
