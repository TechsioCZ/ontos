import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Schema } from 'effect';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CompilerOptionsSchema = Schema.Record(Schema.String, Schema.Json);
const ConfigSchema = Schema.Struct({
  compilerOptions: Schema.optionalKey(CompilerOptionsSchema),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  extends: Schema.optionalKey(Schema.String),
  include: Schema.optionalKey(Schema.Array(Schema.String)),
  references: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String }))),
});
const read = (file: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(ConfigSchema))(readFileSync(file, 'utf-8'));

// Resolve only configuration and file membership. Never construct a compiler program or run a typecheck.
interface ResolvedConfig {
  readonly exclude: readonly string[];
  readonly include: readonly string[];
  readonly options: typeof CompilerOptionsSchema.Type;
  readonly references: readonly string[];
}
const configOf = (file: string): ResolvedConfig => {
  const current = read(file);
  const directory = path.dirname(file);
  const parent = current.extends === undefined ? undefined : configOf(path.resolve(directory, current.extends));
  return {
    exclude: current.exclude?.map((pattern) => path.resolve(directory, pattern)) ?? parent?.exclude ?? [],
    include: current.include?.map((pattern) => path.resolve(directory, pattern)) ?? parent?.include ?? [],
    options: { ...parent?.options, ...current.compilerOptions },
    // TypeScript project references are not inherited through extends.
    references:
      current.references?.map(({ path: ref }) =>
        path.resolve(directory, path.extname(ref) === '.json' ? ref : `${ref}/tsconfig.json`),
      ) ?? [],
  };
};
const graphOf = (entry: string) => {
  const result = new Map<string, ReturnType<typeof configOf>>();
  const visit = (file: string) => {
    if (result.has(file)) {
      return;
    }
    const config = configOf(file);
    result.set(file, config);
    for (const reference of config.references) {
      visit(reference);
    }
  };
  visit(path.resolve(root, entry));
  return result;
};
const rootsOf = (config: ReturnType<typeof configOf>) =>
  [
    ...globSync(
      config.include.map((pattern) => (pattern.includes('*') ? pattern : `${pattern}/**/*`)),
      {
        exclude: config.exclude.flatMap((pattern) =>
          pattern.includes('*') ? [pattern] : [pattern, `${pattern}/**/*`],
        ),
      },
    ),
  ].filter((file) => /\.(?:[cm]?tsx?|json)$/u.test(file));

await test('the failed deployment fixture stays in the CI graph, not the production declaration graph', () => {
  const fixture = path.resolve(root, 'packages/core-runtime/tests/integration/action-runtime.test.ts');
  const ci = graphOf('packages/shared-contracts/tsconfig.json');
  ok([...ci.values()].some((config) => rootsOf(config).includes(fixture)));
  const production = graphOf('packages/shared-contracts/tsconfig.build.json');
  equal(production.size, 2);
  for (const [file, config] of production) {
    ok(file.endsWith('/tsconfig.build.json'));
    const files = rootsOf(config);
    ok(files.length > 0);
    ok(!files.includes(fixture));
    ok(files.every((source) => !/\/(?:tests|testing|scripts)\//u.test(source) && !/\.test\./u.test(source)));
  }
  ok(
    rootsOf(configOf(path.resolve(root, 'packages/core-runtime/tsconfig.build.json'))).includes(
      path.resolve(root, 'packages/core-runtime/src/actions/runtime.ts'),
    ),
  );
});

await test('production keeps the same source diagnostics and declaration locations with separate incremental state', () => {
  for (const project of ['core-runtime', 'shared-contracts', 'shared-design-tokens']) {
    const base = configOf(path.resolve(root, `packages/${project}/tsconfig.json`));
    const build = configOf(path.resolve(root, `packages/${project}/tsconfig.build.json`));
    const { tsBuildInfoFile: originalState, ...originalOptions } = base.options;
    const { tsBuildInfoFile: buildState, ...buildOptions } = build.options;
    deepStrictEqual(buildOptions, originalOptions);
    ok(originalState !== buildState);
    equal(build.options.strict, true);
    equal(build.options.noEmit, false);
    equal(build.options.emitDeclarationOnly, true);
    ok(build.options.noCheck !== true);
  }
});

await test('stage and gates build drivers use the source-only graph before building units', () => {
  for (const driver of ['scripts/zerops/build-app.sh', 'scripts/ci/build-units.sh']) {
    const source = readFileSync(path.resolve(root, driver), 'utf-8');
    ok(source.includes('for project in packages/shared-contracts packages/shared-design-tokens; do'));
    ok(source.includes('typecheck --build "$project/tsconfig.build.json"'));
    ok(!source.includes('typecheck --build "$project/tsconfig.json"'));
  }
  const manifest = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        scripts: Schema.Struct({ build: Schema.String, typecheck: Schema.String }),
      }),
    ),
  )(readFileSync(path.resolve(root, 'package.json'), 'utf-8'));
  ok(manifest.scripts.build.includes('packages/shared-contracts/tsconfig.build.json'));
  ok(manifest.scripts.build.includes('packages/shared-design-tokens/tsconfig.build.json'));
  equal(manifest.scripts.typecheck, 'ultramodern-create ultramodern typecheck --build tsconfig.json');
});
