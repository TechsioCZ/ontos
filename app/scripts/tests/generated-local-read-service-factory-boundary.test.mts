import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

import { hasOwnerLocalReadServiceFactoryResult } from '../generated-governed-http-boundary.mts';

const nativeTypeImport = "import type { ReadServiceFactory } from '@app/core-runtime';";
const nativeEffectImport = "import { Effect } from 'effect';";
const ownerImport = "import { loadOwner, ownerFence } from './owner-scope.ts';";
const ownerPath = 'verticals/fixture-owner';
const readFile = `${ownerPath}/src/api/owner.read.ts`;
const dependencyFile = `${ownerPath}/src/api/owner-scope.ts`;
const dependencySource = `${nativeEffectImport}
export const loadOwner = (transaction, scope, revision) => Effect.succeed({ transaction, scope, revision });
export const ownerFence = (transaction, scope, revision) => Effect.succeed({ transaction, scope, revision });
`;
const resultName = 'ownerReadServiceFactory';
const makerName = 'makeOwnerReadServiceFactory';
const sourceParameter = 'source: typeof loadOwner';
const makerParameters = `(
  ${sourceParameter},
  fence: typeof ownerFence = ownerFence,
)`;
const factoryCallback = `Effect.fn('Owner.Read.serviceFactory')(function* ownerReadServices(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  compositionRevision: string | undefined,
) {
  const sourceValue = yield* source(transaction, scope, compositionRevision);
  yield* fence(transaction, scope, compositionRevision);
  return sourceValue;
})`;
const makerDeclaration = `export const ${makerName} = ${makerParameters}: ReadServiceFactory<OwnerServices, OwnerRequirements> =>
  ${factoryCallback};`;
const resultDeclaration = `export const ${resultName} = ${makerName}(loadOwner);`;
const fixture = `${nativeTypeImport}
${nativeEffectImport}
${ownerImport}
${makerDeclaration}
${resultDeclaration}
`;
const sourcesFor = (source = fixture, dependency = dependencySource): ReadonlyMap<string, string> =>
  new Map([
    [readFile, source],
    [dependencyFile, dependency],
  ]);
const accepts = (source = fixture, candidate: string | undefined = resultName): boolean =>
  hasOwnerLocalReadServiceFactoryResult(sourcesFor(source), readFile, ownerPath, candidate);

it('accepts a directly registered local maker result with a genuine Core return annotation', () => {
  expect(accepts()).toBe(true);
});

it('accepts both the required-only and complete maker argument lists', () => {
  expect(accepts()).toBe(true);
  expect(accepts(fixture.replace(`${makerName}(loadOwner)`, `${makerName}(loadOwner, ownerFence)`))).toBe(true);
});

it('accepts an owner-private result binding without adding an export requirement', () => {
  expect(accepts(fixture.replace(resultDeclaration, resultDeclaration.replace('export const', 'const')))).toBe(true);
});

it('accepts a trailing comma without inventing another maker argument', () => {
  expect(accepts(fixture.replace(`${makerName}(loadOwner)`, `${makerName}(loadOwner,)`))).toBe(true);
});

it('accepts a native Effect.fn arrow callback', () => {
  const callback = `Effect.fn('Owner.Read.serviceFactory')((
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    compositionRevision: string | undefined,
  ) => source(transaction, scope, compositionRevision))`;
  expect(accepts(fixture.replace(factoryCallback, callback))).toBe(true);
});

it('accepts unrelated destructured parameters without weakening protected binding checks', () => {
  const source = `${fixture}\nconst projectOwner = ({ value }: { readonly value: OwnerServices }) => value;`;
  expect(accepts(source)).toBe(true);
});

it('accepts property reads and reflective mutations of unrelated objects', () => {
  const source = `${fixture}
const nativeFn = Effect['fn'];
Reflect.get(Effect, 'fn');
const unrelated = {};
Object.assign(unrelated, { name: 'owner' });
Object.defineProperty(unrelated, 'name', { value: 'owner' });
Reflect.set(unrelated, 'name', 'owner');
`;
  expect(accepts(source)).toBe(true);
});

it('accepts a genuine Core type annotation imported as a named type specifier', () => {
  expect(
    accepts(fixture.replace(nativeTypeImport, "import { type ReadServiceFactory } from '@app/core-runtime';")),
  ).toBe(true);
});

it('accepts a native rename of the genuine Core return annotation', () => {
  const source = fixture
    .replace(nativeTypeImport, "import type { ReadServiceFactory as OwnerFactory } from '@app/core-runtime';")
    .replace(': ReadServiceFactory<', ': OwnerFactory<');
  expect(accepts(source)).toBe(true);
});

it('accepts a directly executable top-level owner argument', () => {
  const source = fixture
    .replace(
      ownerImport,
      `${ownerImport}\nconst localOwner = (transaction, scope, revision) => loadOwner(transaction, scope, revision);`,
    )
    .replace(sourceParameter, 'source: typeof localOwner')
    .replace(`${makerName}(loadOwner)`, `${makerName}(localOwner)`);
  expect(accepts(source)).toBe(true);
});

it('accepts a required parameter after a default only when its position is supplied', () => {
  const source = fixture.replace(makerParameters, '(source: typeof loadOwner = loadOwner, fence: typeof ownerFence)');
  expect(accepts(source)).toBe(false);
  expect(accepts(source.replace(`${makerName}(loadOwner)`, `${makerName}(loadOwner, ownerFence)`))).toBe(true);
});

it('accepts the real Pricing factory result after its native return annotation is installed', () => {
  const pricingOwner = 'verticals/pricing';
  const pricingRead = `${pricingOwner}/src/api/current-pricing-decision.read.ts`;
  const sources = new Map(
    [
      pricingRead,
      `${pricingOwner}/src/integrations/current-pricing-decision-whole-evaluation-adapters.ts`,
      `${pricingOwner}/src/integrations/current-pricing-decision-owner-final-fence.ts`,
    ].map((file): readonly [string, string] => [
      file,
      readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8'),
    ]),
  );
  expect(
    hasOwnerLocalReadServiceFactoryResult(
      sources,
      pricingRead,
      pricingOwner,
      'currentPricingDecisionReadServiceFactory',
    ),
  ).toBe(true);
});

it('rejects owner imports whose actual source is absent', () => {
  expect(hasOwnerLocalReadServiceFactoryResult(new Map([[readFile, fixture]]), readFile, ownerPath, resultName)).toBe(
    false,
  );
});

for (const [name, foreignOwner] of [
  ['a different owner', 'verticals/foreign-owner'],
  ['a similarly prefixed owner', `${ownerPath}-foreign`],
] as const) {
  it(`rejects a dependency source inside ${name}`, () => {
    const source = fixture.replace(
      './owner-scope.ts',
      `../../../${foreignOwner.slice('verticals/'.length)}/src/api/owner-scope.ts`,
    );
    const sources = new Map([
      [readFile, source],
      [`${foreignOwner}/src/api/owner-scope.ts`, dependencySource],
    ]);
    expect(hasOwnerLocalReadServiceFactoryResult(sources, readFile, ownerPath, resultName)).toBe(false);
  });
}

for (const [name, ownerSource] of [
  ['missing actual export', dependencySource.replace('export const loadOwner =', 'export const unrelatedOwner =')],
  ['non-exported actual callable', dependencySource.replace('export const loadOwner =', 'const loadOwner =')],
  [
    'type-only actual export',
    `${nativeEffectImport}\nexport type loadOwner = () => unknown;\nexport const ownerFence = () => Effect.succeed(undefined);`,
  ],
  [
    'noncallable actual export',
    `${nativeEffectImport}\nexport const loadOwner = {};\nexport const ownerFence = () => Effect.succeed(undefined);`,
  ],
  [
    'undefined actual export',
    `${nativeEffectImport}\nexport const loadOwner = undefined;\nexport const ownerFence = () => Effect.succeed(undefined);`,
  ],
  ['duplicate actual export', `${dependencySource}\nexport const loadOwner = () => Effect.succeed({});`],
  [
    'actual callable assignment alias',
    `${nativeEffectImport}\nconst otherOwner = () => Effect.succeed({});\nexport const loadOwner = otherOwner;\nexport const ownerFence = () => Effect.succeed(undefined);`,
  ],
] as const) {
  it(`rejects an imported owner dependency with a ${name}`, () => {
    expect(
      hasOwnerLocalReadServiceFactoryResult(sourcesFor(fixture, ownerSource), readFile, ownerPath, resultName),
    ).toBe(false);
  });
}

it('accepts a genuine Core generic annotation containing structural type members', () => {
  const source = fixture.replace(
    'ReadServiceFactory<OwnerServices, OwnerRequirements>',
    'ReadServiceFactory<{ readonly owner: string }, OwnerRequirements>',
  );
  expect(accepts(source)).toBe(true);
});

it('accepts unrelated member names that match protected imported identifiers', () => {
  const source = `${fixture}\nconst other = {};\nother.Effect = value;\nother.ReadServiceFactory = value;\nother.loadOwner = value;\nother.${makerName} = value;\nother.${resultName} = value;`;
  expect(accepts(source)).toBe(true);
});

for (const binding of ['Effect', 'ReadServiceFactory', 'loadOwner', makerName, resultName]) {
  it(`rejects a structurally annotated maker parameter shadowing ${binding}`, () => {
    const source = fixture
      .replace(
        'ReadServiceFactory<OwnerServices, OwnerRequirements>',
        'ReadServiceFactory<{ readonly owner: string }, OwnerRequirements>',
      )
      .replace(sourceParameter, `${binding}: typeof loadOwner`);
    expect(accepts(source)).toBe(false);
  });
}

for (const [name, source] of [
  ['missing Core type import', fixture.replace(`${nativeTypeImport}\n`, '')],
  [
    'foreign Core annotation',
    fixture.replace(nativeTypeImport, "import type { ReadServiceFactory } from '@app/foreign-runtime';"),
  ],
  ['fabricated Core annotation', fixture.replace(nativeTypeImport, 'type ReadServiceFactory<S, R> = unknown;')],
  ['shadowed Core annotation', `${nativeTypeImport}\ntype ReadServiceFactory<S, R> = unknown;\n${fixture}`],
  ['duplicate native type import', fixture.replace(nativeTypeImport, `${nativeTypeImport}\n${nativeTypeImport}`)],
  ['missing return annotation', fixture.replace(': ReadServiceFactory<OwnerServices, OwnerRequirements>', '')],
  [
    'unrelated return annotation',
    fixture.replace(': ReadServiceFactory<OwnerServices, OwnerRequirements>', ': OwnerCallable'),
  ],
  [
    'asserted return annotation',
    fixture.replace(factoryCallback, `${factoryCallback} as ReadServiceFactory<OwnerServices, OwnerRequirements>`),
  ],
  ['type-only Effect import', fixture.replace(nativeEffectImport, "import type { Effect } from 'effect';")],
  ['type-only Effect specifier', fixture.replace(nativeEffectImport, "import { type Effect } from 'effect';")],
  ['foreign Effect import', fixture.replace(nativeEffectImport, "import { Effect } from '@app/foreign-effect';")],
  ['missing Effect import', fixture.replace(`${nativeEffectImport}\n`, '')],
  ['fabricated Effect binding', fixture.replace(nativeEffectImport, 'const Effect = fakeEffect;')],
  ['shadowed Effect binding', fixture.replace(nativeEffectImport, `${nativeEffectImport}\nconst Effect = fakeEffect;`)],
  ['duplicate maker declaration', fixture.replace(makerDeclaration, `${makerDeclaration}\n${makerDeclaration}`)],
  ['duplicate result declaration', fixture.replace(resultDeclaration, `${resultDeclaration}\n${resultDeclaration}`)],
  [
    'maker binding alias',
    fixture.replace(
      makerDeclaration,
      `const genuineMaker = () => undefined;\nexport const ${makerName} = genuineMaker;`,
    ),
  ],
  ['result binding alias', `${fixture}\nexport const resultAlias = ${resultName};`],
  [
    'maker call alias',
    `${fixture.replace(resultDeclaration, '')}\nconst makerAlias = ${makerName};\nexport const ${resultName} = makerAlias(loadOwner);`,
  ],
  ['missing required argument', fixture.replace(`${makerName}(loadOwner)`, `${makerName}()`)],
  ['too many arguments', fixture.replace(`${makerName}(loadOwner)`, `${makerName}(loadOwner, ownerFence, loadOwner)`)],
  ['wrong argument identity', fixture.replace(`${makerName}(loadOwner)`, `${makerName}(ownerFence)`)],
  ['reordered argument identities', fixture.replace(`${makerName}(loadOwner)`, `${makerName}(ownerFence, loadOwner)`)],
  [
    'wrong optional argument identity',
    fixture.replace(`${makerName}(loadOwner)`, `${makerName}(loadOwner, loadOwner)`),
  ],
  [
    'foreign default identity',
    fixture.replace('fence: typeof ownerFence = ownerFence', 'fence: typeof ownerFence = loadOwner'),
  ],
  ['spread call argument', fixture.replace(`${makerName}(loadOwner)`, `${makerName}(...loadOwner)`)],
  ['middle argument hole', fixture.replace(`${makerName}(loadOwner)`, `${makerName}(loadOwner,,ownerFence)`)],
  ['leading argument hole', fixture.replace(`${makerName}(loadOwner)`, `${makerName}(,ownerFence)`)],
  ['optional argument hole', fixture.replace(`${makerName}(loadOwner)`, `${makerName}(loadOwner,,)`)],
  ['destructured maker parameter', fixture.replace(sourceParameter, '{ source }: OwnerSource')],
  ['rest maker parameter', fixture.replace(sourceParameter, '...source: OwnerSource[]')],
  ['untyped maker parameter', fixture.replace(sourceParameter, 'source')],
  ['literal maker argument', fixture.replace(`${makerName}(loadOwner)`, `${makerName}(undefined)`)],
  ['unresolved maker argument', fixture.replace(`${makerName}(loadOwner)`, `${makerName}(unknownOwner)`)],
  [
    'type-only owner callable import',
    fixture.replace(ownerImport, "import type { loadOwner, ownerFence } from './owner-scope.ts';"),
  ],
  [
    'type-only owner callable specifier',
    fixture.replace(ownerImport, "import { type loadOwner, ownerFence } from './owner-scope.ts';"),
  ],
  ['shadowed owner callable import', fixture.replace(ownerImport, `${ownerImport}\nconst loadOwner = fakeOwner;`)],
  [
    'aliased owner callable',
    fixture
      .replace(ownerImport, `${ownerImport}\nconst localOwner = loadOwner;`)
      .replace(`${makerName}(loadOwner)`, `${makerName}(localOwner)`),
  ],
  [
    'noncallable local owner argument',
    fixture
      .replace(ownerImport, `${ownerImport}\nconst localOwner = {};`)
      .replace(`${makerName}(loadOwner)`, `${makerName}(localOwner)`),
  ],
  [
    'nested owner argument declaration',
    fixture
      .replace(ownerImport, `${ownerImport}\nfunction decoy() { const localOwner = () => undefined; }`)
      .replace(`${makerName}(loadOwner)`, `${makerName}(localOwner)`),
  ],
  [
    'nested maker declaration',
    fixture.replace(makerDeclaration, `function decoy() { ${makerDeclaration.replace('export const', 'const')} }`),
  ],
  ['maker parameter shadowing Effect', fixture.replace(sourceParameter, 'Effect: typeof loadOwner')],
  [
    'maker parameter shadowing the native annotation',
    fixture.replace(sourceParameter, 'ReadServiceFactory: typeof loadOwner'),
  ],
  ['maker parameter shadowing its own binding', fixture.replace(sourceParameter, `${makerName}: typeof loadOwner`)],
  [
    'non-native callback return',
    fixture.replace(factoryCallback, '(transaction, scope, revision) => source(transaction, scope, revision)'),
  ],
  ['noncallable return', fixture.replace(factoryCallback, '{}')],
  ['undefined return', fixture.replace(factoryCallback, 'undefined')],
  [
    'noncallable Effect.fn argument',
    fixture.replace(factoryCallback, "Effect.fn('Owner.Read.serviceFactory')(undefined)"),
  ],
  ['callback alias return', fixture.replace(factoryCallback, 'anotherCallback')],
  ['extra maker call', fixture.replace(`${makerName}(loadOwner)`, `${makerName}(loadOwner)()`)],
  [
    'sequence result initializer',
    fixture.replace(`${makerName}(loadOwner)`, `(${makerName}(loadOwner), otherFactory)`),
  ],
  ['indirect result initializer', fixture.replace(`${makerName}(loadOwner)`, `identity(${makerName}(loadOwner))`)],
  [
    'asserted result initializer',
    fixture.replace(`${makerName}(loadOwner)`, `${makerName}(loadOwner) as ReadServiceFactory<OwnerServices>`),
  ],
  ['maker reassignment', `${fixture}\n${makerName} = otherMaker;`],
  ['result reassignment', `${fixture}\n${resultName} = otherFactory;`],
  ['owner dependency reassignment', `${fixture}\nloadOwner = otherOwner;`],
  ['owner dependency property mutation', `${fixture}\nloadOwner.execute = otherOwner;`],
  ['Effect reassignment', `${fixture}\nEffect = otherEffect;`],
  ['Effect.fn property mutation', `${fixture}\nEffect.fn = otherFactory;`],
  ['Effect.fn deletion', `${fixture}\ndelete Effect.fn;`],
  ['Effect.fn bracket property mutation', `${fixture}\nEffect['fn'] = otherFactory;`],
  ['Effect.fn compound mutation', `${fixture}\nEffect.fn ||= otherFactory;`],
  ['Reflect.set mutation', `${fixture}\nReflect.set(Effect, 'fn', otherFactory);`],
  ['Reflect.deleteProperty mutation', `${fixture}\nReflect.deleteProperty(Effect, 'fn');`],
  ['Object.assign mutation', `${fixture}\nObject.assign(Effect, { fn: otherFactory });`],
  ['Object.defineProperty mutation', `${fixture}\nObject.defineProperty(Effect, 'fn', { value: otherFactory });`],
  ['Object.defineProperties mutation', `${fixture}\nObject.defineProperties(Effect, { fn: { value: otherFactory } });`],
  ['Object.setPrototypeOf mutation', `${fixture}\nObject.setPrototypeOf(ownerFence, {});`],
  [
    'Reflect.defineProperty mutation',
    `${fixture}\nReflect.defineProperty(${resultName}, 'execute', { value: otherFactory });`,
  ],
  ['Reflect.setPrototypeOf mutation', `${fixture}\nReflect.setPrototypeOf(${makerName}, {});`],
  ['protected Effect assignment alias mutation', `${fixture}\nconst aliasedEffect = Effect;\naliasedEffect.fn = fake;`],
  [
    'protected owner assignment alias mutation',
    `${fixture}\nconst aliasedOwner = loadOwner;\naliasedOwner.execute = fake;`,
  ],
  [
    'protected maker assignment alias mutation',
    `${fixture}\nconst aliasedMaker = ${makerName};\naliasedMaker.execute = fake;`,
  ],
  [
    'protected result assignment alias mutation',
    `${fixture}\nconst aliasedResult = ${resultName};\naliasedResult.execute = fake;`,
  ],
  ['computed Object.assign mutation', `${fixture}\nObject['assign'](Effect, { fn: fake });`],
  ['computed Reflect.set mutation', `${fixture}\nReflect['set'](Effect, 'fn', fake);`],
] as const) {
  it(`rejects a local Read factory with a ${name}`, () => {
    expect(accepts(source, name === 'result binding alias' ? 'resultAlias' : resultName)).toBe(false);
  });
}

for (const binding of ['Effect', 'loadOwner', makerName, resultName]) {
  for (const [name, declaration] of [
    ['a later constant declarator', `const harmless = 0, aliasedValue = ${binding};`],
    ['a separate assignment', `let aliasedValue;\naliasedValue = ${binding};`],
    ['a parenthesized copy', `const aliasedValue = (${binding});`],
    ['a type-asserted copy', `const aliasedValue = ${binding} as typeof ${binding};`],
  ] as const) {
    it(`rejects a protected ${binding} alias through ${name}`, () => {
      expect(accepts(`${fixture}\n${declaration}\naliasedValue.fn = fake;`)).toBe(false);
    });
  }

  it(`rejects a protected ${binding} copy into an object property`, () => {
    expect(accepts(`${fixture}\nconst box = {};\nbox.effect = ${binding};\nbox.effect.fn = fake;`)).toBe(false);
  });
}

it('rejects protected aliases created by unrelated typed parameter defaults', () => {
  const source = `${fixture}\nconst otherFactory = (other: typeof Effect = Effect) => other;`;
  expect(accepts(source)).toBe(false);
});

it('accepts protected values on the right side of equality comparisons', () => {
  const source = `${fixture}
const sameEffect = unrelated === Effect;
const sameOwner = unrelated === loadOwner;
const sameMaker = unrelated === ${makerName};
const sameResult = unrelated === ${resultName};
`;
  expect(accepts(source)).toBe(true);
});

it('rejects absent and non-identifier candidates', () => {
  expect(hasOwnerLocalReadServiceFactoryResult(sourcesFor(), readFile, ownerPath)).toBe(false);
  expect(accepts(fixture, `${makerName}(loadOwner)`)).toBe(false);
  expect(accepts(fixture, 'unknownFactory')).toBe(false);
});

it('does not accept declarations appearing only in comments or template text', () => {
  expect(
    accepts(
      `${nativeTypeImport}\n${nativeEffectImport}\n${ownerImport}\n/* ${makerDeclaration}\n${resultDeclaration} */`,
    ),
  ).toBe(false);
  expect(
    accepts(
      `${nativeTypeImport}\n${nativeEffectImport}\n${ownerImport}\nconst decoy = \`${makerDeclaration}\n${resultDeclaration}\`;`,
    ),
  ).toBe(false);
});

it('ignores inert mutation examples in comments and string values', () => {
  const source = `${fixture}\n// Effect.fn = fake;\nconst example = '${makerName} = fake; ${resultName} = fake;';`;
  expect(accepts(source)).toBe(true);
});
