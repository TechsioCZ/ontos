import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { buildKnipModel } from '../../quality-audit/knip-model.mts';
import { runQualityAudit } from '../quality-audit.mts';

const indexModule = 'src/index.ts';
const rootSources = 'src/**/*.ts';
const reporterModule = 'quality-audit/knip-reporter.mts';
const summaryFile = 'summary.json';
const wireAliasKind = 'api-schema-alias';
const appRoot = path.resolve(import.meta.dirname, '../..');
const owner = 'verticals/receiver';
const consumer = `${owner}/tests/support/receiver.fixture.ts`;
const used = '@fixture/resolved';
const packageManifest = 'package.json';
const nativeResolverKind = 'native-resolver';
const literalSpecifier = "const specifier = '@fixture/resolved/testing';";
const tableSpecifierDeclaration = 'const specifier = entries[owner];';
const other = '@fixture/other';
const unused = '@fixture/unused';
const config = {
  workspaces: {
    '.': { entry: [indexModule], lefthook: false, node: false, project: [rootSources] },
    'verticals/*': {
      entry: ['tests/support/receiver.fixture.ts'],
      lefthook: false,
      node: false,
      project: ['**/*.ts', '!**/node_modules/**'],
    },
  },
};
const write = (root: string, file: string, source: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
};
const nativeImport = "import { createRequire } from 'node:module';";
const nativeResolve = "createRequire(new URL('../../package.json', import.meta.url)).resolve(specifier);";
const validSource = [
  nativeImport,
  "export function bundleOwner(owner: 'first' | 'second') {",
  "  const specifier = owner === 'first' ? '@fixture/resolved/testing' : '@fixture/other/testing';",
  `  return ${nativeResolve}`,
  '}',
].join('\n');
const fixture = Effect.fn(function* nativeResolverFixture() {
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => realpathSync(mkdtempSync(path.join(tmpdir(), 'ontos-native-resolver-')))),
    (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
  );
  symlinkSync(path.join(appRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  write(
    root,
    packageManifest,
    JSON.stringify({ name: 'native-resolver-controls', private: true, type: 'module', workspaces: ['verticals/*'] }),
  );
  write(
    root,
    indexModule,
    "import { bundleOwner } from '../verticals/receiver/tests/support/receiver.fixture.ts'; void bundleOwner('first'); void bundleOwner('second');",
  );
  write(
    root,
    `${owner}/package.json`,
    JSON.stringify(
      {
        devDependencies: { [other]: '1', [unused]: '1', [used]: '1' },
        name: '@fixture/receiver',
        private: true,
        type: 'module',
      },
      null,
      2,
    ),
  );
  for (const name of [used, other, unused]) {
    const directory = `${owner}/node_modules/${name}`;
    write(
      root,
      `${directory}/package.json`,
      JSON.stringify({
        exports: { './testing': './fixture.ts' },
        name,
        type: 'module',
      }),
    );
    write(root, `${directory}/fixture.ts`, 'export const receiver = 1; export const unusedNeighbor = 2;');
  }
  write(root, consumer, validSource);
  return root;
});
const model = (root: string) => buildKnipModel(root, config).pipe(Effect.provide(NodeServices.layer));

it.live(
  'native anchored conditional resolvers bind only their actual declared dependencies',
  Effect.fn(function* nativeResolverPositive() {
    const root = yield* fixture();
    const result = yield* model(root);
    const evidence = result.evidence.filter((fact) => fact.kind === nativeResolverKind);
    expect(new Set(evidence.map((fact) => fact.target))).toEqual(new Set([other, used]));
    expect(result.config.workspaces[owner]?.ignoreDependencies ?? []).toEqual([]);
    for (const fact of evidence) {
      expect(fact).toMatchObject({
        anchor: path.join(root, owner, packageManifest),
        declarationSource: `${owner}/package.json`,
        dependencyCategory: 'devDependencies',
        owningManifest: path.join(root, owner, packageManifest),
        source: consumer,
        workspace: owner,
      });
      expect(fact.line).toBe(4);
      expect(fact.resolved).toBe(path.join(root, owner, 'node_modules', fact.target, 'fixture.ts'));
    }
    expect(evidence.some((fact) => fact.target === unused)).toBe(false);
  }),
);

it.live(
  'native CCC protocol input proves its real declared public dependency without executing the protocol',
  Effect.fn(function* nativeResolverActualProtocol() {
    const root = yield* fixture();
    const cccOwner = 'verticals/commerce-customer-context';
    const manifestFile = `${cccOwner}/package.json`;
    const sourceFile = `${cccOwner}/tests/support/price-group-temporal-protocol.ts`;
    const dependency = '@app/price-group-catalog';
    const publicSubpath = `${dependency}/testing/price-group-current-receiver`;
    const source = readFileSync(path.join(appRoot, sourceFile), 'utf-8');
    const manifest = readFileSync(path.join(appRoot, manifestFile), 'utf-8');
    write(root, manifestFile, manifest);
    write(root, sourceFile, source);
    // Read the existing owner's installed public exports; never import its executable fixture.
    symlinkSync(path.join(appRoot, cccOwner, 'node_modules'), path.join(root, cccOwner, 'node_modules'), 'dir');
    const observed = (result: Effect.Success<ReturnType<typeof buildKnipModel>>) =>
      result.evidence.filter((fact) => fact.kind === nativeResolverKind && fact.source === sourceFile);
    const evidence = observed(yield* model(root));
    const manifestOffset = manifest.indexOf(`"${dependency}"`) + 1;
    const declarationLine = manifest.slice(0, manifestOffset).split('\n').length;
    const declarationColumn = manifestOffset - manifest.lastIndexOf('\n', manifestOffset - 1);
    const resolveLine = source.slice(0, source.indexOf('.resolve(specifier);')).split('\n').length;
    const bound = evidence.filter((fact) => fact.target === dependency);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({
      anchor: path.join(root, manifestFile),
      declarationColumn,
      declarationLine,
      declarationSource: manifestFile,
      dependencyCategory: 'devDependencies',
      line: resolveLine,
      owningManifest: path.join(root, manifestFile),
      resolved: realpathSync(
        path.join(
          appRoot,
          cccOwner,
          'node_modules',
          dependency,
          'tests/support/price-group-current-receiver.fixture.ts',
        ),
      ),
      source: sourceFile,
      specifier: publicSubpath,
      target: dependency,
      workspace: cccOwner,
    });
    // The schema-indexed owner annotation remains opaque; only the finite union lookup is proven.
    const indexedResolveLine = source.slice(0, source.indexOf('.resolve(ownerSpecifiers[owner]);')).split('\n').length;
    expect(evidence.some((fact) => fact.line === indexedResolveLine)).toBe(false);
    expect((yield* model(root)).config.workspaces[cccOwner]?.ignoreDependencies ?? []).not.toContain(dependency);
    const parseUse = 'URL.parse(value)';
    const variants = [
      source.replace(parseUse, 'URL["parse"](value)'),
      source.replace(parseUse, 'URL.parse?.(value)'),
      source.replace(parseUse, 'URL?.parse(value)'),
      `${source}\nURL.parse = fakeParse;`,
      `${source}\nglobalThis.URL = fakeURL;`,
      `${source}\nconst parseAlias = URL.parse;`,
      `${source}\nconst urlAlias = URL;`,
      `${source}\nescape(URL);`,
      `${source}\nescape(URL.parse);`,
      source.replace('    const specifier = specifiers[owner];', '    const specifier = specifiers[unknownOwner];'),
      source.replace(
        '    const specifier = specifiers[owner];',
        `    specifiers['price-group-catalog'] = '${publicSubpath}';\n    const specifier = specifiers[owner];`,
      ),
      source.replace(
        "    const entryPath = createRequire(new URL('../../package.json', import.meta.url))",
        "    const URL = fakeURL;\n    const entryPath = createRequire(new URL('../../package.json', import.meta.url))",
      ),
    ];
    for (const [index, variant] of variants.entries()) {
      expect(variant, `production control ${index} must change analyzer input`).not.toBe(source);
      write(root, sourceFile, variant);
      expect(observed(yield* model(root)), `production control ${index}`).toEqual([]);
    }
  }),
);

it.live(
  'native finite table resolvers prove only bounded immutable owner lookups',
  Effect.fn(function* nativeResolverTablePositive() {
    const root = yield* fixture();
    write(
      root,
      consumer,
      [
        nativeImport,
        "const first = 'first' as const;",
        "const entries = { [first]: '@fixture/resolved/testing', second: '@fixture/other/testing' } as const;",
        "export function bundleOwner(owner: typeof first | 'second') {",
        `  ${tableSpecifierDeclaration}`,
        `  return ${nativeResolve}`,
        '}',
      ].join('\n'),
    );
    const result = yield* model(root);
    const evidence = result.evidence.filter((fact) => fact.kind === nativeResolverKind);
    expect(new Set(evidence.map((fact) => fact.target))).toEqual(new Set([used, other]));
    for (const fact of evidence) {
      expect(fact).toMatchObject({
        anchor: path.join(root, owner, packageManifest),
        declarationSource: `${owner}/package.json`,
        dependencyCategory: 'devDependencies',
        owningManifest: path.join(root, owner, packageManifest),
        source: consumer,
        workspace: owner,
      });
      expect(fact.declarationLine).toBeGreaterThan(0);
      expect(fact.declarationColumn).toBeGreaterThan(0);
      expect(fact.resolved).toBe(path.join(root, owner, 'node_modules', fact.target, 'fixture.ts'));
    }
    expect(evidence.some((fact) => fact.target === unused)).toBe(false);
    expect(result.config.workspaces[owner]?.ignoreDependencies ?? []).toEqual([]);
  }),
);

it.live(
  'native finite table resolvers distinguish prototype setters from computed own properties',
  Effect.fn(function* nativeResolverPrototypeKey() {
    const root = yield* fixture();
    for (const key of ['__proto__', "'__proto__'", "['__proto__']"]) {
      write(
        root,
        consumer,
        [
          nativeImport,
          `const entries = { ${key}: '@fixture/resolved/testing' } as const;`,
          "export function bundleOwner(owner: '__proto__') {",
          tableSpecifierDeclaration,
          nativeResolve,
          '}',
        ].join('\n'),
      );
      const evidence = (yield* model(root)).evidence.filter((fact) => fact.kind === nativeResolverKind);
      if (key === "['__proto__']") {
        expect(evidence.map((fact) => fact.target)).toEqual([used]);
        expect(evidence[0]?.specifier).toBe('@fixture/resolved/testing');
      } else {
        expect(evidence, key).toEqual([]);
      }
    }
  }),
);

it.live(
  'native finite table resolvers reject escaped mutable and unknown key controls',
  Effect.fn(function* nativeResolverTableInvalid() {
    const root = yield* fixture();
    const table = "const entries = { first: '@fixture/resolved/testing', second: '@fixture/other/testing' } as const;";
    const indexedEntry = 'entries[owner]';
    const lookup = [
      "export function bundleOwner(owner: 'first' | 'second') {",
      tableSpecifierDeclaration,
      nativeResolve,
      '}',
    ].join('\n');
    const cases = [
      [table, 'escape(entries);', lookup],
      [table, 'escape({ entries });', lookup],
      [table, 'export { entries };', lookup],
      [table, 'export default entries;', lookup],
      [table, 'const alias = entries;', lookup],
      [table, 'entries.first = "@fixture/unused/testing";', lookup],
      [table, 'Object.assign(entries, { first: "@fixture/unused/testing" });', lookup],
      [table, 'delete entries.first;', lookup],
      [table, 'delete (entries.first as any);', lookup],
      [table, '({ value: entries.first } = input);', lookup],
      [table.replace('const entries', 'let entries'), lookup],
      [`export ${table}`, lookup],
      [table, lookup.replace("'first' | 'second'", 'string')],
      [table, lookup.replace("'first' | 'second'", "'first' | 'missing'")],
      [table, lookup.replace(indexedEntry, 'entries[unknownKey]')],
      [table, lookup.replace(indexedEntry, 'entries[entries[owner]]')],
      [
        table,
        lookup

          .replace('const specifier', "owner = 'missing'; const specifier"),
      ],
      [table.replace("first: '@fixture/resolved/testing'", '...unknownEntries'), lookup],
      [
        table.replace("first: '@fixture/resolved/testing'", "get first() { return '@fixture/resolved/testing'; }"),
        lookup,
      ],
      [table.replace("second: '@fixture/other/testing'", 'second: unknownSpecifier'), lookup],
      [table.replace("second: '@fixture/other/testing'", "first: '@fixture/other/testing'"), lookup],
    ];
    for (const [index, source] of cases.entries()) {
      write(root, consumer, [nativeImport, ...source].join('\n'));
      const result = yield* model(root);
      expect(
        result.evidence.filter((fact) => fact.kind === nativeResolverKind),
        `table control ${index}`,
      ).toEqual([]);
    }
  }),
);

it.live(
  'native resolver rejects nearby shadowed, mutable, unanchored and unresolved controls',
  Effect.fn(function* nativeResolverInvalid() {
    const root = yield* fixture();
    const cases = [
      [nativeImport, literalSpecifier, `function fake(createRequire: any) { ${nativeResolve} }`].join('\n'),
      [nativeImport, 'const URL = (value: string) => value;', literalSpecifier, nativeResolve].join('\n'),
      [
        nativeImport,
        "let specifier = '@fixture/resolved/testing';",
        "specifier = '@fixture/unused/testing';",
        nativeResolve,
      ].join('\n'),
      [nativeImport, literalSpecifier, nativeResolve.replace('../../package.json', '../../../../package.json')].join(
        '\n',
      ),
      [nativeImport, "const specifier = '@fixture/resolved/missing';", nativeResolve].join('\n'),
      [
        nativeImport,
        "const specifier = condition ? '@fixture/resolved/testing' : unknownSpecifier;",
        nativeResolve,
      ].join('\n'),
      [nativeImport, literalSpecifier, 'escape(createRequire);', nativeResolve].join('\n'),
      [nativeImport, literalSpecifier, 'globalThis.URL = fakeURL;', nativeResolve].join('\n'),
      [nativeImport, literalSpecifier].join('\n'),
      [nativeImport, literalSpecifier, `function fake() { var createRequire; ${nativeResolve} }`].join('\n'),
    ];
    for (const [index, source] of cases.entries()) {
      write(root, consumer, source);
      const result = yield* model(root);
      expect(
        result.evidence.filter((fact) => fact.kind === nativeResolverKind),
        `control ${index}`,
      ).toEqual([]);
      expect(result.config.workspaces[owner]?.ignoreDependencies ?? []).toEqual([]);
    }
    // Resolution succeeding through an undeclared installed package is insufficient.
    write(root, consumer, validSource);
    write(root, `${owner}/package.json`, JSON.stringify({ name: '@fixture/receiver', private: true }));
    const undeclared = yield* model(root);
    expect(undeclared.evidence.filter((fact) => fact.kind === nativeResolverKind)).toEqual([]);
  }),
);

it.live(
  'runner retains native dependency records and calibrates only the bound consumers',
  Effect.fn(function* nativeResolverNormalization() {
    const root = yield* fixture();
    const unboundOwner = 'verticals/unbound';
    write(
      root,
      `${unboundOwner}/${packageManifest}`,
      JSON.stringify({
        devDependencies: { [other]: '1', [used]: '1' },
        name: '@fixture/unbound',
        private: true,
        type: 'module',
      }),
    );
    write(root, `${unboundOwner}/tests/support/receiver.fixture.ts`, 'export const unrelated = 1;');
    write(
      root,
      'quality-audit/scope.json',
      JSON.stringify({
        exclude: ['**/node_modules/**'],
        patterns: [rootSources, 'verticals/**/*.ts'],
      }),
    );
    write(root, 'quality-audit/knip.json', JSON.stringify(config));
    write(root, reporterModule, readFileSync(path.join(appRoot, reporterModule), 'utf-8'));
    const output = path.join(root, '.reports');
    yield* runQualityAudit(root, output, 'knip').pipe(Effect.provide(NodeServices.layer));
    const json = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          results: Schema.Array(
            Schema.Struct({
              coverage: Schema.Struct({
                findingCounts: Schema.Record(Schema.String, Schema.Number),
                modeledFindingCounts: Schema.Record(Schema.String, Schema.Number),
                modeledUsages: Schema.Number,
                nativeFindingCounts: Schema.Record(Schema.String, Schema.Number),
              }),
              directory: Schema.String,
              name: Schema.String,
            }),
          ),
        }),
      ),
    );
    const summary = json(readFileSync(path.join(output, summaryFile), 'utf-8'));
    const knip = summary.results.find((result) => result.name === 'knip');
    expect(knip).toBeDefined();
    if (knip === undefined) {
      return;
    }
    expect(knip.coverage.modeledFindingCounts).toEqual({ devDependencies: 2 });
    expect(knip.coverage.modeledUsages).toBe(2);
    expect(knip.coverage.nativeFindingCounts.devDependencies).toBe(5);
    expect(knip.coverage.findingCounts.devDependencies).toBe(3);
    const usages = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Array(
          Schema.Struct({
            category: Schema.String,
            file: Schema.String,
            issue: Schema.Struct({ name: Schema.String }),
          }),
        ),
      ),
    )(readFileSync(path.join(knip.directory, 'modeled-usages.json'), 'utf-8'));
    expect(new Set(usages.map((usage) => usage.issue.name))).toEqual(new Set([other, used]));
    expect(
      usages.every((usage) => usage.category === 'devDependencies' && usage.file === `${owner}/package.json`),
    ).toBe(true);
    const native = readFileSync(path.join(knip.directory, 'report.ndjson'), 'utf-8');
    expect(native).toContain(used);
    expect(native).toContain(unused);
    // The unused neighbor and other workspace declarations stay native when the
    // actual loader loses its trusted anchor.
    write(root, consumer, validSource.replace('../../package.json', '../../../../package.json'));
    yield* runQualityAudit(root, output, 'knip').pipe(Effect.provide(NodeServices.layer));
    const [invalid] = json(readFileSync(path.join(output, summaryFile), 'utf-8')).results;
    expect(invalid?.coverage.modeledUsages).toBe(0);
    expect(invalid?.coverage.findingCounts.devDependencies).toBe(5);
  }),
);

const aliasFile = 'src/wire-contract.ts';
const apiExport = 'export const Api';
const aliasPresentation = 'export const present = (value: Basis) => value.value;';
const registeredAlias = [
  "import { Schema } from 'effect';",
  "import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';",
  'export const BasisSchema = Schema.Struct({ value: Schema.String });',
  'export type Basis = typeof BasisSchema.Type;',
  'export const ResponseSchema = BasisSchema;',
  'export const UnusedSchema = Schema.Struct({ stale: Schema.String });',
  'export const UnusedAliasSchema = UnusedSchema;',
  "export const Api = HttpApi.make('Api').add(HttpApiGroup.make('group').add(",
  "  HttpApiEndpoint.post('execute', '/read', { success: ResponseSchema }),",
  '));',
].join('\n');
const aliasConsumer = [
  "export { Api } from './wire-contract.ts';",
  "import type { Basis } from './wire-contract.ts';",
  aliasPresentation,
].join('\n');

it.live(
  'generated endpoint groups require a const path into an exported genuine API',
  Effect.fn(function* generatedGroupRegistration() {
    const root = yield* fixture();
    const groupFile = 'src/generated-action.ts';
    const groupAlias = 'const group: unknown = definition;';
    const groupSource = [
      "import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@modern-js/bff-effect/effect-client';",
      "import { ResponseSchema } from './action.ts';",
      "export const definition = HttpApiGroup.make('action').add(",
      "  HttpApiEndpoint.post('execute', '/action', { success: ResponseSchema }),",
      ').middleware(middleware);',
      'declare const middleware: never;',
      groupAlias,
      "export const Api = HttpApi.make('ActionApi').add(group);",
    ].join('\n');
    write(root, aliasFile, registeredAlias.slice(0, registeredAlias.indexOf(apiExport)));
    write(root, 'src/action.ts', "export { ResponseSchema } from './wire-contract.ts';");
    write(root, groupFile, groupSource);
    // Keep the schema-derived type consumer linked to its actual declaration.
    write(
      root,
      indexModule,
      [
        "export { Api } from './generated-action.ts';",
        "import type { Basis } from './wire-contract.ts';",
        aliasPresentation,
      ].join('\n'),
    );
    const positive = yield* model(root);
    expect(positive.evidence.filter((fact) => fact.kind === wireAliasKind)).toHaveLength(1);
    const shadowedGroup = groupSource.replace(groupAlias, `${groupAlias} function hidden(group: unknown) {`);
    const controls = [
      groupSource.replace('const group: unknown', 'let group: unknown'),
      groupSource.replace('.add(group);', '.add(other);'),
      groupSource.replace(groupAlias, 'const group: unknown = cycle; const cycle = group;'),
      groupSource.replace("'@modern-js/bff-effect/effect-client'", "'./counterfeit.ts'"),
      groupSource.replace(apiExport, 'const Api'),
      groupSource.replace("HttpApi.make('ActionApi')", "fake.make('ActionApi')"),
      groupSource
        .replace("HttpApiGroup.make('action').add(", "discard(HttpApiGroup.make('action').add(")
        .replace(').middleware(middleware);', ').middleware(middleware));'),
      groupSource.replace('.middleware(middleware)', '.unknown(middleware)'),
      groupSource.replace("HttpApiGroup.make('action').add(", "HttpApiGroup.make('action', "),
      `${shadowedGroup}\n}`,
    ];
    for (const [index, source] of controls.entries()) {
      write(root, groupFile, source);
      const invalid = yield* model(root);
      expect(
        invalid.evidence.filter((fact) => fact.kind === wireAliasKind),
        `group control ${index}`,
      ).toEqual([]);
    }
  }),
);

it.live(
  'wire aliases require a genuine registered endpoint and an actual schema-derived type consumer',
  Effect.fn(function* wireAliasProof() {
    const root = yield* fixture();
    write(root, aliasFile, registeredAlias);
    write(root, indexModule, aliasConsumer);
    const result = yield* model(root);
    const aliases = result.evidence.filter((fact) => fact.kind === wireAliasKind);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]?.aliasMembers?.map((member) => member.name)).toEqual(['BasisSchema', 'ResponseSchema']);
    expect(aliases[0]?.reason).toContain('endpoint success');
    expect(aliases[0]?.reason).toContain('consumes exported schema-derived type Basis');
    expect(result.config.workspaces['.']?.ignoreIssues ?? {}).toEqual({});
  }),
);

it.live(
  'nearby invalid wire aliases remain findings for counterfeit, shadowed and unregistered endpoints',
  Effect.fn(function* wireAliasControls() {
    const root = yield* fixture();
    const controls = [
      registeredAlias.replace("'effect/http-api'", "'./lookalike.ts'"),
      `${registeredAlias.slice(0, registeredAlias.indexOf(apiExport))}HttpApiEndpoint.post('execute', '/read', { success: ResponseSchema });`,
      registeredAlias.replace('HttpApiEndpoint.post', 'HttpApiEndpoint.unknown'),
      registeredAlias.replace('success: ResponseSchema', 'success: BasisSchema'),
      registeredAlias.replace('Schema.Struct({ value: Schema.String })', '({ value: "fake" })'),
      `${registeredAlias.replace(
        "export const Api = HttpApi.make('Api').add(HttpApiGroup.make('group').add(",
        "function hidden(HttpApiEndpoint: unknown) { return HttpApi.make('Api').add(HttpApiGroup.make('group').add(",
      )}\n}`,
    ];
    write(root, indexModule, aliasConsumer);
    for (const [index, source] of controls.entries()) {
      write(root, aliasFile, source);
      const result = yield* model(root);
      expect(
        result.evidence.filter((fact) => fact.kind === wireAliasKind),
        'wire control '.concat(String(index)),
      ).toEqual([]);
    }
    write(root, aliasFile, registeredAlias);
    write(root, indexModule, aliasConsumer.replace(aliasPresentation, 'export const unused = 1;'));
    const unusedTypeImport = yield* model(root);
    expect(unusedTypeImport.evidence.filter((fact) => fact.kind === wireAliasKind)).toEqual([]);
  }),
);

it.live(
  'wire alias calibration matches only the exact native duplicate group and retains its unused neighbor',
  Effect.fn(function* wireAliasNormalization() {
    const root = yield* fixture();
    write(root, aliasFile, registeredAlias);
    write(root, indexModule, aliasConsumer);
    write(
      root,
      'quality-audit/scope.json',
      JSON.stringify({
        exclude: ['**/node_modules/**'],
        patterns: [rootSources, 'verticals/**/*.ts'],
      }),
    );
    write(root, 'quality-audit/knip.json', JSON.stringify(config));
    write(root, reporterModule, readFileSync(path.join(appRoot, reporterModule), 'utf-8'));
    const output = path.join(root, '.reports');
    yield* runQualityAudit(root, output, 'knip').pipe(Effect.provide(NodeServices.layer));
    const decode = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          results: Schema.Array(
            Schema.Struct({
              coverage: Schema.Struct({
                findingCounts: Schema.Record(Schema.String, Schema.Number),
                modeledFindingCounts: Schema.Record(Schema.String, Schema.Number),
                nativeFindingCounts: Schema.Record(Schema.String, Schema.Number),
              }),
              directory: Schema.String,
            }),
          ),
        }),
      ),
    );
    const [report] = decode(readFileSync(path.join(output, summaryFile), 'utf-8')).results;
    expect(report?.coverage.nativeFindingCounts.duplicates).toBe(2);
    expect(report?.coverage.findingCounts.duplicates).toBe(1);
    expect(report?.coverage.modeledFindingCounts.duplicates).toBe(1);
    if (report === undefined) {
      throw new Error('Expected Knip report');
    }
    expect(readFileSync(path.join(report.directory, 'report.ndjson'), 'utf-8')).toContain('UnusedAliasSchema');
    write(root, aliasFile, registeredAlias.replace('success: ResponseSchema', 'success: BasisSchema'));
    yield* runQualityAudit(root, output, 'knip').pipe(Effect.provide(NodeServices.layer));
    const [invalid] = decode(readFileSync(path.join(output, summaryFile), 'utf-8')).results;
    expect(invalid?.coverage.findingCounts.duplicates).toBe(2);
    expect(invalid?.coverage.modeledFindingCounts.duplicates ?? 0).toBe(0);
  }),
);
