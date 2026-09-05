/* oxlint-disable typescript/return-await */
// @effect-diagnostics asyncFunction:off
/* eslint-disable no-await-in-loop, unicorn/no-await-expression-member, anti-slop/no-conditional-empty-object-spread, anti-slop/no-unsafe-dictionary-type -- Sequential state assertions and deliberately malformed unknown overrides make the projection boundary contract explicit. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Exit } from 'effect';
import {
  makeCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '../../src/search/projection.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const aliasRef = {
  ...partyRef,
  resourceId: '30000000-0000-4000-8000-000000000002',
} as const;

const party = (overrides: Record<string, unknown> = {}) => ({
  archived: false,
  facets: [],
  metadata: [{ key: 'party-kind', kind: 'string', value: 'ORGANIZATION' }],
  projectionVersion: '1',
  ref: partyRef,
  searchableText: ['Acme, s.r.o.', 'CZ12345678', 'private@example.test'],
  title: 'Acme, s.r.o.',
  ...overrides,
});

test('a projection rebuild floor prevents unseen stale resources and rejects divergent equal-version rebuilds', async () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = makeCoreSearchQueryRuntime(store);
  const rebuild = {
    documents: [],
    moduleId: partyRef.moduleId,
    rebuildVersion: '2',
    resourceType: partyRef.resourceType,
    tenantId,
  };
  await Effect.runPromise(store.replace(rebuild));
  await Effect.runPromise(store.apply({ document: party(), kind: 'upsert' }));
  await Effect.runPromise(store.replace({ ...rebuild, documents: [party()], rebuildVersion: '1' }));
  assert.deepEqual(
    await Effect.runPromise(
      runtime.search({
        includeArchived: false,
        moduleId: partyRef.moduleId,
        query: 'acme',
        resourceType: partyRef.resourceType,
        tenantId,
      }),
    ),
    [],
  );
  await Effect.runPromise(store.replace(rebuild));
  const divergent = await Effect.runPromise(
    Effect.flip(store.replace({ ...rebuild, documents: [party()] })),
  );
  assert.equal(divergent._tag, 'CoreSearchProjectionInvalid');
  await Effect.runPromise(
    store.apply({ document: party({ projectionVersion: '3' }), kind: 'upsert' }),
  );
  await Effect.runPromise(store.replace(rebuild));
  assert.equal(
    (
      await Effect.runPromise(
        runtime.search({
          includeArchived: false,
          moduleId: partyRef.moduleId,
          query: 'acme',
          resourceType: partyRef.resourceType,
          tenantId,
        }),
      )
    ).length,
    1,
  );
});

test('Core Search identifies alias-only matches while canonical evidence takes precedence', async () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = makeCoreSearchQueryRuntime(store);
  await Effect.runPromise(
    store.apply({
      document: party({
        aliases: [{ kind: 'resource', ref: aliasRef, searchableText: ['Former Company', 'Acme'] }],
        matchedRef: aliasRef,
      }),
      kind: 'upsert',
    }),
  );
  const search = async (query: string) =>
    Effect.runPromise(
      runtime.search({
        includeArchived: false,
        moduleId: partyRef.moduleId,
        query,
        resourceType: partyRef.resourceType,
        tenantId,
      }),
    );
  const aliasHits = await search('former');
  assert.equal(aliasHits.length, 1);
  assert.deepEqual(aliasHits[0]?.ref, partyRef);
  assert.deepEqual(aliasHits[0]?.matchedRef, aliasRef);
  assert.equal(aliasHits[0]?.matchedSubjectRef, undefined);
  assert.doesNotMatch(JSON.stringify(aliasHits), /Former Company|searchableText|aliases/u);
  assert.equal((await search('acme'))[0]?.matchedRef, undefined);
});

test('Core Search rejects cross-tenant aliases and malformed or oversized temporal evidence', async () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const invalidEvidence = [
    {
      aliases: [
        {
          kind: 'resource',
          ref: { ...aliasRef, tenantId: otherTenantId },
          searchableText: ['foreign'],
        },
      ],
    },
    { temporalSearchableText: [{ validFrom: 'not-a-date', value: 'private' }] },
    {
      temporalSearchableText: [
        { validFrom: '2026-02-01', validTo: '2026-02-01', value: 'private' },
      ],
    },
    {
      aliases: [
        {
          kind: 'subject',
          ref: aliasRef,
          searchableText: [],
          temporalSearchableText: [
            { validFrom: '2026-02-01', validTo: '2026-01-01', value: 'private' },
          ],
        },
      ],
    },
    {
      aliases: Array.from({ length: 101 }, () => ({
        kind: 'resource',
        ref: aliasRef,
        searchableText: ['private'],
      })),
    },
    {
      temporalSearchableText: Array.from({ length: 101 }, () => ({
        validFrom: '2026-01-01',
        value: 'private',
      })),
    },
  ];
  for (const evidence of invalidEvidence) {
    const failure = await Effect.runPromise(
      Effect.flip(store.apply({ document: party(evidence), kind: 'upsert' })),
    );
    assert.equal(failure._tag, 'CoreSearchProjectionInvalid');
  }
});

test('Core Search honors half-open evidence periods for canonical and subject aliases', async () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = makeCoreSearchQueryRuntime(store);
  await Effect.runPromise(
    store.apply({
      document: party({
        aliases: [
          {
            kind: 'subject',
            ref: aliasRef,
            searchableText: [],
            temporalSearchableText: [
              {
                validFrom: '2026-01-01T00:00:00Z',
                validTo: '2026-02-01T00:00:00Z',
                value: 'old-private@example.test',
              },
            ],
          },
        ],
        temporalSearchableText: [
          { validFrom: '2026-02-01T00:00:00Z', value: 'current-private@example.test' },
          {
            validFrom: '2000-01-01T00:00:00Z',
            validTo: '2100-01-01T00:00:00Z',
            value: 'long-lived@example.test',
          },
        ],
      }),
      kind: 'upsert',
    }),
  );
  const search = async (query: string, effectiveAt?: string) =>
    Effect.runPromise(
      runtime.search({
        ...(effectiveAt === undefined ? {} : { effectiveAt }),
        includeArchived: false,
        moduleId: partyRef.moduleId,
        query,
        resourceType: partyRef.resourceType,
        tenantId,
      }),
    );
  assert.deepEqual(
    (await search('old-private', '2026-01-01T00:00:00Z'))[0]?.matchedSubjectRef,
    aliasRef,
  );
  assert.deepEqual(await search('old-private', '2026-02-01T00:00:00Z'), []);
  assert.deepEqual(await search('current-private', '2026-01-31T23:59:59Z'), []);
  const current = await search('current-private', '2026-02-01T00:00:00Z');
  assert.equal(current.length, 1);
  assert.equal(current[0]?.matchedSubjectRef, undefined);
  assert.doesNotMatch(JSON.stringify(current), /private@example|temporalSearchableText/u);
  assert.equal((await search('long-lived')).length, 1);
});

test('Core Search rebuilds one owned projection atomically and isolates tenants', async () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = makeCoreSearchQueryRuntime(store);

  await Effect.runPromise(
    store.replace({
      documents: [party()],
      moduleId: 'party.registry',
      rebuildVersion: '1',
      resourceType: 'party.registry.party',
      tenantId,
    }),
  );
  await Effect.runPromise(
    store.replace({
      documents: [
        party({
          ref: { ...partyRef, tenantId: otherTenantId },
          title: 'Other tenant',
        }),
      ],
      moduleId: 'party.registry',
      rebuildVersion: '1',
      resourceType: 'party.registry.party',
      tenantId: otherTenantId,
    }),
  );

  const result = await Effect.runPromise(
    runtime.search({
      includeArchived: false,
      moduleId: 'party.registry',
      query: 'acme',
      resourceType: 'party.registry.party',
      tenantId,
    }),
  );
  assert.deepEqual(result, [
    {
      archived: false,
      facets: [],
      metadata: [{ key: 'party-kind', kind: 'string', value: 'ORGANIZATION' }],
      ref: partyRef,
      title: 'Acme, s.r.o.',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private@example\.test/u);

  await Effect.runPromise(
    store.replace({
      documents: [party({ archived: true, projectionVersion: '2', title: 'Replacement' })],
      moduleId: 'party.registry',
      rebuildVersion: '2',
      resourceType: 'party.registry.party',
      tenantId,
    }),
  );
  await assert.doesNotReject(
    Effect.runPromise(
      runtime.search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'acme',
        resourceType: 'party.registry.party',
        tenantId,
      }),
    ).then((hits) => assert.deepEqual(hits, [])),
  );
});

test('Core Search applies typed Legal Entity and role facets without returning match evidence', async () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = makeCoreSearchQueryRuntime(store);
  const counterpartyRef = {
    moduleId: 'party.registry',
    resourceId: '40000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.counterparty',
    tenantId,
  } as const;
  await Effect.runPromise(
    store.replace({
      documents: [
        {
          archived: false,
          facets: [],
          matchedSubjectRef: aliasRef,
          metadata: [{ key: 'current-roles', kind: 'strings', value: ['CUSTOMER', 'SUPPLIER'] }],
          projectionVersion: '1',
          ref: counterpartyRef,
          searchableText: ['Acme', 'private@example.test'],
          selectedLegalEntityId: legalEntityId,
          subjectRef: partyRef,
          temporalFacets: [
            {
              key: 'current-role',
              validFrom: '2026-01-01T00:00:00.000Z',
              value: 'CUSTOMER',
            },
            {
              key: 'current-role',
              validFrom: '2026-02-01T00:00:00.000Z',
              value: 'SUPPLIER',
            },
          ],
          title: 'Acme',
        },
      ],
      moduleId: 'party.registry',
      rebuildVersion: '1',
      resourceType: 'party.registry.counterparty',
      tenantId,
    }),
  );

  const result = await Effect.runPromise(
    runtime.search({
      effectiveAt: '2026-09-03T00:00:00.000Z',
      facets: [{ key: 'current-role', values: ['SUPPLIER'] }],
      includeArchived: false,
      moduleId: 'party.registry',
      query: 'private@example.test',
      resourceType: 'party.registry.counterparty',
      selectedLegalEntityId: legalEntityId,
      tenantId,
    }),
  );
  assert.deepEqual(result, [
    {
      archived: false,
      facets: [],
      matchedSubjectRef: aliasRef,
      metadata: [{ key: 'current-roles', kind: 'strings', value: ['CUSTOMER', 'SUPPLIER'] }],
      ref: counterpartyRef,
      selectedLegalEntityId: legalEntityId,
      subjectRef: partyRef,
      temporalFacets: [
        {
          key: 'current-role',
          validFrom: '2026-01-01T00:00:00.000Z',
          value: 'CUSTOMER',
        },
        {
          key: 'current-role',
          validFrom: '2026-02-01T00:00:00.000Z',
          value: 'SUPPLIER',
        },
      ],
      title: 'Acme',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private@example\.test/u);
  assert.deepEqual(
    await Effect.runPromise(
      runtime.search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'acme',
        resourceType: 'party.registry.counterparty',
        tenantId,
      }),
    ),
    [],
  );
});

test('Core Search rejects malformed or cross-owner rebuild documents without partial replacement', async () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = makeCoreSearchQueryRuntime(store);
  await Effect.runPromise(
    store.replace({
      documents: [party()],
      moduleId: 'party.registry',
      rebuildVersion: '1',
      resourceType: 'party.registry.party',
      tenantId,
    }),
  );

  const failure = await Effect.runPromise(
    Effect.flip(
      store.replace({
        documents: [party({ ref: { ...partyRef, moduleId: 'foreign.module' } })],
        moduleId: 'party.registry',
        rebuildVersion: '1',
        resourceType: 'party.registry.party',
        tenantId,
      }),
    ),
  );
  assert.equal(failure._tag, 'CoreSearchProjectionInvalid');
  const result = await Effect.runPromise(
    runtime.search({
      includeArchived: false,
      moduleId: 'party.registry',
      query: 'acme',
      resourceType: 'party.registry.party',
      tenantId,
    }),
  );
  assert.equal(result.length, 1);
});

test('projection validation separates malformed input from unexpected defects', (t) => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const rebuild = {
    documents: [party()],
    moduleId: partyRef.moduleId,
    rebuildVersion: '2',
    resourceType: partyRef.resourceType,
    tenantId,
  };
  for (const operation of [store.apply, store.replace]) {
    const failure = Effect.runSync(Effect.flip(operation({ unexpected: true })));
    assert.equal(failure._tag, 'CoreSearchProjectionInvalid');
  }
  const defect = new Error('unexpected input accessor failure');
  const brokenDocument = {
    ...party(),
    get title(): string {
      throw defect;
    },
  };
  t.mock.method(Date, 'parse', () => {
    throw defect;
  });
  const temporal = party({
    temporalSearchableText: [{ validFrom: '2026-01-01', value: 'Evidence' }],
  });
  for (const operation of [
    store.apply({ document: brokenDocument, kind: 'upsert' }),
    store.replace({ ...rebuild, documents: [brokenDocument] }),
    store.apply({ document: temporal, kind: 'upsert' }),
    store.replace({ ...rebuild, documents: [temporal] }),
  ]) {
    const exit = Effect.runSyncExit(operation);
    assert.ok(Exit.isFailure(exit));
    assert.equal(exit.cause.reasons.length, 1);
    const reason = exit.cause.reasons[0];
    assert.equal(reason?._tag, 'Die');
    assert.ok(reason?._tag === 'Die');
    assert.equal(reason.defect, defect);
  }
});

test('late rebuild conflicts publish neither staged documents nor a rebuild floor', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const original = party({ projectionVersion: '2' });
  const staged = party({ projectionVersion: '3', ref: aliasRef, title: 'Staged' });
  const rebuild = {
    documents: [staged, party({ projectionVersion: '2', title: 'Conflict' })],
    moduleId: partyRef.moduleId,
    rebuildVersion: '4',
    resourceType: partyRef.resourceType,
    tenantId,
  };
  const candidates = () =>
    Effect.runSync(
      store.queryCandidates({
        includeArchived: true,
        moduleId: partyRef.moduleId,
        query: 'acme',
        resourceType: partyRef.resourceType,
        tenantId,
      }),
    );
  Effect.runSync(store.apply({ document: original, kind: 'upsert' }));
  for (const operation of [
    store.apply({ document: party({ projectionVersion: '2', title: 'Conflict' }), kind: 'upsert' }),
    store.apply({ kind: 'delete', projectionVersion: '2', ref: partyRef }),
    store.replace(rebuild),
    store.replace({ ...rebuild, documents: [staged, staged] }),
    store.replace({ ...rebuild, documents: [party({ projectionVersion: '5' })] }),
  ]) {
    assert.equal(Effect.runSync(Effect.flip(operation))._tag, 'CoreSearchProjectionInvalid');
    assert.deepEqual(candidates(), [original]);
  }
  Effect.runSync(store.apply({ document: staged, kind: 'upsert' }));
  assert.deepEqual(candidates(), [original, staged]);
  const valid = { ...rebuild, documents: [original, staged] };
  Effect.runSync(store.replace(valid));
  Effect.runSync(store.replace({ ...valid, documents: [staged, original] }));
  assert.deepEqual(candidates(), [original, staged]);
});

test('Core Search makes duplicate and out-of-order lifecycle observations harmless', async () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = makeCoreSearchQueryRuntime(store);
  const versionTwo = party({ projectionVersion: '2', title: 'Current title' });
  await Effect.runPromise(store.apply({ document: versionTwo, kind: 'upsert' }));
  await Effect.runPromise(store.apply({ document: versionTwo, kind: 'upsert' }));
  await Effect.runPromise(
    store.apply({
      document: party({ projectionVersion: '1', title: 'Stale title' }),
      kind: 'upsert',
    }),
  );
  await Effect.runPromise(store.apply({ kind: 'delete', projectionVersion: '3', ref: partyRef }));
  await Effect.runPromise(store.apply({ document: versionTwo, kind: 'upsert' }));

  assert.deepEqual(
    await Effect.runPromise(
      runtime.search({
        includeArchived: true,
        moduleId: 'party.registry',
        query: 'current',
        resourceType: 'party.registry.party',
        tenantId,
      }),
    ),
    [],
  );
});
