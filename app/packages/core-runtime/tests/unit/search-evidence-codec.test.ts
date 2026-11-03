import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { searchIndexEntries, searchProjectionRebuilds } from '../../src/db/schema.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { deriveCoreSearchRepresentation } from '../../src/search/evidence-codec.ts';
import { CORE_SEARCH_CANDIDATE_BUDGET, coreSearchCandidatePredicate } from '../../src/search/indexed-query.ts';
import {
  coreSearchDocumentBodyText,
  coreSearchDocumentPayload,
  decodeCoreSearchDocumentRow,
  makePostgresCoreSearchProjectionStore,
} from '../../src/search/persistence.ts';
import {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionReplacementSchema,
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchQuerySchema,
  coreSearchReplacementFingerprint,
  createCoreSearchQueryRuntime,
} from '../../src/search/projection.ts';
import type { CoreSearchProjectionDocument } from '../../src/search/projection.ts';
import {
  CORE_SEARCH_RELEVANCE_VERSION,
  coreSearchTokens,
  escapeCoreSearchLike,
  normalizeCoreSearchText,
} from '../../src/search/search-contract.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const moduleId = 'party.registry';
const resourceType = 'party.registry.party';
const ref = (resourceId: string) => ({ moduleId, resourceId, resourceType, tenantId });
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000009',
    authContextRef: 'better-auth-session:search-evidence-codec',
    authMethod: 'session',
    principalId: '40000000-0000-4000-8000-000000000008',
    tenantId,
  }),
  correlationId: 'search-evidence-codec',
};
const worker = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: '50000000-0000-4000-8000-000000000001',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: moduleId,
  deliveryId: '50000000-0000-4000-8000-000000000002',
  domainEventId: '50000000-0000-4000-8000-000000000003',
  legalEntityScope: 'forbidden',
  messageId: '50000000-0000-4000-8000-000000000004',
  producerModuleKey: moduleId,
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'party.registry.search-refresh-requested.v1',
  workerKey: 'party.registry.refresh-search',
});
const document = (resourceId: string, overrides: Partial<typeof CoreSearchProjectionDocumentSchema.Encoded> = {}) =>
  Schema.decodeSync(CoreSearchProjectionDocumentSchema)({
    archived: false,
    facets: [],
    metadata: [],
    projectionVersion: '7',
    ref: ref(resourceId),
    searchableText: ['Canonical Červená'],
    title: 'Current title',
    ...overrides,
  });
type QueryOverrides = Partial<typeof CoreSearchQuerySchema.Encoded>;
const rawQuery = (text: string, overrides: QueryOverrides = {}) => ({
  effectiveAt: '2026-11-03T00:00:00Z',
  includeArchived: false,
  moduleId,
  query: text,
  resourceType,
  tenantId,
  ...overrides,
});
const query = (text: string, overrides: Parameters<typeof rawQuery>[1] = {}) =>
  Schema.decodeSync(CoreSearchQuerySchema)(rawQuery(text, overrides));
type Row = typeof searchIndexEntries.$inferSelect;
const row = (entry: CoreSearchProjectionDocument): Row => ({
  ...deriveCoreSearchRepresentation(entry),
  bodyText: Result.getOrThrow(coreSearchDocumentBodyText(entry)),
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00Z')),
  deleted: false,
  facetsJson: coreSearchDocumentPayload(entry),
  legalEntityId: entry.selectedLegalEntityId ?? null,
  projectionVersion: BigInt(entry.projectionVersion),
  searchIndexEntryId: '60000000-0000-4000-8000-000000000001',
  sourceModuleKey: entry.ref.moduleId,
  sourceResourceId: entry.ref.resourceId,
  sourceResourceType: entry.ref.resourceType,
  tenantId: entry.ref.tenantId,
  title: entry.title,
  updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00Z')),
});
/** Scripted driver uses positional rows, in the exact real Drizzle table projection order. */
/* oxlint-disable perfectionist/sort-objects -- Scripted PostgreSQL rows must follow Drizzle physical column order; expires: 2027-03-31. */
const driverRow = (entry: Row) => ({
  searchIndexEntryId: entry.searchIndexEntryId,
  tenantId: entry.tenantId,
  legalEntityId: entry.legalEntityId,
  sourceModuleKey: entry.sourceModuleKey,
  sourceResourceType: entry.sourceResourceType,
  sourceResourceId: entry.sourceResourceId,
  title: entry.title,
  bodyText: entry.bodyText,
  searchTextV1: entry.searchTextV1,
  searchFormatVersion: entry.searchFormatVersion,
  searchSourceVersion: entry.searchSourceVersion,
  deleted: entry.deleted,
  facetsJson: entry.facetsJson,
  projectionVersion: entry.projectionVersion,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
});
type RebuildRow = typeof searchProjectionRebuilds.$inferSelect;
const rebuildRow = (entry: RebuildRow) => ({
  tenantId: entry.tenantId,
  sourceModuleKey: entry.sourceModuleKey,
  sourceResourceType: entry.sourceResourceType,
  rebuildVersion: entry.rebuildVersion,
  fingerprint: entry.fingerprint,
  updatedAt: entry.updatedAt,
});
/* oxlint-enable perfectionist/sort-objects */
const replacement = (documents: readonly CoreSearchProjectionDocument[], rebuildVersion = '2') =>
  Schema.decodeSync(CoreSearchProjectionReplacementSchema)({
    documents,
    moduleId,
    rebuildVersion,
    resourceType,
    tenantId,
  });
const infrastructureRows = (statement: string) => {
  if (statement.includes("current_setting('transaction_isolation')")) {
    return [{ isolation: 'read committed' }];
  }
  if (statement.includes('from "core"."application_composition_authority"')) {
    return [{ phase: 'active', revision: 'a'.repeat(64), subscriptionsJson: [], unexpired: true }];
  }
  if (statement.includes('as tenant_id') && statement.includes('as legal_entity_id')) {
    return [{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }];
  }
  return [];
};

it('derives complete accent-normalized all-period evidence without mixing away the original codec groups', () => {
  const entry = document('one', {
    aliases: [
      {
        kind: 'subject',
        ref: ref('alias'),
        searchableText: ['Former Žlutá'],
        temporalSearchableText: [{ validFrom: '2025-01-01', validTo: '2026-01-01', value: 'Expired Modrá' }],
      },
    ],
    temporalSearchableText: [
      { validFrom: '2027-01-01', value: 'Future Zelená' },
      { validFrom: '2025-01-01', validTo: '2026-01-01', value: 'Past Bílá' },
    ],
  });
  const derived = deriveCoreSearchRepresentation(entry);
  expect(derived).toEqual({
    searchFormatVersion: 1,
    searchSourceVersion: 7n,
    searchTextV1: 'current title\ncanonical cervena\nfuture zelena\npast bila\nformer zluta\nexpired modra',
  });
  const decoded = Result.getOrThrow(decodeCoreSearchDocumentRow(row(entry)));
  expect(decoded).toEqual(entry);
  expect(deriveCoreSearchRepresentation(decoded)).toEqual(derived);
});

it('does not truncate final alias / temporal values, compatibility ligatures or wildcard literals', () => {
  const entry = document('capacity', {
    aliases: Array.from({ length: 100 }, (_, index) => ({
      kind: 'resource',
      ref: ref(`alias-${index}`),
      searchableText: [`alias-${index}`],
      temporalSearchableText: [{ validFrom: '2027-01-01', value: `future-${index}` }],
    })),
    searchableText: Array.from({ length: 2002 }, (_, index) => `${index} Červená ﬃ %_\\`),
  });
  const { searchTextV1 } = deriveCoreSearchRepresentation(entry);
  expect(searchTextV1).toContain('2001 cervena ffi %_\\');
  expect(searchTextV1.endsWith('alias-99\nfuture-99')).toBe(true);
  expect(normalizeCoreSearchText('DVOŘÁK')).toBe('dvorak');
  expect(escapeCoreSearchLike(String.raw`a%_\b`)).toBe(String.raw`a\%\_\\b`);
});

it('compiles token-AND SQL with bound escaped LIKE values and complete stale / null fallback', () => {
  const input = query(String.raw`ŽLUTÁ 50%_\kód`);
  const compiled = new PgDialect().sqlToQuery(sql`${coreSearchCandidatePredicate(input)}`);
  expect(compiled.sql.match(/ like /gu)).toHaveLength(2);
  expect(compiled.sql).toContain('"search_source_version" <> "core"."search_index_entries"."projection_version"');
  for (const column of ['search_text_v1', 'search_format_version', 'search_source_version']) {
    expect(compiled.sql).toContain(`"${column}" is null`);
  }
  expect(compiled.sql).toContain(' or ');
  expect(compiled.sql).toContain(' and ');
  expect(compiled.params).toContain('%zluta%');
  expect(compiled.params).toContain(String.raw`%50\%\_\\kod%`);
  expect(compiled.sql).not.toContain('zluta');
  expect(compiled.params).toContain(tenantId);
  expect(compiled.params).toContain(moduleId);
  expect(compiled.params).toContain(resourceType);
});

it.effect(
  'runs the real SQL adapter / decoder / matcher and rejects cross-alias and expired shortlist false positives',
  () =>
    Effect.gen(function* verifyExactSqlShortlist() {
      const entries = [
        document('canonical', { searchableText: ['alpha', 'beta'] }),
        document('cross-alias', {
          aliases: [
            { kind: 'resource', ref: ref('a'), searchableText: ['alpha'] },
            { kind: 'subject', ref: ref('b'), searchableText: ['beta'] },
          ],
          searchableText: [],
        }),
        document('expired', {
          searchableText: ['alpha'],
          temporalSearchableText: [{ validFrom: '2025-01-01', validTo: '2026-01-01', value: 'beta' }],
        }),
        document('stale-fallback', { searchableText: ['alpha beta'] }),
        document('null-fallback', { searchableText: ['alpha beta'] }),
      ];
      const rows = entries.map(row).map((value) => {
        if (value.sourceResourceId === 'stale-fallback') {
          return { ...value, searchSourceVersion: 6n, searchTextV1: 'unrelated old text' };
        }
        return value.sourceResourceId === 'null-fallback'
          ? { ...value, searchFormatVersion: null, searchSourceVersion: null, searchTextV1: null }
          : value;
      });
      const statements: string[] = [];
      const executor = yield* makeTestDatabase((statement) => {
        statements.push(statement);
        return Effect.succeed(
          statement.includes('from "core"."search_index_entries"')
            ? rows.map(driverRow)
            : infrastructureRows(statement),
        );
      });
      const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      const input = {
        effectiveAt: '2026-11-03T00:00:00Z',
        includeArchived: false,
        moduleId,
        query: 'beta alpha',
        resourceType,
        tenantId,
      };
      expect((yield* runtime.search(input, scope)).map(({ ref: hitRef }) => hitRef.resourceId)).toEqual([
        'canonical',
        'null-fallback',
        'stale-fallback',
      ]);
      const select = statements.find((statement) => statement.includes('from "core"."search_index_entries"'));
      expect(select).toContain(' like ');
      expect(select).toContain(' limit ');
      expect(statements.some((statement) => statement.includes('set_config'))).toBe(true);
    }),
);

it.effect(
  'supports a selective shortlist in a scripted corpus above 10000 and fails honestly on shortlisted overflow',
  () =>
    Effect.gen(function* verifyPostShortlistBudget() {
      // This is a scripted PostgreSQL driver fixture, not an EXPLAIN/performance claim.
      const corpus = Array.from({ length: CORE_SEARCH_CANDIDATE_BUDGET + 5 }, (_, index) =>
        row(document(`resource-${index}`, { searchableText: [`token-${index}`] })),
      );
      let broad = false;
      const statements: string[] = [];
      const executor = yield* makeTestDatabase((statement, params) => {
        statements.push(statement);
        if (!statement.includes('from "core"."search_index_entries"')) {
          return Effect.succeed(infrastructureRows(statement));
        }
        expect(statement).toContain(' like ');
        expect(params).toContain(CORE_SEARCH_CANDIDATE_BUDGET + 1);
        expect(params).toContain(broad ? '%token%' : '%token-10004%');
        const tokens = coreSearchTokens(broad ? 'token' : 'token-10004');
        const selected = corpus.filter((entry) =>
          tokens.every((token) => entry.searchTextV1?.includes(token) === true),
        );
        return Effect.succeed(selected.slice(0, CORE_SEARCH_CANDIDATE_BUDGET + 1).map(driverRow));
      });
      const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      expect(
        (yield* runtime.search(
          { includeArchived: false, moduleId, query: 'token-10004', resourceType, tenantId },
          scope,
        )).map(({ ref: hitRef }) => hitRef.resourceId),
      ).toEqual(['resource-10004']);
      broad = true;
      const failure = yield* Effect.flip(store.queryCandidates(query('token'), scope));
      expect(Schema.is(CoreSearchProjectionUnavailable)(failure)).toBe(true);
      expect(statements.filter((statement) => statement.includes('from "core"."search_index_entries"'))).toHaveLength(
        2,
      );
    }),
);

it.effect(
  'writes derived evidence and its version in the same accepted upsert, and clears all evidence on delete',
  () =>
    Effect.gen(function* verifyAtomicDerivedWrites() {
      const statements: { params: readonly unknown[]; statement: string }[] = [];
      const executor = yield* makeTestDatabase((statement, params) => {
        statements.push({ params, statement });
        return Effect.succeed(infrastructureRows(statement));
      });
      const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
      const entry = document('new');
      yield* store.apply({ document: entry, kind: 'upsert' }, worker);
      yield* store.apply({ kind: 'delete', projectionVersion: '8', ref: ref('new') }, worker);
      const inserts = statements.filter(({ statement }) =>
        statement.startsWith('insert into "core"."search_index_entries"'),
      );
      expect(inserts).toHaveLength(2);
      for (const column of ['search_text_v1', 'search_format_version', 'search_source_version', 'projection_version']) {
        expect(inserts[0]?.statement).toContain(`"${column}"`);
        expect(inserts[1]?.statement).toContain(`"${column}"`);
      }
      expect(inserts[0]?.params).toContain(deriveCoreSearchRepresentation(entry).searchTextV1);
      expect(inserts[0]?.params.filter((value) => value === '7' || value === 7n)).toHaveLength(2);
      expect(inserts[1]?.params).not.toContain(deriveCoreSearchRepresentation(entry).searchTextV1);
      expect(inserts[1]?.params.filter((value) => value === null).length).toBeGreaterThanOrEqual(3);
      expect(statements.filter(({ statement }) => /^commit$/iu.test(statement))).toHaveLength(2);
    }),
);

it('compiles a bounded multi-type IN predicate while retaining the legacy single-type equality', () => {
  const single = new PgDialect().sqlToQuery(sql`${coreSearchCandidatePredicate(query('alpha'))}`);
  expect(single.sql).toContain('"source_resource_type" = ');
  const { resourceType: _singleType, ...base } = rawQuery('alpha');
  const multi = Schema.decodeSync(CoreSearchQuerySchema)({
    ...base,
    resourceTypes: [resourceType, 'party.registry.counterparty'],
  });
  const compiled = new PgDialect().sqlToQuery(sql`${coreSearchCandidatePredicate(multi)}`);
  expect(compiled.sql).toContain('"source_resource_type" in (');
  expect(compiled.params).toContain(resourceType);
  expect(compiled.params).toContain('party.registry.counterparty');
});

it.effect('ranks only decoded owner evidence, never stale flat shortlist text or the raw tier', () =>
  Effect.gen(function* verifyStaleEvidenceRelevance() {
    const entry = document('owner', { searchableText: ['Beta', 'Alpha'], title: 'Beta Alpha' });
    const stale = { ...row(entry), searchSourceVersion: 6n, searchTextV1: 'flat 1000 unrelated shortlist' };
    const statements: string[] = [];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      return Effect.succeed(
        statement.includes('from "core"."search_index_entries"') ? [driverRow(stale)] : infrastructureRows(statement),
      );
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    expect(yield* runtime.search(rawQuery('beta alpha'), scope)).toEqual([
      { archived: false, facets: [], metadata: [], ref: ref('owner'), title: 'Beta Alpha' },
    ]);
    expect(yield* runtime.search(rawQuery('beta alpha', { includeRelevance: true }), scope)).toEqual([
      {
        archived: false,
        facets: [],
        metadata: [],
        ref: ref('owner'),
        relevance: { score: 900, version: CORE_SEARCH_RELEVANCE_VERSION },
        title: 'Beta Alpha',
      },
    ]);
    expect(statements.find((statement) => statement.includes('from "core"."search_index_entries"'))).toContain(
      ' like ',
    );
  }),
);

it.effect('replaces one projection unit with derived evidence and a rebuild floor in one transaction', () =>
  Effect.gen(function* verifyReplaceWrites() {
    const statements: string[] = [];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      return Effect.succeed(infrastructureRows(statement));
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const entry = document('replacement', { projectionVersion: '1', title: 'Replacement' });
    yield* store.replace(replacement([entry]), worker);
    const inserts = statements.filter((statement) => statement.startsWith('insert into "core"."search_index_entries"'));
    expect(inserts).toHaveLength(1);
    for (const column of ['search_text_v1', 'search_format_version', 'search_source_version', 'projection_version']) {
      expect(inserts[0]).toContain(`"${column}"`);
    }
    expect(statements.some((statement) => statement.includes('insert into "core"."search_projection_rebuilds"'))).toBe(
      true,
    );
    expect(statements.filter((statement) => /^commit$/iu.test(statement))).toHaveLength(1);
  }),
);

it.effect('rejects same-version replace content with a different fingerprint before any row write', () =>
  Effect.gen(function* verifyReplaceCas() {
    const original = replacement([document('original', { projectionVersion: '1' })]);
    const conflict = replacement([document('conflict', { projectionVersion: '1' })]);
    const fingerprint = coreSearchReplacementFingerprint(original);
    const statements: string[] = [];
    const executor = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      if (statement.includes('from "core"."search_projection_rebuilds"')) {
        return Effect.succeed([
          rebuildRow({
            fingerprint,
            rebuildVersion: 2n,
            sourceModuleKey: moduleId,
            sourceResourceType: resourceType,
            tenantId,
            updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00Z')),
          }),
        ]);
      }
      return Effect.succeed(infrastructureRows(statement));
    });
    const store = makePostgresCoreSearchProjectionStore({ executor }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    yield* store.replace(original, worker);
    expect(statements.filter((statement) => statement.startsWith('insert into "core"."search_index_entries"'))).toEqual(
      [],
    );
    const failure = yield* Effect.flip(store.replace(conflict, worker));
    expect(Schema.is(CoreSearchProjectionInvalid)(failure)).toBe(true);
    expect(statements.filter((statement) => statement.startsWith('insert into "core"."search_index_entries"'))).toEqual(
      [],
    );
    expect(
      statements.filter(
        (statement) =>
          statement.startsWith('update "core"."search_index_entries"') ||
          statement.startsWith('delete from "core"."search_index_entries"'),
      ),
    ).toEqual([]);
  }),
);
