import { Cause, Effect, Predicate, Schema } from 'effect';
import { afterEach, expect, it, rs } from '@app/effect-rstest';

import { execFileSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { transform } from 'esbuild';
import { format } from 'oxfmt';

afterEach(() => {
  rs.restoreAllMocks();
});

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const partyId = 'party-registry';
const mfManifestPath = '/mf-manifest.json';
const readinessPath = '/party-registry-api/party-registry/readiness';
const localePath = '/locales/en/party-registry.json';
const apiSmokePath = '/api-smoke';
const compiledUiAssetPath = 'static/js/index.js';
const ssrBundlePath = 'bundles/index.js';
const apiBundlePath = 'api/index.js';
const routesManifestFile = 'routes-manifest.json';
const mfManifestFile = 'mf-manifest.json';

const generatorRoot = await realpath(path.join(workspaceRoot, 'node_modules/@modern-js/create'));
const require = createRequire(import.meta.url);

const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const IdentitySchema = Schema.Struct({
  appId: AppIdSchema,
  build: Schema.String,
  buildMarker: Schema.String,
  deployProfile: Schema.String,
  kind: Schema.String,
  packageName: Schema.String,
  schemaVersion: Schema.Number,
  sourceRevision: Schema.String,
  unitId: Schema.String.pipe(Schema.brand('UnitId')),
  version: Schema.String,
});
const BuildArtifactSchema = Schema.Struct({
  deliveryUnit: IdentitySchema,
  kind: Schema.String,
  schemaVersion: Schema.Number,
  surfaces: Schema.Struct({
    api: Schema.Struct({ ...IdentitySchema.fields, surface: Schema.Literal('api') }),
    ui: Schema.Struct({ ...IdentitySchema.fields, surface: Schema.Literal('ui') }),
  }),
});
type ReleaseEnvelope = typeof ReleaseEnvelopeSchema.Type;

interface ReleaseFramework {
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- Structural mirror of the installed Modern.js release-envelope SDK.
  readonly emitFrameworkMicroVerticalReleaseEnvelope: (input: {
    readonly apiOnly: boolean;
    readonly distDirectory: string;
    readonly target: string;
  }) => Promise<ReleaseEnvelope>;
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- Structural mirror of the installed Modern.js release-envelope SDK.
  readonly emitNodeStagedReleaseEnvelope: (input: {
    readonly distDirectory: string;
    readonly outputDirectory: string;
  }) => Promise<ReleaseEnvelope>;
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- Structural mirror of the installed Modern.js release-envelope SDK.
  readonly verifyBuildOutputReleaseEnvelope: (root: string, target: string) => Promise<void>;
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- Structural mirror of the installed Modern.js release-envelope SDK.
  readonly verifyNodeReleaseEnvelopeStaging: (input: {
    readonly outputDirectory: string;
  }) => Promise<void>;
}

interface WorkspaceAppFixture {
  readonly exposes: Readonly<Record<string, string>>;
  readonly id: typeof AppIdSchema.Type;
}
type CreateVerticalDescriptor = (appId: string, port: number) => WorkspaceAppFixture;
type CreateLayout = (appId: typeof AppIdSchema.Type) => string;
type CreateAppModernConfig = (applicationRoot: string, app: WorkspaceAppFixture) => string;
type CreateBackendModuleFederationConfig = (app: WorkspaceAppFixture) => string;
type CreateUltramodernBuildModule = (applicationRoot: string, app: WorkspaceAppFixture) => string;
// oxlint-disable-next-line effect-native/no-promise-shaped-port -- The dynamically loaded Modern.js validator owns this Promise signature.
type ValidateCloudflareApp = (
  app: ApiOnlyAppFixture,
  applicationPublicUrl: string,
) => Promise<typeof CloudflareEvidenceSchema.Type>;
type ValidateModuleFederationTypes = (input: {
  readonly appDirs: readonly string[];
  readonly workspaceRoot: string;
}) => typeof ModuleFederationValidationResultSchema.Type;
type InspectModuleFederationConfigSource = (
  source: string,
  appDirectory: string,
  configFile: string,
) => typeof ModuleFederationInspectionSchema.Type;
interface RspackPluginFixture {
  readonly apply: (...argumentsList: never[]) => void;
}
interface RspackConfiguration {
  readonly entry: string;
  readonly externals: Readonly<Record<string, string>>;
  readonly mode: 'none';
  readonly module: {
    readonly rules: readonly {
      readonly test: RegExp;
      readonly use: {
        readonly loader: string;
        readonly options: {
          readonly jsc: { readonly parser: { readonly syntax: string } };
        };
      };
    }[];
  };
  readonly output: {
    readonly filename: string;
    readonly library: { readonly type: string };
    readonly path: string;
  };
  readonly plugins: readonly RspackPluginFixture[];
  readonly target: 'node';
}
type RspackFactory = (configuration: RspackConfiguration) => CompilerFixture;
type DefinePluginConstructor = new (
  definitions: Readonly<Record<string, string>>,
) => RspackPluginFixture;
type RspackModuleFixture = RspackFactory & {
  readonly DefinePlugin: DefinePluginConstructor;
  readonly rspack: RspackFactory;
};
interface CompilerStatsFixture {
  readonly hasErrors: () => boolean;
  readonly toString: (options: { readonly all: boolean; readonly errors: boolean }) => string;
}
interface CompilerFixture {
  readonly close: (onComplete: (error?: Error | null) => void) => void;
  readonly run: (
    onComplete: (error: Error | null, stats?: CompilerStatsFixture | null) => void,
  ) => void;
}

const callable = <Callable extends (...argumentsList: never[]) => void>() =>
  Schema.Opaque<Callable>()(Schema.Unknown.pipe(Schema.refine(Predicate.isFunction)));
const ReleaseEnvelopeSchema = Schema.Struct({
  surfaces: Schema.Struct({
    apiBackend: Schema.Array(Schema.String),
    ssr: Schema.Array(Schema.String),
    uiClient: Schema.Array(Schema.String),
  }),
});
const ReleaseFrameworkModuleSchema = Schema.Struct({
  emitFrameworkMicroVerticalReleaseEnvelope:
    callable<ReleaseFramework['emitFrameworkMicroVerticalReleaseEnvelope']>(),
  emitNodeStagedReleaseEnvelope: callable<ReleaseFramework['emitNodeStagedReleaseEnvelope']>(),
  verifyBuildOutputReleaseEnvelope:
    callable<ReleaseFramework['verifyBuildOutputReleaseEnvelope']>(),
  verifyNodeReleaseEnvelopeStaging:
    callable<ReleaseFramework['verifyNodeReleaseEnvelopeStaging']>(),
});
const WorkspaceAppFixtureSchema = Schema.Struct({
  exposes: Schema.Record(Schema.String, Schema.String),
  id: AppIdSchema,
});
const DescriptorModuleSchema = Schema.Struct({
  createVerticalDescriptor: callable<CreateVerticalDescriptor>(),
});
const ComponentModuleSchema = Schema.Struct({ createLayout: callable<CreateLayout>() });
const FederationConfigModuleSchema = Schema.Struct({
  createAppModernConfig: callable<CreateAppModernConfig>(),
  createBackendModuleFederationConfig: callable<CreateBackendModuleFederationConfig>(),
});
const BuildModuleGeneratorSchema = Schema.Struct({
  createUltramodernBuildModule: callable<CreateUltramodernBuildModule>(),
});
const CloudflareEvidenceSchema = Schema.Struct({
  assertions: Schema.Array(Schema.Struct({ status: Schema.String, type: Schema.String })),
});
const CloudflareProofModuleSchema = Schema.Struct({
  validateApp: callable<ValidateCloudflareApp>(),
});
const ModuleFederationValidationModuleSchema = Schema.Struct({
  validateModuleFederationTypes: callable<ValidateModuleFederationTypes>(),
});
const ModuleFederationValidationResultSchema = Schema.Struct({ hostOnlyAppCount: Schema.Number });
const ModuleFederationInspectionModuleSchema = Schema.Struct({
  inspectModuleFederationConfigSource: callable<InspectModuleFederationConfigSource>(),
});
const ModuleFederationInspectionSchema = Schema.Struct({
  dts: Schema.Record(Schema.String, Schema.Json),
});
const RspackModuleFixtureSchema = callable<RspackModuleFixture>();
const CompilerFixtureSchema = Schema.Struct({
  close: callable<CompilerFixture['close']>(),
  run: callable<CompilerFixture['run']>(),
});
const CompilerStatsFixtureSchema = Schema.Struct({
  hasErrors: callable<CompilerStatsFixture['hasErrors']>(),
  toString: callable<CompilerStatsFixture['toString']>(),
});
const CompiledReaderSchema = Schema.Struct({ allowedOrigins: Schema.Array(Schema.String) });
const PackageJsonSchema = Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String),
});
const TopologySchema = Schema.Struct({
  verticals: Schema.Array(
    Schema.Struct({
      backendFederation: Schema.Struct({
        exposes: Schema.Record(
          Schema.String,
          Schema.Struct({ contract: Schema.String, openapi: Schema.String }),
        ),
      }),
      cloudflare: Schema.Struct({
        routes: Schema.Struct({
          apiReadiness: Schema.String,
          locale: Schema.optionalKey(Schema.String),
          mfManifest: Schema.String,
          ssr: Schema.optionalKey(Schema.String),
        }),
      }),
      id: AppIdSchema,
      moduleFederation: Schema.Struct({ exposes: Schema.Array(Schema.String) }),
    }),
  ),
});
const OverlaySchema = Schema.Struct({
  apis: Schema.Record(Schema.String, Schema.String),
  ports: Schema.Record(Schema.String, Schema.Number),
});
const CloudflareReportSchema = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      appId: AppIdSchema,
      assertions: Schema.Array(Schema.Struct({ status: Schema.String })),
    }),
  ),
  status: Schema.String,
});

const loadReleaseFramework = (modulePath: string): Effect.Effect<ReleaseFramework, unknown> =>
  Effect.gen(function* scenario1() {
    const source: unknown = yield* Effect.promise(() => import(pathToFileURL(modulePath).href));
    const framework = Schema.decodeUnknownSync(ReleaseFrameworkModuleSchema)(source);
    const emitFrameworkMicroVerticalReleaseEnvelope =
      framework.emitFrameworkMicroVerticalReleaseEnvelope.bind(source);
    const emitNodeStagedReleaseEnvelope = framework.emitNodeStagedReleaseEnvelope.bind(source);
    const verifyBuildOutputReleaseEnvelope =
      framework.verifyBuildOutputReleaseEnvelope.bind(source);
    const verifyNodeReleaseEnvelopeStaging =
      framework.verifyNodeReleaseEnvelopeStaging.bind(source);
    return {
      emitFrameworkMicroVerticalReleaseEnvelope,
      emitNodeStagedReleaseEnvelope,
      verifyBuildOutputReleaseEnvelope,
      verifyNodeReleaseEnvelopeStaging,
    };
  });

const readJson = <JsonSchema extends Schema.ConstraintDecoder<unknown>>(
  schema: JsonSchema,
  filePath: string,
): Effect.Effect<JsonSchema['Type'], unknown> =>
  Effect.gen(function* scenario2() {
    return Schema.decodeUnknownSync(schema)(
      JSON.parse(yield* Effect.promise(() => readFile(filePath, 'utf-8'))),
    );
  });

const writeJson = <Value extends object>(
  root: string,
  logicalPath: string,
  value: Value,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario3() {
    yield* Effect.promise(() =>
      mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true }),
    );
    yield* Effect.promise(() => writeFile(path.join(root, logicalPath), JSON.stringify(value)));
  });

const writeText = (
  root: string,
  logicalPath: string,
  value: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario4() {
    yield* Effect.promise(() =>
      mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true }),
    );
    yield* Effect.promise(() => writeFile(path.join(root, logicalPath), value));
  });

const runNode = (
  argumentsList: readonly string[],
  options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } = {},
): string =>
  execFileSync(process.execPath, argumentsList, {
    cwd: options.cwd,
    encoding: 'utf-8',
    env: options.env,
  } satisfies ExecFileSyncOptionsWithStringEncoding);

const releaseFrameworkRoot = path.join(
  workspaceRoot,
  'verticals/party-registry/node_modules/@modern-js/app-tools/dist',
);

const releaseFixture = Effect.fn(function* scenario5() {
  const releaseFramework = yield* loadReleaseFramework(
    path.join(releaseFrameworkRoot, 'esm-node/ultramodern-release-envelope/framework-output.mjs'),
  );
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-empty-producer-'))),
    (dir) => Effect.promise(() => rm(dir, { force: true, recursive: true })),
  );
  const baseArtifact = yield* readJson(
    BuildArtifactSchema,
    path.join(workspaceRoot, 'verticals/party-registry/shared/ultramodern-build.json'),
  );
  const sourceRevision = 'a'.repeat(40);
  const artifact = {
    ...baseArtifact,
    deliveryUnit: { ...baseArtifact.deliveryUnit, sourceRevision },
    surfaces: {
      api: { ...baseArtifact.surfaces.api, sourceRevision },
      ui: { ...baseArtifact.surfaces.ui, sourceRevision },
    },
  };
  const manifest = {
    exposes: [],
    metaData: {
      publicPath: 'https://assets.example.test/app/',
      remoteEntry: { name: '', path: '', type: 'global' },
    },
    remotes: [],
  };
  const putJson = <Value extends object>(
    logicalPath: string,
    value: Value,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* scenario6() {
      return yield* writeJson(root, logicalPath, value);
    });
  const putText = (logicalPath: string, value: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* scenario7() {
      return yield* writeText(root, logicalPath, value);
    });
  yield* putJson('ultramodern-build.json', artifact);
  yield* putJson('backend-mf-manifest.json', {
    backendFederation: {
      deliveryUnit: artifact.deliveryUnit,
      versionBoundary: { deliveryUnit: artifact.deliveryUnit },
    },
  });
  yield* putJson(mfManifestFile, manifest);
  yield* putJson(routesManifestFile, {
    routeAssets: {
      index: { assets: [`https://assets.example.test/app/${compiledUiAssetPath}`] },
    },
  });
  yield* putJson('route.json', { routes: [{ bundle: ssrBundlePath }] });
  yield* putJson('package.json', { type: 'module' });
  yield* Effect.all(
    [compiledUiAssetPath, ssrBundlePath, apiBundlePath, 'index.js', 'backendRemoteEntry.cjs'].map(
      Effect.fn(function* scenario8(file) {
        return yield* putText(file, 'console.log("compiled fixture");');
      }),
    ),
    { concurrency: 'unbounded' },
  );
  const emit = Effect.fn(function* scenario9() {
    return Schema.decodeUnknownSync(ReleaseEnvelopeSchema)(
      yield* Effect.promise(() =>
        releaseFramework.emitFrameworkMicroVerticalReleaseEnvelope({
          apiOnly: false,
          distDirectory: root,
          target: 'node',
        }),
      ),
    );
  });
  return { artifact, emit, framework: releaseFramework, manifest, putJson, putText, root };
});

it.live(
  'empty MF producers retain complete build and Node staged release evidence in every framework format',
  Effect.fn(function* scenario10() {
    yield* Effect.all(
      ['cjs', 'esm', 'esm-node'].map(
        Effect.fn(function* scenario11(moduleFormat) {
          const fixture = yield* releaseFixture();
          const extension = moduleFormat === 'cjs' ? 'js' : 'mjs';
          const framework = yield* loadReleaseFramework(
            path.join(
              releaseFrameworkRoot,
              moduleFormat,
              `ultramodern-release-envelope/framework-output.${extension}`,
            ),
          );
          const envelope = Schema.decodeUnknownSync(ReleaseEnvelopeSchema)(
            yield* Effect.promise(() =>
              framework.emitFrameworkMicroVerticalReleaseEnvelope({
                apiOnly: false,
                distDirectory: fixture.root,
                target: 'node',
              }),
            ),
          );
          expect(envelope.surfaces.uiClient.includes(compiledUiAssetPath)).toBe(true);
          expect(envelope.surfaces.ssr).toEqual([ssrBundlePath]);
          expect(envelope.surfaces.apiBackend).toEqual([apiBundlePath]);
          yield* Effect.promise(() =>
            framework.verifyBuildOutputReleaseEnvelope(fixture.root, 'node'),
          );
          const staged = Schema.decodeUnknownSync(ReleaseEnvelopeSchema)(
            yield* Effect.promise(() =>
              framework.emitNodeStagedReleaseEnvelope({
                distDirectory: fixture.root,
                outputDirectory: fixture.root,
              }),
            ),
          );
          expect(staged.surfaces.uiClient.includes(compiledUiAssetPath)).toBe(true);
          yield* Effect.promise(() =>
            framework.verifyNodeReleaseEnvelopeStaging({ outputDirectory: fixture.root }),
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
    const fixture = yield* releaseFixture();
    yield* fixture.emit();
    yield* fixture.putText(compiledUiAssetPath, 'console.log("tampered");');
    const failureCause1 = yield* Effect.flip(
      Effect.sandbox(
        Effect.fn(function* scenario12() {
          return yield* Effect.promise(() =>
            fixture.framework.verifyBuildOutputReleaseEnvelope(fixture.root, 'node'),
          );
        })(),
      ),
    );
    expect(String(Cause.squash(failureCause1))).toMatch(/digest|hash|size/iu);
  }),
);

it.live(
  'empty MF producers bind root-relative route assets when publicPath is auto',
  Effect.fn(function* scenario13() {
    yield* Effect.all(
      ['cjs', 'esm', 'esm-node'].map(
        Effect.fn(function* scenario14(moduleFormat) {
          const fixture = yield* releaseFixture();
          fixture.manifest.metaData.publicPath = 'auto';
          yield* fixture.putJson(mfManifestFile, fixture.manifest);
          yield* fixture.putJson(routesManifestFile, {
            routeAssets: { index: { assets: [`/${compiledUiAssetPath}`] } },
          });
          const extension = moduleFormat === 'cjs' ? 'js' : 'mjs';
          const framework = yield* loadReleaseFramework(
            path.join(
              releaseFrameworkRoot,
              moduleFormat,
              `ultramodern-release-envelope/framework-output.${extension}`,
            ),
          );
          const envelope = Schema.decodeUnknownSync(ReleaseEnvelopeSchema)(
            yield* Effect.promise(() =>
              framework.emitFrameworkMicroVerticalReleaseEnvelope({
                apiOnly: false,
                distDirectory: fixture.root,
                target: 'node',
              }),
            ),
          );
          expect(envelope.surfaces.uiClient.includes(compiledUiAssetPath)).toBe(true);
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.live(
  'empty-producer fallback rejects undeclared, foreign, traversing, missing, and nonbrowser assets',
  Effect.fn(function* scenario15() {
    const references = [
      `https://foreign.example.test/app/${compiledUiAssetPath}`,
      `https://assets.example.test/app/../app/${compiledUiAssetPath}`,
      `https://assets.example.test/app/%2e%2e/app/${compiledUiAssetPath}`,
      String.raw`https://assets.example.test/app/static\js/index.js`,
      'https://assets.example.test/app/static%5cjs/index.js',
      'https://assets.example.test/app/static/js/missing.js',
      `https://assets.example.test/app/${apiBundlePath}`,
      `https://assets.example.test/app/${ssrBundlePath}`,
      `https://assets.example.test/app/${compiledUiAssetPath}?forged=true`,
    ];
    yield* Effect.all(
      references.map(
        Effect.fn(function* scenario16(reference) {
          const fixture = yield* releaseFixture();
          yield* fixture.putJson(routesManifestFile, {
            routeAssets: { index: { assets: [reference] } },
          });
          const failureCause2 = yield* Effect.flip(Effect.sandbox(fixture.emit()));
          expect(String(Cause.squash(failureCause2)), reference).toMatch(
            /UI\/client manifest references no compiled execution module/u,
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
    const baseline = yield* releaseFixture();
    const invalidManifests = [
      { ...baseline.manifest, exposes: [{ name: './Page' }] },
      { ...baseline.manifest, remotes: [{ name: 'shell' }] },
      { metaData: baseline.manifest.metaData, remotes: baseline.manifest.remotes },
      { exposes: baseline.manifest.exposes, metaData: baseline.manifest.metaData },
      {
        ...baseline.manifest,
        metaData: { ...baseline.manifest.metaData, remoteEntry: { name: '', path: '' } },
      },
    ];
    yield* Effect.all(
      invalidManifests.map(
        Effect.fn(function* scenario17(manifest) {
          const fixture = yield* releaseFixture();
          yield* fixture.putJson(mfManifestFile, manifest);
          const failureCause3 = yield* Effect.flip(Effect.sandbox(fixture.emit()));
          expect(String(Cause.squash(failureCause3))).toMatch(
            /UI\/client manifest references no compiled execution module/u,
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
    const fixture = yield* releaseFixture();
    yield* Effect.promise(() => rm(path.join(fixture.root, routesManifestFile)));
    const failureCause4 = yield* Effect.flip(Effect.sandbox(fixture.emit()));
    expect(String(Cause.squash(failureCause4))).toMatch(/ENOENT/u);
  }),
);

it.live(
  'empty MF producers cannot bypass backend, SSR, revision, or identity proof',
  Effect.fn(function* scenario18() {
    yield* Effect.all(
      [apiBundlePath, ssrBundlePath, 'backendRemoteEntry.cjs'].map(
        Effect.fn(function* scenario19(file) {
          const fixture = yield* releaseFixture();
          yield* Effect.promise(() => rm(path.join(fixture.root, file)));
          const failureCause5 = yield* Effect.flip(Effect.sandbox(fixture.emit()));
          expect(String(Cause.squash(failureCause5))).toMatch(
            /compiled Node Effect API|SSR artifacts|emitted together/u,
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
    const fixture = yield* releaseFixture();
    yield* fixture.putJson('backend-mf-manifest.json', {
      backendFederation: {
        deliveryUnit: { ...fixture.artifact.deliveryUnit, sourceRevision: 'b'.repeat(40) },
      },
    });
    const failureCause6 = yield* Effect.flip(Effect.sandbox(fixture.emit()));
    expect(String(Cause.squash(failureCause6))).toMatch(/must match/u);
    const workspaceArtifact = {
      ...fixture.artifact,
      deliveryUnit: { ...fixture.artifact.deliveryUnit, sourceRevision: 'workspace' },
      surfaces: {
        api: { ...fixture.artifact.surfaces.api, sourceRevision: 'workspace' },
        ui: { ...fixture.artifact.surfaces.ui, sourceRevision: 'workspace' },
      },
    };
    yield* fixture.putJson('ultramodern-build.json', workspaceArtifact);
    const failureCause7 = yield* Effect.flip(Effect.sandbox(fixture.emit()));
    expect(String(Cause.squash(failureCause7))).toMatch(/workspace/u);
  }),
);

const GlobalVarsSchema = Schema.Struct({ ULTRAMODERN_SHELL_ORIGIN: Schema.String });

const evaluatePartyBuildGlobalVars = Effect.fn(function* scenario20(shellOrigin: string) {
  const temporaryRoot = yield* Effect.promise(() =>
    mkdtemp(path.join(os.tmpdir(), 'ontos-party-config-')),
  );
  return yield* Effect.gen(function* useResource1() {
    const harnessPath = path.join(temporaryRoot, 'read-config.mjs');
    const configSource = yield* Effect.promise(() =>
      readFile(path.join(workspaceRoot, 'verticals/party-registry/modern.config.ts'), 'utf-8'),
    );
    const effectModuleUrl = pathToFileURL(
      require.resolve('effect', { paths: [workspaceRoot] }),
    ).href;
    const { code } = yield* Effect.promise(() =>
      transform(configSource, { format: 'cjs', loader: 'ts' }),
    );
    yield* Effect.promise(() =>
      writeFile(
        harnessPath,
        `import * as effect from ${JSON.stringify(effectModuleUrl)};
import { runInNewContext } from 'node:vm';
const framework = {
  appTools: () => ({}),
  bffPlugin: () => ({}),
  createRequire: () => () => ({}),
  defineConfig: configuration => configuration,
  getBuildConfigEnvironment: name => name === 'ULTRAMODERN_MF_DEV_ORIGIN' ? ${JSON.stringify(shellOrigin)} : undefined,
  i18nPlugin: () => ({}),
  moduleFederationPlugin: () => ({}),
  pluginTailwindcss: () => ({}),
  presetUltramodern: configuration => configuration,
  tanstackRouterPlugin: () => ({}),
  ultramodernLocalisedUrls: {},
};
const module = { exports: {} };
runInNewContext(${JSON.stringify(code)}, {
  exports: module.exports,
  module,
  require: specifier => specifier === 'effect' ? effect : framework,
});
process.stdout.write(JSON.stringify(module.exports.default.source.globalVars));
`,
      ),
    );
    const output = runNode([harnessPath]);
    return Schema.decodeUnknownSync(Schema.fromJsonString(GlobalVarsSchema))(output);
  }).pipe(
    Effect.ensuring(Effect.promise(() => rm(temporaryRoot, { force: true, recursive: true }))),
  );
});

it.live(
  'Party build configuration injects the exact nonlocal Shell origin into the API runtime',
  Effect.fn(function* scenario21() {
    const shellOrigin = 'https://operations.example.test';
    const globalVars = yield* evaluatePartyBuildGlobalVars(shellOrigin);
    expect(globalVars.ULTRAMODERN_SHELL_ORIGIN).toBe(shellOrigin);
  }),
);

it.live(
  'compiled Party CORS reader uses the nonlocal DefinePlugin origin without a runtime global',
  Effect.fn(function* scenario22() {
    const shellOrigin = 'https://operations.example.test';
    const globalVars = yield* evaluatePartyBuildGlobalVars(shellOrigin);
    const partyRoot = path.join(workspaceRoot, 'verticals/party-registry');
    const source = yield* Effect.promise(() =>
      readFile(path.join(partyRoot, 'api/index.ts'), 'utf-8'),
    );
    const reader =
      /(?<reader>declare const ULTRAMODERN_SHELL_ORIGIN[\s\S]+?const shellOrigin = readShellOrigin\(\);)/u.exec(
        source,
      )?.groups?.reader;
    expect(reader, 'compile the actual API origin-reader boundary').not.toBe(undefined);
    const appToolsPath = require.resolve('@modern-js/app-tools/config', { paths: [partyRoot] });
    const rspackModule: unknown = require(
      require.resolve('@rspack/core', { paths: [appToolsPath] }),
    );
    const rspackFixture = Schema.decodeUnknownSync(RspackModuleFixtureSchema)(rspackModule);
    const temporaryRoot = yield* Effect.promise(() =>
      mkdtemp(path.join(partyRoot, 'node_modules/.ontos-compiled-cors-')),
    );
    yield* Effect.gen(function* useResource3() {
      const entry = path.join(temporaryRoot, 'reader.ts');
      yield* Effect.promise(() =>
        writeFile(
          entry,
          `import { Schema } from 'effect';\nimport { resolvePartyRegistryShellOrigin, partyRegistryCorsAllowedOrigins } from ${JSON.stringify(path.join(partyRoot, 'api/read-server-support.ts'))};\n${reader}\nexport const allowedOrigins = partyRegistryCorsAllowedOrigins(shellOrigin);\n`,
        ),
      );
      const definePlugin = new rspackFixture.DefinePlugin(
        Object.fromEntries(
          Object.entries(globalVars).map(([key, value]) => [key, JSON.stringify(value)]),
        ),
      );
      const createCompiler = rspackFixture.rspack.bind(rspackModule);
      const compilerSource = createCompiler({
        entry,
        externals: { effect: 'commonjs effect' },
        mode: 'none',
        module: {
          rules: [
            {
              test: /\.ts$/u,
              use: {
                loader: 'builtin:swc-loader',
                options: { jsc: { parser: { syntax: 'typescript' } } },
              },
            },
          ],
        },
        output: { filename: 'reader.cjs', library: { type: 'commonjs2' }, path: temporaryRoot },
        plugins: [definePlugin],
        target: 'node',
      });
      const compiler = Schema.decodeUnknownSync(CompilerFixtureSchema)({
        close: compilerSource.close,
        run: compilerSource.run,
      });
      const runCompiler = promisify(compiler.run.bind(compilerSource));
      const closeCompiler = promisify(compiler.close.bind(compilerSource));
      yield* Effect.gen(function* useResource2() {
        const statsSource = yield* Effect.promise(() => runCompiler());
        expect(statsSource).toBeDefined();
        if (!statsSource) {
          throw new Error('Compiler stats are missing');
        }
        const stats = Schema.decodeUnknownSync(CompilerStatsFixtureSchema)({
          hasErrors: statsSource.hasErrors,
          toString: statsSource.toString,
        });
        const hasErrors = stats.hasErrors.bind(statsSource)();
        const errorText = stats.toString.bind(statsSource)({ all: false, errors: true });
        expect(hasErrors, errorText).toBe(false);
      }).pipe(Effect.ensuring(Effect.promise(() => closeCompiler())));
      const compiledReaderModule: unknown = require(path.join(temporaryRoot, 'reader.cjs'));
      const compiledReader = Schema.decodeUnknownSync(CompiledReaderSchema)(compiledReaderModule);
      expect([...compiledReader.allowedOrigins]).toEqual([shellOrigin]);
    }).pipe(
      Effect.ensuring(Effect.promise(() => rm(temporaryRoot, { force: true, recursive: true }))),
    );
  }),
);

const normalizedGeneratedSource = Effect.fn(function* scenario23(fileName: string, source: string) {
  const result = yield* Effect.promise(() =>
    format(fileName, source, { singleQuote: true, sortImports: true }),
  );
  expect(result.errors).toEqual([]);
  return result.code.replaceAll(/^\s*\n/gmu, '');
});

it.live(
  'all published scaffold formats retain lint-safe Party infrastructure parity',
  Effect.fn(function* scenario24() {
    yield* Effect.all(
      ['esm', 'esm-node', 'cjs'].map(
        Effect.fn(function* scenario25(moduleFormat) {
          const extension = moduleFormat === 'cjs' ? 'cjs' : 'js';
          const generatorModulePath = (name: string): string =>
            path.join(
              generatorRoot,
              `dist/${moduleFormat}/ultramodern-workspace/${name}.${extension}`,
            );
          const descriptorPath = generatorModulePath('descriptors');
          const descriptorSource: unknown =
            moduleFormat === 'cjs'
              ? require(descriptorPath)
              : yield* Effect.promise(() => import(pathToFileURL(descriptorPath).href));
          const descriptorModule =
            Schema.decodeUnknownSync(DescriptorModuleSchema)(descriptorSource);
          const componentPath = generatorModulePath('demo-components');
          const componentSource: unknown =
            moduleFormat === 'cjs'
              ? require(componentPath)
              : yield* Effect.promise(() => import(pathToFileURL(componentPath).href));
          const componentModule = Schema.decodeUnknownSync(ComponentModuleSchema)(componentSource);
          const federationPath = generatorModulePath('module-federation/config');
          const federationSource: unknown =
            moduleFormat === 'cjs'
              ? require(federationPath)
              : yield* Effect.promise(() => import(pathToFileURL(federationPath).href));
          const federationModule = Schema.decodeUnknownSync(FederationConfigModuleSchema)(
            federationSource,
          );
          const buildModulePath = generatorModulePath('module-federation/reexport-module');
          const buildModuleSource: unknown =
            moduleFormat === 'cjs'
              ? require(buildModulePath)
              : yield* Effect.promise(() => import(pathToFileURL(buildModulePath).href));
          const buildModule = Schema.decodeUnknownSync(BuildModuleGeneratorSchema)(
            buildModuleSource,
          );
          const createVerticalDescriptor =
            descriptorModule.createVerticalDescriptor.bind(descriptorSource);
          const createLayout = componentModule.createLayout.bind(componentSource);
          const createAppModernConfig =
            federationModule.createAppModernConfig.bind(federationSource);
          const createBackendModuleFederationConfig =
            federationModule.createBackendModuleFederationConfig.bind(federationSource);
          const createUltramodernBuildModule =
            buildModule.createUltramodernBuildModule.bind(buildModuleSource);
          const descriptor: unknown = createVerticalDescriptor(partyId, 4102);
          Schema.asserts(WorkspaceAppFixtureSchema, descriptor);
          const app = { ...descriptor, exposes: {} };
          const generated = {
            'backend-federation.config.ts': Schema.decodeUnknownSync(Schema.String)(
              createBackendModuleFederationConfig(app),
            ),
            'modern.config.ts': Schema.decodeUnknownSync(Schema.String)(
              createAppModernConfig('app', app),
            ),
            'shared/ultramodern-build.ts': Schema.decodeUnknownSync(Schema.String)(
              createUltramodernBuildModule('app', app),
            ),
            'src/routes/layout.tsx': Schema.decodeUnknownSync(Schema.String)(createLayout(app.id)),
          };
          yield* Effect.all(
            Object.entries(generated).map(
              Effect.fn(function* scenario26([fileName, source]) {
                const actual = yield* Effect.promise(() =>
                  readFile(path.join(workspaceRoot, 'verticals/party-registry', fileName), 'utf-8'),
                );
                expect(
                  yield* normalizedGeneratedSource(fileName, source),
                  `${moduleFormat}: ${fileName} must match the controlled scaffold`,
                ).toBe(yield* normalizedGeneratedSource(fileName, actual));
              }),
            ),
            { concurrency: 'unbounded' },
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.live(
  'full-stack Party Registry keeps backend and Contacts component tests executable',
  Effect.fn(function* scenario27() {
    const packageJson = yield* readJson(
      PackageJsonSchema,
      path.join(workspaceRoot, 'verticals/party-registry/package.json'),
    );
    expect(packageJson.scripts['test:component']).toBe('rstest --project component');
    expect(packageJson.scripts['test:unit']).toBe('rstest --project unit');
    expect(packageJson.scripts['test:integration']).toBe('rstest --project integration');
    expect(
      yield* Effect.promise(() =>
        readFile(path.join(workspaceRoot, 'verticals/party-registry/rstest.config.ts'), 'utf-8'),
      ),
    ).toMatch(/tests\/components/u);
  }),
);
const cloudflareProofModule: unknown = await import(
  pathToFileURL(
    path.join(generatorRoot, 'templates/workspace-scripts/ultramodern-cloudflare-proof.mjs'),
  ).href
);
const cloudflareProof = Schema.decodeUnknownSync(CloudflareProofModuleSchema)(
  cloudflareProofModule,
);
const validateCloudflareApp = cloudflareProof.validateApp.bind(cloudflareProofModule);
const validateApp = (
  app: ApiOnlyAppFixture,
  applicationPublicUrl: string,
): Effect.Effect<typeof CloudflareEvidenceSchema.Type, unknown> =>
  Effect.gen(function* scenario28() {
    const output: unknown = yield* Effect.promise(() =>
      validateCloudflareApp(app, applicationPublicUrl),
    );
    return Schema.decodeUnknownSync(CloudflareEvidenceSchema)(output);
  });
const federationValidationModule: unknown = await import(
  pathToFileURL(
    path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/mf-validation/validate.js'),
  ).href
);
const federationValidation = Schema.decodeUnknownSync(ModuleFederationValidationModuleSchema)(
  federationValidationModule,
);
const validateInstalledModuleFederationTypes =
  federationValidation.validateModuleFederationTypes.bind(federationValidationModule);
const validateModuleFederationTypes = (input: {
  readonly appDirs: readonly string[];
  readonly workspaceRoot: string;
}): typeof ModuleFederationValidationResultSchema.Type => {
  const output: unknown = validateInstalledModuleFederationTypes(input);
  return Schema.decodeUnknownSync(ModuleFederationValidationResultSchema)(output);
};

const publicUrl = 'https://party.example.test';
const buildMarker = 'party-build';
interface ApiOnlyAppFixture {
  readonly deliveryUnit: { readonly buildMarker: string; readonly unitId: string };
  readonly deploy: {
    readonly cloudflare: {
      readonly jsonSmokeChecks: readonly object[];
      readonly routes: Record<string, string>;
      readonly serviceBindings: readonly object[];
    };
  };
  readonly i18n: { readonly namespace: string };
  readonly id: string;
  readonly marker: { readonly build: string };
}

const apiOnlyApp = (): ApiOnlyAppFixture => ({
  deliveryUnit: { buildMarker, unitId: 'app/party-registry' },
  deploy: {
    cloudflare: {
      jsonSmokeChecks: [{ expect: { status: 'ready' }, id: 'api', route: apiSmokePath }],
      routes: {
        apiReadiness: readinessPath,
        mfManifest: mfManifestPath,
      },
      serviceBindings: [
        {
          appId: partyId,
          binding: 'PARTY_WORKER',
          expectedMarker: buildMarker,
          route: '/binding',
        },
      ],
    },
  },
  i18n: { namespace: partyId },
  id: partyId,
  marker: { build: buildMarker },
});

const mockPublicResponses = (failedPath?: string) => {
  const requested: string[] = [];
  rs.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    let address: string;
    if (Schema.is(Schema.String)(input)) {
      address = input;
    } else if ('url' in input) {
      address = input.url;
    } else {
      address = input.href;
    }
    const route = new URL(address).pathname;
    requested.push(route);
    if (route === failedPath) {
      return Promise.resolve(new Response('unavailable', { status: 503 }));
    }
    const body =
      route === mfManifestPath
        ? { metaData: { publicPath: `${publicUrl}/` } }
        : { marker: { build: buildMarker }, status: 'ready' };
    return Promise.resolve(
      Response.json(body, { headers: { 'access-control-allow-origin': '*' } }),
    );
  });
  return requested;
};

it.live(
  'API-only proof keeps manifest, readiness, service-binding and JSON proofs without invented pages/locales',
  Effect.fn(function* scenario29() {
    const requested = mockPublicResponses();
    const evidence = yield* validateApp(apiOnlyApp(), publicUrl);
    expect(requested).toEqual([mfManifestPath, readinessPath, '/binding', apiSmokePath]);
    for (const proof of [
      'mf-manifest',
      'api-marker',
      'delivery-unit-api-marker',
      'service-binding-api-marker',
      'json-smoke-value',
    ]) {
      expect(
        evidence.assertions.some((entry) => entry.type === proof && entry.status === 'pass'),
      ).toBe(true);
    }
    expect(
      evidence.assertions.some((entry) => entry.type === 'ssr' || entry.type === 'i18n-marker'),
    ).toBe(false);
  }),
);

for (const [route, error] of [
  [mfManifestPath, /MF manifest returned HTTP 503/u],
  [readinessPath, /Effect readiness returned HTTP 503/u],
  ['/binding', /service binding PARTY_WORKER returned HTTP 503/u],
  [apiSmokePath, /JSON smoke api returned HTTP 503/u],
] as const) {
  it.live(
    `API-only proof still fails closed for ${route}`,
    Effect.fn(function* scenario30() {
      mockPublicResponses(route);
      const failureCause8 = yield* Effect.flip(
        Effect.sandbox(validateApp(apiOnlyApp(), publicUrl)),
      );
      expect(String(Cause.squash(failureCause8))).toMatch(error);
    }),
  );
}

it.live(
  'full-stack declared SSR remains mandatory',
  Effect.fn(function* scenario31() {
    const requested = mockPublicResponses('/en');
    const app = apiOnlyApp();
    Object.assign(app.deploy.cloudflare.routes, {
      locale: localePath,
      ssr: '/en',
    });
    const failureCause9 = yield* Effect.flip(Effect.sandbox(validateApp(app, publicUrl)));
    expect(String(Cause.squash(failureCause9))).toMatch(/SSR route returned HTTP 503/u);
    expect(requested).toEqual(['/en']);
  }),
);

it.live(
  'declared namespace locale remains mandatory independently of SSR',
  Effect.fn(function* scenario32() {
    const requested = mockPublicResponses(localePath);
    const app = apiOnlyApp();
    Object.assign(app.deploy.cloudflare.routes, { locale: localePath });
    const failureCause10 = yield* Effect.flip(Effect.sandbox(validateApp(app, publicUrl)));
    expect(String(Cause.squash(failureCause10))).toMatch(/locale JSON returned HTTP 503/u);
    expect(requested).toEqual([mfManifestPath, localePath]);
  }),
);

for (const field of ['ssr', 'locale']) {
  it.live(
    `an invalid declared ${field} route cannot disable its proof`,
    Effect.fn(function* scenario33() {
      mockPublicResponses();
      const app = apiOnlyApp();
      Object.assign(app.deploy.cloudflare.routes, { [field]: '' });
      const failureCause11 = yield* Effect.flip(Effect.sandbox(validateApp(app, publicUrl)));
      expect(String(Cause.squash(failureCause11))).toMatch(
        /declared .* route must be a root-relative path/u,
      );
    }),
  );
}

for (const variant of ['cjs', 'esm', 'esm-node']) {
  it.live(
    `${variant} inspector permits dts:false only with zero frontend exposes`,
    Effect.fn(function* scenario34() {
      const extension = variant === 'cjs' ? 'cjs' : 'js';
      const inspectionModule: unknown = yield* Effect.promise(
        () =>
          import(
            pathToFileURL(
              path.join(
                generatorRoot,
                `dist/${variant}/ultramodern-workspace/mf-validation/inspect.${extension}`,
              ),
            ).href
          ),
      );
      const inspection = Schema.decodeUnknownSync(ModuleFederationInspectionModuleSchema)(
        inspectionModule,
      );
      const inspectInstalledModuleFederationConfig =
        inspection.inspectModuleFederationConfigSource.bind(inspectionModule);
      const inspect = (source: string): typeof ModuleFederationInspectionSchema.Type => {
        const output: unknown = inspectInstalledModuleFederationConfig(
          source,
          'verticals/api',
          'module-federation.config.ts',
        );
        return Schema.decodeUnknownSync(ModuleFederationInspectionSchema)(output);
      };
      expect(
        inspect('// @ultramodern-mf no-exposes\nexport default { dts: false, exposes: {} };').dts,
      ).toEqual({});
      expect(() =>
        inspect('export default { dts: false, exposes: { "./Page": "./page.tsx" } };'),
      ).toThrow(/DTS cannot be disabled for exposed app/u);
    }),
  );
}

it.live(
  'MF proof accepts explicit API-only intent but keeps exposed-app archives mandatory',
  Effect.fn(function* scenario35() {
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-api-only-mf-'))),
      (dir) => Effect.promise(() => rm(dir, { force: true, recursive: true })),
    );
    const appDir = 'verticals/api';
    yield* Effect.promise(() => mkdir(path.join(fixture, appDir), { recursive: true }));
    const configPath = path.join(fixture, appDir, 'module-federation.config.ts');
    const validate = () =>
      validateModuleFederationTypes({ appDirs: [appDir], workspaceRoot: fixture });
    yield* Effect.promise(() =>
      writeFile(
        configPath,
        '// @ultramodern-mf no-exposes\nexport default { dts: false, exposes: {} };',
      ),
    );
    expect(validate().hostOnlyAppCount).toBe(1);
    yield* Effect.promise(() =>
      writeFile(configPath, 'export default { dts: false, exposes: {} };'),
    );
    expect(validate).toThrow(/without an explicit host-only\/no-exposes declaration/u);
    yield* Effect.promise(() =>
      writeFile(
        configPath,
        'export default { dts: { tsConfigPath: "./tsconfig.mf-types.json", generateTypes: { compilerInstance: "effect-tsgo" } }, exposes: { "./Page": "./page.tsx" } };',
      ),
    );
    expect(validate).toThrow(/Missing Module Federation DTS archive/u);
  }),
);

it.live(
  'Party deployment declares no fake SSR/locale URL while retaining backend contracts',
  Effect.fn(function* scenario36() {
    const topology = yield* readJson(
      TopologySchema,
      path.join(workspaceRoot, 'topology/reference-topology.json'),
    );
    const party = topology.verticals.find((entry) => entry.id === partyId);
    expect(party).toBeDefined();
    if (!party) {
      throw new Error('Party deployment is missing');
    }
    expect(party.cloudflare.routes.ssr).toBe(undefined);
    expect(party.cloudflare.routes.locale).toBe(undefined);
    expect(party.cloudflare.routes.mfManifest).toBe(mfManifestPath);
    expect(party.cloudflare.routes.apiReadiness).toBe(readinessPath);
    expect(party.backendFederation.exposes['./effect-api'].contract).toBe(
      'verticals/party-registry/shared/api.ts',
    );
    expect(party.backendFederation.exposes['./effect-api'].openapi).toBe(
      '/party-registry-api/openapi.json',
    );
  }),
);

it.live(
  'Party Registry is the sole deployment owner for Contacts capabilities',
  Effect.fn(function* scenario37() {
    const topology = yield* readJson(
      TopologySchema,
      path.join(workspaceRoot, 'topology/reference-topology.json'),
    );
    const overlay = yield* readJson(
      OverlaySchema,
      path.join(workspaceRoot, 'topology/local-overlays/development.json'),
    );
    const zerops = yield* Effect.promise(() =>
      readFile(path.join(workspaceRoot, 'zerops.yaml'), 'utf-8'),
    );
    const partySetup = zerops.split(`  - setup: '${partyId}'`)[1]?.split('  - setup:')[0];
    expect(partySetup).toBeDefined();
    if (!partySetup) {
      throw new Error('Party setup is missing');
    }
    expect(zerops.includes("  - setup: 'contacts'")).toBe(false);
    expect(topology.verticals.some((entry) => entry.id === 'contacts')).toBe(false);
    const party = topology.verticals.find((entry) => entry.id === partyId);
    expect(party).toBeDefined();
    if (!party) {
      throw new Error('Party deployment is missing');
    }
    expect(overlay.ports[party.id]).toBe(4102);
    expect(overlay.apis[party.id]).toBe('http://localhost:4102/party-registry-api');
    expect(partySetup.includes('ULTRAMODERN_ZEROPS_SERVICE: party-registry')).toBe(true);
    expect(party.moduleFederation.exposes.includes('./PageContacts')).toBe(true);
  }),
);

it.live(
  'installed Cloudflare CLI preserves API-only routes when synthesizing the real Party contract',
  Effect.fn(function* scenario38() {
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-api-only-proof-'))),
      (dir) => Effect.promise(() => rm(dir, { force: true, recursive: true })),
    );
    yield* Effect.promise(() => mkdir(path.join(fixture, '.modernjs')));
    const modernConfig = yield* Effect.promise(() =>
      readFile(path.join(workspaceRoot, '.modernjs/ultramodern.json')),
    );
    yield* Effect.promise(() =>
      writeFile(path.join(fixture, '.modernjs/ultramodern.json'), modernConfig),
    );
    const build = yield* readJson(
      BuildArtifactSchema,
      path.join(workspaceRoot, 'verticals/party-registry/shared/ultramodern-build.json'),
    );
    const requestedPath = path.join(fixture, 'requested-routes.txt');
    const fetchMockPath = path.join(fixture, 'cloudflare-fetch-mock.mjs');
    yield* Effect.promise(() =>
      writeFile(
        fetchMockPath,
        `import { appendFileSync } from 'node:fs';
const requestedPath = ${JSON.stringify(requestedPath)};
const publicUrl = ${JSON.stringify(publicUrl)};
const manifestPath = ${JSON.stringify(mfManifestPath)};
const readinessPath = ${JSON.stringify(readinessPath)};
const buildMarker = ${JSON.stringify(build.deliveryUnit.buildMarker)};
const headers = {
  'access-control-allow-origin': '*',
  'content-type': 'application/json',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};
globalThis.fetch = async input => {
  const route = new URL(String(input)).pathname;
  appendFileSync(requestedPath, route + '\\n');
  if (route === manifestPath) {
    return Response.json({ metaData: { publicPath: publicUrl + '/' } }, { headers });
  }
  if (route === readinessPath) {
    return Response.json({
      checks: { api: 'ready', moduleFederation: 'ready', ssr: 'ready' },
      marker: { build: buildMarker },
      status: 'ready',
    }, { headers });
  }
  return Response.json({ error: 'No owner route or locale exists' }, { headers, status: 404 });
};
`,
      ),
    );
    const reportPath = path.join(fixture, 'proof.json');
    runNode(
      [
        '--import',
        pathToFileURL(fetchMockPath).href,
        path.join(generatorRoot, 'templates/workspace-scripts/proof-cloudflare-version.mjs'),
        '--app',
        partyId,
        '--require-public-urls',
        '--out',
        reportPath,
      ],
      {
        env: {
          ULTRAMODERN_PUBLIC_URL_PARTY_REGISTRY: publicUrl,
          ULTRAMODERN_WORKSPACE_ROOT: fixture,
        },
      },
    );
    const requestedSource = yield* Effect.promise(() => readFile(requestedPath, 'utf-8'));
    const requested = requestedSource.trimEnd().split('\n');
    expect(requested).toEqual([mfManifestPath, readinessPath, readinessPath]);
    const report = yield* readJson(CloudflareReportSchema, reportPath);
    expect(report.status).toBe('pass');
    expect(report.results[0].appId).toBe('party-registry');
    expect(report.results[0].assertions.every((entry) => entry.status === 'pass')).toBe(true);
  }),
);
