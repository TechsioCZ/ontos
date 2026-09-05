// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off globalDate:off missedPipeableOpportunity:off strictEffectProvide:off
/* eslint-disable no-await-in-loop, react-hooks/rules-of-hooks, unicorn/consistent-function-scoping, unicorn/no-await-expression-member -- Sequential live assertions use Effect service accessors and fixture-bound helpers, not React hooks. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ActionRuntime, TrustedPrincipalContext } from '@app/core-runtime';
import {
  CoreSearchQueryRuntimeLive,
  ReadRuntime,
  loadDatabaseConnectionPair,
  runAction,
  resolveActionCommit,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { Effect, Layer } from 'effect';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { archivePartyAction } from '../../src/actions/archive-party.action.ts';
import { unarchivePartyAction } from '../../src/actions/unarchive-party.action.ts';
import { counterpartyCreateAction } from '../../src/actions/counterparty-create.action.ts';
import { counterpartyRoleAddAction } from '../../src/actions/counterparty-role-add.action.ts';
import { counterpartyRoleEndAction } from '../../src/actions/counterparty-role-end.action.ts';
import { createPartyRelationshipAction } from '../../src/actions/create-party-relationship.action.ts';
import { updatePartyRelationshipAction } from '../../src/actions/update-party-relationship.action.ts';
import { endPartyRelationshipAction } from '../../src/actions/end-party-relationship.action.ts';
import {
  partiesRead,
  PartySearchProjectionGatewayLive,
} from '../../src/search/parties.provider.ts';
import { partyDetailRead } from '../../src/api/party-detail.read.ts';
import { partyMatchDecisionRead } from '../../src/api/party-match-decision.read.ts';
import { counterpartyReadRead } from '../../src/api/counterparty-read.read.ts';
import { committedCreateResult } from '../../shared/domain/matching-contracts.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { resolveDuplicateCandidateCreateAction } from '../../src/actions/resolve-duplicate-candidate-create.action.ts';
import type { PartyCandidate } from '../../shared/domain/identity-contracts.ts';
import {
  partyDatabaseSchema,
  parties,
  partyFactAssertions,
  partyIdentifierClaims,
  partyMatchDecisions,
  duplicateCandidateCases,
  partyOfficialIdentifiers,
} from '../../src/db/schema.ts';

const candidate = (ico: string, extra: Partial<PartyCandidate> = {}): PartyCandidate => ({
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
const tag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onSuccess: () => 'SUCCESS',
      onFailure: (error) => error._tag,
    }),
  );

test('governed Party identity uses real PostgreSQL and SpiceDB for atomic claims, recovery and temporal authorization', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const fixture = await makeLiveOperationFixture({
    runtimeConnectionString: connections.runtime.connectionString,
  });
  const other = await makeLiveOperationFixture({
    runtimeConnectionString: connections.runtime.connectionString,
  });
  const adminPool = new Pool({ connectionString: connections.admin.connectionString });
  const admin = drizzle({ client: adminPool, schema: partyDatabaseSchema });
  const run = <A, E>(effect: Effect.Effect<A, E, ActionRuntime | ReadRuntime>) =>
    Effect.runPromise(effect.pipe(Effect.provide(fixture.layer)));
  const create = (
    value: PartyCandidate,
    idempotencyKey = randomUUID(),
    principal: TrustedPrincipalContext = fixture.manager,
  ) =>
    runAction({
      registration: createPartyAction,
      payload: { candidate: value },
      principal,
      transport: transport(idempotencyKey),
    });
  const detail = (partyRef: PartyRef, principal: TrustedPrincipalContext = fixture.manager) =>
    ReadRuntime.use((runtime) =>
      runtime.runRead({
        registration: partyDetailRead,
        input: { partyRef },
        principal,
        transport: { correlationId: randomUUID() },
      }),
    );
  const snapshot = async () => {
    const [partyRows, assertions, claims, decisions, cases, core] = await Promise.all([
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
    ]);
    return { partyRows, assertions, claims, decisions, cases, core };
  };
  try {
    // Independent Action invocations, one canonical owner and one success event/outbox pair.
    const exact = candidate('27074358');
    const concurrent = await Promise.all([run(create(exact)), run(create(exact))]);
    assert.deepEqual(concurrent.map((result) => result.outcome).toSorted(), [
      'CREATED',
      'MATCHED_EXISTING',
    ]);
    const created = concurrent.find((result) => result.outcome === 'CREATED');
    assert.ok(created && created.outcome === 'CREATED');
    const { partyRef } = created;
    let state = await snapshot();
    assert.equal(state.partyRows.length, 1);
    assert.equal(state.claims.length, 1);
    assert.equal(state.decisions.length, 2);
    assert.equal(state.assertions.length, 1);
    assert.equal(state.core.events.length, 1);
    assert.equal(state.core.outbox.length, 1);
    assert.equal(state.core.audits.length, 2);
    assert.ok(state.core.invocations.every((invocation) => invocation.status === 'succeeded'));
    assert.ok(state.assertions[0]?.evidenceEvaluation?.subjectEligible);
    const attachment = await run(
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
    state = await snapshot();
    assert.equal(state.partyRows.length, 1);
    assert.equal(state.claims.length, 2);
    assert.equal(state.core.events.length, 2);
    assert.equal(state.core.outbox.length, 2);

    const second = await run(create(candidate('26168685')));
    assert.equal(second.outcome, 'CREATED');
    const split = candidate('26168685', {
      officialIdentifiers: [
        { identifierType: 'ICO', value: '26168685', verification: 'VERIFIED' },
        { identifierType: 'CZ_DIC', value: 'CZ27074358', verification: 'VERIFIED' },
      ],
    });
    const ambiguity = await run(create(split));
    const repeated = await run(create(split));
    assert.ok(ambiguity.outcome === 'AMBIGUOUS' && repeated.outcome === 'AMBIGUOUS');
    assert.deepEqual(repeated.caseRef, ambiguity.caseRef);
    state = await snapshot();
    assert.equal(state.partyRows.length, 2);
    assert.equal(state.cases.length, 1);
    assert.equal(
      state.decisions.filter((decision) => decision.committedCreateOutcome === 'AMBIGUOUS').length,
      2,
    );

    // Every Create outcome survives actual lost commit acknowledgement, followed by a new governed Read.
    for (const value of [candidate('45274649'), exact, split]) {
      const key = randomUUID();
      fixture.faultNextTransaction('lost-ack');
      assert.equal(await run(tag(create(value, key))), 'ActionCommitIndeterminate');
      const before = await snapshot();
      const invocation = before.core.invocations.find((row) => row.idempotencyKey === key);
      assert.ok(invocation);
      assert.equal(
        await run(
          tag(
            resolveActionCommit({
              invocationId: invocation.actionInvocationId,
              principal: fixture.manager,
            }),
          ),
        ),
        'ActionAlreadyCommitted',
      );
      const recovered = await run(
        ReadRuntime.use((runtime) =>
          runtime.runRead({
            registration: partyMatchDecisionRead,
            input: { actionInvocationId: invocation.actionInvocationId },
            principal: fixture.manager,
            transport: { correlationId: randomUUID() },
          }),
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
      assert.equal(await run(tag(create(value, key))), 'ActionAlreadyCommitted');
      const after = await snapshot();
      assert.deepEqual(after.partyRows, before.partyRows);
      assert.deepEqual(after.decisions, before.decisions);
      assert.deepEqual(after.core.events, before.core.events);
      assert.deepEqual(after.core.outbox, before.core.outbox);
      assert.equal(await run(tag(detail(partyRef, fixture.denied))), 'ReadPermissionDenied');
    }
    const beforeDenied = await snapshot();
    assert.equal(
      await run(tag(create(candidate('00006947', { subjectEvidence: [] })))),
      'PartyEvidenceInsufficient',
    );
    const afterDenied = await snapshot();
    assert.deepEqual(afterDenied.partyRows, beforeDenied.partyRows);
    assert.deepEqual(afterDenied.decisions, beforeDenied.decisions);
    assert.deepEqual(afterDenied.cases, beforeDenied.cases);
    fixture.faultNextTransaction('rollback');
    assert.notEqual(await run(tag(create(candidate('00006947')))), 'SUCCESS');
    const rolledBack = await snapshot();
    assert.deepEqual(rolledBack.partyRows, beforeDenied.partyRows);
    assert.deepEqual(rolledBack.assertions, beforeDenied.assertions);
    assert.deepEqual(rolledBack.claims, beforeDenied.claims);
    assert.deepEqual(rolledBack.cases, beforeDenied.cases);
    assert.deepEqual(rolledBack.core.audits, beforeDenied.core.audits);
    assert.deepEqual(rolledBack.decisions, beforeDenied.decisions);
    assert.deepEqual(rolledBack.core.events, beforeDenied.core.events);
    assert.deepEqual(rolledBack.core.outbox, beforeDenied.core.outbox);

    const independent = await Effect.runPromise(
      create(exact, randomUUID(), other.manager).pipe(Effect.provide(other.layer)),
    );
    assert.ok(independent.outcome === 'CREATED');
    assert.notEqual(independent.partyRef.resourceId, partyRef.resourceId);
    assert.equal(await run(tag(detail(independent.partyRef))), 'ReadHandlerNotFound');
    assert.equal(
      await run(tag(create(candidate('00006947'), randomUUID(), fixture.legalEntityOnly))),
      'ActionPermissionDenied',
    );
    assert.equal(await run(tag(detail(partyRef, fixture.legalEntityOnly))), 'ReadPermissionDenied');
    const searchLayer = PartySearchProjectionGatewayLive.pipe(
      Layer.provide(CoreSearchQueryRuntimeLive),
    );
    const deniedSearch = ReadRuntime.use((runtime) =>
      runtime.runRead({
        registration: partiesRead,
        input: { query: 'Live' },
        principal: fixture.legalEntityOnly,
        transport: { correlationId: randomUUID() },
      }),
    ).pipe(Effect.provide(searchLayer));
    assert.equal(await run(tag(deniedSearch)), 'ReadPermissionDenied');
    assert.equal(
      await run(
        tag(
          ReadRuntime.use((runtime) =>
            runtime.runRead({
              registration: partyMatchDecisionRead,
              input: { decisionRef: independent.decisionRef },
              principal: fixture.manager,
              transport: { correlationId: randomUUID() },
            }),
          ),
        ),
      ),
      'ReadHandlerNotFound',
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
    const counterparties = await Promise.all([run(counterparty()), run(counterparty())]);
    assert.deepEqual(counterparties.map((item) => item.created).toSorted(), [false, true]);
    assert.deepEqual(counterparties[0]?.counterpartyRef, counterparties[1]?.counterpartyRef);
    const counterpartyRef = counterparties[0]?.counterpartyRef;
    assert.ok(counterpartyRef);
    const readCounterparty = () =>
      run(
        ReadRuntime.use((runtime) =>
          runtime.runRead({
            registration: counterpartyReadRead,
            input: { counterpartyRef },
            principal: fixture.legalEntityOnly,
            transport: { correlationId: randomUUID() },
          }),
        ),
      );
    // Owning a business Counterparty does not itself grant resource permission.
    await assert.rejects(readCounterparty());
    await fixture.grantResourceAccess(counterpartyRef, fixture.legalEntityOnly.principalId);
    const projection = await readCounterparty();
    assert.deepEqual(Object.keys(projection.party).toSorted(), [
      'archived',
      'canonicalPartyRef',
      'displayName',
      'partyType',
      'storedPartyRef',
    ]);
    assert.notEqual(
      await run(
        tag(
          runAction({
            registration: counterpartyCreateAction,
            payload: { partyRef, provenance },
            principal: fixture.manager,
            transport: transport(),
          }),
        ),
      ),
      'SUCCESS',
    );
    await fixture.grantResourceAccess(
      counterpartyRef,
      fixture.legalEntityOnly.principalId,
      'writer',
    );
    const role = (roleType: 'CUSTOMER' | 'SUPPLIER') =>
      run(
        runAction({
          registration: counterpartyRoleAddAction,
          payload: { counterpartyRef, roleType, provenance, validFrom: '2020-01-01T00:00:00.000Z' },
          principal: fixture.legalEntityOnly,
          transport: transport(),
        }),
      );
    const customer = await role('CUSTOMER');
    await role('SUPPLIER');
    await run(
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
    assert.deepEqual(
      (await readCounterparty()).currentRoles.map((item) => item.roleType),
      ['SUPPLIER'],
    );

    const person = await run(
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
    const reviewedPerson = await run(
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
    const relationship = await run(
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
    assert.equal(
      await run(tag(detail(reviewedPerson.partyRef, fixture.legalEntityOnly))),
      'ReadPermissionDenied',
    );
    assert.equal(await run(tag(detail(partyRef, fixture.legalEntityOnly))), 'ReadPermissionDenied');
    const updatedRelationship = await run(
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
    const endedRelationship = await run(
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
    const legacy = await run(create(candidate('00006947')));
    assert.ok(legacy.outcome === 'CREATED');
    const legacyArchived = await run(
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
    const [identifierTemplate] = await admin
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
    await admin.insert(partyOfficialIdentifiers).values({
      ...identifierTemplate,
      officialIdentifierId: randomUUID(),
      partyId: legacy.partyRef.resourceId,
    });
    const collision = await run(
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
    assert.ok(collision.outcome === 'BLOCKED' && collision.reasonCode === 'EXACT_CLAIM_CONFLICT');

    const current = await run(detail(partyRef));
    const archived = await run(
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
    assert.ok((await run(detail(partyRef))).party.archivedAt);
    assert.equal((await readCounterparty()).party.archived, true);
    assert.notEqual(await run(tag(counterparty())), 'SUCCESS');
    const unarchive = await run(
      runAction({
        registration: unarchivePartyAction,
        payload: { partyRef, expectedRevision: archived.revision, reason: 'Unarchive acceptance' },
        principal: fixture.manager,
        transport: transport(),
      }),
    );
    assert.equal(unarchive.outcome, 'BLOCKED');
    assert.ok(unarchive.outcome === 'BLOCKED' && unarchive.reasonCode === 'OPEN_DUPLICATE_CASE');
  } finally {
    await adminPool.end();
    await fixture.close();
    await other.close();
  }
});
