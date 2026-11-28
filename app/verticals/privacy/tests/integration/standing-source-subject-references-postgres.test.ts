import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { SourceProcessingEligibilityRequestSchema } from '@app/privacy-contracts/source-processing-eligibility';
import type { SourceProcessingEligibilityRequest } from '@app/privacy-contracts/source-processing-eligibility';
import { PrivacyLegalBasisAssignmentSchema } from '../../shared/domain/privacy-legal-basis.ts';
import {
  SourceProcessingAuthorizationSchema,
  sourceProcessingIntendedScope,
} from '../../shared/domain/privacy-source-processing-authorization.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import {
  evaluateSourceProcessingEligibility,
  sourceProcessingEligibilityServices,
} from '../../src/api/source-processing-eligibility.read.ts';
import type { SourceProcessingEligibilityServices } from '../../src/api/source-processing-eligibility.read.ts';
import { privacySubjects } from '../../src/database/schema.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';
import { sourceProcessingAuthorizationRepositoryForScope } from '../../src/persistence/source-processing-authorization-postgres-repository.ts';
import {
  freshPrivacyLedgerScope,
  inPrivacyLedger,
  privacyLedgerDatabaseLive,
} from '../support/privacy-ledger-scope.ts';
import { makeStandingSourceFixture } from '../support/standing-source-fixture.ts';

/**
 * The standing source authorization against Privacy's REAL ledgers in PostgreSQL, through the same owner-local services
 * the governed Read builds: the route history, the admissions, the subject records and the intervention ledger. Only the
 * owner proofs of Party and Commerce are replaced (they are other deployments, proven by their own suites and by C14):
 * here an owner proof always holds, so every denial below is Privacy's own decision.
 */
const layer = Layer.mergeAll(NodeCrypto.layer, privacyLedgerDatabaseLive);

/** The route also carries the Party target of an export and the personal Symmy intake. */
const withRouteGrants = (authorization: ReturnType<typeof makeStandingSourceFixture>['authorization']) =>
  Schema.decodeUnknownSync(SourceProcessingAuthorizationSchema)({
    ...Schema.encodeSync(SourceProcessingAuthorizationSchema)(authorization),
    grants: [
      { allowTargetless: true, consumerModuleId: 'party.registry', operation: 'CREATE', targetKinds: ['PARTY'] },
      {
        allowTargetless: true,
        consumerModuleId: 'integration.symmy',
        operation: 'CUSTOMER_SOURCE_INTAKE',
        targetKinds: [],
      },
    ],
  });

it.live(
  'keeps a restriction across both subject references and a renewal, and commits no binding by evaluating a use',
  () =>
    Effect.gen(function* subjectReferences() {
      const crypto = yield* Crypto.Crypto;
      const nextId = () => crypto.randomUUIDv4();
      const scope = yield* freshPrivacyLedgerScope('api_key');
      const { principalId, tenantId } = scope;
      const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId));
      const caller = (appId: string) =>
        trustVerifiedGatewayPrincipalContext(scope, 'e'.repeat(64), undefined, {
          appId,
          buildMarker: 'fixture',
          principalId,
        });
      const subjectRef = (resourceId: string) => ({
        moduleId: 'privacy.core' as const,
        resourceId,
        resourceType: 'privacy.core.privacy-subject' as const,
        tenantId,
      });
      const partyRef = (resourceId: string) => ({
        moduleId: 'party.registry' as const,
        resourceId,
        resourceType: 'party.registry.party' as const,
        tenantId,
      });
      const [assertedOne, assertedTwo, reconciledOne, reconciledTwo, partyOne, partyTwo] = yield* Effect.all(
        [nextId(), nextId(), nextId(), nextId(), nextId(), nextId()],
        { concurrency: 1 },
      );
      yield* inPrivacyLedger(
        scope,
        Effect.fn('PrivacyTests.standingSourceSubjectReferences')(function* inLedger(
          transaction: ScopedTransactionExecutor,
        ) {
          const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
          const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
          const authorizations = yield* sourceProcessingAuthorizationRepositoryForScope(transaction, scope);
          const purpose = yield* purposes.create(tenantId, legalEntityId, yield* nextId(), {
            businessCode: 'STANDING_SOURCE_SUBJECT_REFERENCES',
            effectiveFrom: '2026-11-01T00:00:00.000Z',
            governanceOwnerId: principalId,
            meaning: 'Explicit internal source ingestion fixture without synthetic consent',
          });
          const { versionId } = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));

          /** Records the governed facts of one grant of the route and returns it. */
          const grantRoute = Effect.fn('PrivacyTests.grantRoute')(function* grantRoute() {
            const facts = makeStandingSourceFixture({
              authorizationId: yield* nextId(),
              basisId: yield* nextId(),
              legalEntityId,
              principalId,
              purposeId: purpose.purposeRef.resourceId,
              responsibilityId: yield* nextId(),
              tenantId,
              versionId,
            });
            const authorization = withRouteGrants(facts.authorization);
            yield* repository.assignResponsibility(tenantId, legalEntityId, yield* nextId(), facts.controller);
            yield* repository.recordApplicabilityPolicy(tenantId, legalEntityId, yield* nextId(), facts.policy);
            yield* repository.recordApplicability(
              tenantId,
              legalEntityId,
              yield* nextId(),
              authorization.applicability.decisionRef,
              facts.decision,
            );
            yield* repository.assignLegalBasis(
              tenantId,
              legalEntityId,
              yield* nextId(),
              Schema.decodeUnknownSync(PrivacyLegalBasisAssignmentSchema)({
                actor: { principalId, tenantId },
                applicabilityDecision: facts.decision,
                assignmentRef: authorization.legalBasisAssignmentRef,
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
                  controllerRef: authorization.scopeTemplate.controllerRef,
                  operation: authorization.scopeTemplate.operation,
                  processingScopeRef: authorization.scopeTemplate.processingScopeRef,
                  purposeRef: purpose.purposeRef,
                  purposeVersionId: versionId,
                },
              }),
            );
            yield* authorizations.create(authorization, yield* nextId());
            return { ...facts, authorization };
          });
          const first = yield* grantRoute();
          const customer = (recordId: string) => ({ ...first.route, recordId });

          // First contact: each customer is admitted as its own asserted source subject. Nothing else is bound.
          for (const [recordId, subjectId] of [
            ['client:one', assertedOne],
            ['client:two', assertedTwo],
          ] as const) {
            yield* repository.createSubject(
              { legalEntityId, tenantId },
              {
                actionInvocationId: yield* nextId(),
                subject: {
                  createdAt: first.from,
                  subject: { kind: 'SOURCE_ASSERTED', source: customer(recordId) },
                  subjectRef: subjectRef(subjectId),
                  updatedAt: first.from,
                },
              },
            );
            yield* authorizations.admit({
              actionInvocationId: yield* nextId(),
              admittedAt: first.from,
              authorizationId: first.authorization.authorizationRef.resourceId,
              sources: [{ role: 'SUBJECT', source: customer(recordId) }],
              subjectId,
            });
          }

          const real = yield* sourceProcessingEligibilityServices(transaction, scope);
          const services: SourceProcessingEligibilityServices = {
            ...real,
            // Only targeted external Party proof is replaced here. Targetless processing must still load the real
            // Privacy subject and validate the admitted role: a CHILD source is not the parent's own source record.
            subjectExists: (subjectId, request, targetAdmission, admittedAs) =>
              request.target === null
                ? real.subjectExists(subjectId, request, targetAdmission, admittedAs)
                : Effect.succeed(true),
          };
          const evaluate = (request: SourceProcessingEligibilityRequest, appId: string) =>
            evaluateSourceProcessingEligibility(request, caller(appId), services, first.evaluatedAt);
          const subjectOf = (result: Effect.Success<ReturnType<typeof evaluate>>) =>
            result.outcome === 'ALLOWED' ? result.evidence.evaluatedScope.subjectRef.resourceId : result.reason;
          const intake = (recordId: string, describes: string) =>
            Schema.decodeUnknownSync(SourceProcessingEligibilityRequestSchema)({
              consumerModuleId: 'integration.symmy',
              describedSubjectSource: customer(describes),
              operation: 'CUSTOMER_SOURCE_INTAKE',
              source: { ...customer(recordId), occurrenceId: `occurrence:${recordId}` },
              target: null,
            });
          const processing = (recordId: string) => first.requestFor(recordId, `occurrence:${recordId}`);
          const exportOf = (recordId: string, partyId: string) =>
            Schema.decodeUnknownSync(SourceProcessingEligibilityRequestSchema)({
              ...processing(recordId),
              target: { kind: 'PARTY', resourceId: partyId },
            });
          const bound = (recordId: string) =>
            authorizations.admission(customer(recordId)).pipe(Effect.map(Option.isSome));

          // A use of a contact is evaluated for the customer it describes, and evaluating it commits nothing.
          expect(subjectOf(yield* evaluate(intake('contact:two', 'client:two'), 'symmy-integration'))).toBe(
            assertedTwo,
          );
          expect(yield* bound('contact:two')).toBe(false);
          expect((yield* evaluate(intake('contact:two', 'client:unadmitted'), 'symmy-integration')).outcome).toBe(
            'DENIED',
          );
          expect(yield* bound('contact:two')).toBe(false);

          // The restriction is recorded for the asserted source, before the Party owner reconciles the person.
          const restrictionRef = `fixture:restriction:${tenantId}`;
          const restrictionInvocation = yield* nextId();
          yield* repository.recordProcessingIntervention(tenantId, legalEntityId, restrictionInvocation, {
            actionInvocationId: restrictionInvocation,
            asOf: first.from,
            authorityRef: restrictionRef,
            evidenceRefs: [restrictionRef],
            intervention: {
              currentness: {
                authoritative: true,
                observedAt: first.from,
                revision: 'ACTIVE',
                sourceRef: restrictionRef,
              },
              interventionRef: restrictionRef,
              kind: 'RESTRICTION',
              scope: sourceProcessingIntendedScope(first.authorization.scopeTemplate, subjectRef(assertedOne)),
              status: 'ACTIVE',
            },
            legalEntityId,
            receiptRef: restrictionRef,
            tenantId,
          });
          // A refused plan leaves no binding behind: the contact of the restricted customer stays unbound.
          expect(yield* evaluate(intake('contact:one', 'client:one'), 'symmy-integration')).toMatchObject({
            outcome: 'DENIED',
            reason: 'PROCESSING_NOT_ALLOWED',
          });
          expect(yield* bound('contact:one')).toBe(false);

          // Reconciliation: the Party owner's person becomes a Data Subject that keeps its asserted source anchor.
          for (const [dataSubjectId, sourceSubjectId, partyId, recordId] of [
            [reconciledOne, assertedOne, partyOne, 'client:one'],
            [reconciledTwo, assertedTwo, partyTwo, 'client:two'],
          ] as const) {
            const reconciled = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
              createdAt: first.from,
              subject: {
                kind: 'DATA_SUBJECT',
                partyRef: partyRef(partyId),
                sourceAdmission: {
                  occurrenceId: `occurrence:${recordId}`,
                  sourceSubjectRef: subjectRef(sourceSubjectId),
                },
              },
              subjectRef: subjectRef(dataSubjectId),
              updatedAt: first.from,
            });
            yield* transaction.insert(privacySubjects).values({
              createdAt: new Date(first.from),
              legalEntityId,
              privacySubjectId: dataSubjectId,
              sourceIdentityKey: null,
              subjectKind: 'DATA_SUBJECT',
              subjectRecord: Schema.encodeSync(PrivacySubjectRecordSchema)(reconciled),
              tenantId,
              updatedAt: new Date(first.from),
            });
          }
          const restrictedEverywhere = Effect.fn('PrivacyTests.restrictedEverywhere')(function* restrictedEverywhere() {
            // The targetless use resolves the asserted source; the export resolves the reconciled Data Subject.
            expect(yield* evaluate(processing('client:one'), 'party-registry')).toMatchObject({
              outcome: 'DENIED',
              reason: 'PROCESSING_NOT_ALLOWED',
            });
            expect(yield* evaluate(exportOf('client:one', partyOne), 'party-registry')).toMatchObject({
              outcome: 'DENIED',
              reason: 'PROCESSING_NOT_ALLOWED',
            });
            // The other customer is untouched, through either of its references.
            expect(subjectOf(yield* evaluate(processing('client:two'), 'party-registry'))).toBe(assertedTwo);
            expect(subjectOf(yield* evaluate(exportOf('client:two', partyTwo), 'party-registry'))).toBe(reconciledTwo);
          });
          yield* restrictedEverywhere();

          // The binding is committed only now, and it is immutable: the contact cannot describe another customer.
          yield* authorizations.admit({
            actionInvocationId: yield* nextId(),
            admittedAt: first.from,
            authorizationId: first.authorization.authorizationRef.resourceId,
            sources: [
              { role: 'SUBJECT', source: customer('client:two') },
              { role: 'CHILD', source: customer('contact:two') },
            ],
            subjectId: assertedTwo,
          });
          expect(yield* bound('contact:two')).toBe(true);
          expect(subjectOf(yield* evaluate(intake('contact:two', 'client:two'), 'symmy-integration'))).toBe(
            assertedTwo,
          );
          expect((yield* evaluate(intake('contact:two', 'client:one'), 'symmy-integration')).outcome).toBe('DENIED');

          // Renewal: the grant ends and a new one starts its own ledger. Nobody is re-admitted, nothing is forgotten.
          yield* authorizations.end(
            Schema.decodeUnknownSync(SourceProcessingAuthorizationSchema)({
              ...Schema.encodeSync(SourceProcessingAuthorizationSchema)(first.authorization),
              endedAt: first.from,
              endedBy: { principalId, tenantId },
              endReason: 'fixture:renewed',
              lifecycle: 'ENDED',
              revision: 2,
            }),
            1,
            yield* nextId(),
          );
          expect(yield* evaluate(processing('client:two'), 'party-registry')).toMatchObject({
            outcome: 'DENIED',
            reason: 'AUTHORITY_NOT_CURRENT',
          });
          yield* grantRoute();
          yield* restrictedEverywhere();
        }),
      );
    }).pipe(Effect.provide(layer)),
  { timeout: 60_000 },
);
