import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { CORE_MIGRATION_MANIFEST } from '../../packages/core-runtime/scripts/migration-equivalence.mts';
import { PARTY_MIGRATION_MANIFESTS } from '../../verticals/party-registry/scripts/migration-equivalence.mts';
import { ownerSnapshotCheckCommand } from '../migration-convergence-cli.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const CHECK_TIMEOUT = '60 seconds';

const sources = [
  { manifest: CORE_MIGRATION_MANIFEST, owner: 'core' },
  ...PARTY_MIGRATION_MANIFESTS.map((manifest) => ({ manifest, owner: 'party' as const })),
] as const;

for (const { manifest, owner } of sources) {
  it.live(
    `checks ${manifest.history} with its installed native Drizzle before any database operation`,
    Effect.fn(
      function* nativeOwnerCheck() {
        const directory = fileURLToPath(
          new URL(
            owner === 'core' ? '../../packages/core-runtime/' : '../../verticals/party-registry/',
            import.meta.url,
          ),
        );
        const command = ownerSnapshotCheckCommand(owner, manifest.folder);
        expect(command.command).toBe(path.join(directory, 'node_modules/.bin/drizzle-kit'));
        expect(command.options.cwd).toBe(directory);
        expect(command.args).toEqual(['check', '--dialect', 'postgresql', '--out', manifest.folder]);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        expect(Number(yield* spawner.exitCode(command).pipe(Effect.timeout(CHECK_TIMEOUT)))).toBe(0);
      },
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
}

it.live(
  'still rejects an invalid snapshot through the native owner CLI',
  Effect.fn(
    function* invalidSnapshotControl() {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-invalid-migration-snapshot-' });
      const snapshot = path.join(folder, '20261027000000_invalid');
      yield* fs.makeDirectory(snapshot);
      yield* fs.writeFileString(path.join(snapshot, 'snapshot.json'), 'not valid JSON');
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const code = yield* spawner
        .exitCode(ownerSnapshotCheckCommand('core', folder))
        .pipe(Effect.timeout(CHECK_TIMEOUT));
      expect(Number(code)).not.toBe(0);
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.live(
  'runs the native owner check in a reduced artifact without disabling pnpm workspace verification',
  Effect.fn(
    function* reducedWorkspaceControl() {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-migrator-workspace-' });
      const workspace = path.join(folder, 'source');
      const artifact = path.join(folder, 'artifact');
      yield* fs.makeDirectory(workspace);
      yield* fs.writeFileString(path.join(workspace, 'package.json'), '{"name":"migrator-fixture","private":true}');
      yield* fs.writeFileString(
        path.join(workspace, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\nverifyDepsBeforeRun: error\nenableGlobalVirtualStore: false\n',
      );
      const packages = {
        runtime: '{"name":"runtime","private":true}',
        shipped: '{"name":"shipped","private":true,"dependencies":{"runtime":"workspace:*","picocolors":"1.1.1"}}',
        unshipped: '{"name":"unshipped","private":true,"dependencies":{"picocolors":"1.1.1"}}',
      };
      for (const [name, manifest] of Object.entries(packages)) {
        const directory = path.join(workspace, 'packages', name);
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, 'package.json'), manifest);
      }
      const invokePnpm = (args: readonly string[], cwd = workspace) =>
        collectToolingProcess(
          ChildProcess.make('pnpm', args, {
            cwd,
            // pnpm exec disables repeated checks in children; this control starts a new workspace.
            env: { pnpm_config_verify_deps_before_run: 'error' },
            extendEnv: true,
            stderr: 'pipe',
            stdout: 'pipe',
          }),
        ).pipe(Effect.timeout(CHECK_TIMEOUT));
      const installed = yield* invokePnpm(['install', '--offline', '--no-frozen-lockfile', '--ignore-scripts']);
      expect(installed.status, installed.stderr).toBe(0);
      const complete = yield* invokePnpm(['--filter', 'shipped', 'exec', 'node', '--version']);
      expect(complete.status, complete.stderr).toBe(0);
      yield* fs.rename(workspace, artifact);
      yield* fs.remove(path.join(artifact, 'packages/unshipped'), { recursive: true });
      const reduced = yield* invokePnpm(['--filter', 'shipped', 'exec', 'node', '--version'], artifact);
      expect(reduced.status).not.toBe(0);
      expect(`${reduced.stdout}${reduced.stderr}`).toContain('ERR_PNPM_VERIFY_DEPS_BEFORE_RUN');
      const native = ownerSnapshotCheckCommand('core', CORE_MIGRATION_MANIFEST.folder);
      const result = yield* collectToolingProcess(
        ChildProcess.make(native.command, native.args, { cwd: artifact, stderr: 'pipe', stdout: 'pipe' }),
      ).pipe(Effect.timeout(CHECK_TIMEOUT));
      expect(result.status, result.stderr).toBe(0);
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
