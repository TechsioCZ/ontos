import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

/**
 * Executable regression for patches/@bleedingdev__modern-js-code-tools@3.9.3-ultramodern.19.patch: the
 * strict-effect-api-boundaries Schema check must run on runtime member expressions only. The type-only
 * `typeof Schema.Unknown.Type` reference in shell-system-search stays accepted, while runtime
 * Schema.Unknown / Schema.Any / Schema.UnknownFromJsonString access keeps failing both the Oxlint rule
 * and the `api:check` model behind `modern-api-check`.
 */

const codeToolsPackage = '@modern-js/code-tools';
const boundaryDiagnostic =
  /API modules must use concrete request, response and error schemas; Schema\.UnknownFromJsonString, Schema\.Unknown and Schema\.Any are forbidden in UltraModern API code\./u;
const boundaryDiagnosticOccurrences =
  /API modules must use concrete request, response and error schemas; Schema\.UnknownFromJsonString, Schema\.Unknown and Schema\.Any are forbidden in UltraModern API code\./gu;
const cleanOutput =
  /^(?:Found 0 warnings and 0 errors\.\r?\nFinished in \d+(?:\.\d+)?(?:ms|s) on \d+ files? with \d+ rules using \d+ threads?\.\r?\n)?$/u;

const require = createRequire(import.meta.url);
const packageEntry = pathToFileURL(require.resolve(codeToolsPackage));
const packageRoot = fileURLToPath(new URL('../..', packageEntry));
const packageRequire = createRequire(packageEntry);
const oxlintRoot = path.dirname(packageRequire.resolve('oxlint/package.json'));

/** The valid reproducer: the exact type-only reference a whole-file regex scan falsely flagged. */
const typeOnlySource = `import { Schema } from 'effect';

type UnparsedSystemSearchResults = typeof Schema.Unknown.Type;

export const keepUnparsed = (value: UnparsedSystemSearchResults) => value;
`;

/** Nearby invalid controls: real runtime Schema.Unknown-family access stays rejected. */
const runtimeSources = {
  'runtime-any.ts': 'export const anySchema = Schema.Any;\n',
  'runtime-computed-literal.ts': "export const computedUnknown = Schema['Unknown'];\n",
  'runtime-computed-template.ts': 'export const computedTemplate = Schema[`Any`];\n',
  'runtime-from-json-string.ts': 'export const fromJsonStringSchema = Schema.UnknownFromJsonString;\n',
  'runtime-optional-chain.ts': 'export const optionalUnknown = Schema?.Unknown;\n',
  'runtime-unknown.ts': 'export const unknownSchema = Schema.Unknown;\n',
} as const;

const formats = [
  ['cjs', 'cjs'],
  ['esm', 'js'],
  ['esm-node', 'js'],
] as const;

/** Runs the packaged Oxlint adapter with only the strict-effect-api-boundaries rule over a temp fixture root. */
const runBoundaryLint = (
  format: (typeof formats)[number][0],
  extension: string,
  sources: Readonly<Record<string, string>>,
) => {
  const root = mkdtempSync(path.join(os.tmpdir(), `ontos-strict-boundaries-${format}-`));
  try {
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    cpSync(path.join(packageRoot, 'dist', format), path.join(root, 'dist', format), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: codeToolsPackage, type: 'module' }));
    mkdirSync(path.join(root, 'node_modules', '@babel'), { recursive: true });
    symlinkSync(oxlintRoot, path.join(root, 'node_modules', 'oxlint'));
    for (const dependency of ['parser', 'traverse', 'types']) {
      symlinkSync(
        path.dirname(packageRequire.resolve(`@babel/${dependency}/package.json`)),
        path.join(root, 'node_modules', '@babel', dependency),
      );
    }
    const fixtureDirectory = path.join(root, 'verticals', 'fixture', 'api', 'modules');
    mkdirSync(fixtureDirectory, { recursive: true });
    for (const [name, source] of Object.entries(sources)) {
      writeFileSync(path.join(fixtureDirectory, name), source);
    }
    if (format === 'cjs') {
      // Oxlint expects the plugin value, not the CJS module's named-export namespace.
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'oxlint-plugin.ts'),
        'import plugin from "../dist/cjs/oxlint-plugin.cjs"; export default plugin.default;',
      );
    }
    const adapter = pathToFileURL(path.join(root, 'dist', format, 'cli', `oxlint.${extension}`)).href;
    const rules = { 'ultramodern/strict-effect-api-boundaries': 'error' };
    const script = `import { runOxlintRules, printOxlintOutput } from ${JSON.stringify(adapter)};
const result = runOxlintRules({ cwd: ${JSON.stringify(root)}, targets: ['verticals/fixture'], rules: ${JSON.stringify(rules)} });
printOxlintOutput(result); process.exitCode = result.exitCode;`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: root,
      encoding: 'utf-8',
      env: { TMPDIR: root },
    });
    const errorOutput = result.error === undefined ? '' : `\n${result.error.message}`;
    return {
      output: stripVTControlCharacters(`${result.stdout ?? ''}${result.stderr ?? ''}${errorOutput}`),
      status: result.status ?? 1,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

for (const [format, extension] of formats) {
  it(`code-tools ${format}: type-only typeof Schema.Unknown.Type stays accepted`, () => {
    const { output, status } = runBoundaryLint(format, extension, { 'unparsed-results.ts': typeOnlySource });
    expect(status, output).toBe(0);
    expect(output).toMatch(cleanOutput);
    expect(output).not.toMatch(boundaryDiagnostic);
  });

  it(`code-tools ${format}: runtime Schema.Unknown-family member access stays rejected`, () => {
    const { output, status } = runBoundaryLint(format, extension, runtimeSources);
    expect(status, output).toBe(1);
    expect(output).not.toMatch(/Error running JS plugin/u);
    for (const name of Object.keys(runtimeSources)) {
      expect(output, name).toContain(`${name}:1:`);
    }
    expect((output.match(boundaryDiagnosticOccurrences) ?? []).length).toBe(Object.keys(runtimeSources).length);
  });
}

/** The `api:check` seam: `modern-api-check` delegates to `checkMicroVerticalApiBoundaries` in the model. */
const boundaryModelEntry = path.join(packageRoot, 'dist/esm-node/microvertical-api-boundary.js');
const boundaryCliEntry = path.join(packageRoot, 'bin/modern-api-check.mjs');
const boundaryMessage = 'must use concrete request, response and error schemas';

interface BoundaryModel {
  readonly checkMicroVerticalApiBoundaries: (options: { readonly workspaceRoot: string }) => {
    readonly diagnostics: readonly string[];
  };
}

const callable = <Callable extends (...argumentsList: never[]) => void>() =>
  Schema.Opaque<Callable>()(Schema.Unknown.pipe(Schema.refine(Predicate.isFunction)));

const BoundaryModelSchema = Schema.Struct({
  checkMicroVerticalApiBoundaries: callable<BoundaryModel['checkMicroVerticalApiBoundaries']>(),
});

const buildBoundaryWorkspace = (sources: Readonly<Record<string, string>>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ontos-api-boundary-'));
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write(
    'topology/reference-topology.json',
    JSON.stringify({
      shell: { id: 'fixture-shell', kind: 'shell', package: '@fixture/shell', path: 'apps/fixture-shell' },
      verticals: [
        {
          deliveryUnitKind: 'microvertical',
          id: 'fixture',
          kind: 'vertical',
          package: '@fixture/vertical',
          path: 'verticals/fixture',
          surfaceProfile: 'api-only',
        },
      ],
    }),
  );
  write('apps/fixture-shell/package.json', JSON.stringify({ name: '@fixture/shell' }));
  write('verticals/fixture/package.json', JSON.stringify({ name: '@fixture/vertical' }));
  for (const [name, source] of Object.entries(sources)) {
    write(`verticals/fixture/api/modules/${name}`, source);
  }
  return root;
};

const boundaryViolations = (diagnostics: readonly string[]) =>
  diagnostics.filter((diagnostic) => diagnostic.includes(boundaryMessage));

const runBoundaryModel = (root: string) =>
  Effect.gen(function* checkBoundaryModel() {
    const source: unknown = yield* Effect.promise(() => import(pathToFileURL(boundaryModelEntry).href));
    const model = Schema.decodeUnknownSync(BoundaryModelSchema)(source);
    return model.checkMicroVerticalApiBoundaries({ workspaceRoot: root });
  });

const runBoundaryCli = (root: string) => {
  const result = spawnSync(process.execPath, [boundaryCliEntry, '--workspace-root', root], {
    encoding: 'utf-8',
    env: { TMPDIR: root },
  });
  return {
    output: stripVTControlCharacters(`${result.stdout ?? ''}${result.stderr ?? ''}`),
    status: result.status,
  };
};

it.live(
  'api:check model and CLI accept the type-only typeof Schema.Unknown.Type shape',
  Effect.fn(function* boundaryTypeOnlyScenario() {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() =>
        buildBoundaryWorkspace({
          'runtime-unknown.ts': runtimeSources['runtime-unknown.ts'],
          'type-only.ts': typeOnlySource,
        }),
      ),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    );
    const result = yield* runBoundaryModel(root);
    expect(boundaryViolations(result.diagnostics)).toEqual([
      `verticals/fixture/api/modules/runtime-unknown.ts: ${boundaryMessage}`,
    ]);
    const { output } = runBoundaryCli(root);
    expect(output).toContain(`API violation: verticals/fixture/api/modules/runtime-unknown.ts: ${boundaryMessage}`);
    expect(output).not.toContain(`type-only.ts: ${boundaryMessage}`);
  }),
);

it.live(
  'api:check model and CLI reject runtime Schema.Unknown-family member access',
  Effect.fn(function* boundaryRuntimeScenario() {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => buildBoundaryWorkspace(runtimeSources)),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    );
    const result = yield* runBoundaryModel(root);
    const violations = boundaryViolations(result.diagnostics);
    expect(violations).toHaveLength(Object.keys(runtimeSources).length);
    for (const name of Object.keys(runtimeSources)) {
      expect(violations, name).toContain(`verticals/fixture/api/modules/${name}: ${boundaryMessage}`);
    }
    const { output, status } = runBoundaryCli(root);
    expect(status).toBe(1);
    for (const name of Object.keys(runtimeSources)) {
      expect(output, name).toContain(`API violation: verticals/fixture/api/modules/${name}: ${boundaryMessage}`);
    }
  }),
);
