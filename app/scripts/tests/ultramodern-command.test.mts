import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const createFilename = 'create.mjs';
const routeGeneratorScript = 'generate-tanstack-routes';
const wrappers = [
  ['assert-mf-types', 'mf-types'],
  ['generate-node-backend-federation', 'backend-federation-generate'],
  ['generate-public-surface-assets', 'public-surface'],
  ['migrate-strict-effect', 'migrate-strict-effect'],
  ['proof-cloudflare-version', 'cloudflare-proof'],
  ['ultramodern-performance-readiness', 'performance-readiness'],
  ['ultramodern-typecheck', 'typecheck'],
  ['verify-cloudflare-output', 'cloudflare-output-verify'],
] as const;

const fixtureDirectory = () =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), 'ontos-command-'))),
    (directory) =>
      Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
  );

const invokeWrapper = (
  script: string,
  environment: Readonly<Record<string, string>>,
  args: readonly string[] = []
) =>
  Effect.gen(function* invokeWrapperEffect() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [path.join(workspaceRoot, 'scripts', `${script}.mts`), ...args],
        {
          cwd: workspaceRoot,
          env: environment,
          extendEnv: true,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        }
      )
    );
    return yield* Effect.all(
      {
        status: child.exitCode.pipe(Effect.map(Number)),
        stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      },
      { concurrency: 'unbounded' }
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

for (const [script, command] of wrappers) {
  it.live(
    `${script} forwards arguments, workspace and child exit status`,
    Effect.fn(function* mergedScenario1() {
      const fixture = yield* fixtureDirectory();
      const createBin = path.join(fixture, createFilename);
      writeFileSync(
        createBin,
        'console.log(process.argv.slice(2).join("|")); console.log(process.env.ULTRAMODERN_WORKSPACE_ROOT); process.exitCode = 7;'
      );
      const result = yield* invokeWrapper(
        script,
        {
          ULTRAMODERN_CREATE_BIN: createBin,
          ULTRAMODERN_WORKSPACE_ROOT: fixture,
        },
        ['--probe', 'argument with spaces']
      );
      expect(result.status, result.stderr).toBe(7);
      expect(result.stdout).toBe(
        `ultramodern|${command}|--probe|argument with spaces\n${fixture}\n`
      );
    })
  );
}

it.live(
  'route generation fails closed on a nonzero framework exit',
  Effect.fn(function* mergedScenario2() {
    const fixture = yield* fixtureDirectory();
    const createBin = path.join(fixture, createFilename);
    writeFileSync(createBin, 'process.exitCode = 7;');
    mkdirSync(path.join(fixture, '.modernjs'));
    writeFileSync(
      path.join(fixture, '.modernjs/ultramodern.json'),
      '{"topology":{"apps":[]}}'
    );
    const result = yield* invokeWrapper(routeGeneratorScript, {
      ULTRAMODERN_CREATE_BIN: createBin,
      ULTRAMODERN_WORKSPACE_ROOT: fixture,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(
      /Framework route-artifact generation failed: exit 7/u
    );
  })
);

it.live(
  'missing PATH launcher reports a typed launch failure and exits one',
  Effect.fn(function* mergedScenario3() {
    const fixture = yield* fixtureDirectory();
    const result = yield* invokeWrapper('assert-mf-types', {
      PATH: fixture,
      ULTRAMODERN_CREATE_BIN: '',
      ULTRAMODERN_WORKSPACE_ROOT: fixture,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /Failed to launch ultramodern-create from PATH/u
    );
    expect(result.stderr).toMatch(/UltraModern command "mf-types"/u);
  })
);

const routeFixture = Effect.fn(function* routeFixture(scope: string) {
  const fixture = yield* fixtureDirectory();
  const ownerPath = 'verticals/inventory';
  mkdirSync(path.join(fixture, '.modernjs'));
  mkdirSync(path.join(fixture, ownerPath, 'src/routes/items'), {
    recursive: true,
  });
  mkdirSync(path.join(fixture, 'bin'));
  writeFileSync(path.join(fixture, 'bin/pnpm'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  writeFileSync(
    path.join(fixture, '.modernjs/ultramodern.json'),
    JSON.stringify({
      topology: { apps: [{ id: 'inventory', path: ownerPath }] },
    })
  );
  writeFileSync(
    path.join(fixture, ownerPath, 'package.json'),
    JSON.stringify({
      modernjs: { ontosModule: { moduleId: 'inventory' } },
    })
  );
  const metadata = {
    canonicalPath: '/items',
    descriptionKey: 'items.description',
    entrypoint: {
      access: 'read',
      authorization: { kind: 'public' },
      entrypointKey: 'inventory.items',
      moduleKey: 'inventory',
      role: 'page',
      scope,
    },
    id: 'items',
    indexable: false,
    localisedPaths: { cs: '/polozky', en: '/items' },
    namespace: 'inventory',
    ownerAppId: 'inventory',
    public: false,
    titleKey: 'items.title',
  };
  writeFileSync(
    path.join(fixture, ownerPath, 'src/routes/items/route.meta.ts'),
    `export const routeMeta = ${JSON.stringify(metadata)};\n`
  );
  const createBin = path.join(fixture, createFilename);
  writeFileSync(
    createBin,
    `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const manifest = readFileSync(path.join(process.env.ULTRAMODERN_WORKSPACE_ROOT, '${ownerPath}/src/routes/ultramodern-route-metadata.ts'), 'utf8');
const urls = JSON.parse(manifest.split('export const ultramodernLocalisedUrls = ')[1].split(' as const;')[0]);
assert.deepEqual(urls, { '/items': { cs: '/polozky', en: '/items' } });
console.log('framework observed canonical-only metadata');
`
  );
  return { createBin, fixture };
});

it.live(
  'route metadata precedes framework generation and keeps canonical-only locale keys',
  Effect.fn(function* canonicalRouteMetadata() {
    const { createBin, fixture } = yield* routeFixture('tenant');
    const result = yield* invokeWrapper(routeGeneratorScript, {
      PATH: path.join(fixture, 'bin'),
      ULTRAMODERN_CREATE_BIN: createBin,
      ULTRAMODERN_WORKSPACE_ROOT: fixture,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /framework observed canonical-only metadata/u
    );
  })
);

it.live(
  'route metadata with the wrong owner scope fails before framework launch',
  Effect.fn(function* invalidRouteScope() {
    const { createBin, fixture } = yield* routeFixture('system');
    const result = yield* invokeWrapper(routeGeneratorScript, {
      PATH: path.join(fixture, 'bin'),
      ULTRAMODERN_CREATE_BIN: createBin,
      ULTRAMODERN_WORKSPACE_ROOT: fixture,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(
      /must declare one governed tenant page entrypoint owned by inventory/u
    );
    expect(result.stdout).not.toMatch(/framework observed/u);
  })
);
