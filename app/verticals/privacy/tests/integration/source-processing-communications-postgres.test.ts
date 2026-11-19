import { ReadHandlerUnavailable } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Crypto, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  SourceProcessingContextSchema,
  SourceProcessingEligibilityResponseSchema,
} from '../../shared/apis/source-processing-eligibility.ts';
import type { SourceProcessingEligibilityRequest } from '../../shared/apis/source-processing-eligibility.ts';
import {
  PrivacyApplicabilityPolicySchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyLegalBasisAssignmentSchema } from '../../shared/domain/privacy-legal-basis.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import {
  evaluateSourceProcessingEligibility,
  readSourceProtections,
  sourceSubjectMatchesRequest,
} from '../../src/api/source-processing-eligibility.read.ts';
import type { SourceProcessingEligibilityServices } from '../../src/api/source-processing-eligibility.read.ts';
import { privacySubjects } from '../../src/database/schema.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';
import { makeSourceProcessingFixture } from '../support/source-processing-fixture.ts';
import {
  freshPrivacyLedgerScope,
  inPrivacyLedger,
  privacyLedgerDatabaseLive,
} from '../support/privacy-ledger-scope.ts';
import type { PrivacyLedgerScope } from '../support/privacy-ledger-scope.ts';

/**
 * #1396 — the Privacy owner's public source-processing contract, proven against its REAL ledgers in PostgreSQL for the
 * Communications consumer. Privacy data (purpose, subject, applicability policy and decision, legal basis,
 * processing interventions) is written through the owner's own repositories; nothing about Privacy is mocked and no
 * outcome is constant. The governed Read runtime and its access gate are a separate seam (they need the SpiceDB-backed
 * native harness); the evaluator below is exactly the function that Read runs after authorization.
 */
const communications = 'communications.core' as const;
const layer = Layer.mergeAll(NodeCrypto.layer, privacyLedgerDatabaseLive);

const unavailable = () => new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'fixture' });

const servicesIn = (
  transaction: ScopedTransactionExecutor,
  scope: PrivacyLedgerScope,
  contexts: SourceProcessingEligibilityServices['contexts'],
) =>
  Effect.gen(function* realServices() {
    const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
    const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
    const services: SourceProcessingEligibilityServices = {
      contexts,
      protections: (subjectRef, request) => readSourceProtections(transaction, scope, subjectRef, request),
      purposes,
      repository,
      subjectExists: (subjectRef, request, targetAdmission) =>
        Effect.gen(function* subjectMatches() {
          const [row] = yield* transaction
            .select({ record: privacySubjects.subjectRecord })
            .from(privacySubjects)
            .where(
              and(
                eq(privacySubjects.tenantId, scope.tenantId),
                eq(privacySubjects.legalEntityId, scope.legalEntityId ?? ''),
                eq(privacySubjects.privacySubjectId, subjectRef),
              ),
            )
            .limit(1);
          if (row === undefined) {
            return false;
          }
          const record = yield* Schema.decodeUnknownEffect(PrivacySubjectRecordSchema)(row.record);
          return sourceSubjectMatchesRequest(record, request, targetAdmission);
        }).pipe(Effect.mapError(unavailable)),
    };
    return services;
  });

const seed = Effect.fn('PrivacyTests.seedCommunicationsLedger')(function* seedLedger(scope: PrivacyLedgerScope) {
  const crypto = yield* Crypto.Crypto;
  const { principalId, tenantId } = scope;
  const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId));
  return yield* inPrivacyLedger(
    scope,
    Effect.fn('PrivacyTests.seedLedgerTransaction')(function* seedTransaction(transaction) {
      const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
      const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
      const purpose = yield* purposes.create(tenantId, legalEntityId, yield* crypto.randomUUIDv4(), {
        businessCode: 'COMMUNICATIONS_ELIGIBILITY_FIXTURE',
        effectiveFrom: '2026-11-01T00:00:00.000Z',
        governanceOwnerId: principalId,
        meaning: 'Explicit fictional test purpose; no production lawfulness is asserted',
      });
      const firstVersion = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));
      const base = makeSourceProcessingFixture({
        authMethod: scope.authMethod,
        legalEntityId,
        principalId,
        purposeId: purpose.purposeRef.resourceId,
        subjectId: yield* crypto.randomUUIDv4(),
        tenantId,
        versionId: firstVersion.versionId,
      });
      const request: SourceProcessingEligibilityRequest = { ...base.request, consumerModuleId: communications };
      const context = Schema.decodeUnknownSync(SourceProcessingContextSchema)({ ...base.context, request });
      yield* repository.createSubject(
        { legalEntityId, tenantId },
        {
          actionInvocationId: yield* crypto.randomUUIDv4(),
          subject: {
            createdAt: base.from,
            subject: { kind: 'SOURCE_ASSERTED', source: base.request.source },
            subjectRef: context.intendedScope.subjectRef,
            updatedAt: base.from,
          },
        },
      );
      yield* repository.recordApplicabilityPolicy(tenantId, legalEntityId, yield* crypto.randomUUIDv4(), base.policy);
      yield* repository.recordApplicability(
        tenantId,
        legalEntityId,
        yield* crypto.randomUUIDv4(),
        context.applicabilityAuthority.decisionRef,
        base.decision,
      );
      const assignment = Schema.decodeUnknownSync(PrivacyLegalBasisAssignmentSchema)({
        actor: { principalId, tenantId },
        applicabilityDecision: base.decision,
        assignmentRef: {
          moduleId: 'privacy.core',
          resourceId: yield* crypto.randomUUIDv4(),
          resourceType: 'privacy.core.legal-basis-assignment',
          tenantId,
        },
        basis: 'CONTRACT',
        basisVersion: 'internal-explicit-contract-fixture:1',
        decision: 'APPROVED',
        effectiveFrom: base.from,
        effectiveTo: base.until,
        provenance: {
          decisionEvidenceRefs: ['internal-fixture:governance-decision'],
          policyRef: base.policy.policyKey,
          policyVersion: base.policy.policyVersion,
          reason: 'Explicit fictional contract fixture; no production assertion',
          recordedAt: base.from,
        },
        scope: {
          controllerRef: context.intendedScope.controllerRef,
          operation: base.request.operation,
          processingScopeRef: context.intendedScope.processingScopeRef,
          purposeRef: purpose.purposeRef,
          purposeVersionId: firstVersion.versionId,
        },
      });
      yield* repository.assignLegalBasis(tenantId, legalEntityId, yield* crypto.randomUUIDv4(), assignment);
      return { ...base, context, purpose, request, source: base.request.source };
    }),
  );
});

type Ledger = Effect.Success<ReturnType<typeof seed>>;

/** The public Communications-consumer check, evaluated against the real ledgers as of the fixture instant. */
const check = (
  scope: PrivacyLedgerScope,
  ledger: Ledger,
  request: SourceProcessingEligibilityRequest = ledger.request,
  contexts: SourceProcessingEligibilityServices['contexts'] = [ledger.context],
) =>
  inPrivacyLedger(
    scope,
    Effect.fn('PrivacyTests.communicationsCheck')(function* communicationsCheck(transaction) {
      const services = yield* servicesIn(transaction, scope, contexts);
      return yield* evaluateSourceProcessingEligibility(request, scope, services, ledger.evaluatedAt);
    }),
  );

const interveneOn = Effect.fn('PrivacyTests.interveneOnScope')(function* interveneOnScope(
  scope: PrivacyLedgerScope,
  ledger: Ledger,
  kind: 'OBJECTION' | 'RESTRICTION',
  status: 'ACTIVE' | 'RESOLVED',
  observedAt: string,
  revision: string,
) {
  const crypto = yield* Crypto.Crypto;
  const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId));
  yield* inPrivacyLedger(
    scope,
    Effect.fn('PrivacyTests.recordIntervention')(function* recordIntervention(transaction) {
      const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
      const actionInvocationId = yield* crypto.randomUUIDv4();
      yield* repository.recordProcessingIntervention(scope.tenantId, legalEntityId, actionInvocationId, {
        actionInvocationId,
        asOf: observedAt,
        authorityRef: `fixture:${kind.toLowerCase()}-authority`,
        evidenceRefs: [`fixture:${kind.toLowerCase()}-decision:${revision}`],
        intervention: {
          currentness: {
            authoritative: true,
            observedAt,
            revision,
            sourceRef: `fixture:${kind.toLowerCase()}-authority`,
          },
          interventionRef: `fixture:${kind.toLowerCase()}:${revision}:${scope.tenantId}`,
          kind,
          scope: ledger.context.intendedScope,
          status,
        },
        legalEntityId,
        receiptRef: `fixture:${kind.toLowerCase()}-receipt:${revision}`,
        tenantId: scope.tenantId,
      });
    }),
  );
});

/** A second exact use of the same subject that has an applicability decision but no approved legal basis. */
const withoutLegalBasis = Effect.fn('PrivacyTests.useWithoutLegalBasis')(function* useWithoutBasis(
  scope: PrivacyLedgerScope,
  ledger: Ledger,
) {
  const crypto = yield* Crypto.Crypto;
  const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId));
  return yield* inPrivacyLedger(
    scope,
    Effect.fn('PrivacyTests.recordUseWithoutBasis')(function* recordUse(transaction) {
      const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
      const policy = Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({
        ...ledger.policy,
        policyKey: `${ledger.policy.policyKey}:read`,
        scopeKey: ledger.policy.scopeKey.replace(/:CREATE$/u, ':READ'),
      });
      const authority = ledger.context.applicabilityAuthority;
      const applicabilityScope = { ...authority.scope, operation: 'READ' };
      const decision = resolvePrivacyApplicability({
        authority: authority.authority,
        authorityEvidenceRefs: authority.evidenceRefs,
        authorityReceiptRef: authority.receiptRef,
        evaluatedAt: ledger.from,
        policies: [policy],
        proposedActivity: true,
        scope: applicabilityScope,
      });
      const decisionRef = `fixture:read-applicability:${scope.tenantId}`;
      yield* repository.recordApplicabilityPolicy(scope.tenantId, legalEntityId, yield* crypto.randomUUIDv4(), policy);
      yield* repository.recordApplicability(
        scope.tenantId,
        legalEntityId,
        yield* crypto.randomUUIDv4(),
        decisionRef,
        decision,
      );
      const request: SourceProcessingEligibilityRequest = { ...ledger.request, operation: 'READ' };
      const context = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
        ...ledger.context,
        applicabilityAuthority: { ...authority, decisionRef, scope: applicabilityScope },
        intendedScope: { ...ledger.context.intendedScope, operation: 'READ' },
        request,
      });
      return { context, request };
    }),
  );
});

const denialOf = (response: Effect.Success<ReturnType<typeof check>>) =>
  response.outcome === 'DENIED' ? response : undefined;

it.live('proves ALLOWED, NOT_ALLOWED and INDETERMINATE as three distinct owner results for Communications', () =>
  Effect.gen(function* threeOutcomes() {
    const scope = yield* freshPrivacyLedgerScope();
    const ledger = yield* seed(scope);

    // ALLOWED: the exact current use has an applicability decision, an approved basis and no blocking intervention.
    const allowed = yield* check(scope, ledger);
    expect(allowed.outcome).toBe('ALLOWED');
    if (allowed.outcome === 'ALLOWED') {
      expect(allowed.evidence.outcome).toBe('ALLOWED');
      expect(allowed.evidence.evaluatedScope).toEqual(ledger.context.intendedScope);
    }

    // INDETERMINATE: another exact use of the same subject has no approved legal basis. Nothing PROVES a prohibition;
    // the mandatory input is simply not evidenced. Communications must see that, not a fabricated deny.
    const readUse = yield* withoutLegalBasis(scope, ledger);
    const indeterminate = denialOf(yield* check(scope, ledger, readUse.request, [readUse.context]));
    expect(indeterminate).toMatchObject({
      eligibility: { evidence: { outcome: 'INDETERMINATE' }, outcome: 'INDETERMINATE' },
      outcome: 'DENIED',
      reason: 'PROCESSING_NOT_ALLOWED',
    });

    // NOT_ALLOWED: an authoritative, current Processing Restriction of exactly this scope prohibits it.
    yield* interveneOn(scope, ledger, 'RESTRICTION', 'ACTIVE', '2026-11-02T00:00:00.000Z', 'restriction:1');
    const notAllowed = denialOf(yield* check(scope, ledger));
    expect(notAllowed).toMatchObject({
      eligibility: { evidence: { outcome: 'NOT_ALLOWED' }, outcome: 'NOT_ALLOWED' },
      outcome: 'DENIED',
      reason: 'PROCESSING_NOT_ALLOWED',
    });
    expect(notAllowed?.eligibility?.evidence.reasonCodes.length).toBeGreaterThan(0);
    expect(notAllowed?.eligibility?.evidence.reasonCodes).not.toEqual(indeterminate?.eligibility?.evidence.reasonCodes);
    // Every response is a valid public response.
    for (const response of [allowed, indeterminate, notAllowed]) {
      expect(Schema.is(SourceProcessingEligibilityResponseSchema)(response)).toBe(true);
    }
  }).pipe(Effect.provide(layer)),
);

it.live('respects a Privacy change made after an earlier ALLOWED, and recovers only through a new Current check', () =>
  Effect.gen(function* changeBetweenQueuedAndHandoff() {
    const scope = yield* freshPrivacyLedgerScope();
    const ledger = yield* seed(scope);
    expect((yield* check(scope, ledger)).outcome).toBe('ALLOWED');
    // A withdrawal-like intervention lands before the last stoppable handoff: the new Current check must stop it.
    yield* interveneOn(scope, ledger, 'OBJECTION', 'ACTIVE', '2026-11-03T00:00:00.000Z', 'objection:1');
    expect(denialOf(yield* check(scope, ledger))?.eligibility?.outcome).toBe('NOT_ALLOWED');
    // Resolving it is a new owner fact; only a fresh Current check can produce ALLOWED again.
    yield* interveneOn(scope, ledger, 'OBJECTION', 'RESOLVED', '2026-11-04T00:00:00.000Z', 'objection:2');
    expect((yield* check(scope, ledger)).outcome).toBe('ALLOWED');
  }).pipe(Effect.provide(layer)),
);

it.live('never reuses an ALLOWED across subject, purpose, controller or an unconfigured context', () =>
  Effect.gen(function* noReuseAcrossScope() {
    const scope = yield* freshPrivacyLedgerScope();
    const ledger = yield* seed(scope);
    expect((yield* check(scope, ledger)).outcome).toBe('ALLOWED');
    // A different source record (another subject) has no configured context: no ALLOWED, and no evaluation to read.
    const otherRecord = {
      ...ledger.request,
      source: { ...ledger.source, recordId: 'client:another-person' },
    };
    expect(yield* check(scope, ledger, otherRecord)).toEqual({
      evaluatedAt: ledger.evaluatedAt,
      outcome: 'DENIED',
      reason: 'AUTHORITY_NOT_CURRENT',
    });
    // The same record asked for another operation (processing activity) has no configured context either.
    const otherOperation = { ...ledger.request, operation: 'SEND_MARKETING' };
    expect(yield* check(scope, ledger, otherOperation)).toEqual({
      evaluatedAt: ledger.evaluatedAt,
      outcome: 'DENIED',
      reason: 'AUTHORITY_NOT_CURRENT',
    });
    // Nothing configured at all (for example the Auth pre-verification occurrence): not a Privacy prohibition either.
    expect(yield* check(scope, ledger, ledger.request, [])).toEqual({
      evaluatedAt: ledger.evaluatedAt,
      outcome: 'DENIED',
      reason: 'AUTHORITY_NOT_CURRENT',
    });
  }).pipe(Effect.provide(layer)),
);

it.live('keeps the response of every other consumer exactly as it was, even for the same non-allowed decision', () =>
  Effect.gen(function* existingConsumersUnchanged() {
    const scope = yield* freshPrivacyLedgerScope();
    const ledger = yield* seed(scope);
    yield* interveneOn(scope, ledger, 'RESTRICTION', 'ACTIVE', '2026-11-02T00:00:00.000Z', 'restriction:1');
    const partyRequest: SourceProcessingEligibilityRequest = { ...ledger.request, consumerModuleId: 'party.registry' };
    const partyContext = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
      ...ledger.context,
      request: partyRequest,
    });
    const party = yield* check(scope, ledger, partyRequest, [partyContext]);
    // `toEqual` on the exact object: no `eligibility` key, no evidence, nothing added for a non-Communications consumer.
    expect(party).toEqual({ evaluatedAt: ledger.evaluatedAt, outcome: 'DENIED', reason: 'PROCESSING_NOT_ALLOWED' });
    expect(Object.keys(party)).toEqual(['evaluatedAt', 'outcome', 'reason']);
    // The same decision for Communications additionally carries the owner's own distinction.
    expect(denialOf(yield* check(scope, ledger))?.eligibility?.outcome).toBe('NOT_ALLOWED');
  }).pipe(Effect.provide(layer)),
);
