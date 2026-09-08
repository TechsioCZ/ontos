import {
  makeEffectTestCallback as nativeTestCallback,
  runEffectTestPromise,
  runEffectTestSync as runNativeSync,
} from '@app/core-runtime/testing/effect-runtime';

// @effect-diagnostics asyncFunction:off globalDate:off -- Existing compatibility boundary; expires: 2026-12-31.
import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Exit as NativeExit, Scope as NativeScope } from 'effect';
import assert from 'node:assert/strict';
import test, { after as afterNativeDatabase } from 'node:test';
import type { Pool } from 'pg';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openBoundaryDatabases } from '../support/database-boundary.ts';
import { purgeFixtureRows } from '../../../../packages/core-runtime/tests/support/fixture-cleanup.ts';
import { normalizeOfficialIdentifier } from '../../shared/domain/identifier-contracts.ts';
import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import {
  duplicateCandidateCaseParties,
  duplicateCandidateCases,
  parties,
  partyFactAssertions,
  partyIdentifierClaims,
  partyMatchDecisions,
  partyOfficialIdentifiers,
  partyRelations,
} from '../../src/db/schema.ts';
import type { PartyTransaction } from '../../src/db/types.ts';
import {
  lockAndResolveClaims,
  lockTenantIdentityWrites,
} from '../../src/services/party-identifier-claim.service.ts';
import { createOrMatchParty } from '../../src/services/party-matching-persistence.service.ts';
import { addOfficialIdentifierRecord } from '../../src/services/party-official-identifier-persistence.service.ts';

const nativeDatabaseScope = runNativeSync(NativeScope.make());
afterNativeDatabase(
  NativeScope.close(nativeDatabaseScope, NativeExit.void).pipe(nativeTestCallback),
);

/** Both boundary roles read the same owned schema through the scope closed after these tests. */
const openPartyDatabase = async (pool: Pool) =>
  await runEffectTestPromise(
    makeTestDatabaseFromPool(pool, partyRelations).pipe(NativeScope.provide(nativeDatabaseScope)),
  );

const tenantId = 'bc100000-0000-4000-8000-000000000001';
const principalId = 'bc200000-0000-4000-8000-000000000001';

test('real PostgreSQL identity locks serialize concurrent exact creates and repeated identifier acceptance', async () => {
  const { admin, adminPool, runtime, runtimePool } = await openBoundaryDatabases(
    openPartyDatabase,
    2,
  );
  // Ordered child-before-parent so every delete respects the owned foreign keys.
  const cleanup = async (): Promise<void> => {
    await runEffectTestPromise(
      purgeFixtureRows(
        [
          partyMatchDecisions,
          duplicateCandidateCaseParties,
          duplicateCandidateCases,
          partyIdentifierClaims,
          partyOfficialIdentifiers,
          partyFactAssertions,
          parties,
        ].map((table) => admin.delete(table).where(eq(table.tenantId, tenantId))),
      ),
    );
  };
  const scoped = <Value, Failure>(
    operation: (transaction: PartyTransaction) => Effect.Effect<Value, Failure>,
  ) =>
    runEffectTestPromise(
      runtime.transaction((transaction) =>
        Effect.gen(function* transactionTestBody() {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id', ${tenantId}, true)`,
            'objects',
          );
          return yield* operation(transaction);
        }),
      ),
    );
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
          subjectKey: partySubjectKeyFromString('one-subject'),
        },
      ],
      validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
    };
    const results = await Promise.all(
      ['bc300000-0000-4000-8000-000000000001', 'bc300000-0000-4000-8000-000000000002'].map(
        (actionInvocationId) =>
          scoped((transaction) =>
            createOrMatchParty(transaction, {
              actionInvocationId,
              candidate,
              principalId,
              tenantId,
            }),
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
    const canonical = await runEffectTestPromise(
      admin.select().from(parties).where(eq(parties.tenantId, tenantId)),
    );
    assert.equal(canonical.length, 1);
    assert.equal(canonical[0]?.currentDisplayName, null);
    const nameAssertions = await runEffectTestPromise(
      admin.select().from(partyFactAssertions).where(eq(partyFactAssertions.tenantId, tenantId)),
    );
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
      );
    const first = await add('bc300000-0000-4000-8000-000000000003');
    const repeated = await add('bc300000-0000-4000-8000-000000000004');
    assert.equal(repeated.officialIdentifierId, first.officialIdentifierId);
    const claims = await runEffectTestPromise(
      admin
        .select()
        .from(partyIdentifierClaims)
        .where(eq(partyIdentifierClaims.tenantId, tenantId)),
    );
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
