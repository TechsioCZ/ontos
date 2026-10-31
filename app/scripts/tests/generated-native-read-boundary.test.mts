import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

import {
  hasOwnerLocalReadFinishFactoryResult,
  hasOwnerLocalReadServiceFactory,
} from '../generated-governed-http-boundary.mts';

const owner = 'verticals/native-owner';
const readFile = `${owner}/src/api/lookup.read.ts`;
const dependencyFile = `${owner}/src/services/lookup.ts`;
const defaultFinish = 'makeFinish()';
const nativeCoreSpecifier = "'@app/core-runtime'";
const foreignCoreSpecifier = "'@app/foreign-runtime'";
const foreignEffectSpecifier = "'./fake-effect.ts'";
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

const scopedTransaction = 'Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0]';
const derivedDependency = dependency.replace(`Pick<${scopedTransaction}, 'invoke'>`, scopedTransaction);
const blockFactory = derivedDependency.replace(
  `=> Effect.succeed({
  lookup: (input) => transaction.invoke(ownerRoutine, [input, scope.tenantId]),
});`,
  `=> {
  const lookup = (input) => transaction.invoke(ownerRoutine, [input, scope.tenantId]);
  return Effect.succeed({ lookup });
};`,
);
const conditionalFactory = derivedDependency.replace(
  `=> Effect.succeed({
  lookup: (input) => transaction.invoke(ownerRoutine, [input, scope.tenantId]),
});`,
  `=> {
  const { legalEntityId, tenantId } = scope;
  return legalEntityId === undefined
    ? Effect.fail(scopeUnavailable())
    : makeRepository(transaction, { scope: { ...scope, legalEntityId, tenantId } }).pipe(
        Effect.map((repository) => OwnerRepository.of(repository)),
      );
};`,
);

it('proves native scoped service factories and local finish makers with verified owner dependencies', () => {
  expect(acceptsService()).toBe(true);
  expect(acceptsFinish()).toBe(true);
  expect(acceptsFinish(read, 'makeFinish(loadOwner)')).toBe(true);
});

it('proves the native Read transaction parameter with direct, block, and conditional Effect factory results', () => {
  for (const source of [derivedDependency, blockFactory, conditionalFactory]) {
    expect(acceptsService(source)).toBe(true);
  }
});

for (const [name, before, after] of [
  ['another transaction parameter', scopedTransaction, 'Parameters<ReadServiceFactory<OwnerPersistence>>[1]'],
  ['a raw transaction alias', scopedTransaction, 'RawDatabase'],
  ['an untrusted scope', 'scope: OperationalScope', 'scope: unknown'],
  ['a foreign Core type', nativeCoreSpecifier, foreignCoreSpecifier],
  ['a foreign Effect', "'effect'", foreignEffectSpecifier],
  ['an untyped result', ': Effect.Effect<OwnerPersistence>', ': unknown'],
  ['a non-Effect result', 'return Effect.succeed({ lookup });', 'return Promise.resolve({ lookup });'],
  ['a non-exported factory', 'export const persistenceForScope', 'const persistenceForScope'],
] as const) {
  it(`rejects a derived Read transaction factory with ${name}`, () => {
    const invalid = blockFactory.replace(before, after);
    expect(invalid).not.toBe(blockFactory);
    expect(acceptsService(invalid)).toBe(false);
  });
}

it('rejects mutated or shadowed native derived Read factory bindings', () => {
  for (const suffix of [
    '\npersistenceForScope = fake;',
    '\nfunction decoy(Effect) {}',
    '\nconst Effect = fake;',
    '\ntype Transaction = unknown;',
    '\ntype ReadServiceFactory = FakeFactory;',
    '\nconst alias = persistenceForScope;',
  ]) {
    expect(acceptsService(blockFactory + suffix), suffix).toBe(false);
  }
  for (const foreignOwner of ['foreign-owner', 'native-owner-foreign']) {
    const foreignPath = `../../../${foreignOwner}/src/services/lookup.ts`;
    const sources = sourcesFor(read.replace('../services/lookup.ts', foreignPath), blockFactory);
    sources.set(`verticals/${foreignOwner}/src/services/lookup.ts`, blockFactory);
    expect(hasOwnerLocalReadServiceFactory(sources, readFile, owner, 'persistenceForScope')).toBe(false);
  }
});

for (const [deployment, readStem, servicePath, factory] of [
  [
    'pricing',
    'commitment-confirmation-verification',
    'src/services/commitment-confirmation-persistence.service.ts',
    'commitmentConfirmationPersistenceForScope',
  ],
  [
    'privacy',
    'notice-presentation',
    'src/persistence/privacy-operation-postgres-repository.ts',
    'privacyOperationRepositoryForScope',
  ],
] as const) {
  it(`proves the actual ${deployment} load/finish Read service factory and rejects a forged transaction type`, () => {
    const ownerPath = `verticals/${deployment}`;
    const actualReadFile = `${ownerPath}/src/api/${readStem}.read.ts`;
    const actualServiceFile = `${ownerPath}/${servicePath}`;
    const actualRead = readFileSync(new URL(`../../${actualReadFile}`, import.meta.url), 'utf-8');
    const actualService = readFileSync(new URL(`../../${actualServiceFile}`, import.meta.url), 'utf-8');
    const sources = new Map([
      [actualReadFile, actualRead],
      [actualServiceFile, actualService],
    ]);
    expect(hasOwnerLocalReadServiceFactory(sources, actualReadFile, ownerPath, factory)).toBe(true);
    const invalid = actualService.replace(scopedTransaction, 'RawDatabase');
    expect(invalid).not.toBe(actualService);
    sources.set(actualServiceFile, invalid);
    expect(hasOwnerLocalReadServiceFactory(sources, actualReadFile, ownerPath, factory)).toBe(false);
  });
}

for (const [name, before, after] of [
  ['missing Core scope', 'scope: OperationalScope', 'scope: unknown'],
  ['foreign Core types', nativeCoreSpecifier, foreignCoreSpecifier],
  ['foreign Effect', "'effect'", foreignEffectSpecifier],
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
  ['foreign Core context', nativeCoreSpecifier, foreignCoreSpecifier],
  ['foreign Effect', "'effect'", foreignEffectSpecifier],
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
