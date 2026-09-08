import assert from 'node:assert/strict';
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
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import {
  Config,
  Effect,
  ManagedRuntime,
  Predicate,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

interface TypecheckResult {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

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
const typecheckRuntime = ManagedRuntime.make(NodeServices.layer);

const runTypecheck = async (
  fixture: string,
  commandArguments: readonly string[]
): Promise<TypecheckResult> =>
  await typecheckRuntime.runPromise(
    Effect.gen(function* runTypecheckEffect() {
      const inheritedPath = yield* Config.string('PATH').pipe(
        Config.withDefault('')
      );
      const processSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return yield* Effect.scoped(
        Effect.gen(function* collectTypecheckResult() {
          const handle = yield* processSpawner.spawn(
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
          const [status, stdout, stderr] = yield* Effect.all(
            [
              handle.exitCode.pipe(Effect.map(Number)),
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            ],
            { concurrency: 'unbounded' }
          );
          return { status, stderr, stdout };
        })
      );
    })
  );

test.after(async () => {
  await typecheckRuntime.dispose();
});

void test('installed generator project default preserves the consumer reference-build gate', async () => {
  const generator = Schema.decodeUnknownSync(WorkspaceScriptPlanModuleSchema)(
    await import(
      pathToFileURL(
        path.join(
          workspaceRoot,
          'node_modules/@modern-js/ultramodern-create/dist/esm-node/ultramodern-workspace/workspace-script-plan.js'
        )
      ).href
    )
  );
  const scriptPlan = Schema.decodeUnknownSync(WorkspaceScriptPlanSchema)(
    generator.createWorkspaceRootScriptPlan([])
  );
  assert.equal(
    scriptPlan.typecheck,
    'node ./scripts/ultramodern-typecheck.mts --project tsconfig.json'
  );
  assert.equal(
    packageJson.scripts.typecheck,
    'node ./scripts/ultramodern-typecheck.mts --build tsconfig.json'
  );
});

void test('Drizzle consumer surface compiles in both ESM and CommonJS projects', async () => {
  const fixture = mkdtempSync(
    path.join(os.tmpdir(), 'ontos-drizzle-declarations-')
  );
  try {
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
    const result = await runTypecheck(fixture, ['--project', tsconfigFile]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

void test('root typecheck checks referenced projects and rejects a newly introduced type error', async () => {
  const fixture = mkdtempSync(
    path.join(os.tmpdir(), 'ontos-typecheck-references-')
  );
  try {
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
    assert.equal(runtime, 'node');
    assert.equal(wrapper, './scripts/ultramodern-typecheck.mts');
    assert.equal(path.join(workspaceRoot, wrapper), typecheckWrapper);
    const initial = await runTypecheck(fixture, args);
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    assert.ok(
      readFileSync(
        path.join(fixture, 'referenced/output/index.d.ts'),
        'utf-8'
      ).includes('referenceGateFixture'),
      'the referenced project must actually be built; a root files:[] project check is a no-op'
    );
    writeFileSync(
      sourceFile,
      'export const referenceGateFixture: number = "invalid";\n'
    );
    const invalid = await runTypecheck(fixture, args);
    assert.notEqual(
      invalid.status,
      0,
      'a referenced source type error must fail the root gate'
    );
    assert.match(
      invalid.stdout + invalid.stderr,
      /referenced[/\\]index\.ts.*TS2322/u
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
