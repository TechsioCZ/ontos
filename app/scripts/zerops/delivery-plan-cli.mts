import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Layer, Option, Schema, Stream } from 'effect';
import { Argument, Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import {
  buildEnvironment,
  DELIVERY_ROOTS,
  DeliveryPlanSchema,
  deliveryReads,
  isReferenceSource,
  planDelivery,
  SERVICES,
  unitIdentity,
  unitInputDigest,
  unitInputGraph,
} from './delivery-plan.mts';
import type { GitEntry } from './delivery-plan.mts';

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
const PriorRunSchema = Schema.Struct({
  conclusion: Schema.OptionFromNullOr(Schema.String),
  head_branch: Schema.String,
  head_sha: Schema.String,
  id: Schema.Number,
  path: Schema.String,
  run_attempt: Schema.Number,
  run_number: Schema.Number,
  status: Schema.String,
});
const Service = Schema.Literals(SERVICES);
/**
 * What scripts/zerops/read-delivery-history.sh read from GitHub. `runs` is null when the run list could not be read;
 * each part that could not be read is null, and the plan then deploys every service.
 */
const History = Schema.Struct({
  comparison: Schema.OptionFromNullOr(
    Schema.Struct({
      ancestor: Schema.Boolean,
      base: Schema.String,
      changedPaths: Schema.Array(Schema.String),
      truncated: Schema.Boolean,
    }),
  ),
  mutations: Schema.Array(
    Schema.Struct({
      mutated: Schema.OptionFromNullOr(Schema.Boolean),
      runId: Schema.Number,
      services: Schema.OptionFromNullOr(Schema.Array(Service)),
    }),
  ),
  runs: Schema.OptionFromNullOr(Schema.Array(PriorRunSchema)),
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
// A function expression, not a generic arrow: tests compile this module with SWC, which refuses `<A,>(…) =>` in .mts.
const readCommitted = function readCommitted<A>(
  repository: string,
  revision: string,
  filename: string,
  schema: Schema.Codec<A>,
) {
  return git(['-C', repository, 'show', `${revision}:${filename}`]).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
  );
};

const workspaceNames = (dependencies: Readonly<Record<string, string>>) =>
  Object.entries(dependencies)
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => name);
const workspacePackage = (directory: string, manifest: typeof Manifest.Type) => ({
  directory,
  name: manifest.name,
  runtimeDependencies: workspaceNames({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }),
  workspaceDependencies: Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => name),
});
/** The committed workspace of one revision; `repository` is any directory inside the repository (default: here). */
export const readWorkspace = (revision: string, repository = '.') =>
  Effect.gen(function* readWorkspaceInputs() {
    const listing = yield* git(['-C', repository, 'ls-tree', '-rz', '--full-tree', revision]);
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
      const manifest = yield* readCommitted(repository, revision, entry.path, Manifest);
      packages.push(workspacePackage(path.posix.dirname(entry.path), manifest));
    }
    const intent = yield* readCommitted(repository, revision, 'app/topology/application-release-intent.json', Intent);
    const topology = yield* readCommitted(repository, revision, 'app/topology/reference-topology.json', Topology);
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

/** The committed text of every reference source, read in one `git cat-file --batch`. */
export const readSources = (entries: readonly GitEntry[], repository = '.') =>
  Effect.gen(function* readReferenceSources() {
    const wanted = entries.filter((entry) => isReferenceSource(entry.path) && entry.identity.includes(' blob '));
    const request = new TextEncoder().encode(wanted.map((entry) => `${entry.identity.split(' ')[2] ?? ''}\n`).join(''));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make('git', ['-C', repository, 'cat-file', '--batch'], { stdin: { stream: Stream.make(request) } }),
    );
    const [chunks, , code] = yield* Effect.all(
      [Stream.runCollect(handle.stdout), Stream.runDrain(handle.stderr), handle.exitCode],
      { concurrency: 'unbounded' },
    );
    if (Number(code) !== 0) {
      return yield* new DeliveryInputInvalid({ reason: 'Git command failed: cat-file' });
    }
    const output = Buffer.concat([...chunks]);
    const decoder = new TextDecoder();
    const sources = new Map<string, string>();
    let offset = 0;
    for (const entry of wanted) {
      const end = output.indexOf(0x0a, offset);
      const size = Number(output.subarray(offset, end).toString('latin1').split(' ')[2]);
      if (end === -1 || !Number.isSafeInteger(size)) {
        return yield* new DeliveryInputInvalid({ reason: `Unreadable blob for ${entry.path}` });
      }
      sources.set(entry.path, decoder.decode(output.subarray(end + 1, end + 1 + size)));
      offset = end + 1 + size + 1;
    }
    return sources;
  }).pipe(Effect.scoped);

/** The environment build children inherit, NUL-separated so values may hold newlines. */
const inheritedEnvironment = Effect.gen(function* readEnvironment() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make('env', ['-0']));
  const [listing] = yield* Effect.all(
    [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(handle.stderr), handle.exitCode],
    { concurrency: 'unbounded' },
  );
  return listing.split('\0').flatMap((pair): (readonly [string, string])[] => {
    const separator = pair.indexOf('=');
    return separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
  });
}).pipe(Effect.scoped);

/** The unit identities of one commit, with the build variables of this process. */
export const readUnitIdentities = (revision: string) =>
  Effect.gen(function* readCommittedIdentities() {
    const workspace = yield* readWorkspace(revision);
    const graph = unitInputGraph({ ...workspace, sources: yield* readSources(workspace.entries) });
    const environment = buildEnvironment(yield* inheritedEnvironment);
    const identities = [];
    for (const unit of workspace.units) {
      identities.push({ id: unit.id, ...(yield* unitIdentity(unit.directory, { environment, graph })) });
    }
    return { graph, identities, units: workspace.units };
  });

/** The committed text of a file, for the delivery roots the reference graph does not read as sources. */
const committedText = (revision: string, filename: string) => git(['show', `${revision}:${filename}`]);

const plan = Command.make('plan', { directory: Argument.String('directory') }, ({ directory }) =>
  Effect.gen(function* writePlan() {
    const fs = yield* FileSystem.FileSystem;
    const head = yield* Config.String('GITHUB_SHA');
    const runAttempt = yield* Config.Number('GITHUB_RUN_ATTEMPT');
    const runNumber = yield* Config.Number('GITHUB_RUN_NUMBER');
    const event = yield* Config.String('GITHUB_EVENT_NAME');
    const workspace = yield* readWorkspace(head);
    const graph = unitInputGraph({ ...workspace, sources: yield* readSources(workspace.entries) });
    const texts = new Map<string, string>();
    for (const root of DELIVERY_ROOTS.filter((entry) => !isReferenceSource(entry))) {
      texts.set(root, yield* committedText(head, root));
    }
    // Unreadable or malformed history is no history: every service deploys.
    const history = yield* fs.readFileString(path.join(directory, 'history.json')).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(History))),
      Effect.orElseSucceed(() => ({ comparison: Option.none(), mutations: [], runs: Option.none() })),
    );
    const result = yield* planDelivery({
      ...workspace,
      comparison: Option.getOrNull(history.comparison),
      deliveryReads: yield* deliveryReads(graph, workspace.units, texts),
      forceFull: event === 'workflow_dispatch',
      head,
      mutations: history.mutations.map((entry) => ({
        mutated: Option.getOrNull(entry.mutated),
        runId: entry.runId,
        services: Option.getOrNull(entry.services),
      })),
      previousRuns: Option.getOrElse(history.runs, () => []).map((run) => ({
        ...run,
        conclusion: Option.getOrNull(run.conclusion),
      })),
      runAttempt,
      runNumber,
    });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(DeliveryPlanSchema))(result);
    yield* fs.writeFileString(path.join(directory, 'plan.json'), `${encoded}\n`);
    const outputs = yield* Config.String('GITHUB_OUTPUT');
    yield* fs.writeFileString(
      outputs,
      [
        ...SERVICES.map((service) => `${service}=${result.services.includes(service)}`),
        `any=${result.services.length > 0}`,
        `full=${result.full}`,
        '',
      ].join('\n'),
      { flag: 'a' },
    );
    yield* Console.log(encoded);
  }),
);
const requireOrigins = Effect.forEach(
  ['ONTOS_PUBLIC_ORIGIN', 'ONTOS_STOREFRONT_ORIGIN', 'ONTOS_SHOP_STOREFRONT_ORIGIN'],
  (name) => Config.String(name),
);
const digest = Command.make('digest', { directory: Argument.String('unit-directory') }, ({ directory }) =>
  Effect.gen(function* printDigest() {
    yield* requireOrigins;
    const head = (yield* git(['rev-parse', 'HEAD'])).trim();
    const workspace = yield* readWorkspace(head);
    const graph = unitInputGraph({ ...workspace, sources: yield* readSources(workspace.entries) });
    yield* Console.log(
      yield* unitInputDigest(`app/${directory}`, {
        environment: buildEnvironment(yield* inheritedEnvironment),
        graph,
      }),
    );
  }),
);
const digests = Command.make(
  'digests',
  { revision: Argument.String('revision').pipe(Argument.withDefault('HEAD')) },
  ({ revision }) =>
    Effect.gen(function* printAllDigests() {
      yield* requireOrigins;
      const head = (yield* git(['rev-parse', revision])).trim();
      // unit, identity, committed-inputs part, build variables as NAME=short-hash (read by build-app.sh).
      for (const { digest: value, files, id, variables } of (yield* readUnitIdentities(head)).identities) {
        yield* Console.log(`${id}\t${value}\t${files}\t${variables.join(' ')}`);
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
