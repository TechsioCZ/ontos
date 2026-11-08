import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

import {
  hasOwnerLocalReadServiceFactory,
  hasReadOwnerPermissionDeclaration,
} from '../generated-governed-http-boundary.mts';

const ownerPath = 'verticals/commerce-customer-context';
const readFile = `${ownerPath}/src/api/payment-term-policy-current.read.ts`;
const serviceFile = `${ownerPath}/src/services/customer-commerce-policy-administration.service.ts`;
const factoryName = 'customerCommercePolicyAdministrationServiceFactory';
const factoryImport = `import { ${factoryName} } from '../services/customer-commerce-policy-administration.service.ts';`;
const coreTypeImport = "import type { ReadServiceFactory } from '@app/core-runtime';";
const serviceInitializer = '(transaction, scope) => makeService(transaction, scope)';
const factoryDeclaration = `export const ${factoryName}: ReadServiceFactory<Service> = ${serviceInitializer};`;
const serviceSource = `${coreTypeImport}\n${factoryDeclaration}`;
const sourcesFor = (readSource = factoryImport, factorySource = serviceSource): ReadonlyMap<string, string> =>
  new Map([
    [readFile, readSource],
    [serviceFile, factorySource],
  ]);
const accepts = (sources: ReadonlyMap<string, string>, candidate: string | undefined = factoryName): boolean =>
  hasOwnerLocalReadServiceFactory(sources, readFile, ownerPath, candidate);

const currentReadFiles = [
  'commerce-quantity-policy-current',
  'market-bootstrap-policy-current',
  'payment-term-policy-current',
  'purchase-currency-policy-current',
];
const currentSources = new Map<string, string>(
  [serviceFile, ...currentReadFiles.map((name) => `${ownerPath}/src/api/${name}.read.ts`)].map(
    (file): readonly [string, string] => [file, readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8')],
  ),
);

for (const name of currentReadFiles) {
  it(`accepts the real CCC ${name} owner service factory without widening the boundary`, () => {
    expect(
      hasOwnerLocalReadServiceFactory(currentSources, `${ownerPath}/src/api/${name}.read.ts`, ownerPath, factoryName),
    ).toBe(true);
  });
}

it('accepts only the original scoped Core routine capability paired with its native operational scope', () => {
  const source = `import type { ScopedRoutineInvoker, OperationalScope } from '@app/core-runtime';
export const ${factoryName} = (transaction: ScopedRoutineInvoker, scope: OperationalScope) => makeService(transaction, scope);`;
  expect(accepts(sourcesFor(factoryImport, source))).toBe(true);
  for (const invalid of [
    source.replace("from '@app/core-runtime'", "from './foreign-core.ts'"),
    source.replace(
      'ScopedRoutineInvoker, OperationalScope',
      'ForeignRoutineInvoker as ScopedRoutineInvoker, OperationalScope',
    ),
    source.replace('transaction: ScopedRoutineInvoker', 'transaction: ForeignRoutineInvoker'),
    source.replace('scope: OperationalScope', 'scope: unknown'),
    `${source}\ntype ScopedRoutineInvoker = unknown;`,
    `${source}\nfunction shadow(ScopedRoutineInvoker) {}`,
    `${source}\nfunction shadow(OperationalScope) {}`,
  ]) {
    expect(invalid).not.toBe(source);
    expect(accepts(sourcesFor(factoryImport, invalid))).toBe(false);
  }
});

it('accepts a genuine Core factory annotation imported only as a type', () => {
  expect(accepts(sourcesFor())).toBe(true);
  expect(
    accepts(
      sourcesFor(
        factoryImport,
        serviceSource.replace(coreTypeImport, "import { type ReadServiceFactory } from '@app/core-runtime';"),
      ),
    ),
  ).toBe(true);
});

it('resolves a native named import rename to the real exported owner factory', () => {
  const readSource = factoryImport.replace(factoryName, `${factoryName} as localFactory`);
  expect(accepts(sourcesFor(readSource), 'localFactory')).toBe(true);
});

it('resolves a native Core type import rename to the genuine factory annotation', () => {
  const factorySource = `import type { ReadServiceFactory as OwnerFactory } from '@app/core-runtime';\n${factoryDeclaration.replace(': ReadServiceFactory', ': OwnerFactory')}`;
  expect(accepts(sourcesFor(factoryImport, factorySource))).toBe(true);
});

it('accepts comments inside the native named value import', () => {
  const readSource = factoryImport.replace(
    `{ ${factoryName} }`,
    `{ /* type, } ignored comment */\n${factoryName}, // ignored import text\n}`,
  );
  expect(accepts(sourcesFor(readSource))).toBe(true);
});

it('accepts comments inside the genuine Core factory annotation import', () => {
  const factorySource = serviceSource.replace(
    '{ ReadServiceFactory }',
    '{ /* alias, } ignored annotation */\nReadServiceFactory, // ignored type text\n}',
  );
  expect(accepts(sourcesFor(factoryImport, factorySource))).toBe(true);
});

for (const [name, readSource, candidate] of [
  ['declaration-level type-only import', factoryImport.replace('import {', 'import type {'), factoryName],
  ['specifier-level type-only import', factoryImport.replace(`{ ${factoryName}`, `{ type ${factoryName}`), factoryName],
  ['missing import', '', factoryName],
  ['assignment alias', `${factoryImport}\nconst localFactory = ${factoryName};`, 'localFactory'],
  [
    'wrapper callback',
    `${factoryImport}\nconst localFactory = (transaction, scope) => ${factoryName}(transaction, scope);`,
    'localFactory',
  ],
  ['shadowed imported value', `${factoryImport}\nconst ${factoryName} = undefined;`, factoryName],
  ['non-identifier callback', factoryImport, `() => ${factoryName}`],
] as const) {
  it(`rejects an owner factory with a ${name}`, () => {
    expect(accepts(sourcesFor(readSource), candidate)).toBe(false);
  });
}

it('rejects a missing factory candidate', () => {
  expect(hasOwnerLocalReadServiceFactory(sourcesFor(), readFile, ownerPath)).toBe(false);
});

it('rejects an import whose owner service source is missing', () => {
  expect(accepts(new Map([[readFile, factoryImport]]))).toBe(false);
});

it('rejects a missing read source even when the owner contains a valid factory', () => {
  expect(accepts(new Map([[serviceFile, serviceSource]]))).toBe(false);
});

for (const [name, target] of [
  ['another vertical', 'verticals/pricing/src/services/customer-commerce-policy-administration.service.ts'],
  [
    'a similarly prefixed owner',
    `${ownerPath}-foreign/src/services/customer-commerce-policy-administration.service.ts`,
  ],
  ['outside the vertical owner', 'packages/core-runtime/src/customer-commerce-policy-administration.service.ts'],
] as const) {
  it(`rejects a genuine factory imported from ${name}`, () => {
    const foreignImport = factoryImport.replace(
      '../services/customer-commerce-policy-administration.service.ts',
      `../../../../${target}`,
    );
    expect(
      accepts(
        new Map([
          [readFile, foreignImport],
          [target, serviceSource],
        ]),
      ),
    ).toBe(false);
  });
}

for (const [name, invalidService] of [
  ['non-exported declaration', serviceSource.replace('export const', 'const')],
  ['different exported symbol', serviceSource.replace(factoryName, 'unrelatedFactory')],
  ['undefined initializer', serviceSource.replace(serviceInitializer, 'undefined')],
  ['non-callable initializer', serviceSource.replace(serviceInitializer, '{}')],
  ['factory alias initializer', serviceSource.replace(serviceInitializer, 'anotherFactory')],
  ['annotation imported from another package', serviceSource.replace('@app/core-runtime', '@app/foreign-runtime')],
  ['missing Core annotation import', factoryDeclaration],
  ['locally declared annotation', `type ReadServiceFactory<T> = T;\n${factoryDeclaration}`],
  ['shadowed Core annotation', `${coreTypeImport}\ntype ReadServiceFactory<T> = T;\n${factoryDeclaration}`],
  [
    'unannotated candidate beside a valid decoy',
    `${coreTypeImport}\n${factoryDeclaration.replace(factoryName, 'decoyFactory')}\nexport const ${factoryName} = ${serviceInitializer};`,
  ],
] as const) {
  it(`rejects an owner source with a ${name}`, () => {
    expect(accepts(sourcesFor(factoryImport, invalidService))).toBe(false);
  });
}

it('ignores a factory declaration appearing only in comments', () => {
  expect(accepts(sourcesFor(factoryImport, `${coreTypeImport}\n/* ${factoryDeclaration} */`))).toBe(false);
});

const ownerPermissionInvocation = 'ownerReadPermission<Input>(resolve)';
const corePermissionInvocation = 'defineReadOwnerPermission(contract, resolve)';
const permissionFile = `${ownerPath}/src/permissions/authorization.ts`;
const permissionImport = "import { ownerReadPermission } from '../permissions/authorization.ts';";
const corePermissionImport = "import { defineReadOwnerPermission } from '@app/core-runtime';";
const permissionWrapper = `${corePermissionImport}
export const ownerReadPermission = <Input>(resolver: (input: Input) => Target) =>
  defineReadOwnerPermission(contract, (input: Input, scope) => resolver(input, scope));`;
const permissionSources = (readSource = permissionImport, wrapperSource = permissionWrapper) =>
  new Map([
    [readFile, readSource],
    [permissionFile, wrapperSource],
  ]);
const acceptsPermission = (sources: ReadonlyMap<string, string>, candidate = ownerPermissionInvocation) =>
  hasReadOwnerPermissionDeclaration(sources, readFile, ownerPath, candidate);

it('accepts the genuine direct Core owner permission declaration and its native import rename', () => {
  expect(acceptsPermission(permissionSources(corePermissionImport), corePermissionInvocation)).toBe(true);
  expect(
    acceptsPermission(
      permissionSources(
        corePermissionImport.replace('defineReadOwnerPermission }', 'defineReadOwnerPermission as nativePermission }'),
      ),
      'nativePermission(contract, resolve)',
    ),
  ).toBe(true);
});

it('accepts a genuine direct declaration stored in a const and a same-owner wrapper with typed resolver', () => {
  expect(
    acceptsPermission(
      permissionSources(`${corePermissionImport}\nconst permission = defineReadOwnerPermission(contract, resolve);`),
      'permission',
    ),
  ).toBe(true);
  expect(acceptsPermission(permissionSources())).toBe(true);
  expect(
    acceptsPermission(
      permissionSources(permissionImport.replace('ownerReadPermission }', 'ownerReadPermission as localPermission }')),
      'localPermission<Input>(resolve)',
    ),
  ).toBe(true);
});

for (const [name, readSource, wrapperSource, candidate] of [
  [
    'fake same-name constructor',
    "import { defineReadOwnerPermission } from '@app/fake-runtime';",
    permissionWrapper,
    corePermissionInvocation,
  ],
  [
    'local fake constructor',
    'const defineReadOwnerPermission = (contract, resolve) => ({});',
    permissionWrapper,
    corePermissionInvocation,
  ],
  [
    'type-only constructor',
    corePermissionImport.replace('import {', 'import type {'),
    permissionWrapper,
    corePermissionInvocation,
  ],
  ['plain DTO', "const permission = { kind: 'owner_permission' };", permissionWrapper, 'permission'],
  ['DTO callback', '', permissionWrapper, "() => ({ kind: 'owner_permission' })"],
  [
    'fake wrapper return',
    permissionImport,
    permissionWrapper.replace(
      'defineReadOwnerPermission(contract, (input: Input, scope) => resolver(input, scope))',
      "({ kind: 'owner_permission' })",
    ),
    ownerPermissionInvocation,
  ],
  [
    'fake wrapper constructor import',
    permissionImport,
    permissionWrapper.replace('@app/core-runtime', '@app/fake-runtime'),
    ownerPermissionInvocation,
  ],
  [
    'shadowed constructor parameter',
    permissionImport,
    permissionWrapper.replace('resolver: (input: Input) => Target', 'defineReadOwnerPermission: Factory'),
    ownerPermissionInvocation,
  ],
  [
    'non-exported wrapper',
    permissionImport,
    permissionWrapper.replace('export const', 'const'),
    ownerPermissionInvocation,
  ],
  [
    'extra expression after declaration',
    corePermissionImport,
    permissionWrapper,
    'defineReadOwnerPermission(contract, resolve) || fake',
  ],
] as const) {
  it(`rejects an owner permission ${name}`, () => {
    expect(acceptsPermission(permissionSources(readSource, wrapperSource), candidate)).toBe(false);
  });
}

it('rejects a genuine constructor wrapper imported from another owner', () => {
  const foreignFile = 'verticals/pricing/src/permissions/authorization.ts';
  expect(
    acceptsPermission(
      new Map([
        [readFile, "import { ownerReadPermission } from '../../../pricing/src/permissions/authorization.ts';"],
        [foreignFile, permissionWrapper],
      ]),
    ),
  ).toBe(false);
});
