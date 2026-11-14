import { addTestGatewayScopeGrantCleanup } from '@app/core-runtime/testing/gateway-scope-grant';
import { eq } from 'drizzle-orm';
import { ConfigProvider, DateTime, Effect, Match, Schema } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { assert, expect, it } from 'effect-rstest';

import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { purgeFixtureRows } from '../../../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import { normalizeOfficialIdentifier } from '../../shared/domain/identifier-contracts.ts';
import type { PartyClientSourceAssertion } from '../../shared/domain/identity-contracts.ts';
import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import {
  duplicateCandidateCaseParties,
  duplicateCandidateCases,
  parties,
  partyFactAssertionIdentities,
  partyFactAssertions,
  partyMatchDecisions,
  partyOfficialIdentifiers,
  partyRelations,
} from '../../src/db/schema.ts';
import type { PartyTransaction } from '../../src/db/types.ts';
import { PartyClientSourcePrivacy } from '../../src/services/party-client-source-evidence.service.ts';
import { lockTenantIdentityWrites } from '../../src/services/party-identifier-claim.service.ts';
import {
  createOrMatchParty,
  matchParty,
  resolveDuplicateCandidateMatch,
} from '../../src/services/party-matching-persistence.service.ts';
import {
  acceptMatchingOfficialIdentifierRecord,
  addOfficialIdentifierRecord,
} from '../../src/services/party-official-identifier-persistence.service.ts';
import {
  establishPartyGatewayScope,
  openBoundaryDatabases,
  openPartyBoundaryClients,
  registerPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = 'bc100000-0000-4000-8000-000000000001';
const principalId = 'bc200000-0000-4000-8000-000000000001';

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'real PostgreSQL identity locks serialize concurrent review cases and repeated identifier acceptance',
    () =>
      Effect.gen(function* identityConcurrencyTest() {
        const clients = yield* openPartyBoundaryClients({ runtimeMaxConnections: 2 });
        const { admin, runtime } = yield* openBoundaryDatabases(
          (client) => makeTestDatabaseFromClient(client, partyRelations),
          clients,
        );
        const scope = yield* registerPartyGatewayScope(clients, { tenantId });
        yield* addTestGatewayScopeGrantCleanup(clients.admin, [tenantId]);
        const cleanup = purgeFixtureRows(
          [
            partyMatchDecisions,
            duplicateCandidateCaseParties,
            duplicateCandidateCases,
            partyOfficialIdentifiers,
            partyFactAssertions,
            // The registry references parties with ON DELETE RESTRICT and survives the assertion it
            // was registered for, so it drops between the assertions and their Party.
            partyFactAssertionIdentities,
            parties,
          ].map((table) => admin.delete(table).where(eq(table.tenantId, tenantId))),
        );
        const scoped = <Value, Failure>(operation: (transaction: PartyTransaction) => Effect.Effect<Value, Failure>) =>
          runtime.transaction((transaction) =>
            Effect.gen(function* transactionTestBody() {
              yield* establishPartyGatewayScope(transaction, scope);
              return yield* operation(transaction);
            }),
          );
        yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
        const candidate = {
          evidenceRefs: ['evidence-artifact:identity-concurrency:registry'],
          officialIdentifiers: [
            {
              identifierType: 'ICO' as const,
              value: '27074358',
            },
          ],
          partyType: 'ORGANIZATION' as const,
          provenance: { method: 'REGISTRY', source: 'identity-concurrency-test' },
          subjectEvidence: [
            {
              basis: 'REVIEWED_DOCUMENT' as const,
              evidenceRef: 'record/42',
              kind: 'ACTOR_ATTESTATION' as const,
              observedSubject: 'ORGANIZATION' as const,
              statement: 'Reviewed this external organization',
              subjectKey: partySubjectKeyFromString('one-subject'),
            },
          ],
          validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
        };
        const results = yield* Effect.forEach(
          ['bc300000-0000-4000-8000-000000000001', 'bc300000-0000-4000-8000-000000000002'],
          (actionInvocationId) =>
            scoped((transaction) =>
              createOrMatchParty(transaction, {
                actionInvocationId,
                candidate,
                principalId,
                tenantId,
              }),
            ),
          { concurrency: 'unbounded' },
        );
        const created = results.find((result) => result.outcome === 'CREATED');
        const ambiguous = results.filter((result) => result.outcome === 'AMBIGUOUS');
        expect(ambiguous).toHaveLength(1);
        if (created === undefined) {
          return yield* Effect.die(new Error('Legitimate NO_MATCH did not create one Party'));
        }
        const partyId = created.partyRef.resourceId;
        const canonical = yield* admin.select().from(parties).where(eq(parties.tenantId, tenantId));
        expect(canonical).toHaveLength(1);
        expect(canonical[0]?.currentDisplayName).toBe(null);
        const nameAssertions = yield* admin
          .select()
          .from(partyFactAssertions)
          .where(eq(partyFactAssertions.tenantId, tenantId));
        expect(nameAssertions.some((row) => row.factKind === 'DISPLAY_NAME')).toBe(false);
        const weakCandidate = candidate;
        const review = yield* scoped((transaction) =>
          matchParty(transaction, {
            actionInvocationId: 'bc300000-0000-4000-8000-000000000010',
            candidate: weakCandidate,
            tenantId,
          }),
        );
        if (review.caseRef === null) {
          return yield* Effect.die(new Error('Weak evidence did not open a review case'));
        }
        const priorId = review.caseRef.resourceId;
        yield* scoped((transaction) =>
          resolveDuplicateCandidateMatch(transaction, {
            actionInvocationId: 'bc300000-0000-4000-8000-000000000011',
            candidateCaseId: priorId,
            expectedRevision: 1,
            principalId,
            reason: 'Reviewed the external subject',
            selectedPartyId: partyId,
            selectedPartyTenantId: tenantId,
            tenantId,
          }),
        );
        const changed = yield* scoped((transaction) =>
          matchParty(transaction, {
            actionInvocationId: 'bc300000-0000-4000-8000-000000000012',
            candidate: { ...weakCandidate, evidenceRefs: ['evidence-artifact:identity-concurrency:new'] },
            priorCandidateCaseId: priorId,
            priorCaseTenantId: tenantId,
            tenantId,
          }),
        );
        expect(changed.outcome).toBe('AMBIGUOUS');
        if (changed.caseRef === null) {
          return yield* Effect.die(new Error('Changed evidence did not open a successor'));
        }
        const [successor] = yield* admin
          .select()
          .from(duplicateCandidateCases)
          .where(eq(duplicateCandidateCases.candidateCaseId, changed.caseRef.resourceId));
        expect(successor?.priorCandidateCaseId).toBe(priorId);
        const [prior] = yield* admin
          .select()
          .from(duplicateCandidateCases)
          .where(eq(duplicateCandidateCases.candidateCaseId, priorId));
        expect(prior?.lifecycleState).toBe('RESOLVED');
        expect(prior?.resolutionOutcome).toBe('MATCH_EXISTING');

        if (prior === undefined) {
          return yield* Effect.die(new Error('Prior review case disappeared'));
        }
        const explicitPriorId = 'bc400000-0000-4000-8000-000000000001';
        yield* admin.insert(duplicateCandidateCases).values({
          ...prior,
          candidateCaseId: explicitPriorId,
          createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(prior.createdAt.getTime() - 1000)),
          lifecycleState: 'DISMISSED',
          resolutionOutcome: 'DISMISSED_AS_NON_SUBJECT',
          selectedPartyId: null,
        });
        yield* admin
          .update(parties)
          .set({ archivedAt: yield* DateTime.nowAsDate })
          .where(eq(parties.partyId, partyId));
        const continuation = yield* scoped((transaction) =>
          matchParty(transaction, {
            actionInvocationId: 'bc300000-0000-4000-8000-000000000014',
            candidate: weakCandidate,
            priorCandidateCaseId: explicitPriorId,
            priorCaseTenantId: tenantId,
            tenantId,
          }),
        );
        if (continuation.caseRef === null) {
          return yield* Effect.die(new Error('Archived target did not open a successor'));
        }
        const [explicitSuccessor] = yield* admin
          .select()
          .from(duplicateCandidateCases)
          .where(eq(duplicateCandidateCases.candidateCaseId, continuation.caseRef.resourceId));
        expect(explicitSuccessor?.priorCandidateCaseId).toBe(explicitPriorId);
        yield* admin
          .update(duplicateCandidateCases)
          .set({ lifecycleState: 'DISMISSED', resolutionOutcome: 'DISMISSED_AS_NON_SUBJECT' })
          .where(eq(duplicateCandidateCases.candidateCaseId, continuation.caseRef.resourceId));
        const newestContinuation = yield* scoped((transaction) =>
          matchParty(transaction, {
            actionInvocationId: 'bc300000-0000-4000-8000-000000000015',
            candidate: weakCandidate,
            tenantId,
          }),
        );
        if (newestContinuation.caseRef === null) {
          return yield* Effect.die(new Error('Archived target did not open the next successor'));
        }
        const [newestSuccessor] = yield* admin
          .select()
          .from(duplicateCandidateCases)
          .where(eq(duplicateCandidateCases.candidateCaseId, newestContinuation.caseRef.resourceId));
        expect(newestSuccessor?.priorCandidateCaseId).toBe(continuation.caseRef.resourceId);
        yield* admin.update(parties).set({ archivedAt: null }).where(eq(parties.partyId, partyId));

        const identifier = normalizeOfficialIdentifier({
          identifierType: 'CZ_DIC',
          value: 'CZ27074358',
        });
        const add = (actionInvocationId: string) =>
          scoped((transaction) =>
            Effect.gen(function* acceptIdentifier() {
              yield* lockTenantIdentityWrites(transaction, tenantId);
              return yield* addOfficialIdentifierRecord(transaction, tenantId, partyId, identifier, {
                actionInvocationId,
                principalId,
                provenanceMethod: 'REGISTRY',
                provenanceSource: 'identity-concurrency-test',
                validFrom: candidate.validFrom,
              });
            }),
          );
        const first = yield* add('bc300000-0000-4000-8000-000000000003');
        const repeated = yield* add('bc300000-0000-4000-8000-000000000004');
        expect(repeated.officialIdentifierId).toBe(first.officialIdentifierId);
        const reusedIdentifier = normalizeOfficialIdentifier({
          identifierType: 'ICO',
          value: '26168685',
        });
        yield* scoped((transaction) =>
          Effect.gen(function* seedDeclaredIdentifier() {
            yield* lockTenantIdentityWrites(transaction, tenantId);
            return yield* addOfficialIdentifierRecord(transaction, tenantId, partyId, reusedIdentifier, {
              actionInvocationId: 'bc300000-0000-4000-8000-000000000005',
              principalId,
              provenanceMethod: 'REGISTRY',
              provenanceSource: 'identity-concurrency-test',
              validFrom: candidate.validFrom,
            });
          }),
        );
        const accepted = yield* Effect.forEach(
          ['bc300000-0000-4000-8000-000000000006', 'bc300000-0000-4000-8000-000000000007'],
          (actionInvocationId) =>
            scoped((transaction) =>
              Effect.gen(function* concurrentAcceptance() {
                yield* lockTenantIdentityWrites(transaction, tenantId);
                return yield* acceptMatchingOfficialIdentifierRecord(transaction, tenantId, partyId, reusedIdentifier, {
                  actionInvocationId,
                  principalId,
                  provenanceMethod: 'REGISTRY',
                  provenanceSource: 'identity-concurrency-test',
                  validFrom: candidate.validFrom,
                });
              }),
            ),
          { concurrency: 'unbounded' },
        );
        expect(
          accepted.map((result) =>
            Match.value(result).pipe(
              Match.tag('added', () => false),
              Match.tag('reused', () => true),
              Match.exhaustive,
            ),
          ),
        ).toEqual([true, true]);
        const upgraded = yield* admin
          .select()
          .from(partyOfficialIdentifiers)
          .where(eq(partyOfficialIdentifiers.tenantId, tenantId));
        expect(upgraded.filter((row) => row.normalizedValue === '26168685')).toHaveLength(1);
        const upgradedAssertion = upgraded.find((row) => row.normalizedValue === '26168685');
        expect(upgradedAssertion?.acceptedByActionInvocationId).toBe('bc300000-0000-4000-8000-000000000005');
        const sourceAssertion: PartyClientSourceAssertion = {
          kind: 'CLIENT_SOURCE_ASSERTION',
          observedSubject: 'ORGANIZATION',
          occurrenceId: 'revision-1',
          recordId: 'fixture-record-1',
          source: {
            issuer: 'internal-contract-fixture-one',
            namespace: 'customers',
            recordType: 'customer',
            routeRef: 'internal-contract-party-route',
          },
          sourceObservedAt: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
          statement: 'Internal contract fixture declares this organization',
          subjectKey: partySubjectKeyFromString('fixture-source-subject'),
        };
        const sourceCandidate = {
          ...candidate,
          businessName: 'Internal fixture organization',
          officialIdentifiers: [],
          subjectEvidence: [sourceAssertion],
        };
        const sourceScope = { authMethod: 'api_key' as const, principalId, tenantId };
        const sourceBindings = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
          { ...sourceScope, ...sourceAssertion.source },
          { ...sourceScope, ...sourceAssertion.source, issuer: 'another-issuer' },
        ]);
        const sourceConfig = ConfigProvider.fromUnknown({ ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: sourceBindings });
        const createSource = (invocation: string, input = sourceCandidate) =>
          scoped((transaction) =>
            createOrMatchParty(transaction, {
              actionInvocationId: invocation,
              candidate: input,
              principalId,
              sourceScope,
              tenantId,
            }),
          ).pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, sourceConfig),
            Effect.provideService(PartyClientSourcePrivacy, { checkImport: () => Effect.succeed('ALLOWED') }),
          );
        const sourceAttempts = yield* Effect.forEach(
          ['bc300000-0000-4000-8000-000000000020', 'bc300000-0000-4000-8000-000000000021'],
          (invocation) => createSource(invocation),
          { concurrency: 'unbounded' },
        );
        const sourceCreated = sourceAttempts.find((attempt) => attempt.replayed !== true);
        const sourceReplay = sourceAttempts.find((attempt) => attempt.replayed === true);
        expect(sourceCreated?.outcome).toBe('CREATED');
        expect(sourceReplay).toEqual({ ...sourceCreated, replayed: true });
        const conflict = yield* Effect.flip(
          createSource('bc300000-0000-4000-8000-000000000022', {
            ...sourceCandidate,
            businessName: 'Changed source content',
          }),
        );
        expect(conflict).toMatchObject({ reason: 'client_source_occurrence_conflict' });
        const unrelated = yield* createSource('bc300000-0000-4000-8000-000000000023', {
          ...sourceCandidate,
          businessName: 'Unrelated fixture organization',
          subjectEvidence: [{ ...sourceAssertion, source: { ...sourceAssertion.source, issuer: 'another-issuer' } }],
        });
        expect(unrelated.outcome).toBe('CREATED');
        expect(unrelated.decisionRef).not.toEqual(sourceCreated?.decisionRef);
        assert.isOk(sourceCreated?.outcome === 'CREATED');
        assert.isOk(unrelated.outcome === 'CREATED');
        const revision = yield* createSource('bc300000-0000-4000-8000-000000000024', {
          ...sourceCandidate,
          subjectEvidence: [{ ...sourceAssertion, occurrenceId: 'revision-2' }],
        });
        expect(revision).toMatchObject({ outcome: 'MATCHED_EXISTING', partyRef: sourceCreated.partyRef });
        const [stored] = yield* admin
          .select()
          .from(partyMatchDecisions)
          .where(eq(partyMatchDecisions.matchDecisionId, sourceCreated.decisionRef.resourceId));
        assert.isOk(stored);
        const { matchDecisionId: _existingDecisionId, ...contradictoryReceipt } = stored;
        yield* admin.insert(partyMatchDecisions).values({
          ...contradictoryReceipt,
          actionInvocationId: 'bc300000-0000-4000-8000-000000000025',
          partyId: unrelated.partyRef.resourceId,
        });
        const exactAmbiguity = yield* Effect.flip(createSource('bc300000-0000-4000-8000-000000000026'));
        expect(exactAmbiguity).toMatchObject({ reason: 'client_source_receipt_ambiguous' });
        const recordAmbiguity = yield* Effect.flip(
          createSource('bc300000-0000-4000-8000-000000000027', {
            ...sourceCandidate,
            subjectEvidence: [{ ...sourceAssertion, occurrenceId: 'revision-3' }],
          }),
        );
        expect(recordAmbiguity).toMatchObject({ reason: 'client_source_party_target_ambiguous' });
      }),
  );
});
