import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  ActiveApplicationCompositionSnapshotSchema,
  OntosDeploymentIdentitySchema,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  applicationCompositionContentRevision,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type {
  ActiveApplicationCompositionSnapshot,
  ActiveApplicationCompositionUnavailableError,
  OntosModuleDeploymentContract,
} from '@app/core-runtime';
import { makePublishedApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeHttpServer } from '@effect/platform-node';
import {
  Array as EffectArray,
  Config,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Queue,
  Ref,
  Schema,
  Stream,
} from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import type { Redacted } from 'effect';
import { ChildProcess } from 'effect/process';

import {
  encodeModuleCredentialHandover,
  MODULE_CREDENTIAL_HANDOVER_VARIABLE,
} from '../../zerops/module-credentials.mts';

export const c14AppRoot = fileURLToPath(new URL('../../../', import.meta.url));
export class SymmyC14ProductFixtureUnavailable extends Schema.TaggedError<SymmyC14ProductFixtureUnavailable>()(
  'SymmyC14ProductFixtureUnavailable',
  {
    cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
    message: Schema.String,
  },
) {}
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });
const sourceLiteral = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const bundleArguments = ['--bundle', '--platform=node', '--format=esm', '--packages=external'] as const;
const redactedDiagnostic = (value: string) =>
  value
    .replaceAll(/(?<scheme>\w+:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$<scheme>[redacted]@')
    .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[redacted]')
    .slice(-4096);
const compositionFailure = (error: ActiveApplicationCompositionUnavailableError) => {
  const reason = Schema.decodeUnknownOption(Schema.Struct({ reason: Schema.String }))(error.cause);
  if (Option.isSome(reason)) {
    return unavailable(`Genuine composition: ${error.reason}; ${reason.value.reason}`);
  }
  const text = Schema.decodeUnknownOption(Schema.String)(error.cause);
  if (Option.isSome(text)) {
    return unavailable(`Genuine composition: ${error.reason}; ${text.value}`);
  }
  const message = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(error.cause);
  return unavailable(`Genuine composition: ${error.reason}; ${Option.isSome(message) ? message.value.message : ''}`);
};

/**
 * Fixture ports come from a block below the kernel's ephemeral range (32768-60999 on Linux, 49152-65535
 * on macOS), one block per scheduler lane, or block 0 outside the scheduler. A port taken from the
 * ephemeral range and released before an owner child binds it can meanwhile become the local port of
 * any outgoing connection on the runner, and the other lane opens many. Inside its block a lane runs one
 * test process at a time, and that process never hands out a port twice.
 */
const fixturePortBase = 20_000;
const fixturePortBlock = 2000;
const FixturePortLane = Config.Int('ONTOS_CI_WORKER_SLOT').pipe(Config.withDefault(0));
const handedOutPorts = new Set<number>();

const bindFixturePort = (port: number) =>
  Layer.build(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port })).pipe(Effect.as(port), Effect.option);

/**
 * Allocates `count` loopback ports with every listener held open at once, so no two of them, and no
 * other fixture of this lane, can receive the same port. The listeners are released together when this
 * effect completes, immediately before the owner children bind the ports.
 */
export const nativePortList = (count: number) =>
  Effect.scoped(
    Effect.gen(function* allocateFixturePorts() {
      const start = fixturePortBase + (yield* FixturePortLane) * fixturePortBlock;
      const candidates = Array.from({ length: fixturePortBlock }, (_, index) => start + index).filter(
        (port) => !handedOutPorts.has(port),
      );
      const ports = yield* Effect.reduce(
        candidates,
        (): readonly number[] => [],
        (bound, port) =>
          bound.length === count
            ? Effect.succeed(bound)
            : bindFixturePort(port).pipe(
                Effect.map(Option.match({ onNone: () => bound, onSome: (free) => [...bound, free] })),
              ),
      );
      if (ports.length < count) {
        return yield* unavailable(`Fixture port block ${start} has fewer than ${count} free ports`);
      }
      for (const port of ports) {
        handedOutPorts.add(port);
      }
      return ports;
    }),
  );

/** `nativePortList` for the fixtures that address their ports by owner appId. */
export const nativePorts = (keys: readonly string[]) =>
  nativePortList(keys.length).pipe(Effect.map((ports) => new Map(EffectArray.zip(keys, ports))));

const derivePublishedContract = Effect.fn('SymmyC14ProductFixture.publishedContract')(function* publishedContract(
  vertical: string,
) {
  // Only the canonical derivation's published DTO crosses into Rstest. Opaque owner registration values stay in the
  // native runtime that created them. The contract is derived, never written: a unit's dist/ may be a kept build
  // whose outputs no fixture may rewrite.
  const program = `import { Effect, ManagedRuntime, Schema } from 'effect';
    import { NodeServices } from '@effect/platform-node';
    import { deriveOntosModuleDeploymentContract } from './scripts/generate-ontos-module-contract.mts';
    import { OntosModuleDeploymentContractSchema } from '@app/core-runtime';
    const runtime = ManagedRuntime.make(NodeServices.layer);
    try {
      const text = await runtime.runPromise(deriveOntosModuleDeploymentContract({ vertical: process.argv.at(-1) ?? '' }).pipe(
        Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema)))));
      process.stdout.write(text);
    } finally { await runtime.dispose(); }`;
  const generator = yield* ChildProcess.make(
    'mise',
    ['exec', '--', 'node', '--experimental-strip-types', '--input-type=module', '--eval', program, vertical],
    { cwd: c14AppRoot, env: { APP_ENV_PATH: '/dev/null' }, extendEnv: true, stderr: 'pipe', stdout: 'pipe' },
  );
  const [exit, errors, output] = yield* Effect.all(
    [
      generator.exitCode,
      generator.stderr.pipe(Stream.decodeText(), Stream.runCollect),
      generator.stdout.pipe(Stream.decodeText(), Stream.runCollect),
    ],
    { concurrency: 3 },
  );
  if (Number(exit) !== 0) {
    return yield* unavailable(`Actual ${vertical} metadata derivation failed: ${redactedDiagnostic(errors.join(''))}`);
  }
  const document = output.join('');
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(document);
});

const C14PolicyFixtureOwnerSchema = Schema.Literals(['assortment', 'tax']);
export type C14PolicyFixtureOwner = typeof C14PolicyFixtureOwnerSchema.Type;

export const productComposition = Effect.fn('SymmyC14ProductFixture.composition')(function* productComposition(
  backends: Readonly<Record<string, string>>,
  fixtureOwners: readonly C14PolicyFixtureOwner[] = [],
) {
  const contracts = yield* Effect.forEach(
    [
      'symmy-integration',
      'catalog',
      'pricing',
      'price-group-catalog',
      'inventory',
      'party-registry',
      'commerce-customer-context',
      'privacy',
      'commerce-market-catalog',
      ...(fixtureOwners.includes('assortment') ? ['storefront-registry'] : []),
      ...fixtureOwners,
    ],
    derivePublishedContract,
    { concurrency: 3 },
  );
  const fs = yield* FileSystem.FileSystem;
  const runtimeDocument = yield* fs.readFileString(
    `${c14AppRoot}/apps/shell-super-app/dist/public/.well-known/ontos-shell-runtime.json`,
  );
  const runtime = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
    runtimeDocument,
  );
  const base = yield* makePublishedApplicationCompositionSnapshotFixture({
    contractInputs: contracts,
    publishedShellRuntime: { document: runtimeDocument, receiverDeployment: runtime.deployment },
    validityMs: Duration.toMillis(Duration.minutes(30)),
  }).pipe(Effect.mapError(compositionFailure));
  const composition = {
    ...base.composition,
    modules: base.composition.modules.map((module) => ({
      ...module,
      backend: {
        baseUrl: backends[module.deployment.appId] ?? `https://${module.deployment.appId}.example.test/`,
        transport: 'node-http' as const,
      },
    })),
  };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: { ...composition, revision: yield* applicationCompositionContentRevision(composition) },
  }).pipe(Effect.mapError(compositionFailure));
  return { contracts, snapshot };
});

const command = Effect.fn('SymmyC14ProductFixture.command')(function* command(args: readonly string[], cwd: string) {
  const child = yield* ChildProcess.make('mise', ['exec', '--', 'pnpm', 'exec', ...args], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exit, errors] = yield* Effect.all(
    [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stdout)],
    { concurrency: 3 },
  );
  if (Number(exit) !== 0) {
    return yield* unavailable(`Actual owner artifact failed: ${redactedDiagnostic(errors.join(''))}`);
  }
  return yield* Effect.void;
});

const receiverChild = `${c14AppRoot}/scripts/integration/support/symmy-c14-product-owner-child.mts`;
const SourceListSchema = Schema.fromJsonString(Schema.Array(Schema.String));
const MetafileSchema = Schema.fromJsonString(Schema.Struct({ inputs: Schema.Record(Schema.String, Schema.Unknown) }));

const sourceDigest = Effect.fn('SymmyC14ProductFixture.sourceDigest')(function* sourceDigest(input: {
  readonly directory: string;
  readonly key: string;
  readonly sources: readonly string[];
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hash = createHash('sha256').update(input.key);
  for (const source of input.sources) {
    hash
      .update('\u0000')
      .update(source)
      .update('\u0000')
      .update(yield* fs.readFile(path.resolve(input.directory, source)));
  }
  return hash.digest('hex').slice(0, 32);
});

/**
 * The owner and receiver bundles use `--packages=external`, so each is a function of its key and of the
 * local sources esbuild read for it, which its metafile lists. An artifact is named after the key and
 * the bytes of those sources, so an edited source names a new artifact even while the published build
 * marker stays the same. The source list is kept per key, and a source edit that adds an import changes
 * a listed file, so a stale list always misses. Artifacts live in the owning package's build cache,
 * are immutable once named and outlive the per-call scope; test processes that miss together publish
 * identical bytes, and every rename is atomic, so a reader always sees a whole artifact.
 */
const cachedBundle = Effect.fn('SymmyC14ProductFixture.cachedBundle')(function* cachedBundle(input: {
  readonly arguments: (staging: string) => Effect.Effect<readonly string[], PlatformError | Schema.SchemaError>;
  readonly cache: string;
  readonly directory: string;
  readonly key: string;
  readonly name: 'owner' | 'receiver';
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const list = path.join(
    input.cache,
    `${input.name}-${createHash('sha256').update(input.key).digest('hex').slice(0, 32)}.sources.json`,
  );
  const current = yield* fs.readFileString(list).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SourceListSchema)),
    Effect.flatMap((sources) => sourceDigest({ directory: input.directory, key: input.key, sources })),
    Effect.option,
  );
  if (Option.isSome(current)) {
    const cached = path.join(input.cache, `${input.name}-${current.value}.mjs`);
    if (yield* fs.exists(cached)) {
      return cached;
    }
  }
  const staging = yield* fs.makeTempDirectoryScoped({ directory: input.cache, prefix: `${input.name}-pending-` });
  const pending = path.join(staging, `${input.name}.mjs`);
  const metafile = path.join(staging, 'metafile.json');
  yield* command(
    [
      'esbuild',
      ...(yield* input.arguments(staging)),
      ...bundleArguments,
      `--metafile=${metafile}`,
      `--outfile=${pending}`,
    ],
    input.directory,
  );
  const { inputs } = yield* Schema.decodeUnknownEffect(MetafileSchema)(yield* fs.readFileString(metafile));
  // The generated owner entry lives in the staging directory and is a pure function of the key.
  const sources = EffectArray.sort(
    Object.keys(inputs).filter((source) => !path.resolve(input.directory, source).startsWith(`${staging}${path.sep}`)),
    Order.String,
  );
  const artifact = path.join(
    input.cache,
    `${input.name}-${yield* sourceDigest({ directory: input.directory, key: input.key, sources })}.mjs`,
  );
  const pendingList = path.join(staging, 'sources.json');
  yield* fs.writeFileString(pendingList, yield* Schema.encodeEffect(SourceListSchema)(sources));
  yield* fs.rename(pending, artifact);
  yield* fs.rename(pendingList, list);
  return artifact;
});

export const buildProductOwner = Effect.fn('SymmyC14ProductFixture.buildOwner')(function* buildOwner(
  contract: OntosModuleDeploymentContract,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = `${c14AppRoot}/verticals/${contract.deployment.appId}`;
  // Keep the native artifacts in their owning package scope for generated package self-imports, outside dist/:
  // a kept unit's outputs are never written.
  const cache = `${directory}/.cache/INTERNAL_C14_PRODUCT`;
  yield* fs.makeDirectory(cache, { recursive: true });
  // The owner's build marker joins both keys: the cwd of each bundle is the owning package, so its
  // resolved esbuild belongs to that package's installed build, and the owner bundle embeds the marker.
  const { buildMarker } = contract.deployment;
  const receiverArtifact = yield* cachedBundle({
    arguments: () => Effect.succeed([receiverChild]),
    cache,
    directory,
    key: buildMarker,
    name: 'receiver',
  });
  const ownerArtifact = yield* cachedBundle({
    arguments: Effect.fnUntraced(function* ownerEntry(staging: string) {
      const entry = path.join(staging, 'owner-entry.ts');
      const api = path.relative(staging, path.join(directory, 'api/index.ts'));
      const marker = path.relative(staging, path.join(directory, 'shared/ultramodern-build.ts'));
      // Bundled inside its own package: only the actual owner's public server entry runs in this child.
      yield* fs.writeFileString(
        entry,
        `export { default as assembly } from ${yield* sourceLiteral(api)};\nexport { ultramodernApiMarker as marker } from ${yield* sourceLiteral(marker)};\n`,
      );
      return [entry, `--define:ULTRAMODERN_BUILD_MARKER=${yield* sourceLiteral(buildMarker)}`];
    }),
    cache,
    directory,
    key: buildMarker,
    name: 'owner',
  });
  return { ownerArtifact, receiverArtifact };
});

/**
 * A child's module key travels the way the host hands it to an owners process: once, on the private channel (file
 * descriptor 3), and never in the environment. A child given no key holds none, so its delegated calls fail closed.
 */
const moduleCredentialChannel = Effect.fn('SymmyC14ProductFixture.moduleCredentialChannel')(function* channel(
  appId: string,
  moduleKey: Redacted.Redacted | undefined,
) {
  const additionalFds: Record<`fd${number}`, ChildProcess.AdditionalFdConfig> = {};
  const environment: Record<string, string> = {};
  if (moduleKey !== undefined) {
    additionalFds.fd3 = {
      stream: Stream.make(yield* encodeModuleCredentialHandover({ [appId]: moduleKey }, [appId])),
      type: 'input',
    };
    environment[MODULE_CREDENTIAL_HANDOVER_VARIABLE] = 'fd3';
  }
  return { additionalFds, environment };
});

const readySchema = Schema.Struct({
  marker: OntosDeploymentIdentitySchema,
  port: Schema.Int,
  type: Schema.Literal('ready'),
});
export const startProductOwner = Effect.fn('SymmyC14ProductFixture.startOwner')(function* startOwner(input: {
  readonly artifacts: Effect.Success<ReturnType<typeof buildProductOwner>>;
  readonly contract: OntosModuleDeploymentContract;
  readonly environment: Readonly<Record<string, string>>;
  /** The owner's own module key, handed over on its private channel; absent for an owner that calls no module. */
  readonly moduleKey?: Redacted.Redacted | undefined;
  readonly port: number;
  readonly prefix:
    | '/catalog-api'
    | '/symmy-integration-api'
    | '/pricing-api'
    | '/party-registry-api'
    | '/privacy-api'
    | '/commerce-customer-context-api'
    | '/price-group-catalog-api'
    | '/inventory-api'
    | '/assortment-api'
    | '/tax-api'
    | '/commerce-market-catalog-api'
    | '/storefront-registry-api';
}) {
  // These owner fixtures use native business routes against a clone without a Portal Auth realm.
  const portalEnvironmentKeys = [
    'COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL',
    'COMMERCE_PORTAL_AUTH_DATABASE_URL',
    'COMMERCE_PORTAL_AUTH_SECRET',
    'COMMERCE_PORTAL_AUTH_URL',
  ];
  const args = [
    ...portalEnvironmentKeys.flatMap((key) => ['-u', key]),
    process.execPath,
    input.artifacts.receiverArtifact,
  ];
  const credentialChannel = yield* moduleCredentialChannel(input.contract.deployment.appId, input.moduleKey);
  const child = yield* ChildProcess.make('env', args, {
    additionalFds: credentialChannel.additionalFds,
    cwd: `${c14AppRoot}/verticals/${input.contract.deployment.appId}`,
    env: {
      ...input.environment,
      ...credentialChannel.environment,
      ONTOS_C14_OWNER_ARTIFACT: input.artifacts.ownerArtifact,
      ONTOS_C14_OWNER_PORT: String(input.port),
      ONTOS_C14_OWNER_PREFIX: input.prefix,
    },
    extendEnv: true,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const output = yield* Queue.unbounded<string>();
  const diagnostic = yield* Ref.make('');
  yield* Effect.forkScoped(
    child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.all([
          Queue.offer(output, line),
          Ref.update(diagnostic, (previous) => redactedDiagnostic(`${previous + line}\n`)),
        ]),
      ),
    ),
  );
  yield* Effect.forkScoped(
    child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Ref.update(diagnostic, (previous) => redactedDiagnostic(previous + chunk))),
    ),
  );
  const nextReady = Effect.gen(function* nextReady() {
    for (;;) {
      const candidate = Schema.decodeUnknownOption(Schema.fromJsonString(readySchema))(yield* Queue.take(output));
      if (Option.isSome(candidate)) {
        return candidate.value;
      }
    }
  });
  const ready = yield* nextReady.pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(30),
      orElse: () =>
        Ref.get(diagnostic).pipe(Effect.flatMap((text) => unavailable(`Actual owner did not start: ${text}`))),
    }),
  );
  if (
    ready.port !== input.port ||
    ready.marker.buildMarker !== input.contract.deployment.buildMarker ||
    ready.marker.appId !== input.contract.deployment.appId
  ) {
    return yield* unavailable('The compiled owner receiver differs from its published deployment contract');
  }
  return { child, diagnostic: Ref.get(diagnostic), origin: `http://127.0.0.1:${ready.port}`, output };
});

export const encodeProductComposition = (snapshot: ActiveApplicationCompositionSnapshot) =>
  Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(snapshot);

const workerChild = `${c14AppRoot}/scripts/integration/support/symmy-c14-product-worker-child.mts`;

export const buildProductWorker = Effect.fn('SymmyC14ProductFixture.buildWorker')(function* buildWorker(
  contract: OntosModuleDeploymentContract,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = `${c14AppRoot}/verticals/symmy-integration`;
  const cache = `${directory}/node_modules/.cache/INTERNAL_C14_PRODUCT`;
  yield* fs.makeDirectory(cache, { recursive: true });
  const workerHost = createRequire(`${c14AppRoot}/package.json`).resolve('@app/symmy-integration/outbox-worker-host');
  const identity = createHash('sha256')
    .update(yield* fs.readFileString(workerChild))
    .update(contract.deployment.buildMarker)
    .digest('hex')
    .slice(0, 32);
  const publishedWorker = path.join(cache, `worker-${identity}.mjs`);
  if (yield* fs.exists(publishedWorker)) {
    return publishedWorker;
  }
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: 'worker-' });
  const artifact = path.join(temporary, 'worker.mjs');
  yield* command(
    [
      'esbuild',
      workerChild,
      ...bundleArguments,
      `--alias:@app/symmy-integration/outbox-worker-host=${workerHost}`,
      `--define:ULTRAMODERN_BUILD_MARKER=${yield* sourceLiteral(contract.deployment.buildMarker)}`,
      `--outfile=${artifact}`,
    ],
    directory,
  );
  yield* fs.rename(artifact, publishedWorker);
  return publishedWorker;
});

/** The Symmy Outbox Worker child; its module key, if any, is handed over on its private channel. */
export const startProductWorker = Effect.fn('SymmyC14ProductFixture.startWorker')(function* startWorker(
  artifact: string,
  environment: Readonly<Record<string, string>>,
  moduleKey?: Redacted.Redacted,
) {
  const credentialChannel = yield* moduleCredentialChannel('symmy-integration', moduleKey);
  const child = yield* ChildProcess.make(process.execPath, [artifact], {
    additionalFds: credentialChannel.additionalFds,
    cwd: `${c14AppRoot}/verticals/symmy-integration`,
    env: { ...environment, ...credentialChannel.environment },
    extendEnv: true,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const diagnostic = yield* Ref.make('');
  yield* Effect.forkScoped(
    child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Ref.update(diagnostic, (previous) => redactedDiagnostic(previous + chunk))),
    ),
  );
  yield* Effect.forkScoped(
    child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Ref.update(diagnostic, (previous) => redactedDiagnostic(previous + chunk))),
    ),
  );
  return { child, diagnostic: Ref.get(diagnostic) };
});
