import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import { parseSync } from 'oxc-parser';
import { expect, it } from 'effect-rstest';

import { nativeModuleSourceReferences } from '../../anti-slop/effect/rules/registered-tooling-package-proof.ts';
import { antiSlopEffectRule, appRoot, ruleTester, workspaceCase } from './rule-tester.mts';
import type { InvalidCase, ValidCase } from './rule-tester.mts';

const rootFile = 'commands/audit.mts';
const factoryFile = 'commands/parser.mts';
const unrelatedData = 'export const data = 1;';
const evidenceFilename = 'consumer.mts';
const moduleEvidence = (text: string) =>
  nativeModuleSourceReferences(parseSync(evidenceFilename, text, { sourceType: 'module' }).program);
const consumerTypeScript = 'src/consumer.ts';
const consumerModule = 'src/consumer.mts';
const factory = `import { parseSync } from 'oxc-parser';
export const makeParser = (source: string) => {
  const cache = new Map();
  return { parse: () => { cache.set(source, parseSync('input.ts', source)); return cache.get(source); } };
};`;
const command = `import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, ManagedRuntime } from 'effect';
import { makeParser } from './parser.mts';
export const inspect = (source: string) => { const parser = makeParser(source); return parser.parse(); };
const main = Effect.gen(function* () { inspect('const value = 1'); });
const [, invokedPath] = process.argv;
if (invokedPath === import.meta.filename) {
  const runtime = ManagedRuntime.make(NodeServices.layer);
  const exit = await runtime.runPromiseExit(main);
  process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
}`;
const message =
  'Do not import Effect service constructor "makeParser" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.';
const mainDeclaration = 'const main =';
const parserObservation = 'return parser.parse();';
const inspectConsumer = "import { inspect } from '../commands/audit.mts'; void inspect;";
const foreignManifest = 'foreign/package.json';
const foreignPackageName = 'foreign-package';
const valid: ValidCase[] = [];
const invalid: InvalidCase[] = [];
const scenario = (
  name: string,
  source: string,
  files: readonly { path: string; source: string }[] = [],
  registered = true,
  symlink?: 'entry' | 'factory',
) => {
  const workspace = workspaceCase([
    {
      path: 'package.json',
      source: JSON.stringify({ name: 'tooling-owner', scripts: registered ? { audit: `node ./${rootFile}` } : {} }),
    },
    { path: rootFile, source },
    { path: factoryFile, source: factory },
    ...files,
  ]);
  return {
    code: source,
    filename: workspace.file(rootFile),
    name,
    ...workspace.hooks,
    before: () => {
      workspace.create();
      if (symlink !== undefined) {
        const target = symlink === 'entry' ? rootFile : factoryFile;
        const actual = workspace.file('commands/actual.mts');
        writeFileSync(actual, symlink === 'entry' ? source : factory);
        unlinkSync(workspace.file(target));
        symlinkSync(actual, workspace.file(target));
      }
    },
  };
};
valid.push(
  scenario('a registered genuine guarded tooling root owns its stateful parser construction', command),
  scenario(
    'native freeze of a fresh inert metadata object preserves the registered tooling root',
    command.replace(mainDeclaration, `const edge = Object.freeze({ kind: 'other-native' }); ${mainDeclaration}`),
  ),
  scenario(
    'native freeze accepts the actual const-asserted fresh metadata object',
    command.replace(
      mainDeclaration,
      `const edge = Object.freeze({ kind: 'other-native' } as const); ${mainDeclaration}`,
    ),
  ),
  scenario('test consumers do not turn the tooling root into a production service', command, [
    { path: 'tests/audit.test.mts', source: inspectConsumer },
  ]),
  scenario(
    'native freeze preserves nested eager data objects and arrays',
    command.replace(
      mainDeclaration,
      `const edge = Object.freeze({ nested: [{ kind: 'other-native' }] } as const); ${mainDeclaration}`,
    ),
  ),
);
for (const [name, initializer] of [
  [
    'shadowed Object freeze is not native metadata construction',
    "const Object = { freeze: (value) => value }; const edge = Object.freeze({ kind: 'other-native' });",
  ],
  [
    'foreign Object freeze is not native metadata construction',
    "import { Object } from 'foreign-object'; const edge = Object.freeze({ kind: 'other-native' });",
  ],
  [
    'freezing a shared object is not a fresh metadata initializer',
    "const shared = { kind: 'other-native' }; const edge = Object.freeze(shared);",
  ],
  [
    'aliased freeze does not acquire native initializer trust',
    "const freeze = Object.freeze; const edge = freeze({ kind: 'other-native' });",
  ],
  [
    'freezing a constructor result cannot hide eager construction',
    "const edge = Object.freeze(makeParser('outside'));",
  ],
  [
    'fresh frozen metadata cannot hide a spread acquisition',
    "const shared = { kind: 'other-native' }; const edge = Object.freeze({ ...shared });",
  ],
  [
    'fresh frozen metadata cannot hide an eager project call',
    "const edge = Object.freeze({ kind: inspect('outside') });",
  ],
  [
    'native freeze requires exactly one initializer argument',
    "const edge = Object.freeze({ kind: 'other-native' }, inspect('outside'));",
  ],
  ['native freeze does not open array construction as a tooling-root category', 'const edge = Object.freeze([1, 2]);'],
  [
    'fresh frozen metadata cannot introduce a getter',
    "const edge = Object.freeze({ get kind() { return inspect('outside'); } });",
  ],
  [
    'fresh frozen metadata cannot introduce a setter',
    'const edge = Object.freeze({ set kind(value) { inspect(value); } });',
  ],
  [
    'fresh frozen metadata rejects a nested eager object getter',
    "const edge = Object.freeze({ nested: { get kind() { return inspect('outside'); } } });",
  ],
  [
    'fresh frozen metadata rejects a setter nested in an eager array',
    'const edge = Object.freeze({ nested: [{ set kind(value) { inspect(value); } }] });',
  ],
] as const) {
  invalid.push({
    ...scenario(name, command.replace(mainDeclaration, `${initializer} ${mainDeclaration}`)),
    errors: [{ message }],
  });
}
for (const [name, source] of [
  ['unguarded process execution', command.replace('if (invokedPath === import.meta.filename)', 'if (true)')],
  ['fake import-meta guard', command.replace('import.meta.filename', "'audit.mts'")],
  ['fake argv binding', command.replace('process.argv', "['node', 'audit.mts']")],
  [
    'fake ManagedRuntime origin',
    command.replace(
      "Effect, Exit, ManagedRuntime } from 'effect'",
      "Effect, Exit } from 'effect'; import { ManagedRuntime } from 'foreign-effect'",
    ),
  ],
  ['fake NodeServices origin', command.replace("'@effect/platform-node'", "'foreign-platform-node'")],
  ['exported runtime escapes the guarded lifetime', command.replace(mainDeclaration, 'export const main =')],
  [
    'ungated side effect before the process guard',
    command.replace('const [, invokedPath]', "inspect('outside'); const [, invokedPath]"),
  ],
  [
    'constructor binding escapes through an export',
    command.replace(mainDeclaration, 'export { makeParser }; const main ='),
  ],
  [
    'constructor runs eagerly outside the guarded process',
    command.replace(mainDeclaration, "const outside = makeParser('outside'); const main ="),
  ],
  ['runtime namespace is mutated', command.replace(mainDeclaration, 'ManagedRuntime.make = () => ({}); const main =')],
  ['NodeServices layer is replaced', command.replace(mainDeclaration, 'NodeServices.layer = {}; const main =')],
  [
    'runtime method is extracted',
    command.replace(
      'const exit = await runtime.runPromiseExit(main);',
      'const execute = runtime.runPromiseExit; const exit = await execute(main);',
    ),
  ],
  [
    'runtime shadowed inside the process guard',
    command.replace(
      'const runtime = ManagedRuntime.make(NodeServices.layer);',
      'const ManagedRuntime = { make: () => ({ runPromiseExit: () => ({}) }) }; const runtime = ManagedRuntime.make(NodeServices.layer);',
    ),
  ],
  ['wrong native layer selected', command.replace('NodeServices.layer', 'NodeServices.fake')],
  ['constructed parser cannot be returned as a raw service', command.replace(parserObservation, 'return parser;')],
  ['constructed parser cannot escape in a returned object', command.replace(parserObservation, 'return { parser };')],
  [
    'constructed parser cannot be aliased before escape',
    command.replace(parserObservation, 'const escaped = parser; return escaped;'),
  ],
  [
    'constructor result cannot escape an expression-bodied export',
    command.replace('{ const parser = makeParser(source); return parser.parse(); }', 'makeParser(source)'),
  ],
] as const) {
  invalid.push({ ...scenario(name, source), errors: [{ message }] });
}
const additionalInvalid = [
  scenario('unregistered scripts remain runtime code', command, [], false),
  scenario('a production importer revokes root-only custody', command, [
    { path: consumerTypeScript, source: inspectConsumer },
  ]),
  scenario('a production reexport cannot expose a tooling root', command, [
    { path: consumerTypeScript, source: "export { inspect } from '../commands/audit.mts';" },
  ]),
  scenario(
    'a foreign package script cannot register this entry',
    command,
    [{ path: foreignManifest, source: JSON.stringify({ scripts: { audit: `node ../${rootFile}` } }) }],
    false,
  ),
  scenario('a nested package entry cannot borrow its parent registration', command, [
    { path: 'commands/package.json', source: JSON.stringify({ name: foreignPackageName, scripts: {} }) },
  ]),
  scenario('a nested package production consumer revokes root custody', command, [
    { path: foreignManifest, source: JSON.stringify({ name: foreignPackageName }) },
    { path: 'foreign/consumer.mts', source: inspectConsumer },
  ]),
  scenario(
    'a registered root cannot borrow a foreign package constructor',
    command.replace('./parser.mts', '../foreign/parser.mts'),
    [
      { path: foreignManifest, source: JSON.stringify({ name: foreignPackageName }) },
      { path: 'foreign/parser.mts', source: factory },
    ],
  ),
  scenario('a package export cannot expose its tooling process', command, [
    {
      path: 'package.json',
      source: JSON.stringify({ exports: { './audit': `./${rootFile}` }, scripts: { audit: `node ./${rootFile}` } }),
    },
  ]),
  scenario('entry symlinks cannot borrow package registration', command, [], true, 'entry'),
  scenario('constructor symlinks cannot borrow process ownership', command, [], true, 'factory'),
  ...[
    [
      'constant-selected production import',
      "const entry = '../commands/audit.mts'; const api = await import(entry); api.inspect();",
    ],
    [
      'constant-prefix production import',
      `const directory = '../commands/'; await import(\`\${directory}audit.mts\`);`,
    ],
    [
      'reassigned production import selector',
      "let entry = './other.mts'; entry = '../commands/audit.mts'; await import(entry);",
    ],
    ['cyclic production import selector', 'const left = right; const right = left; await import(left);'],
    [
      'aliased genuine Node createRequire',
      "import { createRequire } from 'node:module'; const factory = createRequire; const load = factory(import.meta.url); load('../commands/audit.mts');",
    ],
    [
      'namespace genuine Node createRequire',
      "import * as Module from 'node:module'; const load = Module.createRequire(import.meta.url); load('../commands/audit.mts');",
    ],
    [
      'changed URL native loader base',
      "import { createRequire } from 'node:module'; const load=createRequire(new URL('../commands/base.mjs',import.meta.url)); load('./audit.mts');",
    ],
    [
      'configured native loader base',
      "import { createRequire } from 'node:module'; const load=createRequire(configuredBase); load('./audit.mts');",
    ],
    [
      'mutated native module URL base',
      "import { createRequire } from 'node:module'; import.meta.url = new URL('../commands/base.mjs',import.meta.url).href; const load=createRequire(import.meta.url); load('./audit.mts');",
    ],
    [
      'destructured genuine Node createRequire',
      "import * as Module from 'node:module'; const {createRequire:factory}=Module; const load=factory(import.meta.url); load('../commands/audit.mts');",
    ],
    [
      'native required Node module member factory',
      "const load=require('node:module').createRequire(__filename); load('../commands/audit.mts');",
    ],
    [
      'native required Node module destructured factory',
      "const {createRequire:factory}=require('module'); const load=factory(__filename); load('../commands/audit.mts');",
    ],
    [
      'compiled TypeScript external module consumer',
      "import Contract = require('../commands/audit.mts'); void Contract.inspect;",
    ],
    [
      'closed private wrapper selecting the registered entry',
      "const loadSource=(specifier)=>require(specifier); const api=loadSource('../commands/audit.mts'); api.inspect();",
    ],
  ].map(([name, consumer]) => scenario(name, command, [{ path: consumerModule, source: consumer }])),
];
invalid.push(...additionalInvalid.map((entry) => ({ ...entry, errors: [{ message }] })));
valid.push(
  scenario('a literal-bound unrelated dynamic module does not import the tooling entry', command, [
    { path: consumerModule, source: "const entry = './other.mts'; await import(entry);" },
    { path: 'src/other.mts', source: unrelatedData },
  ]),
  scenario('a genuine importer-base native loader may consume an unrelated finite module', command, [
    {
      path: consumerModule,
      source:
        "import { createRequire } from 'node:module'; const load=createRequire(import.meta.url); load('./other.mts');",
    },
    { path: 'src/other.mts', source: unrelatedData },
  ]),
  scenario('an erased TypeScript external module type import is not a value consumer', command, [
    {
      path: consumerTypeScript,
      source: "import type Contract = require('../commands/audit.mts'); type Report = typeof Contract.inspect;",
    },
  ]),
  scenario('a compiled TypeScript unrelated JSON import does not consume the registered entry', command, [
    { path: consumerTypeScript, source: "import Version = require('./version.json'); void Version;" },
    { path: 'src/version.json', source: '{"version":"1"}' },
  ]),
  scenario(
    'native runtime aliases preserve import declaration identity',
    command
      .replace('{ NodeServices }', '{ NodeServices as Native }')
      .replace('Effect, Exit, ManagedRuntime', 'Effect as E, Exit as X, ManagedRuntime as R')
      .replace('Effect.gen', 'E.gen')
      .replace('Exit.isSuccess', 'X.isSuccess')
      .replace('ManagedRuntime.make', 'R.make')
      .replace('NodeServices.layer', 'Native.layer'),
  ),
);

ruleTester.run(
  'registered native tooling process roots retain constructor custody',
  antiSlopEffectRule('no-service-constructor-imports'),
  {
    invalid,
    valid: [
      ...valid,
      {
        code: readFileSync(nodePath.join(appRoot, 'scripts/check-database-access-boundaries.mts'), 'utf-8'),
        filename: nodePath.join(appRoot, 'scripts/check-database-access-boundaries.mts'),
        name: 'the actual package-registered database access checker',
      },
    ],
  },
);

it('shares only lexical native-loader source evidence and refuses an invalid program', () => {
  expect(nativeModuleSourceReferences(null)).toBeNull();
  const target = './target.mts';
  const source = `import { createRequire } from 'node:module'; const load=createRequire(import.meta.url); const directory='./'; const name='target.mts'; load(directory+name); import(\`\${directory}\${name}\`);`;
  const parsed = parseSync(evidenceFilename, source, { sourceType: 'module' });
  expect(parsed.errors).toEqual([]);
  expect(nativeModuleSourceReferences(parsed.program)).toEqual([
    { base: 'importer', invalidBinding: false, kind: 'native-loader', prefix: target, staticSpecifier: target },
    { base: 'importer', invalidBinding: false, kind: 'dynamic-import', prefix: target, staticSpecifier: target },
  ]);
  const mutable = parseSync(evidenceFilename, "let entry='./target.mts'; entry='./other.mts'; import(entry);", {
    sourceType: 'module',
  });
  expect(nativeModuleSourceReferences(mutable.program)?.[0]?.invalidBinding).toBe(true);
  const mutableLoader = parseSync(
    evidenceFilename,
    "import { createRequire } from 'node:module'; let factory=createRequire; factory=()=>()=>null; const load=factory(import.meta.url); load('./target.mts');",
    { sourceType: 'module' },
  );
  expect(
    nativeModuleSourceReferences(mutableLoader.program)?.find(({ staticSpecifier }) => staticSpecifier === target)
      ?.invalidBinding,
  ).toBe(true);
  const external = parseSync(
    'consumer.ts',
    "import Version = require('./version.json'); import type Data = require('./erased.json');",
    { sourceType: 'module' },
  );
  expect(external.errors).toEqual([]);
  expect(nativeModuleSourceReferences(external.program)).toEqual([
    {
      base: 'importer',
      invalidBinding: false,
      kind: 'native-loader',
      prefix: './version.json',
      staticSpecifier: './version.json',
    },
  ]);
});

it('enumerates only a closed private module-loader wrapper with finite literal callers', () => {
  const secondCall = "packageVersion('effect/package.json')";
  const packages = [
    '@modern-js/plugin-bff/package.json',
    'effect/package.json',
    '@module-federation/runtime/package.json',
  ];
  const program = `import { createRequire } from 'node:module';
    const packageVersion = (specifier: string) => { const load=createRequire(import.meta.url); return load(specifier).version; };
    packageVersion('@modern-js/plugin-bff/package.json'); packageVersion('effect/package.json'); packageVersion('@module-federation/runtime/package.json');`;
  expect(
    moduleEvidence(program)
      ?.map(({ staticSpecifier }) => staticSpecifier)
      .toSorted(),
  ).toEqual([...packages].toSorted());
  for (const unproven of [
    program.replace(secondCall, 'packageVersion(configured)'),
    program.replace('const packageVersion =', 'export const packageVersion ='),
    `${program} const escaped=packageVersion; void escaped;`,
    `${program} export { packageVersion };`,
    program.replace(secondCall, "(() => packageVersion('effect/package.json'))()"),
    `${program.replace('const packageVersion =', 'let packageVersion =')} packageVersion=()=>null;`,
  ]) {
    expect(moduleEvidence(unproven)?.some(({ staticSpecifier }) => staticSpecifier === null)).toBe(true);
  }
  expect(
    moduleEvidence(program.replace(secondCall, "packageVersion('./consent-access.ts')"))?.some(
      ({ staticSpecifier }) => staticSpecifier === './consent-access.ts',
    ),
  ).toBe(true);
});
