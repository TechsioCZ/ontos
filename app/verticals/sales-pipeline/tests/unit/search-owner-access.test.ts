import {
  ContextAccess,
  CoreSearchProjectionHitSchema,
  CoreSearchQueryRuntime,
  ReadPermissionDenied,
  ReadHandlerUnavailable,
} from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { opportunitiesRead } from '../../src/search/opportunities.provider.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { parsePipelineSearchPredicate } from '../../src/services/search-record-access.ts';
import { salesPipelineRegistration } from '../../vertical.registration.ts';
import { company, scope } from './search-fixtures.ts';

const principal = {
  ...scope,
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:pipeline-search-owner',
  authMethod: 'session' as const,
};
const first = '60000000-0000-4000-8000-000000000001';
const second = '60000000-0000-4000-8000-000000000002';
const third = '60000000-0000-4000-8000-000000000003';
const base = {
  amountMinor: 500,
  currency: 'CZK',
  expectedCloseDate: '2026-12-31',
  stage: 'LEAD',
  title: 'Deal current',
};
const records = [
  { ...base, entrustedPrincipalRef: { principalId: scope.principalId, tenantId: scope.tenantId }, id: first },
  {
    ...base,
    entrustedPrincipalRef: { principalId: '30000000-0000-4000-8000-000000000099', tenantId: scope.tenantId },
    id: second,
  },
  { ...base, id: third },
];
const entrusted: ListAccessPredicate = {
  groups: [
    {
      clauses: [
        {
          conditions: [
            {
              _tag: 'EntrustedTo',
              holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(scope.principalId) },
            },
          ],
        },
      ],
    },
  ],
};
const targets = (firstKey: string, ...rest: string[]): ListAccessPredicate => ({
  groups: [
    {
      clauses: [
        {
          conditions: [
            {
              _tag: 'RecordKeyIn',
              recordKeys: [RecordKeySchema.make(firstKey), ...rest.map((key) => RecordKeySchema.make(key))],
            },
          ],
        },
      ],
    },
  ],
});
interface Scenario {
  readonly admission?: 'allowed' | 'denied' | 'unavailable';
  readonly archiveFirst?: boolean;
  readonly foreignCompany?: boolean;
  readonly missingPredicate?: boolean;
  readonly outcome?: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE';
  readonly predicate?: ListAccessPredicate;
  readonly renamed?: boolean;
}
const runScenario = (options: Scenario = {}) =>
  Effect.scoped(
    Effect.gen(function* run() {
      const gate = makeTestAccessDecision({
        answers: {
          'demo.sales-pipeline.api-records.read': {
            outcome: options.outcome ?? 'ALLOWED',
            predicate: options.predicate ?? { groups: [] },
          },
        },
      });
      const ownerGate =
        options.missingPredicate === true
          ? {
              ...gate,
              list: (question: Parameters<typeof gate.list>[0]) =>
                gate.list(question).pipe(Effect.map(({ decision }) => ({ decision }))),
            }
          : gate;
      const harness = yield* makeReadTestHarness({
        access: options.admission ?? 'allowed',
        compositionRevision: 'a'.repeat(64),
        executeOwnerQuery: ({ params, scope: queryScope, sql }) => {
          expect(queryScope).toEqual({ legalEntityId: company, tenantId: scope.tenantId });
          expect(sql).toContain('jsonb_array_elements');
          expect(sql).toContain('"demo_sales_pipeline"."sales_pipeline_states"');
          expect(sql).not.toMatch(/note|stageHistory|lines/u);
          expect(params).toContain(scope.tenantId);
          expect(params).toContain(company);
          return Effect.succeed([
            {
              legalEntityId: options.foreignCompany === true ? '30000000-0000-4000-8000-000000000099' : company,
              records: records.map((record, index) => {
                if (index !== 0) {
                  return record;
                }
                const current = { ...record, title: options.renamed === true ? 'Withdrawn title' : record.title };
                return options.archiveFirst === true ? { ...current, archivedAt: '2026-11-01T00:00:00Z' } : current;
              }),
              tenantId: scope.tenantId,
            },
          ]);
        },
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T00:00:00Z')),
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: salesPipelineRegistration,
        scope: principal,
      });
      const services = yield* Layer.build(harness.layer);
      Object.assign(Context.get(services, ContextAccess), {
        contextPermissions: () => Effect.die('Retired permissions invoked'),
        modules: () => Effect.die('Retired modules invoked'),
        resources: () => Effect.die('Retired resource authority was invoked'),
      });
      let searches = 0;
      const hits = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(
        records.map((record) => ({
          archived: false,
          facets: [],
          metadata: [],
          ref: {
            moduleId: 'demo.sales-pipeline',
            resourceId: record.id,
            resourceType: 'demo.sales-pipeline.opportunity',
            tenantId: scope.tenantId,
          },
          relevance: { score: 1000, version: '1' },
          selectedLegalEntityId: company,
          title: 'Deal stale',
        })),
      );
      const exit = yield* harness.runtime
        .runRead({
          input: { query: 'deal' },
          principal,
          registration: opportunitiesRead,
          transport: { correlationId: scope.correlationId },
        })
        .pipe(
          Effect.provideService(AccessDecisionGate, ownerGate),
          Effect.provideService(CoreSearchQueryRuntime, {
            search: () =>
              Effect.sync(() => {
                searches += 1;
                expect(harness.snapshot().statements.join('\n')).toMatch(/commit/iu);
                return hits;
              }),
          }),
          Effect.exit,
        );
      return { exit, gate, searches, snapshot: harness.snapshot() };
    }),
  );
it.layer(NodeCrypto.layer)('registered Pipeline search owner reach', (suite) => {
  suite.effect(
    'scope-wide search admits only canonical entrusted owner records and private facts never leave owner SQL',
    () =>
      Effect.gen(function* entrustedSearch() {
        const result = yield* runScenario({ predicate: entrusted });
        expect(Exit.isSuccess(result.exit)).toBe(true);
        if (Exit.isSuccess(result.exit)) {
          expect(result.exit.value.map((hit) => [hit.ref.resourceId, hit.title])).toEqual([[first, 'Deal current']]);
        }
        expect(result.gate.askedLists).toHaveLength(1);
        expect(result.gate.askedLists[0]?.carrier.accessDeclaration?.key).toBe('demo.sales-pipeline.api-records.read');
        expect(result.gate.askedLists[0]?.carrier).toBe(recordsRead.descriptor);
        expect(result.gate.askedDecisions).toEqual([]);
        expect(result.snapshot.ownerQueries[0]?.sql).toContain('entrustedPrincipalRef');
        expect(result.snapshot.ownerQueries[0]?.params).toContain(scope.principalId);
      }),
  );
  suite.effect('full AND/OR plus exact targets intersect canonical record reach', () =>
    Effect.gen(function* intersect() {
      for (const [predicate, expected] of [
        [{ groups: [...entrusted.groups, ...targets(first, second).groups] }, [first]],
        [{ groups: [...entrusted.groups, ...targets(second).groups] }, []],
        [
          {
            groups: [
              {
                clauses: [
                  { conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(first)] }] },
                  { conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(second)] }] },
                ],
              },
              ...targets(second).groups,
            ],
          },
          [second],
        ],
      ] as const) {
        const result = yield* runScenario({ predicate });
        expect(Exit.isSuccess(result.exit)).toBe(true);
        if (Exit.isSuccess(result.exit)) {
          expect(result.exit.value.map((hit) => hit.ref.resourceId)).toEqual(expected);
        }
        expect(result.snapshot.ownerQueries[0]?.sql).toContain(' in (');
      }
    }),
  );
  suite.effect('both admission and owner LIST denial/unavailability stop owner SQL and index observation', () =>
    Effect.gen(function* deny() {
      for (const admission of ['denied', 'unavailable'] as const) {
        const result = yield* runScenario({ admission });
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.snapshot.ownerQueries).toEqual([]);
        expect(result.searches).toBe(0);
      }
      for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
        const result = yield* runScenario({ outcome });
        expect(Exit.isFailure(result.exit)).toBe(true);
        expect(result.snapshot.ownerQueries).toEqual([]);
        expect(result.searches).toBe(0);
        if (Exit.isFailure(result.exit)) {
          const failure = Option.getOrUndefined(Cause.findErrorOption(result.exit.cause));
          expect(
            outcome === 'DENIED'
              ? Schema.is(ReadPermissionDenied)(failure)
              : Schema.is(ReadHandlerUnavailable)(failure),
          ).toBe(true);
        }
      }
    }),
  );
  suite.effect('missing/malformed/unsupported predicates never widen into an all-record fallback', () =>
    Effect.gen(function* malformed() {
      const missing = yield* runScenario({ missingPredicate: true });
      expect(Exit.isFailure(missing.exit)).toBe(true);
      expect(missing.snapshot.ownerQueries).toEqual([]);
      for (const invalid of [
        { groups: [{ clauses: [] }] },
        { groups: [{ clauses: [{ conditions: [] }] }] },
        { extra: true, groups: [] },
      ]) {
        expect(Schema.isSchemaError(yield* parsePipelineSearchPredicate(invalid).pipe(Effect.flip))).toBe(true);
      }
      const unsupported = yield* runScenario({
        predicate: {
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
              ],
            },
          ],
        },
      });
      expect(unsupported.exit).toEqual(Exit.succeed([]));
      expect(unsupported.snapshot.ownerQueries[0]?.sql).toContain('false');
    }),
  );
  suite.effect('current owner archive and rematch suppress stale index evidence; foreign owner rows fail closed', () =>
    Effect.gen(function* current() {
      for (const option of [{ archiveFirst: true }, { renamed: true }]) {
        const result = yield* runScenario({ ...option, predicate: targets(first) });
        expect(result.exit).toEqual(Exit.succeed([]));
      }
      const foreign = yield* runScenario({ foreignCompany: true });
      expect(Exit.isFailure(foreign.exit)).toBe(true);
      expect(foreign.searches).toBe(0);
    }),
  );
});
