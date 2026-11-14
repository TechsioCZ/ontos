import {
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchQueryRuntime,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchProjectionHit } from '@app/core-runtime';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { getReadHandler, makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { OccupancyStateSchema } from '../../shared/apis/records.ts';
import type { OccupancyState } from '../../shared/apis/records.ts';
import { leasesRead } from '../../src/search/leases.provider.ts';
import { buildSearchDocuments } from '../../src/services/search-projection.ts';
import { propertyLeasingRegistration } from '../../vertical.registration.ts';
import { leaseSearchCompanyId, leaseSearchState, leaseSearchTenantId } from '../fixtures/lease-search-state.ts';

const resourceId = '40000000-0000-4000-8000-000000000001';
const scope = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:lease-current-search',
  authMethod: 'session',
  correlationId: 'lease-current-search',
  legalEntityId: leaseSearchCompanyId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId: leaseSearchTenantId,
} as const;
const worker = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'property.leasing',
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'property.leasing',
  tenantId: leaseSearchTenantId,
  tenantSequenceNo: 1n,
  topic: 'property.leasing.search-refresh-requested.v1',
  workerKey: 'property.leasing.refresh-search',
});

const run = Effect.fn('LeaseSearchCurrentOwnerTest.run')(function* run(input: {
  readonly current: OccupancyState;
  readonly indexed?: OccupancyState;
  readonly outcome?: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';
  readonly predicate?: ListAccessPredicate;
  readonly query?: string;
  readonly revision?: number;
  readonly transformHits?: (hits: readonly CoreSearchProjectionHit[]) => readonly CoreSearchProjectionHit[];
  readonly unavailableIndex?: boolean;
  readonly unavailableOwner?: boolean;
  readonly withoutIndex?: boolean;
}) {
  const store = makeInMemoryCoreSearchProjectionStore();
  for (const document of yield* buildSearchDocuments({
    companies: [{ legalEntityId: leaseSearchCompanyId, state: input.indexed ?? leaseSearchState([resourceId]) }],
    projectionVersion: '1',
    tenantId: leaseSearchTenantId,
  })) {
    yield* store.apply({ document, kind: 'upsert' }, worker);
  }
  const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
  const predicate = input.predicate ?? { groups: [] };
  const gate = makeTestBoundAccessGate({
    answers: { 'property.leasing.search-leases.read': { outcome: input.outcome ?? 'ALLOWED', predicate } },
    defaultAnswer: { outcome: 'DENIED' },
  });
  let ownerReads = 0;
  let indexReads = 0;
  const harness = yield* makeReadTestHarness({
    accessDecision: gate.bound,
    executeOwnerQuery: ({ params, scope: installed, sql }) => {
      expect(installed).toEqual({ legalEntityId: leaseSearchCompanyId, tenantId: leaseSearchTenantId });
      expect(sql).toContain('"property_leasing"."state"');
      expect(sql).toContain('"tenant_id" =');
      expect(sql).toContain('"legal_entity_id" =');
      expect(params).toEqual([leaseSearchTenantId, leaseSearchCompanyId, 1]);
      ownerReads += 1;
      if (input.unavailableOwner === true) {
        return Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'Controlled owner outage' }) }));
      }
      return Effect.succeed([
        {
          legalEntityId: leaseSearchCompanyId,
          revision: input.revision ?? 2,
          snapshot: Schema.encodeSync(OccupancyStateSchema)(input.current),
          tenantId: leaseSearchTenantId,
        },
      ]);
    },
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-01T09:00:00Z')),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: propertyLeasingRegistration,
    scope,
  });
  const operation = harness.runtime.runRead({
    input: { query: input.query ?? 'najem' },
    principal: scope,
    registration: leasesRead,
    transport: { correlationId: scope.correlationId },
  });
  const configured =
    input.withoutIndex === true
      ? operation
      : operation.pipe(
          Effect.provideService(CoreSearchQueryRuntime, {
            search: (query, requester, authorization) =>
              Effect.gen(function* historicalIndexMustNotRun() {
                indexReads += 1;
                if (input.unavailableIndex === true) {
                  return yield* new CoreSearchProjectionUnavailable({
                    code: 'core_search_projection_unavailable',
                    reason: 'Controlled index outage',
                  });
                }
                const hits = yield* runtime.search(query, requester, authorization);
                return input.transformHits === undefined ? hits : input.transformHits(hits);
              }),
          }),
        );
  const exit = yield* Effect.exit(configured);
  const { statements } = harness.snapshot();
  expect(statements.filter((statement) => /^begin/iu.test(statement))).toHaveLength(
    statements.filter((statement) => /^(?:commit|rollback)/iu.test(statement)).length,
  );
  return { exit, indexReads, ownerReads, snapshot: harness.snapshot() };
});

it.layer(NodeCrypto.layer)('current owner Lease search', (suite) => {
  suite.effect('current new text returns identical results with an old, empty, unavailable or absent index', () =>
    Effect.gen(function* currentTextWithoutProjectionRefresh() {
      const current = yield* Schema.decodeUnknownEffect(OccupancyStateSchema)({
        occupancies: leaseSearchState([resourceId]).occupancies.map((record) => ({
          ...record,
          startDate: '2028-01-01',
        })),
      });
      for (const index of [
        { indexed: leaseSearchState([resourceId]) },
        { indexed: leaseSearchState([]) },
        { unavailableIndex: true },
        { withoutIndex: true },
      ] as const) {
        const result = yield* run({ ...index, current, query: '2028-01-01' });
        expect(result.exit).toEqual(
          Exit.succeed([
            {
              ref: current.occupancies[0]?.occupancyRef,
              relevance: { score: 100, version: '1' },
              selectedLegalEntityId: leaseSearchCompanyId,
              title: `Nájem od 1. 1. 2028 na dobu neurčitou · Aktivní · ${resourceId}`,
            },
          ]),
        );
        expect(result.ownerReads).toBe(1);
        expect(result.indexReads).toBe(0);
      }
    }).pipe(Effect.scoped),
  );
  suite.effect('an actual owner SQL outage stays unavailable rather than falling back to an indexed lease', () =>
    Effect.gen(function* currentOwnerUnavailable() {
      const result = yield* run({ current: leaseSearchState([resourceId]), unavailableOwner: true });
      expect(
        Exit.isFailure(result.exit) &&
          Option.exists(Cause.findErrorOption(result.exit.cause), Schema.is(ReadHandlerUnavailable)),
      ).toBe(true);
      expect(result.ownerReads).toBe(1);
      expect(result.indexReads).toBe(0);
    }).pipe(Effect.scoped),
  );
  suite.effect('uses actual owner revision zero without fabricating a positive worker projection generation', () =>
    Effect.gen(function* ownerRevisionIsNotProjectionGeneration() {
      const result = yield* run({ current: leaseSearchState([resourceId]), revision: 0 });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      if (Exit.isSuccess(result.exit)) {
        expect(result.exit.value.map(({ ref }) => ref.resourceId)).toEqual([resourceId]);
      }
      expect(result.ownerReads).toBe(1);
      expect(result.indexReads).toBe(0);
    }).pipe(Effect.scoped),
  );
  suite.effect('duplicate current owner identities fail before index work instead of choosing an arbitrary label', () =>
    Effect.gen(function* duplicateOwnerIdentity() {
      const current = leaseSearchState([resourceId, resourceId]);
      const result = yield* run({ current });
      expect(
        Exit.isFailure(result.exit) &&
          Option.exists(Cause.findErrorOption(result.exit.cause), Schema.is(ReadHandlerUnavailable)),
      ).toBe(true);
      expect(result.ownerReads).toBe(1);
      expect(result.indexReads).toBe(0);
    }).pipe(Effect.scoped),
  );
  for (const ineligible of [{ state: 'CANCELLED' }, { kind: 'SHORT_STAY' }] as const) {
    suite.effect(`mixed-eligibility duplicate identities fail closed: ${JSON.stringify(ineligible)}`, () =>
      Effect.gen(function* mixedEligibilityDuplicate() {
        for (const ineligibleIndex of [0, 1]) {
          const current = yield* Schema.decodeUnknownEffect(OccupancyStateSchema)({
            occupancies: leaseSearchState([resourceId, resourceId]).occupancies.map((record, index) =>
              index === ineligibleIndex ? { ...record, ...ineligible } : record,
            ),
          });
          const result = yield* run({ current });
          expect(
            Exit.isFailure(result.exit) &&
              Option.exists(Cause.findErrorOption(result.exit.cause), Schema.is(ReadHandlerUnavailable)),
          ).toBe(true);
          expect(result.ownerReads).toBe(1);
          expect(result.indexReads).toBe(0);
        }
      }).pipe(Effect.scoped),
    );
  }
  suite.effect('sorts and scores from current owner labels rather than the index order, titles or scores', () =>
    Effect.gen(function* currentRanking() {
      const secondId = '40000000-0000-4000-8000-000000000002';
      const indexed = leaseSearchState([resourceId, secondId]);
      const current = yield* Schema.decodeUnknownEffect(OccupancyStateSchema)({
        occupancies: indexed.occupancies.map((record, index) => ({
          ...record,
          endDate: index === 0 ? '2027-01-01' : null,
          startDate: index === 0 ? '2026-11-02' : '2026-01-01',
        })),
      });
      const result = yield* run({
        current,
        indexed,
        query: 'najem od 1.',
        transformHits: (hits) =>
          hits.map((hit, index) => ({
            ...hit,
            relevance: { score: index === 0 ? 1000 : 0, version: '1' },
            title: index === 0 ? 'A STALE LABEL' : 'Z STALE LABEL',
          })),
      });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      if (Exit.isSuccess(result.exit)) {
        expect(
          result.exit.value.map(({ ref, relevance, title }) => ({ id: ref.resourceId, relevance, title })),
        ).toEqual([
          {
            id: secondId,
            relevance: { score: 800, version: '1' },
            title: `Nájem od 1. 1. 2026 na dobu neurčitou · Aktivní · ${secondId}`,
          },
          {
            id: resourceId,
            relevance: { score: 600, version: '1' },
            title: `Nájem od 2. 11. 2026 do 1. 1. 2027 · Aktivní · ${resourceId}`,
          },
        ]);
      }
    }).pipe(Effect.scoped),
  );

  suite.effect('keeps full AND/OR and RecordKeyIn semantics while an unsupported owner dimension remains false', () =>
    Effect.gen(function* fullPredicate() {
      const secondId = '40000000-0000-4000-8000-000000000002';
      const thirdId = '40000000-0000-4000-8000-000000000003';
      const predicate: ListAccessPredicate = {
        groups: [
          {
            clauses: [
              {
                conditions: [
                  {
                    _tag: 'AssignedTo',
                    holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(scope.principalId) },
                  },
                ],
              },
              {
                conditions: [
                  {
                    _tag: 'RecordKeyIn',
                    recordKeys: [RecordKeySchema.make(resourceId), RecordKeySchema.make(secondId)],
                  },
                ],
              },
            ],
          },
          {
            clauses: [
              {
                conditions: [
                  {
                    _tag: 'RecordKeyIn',
                    recordKeys: [RecordKeySchema.make(resourceId), RecordKeySchema.make(secondId)],
                  },
                  { _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(secondId), RecordKeySchema.make(thirdId)] },
                ],
              },
            ],
          },
        ],
      };
      const state = leaseSearchState([resourceId, secondId, thirdId]);
      const result = yield* run({ current: state, indexed: state, predicate });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      if (Exit.isSuccess(result.exit)) {
        expect(result.exit.value.map(({ ref }) => ref.resourceId)).toEqual([secondId]);
      }
      expect(result.indexReads).toBe(0);
    }).pipe(Effect.scoped),
  );

  suite.effect('missing, malformed or undeclared field restrictions fail before owner and index work', () =>
    Effect.gen(function* fieldAuthority() {
      for (const paths of [undefined, [['title']], [['title', 22]]]) {
        const context = {
          listAccess: { groups: [] },
          readKey: leasesRead.descriptor.readKey,
          scope,
          services: {
            load: () => Effect.die('Invalid field authority must not load owner state'),
            save: () => Effect.die('A search must never save owner state'),
          },
        };
        if (paths !== undefined) {
          Reflect.set(context, 'deniedFieldPaths', paths);
        }
        const failure = yield* getReadHandler(leasesRead)({ query: 'najem' }, context).pipe(
          Effect.provideService(CoreSearchQueryRuntime, {
            search: () => Effect.die('Invalid field authority must not read the index'),
          }),
          Effect.flip,
        );
        expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
      }
    }),
  );

  suite.effect(
    'the registered Lease Read hides a currently CANCELLED lease while its unchanged index still matches',
    () =>
      Effect.gen(function* cancelledWithoutProjectionRefresh() {
        const original = leaseSearchState([resourceId]);
        const current = yield* Schema.decodeUnknownEffect(OccupancyStateSchema)({
          occupancies: original.occupancies.map((record) => ({ ...record, state: 'CANCELLED' })),
        });
        const result = yield* run({ current });
        expect(result.exit).toEqual(Exit.succeed([]));
        expect(result.ownerReads).toBe(1);
        expect(result.indexReads).toBe(0);
      }).pipe(Effect.scoped),
  );

  suite.effect(
    'a current deletion or change to SHORT_STAY hides the unchanged indexed lease without any index read',
    () =>
      Effect.gen(function* withdrawals() {
        const original = leaseSearchState([resourceId]);
        for (const current of [
          { occupancies: [] },
          {
            occupancies: original.occupancies.map((record) => ({
              ...record,
              endDate: '2026-12-01',
              kind: 'SHORT_STAY' as const,
            })),
          },
        ]) {
          const result = yield* run({ current: yield* Schema.decodeUnknownEffect(OccupancyStateSchema)(current) });
          expect(result.exit).toEqual(Exit.succeed([]));
          expect(result.ownerReads).toBe(1);
          expect(result.indexReads).toBe(0);
        }
      }).pipe(Effect.scoped),
  );

  suite.effect(
    'current dates and lifecycle remove stale text matches before index work while preserving completed history',
    () =>
      Effect.gen(function* changedOwnerText() {
        const current = yield* Schema.decodeUnknownEffect(OccupancyStateSchema)({
          occupancies: leaseSearchState([resourceId]).occupancies.map((record) => ({
            ...record,
            endDate: '2028-12-31',
            startDate: '2028-01-01',
            state: 'COMPLETED',
          })),
        });
        for (const query of ['2026-11-01', 'aktivni']) {
          const result = yield* run({ current, query });
          expect(result.exit).toEqual(Exit.succeed([]));
          expect(result.indexReads).toBe(0);
        }
        const result = yield* run({
          current,
          transformHits: (hits) =>
            hits.map((hit) => ({
              ...hit,
              archived: true,
              relevance: { score: 0, version: '1' },
              title: 'PRIVATE STALE INDEX TITLE',
            })),
        });
        expect(result.exit).toEqual(
          Exit.succeed([
            {
              ref: current.occupancies[0]?.occupancyRef,
              relevance: { score: 800, version: '1' },
              selectedLegalEntityId: leaseSearchCompanyId,
              title: `Nájem od 1. 1. 2028 do 31. 12. 2028 · Ukončený · ${resourceId}`,
            },
          ]),
        );
        expect(result.indexReads).toBe(0);
      }).pipe(Effect.scoped),
  );

  suite.effect(
    'applies the original AND/OR LIST predicate to current records without a historical candidate budget',
    () =>
      Effect.gen(function* currentReachBeforeBudget() {
        const ids = Array.from(
          { length: 300 },
          (_, index) => `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        );
        const indexed = leaseSearchState(ids);
        const retained = ids.at(-1);
        const excluded = ids.at(-2);
        const predicate: ListAccessPredicate = {
          groups: [
            {
              clauses: [
                {
                  conditions: [
                    {
                      _tag: 'RecordKeyIn',
                      recordKeys: yield* Schema.decodeUnknownEffect(Schema.NonEmptyArray(RecordKeySchema))([
                        retained,
                        excluded,
                      ]),
                    },
                  ],
                },
              ],
            },
            { clauses: [{ conditions: [{ _tag: 'AllInScope' }] }] },
          ],
        };
        const result = yield* run({ current: leaseSearchState(ids.slice(-1)), indexed, predicate });
        expect(Exit.isSuccess(result.exit)).toBe(true);
        if (Exit.isSuccess(result.exit)) {
          expect(result.exit.value.map(({ ref }) => ref.resourceId)).toEqual([retained]);
        }
        expect(result.indexReads).toBe(0);
      }).pipe(Effect.scoped),
  );

  for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
    suite.effect(`the registered current-owner search ${outcome} observes neither owner SQL nor the index`, () =>
      Effect.gen(function* deniedCurrentSearch() {
        const result = yield* run({ current: leaseSearchState([resourceId]), outcome });
        expect(
          Exit.isFailure(result.exit) &&
            Option.exists(
              Cause.findErrorOption(result.exit.cause),
              Schema.is(outcome === 'DENIED' ? ReadPermissionDenied : ReadPermissionUnavailable),
            ),
        ).toBe(true);
        expect(result.ownerReads).toBe(0);
        expect(result.indexReads).toBe(0);
        expect(result.snapshot.ownerQueries).toEqual([]);
      }).pipe(Effect.scoped),
    );
  }

  suite.effect('refuses cross-tenant current owner references even when the lease would otherwise be ineligible', () =>
    Effect.gen(function* foreignCurrentOwner() {
      const current = yield* Schema.decodeUnknownEffect(OccupancyStateSchema)({
        occupancies: leaseSearchState([resourceId]).occupancies.map((record) => ({
          ...record,
          occupancyRef: { ...record.occupancyRef, tenantId: '10000000-0000-4000-8000-000000000002' },
          state: 'CANCELLED',
        })),
      });
      const result = yield* run({ current });
      expect(
        Exit.isFailure(result.exit) &&
          Option.exists(Cause.findErrorOption(result.exit.cause), Schema.is(ReadHandlerUnavailable)),
      ).toBe(true);
      expect(result.ownerReads).toBe(1);
      expect(result.indexReads).toBe(0);
    }).pipe(Effect.scoped),
  );
});
