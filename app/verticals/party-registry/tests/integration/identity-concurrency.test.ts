// @effect-diagnostics asyncFunction:off globalDate:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Pool } from 'pg';
import { normalizeOfficialIdentifier } from '../../shared/domain/identifier-contracts.ts';
import {
  duplicateCandidateCaseParties,
  duplicateCandidateCases,
  parties,
  partyDatabaseSchema,
  partyFactAssertions,
  partyIdentifierClaims,
  partyMatchDecisions,
  partyOfficialIdentifiers,
} from '../../src/db/schema.ts';
import type { PartyTransaction } from '../../src/db/types.ts';
import { createOrMatchParty } from '../../src/services/party-matching-persistence.service.ts';
import { addOfficialIdentifierRecord } from '../../src/services/party-official-identifier-persistence.service.ts';
import {
  lockTenantIdentityWrites,
  lockAndResolveClaims,
} from '../../src/services/party-identifier-claim.service.ts';

const tenantId = 'bc100000-0000-4000-8000-000000000001';
const principalId = 'bc200000-0000-4000-8000-000000000001';

test('real PostgreSQL identity locks serialize concurrent exact creates and repeated identifier acceptance', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const adminPool = new Pool({ connectionString: connections.admin.connectionString });
  const runtimePool = new Pool({ connectionString: connections.runtime.connectionString, max: 2 });
  const admin = drizzle({ client: adminPool, schema: partyDatabaseSchema });
  const runtime = drizzle({ client: runtimePool, schema: partyDatabaseSchema });
  const cleanup = async () => {
    await admin.delete(partyMatchDecisions).where(eq(partyMatchDecisions.tenantId, tenantId));
    await admin
      .delete(duplicateCandidateCaseParties)
      .where(eq(duplicateCandidateCaseParties.tenantId, tenantId));
    await admin
      .delete(duplicateCandidateCases)
      .where(eq(duplicateCandidateCases.tenantId, tenantId));
    await admin.delete(partyIdentifierClaims).where(eq(partyIdentifierClaims.tenantId, tenantId));
    await admin
      .delete(partyOfficialIdentifiers)
      .where(eq(partyOfficialIdentifiers.tenantId, tenantId));
    await admin.delete(partyFactAssertions).where(eq(partyFactAssertions.tenantId, tenantId));
    await admin.delete(parties).where(eq(parties.tenantId, tenantId));
  };
  const scoped = <Value>(operation: (transaction: PartyTransaction) => Promise<Value>) =>
    runtime.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`);
      return operation(transaction);
    });
  try {
    await cleanup();
    const candidate = {
      evidenceRefs: ['evidence-artifact:identity-concurrency:registry'],
      officialIdentifiers: [
        { identifierType: 'ICO' as const, value: '27074358', verification: 'VERIFIED' as const },
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
          subjectKey: 'one-subject',
        },
      ],
      validFrom: '2020-01-01T00:00:00.000Z',
    };
    const results = await Promise.all(
      ['bc300000-0000-4000-8000-000000000001', 'bc300000-0000-4000-8000-000000000002'].map(
        (actionInvocationId) =>
          scoped((transaction) =>
            Effect.runPromise(
              createOrMatchParty(transaction, {
                actionInvocationId,
                candidate,
                principalId,
                tenantId,
              }),
            ),
          ),
      ),
    );
    assert.deepEqual(results.map((result) => result.outcome).toSorted(), [
      'CREATED',
      'MATCHED_EXISTING',
    ]);
    const created = results.find((result) => result.outcome === 'CREATED');
    assert.ok(created && created.outcome === 'CREATED');
    const partyId = created.partyRef.resourceId;
    const canonical = await admin.select().from(parties).where(eq(parties.tenantId, tenantId));
    assert.equal(canonical.length, 1);
    assert.equal(canonical[0]?.currentDisplayName, null);
    const nameAssertions = await admin
      .select()
      .from(partyFactAssertions)
      .where(eq(partyFactAssertions.tenantId, tenantId));
    assert.equal(
      nameAssertions.some((row) => row.factKind === 'DISPLAY_NAME'),
      false,
    );
    const identifier = normalizeOfficialIdentifier({
      identifierType: 'CZ_DIC',
      value: 'CZ27074358',
      verification: 'VERIFIED',
    });
    const add = (actionInvocationId: string) =>
      scoped((transaction) =>
        Effect.runPromise(
          Effect.gen(function* acceptIdentifier() {
            yield* lockTenantIdentityWrites(transaction, tenantId);
            yield* lockAndResolveClaims(transaction, tenantId, [identifier]);
            return yield* addOfficialIdentifierRecord(transaction, tenantId, partyId, identifier, {
              actionInvocationId,
              matchRuleVersion: 'party-exact-claims.v1',
              partyType: 'ORGANIZATION',
              principalId,
              provenanceMethod: 'REGISTRY',
              provenanceSource: 'identity-concurrency-test',
              validFrom: candidate.validFrom,
            });
          }),
        ),
      );
    const first = await add('bc300000-0000-4000-8000-000000000003');
    const repeated = await add('bc300000-0000-4000-8000-000000000004');
    assert.equal(repeated.officialIdentifierId, first.officialIdentifierId);
    const claims = await admin
      .select()
      .from(partyIdentifierClaims)
      .where(eq(partyIdentifierClaims.tenantId, tenantId));
    assert.equal(claims.length, 2);
  } finally {
    try {
      await cleanup();
    } finally {
      await runtimePool.end();
      await adminPool.end();
    }
  }
});
