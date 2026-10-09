import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createModuleGraph } from '@modern-js/code-tools/microvertical-api-boundary';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { unconstrainedHttpApiContractSchemas } from '../api-contract-schema-rules.mts';

const contractApiFixturePath = 'verticals/catalog/src/contracts/api.ts';
const contractBarrelFixturePath = 'verticals/catalog/src/contracts/barrel.ts';
const unsafeContractFixturePath = 'verticals/catalog/src/contracts/unsafe.ts';
const packageFixturePath = 'packages/example/package.json';
const packageSafeFixturePath = 'packages/example/src/safe.ts';
const packageUnsafeFixturePath = 'packages/example/src/unsafe.ts';

const write = Effect.fn(function* writeFixture(root: string, file: string, content: string) {
  const target = path.join(root, file);
  yield* Effect.promise(() => mkdir(path.dirname(target), { recursive: true }));
  yield* Effect.promise(() => writeFile(target, content));
});

/**
 * Prepends the imports most fixture snippets need to resolve `HttpApiEndpoint`, `Schema`, and the
 * Problem Details factories as real bindings instead of unimported globals. Callers whose snippet
 * declares one of these names locally (shadow/namespace/enum fixtures) must not wrap with this.
 */
const withImports = (source: string): string =>
  `import { HttpApiEndpoint } from 'effect/unstable/httpapi';
import { Schema } from 'effect';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts';
${source}`;

/**
 * A fresh temp workspace with `@app/shared-contracts` linked (Problem Details factories are only
 * recognized when declared under `/packages/shared-contracts/`) and every `packages/<name>` fixture
 * referenced by `files` linked into `node_modules/@app/<name>`, following the old resolver's
 * `@app/<name>/<subpath>` -> `packages/<name>/src/<subpath>.ts` convention unless a test supplies an
 * explicit `package.json`.
 */
const createWorkspace = Effect.fn(function* buildWorkspace(files: ReadonlyMap<string, string>) {
  const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'api-contract-schema-rules-')));
  yield* write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - verticals/*\n');

  const defaults = new Map<string, string>([
    [
      'packages/shared-contracts/package.json',
      JSON.stringify({
        exports: { '.': './src/index.ts', './problem-details': './src/problem-details.ts' },
        name: '@app/shared-contracts',
      }),
    ],
    [
      'packages/shared-contracts/src/problem-details.ts',
      `export const makeProblemDetailsSchema = (name, status, extensions) => ({ name, status, extensions });
export const makeRetryableProblemDetailsSchema = (name, status, extensions) => ({ name, status, extensions });
`,
    ],
    [
      'packages/shared-contracts/src/index.ts',
      `export { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from './problem-details';`,
    ],
  ]);
  for (const [file, content] of defaults) {
    if (!files.has(file)) {
      yield* write(root, file, content);
    }
  }
  for (const [file, content] of files) {
    yield* write(root, file, content);
  }

  const packageDirs = new Set<string>(['shared-contracts']);
  for (const file of files.keys()) {
    const match = /^packages\/(?<name>[^/]+)\//u.exec(file);
    if (match?.groups?.name !== undefined) {
      packageDirs.add(match.groups.name);
    }
  }
  for (const name of packageDirs) {
    const packageJsonPath = `packages/${name}/package.json`;
    if (!files.has(packageJsonPath) && !defaults.has(packageJsonPath)) {
      yield* write(root, packageJsonPath, JSON.stringify({ exports: { './*': './src/*.ts' }, name: `@app/${name}` }));
    }
    yield* Effect.promise(() => mkdir(path.join(root, 'node_modules/@app'), { recursive: true }));
    yield* Effect.promise(() =>
      symlink(path.join(root, 'packages', name), path.join(root, 'node_modules/@app', name), 'dir'),
    );
  }
  return root;
});

/** Runs the rule against `file` inside a fresh temp workspace built from `files`, cleaned up on exit. */
const violation = (files: ReadonlyMap<string, string>, file: string = contractApiFixturePath) =>
  Effect.acquireUseRelease(
    createWorkspace(files),
    (root) =>
      Effect.sync(() => {
        const graph = createModuleGraph();
        const module = graph.module(path.join(root, file));
        const messages = unconstrainedHttpApiContractSchemas({ file, graph, module });
        return messages.length > 0 ? messages.join(' ') : undefined;
      }),
    (root) => Effect.promise(() => rm(root, { force: true, recursive: true })),
  );

/** `violation` for the common single-file case. */
const violationOf = (content: string, file: string = contractApiFixturePath) =>
  violation(new Map([[file, content]]), file);

it.live(
  'requires concrete HttpApi contract schemas through Problem Details helpers',
  Effect.fn(function* scenario1() {
    expect(
      yield* violationOf(
        withImports(`
        const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
          field: Schema.String,
        });
      `),
      ),
    ).toBe(undefined);
    expect(
      (yield* violationOf(
        withImports(`
        const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
          field: Schema.Unknown,
        });
      `),
      )) ?? '',
    ).toMatch(/must use concrete/u);
    expect(
      (yield* violationOf(
        withImports(`
        HttpApiEndpoint.post('execute', '/reads/example', {
          success: Schema.Any,
        });
      `),
      )) ?? '',
    ).toMatch(/must use concrete/u);
    expect(
      (yield* violationOf(
        withImports(`
        const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
          diagnostics: Schema.Record(Schema.String, Schema.String),
        });
      `),
      )) ?? '',
    ).toMatch(/must use concrete/u);
    expect(
      (yield* violationOf(
        withImports(`
        const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, {
          diagnostics: Schema.Json,
        });
      `),
      )) ?? '',
    ).toMatch(/must use concrete/u);
  }),
);

it.live(
  'follows imported payload, query, parameter, success, and error schemas',
  Effect.fn(function* scenario2() {
    for (const member of ['payload', 'query', 'urlParams', 'success', 'error']) {
      const files = new Map([
        [
          contractApiFixturePath,
          withImports(`
          import { UnsafeSchema } from './unsafe';
          HttpApiEndpoint.post('execute', '/reads/example', { ${member}: UnsafeSchema });
        `),
        ],
        [
          unsafeContractFixturePath,
          withImports(`export const UnsafeSchema = Schema.Struct({ nested: Schema.Unknown });`),
        ],
      ]);
      expect((yield* violation(files)) ?? '', member).toMatch(/must use concrete/u);
    }
  }),
);

it.live(
  'covers every supported endpoint constructor through direct and aliased paths',
  Effect.fn(function* scenario3() {
    for (const method of ['delete', 'head', 'options']) {
      expect(
        (yield* violationOf(
          withImports(`
          HttpApiEndpoint.${method}('execute', '/reads/example', { success: Schema.Any });
        `),
        )) ?? '',
        method,
      ).toMatch(/must use concrete/u);
    }

    expect(
      (yield* violationOf(
        withImports(`
        const inspectHeaders = HttpApiEndpoint.head;
        inspectHeaders('execute', '/reads/example', { success: Schema.Unknown });
      `),
      )) ?? '',
    ).toMatch(/must use concrete/u);

    const files = new Map([
      [
        contractApiFixturePath,
        withImports(`
        import { ReexportedEndpoint } from './barrel';
        ReexportedEndpoint.options('execute', '/reads/example', { success: Schema.Any });
      `),
      ],
      [contractBarrelFixturePath, `export { HttpApiEndpoint as ReexportedEndpoint } from 'effect/unstable/httpapi';`],
    ]);
    expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
  }),
);

it.live(
  'follows HttpApiEndpoint.make factories through local and imported helpers',
  Effect.fn(function* scenario4() {
    for (const source of [
      `
      HttpApiEndpoint.make('GET')('execute', '/reads/example', { success: Schema.Any });
    `,
      `
      const endpoint = HttpApiEndpoint.make('GET');
      endpoint('execute', '/reads/example', { success: Schema.Any });
    `,
      `
      const makeEndpoint = () => HttpApiEndpoint.make('GET');
      makeEndpoint()('execute', '/reads/example', { success: Schema.Any });
    `,
    ]) {
      expect((yield* violationOf(withImports(source))) ?? '').toMatch(/must use concrete/u);
    }

    const files = new Map([
      [
        contractApiFixturePath,
        withImports(`
        import { makeEndpoint } from './barrel';
        makeEndpoint()('execute', '/reads/example', { success: Schema.Unknown });
      `),
      ],
      [contractBarrelFixturePath, `export { makeEndpoint } from './unsafe';`],
      [
        unsafeContractFixturePath,
        `import { HttpApiEndpoint } from 'effect/unstable/httpapi';
        export function makeEndpoint() {
          return HttpApiEndpoint.make('GET');
        }
      `,
      ],
    ]);
    expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
  }),
);

it.live(
  'follows the direct HttpApiEndpoint provider through verbs, make, and re-exports',
  Effect.fn(function* scenario5() {
    const provider = 'effect/unstable/httpapi/HttpApiEndpoint';
    for (const method of ['delete', 'get', 'head', 'options', 'patch', 'post', 'put']) {
      const entry = withImports(`
      import * as Endpoint from '${provider}';
      Endpoint.${method}('execute', '/reads/example', { success: Schema.Any });
    `);
      expect((yield* violation(new Map([[contractApiFixturePath, entry]]))) ?? '', method).toMatch(
        /must use concrete/u,
      );
    }

    const makeEntry = withImports(`
    import { Endpoint } from './barrel';
    Endpoint.make('GET')('execute', '/reads/example', { success: Schema.Unknown });
  `);
    const makeFiles = new Map([
      [contractApiFixturePath, makeEntry],
      [contractBarrelFixturePath, `export * as Endpoint from '${provider}';`],
    ]);
    expect((yield* violation(makeFiles)) ?? '').toMatch(/must use concrete/u);

    const namespaceEntry = withImports(`
    import { Endpoint } from './barrel';
    Endpoint.get('execute', '/reads/example', { success: Schema.Any });
  `);
    const namespaceFiles = new Map([
      [contractApiFixturePath, namespaceEntry],
      [contractBarrelFixturePath, `export * as Endpoint from '${provider}';`],
    ]);
    expect((yield* violation(namespaceFiles)) ?? '').toMatch(/must use concrete/u);
  }),
);

it.live(
  'follows local and imported function helpers used as public schemas',
  Effect.fn(function* scenario6() {
    expect(
      (yield* violationOf(
        withImports(`
        function unsafeResponse() {
          return Schema.Any;
        }
        HttpApiEndpoint.get('read', '/reads/example', { success: unsafeResponse() });
      `),
      )) ?? '',
    ).toMatch(/must use concrete/u);

    const files = new Map([
      [
        contractApiFixturePath,
        withImports(`
        import { unsafeExtensions } from './unsafe';
        makeProblemDetailsSchema('InvalidProblem', 400, unsafeExtensions());
      `),
      ],
      [
        unsafeContractFixturePath,
        `import { Schema } from 'effect';
        export function unsafeExtensions() {
          return { diagnostics: Schema.Record(Schema.String, Schema.String) };
        }
      `,
      ],
    ]);
    expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
  }),
);

it.live(
  'follows imported arbitrary Problem Details extension records',
  Effect.fn(function* scenario7() {
    const files = new Map([
      [
        contractApiFixturePath,
        withImports(`
        import { UnsafeExtensions } from './barrel';
        const InvalidProblem = makeProblemDetailsSchema('InvalidProblem', 400, UnsafeExtensions);
      `),
      ],
      [
        unsafeContractFixturePath,
        `import { Schema } from 'effect';
      export const ExtensionFields = { diagnostics: Schema.Record(Schema.String, Schema.String) };`,
      ],
      [contractBarrelFixturePath, `export { ExtensionFields as UnsafeExtensions } from './unsafe';`],
    ]);
    expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
  }),
);

it.live(
  'follows transitive imported schema aliases without rejecting unused unsafe exports',
  Effect.fn(function* scenario8() {
    const files = new Map([
      [
        contractApiFixturePath,
        withImports(`
        import { PublicResponse } from './public-response';
        HttpApiEndpoint.get('read', '/reads/example', { success: PublicResponse });
      `),
      ],
      [
        'verticals/catalog/src/contracts/public-response.ts',
        `import { Schema } from 'effect';
        import { InternalResponse } from './internal-response';
        export const PublicResponse = InternalResponse;
        export const UnusedUnsafeResponse = Schema.Any;
      `,
      ],
      [
        'verticals/catalog/src/contracts/internal-response.ts',
        `import { Schema } from 'effect'; export const InternalResponse = Schema.Json;`,
      ],
    ]);
    expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);

    const safeFiles = new Map([
      ...files,
      [
        'verticals/catalog/src/contracts/internal-response.ts',
        `import { Schema } from 'effect'; export const InternalResponse = Schema.Struct({ value: Schema.String });`,
      ] as const,
    ]);
    expect(yield* violation(safeFiles)).toBe(undefined);
  }),
);

it.live(
  'rejects Effect Schema namespace aliases and destructured unsafe members',
  Effect.fn(function* scenario9() {
    for (const unsafeSource of [
      `
      import { Schema as S } from 'effect';
      export const UnsafeSchema = S.Struct({ nested: S.Unknown });
    `,
      `
      import * as Effect from 'effect';
      const S = Effect.Schema;
      export const UnsafeSchema = S.Any;
    `,
      `
      import { Schema } from 'effect';
      const { Json: UnsafeJson } = Schema;
      export const UnsafeSchema = UnsafeJson;
    `,
    ]) {
      const files = new Map([
        [
          contractApiFixturePath,
          withImports(`
          import { UnsafeSchema } from './unsafe';
          HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
        `),
        ],
        [unsafeContractFixturePath, unsafeSource],
      ]);
      expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
    }
  }),
);

it.live(
  'follows barrel re-exports and relative namespace imports',
  Effect.fn(function* scenario10() {
    for (const entrySource of [
      `
      import { UnsafeSchema } from './barrel';
      HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
    `,
      `
      import * as Schemas from './unsafe';
      HttpApiEndpoint.get('read', '/reads/example', { success: Schemas.UnsafeSchema });
    `,
    ]) {
      const files = new Map([
        [contractApiFixturePath, withImports(entrySource)],
        [contractBarrelFixturePath, `export { UnsafeSchema } from './unsafe';`],
        [unsafeContractFixturePath, `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Any;`],
      ]);
      expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
    }
  }),
);

it.live(
  'follows local re-exports of imported schemas',
  Effect.fn(function* scenario11() {
    const files = new Map([
      [
        contractApiFixturePath,
        withImports(`
        import { PublicSchema } from './barrel';
        HttpApiEndpoint.get('read', '/reads/example', { success: PublicSchema });
      `),
      ],
      [
        contractBarrelFixturePath,
        `
        import { UnsafeSchema } from './unsafe';
        export { UnsafeSchema as PublicSchema };
      `,
      ],
      [unsafeContractFixturePath, `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Any;`],
    ]);
    expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
  }),
);

it.live(
  'rejects direct Effect schema imports used through an aliased endpoint factory',
  Effect.fn(function* scenario12() {
    const content = `
    import { HttpApiEndpoint as Endpoint } from '@modern-js/bff-effect/effect-client';
    import { Any as UnsafeSchema } from 'effect/Schema';
    Endpoint.get('read', '/reads/example', { success: UnsafeSchema });
  `;
    expect((yield* violationOf(content)) ?? '').toMatch(/must use concrete/u);
  }),
);

it.live(
  'follows schemas imported through @app package subpaths',
  Effect.fn(function* scenario13() {
    const files = new Map([
      [
        contractApiFixturePath,
        withImports(`
        import { UnsafeSchema } from '@app/example/unsafe';
        HttpApiEndpoint.get('read', '/reads/example', {
          success: UnsafeSchema,
        });
      `),
      ],
      [packageUnsafeFixturePath, `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Any;`],
    ]);
    expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
  }),
);

it.live(
  'follows star barrels, default imports, and package export maps',
  Effect.fn(function* scenario14() {
    const fixtures: readonly {
      readonly entry: string;
      readonly extraFiles: readonly (readonly [string, string])[];
    }[] = [
      {
        entry: withImports(`
        import { UnsafeSchema } from './barrel';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `),
        extraFiles: [
          [contractBarrelFixturePath, `export * from './unsafe';`],
          [unsafeContractFixturePath, `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Any;`],
        ],
      },
      {
        entry: withImports(`
        import UnsafeSchema from './unsafe';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `),
        extraFiles: [[unsafeContractFixturePath, `import { Schema } from 'effect'; export default Schema.Json;`]],
      },
      {
        entry: withImports(`
        import { UnsafeSchema } from '@app/example/api';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `),
        extraFiles: [
          [packageFixturePath, `{"name":"@app/example","exports":{"./api":"./shared/unsafe.ts"}}`],
          [
            'packages/example/shared/unsafe.ts',
            `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Unknown;`,
          ],
        ],
      },
    ];
    for (const fixture of fixtures) {
      const files = new Map<string, string>([[contractApiFixturePath, fixture.entry], ...fixture.extraFiles]);
      expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
    }
  }),
);

it.live(
  'covers ordinary endpoint aliases and TypeScript module forms',
  Effect.fn(function* scenario15() {
    for (const content of [
      withImports(`
      const Endpoint = HttpApiEndpoint;
      Endpoint.get('read', '/reads/example', { success: Schema.Any });
    `),
      withImports(`
      import * as S from 'effect/Schema';
      HttpApiEndpoint.get('read', '/reads/example', { success: S.Unknown });
    `),
      `
      import { HttpApiEndpoint, Schema as S } from '@modern-js/bff-effect/effect-client';
      HttpApiEndpoint.get('read', '/reads/example', { success: S.Any });
    `,
    ]) {
      expect((yield* violationOf(content)) ?? '').toMatch(/must use concrete/u);
    }

    const fixtures: readonly (readonly [string, ReadonlyMap<string, string>])[] = [
      [
        withImports(`
        import SafeDefault, { UnsafeSchema } from './unsafe';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `),
        new Map([
          [
            unsafeContractFixturePath,
            `import { Schema } from 'effect'; export default Schema.String; export const UnsafeSchema = Schema.Any;`,
          ],
        ]),
      ],
      [
        withImports(`
        import { Schemas } from './barrel';
        HttpApiEndpoint.get('read', '/reads/example', { success: Schemas.UnsafeSchema });
      `),
        new Map([
          [contractBarrelFixturePath, `export * as Schemas from './unsafe';`],
          [unsafeContractFixturePath, `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Unknown;`],
        ]),
      ],
      [
        withImports(`
        import { UnsafeSchema } from '@app/example/api';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `),
        new Map([
          [
            packageFixturePath,
            `{"name":"@app/example","exports":{"./api":{"types":"./src/unsafe.d.ts","default":"./src/unsafe.ts"}}}`,
          ],
          ['packages/example/src/unsafe.d.ts', `export const UnsafeSchema: unknown;`],
          [packageUnsafeFixturePath, `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Any;`],
        ]),
      ],
      [
        withImports(`
        import { UnsafeSchema } from '@app/example/unsafe';
        HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
      `),
        new Map([
          [packageFixturePath, `{"name":"@app/example","exports":{"./*":{"default":"./src/*.ts"}}}`],
          [packageUnsafeFixturePath, `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Unknown;`],
        ]),
      ],
    ];
    for (const [entry, extraFiles] of fixtures) {
      const files = new Map([[contractApiFixturePath, entry], ...extraFiles]);
      expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
    }
  }),
);

it.live(
  'covers destructured, computed, and provenance-safe aliases',
  Effect.fn(function* scenario16() {
    for (const content of [
      withImports(`
      const { get } = HttpApiEndpoint;
      get('read', '/reads/example', { success: Schema.Any });
    `),
      withImports(`HttpApiEndpoint['get']('read', '/reads/example', { success: Schema.Unknown });`),
      `
      import * as Effect from 'effect';
      import { HttpApiEndpoint } from 'effect/unstable/httpapi';
      const { Schema: S } = Effect;
      HttpApiEndpoint.get('read', '/reads/example', { success: S.Json });
    `,
      `
      import * as Problems from '@app/shared-contracts/problem-details';
      const { makeProblemDetailsSchema: factory } = Problems;
      import { Schema } from 'effect';
      factory('InvalidProblem', 400, { values: Schema.Record(Schema.String, Schema.String) });
    `,
    ]) {
      expect((yield* violationOf(content)) ?? '').toMatch(/must use concrete/u);
    }

    expect(
      yield* violationOf(`
      const Schema = { Any: 'not an Effect schema' };
      const HttpApiEndpoint = { get: () => undefined };
      HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
      const makeProblemDetailsSchema = () => undefined;
      makeProblemDetailsSchema('SafeLocalCall', 400, { value: Schema.Any });
    `),
    ).toBe(undefined);
    expect(
      yield* violationOf(
        withImports(`
        HttpApiEndpoint.get('read', '/reads/example', {
          success: Schema.Record(Schema.String, Schema.String),
        });
      `),
      ),
    ).toBe(undefined);
  }),
);

it.live(
  'resolves recursive namespace exports for endpoints, factories, and schemas',
  Effect.fn(function* scenario17() {
    const commonFiles = new Map<string, string>([
      [
        contractBarrelFixturePath,
        `
        export * as Problems from './factories';
        export * as Http from './http';
        export * as Schemas from './unsafe';
      `,
      ],
      [
        'verticals/catalog/src/contracts/factories.ts',
        `export { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';`,
      ],
      ['verticals/catalog/src/contracts/http.ts', `export { HttpApiEndpoint } from 'effect/unstable/httpapi';`],
      [unsafeContractFixturePath, `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Unknown;`],
    ]);
    for (const entry of [
      `
      import { Problems } from './barrel';
      import { Schema } from 'effect';
      Problems.makeProblemDetailsSchema('InvalidProblem', 400, { field: Schema.Any });
    `,
      `
      import { Problems } from './barrel';
      import { Schema } from 'effect';
      Problems.makeRetryableProblemDetailsSchema('InvalidProblem', 503, { field: Schema.Json });
    `,
      `
      import { Http } from './barrel';
      import { Schema } from 'effect';
      Http.HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
    `,
      `
      import * as Barrel from './barrel';
      import { HttpApiEndpoint } from 'effect/unstable/httpapi';
      HttpApiEndpoint.get('read', '/reads/example', { success: Barrel.Schemas.UnsafeSchema });
    `,
      `
      import { Renamed } from './renamed';
      import { Schema } from 'effect';
      Renamed.makeProblemDetailsSchema('InvalidProblem', 400, { field: Schema.Unknown });
    `,
    ]) {
      const files = new Map([
        ...commonFiles,
        [contractApiFixturePath, entry] as const,
        ['verticals/catalog/src/contracts/renamed.ts', `export { Problems as Renamed } from './barrel';`] as const,
      ]);
      expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
    }
  }),
);

it.live(
  'resolves lexical shadows without inspecting unused inner bindings',
  Effect.fn(function* scenario18() {
    expect(
      (yield* violationOf(
        withImports(`
        const ResponseSchema = Schema.Any;
        { const ResponseSchema = Schema.String; void ResponseSchema; }
        HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
      `),
      )) ?? '',
    ).toMatch(/must use concrete/u);
    expect(
      yield* violationOf(
        withImports(`
        const ResponseSchema = Schema.String;
        { const ResponseSchema = Schema.Any; void ResponseSchema; }
        HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
      `),
      ),
    ).toBe(undefined);
  }),
);

it.live(
  'evaluates package export conditions, wildcard specificity, and null exclusions',
  Effect.fn(function* scenario19() {
    const fixtures: readonly (readonly [string, ReadonlyMap<string, string>])[] = [
      [
        '@app/example/api',
        new Map([
          [
            packageFixturePath,
            `{"name":"@app/example","exports":{"./api":{"types":"./src/safe.d.ts","default":"./src/unsafe.ts"}}}`,
          ],
          ['packages/example/src/safe.d.ts', `export const UnsafeSchema: unknown;`],
          [packageUnsafeFixturePath, `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Any;`],
        ]),
      ],
      [
        '@app/example/api/schema',
        new Map([
          [
            packageFixturePath,
            `{"name":"@app/example","exports":{"./*":"./src/safe.ts","./api/*":"./src/unsafe/*.ts"}}`,
          ],
          [packageSafeFixturePath, `import { Schema } from 'effect'; export const UnsafeSchema = Schema.String;`],
          [
            'packages/example/src/unsafe/schema.ts',
            `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Unknown;`,
          ],
        ]),
      ],
      [
        '@app/example/api',
        new Map([
          [packageFixturePath, `{"name":"@app/example","exports":{"./blocked":null,"./api":"./unusual/unsafe.ts"}}`],
          [
            'packages/example/unusual/unsafe.ts',
            `import { Schema } from 'effect'; export const UnsafeSchema = Schema.Json;`,
          ],
        ]),
      ],
    ];
    for (const [specifier, extraFiles] of fixtures) {
      const entry = withImports(`
      import { UnsafeSchema } from '${specifier}';
      HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
    `);
      const files = new Map([[contractApiFixturePath, entry], ...extraFiles]);
      expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
    }

    const safeEntry = withImports(`
    import { ResponseSchema } from '@app/example/api';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `);
    const safeFiles = new Map([
      [contractApiFixturePath, safeEntry],
      [packageFixturePath, `{"name":"@app/example","exports":{"./api":"./src/safe.ts"}}`],
      [packageSafeFixturePath, `import { Schema } from 'effect'; export const ResponseSchema = Schema.String;`],
      ['packages/example/src/api.ts', `import { Schema } from 'effect'; export const ResponseSchema = Schema.Any;`],
    ]);
    expect(yield* violation(safeFiles)).toBe(undefined);

    const specificEntry = withImports(`
    import { ResponseSchema } from '@app/example/foo/bar';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `);
    const specificFiles = new Map([
      [contractApiFixturePath, specificEntry],
      [packageFixturePath, `{"name":"@app/example","exports":{"./foo/*":"./src/safe.ts","./*/bar":"./src/unsafe.ts"}}`],
      [packageSafeFixturePath, `import { Schema } from 'effect'; export const ResponseSchema = Schema.String;`],
      [packageUnsafeFixturePath, `import { Schema } from 'effect'; export const ResponseSchema = Schema.Any;`],
    ]);
    expect(yield* violation(specificFiles)).toBe(undefined);
  }),
);

it.live(
  'terminates on safe and unsafe cyclic re-exports',
  Effect.fn(function* scenario20() {
    const entry = withImports(`
    import { ResponseSchema } from './cycle-a';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `);
    const safeFiles = new Map([
      [contractApiFixturePath, entry],
      ['verticals/catalog/src/contracts/cycle-a.ts', `export * from './cycle-b';`],
      [
        'verticals/catalog/src/contracts/cycle-b.ts',
        `import { Schema } from 'effect'; export * from './cycle-a'; export const ResponseSchema = Schema.String;`,
      ],
    ]);
    expect(yield* violation(safeFiles)).toBe(undefined);
    const unsafeFiles = new Map([
      ...safeFiles,
      [
        'verticals/catalog/src/contracts/cycle-b.ts',
        `import { Schema } from 'effect'; export * from './cycle-a'; export const ResponseSchema = Schema.Any;`,
      ] as const,
    ]);
    expect((yield* violation(unsafeFiles)) ?? '').toMatch(/must use concrete/u);
  }),
);

it.live(
  'honors explicit export precedence and star-export binding identity',
  Effect.fn(function* scenario21() {
    const entry = withImports(`
    import { ResponseSchema } from './barrel';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `);
    const explicitFiles = new Map([
      [contractApiFixturePath, entry],
      [contractBarrelFixturePath, `export { SafeSchema as ResponseSchema } from './safe'; export * from './unsafe';`],
      [
        'verticals/catalog/src/contracts/safe.ts',
        `import { Schema } from 'effect'; export const SafeSchema = Schema.String;`,
      ],
      [unsafeContractFixturePath, `import { Schema } from 'effect'; export const ResponseSchema = Schema.Any;`],
    ]);
    expect(yield* violation(explicitFiles)).toBe(undefined);

    const diamondFiles = new Map([
      [contractApiFixturePath, entry],
      [contractBarrelFixturePath, `export * from './left'; export * from './right';`],
      ['verticals/catalog/src/contracts/left.ts', `export * from './origin';`],
      ['verticals/catalog/src/contracts/right.ts', `export * from './origin';`],
      [
        'verticals/catalog/src/contracts/origin.ts',
        `import { Schema } from 'effect'; export const ResponseSchema = Schema.Unknown;`,
      ],
    ]);
    expect((yield* violation(diamondFiles)) ?? '').toMatch(/must use concrete/u);

    const ambiguousFiles = new Map([
      ...diamondFiles,
      [
        'verticals/catalog/src/contracts/left.ts',
        `import { Schema } from 'effect'; export const ResponseSchema = Schema.String;`,
      ] as const,
      [
        'verticals/catalog/src/contracts/right.ts',
        `import { Schema } from 'effect'; export const ResponseSchema = Schema.Any;`,
      ] as const,
    ]);
    expect(yield* violation(ambiguousFiles)).toBe(undefined);
  }),
);

it.live(
  'uses TypeScript source and relative-file resolution precedence',
  Effect.fn(function* scenario22() {
    const entry = withImports(`
    import { ResponseSchema } from './foo';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `);
    const files = new Map([
      [contractApiFixturePath, entry],
      [
        'verticals/catalog/src/contracts/foo.ts',
        `import { Schema } from 'effect'; export const ResponseSchema = Schema.String;`,
      ],
      [
        'verticals/catalog/src/contracts/foo/index.ts',
        `import { Schema } from 'effect'; export const ResponseSchema = Schema.Any;`,
      ],
    ]);
    expect(yield* violation(files)).toBe(undefined);

    const nodeNextEntry = withImports(`
    import { ResponseSchema } from './foo.js';
    HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
  `);
    const nodeNextFiles = new Map([
      ...files,
      [contractApiFixturePath, nodeNextEntry] as const,
      [
        'verticals/catalog/src/contracts/foo.ts',
        `import { Schema } from 'effect'; export const ResponseSchema = Schema.Json;`,
      ] as const,
    ]);
    expect((yield* violation(nodeNextFiles)) ?? '').toMatch(/must use concrete/u);
  }),
);

it.live(
  'tracks object, mutable, rest, var, enum, and namespace provenance',
  Effect.fn(function* scenario23() {
    for (const content of [
      withImports(`
      const Endpoints = { endpoint: HttpApiEndpoint };
      Endpoints.endpoint.get('read', '/reads/example', { success: Schema.Any });
    `),
      withImports(`
      let Endpoint = { get: () => undefined };
      Endpoint = HttpApiEndpoint;
      Endpoint.get('read', '/reads/example', { success: Schema.Unknown });
    `),
      withImports(`
      let factory = () => undefined;
      factory = makeProblemDetailsSchema;
      factory('InvalidProblem', 400, { values: Schema.Record(Schema.String, Schema.String) });
    `),
      withImports(`
      const all = { ...Schema };
      HttpApiEndpoint.get('read', '/reads/example', { success: all['A' + 'ny'] });
    `),
      withImports(`
      const { ...S } = Schema;
      HttpApiEndpoint.get('read', '/reads/example', { success: S.Any });
    `),
      withImports(`
      const key = 'Unknown';
      HttpApiEndpoint.get('read', '/reads/example', { success: Schema[key] });
    `),
      withImports(`
      const { ['Any']: UnsafeSchema } = Schema;
      HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });
    `),
      withImports(`
      const holder = { endpoint: undefined };
      holder.endpoint = HttpApiEndpoint;
      holder.endpoint.get('read', '/reads/example', { success: Schema.Unknown });
    `),
      withImports(`
      let ResponseSchema = Schema.String;
      { ResponseSchema = Schema.Any; }
      HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
    `),
      withImports(`
      let ResponseSchema = Schema.Any;
      if (false) ResponseSchema = Schema.String;
      HttpApiEndpoint.get('read', '/reads/example', { success: ResponseSchema });
    `),
    ]) {
      expect((yield* violationOf(content)) ?? '').toMatch(/must use concrete/u);
    }

    for (const content of [
      `
      import { Schema } from 'effect';
      import { HttpApiEndpoint } from 'effect/unstable/httpapi';
      function fixture() {
        { var Schema = { Any: 'safe' }; }
        HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
      }
      fixture();
    `,
      `
      namespace HttpApiEndpoint { export const get = () => undefined; }
      HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
    `,
      `
      enum HttpApiEndpoint { get }
      HttpApiEndpoint.get('read', '/reads/example', { success: Schema.Any });
    `,
    ]) {
      expect(yield* violationOf(content)).toBe(undefined);
    }
    expect(
      yield* violationOf(
        withImports(`
        const { String, ...S } = Schema;
        HttpApiEndpoint.get('read', '/reads/example', { success: S.String });
      `),
      ),
    ).toBe(undefined);
  }),
);

it.live(
  'follows external schema and endpoint provider re-exports',
  Effect.fn(function* scenario24() {
    const fixtures: readonly (readonly [string, string])[] = [
      [`export { Any as UnsafeSchema } from 'effect/Schema';`, `import { UnsafeSchema } from './barrel';`],
      [`export { Unknown as UnsafeSchema } from 'effect/Schema';`, `import { UnsafeSchema } from './barrel';`],
      [`export * as S from 'effect/Schema';`, `import { S } from './barrel'; const UnsafeSchema = S.Any;`],
    ];
    for (const [barrel, imported] of fixtures) {
      const entry = `import { HttpApiEndpoint } from 'effect/unstable/httpapi';
      ${imported}
      HttpApiEndpoint.get('read', '/reads/example', { success: UnsafeSchema });`;
      const files = new Map([
        [contractApiFixturePath, entry],
        [contractBarrelFixturePath, barrel],
      ]);
      expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
    }

    for (const barrel of [
      `export { HttpApiEndpoint } from 'effect/unstable/httpapi';`,
      `export * as Http from 'effect/unstable/httpapi';`,
    ]) {
      const imported = barrel.includes('* as')
        ? `import { Http } from './barrel'; Http.HttpApiEndpoint`
        : `import { HttpApiEndpoint as Endpoint } from './barrel'; Endpoint`;
      const entry = `import { Schema } from 'effect';
      ${imported}.get('read', '/reads/example', { success: Schema.Any });`;
      const files = new Map([
        [contractApiFixturePath, entry],
        [contractBarrelFixturePath, barrel],
      ]);
      expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
    }
  }),
);

it.live(
  'follows local and imported aliases of Problem Details factories',
  Effect.fn(function* scenario25() {
    expect(
      (yield* violationOf(
        withImports(`
        const factory = makeProblemDetailsSchema;
        const InvalidProblem = factory('InvalidProblem', 400, { field: Schema.Unknown });
      `),
      )) ?? '',
    ).toMatch(/must use concrete/u);
    expect(
      yield* violationOf(
        withImports(`
        const factory = makeProblemDetailsSchema;
        const ValidProblem = factory('ValidProblem', 400, { field: Schema.String });
      `),
      ),
    ).toBe(undefined);

    const files = new Map([
      [
        contractApiFixturePath,
        withImports(`
        import { factory } from './factory';
        import { UnsafeExtensions } from './unsafe';
        const InvalidProblem = factory('InvalidProblem', 400, UnsafeExtensions);
      `),
      ],
      [
        'verticals/catalog/src/contracts/factory.ts',
        `import { makeProblemDetailsSchema } from '@app/shared-contracts'; export const factory = makeProblemDetailsSchema;`,
      ],
      [
        unsafeContractFixturePath,
        `import { Schema } from 'effect'; export const UnsafeExtensions = { values: Schema.Record(Schema.String, Schema.String) };`,
      ],
    ]);
    expect((yield* violation(files)) ?? '').toMatch(/must use concrete/u);
    for (const extensions of [`{ field: Schema.Unknown }`, `{ values: Schema.Record(Schema.String, Schema.String) }`]) {
      const inlineFiles = new Map([
        ...files,
        [
          contractApiFixturePath,
          withImports(`
          import { factory } from './factory';
          const InvalidProblem = factory('InvalidProblem', 400, ${extensions});
        `),
        ] as const,
      ]);
      expect((yield* violation(inlineFiles)) ?? '').toMatch(/must use concrete/u);
    }
    for (const factoryName of ['makeProblemDetailsSchema', 'makeRetryableProblemDetailsSchema']) {
      const factoryFiles = new Map([
        [
          'verticals/catalog/src/contracts/factory.ts',
          `import { ${factoryName} } from '@app/shared-contracts'; export const factory = ${factoryName};`,
        ],
        [
          unsafeContractFixturePath,
          `import { Schema } from 'effect';
          export const RecordAlias = Schema.Record(Schema.String, Schema.String);
          export const UnsafeExtensions = { values: RecordAlias };
        `,
        ],
      ]);
      for (const entry of [
        `
        import { factory } from './factory';
        import { Schema } from 'effect';
        const RecordAlias = Schema.Record(Schema.String, Schema.String);
        factory('InvalidProblem', 400, { values: RecordAlias });
      `,
        `
        import { factory } from './factory';
        import { RecordAlias } from './unsafe';
        factory('InvalidProblem', 400, { values: RecordAlias });
      `,
        `
        import { factory } from './factory';
        import * as Extensions from './unsafe';
        factory('InvalidProblem', 400, Extensions.UnsafeExtensions);
      `,
      ]) {
        const aliasedFiles = new Map([...factoryFiles, [contractApiFixturePath, entry] as const]);
        expect((yield* violation(aliasedFiles)) ?? '').toMatch(/must use concrete/u);
      }
    }
  }),
);
