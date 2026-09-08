import { expect, it } from '@app/effect-rstest';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';
import { Pool } from 'pg';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
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

const tenantId = 'bc100000-0000-4000-8000-000000000001';
const principalId = 'bc200000-0000-4000-8000-000000000001';

it.live(
  'real PostgreSQL identity locks serialize concurrent exact creates and repeated identifier acceptance',
  () =>
    Effect.gen(function* identityConcurrencyTest() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: connections.admin.connectionString })),
        (pool) => Effect.promise(() => pool.end()),
      );
      const runtimePool = yield* Effect.acquireRelease(
        Effect.sync(
          () => new Pool({ connectionString: connections.runtime.connectionString, max: 2 }),
        ),
        (pool) => Effect.promise(() => pool.end()),
      );
      const admin = yield* makeTestDatabaseFromPool(adminPool, partyRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, partyRelations);
      const cleanup = Effect.gen(function* cleanupIdentityRecords() {
        yield* admin.delete(partyMatchDecisions).where(eq(partyMatchDecisions.tenantId, tenantId));
        yield* admin
          .delete(duplicateCandidateCaseParties)
          .where(eq(duplicateCandidateCaseParties.tenantId, tenantId));
        yield* admin
          .delete(duplicateCandidateCases)
          .where(eq(duplicateCandidateCases.tenantId, tenantId));
        yield* admin
          .delete(partyIdentifierClaims)
          .where(eq(partyIdentifierClaims.tenantId, tenantId));
        yield* admin
          .delete(partyOfficialIdentifiers)
          .where(eq(partyOfficialIdentifiers.tenantId, tenantId));
        yield* admin.delete(partyFactAssertions).where(eq(partyFactAssertions.tenantId, tenantId));
        yield* admin.delete(parties).where(eq(parties.tenantId, tenantId));
      });
      const scoped = <Value, Failure>(
        operation: (transaction: PartyTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* transactionTestBody() {
            yield* transaction.execute(
              sql`select set_config('ontos.tenant_id', ${tenantId}, true)`,
              'objects',
            );
            return yield* operation(transaction);
          }),
        );
      yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
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
      const results = yield* Effect.all(
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
        { concurrency: 'unbounded' },
      );
      expect(results.map((result) => result.outcome).toSorted()).toEqual([
        'CREATED',
        'MATCHED_EXISTING',
      ]);
      const created = Option.getOrThrow(
        Option.fromNullishOr(results.find((result) => result.outcome === 'CREATED')),
      );
      expect(created.outcome).toBe('CREATED');
      const partyId = created.partyRef.resourceId;
      const canonical = yield* admin.select().from(parties).where(eq(parties.tenantId, tenantId));
      expect(canonical).toHaveLength(1);
      expect(canonical[0]?.currentDisplayName).toBe(null);
      const nameAssertions = yield* admin
        .select()
        .from(partyFactAssertions)
        .where(eq(partyFactAssertions.tenantId, tenantId));
      expect(nameAssertions.some((row) => row.factKind === 'DISPLAY_NAME')).toBe(false);
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
      const first = yield* add('bc300000-0000-4000-8000-000000000003');
      const repeated = yield* add('bc300000-0000-4000-8000-000000000004');
      expect(repeated.officialIdentifierId).toBe(first.officialIdentifierId);
      const claims = yield* admin
        .select()
        .from(partyIdentifierClaims)
        .where(eq(partyIdentifierClaims.tenantId, tenantId));
      expect(claims).toHaveLength(2);
    }),
);
