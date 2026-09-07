import {
  makeEffectTestCallback as nativeTestCallback,
  runEffectTestPromise,
  runEffectTestSync as runNativeSync,
} from '@app/core-runtime/testing/effect-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import {
  CoreSearchQueryRuntimeLive,
  loadDatabaseConnectionPair,
  ReadRuntime,
  resolveActionCommit,
  runAction,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';

import { and, eq } from 'drizzle-orm';
import {
  Effect,
  Exit,
  Layer,
  Exit as NativeExit,
  Scope as NativeScope,
  Redacted,
  Predicate,
} from 'effect';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after as afterNativeDatabase } from 'node:test';
import { Pool } from 'pg';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { PartyCandidateSchema } from '../../shared/domain/identity-contracts.ts';
import { committedCreateResult } from '../../shared/domain/matching-contracts.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { archivePartyAction } from '../../src/actions/archive-party.action.ts';
import { counterpartyCreateAction } from '../../src/actions/counterparty-create.action.ts';
import { counterpartyRoleAddAction } from '../../src/actions/counterparty-role-add.action.ts';
import { counterpartyRoleEndAction } from '../../src/actions/counterparty-role-end.action.ts';
import { createPartyRelationshipAction } from '../../src/actions/create-party-relationship.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { endPartyRelationshipAction } from '../../src/actions/end-party-relationship.action.ts';
import { resolveDuplicateCandidateCreateAction } from '../../src/actions/resolve-duplicate-candidate-create.action.ts';
import { unarchivePartyAction } from '../../src/actions/unarchive-party.action.ts';
import { updatePartyRelationshipAction } from '../../src/actions/update-party-relationship.action.ts';
import { counterpartyReadRead } from '../../src/api/counterparty-read.read.ts';
import { partyDetailRead } from '../../src/api/party-detail.read.ts';
import { partyMatchDecisionRead } from '../../src/api/party-match-decision.read.ts';
import {
  duplicateCandidateCases,
  parties,
  partyFactAssertions,
  partyIdentifierClaims,
  partyMatchDecisions,
  partyOfficialIdentifiers,
  partyRelations,
} from '../../src/db/schema.ts';
import {
  partiesRead,
  PartySearchProjectionGatewayLive,
} from '../../src/search/parties.provider.ts';

const nativeDatabaseScope = runNativeSync(NativeScope.make());
afterNativeDatabase(
  NativeScope.close(nativeDatabaseScope, NativeExit.void).pipe(nativeTestCallback),
);

type EncodedPartyCandidate = typeof PartyCandidateSchema.Encoded;
const candidate = (
  ico: string,
  extra: Partial<EncodedPartyCandidate> = {},
): EncodedPartyCandidate => ({
  partyType: 'ORGANIZATION',
  officialIdentifiers: [{ identifierType: 'ICO', value: ico, verification: 'VERIFIED' }],
  subjectEvidence: [
    {
      kind: 'ACTOR_ATTESTATION',
      basis: 'REVIEWED_DOCUMENT',
      evidenceRef: 'review/42',
      observedSubject: 'ORGANIZATION',
      subjectKey: 'subject',
      statement: 'Reviewed this concrete external organization',
    },
  ],
  evidenceRefs: ['review/42'],
  provenance: { method: 'DOCUMENT', source: 'live-acceptance' },
  validFrom: '2020-01-01T00:00:00.000Z',
  ...extra,
});
const transport = (idempotencyKey = randomUUID()) => ({
  correlationId: `live-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'party.registry',
});
const readPartyDetail = (partyRef: PartyRef, principal: TrustedPrincipalContext) =>
  ReadRuntime.pipe(
    Effect.flatMap((runtime) =>
      runtime.runRead({
        registration: partyDetailRead,
        input: { partyRef },
        principal,
        transport: { correlationId: randomUUID() },
      }),
    ),
  );
const endPool = (pool: Pool) => pool.end();
const promiseEffect = <Value>(operation: () => PromiseLike<Value>) => Effect.promise(operation);

void test('governed Party identity uses real PostgreSQL and SpiceDB for atomic claims, recovery and temporal authorization', () =>
  runEffectTestPromise(
    Effect.scoped(
      Effect.gen(function* governedIdentityTestEffect() {
        const connections = yield* loadDatabaseConnectionPair();
        const actionKeys = [
          createPartyAction,
          counterpartyCreateAction,
          counterpartyRoleAddAction,
          counterpartyRoleEndAction,
          resolveDuplicateCandidateCreateAction,
          createPartyRelationshipAction,
          updatePartyRelationshipAction,
          endPartyRelationshipAction,
          archivePartyAction,
          unarchivePartyAction,
        ].map(({ descriptor }) => descriptor.actionKey);
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            actionKeys,
            runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          }).pipe(Effect.orDie),
          (resource) => resource.close().pipe(Effect.orDie),
        );
        const other = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            actionKeys,
            runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          }).pipe(Effect.orDie),
          (resource) => resource.close().pipe(Effect.orDie),
        );
        const adminPool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: connections.admin.connectionString })),
          (pool) => promiseEffect(endPool.bind(undefined, pool)).pipe(Effect.orDie),
        );
        const admin = yield* makeTestDatabaseFromPool(adminPool, partyRelations).pipe(
          NativeScope.provide(nativeDatabaseScope),
        );
        const fixtureContext = yield* Layer.build(fixture.layer);
        const otherContext = yield* Layer.build(other.layer);
        const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof fixture.layer>>) =>
          effect.pipe(Effect.provideContext(fixtureContext));
        const create = (
          value: EncodedPartyCandidate,
          idempotencyKey = randomUUID(),
          principal: TrustedPrincipalContext = fixture.manager,
        ) =>
          runAction({
            registration: createPartyAction,
            payload: { candidate: value },
            principal,
            transport: transport(idempotencyKey),
          });
        const snapshot = Effect.fn('GovernedIdentityTest.snapshot')(function* snapshotEffect() {
          const [partyRows, assertions, claims, decisions, cases, core] = yield* Effect.all(
            [
              admin.select().from(parties).where(eq(parties.tenantId, fixture.tenantId)),
              admin
                .select()
                .from(partyFactAssertions)
                .where(eq(partyFactAssertions.tenantId, fixture.tenantId)),
              admin
                .select()
                .from(partyIdentifierClaims)
                .where(eq(partyIdentifierClaims.tenantId, fixture.tenantId)),
              admin
                .select()
                .from(partyMatchDecisions)
                .where(eq(partyMatchDecisions.tenantId, fixture.tenantId)),
              admin
                .select()
                .from(duplicateCandidateCases)
                .where(eq(duplicateCandidateCases.tenantId, fixture.tenantId)),
              fixture.evidence(),
            ],
            { concurrency: 6 },
          );
          return { partyRows, assertions, claims, decisions, cases, core };
        });
        // Independent Action invocations, one canonical owner and one success event/outbox pair.
        const exact = candidate('27074358');
        const concurrent = yield* Effect.all([run(create(exact)), run(create(exact))], {
          concurrency: 2,
        });
        assert.deepEqual(concurrent.map((result) => result.outcome).toSorted(), [
          'CREATED',
          'MATCHED_EXISTING',
        ]);
        const created = concurrent.find((result) => result.outcome === 'CREATED');
        assert.ok(created && created.outcome === 'CREATED');
        const { partyRef } = created;
        let state = yield* snapshot();
        assert.equal(state.partyRows.length, 1);
        assert.equal(state.claims.length, 1);
        assert.equal(state.decisions.length, 2);
        assert.equal(state.assertions.length, 1);
        assert.equal(state.core.events.length, 1);
        assert.equal(state.core.outbox.length, 1);
        assert.equal(state.core.audits.length, 2);
        assert.ok(state.core.invocations.every((invocation) => invocation.status === 'succeeded'));
        assert.ok(state.assertions[0]?.evidenceEvaluation?.subjectEligible);
        const attachment = yield* run(
          create(
            candidate('27074358', {
              officialIdentifiers: [
                ...exact.officialIdentifiers,
                { identifierType: 'CZ_DIC', value: 'CZ27074358', verification: 'VERIFIED' },
              ],
            }),
          ),
        );
        assert.equal(attachment.outcome, 'MATCHED_EXISTING');
        state = yield* snapshot();
        assert.equal(state.partyRows.length, 1);
        assert.equal(state.claims.length, 2);
        assert.equal(state.core.events.length, 2);
        assert.equal(state.core.outbox.length, 2);

        const second = yield* run(create(candidate('26168685')));
        assert.equal(second.outcome, 'CREATED');
        const split = candidate('26168685', {
          officialIdentifiers: [
            { identifierType: 'ICO', value: '26168685', verification: 'VERIFIED' },
            { identifierType: 'CZ_DIC', value: 'CZ27074358', verification: 'VERIFIED' },
          ],
        });
        const ambiguity = yield* run(create(split));
        const repeated = yield* run(create(split));
        assert.ok(ambiguity.outcome === 'AMBIGUOUS' && repeated.outcome === 'AMBIGUOUS');
        assert.deepEqual(repeated.caseRef, ambiguity.caseRef);
        state = yield* snapshot();
        assert.equal(state.partyRows.length, 2);
        assert.equal(state.cases.length, 1);
        assert.equal(
          state.decisions.filter((decision) => decision.committedCreateOutcome === 'AMBIGUOUS')
            .length,
          2,
        );

        // Every Create outcome survives actual lost commit acknowledgement, followed by a new governed Read.
        const recoveryCandidates = [candidate('45274649'), exact, split];
        yield* Effect.forEach(
          recoveryCandidates,
          Effect.fn('GovernedIdentityTest.verifyCommitRecovery')(
            function* verifyCommitRecoveryEffect(value) {
              const key = randomUUID();
              fixture.faultNextTransaction('lost-ack');
              assert.ok(
                Predicate.isTagged(
                  yield* run(create(value, key).pipe(Effect.flip)),
                  'ActionCommitIndeterminate',
                ),
              );
              const before = yield* snapshot();
              const invocation = before.core.invocations.find((row) => row.idempotencyKey === key);
              assert.ok(invocation);
              assert.ok(
                Predicate.isTagged(
                  yield* run(
                    resolveActionCommit({
                      invocationId: invocation.actionInvocationId,
                      principal: fixture.manager,
                    }).pipe(Effect.flip),
                  ),
                  'ActionAlreadyCommitted',
                ),
              );
              const recovered = yield* run(
                ReadRuntime.pipe(
                  Effect.flatMap((runtime) =>
                    runtime.runRead({
                      registration: partyMatchDecisionRead,
                      input: { actionInvocationId: invocation.actionInvocationId },
                      principal: fixture.manager,
                      transport: { correlationId: randomUUID() },
                    }),
                  ),
                ),
              );
              const original = before.decisions.find(
                (row) => row.actionInvocationId === invocation.actionInvocationId,
              );
              assert.ok(original);
              const recoveredResult = committedCreateResult(recovered);
              assert.ok(recoveredResult);
              assert.equal(recoveredResult.outcome, original.committedCreateOutcome);
              assert.equal(recoveredResult.decisionRef.resourceId, original.matchDecisionId);
              assert.equal(recovered.partyRef?.resourceId ?? null, original.partyId);
              assert.equal(recovered.caseRef?.resourceId ?? null, original.candidateCaseId);
              assert.ok(
                Predicate.isTagged(
                  yield* run(create(value, key).pipe(Effect.flip)),
                  'ActionAlreadyCommitted',
                ),
              );
              const after = yield* snapshot();
              assert.deepEqual(after.partyRows, before.partyRows);
              assert.deepEqual(after.decisions, before.decisions);
              assert.deepEqual(after.core.events, before.core.events);
              assert.deepEqual(after.core.outbox, before.core.outbox);
              assert.ok(
                Predicate.isTagged(
                  yield* run(readPartyDetail(partyRef, fixture.denied).pipe(Effect.flip)),
                  'ReadPermissionDenied',
                ),
              );
            },
          ),
          { concurrency: 1, discard: true },
        );
        const beforeDenied = yield* snapshot();
        assert.ok(
          Predicate.isTagged(
            yield* run(create(candidate('00006947', { subjectEvidence: [] })).pipe(Effect.flip)),
            'PartyEvidenceInsufficient',
          ),
        );
        const afterDenied = yield* snapshot();
        assert.deepEqual(afterDenied.partyRows, beforeDenied.partyRows);
        assert.deepEqual(afterDenied.decisions, beforeDenied.decisions);
        assert.deepEqual(afterDenied.cases, beforeDenied.cases);
        fixture.faultNextTransaction('rollback');
        yield* run(create(candidate('00006947')).pipe(Effect.flip));
        const rolledBack = yield* snapshot();
        assert.deepEqual(rolledBack.partyRows, beforeDenied.partyRows);
        assert.deepEqual(rolledBack.assertions, beforeDenied.assertions);
        assert.deepEqual(rolledBack.claims, beforeDenied.claims);
        assert.deepEqual(rolledBack.cases, beforeDenied.cases);
        assert.deepEqual(rolledBack.core.audits, beforeDenied.core.audits);
        assert.deepEqual(rolledBack.decisions, beforeDenied.decisions);
        assert.deepEqual(rolledBack.core.events, beforeDenied.core.events);
        assert.deepEqual(rolledBack.core.outbox, beforeDenied.core.outbox);

        const independent = yield* create(exact, randomUUID(), other.manager).pipe(
          Effect.provideContext(otherContext),
        );
        assert.ok(independent.outcome === 'CREATED');
        assert.notEqual(independent.partyRef.resourceId, partyRef.resourceId);
        assert.ok(
          Predicate.isTagged(
            yield* run(readPartyDetail(independent.partyRef, fixture.manager).pipe(Effect.flip)),
            'ReadHandlerNotFound',
          ),
        );
        assert.ok(
          Predicate.isTagged(
            yield* run(
              create(candidate('00006947'), randomUUID(), fixture.legalEntityOnly).pipe(
                Effect.flip,
              ),
            ),
            'ActionPermissionDenied',
          ),
        );
        assert.ok(
          Predicate.isTagged(
            yield* run(readPartyDetail(partyRef, fixture.legalEntityOnly).pipe(Effect.flip)),
            'ReadPermissionDenied',
          ),
        );
        const searchLayer = PartySearchProjectionGatewayLive.pipe(
          Layer.provide(CoreSearchQueryRuntimeLive),
        );
        const searchContext = yield* Layer.build(searchLayer).pipe(
          Effect.provideContext(fixtureContext),
        );
        const deniedSearch = ReadRuntime.pipe(
          Effect.flatMap((runtime) =>
            runtime.runRead({
              registration: partiesRead,
              input: { query: 'Live' },
              principal: fixture.legalEntityOnly,
              transport: { correlationId: randomUUID() },
            }),
          ),
          Effect.provideContext(searchContext),
        );
        assert.ok(
          Predicate.isTagged(yield* run(deniedSearch.pipe(Effect.flip)), 'ReadPermissionDenied'),
        );
        assert.ok(
          Predicate.isTagged(
            yield* run(
              ReadRuntime.pipe(
                Effect.flatMap((runtime) =>
                  runtime.runRead({
                    registration: partyMatchDecisionRead,
                    input: { decisionRef: independent.decisionRef },
                    principal: fixture.manager,
                    transport: { correlationId: randomUUID() },
                  }),
                ),
                Effect.flip,
              ),
            ),
            'ReadHandlerNotFound',
          ),
        );

        const provenance = {
          evidenceReference: 'review/42',
          method: 'SIGNED_CONTRACT',
          source: 'live-acceptance',
          reason: 'Business relationship',
        };
        const counterparty = () =>
          runAction({
            registration: counterpartyCreateAction,
            payload: { partyRef, provenance },
            principal: fixture.legalEntityOnly,
            transport: transport(),
          });
        const counterparties = yield* Effect.all([run(counterparty()), run(counterparty())], {
          concurrency: 2,
        });
        assert.deepEqual(counterparties.map((item) => item.created).toSorted(), [false, true]);
        assert.deepEqual(counterparties[0]?.counterpartyRef, counterparties[1]?.counterpartyRef);
        const counterpartyRef = counterparties[0]?.counterpartyRef;
        assert.ok(counterpartyRef);
        const readCounterparty = () =>
          run(
            ReadRuntime.pipe(
              Effect.flatMap((runtime) =>
                runtime.runRead({
                  registration: counterpartyReadRead,
                  input: { counterpartyRef },
                  principal: fixture.legalEntityOnly,
                  transport: { correlationId: randomUUID() },
                }),
              ),
            ),
          );
        // Owning a business Counterparty does not itself grant resource permission.
        const forbiddenCounterpartyRead = yield* Effect.exit(readCounterparty());
        assert.ok(Exit.isFailure(forbiddenCounterpartyRead));
        yield* fixture.grantResourceAccess(counterpartyRef, fixture.legalEntityOnly.principalId);
        const projection = yield* readCounterparty();
        assert.deepEqual(Object.keys(projection.party).toSorted(), [
          'archived',
          'canonicalPartyRef',
          'displayName',
          'partyType',
          'storedPartyRef',
        ]);
        yield* run(
          runAction({
            registration: counterpartyCreateAction,
            payload: { partyRef, provenance },
            principal: fixture.manager,
            transport: transport(),
          }).pipe(Effect.flip),
        );
        yield* fixture.grantResourceAccess(
          counterpartyRef,
          fixture.legalEntityOnly.principalId,
          'writer',
        );
        const role = (roleType: 'CUSTOMER' | 'SUPPLIER') =>
          run(
            runAction({
              registration: counterpartyRoleAddAction,
              payload: {
                counterpartyRef,
                roleType,
                provenance,
                validFrom: '2020-01-01T00:00:00.000Z',
              },
              principal: fixture.legalEntityOnly,
              transport: transport(),
            }),
          );
        const customer = yield* role('CUSTOMER');
        yield* role('SUPPLIER');
        yield* run(
          runAction({
            registration: counterpartyRoleEndAction,
            payload: {
              counterpartyRef,
              rolePeriodRef: customer.rolePeriodRef,
              provenance: { ...provenance, method: 'SIGNED_TERMINATION_AGREEMENT' },
              validTo: '2021-01-01T00:00:00.000Z',
            },
            principal: fixture.legalEntityOnly,
            transport: transport(),
          }),
        );
        const counterpartyAfterRoleEnd = yield* readCounterparty();
        assert.deepEqual(
          counterpartyAfterRoleEnd.currentRoles.map((item) => item.roleType),
          ['SUPPLIER'],
        );

        const person = yield* run(
          create(
            candidate('00006947', {
              partyType: 'PERSON',
              officialIdentifiers: [],
              displayName: 'Live contact',
              subjectEvidence: [
                {
                  kind: 'ACTOR_ATTESTATION',
                  basis: 'DIRECT_INTERACTION',
                  evidenceRef: 'meeting/42',
                  subjectKey: 'person',
                  observedSubject: 'PERSON',
                  statement: 'Met this concrete external person',
                },
              ],
            }),
          ),
        );
        assert.ok(person.outcome === 'AMBIGUOUS');
        const reviewedPerson = yield* run(
          runAction({
            registration: resolveDuplicateCandidateCreateAction,
            payload: {
              caseRef: person.caseRef,
              expectedRevision: 1,
              reason: 'Reviewed concrete external person',
            },
            principal: fixture.manager,
            transport: transport(),
          }),
        );
        assert.ok(reviewedPerson.partyRef);
        const relationship = yield* run(
          runAction({
            registration: createPartyRelationshipAction,
            payload: {
              fromPartyRef: reviewedPerson.partyRef,
              toPartyRef: partyRef,
              relationshipType: 'CONTACT_PERSON_OF',
              validFrom: '2090-01-01T00:00:00.000Z',
              validTo: null,
              provenance: { method: 'DIRECT_INTERACTION', source: 'live' },
            },
            principal: fixture.manager,
            transport: transport(),
          }),
        );
        // Domain relationships never provision access to Party records.
        assert.ok(
          Predicate.isTagged(
            yield* run(
              readPartyDetail(reviewedPerson.partyRef, fixture.legalEntityOnly).pipe(Effect.flip),
            ),
            'ReadPermissionDenied',
          ),
        );
        assert.ok(
          Predicate.isTagged(
            yield* run(readPartyDetail(partyRef, fixture.legalEntityOnly).pipe(Effect.flip)),
            'ReadPermissionDenied',
          ),
        );
        const updatedRelationship = yield* run(
          runAction({
            registration: updatePartyRelationshipAction,
            payload: {
              relationshipRef: relationship.relationship.relationshipRef,
              expectedRevision: relationship.relationship.revision,
              changeReason: 'Change planned start',
              validFrom: '2089-01-01T00:00:00.000Z',
              provenance: { method: 'DOCUMENT', source: 'live' },
            },
            principal: fixture.manager,
            transport: transport(),
          }),
        );
        assert.equal(updatedRelationship.outcome, 'CHANGED');
        const endedRelationship = yield* run(
          runAction({
            registration: endPartyRelationshipAction,
            payload: {
              relationshipRef: relationship.relationship.relationshipRef,
              expectedRevision: updatedRelationship.relationship.revision,
              effectiveAt: '2091-01-01T00:00:00.000Z',
              reason: 'Contact ended',
              provenance: { method: 'DOCUMENT', source: 'live' },
            },
            principal: fixture.manager,
            transport: transport(),
          }),
        );
        assert.equal(endedRelationship.outcome, 'CHANGED');

        // Seed a legacy unclaimed identifier assertion only in owner storage, then exercise
        // the public unarchive Action against another Party's real current exact claim.
        const legacy = yield* run(create(candidate('00006947')));
        assert.ok(legacy.outcome === 'CREATED');
        const legacyArchived = yield* run(
          runAction({
            registration: archivePartyAction,
            payload: {
              partyRef: legacy.partyRef,
              expectedRevision: 1,
              reason: 'Historical collision fixture',
            },
            principal: fixture.manager,
            transport: transport(),
          }),
        );
        const [identifierTemplate] = yield* admin
          .select()
          .from(partyOfficialIdentifiers)
          .where(
            and(
              eq(partyOfficialIdentifiers.tenantId, fixture.tenantId),
              eq(partyOfficialIdentifiers.partyId, partyRef.resourceId),
            ),
          )
          .limit(1);
        assert.ok(identifierTemplate);
        yield* admin.insert(partyOfficialIdentifiers).values({
          ...identifierTemplate,
          officialIdentifierId: randomUUID(),
          partyId: legacy.partyRef.resourceId,
        });
        const collision = yield* run(
          runAction({
            registration: unarchivePartyAction,
            payload: {
              partyRef: legacy.partyRef,
              expectedRevision: legacyArchived.revision,
              reason: 'Recheck historical claims',
            },
            principal: fixture.manager,
            transport: transport(),
          }),
        );
        assert.ok(
          collision.outcome === 'BLOCKED' && collision.reasonCode === 'EXACT_CLAIM_CONFLICT',
        );

        const current = yield* run(readPartyDetail(partyRef, fixture.manager));
        const archived = yield* run(
          runAction({
            registration: archivePartyAction,
            payload: {
              partyRef,
              expectedRevision: current.party.revision,
              reason: 'Archive acceptance',
            },
            principal: fixture.manager,
            transport: transport(),
          }),
        );
        const archivedParty = yield* run(readPartyDetail(partyRef, fixture.manager));
        assert.ok(archivedParty.party.archivedAt);
        const archivedCounterparty = yield* readCounterparty();
        assert.equal(archivedCounterparty.party.archived, true);
        yield* run(counterparty().pipe(Effect.flip));
        const unarchive = yield* run(
          runAction({
            registration: unarchivePartyAction,
            payload: {
              partyRef,
              expectedRevision: archived.revision,
              reason: 'Unarchive acceptance',
            },
            principal: fixture.manager,
            transport: transport(),
          }),
        );
        assert.equal(unarchive.outcome, 'BLOCKED');
        assert.ok(
          unarchive.outcome === 'BLOCKED' && unarchive.reasonCode === 'OPEN_DUPLICATE_CASE',
        );
      }),
    ),
  ));
