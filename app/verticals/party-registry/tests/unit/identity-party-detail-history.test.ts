import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { Effect, Option, Schema } from 'effect';

import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { PartyFactAssertionSchema } from '../../shared/apis/party-detail.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
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
const wireFact = {
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
const fact = Schema.decodeUnknownSync(PartyFactAssertionSchema)(wireFact);

test('Party fact assertion contract exposes usable correction identities without sensitive evidence', () => {
  assert.deepEqual(Schema.encodeSync(PartyFactAssertionSchema)(fact), wireFact);
  assert.throws(() =>
    Schema.decodeUnknownSync(PartyFactAssertionSchema)({
      ...wireFact,
      assertionId: 'not-a-uuid',
    })
  );
  const decodedWithSensitiveFields = Schema.decodeUnknownSync(
    PartyFactAssertionSchema
  )({
    ...wireFact,
    evidenceRefs: ['secret'],
    provenance: { source: 'secret' },
  });
  assert.deepEqual(
    Schema.encodeSync(PartyFactAssertionSchema)(decodedWithSensitiveFields),
    wireFact
  );
});

test('Party Detail history derives reviewer authority while current fact targets retain normal read authority', () => {
  assert.equal(
    partyDetailPermissionTarget({ partyRef }).permission,
    'read_party_identity'
  );
  assert.equal(
    partyDetailPermissionTarget({ includeFactHistory: false, partyRef })
      .permission,
    'read_party_identity'
  );
  assert.equal(
    partyDetailPermissionTarget({ includeFactHistory: true, partyRef })
      .permission,
    'review_party_identity'
  );
});

test('Party Detail persistence reads safe current and immutable historical assertions through a tenant-scoped query', () => {
  const queries: string[] = [];
  const values: (readonly unknown[])[] = [];
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
  const database = makeTestDatabase((text, parameters) =>
    Effect.sync(() => {
      queries.push(text);
      values.push(parameters);
      return rows.map((row) =>
        Object.fromEntries(row.map((value, index) => [String(index), value]))
      );
    })
  );
  return runEffectTestPromise(
    Effect.gen(function* checkSafeHistory() {
      const result = yield* findPartyDetailAssertions(
        database,
        tenantId,
        partyId,
        true
      );
      assert.deepEqual(result.currentFactAssertions, [fact]);
      const history = Option.getOrThrow(result.factHistory);
      assert.equal(history.length, 2);
      assert.equal(history[0]?.value, 'Original name');
      assert.equal(history[0]?.state, 'SUPERSEDED');
      const current = yield* findPartyDetailAssertions(
        database,
        tenantId,
        partyId,
        false
      );
      assert.deepEqual(current, {
        currentFactAssertions: [fact],
        factHistory: Option.none(),
      });
      assert.deepEqual(values, [
        [tenantId, partyId],
        [tenantId, partyId, 'ACTIVE', true],
      ]);
      const [historyQuery = '', currentQuery = ''] = queries;
      assert.match(historyQuery, /"tenant_id" = \$1/u);
      assert.match(historyQuery, /"party_id" = \$2/u);
      assert.doesNotMatch(
        historyQuery,
        /provenance|principal|invocation|verification/u
      );
      assert.doesNotMatch(currentQuery, /external_evidence/u);
      assert.match(currentQuery, /"state" = \$3/u);
      assert.match(currentQuery, /"is_current" = \$4/u);
      const detail = yield* readPartyDetailFromServices(
        partyRef,
        tenantId,
        {
          facts: (canonicalPartyId, includeHistory) =>
            findPartyDetailAssertions(
              database,
              tenantId,
              canonicalPartyId,
              includeHistory
            ),
          find: () =>
            Effect.succeed({
              _tag: 'found' as const,
              value: Schema.decodeUnknownSync(PartySchema)({
                archivedAt: null,
                createdAt: '2026-09-01T10:00:00.000Z',
                displayName: 'Corrected name',
                partyRef,
                partyType: 'ORGANIZATION' as const,
                revision: 2,
                updatedAt: '2026-09-03T10:00:00.000Z',
              }),
            }),
          resolve: () =>
            Effect.succeed({
              canonicalPartyId: partyId,
              requestedPartyId: partyId,
              traversedAliasIds: [],
              wasAlias: false,
            }),
        },
        true
      );
      assert.equal(detail.currentFactAssertions[0]?.assertionId, assertionId);
      const detailHistory = Option.getOrThrow(detail.factHistory);
      assert.equal(detailHistory[0]?.assertionId, previousId);
      assert.equal(detailHistory[0]?.value, 'Original name');
    })
  );
});
