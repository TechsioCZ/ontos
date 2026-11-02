import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { runScaffoldEffect } from '../cli.mts';
import { write, snapshotTree } from './fixture-files.mts';

const verticalFlag = '--vertical';
const coreOwner = 'core';
const personResource = 'person';
const resourceFlag = '--resource';
const withFixture = <Value, Failure, Services>(use: (root: string) => Effect.Effect<Value, Failure, Services>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => await mkdtemp(path.join(tmpdir(), 'ontos-core-people-'))),
    use,
    (root) => Effect.promise(async () => await rm(root, { force: true, recursive: true })),
  );
const scaffold = (root: string, command: Parameters<typeof runScaffoldEffect>[0], args: readonly string[]) =>
  runScaffoldEffect(command, args, { workspaceRoot: root });
const resourceArgs = [verticalFlag, coreOwner, resourceFlag, personResource];
const providerArgs = [
  verticalFlag,
  coreOwner,
  '--name',
  'people',
  resourceFlag,
  personResource,
  '--authorization',
  'context_permission',
  '--permission',
  'module.access',
];
const workerArgs = [
  verticalFlag,
  coreOwner,
  '--producer',
  coreOwner,
  '--worker',
  'project-people-lifecycle-search',
  '--topic',
  'core.identity.principal-lifecycle-changed.v1',
  '--authorization',
  'owner_local_background',
];

it.effect('Core person generator preserves conditional exports and provider emits governed system row checks', () =>
  withFixture((root) =>
    Effect.gen(function* approvedCoreBoundary() {
      yield* write(
        root,
        'packages/core-runtime/package.json',
        JSON.stringify({
          exports: { '.': './src/index.ts', './conditional': { default: './node.ts', workerd: './workerd.ts' } },
          name: '@app/core-runtime',
        }),
      );
      yield* scaffold(root, 'resource', resourceArgs);
      const packageText = yield* Effect.promise(
        async () => await readFile(path.join(root, 'packages/core-runtime/package.json'), 'utf-8'),
      );
      expect(JSON.parse(packageText)).toMatchObject({
        exports: {
          './conditional': { default: './node.ts', workerd: './workerd.ts' },
          './resources/person': './src/resources/person.ts',
        },
      });
      yield* scaffold(root, 'search-provider', providerArgs);
      const files = yield* snapshotTree(root);
      expect(files['packages/core-runtime/src/people/people-search.ts']).toContain('defineSystemModuleEntrypoint');
      expect(files['packages/core-runtime/src/people/people-search.ts']).toContain("legalEntityScope: 'required'");
      expect(files['packages/core-runtime/src/people/people-search.ts']).toContain("permission: 'read_people'");
      expect(files['packages/core-runtime/src/people/people-search.ts']).toContain('result.map(({ ref }) => ref)');
      expect(files['packages/core-runtime/src/people/people-search-contract.ts']).toContain(
        "accessFiltering: 'resource_permission'",
      );
      expect(Object.keys(files).some((file) => file.startsWith('verticals/'))).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('Core provider and worker reject unsupported owners, topics and public authorization without writes', () =>
  withFixture((root) =>
    Effect.gen(function* refusedCoreBoundary() {
      for (const args of [
        providerArgs.map((value) => (value === 'people' ? 'anything' : value)),
        providerArgs.map((value) => (value === 'module.access' ? 'read_all' : value)),
      ]) {
        const before = yield* snapshotTree(root);
        yield* scaffold(root, 'search-provider', args).pipe(Effect.flip);
        expect(yield* snapshotTree(root)).toEqual(before);
      }
      yield* scaffold(root, 'resource', [verticalFlag, coreOwner, resourceFlag, 'anything']).pipe(Effect.flip);
      for (const args of [
        workerArgs.map((value) =>
          value === 'core.identity.principal-lifecycle-changed.v1' ? 'other.owner.changed.v1' : value,
        ),
        workerArgs.map((value) => (value === 'project-people-lifecycle-search' ? 'unreviewed-worker' : value)),
      ]) {
        yield* scaffold(root, 'outbox-worker', args).pipe(Effect.flip);
      }
      expect(yield* snapshotTree(root)).toEqual({});
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('Core worker consumes only a published Core contract and registers a system background entry', () =>
  withFixture((root) =>
    Effect.gen(function* publishedCoreWorker() {
      yield* write(
        root,
        'packages/core-runtime/src/outbox/core-identity-principal-lifecycle-changed-v1.ts',
        'export const OutboxPayloadSchema = {};',
      );
      yield* scaffold(root, 'outbox-worker', workerArgs);
      const files = yield* snapshotTree(root);
      const worker = files['packages/core-runtime/src/people/project-people-lifecycle-search.worker.ts'];
      expect(files['packages/core-runtime/src/people/people-search-subscriptions.ts']).toContain(
        'consumerModuleKey: coreIdentity',
      );
      expect(files['packages/core-runtime/src/people/people-search-subscriptions.ts']).toContain(
        'producerModuleKey: coreIdentity',
      );
      expect(files['packages/core-runtime/src/people/people-search-subscriptions.ts']).toContain(
        'defineSystemModuleEntrypoint',
      );
      expect(worker).toContain('projector.project(context)');
      expect(worker).not.toContain('defineTenantModuleEntrypoint');
      expect(files['packages/core-runtime/src/people/people-search-workers.ts']).toContain(
        'projectPeopleLifecycleSearchSubscription',
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('Core rebuild HTTP generator refuses other Actions and emits only the approved tenant ingress adapter', () =>
  withFixture((root) =>
    Effect.gen(function* approvedCoreHttp() {
      yield* scaffold(root, 'action-http', [verticalFlag, coreOwner, '--action', 'arbitrary-write']).pipe(Effect.flip);
      expect(yield* snapshotTree(root)).toEqual({});
      yield* write(
        root,
        'packages/core-runtime/src/modules/actions/request-people-search-rebuild.action.ts',
        "// @ontos-action-owner core.identity\nconst descriptor = { legalEntityScope: 'forbidden' };",
      );
      yield* scaffold(root, 'action-http', [verticalFlag, coreOwner, '--action', 'request-people-search-rebuild']);
      const files = yield* snapshotTree(root);
      expect(files['apps/shell-super-app/api/people-search-rebuild.ts']).toContain('runtime.runAction');
      expect(files['apps/shell-super-app/api/people-search-rebuild.ts']).not.toContain('runRead');
      expect(files['apps/shell-super-app/shared/core-actions/request-people-search-rebuild.ts']).toContain(
        '/core.identity/actions/request-people-search-rebuild',
      );
      expect(files['apps/shell-super-app/api/index.ts']).toBeUndefined();
      expect(files['apps/shell-super-app/shared/api.ts']).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
