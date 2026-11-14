import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Layer, Option, Schema, Stream } from 'effect';
import { Argument, Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import {
  DeliveryPlanSchema,
  DeliveryAttemptSchema,
  DeliveryReceiptSchema,
  planDelivery,
  previousVerifiedBase,
  SERVICES,
  unitInputDigest,
} from './delivery-plan.mts';

const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  name: Schema.String,
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const AppId = Schema.String.pipe(Schema.brand('DeliveryAppId'));
const Intent = Schema.Struct({ modules: Schema.Array(Schema.Struct({ appId: AppId })) });
const Topology = Schema.Struct({
  shell: Schema.Struct({ path: Schema.String }),
  verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});
const Runs = Schema.Struct({
  workflow_runs: Schema.Array(
    Schema.Struct({
      conclusion: Schema.OptionFromNullOr(Schema.String),
      head_branch: Schema.String,
      head_sha: Schema.String,
      id: Schema.Number,
      path: Schema.String,
      run_attempt: Schema.Number,
      run_number: Schema.Number,
      status: Schema.String,
    }),
  ),
});
class DeliveryInputInvalid extends Schema.TaggedError<DeliveryInputInvalid>()('DeliveryInputInvalid', {
  reason: Schema.String,
}) {}

const git = (args: readonly string[]) =>
  Effect.gen(function* runGit() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make('git', args));
    const [stdout, , code] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(handle.stderr), handle.exitCode],
      { concurrency: 'unbounded' },
    );
    if (Number(code) !== 0) {
      return yield* new DeliveryInputInvalid({ reason: `Git command failed: ${args[0]}` });
    }
    return stdout;
  }).pipe(Effect.scoped);
const readCommitted = <A,>(revision: string, filename: string, schema: Schema.Codec<A>) =>
  git(['show', `${revision}:${filename}`]).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))));

const workspacePackage = (directory: string, manifest: typeof Manifest.Type) => ({
  directory,
  name: manifest.name,
  workspaceDependencies: Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => name),
});
export const readWorkspace = (revision: string) =>
  Effect.gen(function* readWorkspaceInputs() {
    const listing = yield* git(['ls-tree', '-rz', '--full-tree', revision]);
    const entries = listing
      .split('\0')
      .filter((value) => value.length > 0)
      .map((row) => {
        const separator = row.indexOf('\t');
        return { identity: row.slice(0, separator), path: row.slice(separator + 1) };
      });
    const manifests = entries.filter((entry) =>
      /^app\/(?:(?:apps|verticals|packages)\/[^/]+|akros-storefront|n1-storefront)\/package\.json$/u.test(entry.path),
    );
    const packages = [];
    for (const entry of manifests) {
      const manifest = yield* readCommitted(revision, entry.path, Manifest);
      packages.push(workspacePackage(path.posix.dirname(entry.path), manifest));
    }
    const intent = yield* readCommitted(revision, 'app/topology/application-release-intent.json', Intent);
    const topology = yield* readCommitted(revision, 'app/topology/reference-topology.json', Topology);
    const units = [{ directory: `app/${topology.shell.path}`, id: 'shell-super-app' }];
    for (const module of intent.modules) {
      const owner = topology.verticals.find((entry) => entry.id === module.appId);
      if (owner === undefined) {
        return yield* new DeliveryInputInvalid({ reason: `Missing topology owner ${module.appId}` });
      }
      units.push({ directory: `app/${owner.path}`, id: module.appId });
    }
    return { entries, packages, units };
  });

const optionalReceipt = (filename: string) =>
  Effect.gen(function* readReceipt() {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(filename).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(DeliveryReceiptSchema))),
      Effect.orElseSucceed(() => null),
    );
  });
const optionalAttempt = (filename: string) =>
  Effect.gen(function* readAttempt() {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(filename).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(DeliveryAttemptSchema))),
      Effect.orElseSucceed(() => null),
    );
  });

const plan = Command.make('plan', { directory: Argument.String('directory') }, ({ directory }) =>
  Effect.gen(function* writePlan() {
    const fs = yield* FileSystem.FileSystem;
    const head = yield* Config.String('GITHUB_SHA');
    const runId = yield* Config.Number('GITHUB_RUN_ID');
    const runAttempt = yield* Config.Number('GITHUB_RUN_ATTEMPT');
    const runNumber = yield* Config.Number('GITHUB_RUN_NUMBER');
    const event = yield* Config.String('GITHUB_EVENT_NAME');
    const workspace = yield* readWorkspace(head);
    const previousReceipt = yield* optionalReceipt(path.join(directory, 'last-success', 'receipt.json'));
    const previousAttempt = yield* optionalAttempt(path.join(directory, 'last-attempt', 'attempt.json'));
    const previousRuns = yield* fs.readFileString(path.join(directory, 'prior-runs.json')).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Runs))),
      Effect.map((runs) => runs.workflow_runs.map((run) => ({ ...run, conclusion: Option.getOrNull(run.conclusion) }))),
      Effect.orElseSucceed(() => []),
    );
    const base = previousVerifiedBase(previousReceipt, previousRuns, runNumber);
    const ancestor =
      base === null
        ? false
        : yield* git(['merge-base', '--is-ancestor', base, head]).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
    const changedPaths =
      ancestor && base !== null
        ? (yield* git(['diff', '--name-only', '--no-renames', '-z', base, head]))
            .split('\0')
            .filter((value) => value.length > 0)
        : [];
    const result = yield* planDelivery({
      ...workspace,
      ancestor,
      changedPaths,
      forceFull: event === 'workflow_dispatch',
      head,
      previousAttempt,
      previousReceipt,
      previousRuns,
      runAttempt,
      runId,
      runNumber,
    });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(DeliveryPlanSchema))(result);
    const encodedReceipt = yield* Schema.encodeEffect(Schema.fromJsonString(DeliveryReceiptSchema))(result.receipt);
    yield* fs.writeFileString(path.join(directory, 'plan.json'), `${encoded}\n`);
    const outputs = yield* Config.String('GITHUB_OUTPUT');
    yield* fs.writeFileString(
      outputs,
      [
        ...SERVICES.map((service) => `${service}=${result.services.includes(service)}`),
        `any=${result.services.length > 0}`,
        `full=${result.full}`,
        `receipt=${encodedReceipt}`,
        '',
      ].join('\n'),
      { flag: 'a' },
    );
    yield* Console.log(encoded);
  }),
);
const digest = Command.make('digest', { directory: Argument.String('unit-directory') }, ({ directory }) =>
  Effect.gen(function* printDigest() {
    const head = (yield* git(['rev-parse', 'HEAD'])).trim();
    const workspace = yield* readWorkspace(head);
    const origins = yield* Effect.forEach(
      ['ONTOS_PUBLIC_ORIGIN', 'ONTOS_STOREFRONT_ORIGIN', 'ONTOS_SHOP_STOREFRONT_ORIGIN'],
      (name) => Config.String(name),
    );
    yield* Console.log(
      yield* unitInputDigest(`app/${directory}`, workspace.packages, workspace.units, workspace.entries, origins),
    );
  }),
);
const digests = Command.make('digests', {}, () =>
  Effect.gen(function* printAllDigests() {
    const head = (yield* git(['rev-parse', 'HEAD'])).trim();
    const workspace = yield* readWorkspace(head);
    const origins = yield* Effect.forEach(
      ['ONTOS_PUBLIC_ORIGIN', 'ONTOS_STOREFRONT_ORIGIN', 'ONTOS_SHOP_STOREFRONT_ORIGIN'],
      (name) => Config.String(name),
    );
    for (const unit of workspace.units) {
      const value = yield* unitInputDigest(
        unit.directory,
        workspace.packages,
        workspace.units,
        workspace.entries,
        origins,
      );
      yield* Console.log(`${unit.id}\t${value}`);
    }
  }),
);
const command = Command.make('delivery-plan').pipe(Command.withSubcommands([plan, digest, digests]));
if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(Layer.provide(NodeServices.layer)),
    ).pipe(Effect.scoped),
  );
}
