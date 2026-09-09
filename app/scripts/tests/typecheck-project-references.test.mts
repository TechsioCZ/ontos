import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/unstable/process';

import { collectToolingProcess } from './tooling-process-fixture.mts';

interface WorkspaceScriptPlan {
  readonly typecheck: string;
}

type WorkspaceScriptPlanFactory = (
  applications: readonly string[]
) => WorkspaceScriptPlan;

const callable = <Callable extends (...argumentsList: never[]) => void>() =>
  Schema.Opaque<Callable>()(
    Schema.Unknown.pipe(Schema.refine(Predicate.isFunction))
  );

const PackageJsonSchema = Schema.Struct({
  scripts: Schema.Struct({ typecheck: Schema.String }),
});
const WorkspaceScriptPlanSchema = Schema.Struct({ typecheck: Schema.String });
const WorkspaceScriptPlanModuleSchema = Schema.Struct({
  createWorkspaceRootScriptPlan: callable<WorkspaceScriptPlanFactory>(),
});

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const packageJsonFile = 'package.json';
const tsconfigFile = 'tsconfig.json';
const packageJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(PackageJsonSchema)
)(readFileSync(path.join(workspaceRoot, packageJsonFile), 'utf-8'));
const typecheckWrapper = path.join(
  workspaceRoot,
  'scripts/ultramodern-typecheck.mts'
);
const executablePath = path.join(workspaceRoot, 'node_modules/.bin');

const runTypecheck = (fixture: string, commandArguments: readonly string[]) =>
  Effect.gen(function* runTypecheckEffect() {
    const inheritedPath = yield* Config.string('PATH').pipe(
      Config.withDefault('')
    );
    return yield* collectToolingProcess(
      ChildProcess.make(
        process.execPath,
        [typecheckWrapper, ...commandArguments],
        {
          cwd: fixture,
          env: {
            PATH: `${executablePath}${path.delimiter}${inheritedPath}`,
            ULTRAMODERN_WORKSPACE_ROOT: fixture,
          },
          extendEnv: true,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        }
      )
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live(
  'installed generator and consumer both check the full project reference graph',
  Effect.fn(function* testEffect2() {
    const generator = Schema.decodeUnknownSync(WorkspaceScriptPlanModuleSchema)(
      yield* Effect.tryPromise(
        () =>
          import(
            pathToFileURL(
              path.join(
                workspaceRoot,
                'node_modules/@modern-js/ultramodern-create/dist/esm-node/ultramodern-workspace/workspace-script-plan.js'
              )
            ).href
          )
      )
    );
    const scriptPlan = Schema.decodeUnknownSync(WorkspaceScriptPlanSchema)(
      generator.createWorkspaceRootScriptPlan([])
    );
    expect(scriptPlan.typecheck).toBe(
      'node ./scripts/ultramodern-typecheck.mts --build tsconfig.json'
    );
    expect(packageJson.scripts.typecheck).toBe(
      'node ./scripts/ultramodern-typecheck.mts --build tsconfig.json'
    );
  })
);

it.live(
  'Drizzle consumer surface compiles in both ESM and CommonJS projects',
  Effect.fn(function* testEffect3() {
    const fixture = yield* Effect.acquireRelease(
      Effect.sync(() =>
        mkdtempSync(path.join(os.tmpdir(), 'ontos-drizzle-declarations-'))
      ),
      (directory) =>
        Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
    );
    symlinkSync(
      path.join(workspaceRoot, 'node_modules'),
      path.join(fixture, 'node_modules'),
      'dir'
    );
    writeFileSync(
      path.join(fixture, packageJsonFile),
      '{"private":true,"type":"module"}\n'
    );
    writeFileSync(
      path.join(fixture, tsconfigFile),
      JSON.stringify({
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: 'ESNext',
          types: ['node'],
        },
        files: ['./consumer.mts', './consumer.cts'],
      })
    );
    for (const extension of ['mts', 'cts']) {
      writeFileSync(
        path.join(fixture, `consumer.${extension}`),
        'import { pgTable, uuid } from "drizzle-orm/pg-core";\n' +
          'export const fixtureTable = pgTable("declaration_fixture", { id: uuid("id") });\n'
      );
    }
    const result = yield* runTypecheck(fixture, ['--project', tsconfigFile]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  })
);

it.live(
  'root typecheck checks referenced projects and rejects a newly introduced type error',
  Effect.fn(function* testEffect4() {
    const fixture = yield* Effect.acquireRelease(
      Effect.sync(() =>
        mkdtempSync(path.join(os.tmpdir(), 'ontos-typecheck-references-'))
      ),
      (directory) =>
        Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
    );
    mkdirSync(path.join(fixture, 'referenced'));
    symlinkSync(
      path.join(workspaceRoot, 'node_modules'),
      path.join(fixture, 'node_modules'),
      'dir'
    );
    writeFileSync(
      path.join(fixture, packageJsonFile),
      '{"private":true,"type":"module"}\n'
    );
    writeFileSync(
      path.join(fixture, tsconfigFile),
      JSON.stringify({ files: [], references: [{ path: './referenced' }] })
    );
    writeFileSync(
      path.join(fixture, 'referenced/tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          outDir: './output',
          strict: true,
          types: [],
        },
        files: ['./index.ts'],
      })
    );
    const sourceFile = path.join(fixture, 'referenced/index.ts');
    writeFileSync(
      sourceFile,
      'export const referenceGateFixture: number = 1;\n'
    );
    const [runtime, wrapper, ...args] =
      packageJson.scripts.typecheck.split(' ');
    expect(runtime).toBe('node');
    expect(wrapper).toBe('./scripts/ultramodern-typecheck.mts');
    expect(path.join(workspaceRoot, wrapper)).toBe(typecheckWrapper);
    const initial = yield* runTypecheck(fixture, args);
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    expect(
      readFileSync(
        path.join(fixture, 'referenced/output/index.d.ts'),
        'utf-8'
      ).includes('referenceGateFixture'),
      'the referenced project must actually be built; a root files:[] project check is a no-op'
    ).toBe(true);
    writeFileSync(
      sourceFile,
      'export const referenceGateFixture: number = "invalid";\n'
    );
    const invalid = yield* runTypecheck(fixture, args);
    expect(
      invalid.status,
      'a referenced source type error must fail the root gate'
    ).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).toMatch(
      /referenced[/\\]index\.ts.*TS2322/u
    );
  })
);
