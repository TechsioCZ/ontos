import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { runScaffoldEffect } from '../cli.mts';
import { write, snapshotTree } from './fixture-files.mts';

const lifecycleWorker = 'project-people-lifecycle-search';
const lifecycleTopic = 'core.identity.principal-lifecycle-changed.v1';
const payloadDeclaration = 'export const OutboxPayloadSchema = {};';
const replaceWorkerValue = (value: string, worker: string, topic: string): string => {
  if (value === lifecycleWorker) {
    return worker;
  }
  return value === lifecycleTopic ? topic : value;
};
const subscriptionsPath = 'packages/core-runtime/src/people/people-search-subscriptions.ts';
const peopleSearchPath = 'packages/core-runtime/src/people/people-search.ts';
const outboxWorkerCommand = 'outbox-worker';
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
  'protected',
];
const workerArgs = [
  verticalFlag,
  coreOwner,
  '--producer',
  coreOwner,
  '--worker',
  lifecycleWorker,
  '--topic',
  lifecycleTopic,
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
      expect(files[peopleSearchPath]).toContain('defineSystemModuleEntrypoint');
      expect(files[peopleSearchPath]).toContain("legalEntityScope: 'required'");
      expect(files[peopleSearchPath]).toContain("key: 'core.identity.people-search.query'");
      expect(files[peopleSearchPath]).not.toContain('read_people');
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
        providerArgs.map((value) => (value === 'protected' ? 'public' : value)),
      ]) {
        const before = yield* snapshotTree(root);
        yield* scaffold(root, 'search-provider', args).pipe(Effect.flip);
        expect(yield* snapshotTree(root)).toEqual(before);
      }
      yield* scaffold(root, 'resource', [verticalFlag, coreOwner, resourceFlag, 'anything']).pipe(Effect.flip);
      for (const args of [
        workerArgs.map((value) => (value === lifecycleTopic ? 'other.owner.changed.v1' : value)),
        workerArgs.map((value) => (value === lifecycleWorker ? 'unreviewed-worker' : value)),
        workerArgs.map((value) =>
          replaceWorkerValue(value, 'project-people-role-search', 'core.identity.scoped-role-membership-changed.v1'),
        ),
      ]) {
        yield* scaffold(root, outboxWorkerCommand, args).pipe(Effect.flip);
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
        payloadDeclaration,
      );
      yield* scaffold(root, outboxWorkerCommand, workerArgs);
      const files = yield* snapshotTree(root);
      const worker = files['packages/core-runtime/src/people/project-people-lifecycle-search.worker.ts'];
      expect(files[subscriptionsPath]).toContain('consumerModuleKey: coreIdentity');
      expect(files[subscriptionsPath]).toContain('producerModuleKey: coreIdentity');
      expect(files[subscriptionsPath]).toContain('defineSystemModuleEntrypoint');
      expect(worker).toContain('projector.project(context)');
      expect(worker).not.toContain('defineTenantModuleEntrypoint');
      expect(files['packages/core-runtime/src/people/people-search-workers.ts']).toContain(
        'projectPeopleLifecycleSearchSubscription',
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('Core HTTP generation is not routed through the business vertical generator', () =>
  withFixture((root) =>
    Effect.gen(function* noBusinessCoreHttp() {
      for (const action of ['arbitrary-write', 'request-people-search-rebuild']) {
        yield* scaffold(root, 'action-http', [verticalFlag, coreOwner, '--action', action]).pipe(Effect.flip);
        expect(yield* snapshotTree(root)).toEqual({});
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('generates the live rebuild subscription, never the retired role-change stream', () =>
  withFixture((root) =>
    Effect.gen(function* liveRebuildWorker() {
      yield* write(
        root,
        'packages/core-runtime/src/outbox/core-identity-people-search-rebuild-requested-v1.ts',
        payloadDeclaration,
      );
      const args = workerArgs.map((value) =>
        replaceWorkerValue(value, 'rebuild-people-search', 'core.identity.people-search-rebuild-requested.v1'),
      );
      yield* scaffold(root, outboxWorkerCommand, args);
      const files = yield* snapshotTree(root);
      expect(files[subscriptionsPath]).toContain("topic: 'core.identity.people-search-rebuild-requested.v1'");
      expect(files['packages/core-runtime/src/people/rebuild-people-search.worker.ts']).toContain(
        'projector.project(context)',
      );
      expect(JSON.stringify(files)).not.toContain('scoped-role-membership-changed');
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
