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
import type {
  SourceProcessingContext,
  SourceProcessingEligibilityRequest,
} from '../../shared/apis/source-processing-eligibility.ts';
import {
  PrivacyApplicabilityPolicySchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyLegalBasisAssignmentSchema } from '../../shared/domain/privacy-legal-basis.ts';
import { PrivacyPartyRefSchema } from '../../shared/domain/party-reference.ts';
import { PrivacySubjectOwnerEvidenceSchema, PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import {
  evaluateSourceProcessingEligibility,
  readSourceProtections,
  sourceSubjectMatchesRequest,
} from '../../src/api/source-processing-eligibility.read.ts';
import type { SourceProcessingEligibilityServices } from '../../src/api/source-processing-eligibility.read.ts';
import { privacySubjects } from '../../src/database/schema.ts';
import { PrivacySubjectPartyOwner } from '../../src/persistence/privacy-subject-party-owner.ts';
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

/**
 * TEST DOUBLE of the Party owner admission, used only to store a Party-target Data Subject: the real Party owner is a
 * different seam (it needs the Party deployment). Eligibility itself never calls it for a plain Party target.
 */
const partyOwnerDouble = (observedAt: string) =>
  PrivacySubjectPartyOwner.of({
    resolve: (partyRef) =>
      Effect.succeed(
        Schema.decodeUnknownSync(PrivacySubjectOwnerEvidenceSchema)({
          observedAt,
          ownerRevision: 1,
          partyRef,
          typeAssertions: [{ assertionId: 'fixture:person-assertion', validFrom: observedAt, validTo: null }],
        }),
      ),
  });

const seed = Effect.fn('PrivacyTests.seedCommunicationsLedger')(function* seedLedger(
  scope: PrivacyLedgerScope,
  subjectKind: 'PARTY_TARGET' | 'SOURCE_ASSERTED' = 'SOURCE_ASSERTED',
) {
  const crypto = yield* Crypto.Crypto;
  const { principalId, tenantId } = scope;
  const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId));
  return yield* inPrivacyLedger(
    scope,
    Effect.fn('PrivacyTests.seedLedgerTransaction')(function* seedTransaction(transaction) {
      const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
      // The repository takes the Party owner when it is built, so the double is supplied here and only to seed a subject.
      const repository = yield* privacyOperationRepositoryForScope(transaction, scope).pipe(
        Effect.provideService(PrivacySubjectPartyOwner, partyOwnerDouble('2026-11-01T00:00:00.000Z')),
      );
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
      const partyId = `party-${yield* crypto.randomUUIDv4()}`;
      const request: SourceProcessingEligibilityRequest =
        subjectKind === 'PARTY_TARGET'
          ? {
              ...base.request,
              consumerModuleId: communications,
              source: null,
              target: { kind: 'PARTY', resourceId: partyId },
            }
          : { ...base.request, consumerModuleId: communications };
      const context = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
        ...base.context,
        request,
        resourceRefs: subjectKind === 'PARTY_TARGET' ? [partyId] : base.context.resourceRefs,
      });
      yield* repository.createSubject(
        { legalEntityId, tenantId },
        {
          actionInvocationId: yield* crypto.randomUUIDv4(),
          subject: {
            createdAt: base.from,
            subject:
              subjectKind === 'PARTY_TARGET'
                ? {
                    kind: 'DATA_SUBJECT',
                    partyRef: Schema.decodeUnknownSync(PrivacyPartyRefSchema)({
                      moduleId: 'party.registry',
                      resourceId: partyId,
                      resourceType: 'party.registry.party',
                      tenantId,
                    }),
                  }
                : { kind: 'SOURCE_ASSERTED', source: base.request.source },
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
      return { ...base, context, purpose, request, source: base.request.source, version: firstVersion };
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
  intendedScope: SourceProcessingContext['intendedScope'] = ledger.context.intendedScope,
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
          scope: intendedScope,
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

/** The owner's own reason codes of an evaluated denial; an unevaluated denial has none. */
const reasonCodesOf = (response: ReturnType<typeof denialOf>): readonly string[] =>
  response?.eligibility !== undefined && 'evidence' in response.eligibility
    ? response.eligibility.evidence.reasonCodes
    : [];

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
    expect(reasonCodesOf(notAllowed).length).toBeGreaterThan(0);
    expect(reasonCodesOf(notAllowed)).not.toEqual(reasonCodesOf(indeterminate));
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

it.live('finds no ALLOWED for another subject, operation or an unconfigured context, and says why', () =>
  Effect.gen(function* noContextForAnotherUse() {
    const scope = yield* freshPrivacyLedgerScope();
    const ledger = yield* seed(scope);
    expect((yield* check(scope, ledger)).outcome).toBe('ALLOWED');
    const notEvaluated = (cause: string) => ({
      eligibility: { outcome: 'NOT_EVALUATED', reasonCode: cause },
      evaluatedAt: ledger.evaluatedAt,
      outcome: 'DENIED',
      reason: 'AUTHORITY_NOT_CURRENT',
    });
    // A different source record (another subject) has no configured context: no ALLOWED, and no evaluation to read.
    const otherRecord = {
      ...ledger.request,
      source: { ...ledger.source, recordId: 'client:another-person' },
    };
    expect(yield* check(scope, ledger, otherRecord)).toEqual(notEvaluated('NO_CONTEXT'));
    // The same record asked for another operation (processing activity) has no configured context either.
    const otherOperation = { ...ledger.request, operation: 'SEND_MARKETING' };
    expect(yield* check(scope, ledger, otherOperation)).toEqual(notEvaluated('NO_CONTEXT'));
    // Nothing configured at all (for example the Auth pre-verification occurrence): not a Privacy prohibition either.
    expect(yield* check(scope, ledger, ledger.request, [])).toEqual(notEvaluated('NO_CONTEXT'));
    // The same use configured twice is ambiguous, which is a different fact from "no context".
    expect(yield* check(scope, ledger, ledger.request, [ledger.context, ledger.context])).toEqual(
      notEvaluated('MULTIPLE_CONTEXTS'),
    );
    // A context that is no longer within its validity is not current.
    const expired = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
      ...ledger.context,
      validUntil: '2026-11-06T00:00:00.000Z',
    });
    expect(yield* check(scope, ledger, ledger.request, [expired])).toEqual(notEvaluated('CONTEXT_NOT_CURRENT'));
    // Every one of them is a valid public response and none carries evidence of an evaluation.
    for (const response of [
      yield* check(scope, ledger, otherRecord),
      yield* check(scope, ledger, ledger.request, []),
    ]) {
      expect(Schema.is(SourceProcessingEligibilityResponseSchema)(response)).toBe(true);
    }
  }).pipe(Effect.provide(layer)),
);

it.live('says when the purpose is retired, absent or no longer the one of the context', () =>
  Effect.gen(function* purposeNotCurrent() {
    const scope = yield* freshPrivacyLedgerScope();
    const ledger = yield* seed(scope);
    const purposeDenied = {
      eligibility: { outcome: 'NOT_EVALUATED', reasonCode: 'PURPOSE_NOT_CURRENT' },
      evaluatedAt: ledger.evaluatedAt,
      outcome: 'DENIED',
      reason: 'PROCESSING_NOT_ALLOWED',
    };
    // A context for a purpose that does not exist, and for a version that is not the effective one.
    const absentPurpose = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
      ...ledger.context,
      intendedScope: { ...ledger.context.intendedScope, purposeRef: '20000000-0000-4000-8000-000000000099' },
    });
    expect(yield* check(scope, ledger, ledger.request, [absentPurpose])).toEqual(purposeDenied);
    const otherVersion = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
      ...ledger.context,
      intendedScope: { ...ledger.context.intendedScope, purposeVersionId: '20000000-0000-4000-8000-000000000098' },
    });
    expect(yield* check(scope, ledger, ledger.request, [otherVersion])).toEqual(purposeDenied);
    // Every other consumer receives its existing plain denial for the same state, byte for byte.
    const partyRequest: SourceProcessingEligibilityRequest = { ...ledger.request, consumerModuleId: 'party.registry' };
    const partyContext = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
      ...otherVersion,
      request: partyRequest,
    });
    const party = yield* check(scope, ledger, partyRequest, [partyContext]);
    expect(party).toEqual({ evaluatedAt: ledger.evaluatedAt, outcome: 'DENIED', reason: 'PROCESSING_NOT_ALLOWED' });
    expect(Object.keys(party)).toEqual(['evaluatedAt', 'outcome', 'reason']);
  }).pipe(Effect.provide(layer)),
);

it.live('keeps a blocking fact decisive over a missing input, as NOT_ALLOWED with the blocking evidence', () =>
  Effect.gen(function* blockerBeatsUnknown() {
    const scope = yield* freshPrivacyLedgerScope();
    const ledger = yield* seed(scope);
    // The READ use has no approved legal basis (an unknown input) ...
    const readUse = yield* withoutLegalBasis(scope, ledger);
    const unknownOnly = denialOf(yield* check(scope, ledger, readUse.request, [readUse.context]));
    expect(unknownOnly?.eligibility?.outcome).toBe('INDETERMINATE');
    // ... and an authoritative Restriction of exactly that use is a blocker. The blocker is decisive.
    yield* interveneOn(
      scope,
      ledger,
      'RESTRICTION',
      'ACTIVE',
      '2026-11-02T00:00:00.000Z',
      'restriction:read',
      readUse.context.intendedScope,
    );
    const both = denialOf(yield* check(scope, ledger, readUse.request, [readUse.context]));
    expect(both?.eligibility?.outcome).toBe('NOT_ALLOWED');
    expect(reasonCodesOf(both).length).toBeGreaterThan(0);
    expect(reasonCodesOf(both)).not.toEqual(reasonCodesOf(unknownOnly));
  }).pipe(Effect.provide(layer)),
);

it.live('proves the three outcomes for a Party target subject as well', () =>
  Effect.gen(function* partyTargetOutcomes() {
    const scope = yield* freshPrivacyLedgerScope();
    const ledger = yield* seed(scope, 'PARTY_TARGET');
    expect(ledger.request.source).toBeNull();
    expect(ledger.request.target?.kind).toBe('PARTY');

    const allowed = yield* check(scope, ledger);
    expect(allowed.outcome).toBe('ALLOWED');
    expect(allowed.outcome === 'ALLOWED' && allowed.evidence.evaluatedScope).toEqual(ledger.context.intendedScope);

    const readUse = yield* withoutLegalBasis(scope, ledger);
    expect(denialOf(yield* check(scope, ledger, readUse.request, [readUse.context]))?.eligibility?.outcome).toBe(
      'INDETERMINATE',
    );
    yield* interveneOn(scope, ledger, 'RESTRICTION', 'ACTIVE', '2026-11-02T00:00:00.000Z', 'restriction:party');
    expect(denialOf(yield* check(scope, ledger))?.eligibility?.outcome).toBe('NOT_ALLOWED');
    // Another Party is another subject with no configured context, never the first Party's decision.
    const otherParty = {
      ...ledger.request,
      target: { kind: 'PARTY' as const, resourceId: 'party-someone-else' },
    };
    expect(denialOf(yield* check(scope, ledger, otherParty))?.eligibility).toEqual({
      outcome: 'NOT_EVALUATED',
      reasonCode: 'NO_CONTEXT',
    });
  }).pipe(Effect.provide(layer)),
);

it.live('isolates one Tenant and one Legal Entity from another in the same cluster', () =>
  Effect.gen(function* isolation() {
    const crypto = yield* Crypto.Crypto;
    const first = yield* freshPrivacyLedgerScope();
    const second = yield* freshPrivacyLedgerScope();
    const firstLedger = yield* seed(first);
    const secondLedger = yield* seed(second);
    expect((yield* check(first, firstLedger)).outcome).toBe('ALLOWED');
    expect((yield* check(second, secondLedger)).outcome).toBe('ALLOWED');

    // A restriction in one Tenant never reaches the other, although both use the same purpose names and codes.
    yield* interveneOn(first, firstLedger, 'RESTRICTION', 'ACTIVE', '2026-11-02T00:00:00.000Z', 'restriction:tenant');
    expect(denialOf(yield* check(first, firstLedger))?.eligibility?.outcome).toBe('NOT_ALLOWED');
    expect((yield* check(second, secondLedger)).outcome).toBe('ALLOWED');

    // The first Tenant's context asked in the second Tenant's scope is no context there, whatever is stored.
    expect(yield* check(second, secondLedger, firstLedger.request, [firstLedger.context])).toMatchObject({
      eligibility: { outcome: 'NOT_EVALUATED', reasonCode: 'NO_CONTEXT' },
    });
    // And the first Tenant's subject, purpose and decision are not readable in the second Tenant's ledger: a context that
    // names them under the second Tenant's own scope finds no purpose.
    const crossTenant = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
      ...secondLedger.context,
      intendedScope: firstLedger.context.intendedScope,
    });
    expect(yield* check(second, secondLedger, secondLedger.request, [crossTenant])).toMatchObject({
      eligibility: { outcome: 'NOT_EVALUATED' },
      outcome: 'DENIED',
    });

    // Another Legal Entity of the SAME Tenant has none of the first one's ledgers either.
    const otherLegalEntity = { ...second, legalEntityId: yield* crypto.randomUUIDv4() };
    const withinOtherEntity = Schema.decodeUnknownSync(SourceProcessingContextSchema)({
      ...secondLedger.context,
      legalEntityId: otherLegalEntity.legalEntityId,
    });
    // Nothing of the first Legal Entity is visible there: the check fails closed as unavailable, never as an answer.
    const otherEntityFailure = yield* Effect.flip(
      check(otherLegalEntity, secondLedger, secondLedger.request, [withinOtherEntity]),
    );
    expect(Schema.is(ReadHandlerUnavailable)(otherEntityFailure)).toBe(true);
    // The first Legal Entity is untouched.
    expect((yield* check(second, secondLedger)).outcome).toBe('ALLOWED');
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
