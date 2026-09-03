import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));

test('installed workspace generator keeps build mode as the root typecheck default', async () => {
  const generator = await import(
    pathToFileURL(
      path.join(
        workspaceRoot,
        'node_modules/@modern-js/create/dist/esm-node/ultramodern-workspace/workspace-script-plan.js',
      ),
    ).href
  );
  assert.equal(
    generator.createWorkspaceRootScriptPlan([]).typecheck,
    'node ./scripts/ultramodern-typecheck.mts --build tsconfig.json',
  );
});

test('strict Drizzle declaration graph compiles in both ESM and CommonJS consumers', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ontos-drizzle-declarations-'));
  try {
    symlinkSync(
      path.join(workspaceRoot, 'node_modules'),
      path.join(fixture, 'node_modules'),
      'dir',
    );
    writeFileSync(path.join(fixture, 'package.json'), '{"private":true,"type":"module"}\n');
    writeFileSync(
      path.join(fixture, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          target: 'ESNext',
          types: ['node'],
        },
        files: ['./consumer.mts', './consumer.cts'],
      }),
    );
    for (const extension of ['mts', 'cts']) {
      writeFileSync(
        path.join(fixture, `consumer.${extension}`),
        'import { pgTable, uuid } from "drizzle-orm/pg-core";\n' +
          'export const fixtureTable = pgTable("declaration_fixture", { id: uuid("id") });\n',
      );
    }
    const result = spawnSync(
      process.execPath,
      [path.join(workspaceRoot, 'scripts/ultramodern-typecheck.mts'), '--project', 'tsconfig.json'],
      {
        cwd: fixture,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${path.join(workspaceRoot, 'node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
          ULTRAMODERN_WORKSPACE_ROOT: fixture,
        },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('root typecheck checks referenced projects and rejects a newly introduced type error', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ontos-typecheck-references-'));
  try {
    mkdirSync(path.join(fixture, 'referenced'));
    symlinkSync(
      path.join(workspaceRoot, 'node_modules'),
      path.join(fixture, 'node_modules'),
      'dir',
    );
    writeFileSync(path.join(fixture, 'package.json'), '{"private":true,"type":"module"}\n');
    writeFileSync(
      path.join(fixture, 'tsconfig.json'),
      JSON.stringify({ files: [], references: [{ path: './referenced' }] }),
    );
    writeFileSync(
      path.join(fixture, 'referenced/tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          strict: true,
          types: [],
          outDir: './output',
        },
        files: ['./index.ts'],
      }),
    );
    const sourceFile = path.join(fixture, 'referenced/index.ts');
    writeFileSync(sourceFile, 'export const referenceGateFixture: number = 1;\n');
    const [runtime, wrapper, ...args] = packageJson.scripts.typecheck.split(' ');
    assert.equal(runtime, 'node');
    assert.equal(wrapper, './scripts/ultramodern-typecheck.mts');
    const runGate = () =>
      spawnSync(process.execPath, [path.join(workspaceRoot, wrapper), ...args], {
        cwd: fixture,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${path.join(workspaceRoot, 'node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
          ULTRAMODERN_WORKSPACE_ROOT: fixture,
        },
      });
    const initial = runGate();
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    assert.ok(
      readFileSync(path.join(fixture, 'referenced/output/index.d.ts'), 'utf8').includes(
        'referenceGateFixture',
      ),
      'the referenced project must actually be built; a root files:[] project check is a no-op',
    );
    writeFileSync(sourceFile, 'export const referenceGateFixture: number = "invalid";\n');
    const invalid = runGate();
    assert.notEqual(invalid.status, 0, 'a referenced source type error must fail the root gate');
    assert.match(invalid.stdout + invalid.stderr, /referenced[/\\]index\.ts.*TS2322/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
