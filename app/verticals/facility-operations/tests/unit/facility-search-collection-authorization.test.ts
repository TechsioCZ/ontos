import { ReadHandlerUnavailable, ReadPermissionDenied, ReadPermissionUnavailable } from '@app/core-runtime';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { parseFacilitySearchPredicate } from '../../src/search/record-access.ts';
import { company } from './facility-search-fixtures.ts';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { runFacilitySearchScenario } from './facility-search-harness.ts';

const targets = (first: string, ...keys: string[]): ListAccessPredicate => ({
  groups: [
    {
      clauses: [
        {
          conditions: [
            {
              _tag: 'RecordKeyIn',
              recordKeys: [RecordKeySchema.make(first), ...keys.map((key) => RecordKeySchema.make(key))],
            },
          ],
        },
      ],
    },
  ],
});
it.layer(NodeCrypto.layer)('canonical Facility search reach', (suite) => {
  for (const resource of ['asset', 'device', 'document', 'meter'] as const) {
    suite.effect(
      `${resource}: filters a denied first candidate without losing later permitted rows or relevance in owner SQL`,
      () =>
        Effect.gen(function* partial() {
          const predicate = targets(`${company}.${resource}-1`, `${company}.${resource}-2`);
          const outcome = yield* runFacilitySearchScenario(resource, { predicate });
          expect(Exit.isSuccess(outcome.exit), JSON.stringify(outcome.exit)).toBe(true);
          if (Exit.isSuccess(outcome.exit)) {
            expect(outcome.exit.value.map((hit) => [hit.ref.resourceId, hit.relevance])).toEqual(
              outcome.hits.slice(1).map((hit) => [hit.ref.resourceId, hit.relevance]),
            );
          }
          expect(outcome.snapshot.ownerQueries).toHaveLength(1);
          expect(outcome.snapshot.ownerQueries[0]?.sql).toContain(' in (');
          expect(outcome.snapshot.ownerQueries[0]?.params).toContain(`${company}.${resource}-1`);
          expect(outcome.snapshot.evidenceWrites).toBe(1);
        }),
    );
    suite.effect(`${resource}: hidden-only and nonexistent matches return the same admitted empty success`, () =>
      Effect.gen(function* empty() {
        const hidden = yield* runFacilitySearchScenario(resource, { predicate: targets('foreign-company.hidden') });
        const missing = yield* runFacilitySearchScenario(resource, { candidateCount: 0 });
        expect(hidden.exit).toEqual(Exit.succeed([]));
        expect(missing.exit).toEqual(hidden.exit);
        expect(hidden.snapshot.evidenceWrites).toBe(1);
        expect(missing.snapshot.evidenceWrites).toBe(1);
      }),
    );
    suite.effect(`${resource}: preserves the full ordered result without a candidate limit`, () =>
      Effect.gen(function* full() {
        const outcome = yield* runFacilitySearchScenario(resource, { candidateCount: 201 });
        expect(Exit.isSuccess(outcome.exit), JSON.stringify(outcome.exit)).toBe(true);
        if (Exit.isSuccess(outcome.exit)) {
          expect(outcome.exit.value.map((hit) => hit.ref.resourceId)).toEqual(
            outcome.hits.map((hit) => hit.ref.resourceId),
          );
        }
      }),
    );
    suite.effect(`${resource}: unavailable, missing and malformed predicates fail closed, never ALL`, () =>
      Effect.gen(function* uncertain() {
        for (const malformed of [
          { groups: [{ clauses: [] }] },
          { groups: [{ clauses: [{ conditions: [] }] }] },
          { groups: [{ clauses: [{ conditions: [{ _tag: 'foreign' }] }] }] },
          { groups: [], unsupportedRestriction: true },
          { groups: [{ clauses: [{ conditions: [{ _tag: 'AllInScope', unsupportedRestriction: true }] }] }] },
        ]) {
          const failure = yield* parseFacilitySearchPredicate(malformed).pipe(Effect.flip);
          expect(Schema.isSchemaError(failure)).toBe(true);
        }

        for (const options of [{ listOutcome: 'UNAVAILABLE' }, { missingPredicate: true }] as const) {
          const outcome = yield* runFacilitySearchScenario(resource, options);
          expect(Exit.isFailure(outcome.exit)).toBe(true);
          if (Exit.isFailure(outcome.exit)) {
            const failure = Option.getOrUndefined(Cause.findErrorOption(outcome.exit.cause));
            expect(Schema.is(ReadPermissionUnavailable)(failure) || Schema.is(ReadPermissionDenied)(failure)).toBe(
              true,
            );
          }
          expect(outcome.searched).toBe(false);
          expect(outcome.snapshot.ownerQueries).toEqual([]);
        }
      }),
    );
    suite.effect(`${resource}: canonical list denial and scope admission precede owner SQL and remote search`, () =>
      Effect.gen(function* denied() {
        const outcome = yield* runFacilitySearchScenario(resource, { listOutcome: 'DENIED' });
        expect(Exit.isFailure(outcome.exit)).toBe(true);
        expect(outcome.searched).toBe(false);
        expect(outcome.snapshot.ownerQueries).toEqual([]);
        expect(outcome.gate.askedLists[0]?.carrier.accessDeclaration?.key).toBe(
          `facility.operations.search-${{ asset: 'assets', device: 'devices', document: 'documents', meter: 'meters' }[resource]}.read`,
        );
        expect(outcome.gate.askedDecisions).toEqual([]);
        const scopeDenied = yield* runFacilitySearchScenario(resource, { scopeAccess: 'denied' });
        expect(Exit.isFailure(scopeDenied.exit)).toBe(true);
        expect(scopeDenied.searched).toBe(false);
        expect(scopeDenied.snapshot.ownerQueries).toEqual([]);
      }),
    );
    suite.effect(`${resource}: foreign source scope cannot hide behind denied record reach`, () =>
      Effect.gen(function* foreign() {
        for (const options of [{ foreignCompany: true }, { foreignOwnerRow: true }] as const) {
          const outcome = yield* runFacilitySearchScenario(resource, { ...options, predicate: targets('hidden') });
          expect(Exit.isFailure(outcome.exit)).toBe(true);
          if (Exit.isFailure(outcome.exit)) {
            expect(
              Schema.is(ReadHandlerUnavailable)(Option.getOrUndefined(Cause.findErrorOption(outcome.exit.cause))),
            ).toBe(true);
          }
          expect(outcome.snapshot.evidenceWrites).toBe(0);
        }
      }),
    );
    suite.effect(
      `${resource}: all AND/OR restrictions intersect and unsupported holder facts never grant records`,
      () =>
        Effect.gen(function* intersections() {
          const first = `${company}.${resource}-0`;
          const second = `${company}.${resource}-1`;
          const predicate: ListAccessPredicate = {
            groups: [
              {
                clauses: [
                  { conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(first)] }] },
                  { conditions: [{ _tag: 'RecordKeyIn', recordKeys: [RecordKeySchema.make(second)] }] },
                ],
              },
              ...targets(second).groups,
            ],
          };
          const outcome = yield* runFacilitySearchScenario(resource, { predicate });
          expect(Exit.isSuccess(outcome.exit), JSON.stringify(outcome.exit)).toBe(true);
          if (Exit.isSuccess(outcome.exit)) {
            expect(outcome.exit.value.map((hit) => hit.ref.resourceId)).toEqual([second]);
          }
          const unsupported = yield* runFacilitySearchScenario(resource, {
            predicate: {
              groups: [
                {
                  clauses: [
                    {
                      conditions: [
                        {
                          _tag: 'AssignedTo',
                          holder: {
                            _tag: 'Principal',
                            principalId: PrincipalIdSchema.make('30000000-0000-4000-8000-000000000099'),
                          },
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
  }
});
