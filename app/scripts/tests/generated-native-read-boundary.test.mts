import { expect, it } from 'effect-rstest';

import {
  hasOwnerLocalReadFinishFactoryResult,
  hasOwnerLocalReadServiceFactory,
} from '../generated-governed-http-boundary.mts';

const owner = 'verticals/native-owner';
const readFile = `${owner}/src/api/lookup.read.ts`;
const dependencyFile = `${owner}/src/services/lookup.ts`;
const defaultFinish = 'makeFinish()';
const dependency = `import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { Effect } from 'effect';
type Transaction = Pick<Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0], 'invoke'>;
export const persistenceForScope = (
  transaction: Transaction,
  scope: OperationalScope,
): Effect.Effect<OwnerPersistence> => Effect.succeed({
  lookup: (input) => transaction.invoke(ownerRoutine, [input, scope.tenantId]),
});
export const loadOwner = (transaction, scope, revision) => Effect.succeed({ transaction, scope, revision });
`;
const read = `import type { ReadFinishContext } from '@app/core-runtime';
import { Effect } from 'effect';
import { persistenceForScope, loadOwner } from '../services/lookup.ts';
export const makeFinish = (
  load: typeof loadOwner = loadOwner,
) => Effect.fn('Owner.finish')(function* finish(input: Request, context: ReadFinishContext<Prepared, void>) {
  return yield* load(context.transaction, context.scope, context.prepared.revision);
});
`;
const sourcesFor = (readSource = read, dependencySource = dependency) =>
  new Map([
    [readFile, readSource],
    [dependencyFile, dependencySource],
  ]);
const acceptsFinish = (source = read, candidate = defaultFinish) =>
  hasOwnerLocalReadFinishFactoryResult(sourcesFor(source), readFile, owner, candidate);
const acceptsService = (source = dependency) =>
  hasOwnerLocalReadServiceFactory(sourcesFor(read, source), readFile, owner, 'persistenceForScope');

it('proves native scoped service factories and local finish makers with verified owner dependencies', () => {
  expect(acceptsService()).toBe(true);
  expect(acceptsFinish()).toBe(true);
  expect(acceptsFinish(read, 'makeFinish(loadOwner)')).toBe(true);
});

for (const [name, before, after] of [
  ['missing Core scope', 'scope: OperationalScope', 'scope: unknown'],
  ['foreign Core types', "'@app/core-runtime'", "'@app/foreign-runtime'"],
  ['foreign Effect', "'effect'", "'./fake-effect.ts'"],
  [
    'raw transaction type',
    "type Transaction = Pick<Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0], 'invoke'>;",
    'type Transaction = unknown;',
  ],
  ['widened transaction access', "'invoke'", "'query'"],
  ['untyped return', ': Effect.Effect<OwnerPersistence>', ': unknown'],
  ['non-Effect output', 'Effect.succeed({', 'Promise.resolve({'],
  ['non-exported service', 'export const persistenceForScope', 'const persistenceForScope'],
] as const) {
  it(`rejects a scoped service factory with ${name}`, () => {
    expect(acceptsService(dependency.replace(before, after))).toBe(false);
  });
}

for (const [name, before, after] of [
  ['missing Core context', 'ReadFinishContext<Prepared, void>', 'unknown'],
  ['foreign Core context', "'@app/core-runtime'", "'@app/foreign-runtime'"],
  ['foreign Effect', "'effect'", "'./fake-effect.ts'"],
  ['arbitrary return', "Effect.fn('Owner.finish')", 'fakeFactory'],
  ['untyped dependency', 'load: typeof loadOwner', 'load: unknown'],
  ['mismatched dependency default', 'loadOwner = loadOwner', 'loadOwner = otherOwner'],
  ['private cross-owner import', "'../services/lookup.ts'", "'../../../foreign-owner/src/services/lookup.ts'"],
] as const) {
  it(`rejects a finish maker with ${name}`, () => {
    expect(acceptsFinish(read.replace(before, after))).toBe(false);
  });
}

for (const candidate of [
  'makeFinish',
  'makeFinish(untrusted)',
  'makeFinish(loadOwner, loadOwner)',
  'makeFinish() || fake',
  'makeFinish() as Callback',
]) {
  it(`rejects an unproven finish expression ${candidate}`, () => {
    expect(acceptsFinish(read, candidate)).toBe(false);
  });
}

it('rejects absent, noncallable, shadowed, or mutated owner dependencies', () => {
  expect(hasOwnerLocalReadFinishFactoryResult(new Map([[readFile, read]]), readFile, owner, defaultFinish)).toBe(false);
  for (const replacement of [
    'export const other =',
    'const loadOwner =',
    'export const loadOwner = null; const decoy =',
  ]) {
    const sources = sourcesFor(read, dependency.replace('export const loadOwner =', replacement));
    expect(hasOwnerLocalReadFinishFactoryResult(sources, readFile, owner, defaultFinish)).toBe(false);
  }
  for (const suffix of [
    '\nloadOwner = fake;',
    '\nmakeFinish = fake;',
    '\nconst Effect = fake;',
    '\nconst alias = makeFinish;',
    '\nfunction decoy(Effect) {}',
    '\nfunction decoy(loadOwner) {}',
  ]) {
    expect(acceptsFinish(read + suffix), suffix).toBe(false);
  }
  expect(acceptsService(`${dependency}\npersistenceForScope = fake;`)).toBe(false);
  expect(acceptsService(`${dependency}\nconst Effect = fake;`)).toBe(false);
});
