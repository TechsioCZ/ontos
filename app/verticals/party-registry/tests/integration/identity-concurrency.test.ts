import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
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
import { lockAndResolveClaims, lockTenantIdentityWrites } from '../../src/services/party-identifier-claim.service.ts';
import { createOrMatchParty } from '../../src/services/party-matching-persistence.service.ts';
import {
  acceptMatchingOfficialIdentifierRecord,
  addOfficialIdentifierRecord,
} from '../../src/services/party-official-identifier-persistence.service.ts';
import { openBoundaryDatabases } from '../support/database-boundary.ts';

const tenantId = 'bc100000-0000-4000-8000-000000000001';
const principalId = 'bc200000-0000-4000-8000-000000000001';

it.live('real PostgreSQL identity locks serialize concurrent exact creates and repeated identifier acceptance', () =>
  Effect.gen(function* identityConcurrencyTest() {
    const { admin, runtime } = yield* openBoundaryDatabases(
      (pool) => makeTestDatabaseFromPool(pool, partyRelations),
      2,
    );
    const cleanup = purgeFixtureRows(
      [
        partyMatchDecisions,
        duplicateCandidateCaseParties,
        duplicateCandidateCases,
        partyIdentifierClaims,
        partyOfficialIdentifiers,
        partyFactAssertions,
        parties,
      ].map((table) => admin.delete(table).where(eq(table.tenantId, tenantId))),
    );
    const scoped = <Value, Failure>(operation: (transaction: PartyTransaction) => Effect.Effect<Value, Failure>) =>
      runtime.transaction((transaction) =>
        Effect.gen(function* transactionTestBody() {
          yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
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
          verification: 'VERIFIED' as const,
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
    expect(results.map((result) => result.outcome).toSorted()).toEqual(['CREATED', 'MATCHED_EXISTING']);
    const created = Option.getOrThrow(Option.fromNullishOr(results.find((result) => result.outcome === 'CREATED')));
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

    const upgradeIdentifier = normalizeOfficialIdentifier({
      identifierType: 'ICO',
      value: '26168685',
      verification: 'UNVERIFIED',
    });
    yield* scoped((transaction) =>
      Effect.gen(function* seedUnverifiedIdentifier() {
        yield* lockTenantIdentityWrites(transaction, tenantId);
        return yield* addOfficialIdentifierRecord(transaction, tenantId, partyId, upgradeIdentifier, {
          actionInvocationId: 'bc300000-0000-4000-8000-000000000005',
          matchRuleVersion: 'party-exact-claims.v1',
          partyType: 'ORGANIZATION',
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
          Effect.gen(function* concurrentUpgrade() {
            yield* lockTenantIdentityWrites(transaction, tenantId);
            yield* lockAndResolveClaims(transaction, tenantId, [{ ...upgradeIdentifier, verification: 'VERIFIED' }]);
            return yield* acceptMatchingOfficialIdentifierRecord(
              transaction,
              tenantId,
              partyId,
              { ...upgradeIdentifier, verification: 'VERIFIED' },
              {
                actionInvocationId,
                matchRuleVersion: 'party-exact-claims.v1',
                partyType: 'ORGANIZATION',
                principalId,
                provenanceMethod: 'REGISTRY',
                provenanceSource: 'identity-concurrency-test',
                validFrom: candidate.validFrom,
              },
            );
          }),
        ),
      { concurrency: 'unbounded' },
    );
    expect(accepted.map((result) => result._tag).toSorted()).toEqual(['reused', 'updated']);
    const upgraded = yield* admin
      .select()
      .from(partyOfficialIdentifiers)
      .where(eq(partyOfficialIdentifiers.tenantId, tenantId));
    expect(upgraded.filter((row) => row.normalizedValue === '26168685')).toHaveLength(1);
    const upgradedAssertion = upgraded.find((row) => row.normalizedValue === '26168685');
    expect(upgradedAssertion?.verificationState).toBe('VERIFIED');
    const upgradeClaims = yield* admin
      .select()
      .from(partyIdentifierClaims)
      .where(eq(partyIdentifierClaims.tenantId, tenantId));
    const exactUpgradeClaims = upgradeClaims.filter(
      (claim) =>
        claim.identifierTypeKey === 'ICO' && claim.namespace === 'CZ:ICO' && claim.normalizedValue === '26168685',
    );
    expect(exactUpgradeClaims).toHaveLength(1);
    expect(exactUpgradeClaims[0]?.partyId).toBe(partyId);
    expect(exactUpgradeClaims[0]?.officialIdentifierId).toBe(upgradedAssertion?.officialIdentifierId);
  }),
);
