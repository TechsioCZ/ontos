#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

import { NodeFileSystem } from '@effect/platform-node';
import {
  Array as EffectArray,
  Config,
  Effect,
  Exit,
  FileSystem,
  ManagedRuntime,
  Option,
  Order,
  Schema,
} from 'effect';
import {
  Headers as MiniflareHeaders,
  Log,
  LogLevel,
  Miniflare,
  Response as MiniflareResponse,
} from 'miniflare';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { PlatformError } from 'effect/PlatformError';
import type { Scope } from 'effect/Scope';
import type { Request as MiniflareRequest, RequestInit as MiniflareRequestInit } from 'miniflare';

const DISTRIBUTED_SSR_FRAGMENT_REQUEST_HEADER = 'x-modern-js-fragment-request';
const APPLICATION_JSON_CONTENT_TYPE = 'application/json';
const CONTENT_TYPE_HEADER = 'content-type';
const DEGRADED_BOUNDARY_MARKER = 'data-modern-distributed-ssr-status="degraded"';
const DISTRIBUTED_SSR_REQUIRED_HEADERS = [
  'x-modern-distributed-ssr-boundary-id',
  'x-modern-distributed-ssr-expose',
  'x-modern-distributed-ssr-props',
  'x-modern-distributed-ssr-remote',
  'x-modern-distributed-ssr-source-url',
];

const JsonTextSchema = Schema.fromJsonString(Schema.Unknown);
const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const UnitIdSchema = Schema.String.pipe(Schema.brand('UnitId'));

const SmokeCheckSchema = Schema.Struct({
  body: Schema.optionalKey(Schema.Json),
  expect: Schema.optionalKey(Schema.Json),
  id: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(Schema.String),
  route: Schema.String,
});
const WranglerSchema = Schema.Struct({
  assets: Schema.optionalKey(
    Schema.Struct({
      binding: Schema.optionalKey(Schema.String),
      directory: Schema.optionalKey(Schema.String),
      run_worker_first: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  compatibility_date: Schema.optionalKey(Schema.String),
  compatibility_flags: Schema.optionalKey(Schema.Array(Schema.String)),
  main: Schema.optionalKey(Schema.String),
  name: Schema.String,
  services: Schema.optionalKey(
    Schema.Array(Schema.Struct({ binding: Schema.String, service: Schema.String })),
  ),
  vars: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const ArtifactSchema = Schema.Struct({
  byteLength: Schema.Number,
  kind: Schema.String,
  logicalPath: Schema.String,
  runtime: Schema.String,
  sha256: Schema.String,
});
const ReleaseEnvelopeIdentitySchema = Schema.Struct({
  buildMarker: Schema.String,
  releaseVersion: Schema.String,
  sourceRevision: Schema.String,
  unitId: UnitIdSchema,
});
const ApiReleaseMarkerSchema = Schema.Struct({
  appId: AppIdSchema,
  build: Schema.String,
  version: Schema.String,
});
const ExecutionEnvelopeSchema = Schema.Struct({
  artifacts: Schema.Array(ArtifactSchema),
  envelopeDigest: Schema.String,
  identity: ReleaseEnvelopeIdentitySchema,
  schemaVersion: Schema.Number,
  surfaces: Schema.Struct({
    apiBackend: Schema.optionalKey(Schema.Array(Schema.String)),
    ssr: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  target: Schema.String,
});
const RawAppSchema = Schema.Struct({
  api: Schema.optionalKey(Schema.Struct({ prefix: Schema.optionalKey(Schema.String) })),
  deliveryUnit: Schema.optionalKey(Schema.Struct({ unitId: Schema.optionalKey(UnitIdSchema) })),
  deploy: Schema.optionalKey(
    Schema.Struct({
      cloudflare: Schema.optionalKey(
        Schema.Struct({
          distributedSsrProofRoutes: Schema.optionalKey(Schema.Array(Schema.String)),
          jsonSmokeChecks: Schema.optionalKey(Schema.Array(SmokeCheckSchema)),
          routes: Schema.optionalKey(Schema.Struct({ ssr: Schema.optionalKey(Schema.String) })),
        }),
      ),
    }),
  ),
  id: AppIdSchema,
  kind: Schema.optionalKey(Schema.String),
  moduleFederation: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      verticalRefs: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  path: Schema.optionalKey(Schema.String),
  port: Schema.Number,
});
const CompactConfigSchema = Schema.Struct({
  topology: Schema.optionalKey(
    Schema.Struct({ apps: Schema.optionalKey(Schema.Array(RawAppSchema)) }),
  ),
});
const ApiResponseSchema = Schema.Struct({ marker: ApiReleaseMarkerSchema });
const ServiceBindingFaultCommandSchema = Schema.Struct({
  appId: AppIdSchema,
  failed: Schema.Boolean,
});
const FragmentPropsSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Null, Schema.Boolean, Schema.Number, Schema.String]),
);
const ServiceBindingFaultResponseSchema = Schema.fromJsonString(
  Schema.Struct({ failed: Schema.Boolean, service: Schema.String }),
);
const TargetUrlsSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

export class WorkerdProofError extends Schema.TaggedError<WorkerdProofError>()(
  'WorkerdProofError',
  { cause: Schema.optionalKey(Schema.Defect()), message: Schema.String },
) {}

type SmokeCheck = typeof SmokeCheckSchema.Type;
type Wrangler = typeof WranglerSchema.Type;
type ExecutionEnvelope = typeof ExecutionEnvelopeSchema.Type;
type ReleaseEnvelopeIdentity = typeof ReleaseEnvelopeIdentitySchema.Type;
type ApiReleaseMarker = typeof ApiReleaseMarkerSchema.Type;
type JsonObject = typeof FragmentPropsSchema.Type;
type ProofFailure = PlatformError | WorkerdProofError;
type ProofEffect<Value> = Effect.Effect<Value, ProofFailure, FileSystem.FileSystem>;
type ScopedProofEffect<Value> = Effect.Effect<Value, ProofFailure, FileSystem.FileSystem | Scope>;
type ServiceBindingHandler = (
  request: MiniflareRequest,
  miniflare: Miniflare,
) => MiniflareResponse | Promise<MiniflareResponse>;
type ServiceBindings = Record<string, ServiceBindingHandler>;

interface WorkerModule {
  readonly path: string;
  readonly type: 'CommonJS' | 'ESModule';
}
interface ServiceReference {
  readonly binding: string;
  readonly service: string;
}
interface BoundModule {
  readonly byteLength: number;
  readonly logicalPath: string;
  readonly runtime: string;
  readonly sha256: string;
  readonly type: 'CommonJS' | 'ESModule';
}
interface App {
  readonly apiPrefix: string | undefined;
  readonly envelope: ExecutionEnvelope | undefined;
  readonly envelopePath: string | undefined;
  readonly id: string;
  readonly jsonSmokeChecks: readonly SmokeCheck[];
  readonly kind: 'shell' | 'vertical';
  readonly outputRoot: string;
  readonly port: number;
  readonly proofRoutes: readonly string[];
  readonly verticalRefs: readonly string[];
  readonly wrangler: Wrangler;
}
interface ExecutionEvidence {
  readonly apiBackend: readonly string[];
  readonly appId: string;
  readonly envelopeDigest: string | null;
  readonly envelopePath: string | null;
  readonly identity: ReleaseEnvelopeIdentity | null;
  readonly main: string;
  readonly modules: readonly BoundModule[];
  readonly modulesRoot: string;
  readonly worker: string;
}
interface WorkerConfiguration {
  readonly executionEvidence: ExecutionEvidence;
  readonly options: ProofWorkerOptions;
}
interface ProofWorkerOptions {
  readonly assets: {
    readonly binding: string;
    readonly directory: string;
    readonly routerConfig: {
      readonly has_user_worker: boolean;
      readonly invoke_user_worker_ahead_of_assets: boolean;
    };
    readonly workerName: string;
  };
  readonly bindings: Readonly<Record<string, string>>;
  readonly compatibilityDate: Wrangler['compatibility_date'];
  readonly compatibilityFlags: readonly string[] | undefined;
  readonly modules: readonly WorkerModule[];
  readonly modulesRoot: string;
  readonly name: string;
  readonly outboundService: ServiceBindingHandler;
  readonly serviceBindings: ServiceBindings;
}
interface ResponseEvidence {
  readonly bodyBase64: string;
  readonly byteLength: number;
  readonly releaseMarker: ApiReleaseMarker;
  readonly sha256: string;
  readonly status: number;
}
interface ApiBindingRequest {
  readonly binding: string;
  readonly callerId: string;
  readonly method: string;
  readonly pathname: string;
  readonly requestBody: {
    readonly contentLength: string | null;
    readonly contentType: string | null;
    readonly present: boolean;
  };
  response?: { readonly contentType: string | null; readonly status: number };
  readonly service: string;
}
interface FragmentBindingRequest {
  readonly binding: string;
  readonly boundaryId: string;
  readonly callerId: string;
  readonly expose: string;
  readonly method: string;
  readonly pathname: string;
  readonly props: JsonObject;
  readonly remote: string;
  readonly service: string;
  readonly sourceUrl: string;
}
interface OutboundRequest {
  readonly callerId: string;
  readonly url: string;
}
interface DistributedBoundary {
  readonly buildMarker: string | undefined;
  readonly digest: string | undefined;
  readonly expose: string;
  readonly key: string;
  readonly remote: string;
  readonly status: string | undefined;
}
interface TargetServers {
  readonly stop: Effect.Effect<void>;
  readonly targetUrls: Readonly<Record<string, string>>;
}
interface StartedTargetServer {
  readonly app: App;
  readonly runtime: Option.Option<Miniflare>;
  readonly server: Server;
}
interface ApiProof {
  readonly appId: string;
  readonly binding: string;
  readonly bindingTarget: {
    readonly appId: string;
    readonly envelopeDigest: string | null;
    readonly worker: string;
  };
  readonly direct: ResponseEvidence;
  readonly id: string | null;
  readonly method: string;
  readonly route: string;
  readonly throughShell: ResponseEvidence;
}
interface ShellProof {
  readonly apiBindingRequests: readonly ApiBindingRequest[];
  readonly boundaries: readonly DistributedBoundary[];
  readonly degradedBoundaryCount: number;
  readonly fragmentBindingRequests: readonly FragmentBindingRequest[];
  readonly outboundRequests: readonly OutboundRequest[];
  readonly route: string;
  readonly shellId: string;
  readonly status: number;
  readonly stylesheetHrefs: readonly string[];
  readonly worker: string;
}
interface RemoteProof {
  readonly appId: string;
  readonly outboundRequests: readonly OutboundRequest[];
  readonly route: string;
  readonly status: number;
  readonly worker: string;
}
interface ShellProofState {
  readonly apiBindingRequests: ApiBindingRequest[];
  readonly fragmentBindingRequests: FragmentBindingRequest[];
  readonly outboundRequests: OutboundRequest[];
  readonly proofs: ShellProof[];
  readonly remoteProofs: RemoteProof[];
  readonly renderedRemoteIds: Set<string>;
}

const proofError = (message: string, cause?: unknown) => {
  if (cause === undefined) {
    return new WorkerdProofError({ message });
  }
  return new WorkerdProofError({ cause, message });
};
const ensure = (condition: boolean, message: string): Effect.Effect<void, WorkerdProofError> =>
  condition ? Effect.void : Effect.fail(proofError(message));
const sha256 = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const count = (source: string, value: string) => source.split(value).length - 1;
const normalizePath = (value: string) => value.replaceAll('\\', '/');
const adapterRuntime = ManagedRuntime.make(NodeFileSystem.layer);

const encodeJson = <Value,>(value: Value): Effect.Effect<string, WorkerdProofError> =>
  Schema.encodeEffect(JsonTextSchema)(value).pipe(
    Effect.mapError((cause) => proofError('Could not encode JSON', cause)),
  );

const readJsonDocument = <DocumentSchema extends Schema.ConstraintDecoder<unknown>>(
  absolutePath: string,
  schema: DocumentSchema,
): ProofEffect<DocumentSchema['Type']> =>
  Effect.gen(function* readJsonDocumentEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(absolutePath);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(source).pipe(
      Effect.mapError((cause) => proofError(`Invalid JSON document ${absolutePath}`, cause)),
    );
  });

const collectJavaScriptFiles = (absoluteDirectory: string): ProofEffect<readonly string[]> =>
  Effect.gen(function* collectJavaScriptFilesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(absoluteDirectory))) {
      return [];
    }
    const names = yield* fileSystem.readDirectory(absoluteDirectory);
    const nested = yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* collectEntryEffect() {
          const absolutePath = path.join(absoluteDirectory, name);
          const info = yield* fileSystem.stat(absolutePath);
          if (info.type === 'Directory') {
            return yield* collectJavaScriptFiles(absolutePath);
          }
          return info.type === 'File' && /\.(?:c|m)?js$/u.test(name) ? [absolutePath] : [];
        }),
      { concurrency: 1 },
    );
    return EffectArray.sort(nested.flat(), Order.String);
  });

const createWorkerModules = (
  outputRoot: string,
  main: string,
): ProofEffect<readonly WorkerModule[]> =>
  Effect.gen(function* createWorkerModulesEffect() {
    const entryPath = path.resolve(outputRoot, main);
    const collected = yield* Effect.all(
      [
        collectJavaScriptFiles(path.join(outputRoot, 'server')),
        collectJavaScriptFiles(path.join(outputRoot, 'worker')),
      ],
      { concurrency: 2 },
    );
    const modulePaths = [entryPath, ...collected.flat()].filter(
      (modulePath, index, paths) => paths.indexOf(modulePath) === index,
    );
    return modulePaths.map((modulePath): WorkerModule => ({
      path: modulePath,
      type: modulePath.endsWith('.cjs') ? 'CommonJS' : 'ESModule',
    }));
  });

const readExecutionEnvelope = (
  appId: string,
  outputRoot: string,
  expectedUnitId: string | undefined,
): ProofEffect<{ readonly envelope: ExecutionEnvelope; readonly envelopePath: string }> =>
  Effect.gen(function* readExecutionEnvelopeEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const envelopePath = path.join(outputRoot, 'release/microvertical-release-envelope.json');
    yield* ensure(
      yield* fileSystem.exists(envelopePath),
      `${appId} executed .output release envelope is missing`,
    );
    const envelope = yield* readJsonDocument(envelopePath, ExecutionEnvelopeSchema);
    yield* ensure(envelope.schemaVersion === 3, `${appId} executed envelope schema must be 3`);
    yield* ensure(
      envelope.target === 'cloudflare',
      `${appId} executed envelope must target cloudflare`,
    );
    yield* ensure(
      expectedUnitId !== undefined &&
        expectedUnitId.length > 0 &&
        envelope.identity.unitId === expectedUnitId,
      `${appId} executed envelope unit identity is invalid`,
    );
    yield* ensure(
      /^[a-f\d]{64}$/u.test(envelope.envelopeDigest),
      `${appId} executed envelope digest is invalid`,
    );
    yield* ensure(envelope.artifacts.length > 0, `${appId} executed envelope has no artifacts`);
    return { envelope, envelopePath };
  });

const bindExecutedModule = (
  app: App,
  envelope: ExecutionEnvelope,
  module: WorkerModule,
): ProofEffect<BoundModule> =>
  Effect.gen(function* bindExecutedModuleEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const logicalPath = normalizePath(path.relative(app.outputRoot, module.path));
    yield* ensure(
      logicalPath.length > 0 &&
        !logicalPath.startsWith('../') &&
        !path.posix.isAbsolute(logicalPath),
      `${app.id} selected module escapes .output: ${logicalPath}`,
    );
    const artifact = envelope.artifacts.find((candidate) => candidate.logicalPath === logicalPath);
    if (artifact === undefined) {
      return yield* Effect.fail(
        proofError(`${app.id} selected module ${logicalPath} is not envelope-bound`),
      );
    }
    yield* ensure(
      artifact.kind === 'file',
      `${app.id} selected module ${logicalPath} is bound to a non-file artifact`,
    );
    const bytes = yield* fileSystem.readFile(module.path);
    const digest = sha256(bytes);
    yield* ensure(
      artifact.byteLength === bytes.byteLength && artifact.sha256 === digest,
      `${app.id} selected module ${logicalPath} differs from its envelope artifact`,
    );
    return {
      byteLength: bytes.byteLength,
      logicalPath,
      runtime: artifact.runtime,
      sha256: digest,
      type: module.type,
    };
  });

const resolveAppPath = (id: string, kind: App['kind'], configuredPath: string | undefined) => {
  if (configuredPath !== undefined) {
    return normalizePath(configuredPath);
  }
  return kind === 'shell' ? 'apps/shell-super-app' : `verticals/${id}`;
};
const resolveProofRoutes = (
  configuredRoutes: readonly string[],
  configuredSsrRoute: string | undefined,
) => {
  const proofRoutes = [...new Set(configuredRoutes.filter((route) => route.startsWith('/')))];
  if (proofRoutes.length > 0) {
    return proofRoutes;
  }
  return [configuredSsrRoute?.startsWith('/') === true ? configuredSsrRoute : '/'];
};

const deriveAppConfiguration = (rawApp: typeof RawAppSchema.Type) => {
  const cloudflare = rawApp.deploy?.cloudflare;
  return {
    apiPrefix: rawApp.api?.prefix?.replace(/\/+$/u, ''),
    id: rawApp.id,
    jsonSmokeChecks: cloudflare?.jsonSmokeChecks ?? [],
    port: rawApp.port,
    proofRoutes: resolveProofRoutes(
      cloudflare?.distributedSsrProofRoutes ?? [],
      cloudflare?.routes?.ssr,
    ),
    verticalRefs: rawApp.moduleFederation?.verticalRefs ?? [],
  };
};

const loadApps = (workspaceRoot: string): ProofEffect<readonly App[]> =>
  Effect.gen(function* loadAppsEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const compactConfig = yield* readJsonDocument(
      path.join(workspaceRoot, '.modernjs/ultramodern.json'),
      CompactConfigSchema,
    );
    return yield* Effect.forEach(
      compactConfig.topology?.apps ?? [],
      (rawApp) =>
        Effect.gen(function* loadAppEffect() {
          const kind: App['kind'] = rawApp.kind === 'vertical' ? 'vertical' : 'shell';
          const appPath = resolveAppPath(rawApp.id, kind, rawApp.path);
          const outputRoot = path.join(workspaceRoot, appPath, '.output');
          const wranglerPath = path.join(outputRoot, 'wrangler.json');
          yield* ensure(
            yield* fileSystem.exists(wranglerPath),
            `${rawApp.id} Cloudflare output is missing; run pnpm cloudflare:build first`,
          );
          const wrangler = yield* readJsonDocument(wranglerPath, WranglerSchema);
          const executedEnvelope =
            kind === 'vertical'
              ? yield* readExecutionEnvelope(rawApp.id, outputRoot, rawApp.deliveryUnit?.unitId)
              : undefined;
          return {
            ...deriveAppConfiguration(rawApp),
            envelope: executedEnvelope?.envelope,
            envelopePath: executedEnvelope?.envelopePath,
            kind,
            outputRoot,
            wrangler,
          };
        }),
      { concurrency: 1 },
    );
  });

const workerName = (app: App): Effect.Effect<string, WorkerdProofError> =>
  app.wrangler.name.length > 0
    ? Effect.succeed(app.wrangler.name)
    : Effect.fail(proofError(`${app.id} wrangler output must define a worker name`));

const createWorkerConfiguration = (
  app: App,
  workspaceRoot: string,
  outboundService: ServiceBindingHandler,
  serviceBindings: ServiceBindings,
): ProofEffect<WorkerConfiguration> =>
  Effect.gen(function* createWorkerConfigurationEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const main = app.wrangler.main ?? 'server/index.mjs';
    const assets = app.wrangler.assets ?? {};
    const modules = yield* createWorkerModules(app.outputRoot, main);
    const boundModules = yield* Effect.forEach(
      modules,
      (module) =>
        app.envelope === undefined
          ? Effect.gen(function* bindShellModuleEffect() {
              const bytes = yield* fileSystem.readFile(module.path);
              return {
                byteLength: bytes.byteLength,
                logicalPath: normalizePath(path.relative(app.outputRoot, module.path)),
                runtime: 'workerd',
                sha256: sha256(bytes),
                type: module.type,
              };
            })
          : bindExecutedModule(app, app.envelope, module),
      { concurrency: 1 },
    );
    const mainLogicalPath = normalizePath(
      path.relative(app.outputRoot, path.resolve(app.outputRoot, main)),
    );
    yield* ensure(
      boundModules.some((module) => module.logicalPath === mainLogicalPath),
      `${app.id} Miniflare main ${mainLogicalPath} is not in the selected module set`,
    );
    const validateSelectedSurfaces = Effect.gen(function* validateSelectedSurfacesEffect() {
      const apiBackend = app.envelope?.surfaces.apiBackend ?? [];
      const ssr = app.envelope?.surfaces.ssr ?? [];
      const selectedPaths = new Set(boundModules.map((module) => module.logicalPath));
      yield* ensure(
        app.kind !== 'vertical' ||
          (apiBackend.length > 0 &&
            apiBackend.every((logicalPath) => selectedPaths.has(logicalPath))),
        `${app.id} BFF worker surface is not selected by Miniflare`,
      );
      yield* ensure(
        app.kind !== 'vertical' ||
          (ssr.includes(mainLogicalPath) &&
            boundModules.every((module) => [...ssr, ...apiBackend].includes(module.logicalPath))),
        `${app.id} Miniflare main/SSR modules are not envelope-bound SSR surfaces`,
      );

      return { apiBackend };
    });
    const { apiBackend } = yield* validateSelectedSurfaces;
    const name = yield* workerName(app);
    const options: ProofWorkerOptions = {
      assets: {
        binding: assets.binding ?? 'ASSETS',
        directory: path.resolve(app.outputRoot, assets.directory ?? './public'),
        routerConfig: {
          has_user_worker: true,
          invoke_user_worker_ahead_of_assets: assets.run_worker_first !== false,
        },
        workerName: name,
      },
      bindings: {
        ...app.wrangler.vars,
        DATABASE_URL: 'postgresql://workerd-proof:workerd-proof@127.0.0.1:5432/workerd-proof',
        SPICEDB_ENDPOINT: '127.0.0.1:50051',
        SPICEDB_INSECURE: 'true',
        SPICEDB_PRESHARED_KEY: 'workerd-proof',
      },
      compatibilityDate: app.wrangler.compatibility_date,
      compatibilityFlags: app.wrangler.compatibility_flags,
      modules,
      modulesRoot: app.outputRoot,
      name,
      outboundService,
      serviceBindings,
    };
    return {
      executionEvidence: {
        apiBackend,
        appId: app.id,
        envelopeDigest: app.envelope?.envelopeDigest ?? null,
        envelopePath:
          app.envelopePath === undefined
            ? null
            : normalizePath(path.relative(workspaceRoot, app.envelopePath)),
        identity: app.envelope?.identity ?? null,
        main: mainLogicalPath,
        modules: boundModules,
        modulesRoot: normalizePath(path.relative(workspaceRoot, app.outputRoot)),
        worker: name,
      },
      options,
    };
  });

const responseEvidence = (
  app: App,
  response: MiniflareResponse,
): Effect.Effect<ResponseEvidence, WorkerdProofError> =>
  Effect.gen(function* responseEvidenceEffect() {
    const arrayBuffer = yield* Effect.tryPromise({
      catch: (cause) => proofError(`${app.id} API response body could not be read`, cause),
      try: async () => await response.arrayBuffer(),
    });
    const bytes = Buffer.from(arrayBuffer);
    const source = bytes.toString('utf-8');
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApiResponseSchema))(
      source,
    ).pipe(
      Effect.mapError((cause) => proofError(`${app.id} API response is not valid JSON`, cause)),
    );
    const { marker } = body;
    yield* ensure(
      marker.appId === app.id &&
        marker.build === app.envelope?.identity.buildMarker &&
        marker.version === app.envelope.identity.releaseVersion,
      `${app.id} API response is not tied to its executed release identity: ${source.slice(0, 1000)}`,
    );
    yield* ensure(response.ok, `${app.id} API response returned HTTP ${response.status}`);
    return {
      bodyBase64: bytes.toString('base64'),
      byteLength: bytes.byteLength,
      releaseMarker: marker,
      sha256: sha256(bytes),
      status: response.status,
    };
  });

const resolveApiSmokeChecks = (app: App, shell: App): readonly SmokeCheck[] => {
  const shellChecks =
    app.apiPrefix?.startsWith('/') === true
      ? shell.jsonSmokeChecks.filter(
          (check) => check.route === app.apiPrefix || check.route.startsWith(`${app.apiPrefix}/`),
        )
      : [];
  const uniqueChecks = new Map<string, SmokeCheck>();
  for (const check of [...app.jsonSmokeChecks, ...shellChecks]) {
    const key = [(check.method ?? 'GET').toUpperCase(), check.route, check.id ?? ''].join('\u0000');
    if (!uniqueChecks.has(key)) {
      uniqueChecks.set(key, check);
    }
  }
  return [...uniqueChecks.values()];
};

const runApiCheck = (
  app: App,
  appWorkerName: string,
  binding: string,
  check: SmokeCheck,
  miniflare: Miniflare,
  shellWorkerName: string,
  targetEvidence: ExecutionEvidence,
): Effect.Effect<ApiProof, WorkerdProofError> =>
  Effect.gen(function* runApiCheckEffect() {
    const method = (check.method ?? 'GET').toUpperCase();
    const headers = new MiniflareHeaders();
    const body =
      check.body === undefined
        ? undefined
        : yield* Schema.encodeEffect(JsonTextSchema)(check.body).pipe(
            Effect.mapError((cause) => proofError(`${app.id} smoke body is invalid`, cause)),
          );
    if (body !== undefined) {
      headers.set(CONTENT_TYPE_HEADER, APPLICATION_JSON_CONTENT_TYPE);
    }
    const init: MiniflareRequestInit = { headers, method };
    if (body !== undefined) {
      init.body = body;
    }
    const target = yield* Effect.tryPromise({
      catch: (cause) => proofError(`${app.id} worker could not be resolved`, cause),
      try: async () => await miniflare.getWorker(appWorkerName),
    });
    const directResponse = yield* Effect.tryPromise({
      catch: (cause) => proofError(`${app.id} direct API request failed`, cause),
      try: async () => await target.fetch(`https://${appWorkerName}.invalid${check.route}`, init),
    });
    const direct = yield* responseEvidence(app, directResponse);
    const shellResponse = yield* Effect.tryPromise({
      catch: (cause) => proofError(`${app.id} Shell API request failed`, cause),
      try: async () =>
        await miniflare.dispatchFetch(`https://${shellWorkerName}.invalid${check.route}`, init),
    });
    const throughShell = yield* responseEvidence(app, shellResponse);
    yield* ensure(
      direct.sha256 === throughShell.sha256,
      `${app.id} direct and service-binding API responses differ`,
    );
    return {
      appId: app.id,
      binding,
      bindingTarget: {
        appId: app.id,
        envelopeDigest: targetEvidence.envelopeDigest,
        worker: appWorkerName,
      },
      direct,
      id: check.id ?? null,
      method,
      route: check.route,
      throughShell,
    };
  });

const runAppApiProofs = (
  app: App,
  miniflare: Miniflare,
  shell: App,
  executionByAppId: ReadonlyMap<string, ExecutionEvidence>,
): Effect.Effect<readonly ApiProof[], WorkerdProofError> =>
  Effect.gen(function* runAppApiProofsEffect() {
    const checks = resolveApiSmokeChecks(app, shell);
    yield* ensure(checks.length > 0, `${app.id} has no real Cloudflare API smoke check`);
    const appWorkerName = yield* workerName(app);
    const shellWorkerName = yield* workerName(shell);
    const binding = (shell.wrangler.services ?? []).find(
      (candidate) => candidate.service === appWorkerName,
    );
    const targetEvidence = executionByAppId.get(app.id);
    if (binding === undefined || targetEvidence === undefined) {
      return yield* Effect.fail(proofError(`${app.id} service-binding evidence is missing`));
    }
    return yield* Effect.forEach(
      checks,
      (check) =>
        runApiCheck(
          app,
          appWorkerName,
          binding.binding,
          check,
          miniflare,
          shellWorkerName,
          targetEvidence,
        ),
      { concurrency: 1 },
    );
  });

const runApiProofs = (
  apps: readonly App[],
  miniflare: Miniflare,
  shell: App,
  executionByAppId: ReadonlyMap<string, ExecutionEvidence>,
): Effect.Effect<readonly ApiProof[], WorkerdProofError> =>
  Effect.forEach(
    apps.filter((candidate) => candidate.kind === 'vertical'),
    (app) => runAppApiProofs(app, miniflare, shell, executionByAppId),
    { concurrency: 1 },
  ).pipe(Effect.map((nested) => nested.flat()));

const readRequestBody = (
  request: IncomingMessage,
): Effect.Effect<Option.Option<Buffer>, WorkerdProofError> =>
  Effect.callback((resume) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = () => {
      resume(
        Effect.succeed(chunks.length > 0 ? Option.some(Buffer.concat(chunks)) : Option.none()),
      );
    };
    const onError = (cause: Error) => {
      resume(Effect.fail(proofError('Could not read incoming proof request', cause)));
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    return Effect.sync(() => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
    });
  });
const listen = (server: Server, port: number): Effect.Effect<void, WorkerdProofError> =>
  Effect.callback((resume) => {
    const onError = (cause: Error) => {
      resume(Effect.fail(proofError(`Could not listen on proof port ${port}`, cause)));
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resume(Effect.void);
    });
    return Effect.sync(() => {
      server.off('error', onError);
    });
  });
const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => {
      resume(Effect.void);
    });
  });

const copyIncomingHeaders = (incoming: IncomingMessage): MiniflareHeaders => {
  const headers = new MiniflareHeaders();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      headers.set(name, value.join(', '));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
};

const handleTargetRequest = (
  apps: readonly App[],
  app: App,
  runtime: Miniflare,
  failedServices: Set<string>,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Effect.Effect<void> =>
  Effect.gen(function* handleTargetRequestEffect() {
    const body = Option.getOrUndefined(yield* readRequestBody(incoming));
    if (
      incoming.method === 'POST' &&
      incoming.url === '/_ultramodern-proof/service-binding-fault'
    ) {
      const command = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ServiceBindingFaultCommandSchema),
      )(body?.toString('utf-8') ?? '{}').pipe(
        Effect.mapError((cause) => proofError('Invalid service-binding fault command', cause)),
      );
      const targetApp = yield* Effect.fromOption(
        Option.fromNullishOr(apps.find((candidate) => candidate.id === command.appId)),
        () => proofError(`Unknown service-binding fault target ${command.appId}`),
      );
      const service = yield* workerName(targetApp);
      if (command.failed) {
        failedServices.add(service);
      } else {
        failedServices.delete(service);
      }
      const encoded = yield* Schema.encodeEffect(ServiceBindingFaultResponseSchema)({
        failed: failedServices.has(service),
        service,
      }).pipe(Effect.mapError((cause) => proofError('Could not encode fault response', cause)));
      yield* Effect.sync(() => {
        outgoing.writeHead(200, { [CONTENT_TYPE_HEADER]: APPLICATION_JSON_CONTENT_TYPE });
        outgoing.end(encoded);
      });
    } else {
      const name = yield* workerName(app);
      const init: MiniflareRequestInit = {
        headers: copyIncomingHeaders(incoming),
        method: incoming.method,
      };
      if (body !== undefined) {
        init.body = new Uint8Array(body);
      }
      const response = yield* Effect.tryPromise({
        catch: (cause) => proofError(`${app.id} target dispatch failed`, cause),
        try: async () =>
          await runtime.dispatchFetch(`https://${name}.invalid${incoming.url ?? '/'}`, init),
      });
      const bytes = yield* Effect.tryPromise({
        catch: (cause) => proofError('Could not read Worker response', cause),
        try: async () => await response.arrayBuffer(),
      });
      yield* Effect.sync(() => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        outgoing.end(Buffer.from(bytes));
      });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError(cause).pipe(
        Effect.andThen(
          Effect.sync(() => {
            outgoing.writeHead(500, { [CONTENT_TYPE_HEADER]: 'text/plain; charset=utf-8' });
            outgoing.end('Workerd proof request failed');
          }),
        ),
      ),
    ),
  );

const createTargetRequestListener =
  (apps: readonly App[], app: App, runtime: Miniflare, failedServices: Set<string>) =>
  (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    adapterRuntime.runCallback(
      handleTargetRequest(apps, app, runtime, failedServices, incoming, outgoing),
    );
  };

const startTargetServer = (
  apps: readonly App[],
  app: App,
  configuration: ProofWorkerOptions | undefined,
  failedServices: Set<string>,
  miniflare: Miniflare,
): Effect.Effect<StartedTargetServer, WorkerdProofError> =>
  Effect.gen(function* startTargetServerEffect() {
    yield* ensure(
      Number.isInteger(app.port) && app.port > 0,
      `${app.id} requires a configured local port for all-workerd browser proof`,
    );
    if (configuration === undefined) {
      return yield* Effect.fail(proofError(`${app.id} Worker configuration is missing`));
    }
    const runtime =
      app.kind === 'vertical'
        ? new Miniflare({ log: new Log(LogLevel.ERROR), workers: [configuration] })
        : miniflare;
    const server = http.createServer(
      createTargetRequestListener(apps, app, runtime, failedServices),
    );
    yield* listen(server, app.port);
    return {
      app,
      runtime: runtime === miniflare ? Option.none() : Option.some(runtime),
      server,
    };
  });

const disposeTargetRuntime = (runtime: Option.Option<Miniflare>): Effect.Effect<void> => {
  if (Option.isNone(runtime)) {
    return Effect.void;
  }
  return Effect.tryPromise({
    catch: () => proofError('Could not dispose isolated Workerd runtime'),
    try: async () => await runtime.value.dispose(),
  }).pipe(Effect.ignore);
};

const startWorkerdTargetServers = (
  apps: readonly App[],
  miniflare: Miniflare,
  failedServices: Set<string>,
  workerConfigurations: readonly ProofWorkerOptions[],
): Effect.Effect<TargetServers, WorkerdProofError> =>
  Effect.gen(function* startWorkerdTargetServersEffect() {
    const started = yield* Effect.forEach(
      apps,
      (app, index) =>
        startTargetServer(apps, app, workerConfigurations[index], failedServices, miniflare),
      { concurrency: 1 },
    );
    const targetUrls = Object.fromEntries(
      started.map(({ app }) => [app.id, `http://127.0.0.1:${app.port}`]),
    );
    const runtimeDisposals = started.map(({ runtime }) => disposeTargetRuntime(runtime));
    const stop = Effect.all(
      [...started.map(({ server }) => closeServer(server)), ...runtimeDisposals],
      { concurrency: 'unbounded' },
    ).pipe(Effect.asVoid);
    return { stop, targetUrls };
  });

const readAttribute = (tag: string, name: string) => {
  const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  const match = new RegExp(`\\s${escapedName}=(?:"([^"]*)"|'([^']*)')`, 'u').exec(tag);
  return match?.[1] ?? match?.[2];
};
const collectDistributedBoundaries = (
  html: string,
): Effect.Effect<readonly DistributedBoundary[], WorkerdProofError> =>
  Effect.forEach(
    html.matchAll(/<[a-z][^>]*data-modern-distributed-ssr-boundary=(?:"[^"]+"|'[^']+')[^>]*>/giu),
    (match) =>
      Effect.gen(function* collectBoundaryEffect() {
        const [tag] = match;
        const key = readAttribute(tag, 'data-modern-distributed-ssr-boundary');
        const separator = key?.indexOf('::') ?? -1;
        if (key === undefined || separator <= 0) {
          return yield* Effect.fail(proofError(`Invalid distributed SSR boundary key ${key}`));
        }
        return {
          buildMarker: readAttribute(tag, 'data-modern-distributed-ssr-build'),
          digest: readAttribute(tag, 'data-modern-distributed-ssr-digest'),
          expose: key.slice(separator + 2),
          key,
          remote: key.slice(0, separator),
          status: readAttribute(tag, 'data-modern-distributed-ssr-status'),
        };
      }),
    { concurrency: 1 },
  );
const collectStylesheetHrefs = (html: string): readonly string[] =>
  [...html.matchAll(/<link\b[^>]*>/giu)]
    .filter(
      (match) => readAttribute(match[0], 'rel')?.split(/\s+/u).includes('stylesheet') === true,
    )
    .map((match) => readAttribute(match[0], 'href'))
    .filter((href): href is string => href !== undefined);
const isDistributedSsrFragmentRequest = (request: MiniflareRequest) =>
  request.headers.get(DISTRIBUTED_SSR_FRAGMENT_REQUEST_HEADER) === '1';
const readRequiredFragmentHeader = (
  request: MiniflareRequest,
  header: string,
): Effect.Effect<string, WorkerdProofError> => {
  const value = request.headers.get(header);
  return value === null || value.length === 0
    ? Effect.fail(proofError(`Distributed SSR fragment request is missing ${header}`))
    : Effect.succeed(value);
};
const decodeDistributedSsrFragmentRequest = (
  request: MiniflareRequest,
): Effect.Effect<
  {
    readonly boundaryId: string;
    readonly expose: string;
    readonly props: JsonObject;
    readonly remote: string;
    readonly sourceUrl: string;
  },
  WorkerdProofError
> =>
  Effect.gen(function* decodeDistributedSsrFragmentRequestEffect() {
    yield* ensure(
      isDistributedSsrFragmentRequest(request),
      'Distributed SSR fragment request is missing its request marker',
    );
    yield* ensure(
      request.method === 'GET',
      `Distributed SSR fragment request must use GET, received ${request.method}`,
    );
    const values = yield* Effect.forEach(
      DISTRIBUTED_SSR_REQUIRED_HEADERS,
      (header) => readRequiredFragmentHeader(request, header),
      { concurrency: 5 },
    );
    const headers = new Map(
      DISTRIBUTED_SSR_REQUIRED_HEADERS.map((header, index) => [header, values[index]]),
    );
    const propsSource = headers.get('x-modern-distributed-ssr-props');
    const sourceUrl = headers.get('x-modern-distributed-ssr-source-url');
    const boundaryId = headers.get('x-modern-distributed-ssr-boundary-id');
    const expose = headers.get('x-modern-distributed-ssr-expose');
    const remote = headers.get('x-modern-distributed-ssr-remote');
    if (
      propsSource === undefined ||
      sourceUrl === undefined ||
      boundaryId === undefined ||
      expose === undefined ||
      remote === undefined
    ) {
      return yield* Effect.fail(proofError('Distributed SSR fragment headers are incomplete'));
    }
    const props = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FragmentPropsSchema))(
      decodeURIComponent(propsSource),
    ).pipe(Effect.mapError((cause) => proofError('Fragment props must be an object', cause)));
    yield* ensure(URL.canParse(sourceUrl), 'Distributed SSR fragment source URL must be absolute');
    return { boundaryId, expose, props, remote, sourceUrl };
  });

const handleServiceBinding = (
  caller: App,
  apiBindingRequests: ApiBindingRequest[],
  failedServices: Set<string>,
  fragmentBindingRequests: FragmentBindingRequest[],
  miniflare: Miniflare,
  request: MiniflareRequest,
  service: ServiceReference,
): Effect.Effect<MiniflareResponse, WorkerdProofError> =>
  Effect.gen(function* serviceBindingEffect() {
    if (failedServices.has(service.service)) {
      return yield* Effect.fail(
        proofError(`Injected unavailable service binding ${service.binding} -> ${service.service}`),
      );
    }
    const requestUrl = new URL(request.url);
    let apiBindingRequest: ApiBindingRequest | undefined;
    if (isDistributedSsrFragmentRequest(request)) {
      const fragment = yield* decodeDistributedSsrFragmentRequest(request);
      fragmentBindingRequests.push({
        binding: service.binding,
        boundaryId: fragment.boundaryId,
        callerId: caller.id,
        expose: fragment.expose,
        method: request.method,
        pathname: requestUrl.pathname,
        props: fragment.props,
        remote: fragment.remote,
        service: service.service,
        sourceUrl: fragment.sourceUrl,
      });
    } else {
      apiBindingRequest = {
        binding: service.binding,
        callerId: caller.id,
        method: request.method,
        pathname: requestUrl.pathname,
        requestBody: {
          contentLength: request.headers.get('content-length'),
          contentType: request.headers.get(CONTENT_TYPE_HEADER),
          present: request.body !== null,
        },
        service: service.service,
      };
      apiBindingRequests.push(apiBindingRequest);
    }
    const target = yield* Effect.tryPromise({
      catch: (cause) => proofError(`Could not resolve service ${service.service}`, cause),
      try: async () => await miniflare.getWorker(service.service),
    });
    const response = yield* Effect.tryPromise({
      catch: (cause) => proofError(`Service ${service.service} request failed`, cause),
      try: async () => await target.fetch(request),
    });
    if (apiBindingRequest !== undefined) {
      apiBindingRequest.response = {
        contentType: response.headers.get(CONTENT_TYPE_HEADER),
        status: response.status,
      };
    }
    return response;
  });

const createServiceBindingHandler =
  (
    caller: App,
    apiBindingRequests: ApiBindingRequest[],
    failedServices: Set<string>,
    fragmentBindingRequests: FragmentBindingRequest[],
    service: ServiceReference,
  ): ServiceBindingHandler =>
  (request, miniflare): MiniflareResponse | Promise<MiniflareResponse> =>
    adapterRuntime.runPromise(
      handleServiceBinding(
        caller,
        apiBindingRequests,
        failedServices,
        fragmentBindingRequests,
        miniflare,
        request,
        service,
      ),
    );

const createServiceBindings = (
  caller: App,
  apiBindingRequests: ApiBindingRequest[],
  failedServices: Set<string>,
  fragmentBindingRequests: FragmentBindingRequest[],
): ServiceBindings =>
  Object.fromEntries(
    (caller.wrangler.services ?? []).map((service) => [
      service.binding,
      createServiceBindingHandler(
        caller,
        apiBindingRequests,
        failedServices,
        fragmentBindingRequests,
        service,
      ),
    ]),
  );

const waitForTerminationSignal: Effect.Effect<void> = Effect.callback((resume) => {
  const done = () => {
    resume(Effect.void);
  };
  process.once('SIGINT', done);
  process.once('SIGTERM', done);
  return Effect.sync(() => {
    process.off('SIGINT', done);
    process.off('SIGTERM', done);
  });
});

const writeReport = (
  reportPath: string,
  apiProofs: readonly ApiProof[],
  executions: readonly ExecutionEvidence[],
  proofs: readonly ShellProof[],
  remoteProofs: readonly RemoteProof[],
): ProofEffect<void> =>
  Effect.gen(function* writeReportEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const routes = proofs.flatMap((proof) => {
      const decoded = Schema.decodeUnknownOption(Schema.Struct({ route: Schema.String }))(proof);
      return Option.match(decoded, {
        onNone: () => [],
        onSome: ({ route }) => [route],
      });
    });
    const report = {
      apiProofs,
      executions,
      proofs,
      remoteProofs,
      routes: [...new Set(routes)],
      runtime: 'workerd',
      schemaVersion: 3,
    };
    const encoded = yield* encodeJson(report);
    yield* fileSystem.makeDirectory(path.dirname(reportPath), { recursive: true });
    yield* fileSystem.writeFileString(reportPath, `${encoded}\n`);
  });

const createOutboundService =
  (app: App, outboundRequests: OutboundRequest[]): ServiceBindingHandler =>
  (request) => {
    outboundRequests.push({ callerId: app.id, url: new URL(request.url).href });
    return new MiniflareResponse('External network disabled by SSR proof', { status: 502 });
  };

const proveBoundary = (
  apps: readonly App[],
  boundaries: readonly DistributedBoundary[],
  boundary: DistributedBoundary,
  renderedRemoteIds: Set<string>,
  route: string,
  routeFragmentBindingRequests: readonly FragmentBindingRequest[],
  shell: App,
): Effect.Effect<void, WorkerdProofError> =>
  Effect.gen(function* proveBoundaryEffect() {
    renderedRemoteIds.add(boundary.remote);
    yield* ensure(
      boundary.status === 'ready',
      `${shell.id} did not mark ${boundary.key} as ready for ${route}`,
    );
    yield* ensure(
      boundary.buildMarker !== undefined && boundary.buildMarker.length > 0,
      `${shell.id} ${boundary.key} is missing immutable build provenance`,
    );
    yield* ensure(
      /^[a-f\d]{64}$/u.test(boundary.digest ?? ''),
      `${shell.id} ${boundary.key} is missing a verified SHA-256 digest`,
    );
    const remote = yield* Effect.fromOption(
      Option.fromNullishOr(apps.find((app) => app.id === boundary.remote)),
      () => proofError(`${shell.id} rendered unknown remote ${boundary.remote}`),
    );
    const remoteWorkerName = yield* workerName(remote);
    const requests = routeFragmentBindingRequests.filter(
      (request) =>
        request.service === remoteWorkerName &&
        request.remote === boundary.remote &&
        request.expose === boundary.expose,
    );
    const renderedCount = boundaries.filter((candidate) => candidate.key === boundary.key).length;
    yield* ensure(
      requests.length === renderedCount &&
        requests.every((request) => request.pathname.includes('/_mf/fragment/')),
      `${shell.id} must compose each ${boundary.key} occurrence through its remote service binding`,
    );
  });

const proveShellRoute = (
  apps: readonly App[],
  miniflare: Miniflare,
  route: string,
  shell: App,
  shellWorkerName: string,
  state: ShellProofState,
): Effect.Effect<void, WorkerdProofError> =>
  Effect.gen(function* proveShellRouteEffect() {
    const apiStart = state.apiBindingRequests.length;
    const fragmentStart = state.fragmentBindingRequests.length;
    const outboundStart = state.outboundRequests.length;
    const response = yield* Effect.tryPromise({
      catch: (cause) => proofError(`${shell.id} route ${route} failed`, cause),
      try: async () =>
        await miniflare.dispatchFetch(`https://${shellWorkerName}.invalid${route}`, {
          headers: { accept: 'text/html' },
        }),
    });
    const html = yield* Effect.tryPromise({
      catch: (cause) => proofError(`${shell.id} route ${route} body failed`, cause),
      try: async () => await response.text(),
    });
    const routeOutboundRequests = state.outboundRequests.slice(outboundStart);
    const outboundEvidence = yield* encodeJson(routeOutboundRequests);
    yield* ensure(
      response.status === 200,
      `${shell.id} returned HTTP ${response.status} for ${route} in workerd; outbound requests: ${outboundEvidence}; response: ${html.slice(0, 500)} ... ${html.slice(-1000)}`,
    );
    yield* ensure(
      !html.includes(DEGRADED_BOUNDARY_MARKER),
      `${shell.id} rendered a degraded MicroVertical fallback for ${route} in workerd`,
    );
    const boundaries = yield* collectDistributedBoundaries(html);
    const routeApiBindingRequests = state.apiBindingRequests.slice(apiStart);
    const routeFragmentBindingRequests = state.fragmentBindingRequests.slice(fragmentStart);
    yield* Effect.forEach(
      boundaries,
      (boundary) =>
        proveBoundary(
          apps,
          boundaries,
          boundary,
          state.renderedRemoteIds,
          route,
          routeFragmentBindingRequests,
          shell,
        ),
      { concurrency: 1 },
    );
    const stylesheetHrefs = collectStylesheetHrefs(html);
    yield* ensure(
      new Set(stylesheetHrefs).size === stylesheetHrefs.length,
      `${shell.id} rendered duplicate distributed SSR stylesheets for ${route}`,
    );
    yield* ensure(
      !routeOutboundRequests.some(({ url }) => /(?:remoteEntry|\.m?js(?:\?|$))/u.test(url)),
      `${shell.id} attempted to fetch remote JavaScript during ${route} server composition`,
    );
    state.proofs.push({
      apiBindingRequests: routeApiBindingRequests,
      boundaries,
      degradedBoundaryCount: count(html, DEGRADED_BOUNDARY_MARKER),
      fragmentBindingRequests: routeFragmentBindingRequests,
      outboundRequests: routeOutboundRequests,
      route,
      shellId: shell.id,
      status: response.status,
      stylesheetHrefs,
      worker: shellWorkerName,
    });
  });

const proveRemote = (
  miniflare: Miniflare,
  remote: App,
  shell: App,
  state: ShellProofState,
): Effect.Effect<void, WorkerdProofError> =>
  Effect.gen(function* proveRemoteEffect() {
    if (!state.renderedRemoteIds.has(remote.id)) {
      const route = remote.proofRoutes[0] ?? '/en';
      const outboundStart = state.outboundRequests.length;
      const remoteWorkerName = yield* workerName(remote);
      const target = yield* Effect.tryPromise({
        catch: (cause) => proofError(`${remote.id} Worker could not be resolved`, cause),
        try: async () => await miniflare.getWorker(remoteWorkerName),
      });
      const response = yield* Effect.tryPromise({
        catch: (cause) => proofError(`${remote.id} route ${route} failed`, cause),
        try: async () =>
          await target.fetch(`https://${remoteWorkerName}.invalid${route}`, {
            headers: { accept: 'text/html' },
          }),
      });
      const html = yield* Effect.tryPromise({
        catch: (cause) => proofError(`${remote.id} route ${route} body failed`, cause),
        try: async () => await response.text(),
      });
      const routeOutboundRequests = state.outboundRequests.slice(outboundStart);
      const outboundEvidence = yield* encodeJson(routeOutboundRequests);
      yield* ensure(
        response.status === 200,
        `${remote.id} returned HTTP ${response.status} for ${route} in workerd; outbound requests: ${outboundEvidence}; response: ${html.slice(0, 500)} ... ${html.slice(-1000)}`,
      );
      yield* ensure(
        response.headers.get(CONTENT_TYPE_HEADER)?.includes('text/html') === true,
        `${remote.id} did not return HTML for ${route} in workerd`,
      );
      yield* ensure(
        !html.includes(DEGRADED_BOUNDARY_MARKER),
        `${remote.id} rendered a degraded distributed SSR boundary for ${route} in workerd`,
      );
      yield* ensure(
        !routeOutboundRequests.some(({ url }) => /(?:remoteEntry|\.m?js(?:\?|$))/u.test(url)),
        `${remote.id} attempted to fetch remote JavaScript during ${route} server rendering`,
      );
      state.remoteProofs.push({
        appId: remote.id,
        outboundRequests: routeOutboundRequests,
        route,
        status: response.status,
        worker: remoteWorkerName,
      });
      state.renderedRemoteIds.add(remote.id);
    }
    yield* ensure(
      state.renderedRemoteIds.has(remote.id),
      `${shell.id} proof routes are missing independently rendered ${remote.id} content`,
    );
  });

const runShellProof = (
  apps: readonly App[],
  shell: App,
  keepWorkerd: boolean,
  reportPath: string,
): ScopedProofEffect<{
  readonly apiProofs: readonly ApiProof[];
  readonly executions: readonly ExecutionEvidence[];
  readonly proofs: readonly ShellProof[];
  readonly remoteProofs: readonly RemoteProof[];
}> =>
  Effect.gen(function* runShellProofEffect() {
    const remotes = shell.verticalRefs
      .map((ref) => apps.find((app) => app.id === ref))
      .filter((remote): remote is App => remote !== undefined);
    yield* ensure(
      remotes.length === shell.verticalRefs.length,
      `${shell.id} references a missing MicroVertical`,
    );
    yield* ensure(remotes.length > 0, `${shell.id} has no MicroVerticals to prove`);
    const failedServices = new Set<string>();
    const state: ShellProofState = {
      apiBindingRequests: [],
      fragmentBindingRequests: [],
      outboundRequests: [],
      proofs: [],
      remoteProofs: [],
      renderedRemoteIds: new Set<string>(),
    };
    const workerConfigurations = yield* Effect.forEach(
      apps,
      (app) =>
        createWorkerConfiguration(
          app,
          process.cwd(),
          createOutboundService(app, state.outboundRequests),
          createServiceBindings(
            app,
            state.apiBindingRequests,
            failedServices,
            state.fragmentBindingRequests,
          ),
        ),
      { concurrency: 1 },
    );
    const executions = workerConfigurations.map(({ executionEvidence }) => executionEvidence);
    const executionByAppId = new Map(apps.map((app, index) => [app.id, executions[index]]));
    const workers = workerConfigurations.map(({ options }) => options);
    const miniflare = new Miniflare({ log: new Log(LogLevel.ERROR), workers });
    const shellWorkerName = yield* workerName(shell);
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        catch: () => proofError('Could not dispose Workerd runtime'),
        try: async () => await miniflare.dispose(),
      }).pipe(Effect.ignore),
    );
    yield* Effect.forEach(
      shell.proofRoutes,
      (route) => proveShellRoute(apps, miniflare, route, shell, shellWorkerName, state),
      { concurrency: 1 },
    );
    yield* Effect.forEach(remotes, (remote) => proveRemote(miniflare, remote, shell, state), {
      concurrency: 1,
    });
    const apiProofs = yield* runApiProofs(apps, miniflare, shell, executionByAppId);
    if (keepWorkerd) {
      yield* writeReport(reportPath, apiProofs, executions, state.proofs, state.remoteProofs);
      const targetServers = yield* startWorkerdTargetServers(
        apps,
        miniflare,
        failedServices,
        workers,
      );
      const encodedTargetUrls = yield* Schema.encodeEffect(TargetUrlsSchema)(
        targetServers.targetUrls,
      ).pipe(Effect.mapError((cause) => proofError('Could not encode Workerd target URLs', cause)));
      yield* Effect.log(`WORKERD_TARGET_URLS=${encodedTargetUrls}`);
      yield* Effect.log(`WORKERD_URL=${targetServers.targetUrls[shell.id] ?? ''}`);
      yield* waitForTerminationSignal.pipe(Effect.ensuring(targetServers.stop));
    }
    return {
      apiProofs,
      executions,
      proofs: state.proofs,
      remoteProofs: state.remoteProofs,
    };
  });

const main = Effect.gen(function* mainEffect() {
  const workspaceRoot = process.cwd();
  const reportPath = path.join(
    workspaceRoot,
    '.codex/reports/cloudflare-workerd-ssr/composition-proof.json',
  );
  const keepWorkerd = yield* Config.boolean('ULTRAMODERN_KEEP_WORKERD').pipe(
    Config.withDefault(false),
  );
  const apps = yield* loadApps(workspaceRoot);
  const shells = apps.filter((app) => app.kind === 'shell');
  yield* ensure(shells.length > 0, 'Workerd SSR proof requires at least one shell');
  if (keepWorkerd) {
    yield* ensure(shells.length === 1, 'Browser workerd proof requires exactly one shell');
  }
  const results = yield* Effect.forEach(
    shells,
    (shell) => runShellProof(apps, shell, keepWorkerd, reportPath),
    { concurrency: 1 },
  );
  const apiProofs = results.flatMap((result) => result.apiProofs);
  const executions = results.flatMap((result) => result.executions);
  const proofs = results.flatMap((result) => result.proofs);
  const remoteProofs = results.flatMap((result) => result.remoteProofs);
  yield* writeReport(reportPath, apiProofs, executions, proofs, remoteProofs);
  yield* Effect.log(
    `Workerd SSR composition proof passed for ${shells.length} shell(s): ${reportPath}`,
  );
}).pipe(Effect.scoped);

const loggedMain = main.pipe(Effect.tapCause((cause) => Effect.logError(cause)));
const exit = await Effect.runPromiseExit(Effect.provide(loggedMain, NodeFileSystem.layer));
if (Exit.isFailure(exit)) {
  process.exitCode = 1;
}
