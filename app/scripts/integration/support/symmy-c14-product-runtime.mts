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
import { Context, Duration, Effect, FileSystem, Layer, Option, Path, Queue, Ref, Schema, Stream } from 'effect';
import { HttpServer } from 'effect/http';
import { ChildProcess } from 'effect/process';

export const c14AppRoot = fileURLToPath(new URL('../../../', import.meta.url));
export class SymmyC14ProductFixtureUnavailable extends Schema.TaggedError<SymmyC14ProductFixtureUnavailable>()(
  'SymmyC14ProductFixtureUnavailable',
  {
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

export const nativePort = Effect.scoped(
  Effect.gen(function* nativePort() {
    const server = Context.get(
      yield* Layer.build(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: 0 })),
      HttpServer.HttpServer,
    );
    if (!Schema.is(Schema.Struct({ port: Schema.Int }))(server.address)) {
      return yield* unavailable('The native receiver requires a loopback TCP port');
    }
    return server.address.port;
  }),
);

const derivePublishedContract = Effect.fn('SymmyC14ProductFixture.publishedContract')(function* publishedContract(
  vertical: string,
) {
  // Only the canonical CLI's published DTO crosses into Rstest. Opaque owner registration values
  // stay in the native runtime that created them.
  const generator = yield* ChildProcess.make(
    'mise',
    ['exec', '--', 'node', 'scripts/generate-ontos-module-contract.mts', '--vertical', vertical, '--target', 'dist'],
    { cwd: c14AppRoot, stderr: 'pipe', stdout: 'pipe' },
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
    return yield* unavailable(
      `Actual ${vertical} metadata generation failed: ${redactedDiagnostic(errors.join('') + output.join(''))}`,
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const document = yield* fs.readFileString(
    `${c14AppRoot}/verticals/${vertical}/dist/public/.well-known/ontos-module-manifest.json`,
  );
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

export const buildProductOwner = Effect.fn('SymmyC14ProductFixture.buildOwner')(function* buildOwner(
  contract: OntosModuleDeploymentContract,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = `${c14AppRoot}/verticals/${contract.deployment.appId}`;
  // Keep the native artifacts in their owning package scope for generated package self-imports.
  const cache = `${directory}/dist/.cache/INTERNAL_C14_PRODUCT`;
  yield* fs.makeDirectory(cache, { recursive: true });
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: 'owner-' });
  const ownerArtifact = path.join(temporary, 'owner.mjs');
  const receiverArtifact = path.join(temporary, 'receiver.mjs');
  const entry = path.join(temporary, 'owner-entry.ts');
  const api = path.relative(temporary, path.join(directory, 'api/index.ts'));
  const marker = path.relative(temporary, path.join(directory, 'shared/ultramodern-build.ts'));
  // Bundled inside its own package: only the actual owner's public server entry runs in this child.
  yield* fs.writeFileString(
    entry,
    `export { default as assembly } from ${yield* sourceLiteral(api)};\nexport { ultramodernApiMarker as marker } from ${yield* sourceLiteral(marker)};\n`,
  );
  yield* command(
    [
      'esbuild',
      entry,
      ...bundleArguments,
      `--define:ULTRAMODERN_BUILD_MARKER=${yield* sourceLiteral(contract.deployment.buildMarker)}`,
      `--outfile=${ownerArtifact}`,
    ],
    directory,
  );
  yield* command(
    [
      'esbuild',
      `${c14AppRoot}/scripts/integration/support/symmy-c14-product-owner-child.mts`,
      ...bundleArguments,
      `--outfile=${receiverArtifact}`,
    ],
    directory,
  );
  return { ownerArtifact, receiverArtifact };
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
    | '/commerce-market-catalog-api';
}) {
  const child = yield* ChildProcess.make(process.execPath, [input.artifacts.receiverArtifact], {
    cwd: `${c14AppRoot}/verticals/${input.contract.deployment.appId}`,
    env: {
      ...input.environment,
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

export const buildProductWorker = Effect.fn('SymmyC14ProductFixture.buildWorker')(function* buildWorker(
  contract: OntosModuleDeploymentContract,
) {
  const fs = yield* FileSystem.FileSystem;
  const cache = `${c14AppRoot}/verticals/symmy-integration/node_modules/.cache/INTERNAL_C14_PRODUCT`;
  yield* fs.makeDirectory(cache, { recursive: true });
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: cache, prefix: 'worker-' });
  const artifact = `${temporary}/worker.mjs`;
  const workerHost = createRequire(`${c14AppRoot}/package.json`).resolve('@app/symmy-integration/outbox-worker-host');
  yield* command(
    [
      'esbuild',
      `${c14AppRoot}/scripts/integration/support/symmy-c14-product-worker-child.mts`,
      ...bundleArguments,
      `--alias:@app/symmy-integration/outbox-worker-host=${workerHost}`,
      `--define:ULTRAMODERN_BUILD_MARKER=${yield* sourceLiteral(contract.deployment.buildMarker)}`,
      `--outfile=${artifact}`,
    ],
    `${c14AppRoot}/verticals/symmy-integration`,
  );
  return artifact;
});

export const startProductWorker = Effect.fn('SymmyC14ProductFixture.startWorker')(function* startWorker(
  artifact: string,
  environment: Readonly<Record<string, string>>,
) {
  const child = yield* ChildProcess.make(process.execPath, [artifact], {
    cwd: `${c14AppRoot}/verticals/symmy-integration`,
    env: environment,
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
