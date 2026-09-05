import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Schema } from 'effect';
import { Client } from 'pg';
import { PartyFactAssertionSchema } from '../../shared/apis/party-detail.ts';
import {
  partyDetailPermissionTarget,
  readPartyDetailFromServices,
} from '../../src/api/party-detail.read.ts';
import { findPartyDetailAssertions } from '../../src/services/party-detail-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const partyId = '22222222-2222-4222-8222-222222222222';
const assertionId = '33333333-3333-4333-8333-333333333333';
const previousId = '44444444-4444-4444-8444-444444444444';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const fact = {
  assertionId,
  factKind: 'DISPLAY_NAME',
  isCurrent: true,
  partyRef,
  recordedAt: '2026-09-03T10:00:00.000Z',
  retractsAssertionId: null,
  state: 'ACTIVE',
  supersedesAssertionId: previousId,
  validFrom: '2026-09-03T10:00:00.000Z',
  validTo: null,
  value: 'Corrected name',
} as const;

test('Party fact assertion contract exposes usable correction identities without sensitive evidence', () => {
  assert.deepEqual(Schema.decodeUnknownSync(PartyFactAssertionSchema)(fact), fact);
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyFactAssertionSchema)({ ...fact, assertionId: 'not-a-uuid' }),
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(PartyFactAssertionSchema)({
      ...fact,
      evidenceRefs: ['secret'],
      provenance: { source: 'secret' },
    }),
    fact,
  );
});

test('Party Detail history derives reviewer authority while current fact targets retain normal read authority', () => {
  assert.equal(partyDetailPermissionTarget({ partyRef }).permission, 'read_party_identity');
  assert.equal(
    partyDetailPermissionTarget({ includeFactHistory: false, partyRef }).permission,
    'read_party_identity',
  );
  assert.equal(
    partyDetailPermissionTarget({ includeFactHistory: true, partyRef }).permission,
    'review_party_identity',
  );
});

test('Party Detail persistence reads safe current and immutable historical assertions through a tenant-scoped query', () => {
  const client = new Client();
  const database = drizzle({ client });
  const queries: string[] = [];
  const values: unknown[][] = [];
  const rows = [
    [
      previousId,
      null,
      'DISPLAY_NAME',
      false,
      '2026-09-01T10:00:00.000Z',
      null,
      'SUPERSEDED',
      null,
      '2026-09-01T10:00:00.000Z',
      '2026-09-03T10:00:00.000Z',
      'Original name',
    ],
    [
      assertionId,
      null,
      'DISPLAY_NAME',
      true,
      '2026-09-03T10:00:00.000Z',
      null,
      'ACTIVE',
      previousId,
      '2026-09-03T10:00:00.000Z',
      null,
      'Corrected name',
    ],
  ];
  const query = mock.method(client, 'query', (config: { text: string }, parameters: unknown[]) => {
    queries.push(config.text);
    values.push(parameters);
    return Promise.resolve({ rows });
  });
  return Effect.runPromise(
    Effect.gen(function* checkSafeHistory() {
      const result = yield* findPartyDetailAssertions(database, tenantId, partyId, true);
      assert.deepEqual(result.currentFactAssertions, [fact]);
      assert.equal(result.factHistory?.length, 2);
      assert.equal(result.factHistory?.[0]?.value, 'Original name');
      assert.equal(result.factHistory?.[0]?.state, 'SUPERSEDED');
      const current = yield* findPartyDetailAssertions(database, tenantId, partyId, false);
      assert.deepEqual(current, { currentFactAssertions: [fact], factHistory: null });
      assert.deepEqual(values, [
        [tenantId, partyId],
        [tenantId, partyId, 'ACTIVE', true],
      ]);
      assert.match(queries[0] ?? '', /"tenant_id" = \$1/u);
      assert.match(queries[0] ?? '', /"party_id" = \$2/u);
      assert.doesNotMatch(queries[0] ?? '', /provenance|principal|invocation|verification/u);
      assert.doesNotMatch(queries[1] ?? '', /external_evidence/u);
      assert.match(queries[1] ?? '', /"state" = \$3/u);
      assert.match(queries[1] ?? '', /"is_current" = \$4/u);
      const detail = yield* readPartyDetailFromServices(
        partyRef,
        tenantId,
        {
          facts: (canonicalPartyId, includeHistory) =>
            findPartyDetailAssertions(database, tenantId, canonicalPartyId, includeHistory),
          find: () =>
            Effect.succeed({
              _tag: 'found' as const,
              value: {
                archivedAt: null,
                createdAt: '2026-09-01T10:00:00.000Z',
                displayName: 'Corrected name',
                partyRef,
                partyType: 'ORGANIZATION' as const,
                revision: 2,
                updatedAt: '2026-09-03T10:00:00.000Z',
              },
            }),
          resolve: () =>
            Effect.succeed({
              canonicalPartyId: partyId,
              requestedPartyId: partyId,
              traversedAliasIds: [],
              wasAlias: false,
            }),
        },
        true,
      );
      assert.equal(detail.currentFactAssertions[0]?.assertionId, assertionId);
      assert.equal(detail.factHistory?.[0]?.assertionId, previousId);
      assert.equal(detail.factHistory?.[0]?.value, 'Original name');
    }).pipe(Effect.ensuring(Effect.sync(() => query.mock.restore()))),
  );
});
