import type { defineEffectBff } from '@modern-js/plugin-bff/effect-edge';
import { Cause, Effect, Predicate, Schema } from 'effect';
import { afterEach, expect, it, rs } from '@app/effect-rstest';
import { execFileSync, spawnSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { transform } from 'esbuild';
import { format } from 'oxfmt';
import { MicroVerticalReadinessSchema } from '../../packages/shared-contracts/src/microvertical-api-baseline.ts';
import {
  configuredMicroVerticalApiStem,
  microVerticalApiBaselineViolation as microVerticalApiBaselineViolationForFile,
} from '../microvertical-api-baseline-boundary.mts';
import type { MicroVerticalApiBaselineExpectation } from '../microvertical-api-baseline-boundary.mts';
import { strictEffectRuntimeTopologyViolation } from '../ultramodern-api-boundary-rules.mts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

const partyId = 'party-registry';

const generatedFixtureId = 'inventory-stock';

const generatedApiPrefix = '/inventory-stock-api';

const generatedServiceModuleName = 'api/service';

const generatedApiServiceModule = 'dist/esm-node/ultramodern-workspace/api/service.js';

const generatedSharedApiImport = '../shared/api.ts';

const generatedSharedRpcImport = '../shared/rpc.ts';

const apiIndexFile = 'api/index.ts';

const sharedApiFile = 'shared/api.ts';

const buildMarkerFile = 'shared/ultramodern-build.ts';

const tsconfigFile = 'tsconfig.json';

const fixtureApiModuleSource = 'export const fixtureApi = {};';

const governedApiModuleSource = `${fixtureApiModuleSource}
export const governedHttpApi = fixtureApi;
export const unusedApi = {};
`;

const governedLayerAliasFixture = `
import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import { Layer as GovernedReadLayer } from 'effect';
import { fixtureApi, governedHttpApi } from '${generatedSharedApiImport}';
const group = HttpApiBuilder.group(governedHttpApi, 'fixture', (handlers) => handlers.handle('reachable', () => undefined));
const handlers = Layer.mergeAll(group.pipe(GovernedReadLayer.provide(Layer.empty)));
export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
`;

const governedLayerAliasMutations = [
  ["from 'effect'", "from './counterfeit-layer.ts'"],
  ['fixtureApi, governedHttpApi', 'fixtureApi, unusedApi as governedHttpApi'],
  ['const handlers =', 'const GovernedReadLayer = {}; const handlers ='],
] as const;

const mfManifestPath = '/mf-manifest.json';

const readinessPath = '/party-registry-api/party-registry/readiness';

const localePath = '/locales/en/party-registry.json';

const apiSmokePath = '/api-smoke';

const compiledUiAssetPath = 'static/js/index.js';

const ssrBundlePath = 'bundles/index.js';

const apiBundlePath = 'api/index.js';

const routesManifestFile = 'routes-manifest.json';

const mfManifestFile = 'mf-manifest.json';

const generatedProofScope = 'generated-proof';

const generatedClientContractImport = '../../shared/api.ts';

const generatedSharedApiModule = 'api/shared';

const generatedSharedContractsPackage = '@generated-proof/shared-contracts';

const effectClientPackage = '@modern-js/plugin-bff/effect-client';

const generatedBaselineTemplateEntry = 'src/index.ts';

const apiBoundaryCheckerPath = 'scripts/check-ultramodern-api-boundaries.mts';

const topologyReferencePath = 'topology/reference-topology.json';

const checkoutId = 'checkout';

const checkoutApiPrefix = '/checkout-api';

const inventoryStockId = 'inventory-stock';

const warehouseItemsApiStem = 'warehouse-items';

const warehouseApiPrefix = '/warehouse-api';

const partyReadinessMetadataLine =
  "  readinessPath: '/party-registry-api/party-registry/readiness',";

const microVerticalApiBaselineViolation = Effect.fn(function* inspectMicroVerticalBaseline(
  stem: string,
  source: string,
  expectation?: Partial<MicroVerticalApiBaselineExpectation>,
) {
  const fixture = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-microvertical-api-test-'))),
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  );
  const contractPath = path.join(fixture, 'api.ts');
  yield* Effect.promise(() => writeFile(contractPath, source));
  return microVerticalApiBaselineViolationForFile(stem, contractPath, {
    additionalPaths: {},
    apiPrefix: `/${stem}-api`,
    basePath: `/${stem}-api/${stem}`,
    effectClientPackage,
    ownerId: stem,
    readinessPath: `/${stem}-api/${stem}/readiness`,
    sharedContractsPackage: '@app/shared-contracts',
    ...expectation,
  });
});

const unexpectedTopologyImport = (specifier: string): never => {
  throw new Error(`Unexpected strict-topology import: ${specifier}`);
};

const generatorRoot = await realpath(path.join(workspaceRoot, 'node_modules/@modern-js/create'));

const require = createRequire(import.meta.url);
const publishedGeneratorModulePath =
  (moduleFormat: string) =>
  (name: string): string =>
    path.join(
      generatorRoot,
      `dist/${moduleFormat}/ultramodern-workspace/${name}.${moduleFormat === 'cjs' ? 'cjs' : 'js'}`,
    );
const violationText = (violation: string | undefined): string => violation ?? '';

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
  readonly api?: {
    readonly prefix: string;
    readonly protocol?: string;
    readonly stem: string;
  };
  readonly exposes: Readonly<Record<string, string>>;
  readonly id: typeof AppIdSchema.Type;
}

type CreateSharedPackage = (
  scope: string,
  id: string,
  description: string,
  packageSource: {
    readonly modernPackageVersion: string;
    readonly strategy: 'install';
  },
) => {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, string>>;
};

interface StrictEffectApiBoundaryNode {
  readonly type?: string;
}

interface StrictEffectApiBoundaryContext {
  readonly filename: string;
  readonly getSourceCode: () => {
    readonly getText: () => string;
    readonly text: string;
  };
  readonly report: (finding: { readonly message: string }) => void;
}

type StrictEffectApiBoundaryRuleFactory = () => {
  readonly create: (context: StrictEffectApiBoundaryContext) => {
    readonly Program: (node: StrictEffectApiBoundaryNode) => void;
  };
};

type CreateVerticalDescriptor = (appId: string, port: number) => WorkspaceAppFixture;

type CreateLayout = (appId: typeof AppIdSchema.Type) => string;

type CreateAppModernConfig = (applicationRoot: string, app: WorkspaceAppFixture) => string;

type CreateBackendModuleFederationConfig = (app: WorkspaceAppFixture) => string;

type CreateUltramodernBuildModule = (applicationRoot: string, app: WorkspaceAppFixture) => string;

interface ApiGeneratorFixture {
  readonly api?: {
    readonly consumedBy?: readonly string[];
    readonly prefix: string;
    readonly protocol?: string;
    readonly stem: string;
  };
  readonly exposes?: Readonly<Record<string, string>>;
  readonly id: string;
}

type CreateSharedApi = (scope: string, app: ApiGeneratorFixture) => string;

type CreateApiClient = (app: WorkspaceAppFixture, contractImportPath: string) => string;

type CreateApiServiceEntry = (
  scope: string,
  app: ApiGeneratorFixture,
  contractImportPath: string,
) => string;

interface GeneratedWorkspaceScriptArtifact {
  readonly content: string;
  readonly relativePath: string;
}

type MigratedWorkspaceScriptArtifacts = (options: {
  readonly hasBackendSurface: boolean;
  readonly shellOnly: boolean;
}) => readonly GeneratedWorkspaceScriptArtifact[];

type GeneratedHttpHandler = ReturnType<ReturnType<typeof defineEffectBff>['createHandler']>;

type CreateGeneratedHttpHandler = () => GeneratedHttpHandler;

type GeneratedReadiness = typeof MicroVerticalReadinessSchema.Type;

type GeneratedReadinessEffect = Effect.Effect<GeneratedReadiness, unknown>;

type GetGeneratedReadiness = (options?: {
  readonly baseUrl?: string | URL;
}) => GeneratedReadinessEffect;

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
  api: Schema.optionalKey(
    Schema.Struct({
      prefix: Schema.String,
      protocol: Schema.optionalKey(Schema.String),
      stem: Schema.String,
    }),
  ),
  exposes: Schema.Record(Schema.String, Schema.String),
  id: AppIdSchema,
});

const DescriptorModuleSchema = Schema.Struct({
  createVerticalDescriptor: callable<CreateVerticalDescriptor>(),
});

const ApiServiceGeneratorModuleSchema = Schema.Struct({
  createApiServiceEntry: callable<CreateApiServiceEntry>(),
});

const PackageGeneratorModuleSchema = Schema.Struct({
  createSharedPackage: callable<CreateSharedPackage>(),
});

const SharedApiGeneratorModuleSchema = Schema.Struct({
  createSharedApi: callable<CreateSharedApi>(),
});

const StrictEffectApiBoundaryRuleModuleSchema = Schema.Struct({
  createStrictEffectApiBoundariesRule: callable<StrictEffectApiBoundaryRuleFactory>(),
});

const ComponentModuleSchema = Schema.Struct({ createLayout: callable<CreateLayout>() });

const FederationConfigModuleSchema = Schema.Struct({
  createAppModernConfig: callable<CreateAppModernConfig>(),
  createBackendModuleFederationConfig: callable<CreateBackendModuleFederationConfig>(),
});

const BuildModuleGeneratorSchema = Schema.Struct({
  createUltramodernBuildModule: callable<CreateUltramodernBuildModule>(),
});

const SharedApiGeneratorSchema = Schema.Struct({ createSharedApi: callable<CreateSharedApi>() });

const ApiClientGeneratorSchema = Schema.Struct({ createApiClient: callable<CreateApiClient>() });

const ApiServiceGeneratorSchema = Schema.Struct({
  createApiServiceEntry: callable<CreateApiServiceEntry>(),
});

const WorkspaceScriptsGeneratorSchema = Schema.Struct({
  migratedWorkspaceScriptArtifacts: callable<MigratedWorkspaceScriptArtifacts>(),
});

const GeneratedApiRuntimeModuleSchema = Schema.Struct({
  default: Schema.Struct({ createHandler: callable<CreateGeneratedHttpHandler>() }),
});

const CloudflareEvidenceSchema = Schema.Struct({
  assertions: Schema.Array(Schema.Struct({ status: Schema.String, type: Schema.String })),
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
    const framework = yield* Schema.decodeUnknownEffect(ReleaseFrameworkModuleSchema)(source);
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
    return yield* Schema.decodeUnknownEffect(schema)(
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

it.live(
  'MicroVertical templates use the shared strict Effect BFF assembly primitive',
  Effect.fn(function* governanceScenario1() {
    const apiServiceModule: unknown = yield* Effect.promise(
      () => import(pathToFileURL(path.join(generatorRoot, generatedApiServiceModule)).href),
    );
    const apiServiceGenerator = yield* Schema.decodeUnknownEffect(ApiServiceGeneratorModuleSchema)(
      apiServiceModule,
    );
    const packageModule: unknown = yield* Effect.promise(
      () =>
        import(
          pathToFileURL(
            path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/package-json.js'),
          ).href
        ),
    );
    const packageGenerator = yield* Schema.decodeUnknownEffect(PackageGeneratorModuleSchema)(
      packageModule,
    );
    const source = apiServiceGenerator.createApiServiceEntry(
      'fixture',
      {
        api: { consumedBy: [], prefix: generatedApiPrefix, stem: generatedFixtureId },
        id: generatedFixtureId,
      },
      generatedSharedApiImport,
    );

    expect(source).toMatch(
      /import \{ assembleEffectBffRuntime \} from '@fixture\/shared-contracts\/server\/effect-bff-runtime';/u,
    );
    expect(source).toMatch(/const apiHandlersLive = Layer\.mergeAll\(/u);
    expect(source).toMatch(/assembleEffectBffRuntime\(\{[\s\S]*handlers: apiHandlersLive/u);
    expect(source).not.toMatch(/\bdefineEffectBff\b/u);

    const sharedContractsPackage = packageGenerator.createSharedPackage(
      'fixture',
      'shared-contracts',
      'fixture contracts',
      { modernPackageVersion: '3.8.2', strategy: 'install' },
    );
    expect(sharedContractsPackage.exports['./server/effect-bff-runtime']).toBe(
      './src/effect-bff-runtime.ts',
    );
    expect(sharedContractsPackage.dependencies['@modern-js/plugin-bff']).toBe('3.8.2');
    expect(sharedContractsPackage.dependencies.effect).toBe('4.0.0-beta.107');
    expect(
      yield* Effect.promise(() =>
        readFile(path.join(generatorRoot, 'templates/packages/effect-bff-runtime.ts'), 'utf-8'),
      ),
    ).toMatch(/export const assembleEffectBffRuntime/u);
    expect(
      yield* Effect.promise(() =>
        readFile(
          path.join(
            generatorRoot,
            'templates/workspace-scripts/check-ultramodern-api-boundaries.mts',
          ),
          'utf-8',
        ),
      ),
    ).toMatch(/strictEffectRuntimeTopologyViolation/u);
  }),
);

const adversarialStrictRuntimeSources = [
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer);
    export const makeRuntime = () => {
      return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      function assembleEffectBffRuntime(_input) { return fakeRuntime; }
    };
    const apiRuntime = makeRuntime();
    export default apiRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const groupLayer = HttpApiBuilder.group(fixtureApi, 'fixture', (handlers) => handlers);
    const handlers = Layer.mergeAll(groupLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers }) && fakeRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    type FakeLayer = typeof Layer;
    function fake(Layer: FakeLayer, callback: () => void) {
      const handlers = Layer.mergeAll(groupLayer);
      return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    }
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    function fake(Layer: { mergeAll: typeof Layer.mergeAll }): unknown {
      const handlers = Layer.mergeAll(groupLayer);
      return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    }
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    type FakeLayer = typeof Layer;
    function fake({ Layer }: { Layer: FakeLayer }) {
      const handlers = Layer.mergeAll(groupLayer);
      return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    }
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    type FakeLayer = typeof Layer;
    function fake<T>(Layer: FakeLayer) {
      const handlers = Layer.mergeAll(groupLayer);
      return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    }
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    type FakeLayer = typeof Layer;
    const fixture = {
      ["create"]<T>(Layer: FakeLayer): unknown {
        const handlers = Layer.mergeAll(groupLayer);
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      },
    };
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    try { runFixture(); } catch ({ Layer }) {
      const handlers = Layer.mergeAll(groupLayer);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    }
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const fakeRuntime = { assembleEffectBffRuntime };
    for (const { assembleEffectBffRuntime } of [fakeRuntime]) {
      const handlers = Layer.mergeAll(groupLayer);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    }
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer) satisfies Layer.Layer<any>
      ? fakeHandlers
      : fakeHandlers;
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const HttpRouter = { cors: () => Layer.empty };
    const handlers = Layer.mergeAll(groupLayer);
    const cors = HttpRouter.cors({});
    const transport = cors.pipe(Layer.orDie);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers, transport });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer);
    const proof = assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    function unrelated() { const proof = fakeRuntime; return proof; }
    export default fakeRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer);
    export const makeRuntime = () => {
      return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    };
    function dead() { const apiRuntime = makeRuntime(); return apiRuntime; }
    const apiRuntime = fakeRuntime;
    export default apiRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer, fakeHandlers } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer.pipe(() => fakeHandlers));
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer, fakeHandlers } from './group.ts';
    type GroupLayer = typeof groupLayer;
    export const makeRuntime = (groupLayer: GroupLayer) => {
      const handlers = Layer.mergeAll(groupLayer);
      return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    };
    const apiRuntime = makeRuntime(fakeHandlers);
    export default apiRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const HttpApiBuilder = { group: () => fakeHandlers };
    const groupLayer = HttpApiBuilder.group(fixtureApi, 'fixture', () => fakeHandlers);
    const handlers = Layer.mergeAll(groupLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    function decoy() {
      const handlers = Layer.mergeAll(groupLayer);
      return handlers;
    }
    const handlers = Layer.empty;
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer);
    export const makeRuntime = () => {
      if (false) return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      return fakeRuntime;
    };
    const apiRuntime = makeRuntime();
    export default apiRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer);
    export const makeRuntime = () => {
      if (true) return fakeRuntime;
      return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    };
    const apiRuntime = makeRuntime();
    export default apiRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const groupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
    const handlers = Layer.mergeAll(groupLayer);
    const apiRuntime = assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    export default apiRuntime && fakeRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const groupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
    const handlers = Layer.mergeAll(groupLayer);
    export const makeRuntime = () => {
      return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    };
    const apiRuntime = makeRuntime() && fakeRuntime;
    export default apiRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    export { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
    namespace HttpApiBuilder { export const group = () => Layer.empty; }
    const groupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
    const handlers = Layer.mergeAll(groupLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer, SomeOtherExport as HttpRouter } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const groupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
    const handlers = Layer.mergeAll(groupLayer);
    const transport = HttpRouter.cors({});
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers, transport: transport });
  `,
  `
    import { defineEffectBff, HttpApi, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureRpcGroup } from '../shared/rpc.ts';
    const fakeRpcGroup = { toLayer: () => Layer.empty };
    const fakeRpcLayer = Layer.empty;
    const rpcTransport = HttpApi.make('FixtureRpcTransport');
    const layer = Layer.empty;
    const apiRuntime = defineEffectBff({
      api: rpcTransport,
      layer,
      rpc: {
        group: fakeRpcGroup,
        layer: fakeRpcLayer,
        path: '/rpc',
        serialization: 'json',
      },
    });
    export default apiRuntime;
  `,
  `
    import { defineEffectBff, HttpApi, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fakeRpcGroup as fixtureRpcGroup } from '../shared/rpc.ts';
    const fixtureRpcLayer = fixtureRpcGroup.toLayer({});
    const rpcTransport = HttpApi.make('FixtureRpcTransport');
    const layer = Layer.empty;
    export default defineEffectBff({
      api: rpcTransport,
      layer,
      rpc: {
        group: fixtureRpcGroup,
        layer: fixtureRpcLayer,
        path: '/rpc',
        serialization: 'json',
      },
    });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { arbitraryLayer } from 'anything';
    const handlers = Layer.mergeAll(arbitraryLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
] as const;

const validAdversarialStrictRuntimeSources = [
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const groupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
    const pattern = /{/u;
    const handlers = Layer.mergeAll(groupLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const groupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
    const handlers: Layer.Layer<never, never, { readonly run: () => void; }> =
      Layer.mergeAll(groupLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { $api } from '../shared/api.ts';
    const $groupLayer = HttpApiBuilder.group(
      $api,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
    const $handlers = Layer.mergeAll($groupLayer);
    export default assembleEffectBffRuntime({ api: $api, handlers: $handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const groupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
    type Pair<A, B> = readonly [A, B];
    function observe(value: Pair<string, typeof Layer>): void {}
    const first = condition ? identity(Layer) : {};
    const second = condition ? identity(Layer) : () => {};
    switch (value) { case identity(Layer): { break; } }
    const handlers = Layer.mergeAll(
      groupLayer satisfies Layer.Layer<ExpectedHandlers, never, Requirements>,
    );
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime as assemble } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const groupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
    function unrelated(Layer) { return Layer; }
    const handlers = Layer.mergeAll(groupLayer);
    export default assemble({ api: fixtureApi, handlers: handlers });
  `,
] as const;

it('static API validation proves the imported helper call topology', () => {
  const valid = `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const groupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
    const fixtureHandlers = Layer.mergeAll(groupLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: fixtureHandlers });
  `;
  expect(strictEffectRuntimeTopologyViolation(valid)).toBe(undefined);
  const groupModule = `
    import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    export const fixtureGroupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
  `;
  const aggregateModule = `
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureGroupLayer } from './fixture-group.ts';
    export const fixtureHandlers = Layer.mergeAll(fixtureGroupLayer);
  `;
  const importedHandlers = `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/plugin-bff/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { fixtureHandlers } from './fixture-handlers.ts';
    const handlers = Layer.mergeAll(fixtureHandlers);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `;
  const sharedApiModule = {
    id: 'owner/shared/api.ts',
    resolveImport: unexpectedTopologyImport,
    source: fixtureApiModuleSource,
  };
  const resolveImportedHandlers = (specifier: string) => {
    if (specifier === generatedSharedApiImport) {
      return sharedApiModule;
    }
    if (specifier !== './fixture-handlers.ts') {
      return unexpectedTopologyImport(specifier);
    }
    return {
      id: 'fixture-handlers.ts',
      resolveImport: (nestedSpecifier: string) => {
        if (nestedSpecifier !== './fixture-group.ts') {
          return unexpectedTopologyImport(nestedSpecifier);
        }
        return {
          id: 'fixture-group.ts',
          resolveImport: (groupSpecifier: string) => {
            if (groupSpecifier === generatedSharedApiImport) {
              return sharedApiModule;
            }
            return unexpectedTopologyImport(groupSpecifier);
          },
          source: groupModule,
        };
      },
      source: aggregateModule,
    };
  };
  expect(strictEffectRuntimeTopologyViolation(importedHandlers, resolveImportedHandlers)).toBe(
    undefined,
  );
  const foreignGroupModule = groupModule.replace(
    `from '${generatedSharedApiImport}'`,
    "from '../../foreign/shared/api.ts'",
  );
  const resolveForeignHandlers = (specifier: string) => {
    if (specifier === generatedSharedApiImport) {
      return sharedApiModule;
    }
    if (specifier !== './fixture-handlers.ts') {
      return unexpectedTopologyImport(specifier);
    }
    return {
      id: 'fixture-handlers.ts',
      resolveImport: (nestedSpecifier: string) => {
        if (nestedSpecifier !== './fixture-group.ts') {
          return unexpectedTopologyImport(nestedSpecifier);
        }
        return {
          id: 'foreign/api/fixture-group.ts',
          resolveImport: (groupSpecifier: string) => {
            if (groupSpecifier === '../../foreign/shared/api.ts') {
              return {
                id: 'foreign/shared/api.ts',
                resolveImport: unexpectedTopologyImport,
                source: fixtureApiModuleSource,
              };
            }
            return unexpectedTopologyImport(groupSpecifier);
          },
          source: foreignGroupModule,
        };
      },
      source: aggregateModule,
    };
  };
  expect(
    violationText(strictEffectRuntimeTopologyViolation(importedHandlers, resolveForeignHandlers)),
  ).toMatch(/explicitly composed Layer/u);
  expect(
    strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime as assemble } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const groupLayer = HttpApiBuilder.group(
        fixtureApi,
        'fixture',
        (handlers) => handlers.handle('reachable', () => undefined),
      );
      function unrelated(Layer) { return Layer; }
      const handlers = Layer.mergeAll(groupLayer);
      export default assemble({ api: fixtureApi, handlers: handlers });
    `),
  ).toBe(undefined);
  for (const [index, source] of validAdversarialStrictRuntimeSources.entries()) {
    expect(
      strictEffectRuntimeTopologyViolation(source),
      `valid adversarial source ${index + 1}`,
    ).toBe(undefined);
  }
  for (const source of adversarialStrictRuntimeSources) {
    expect(strictEffectRuntimeTopologyViolation(source)).not.toBe(undefined);
  }
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer: Layer.Layer<never> = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
      );
      export default defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `),
    ),
  ).toMatch(/server-only shared Effect BFF assembly helper/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      import { groupLayer } from './group.ts';
      function decoy() {
        const handlers = Layer.mergeAll(groupLayer);
        return handlers;
      }
      const handlers = Layer.empty;
      export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `),
    ),
  ).toMatch(/explicitly composed Layer/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const groupLayer = HttpApiBuilder.group(
        fixtureApi,
        'fixture',
        (handlers) => handlers.handle('reachable', () => undefined),
      );
      const handlers = Layer.mergeAll(groupLayer);
      export const makeRuntime = () => {
        if (false) return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
        return fakeRuntime;
      };
      const apiRuntime = makeRuntime();
      export default apiRuntime;
    `),
    ),
  ).toMatch(/return or export the assembled strict Effect BFF runtime/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { defineEffectBff, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = Layer.empty;
      export default defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `),
    ),
  ).toMatch(/server-only shared Effect BFF assembly helper/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(() => Layer.empty);
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `),
    ),
  ).toMatch(/server-only shared Effect BFF assembly helper/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
        () => Layer.empty,
      );
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `),
    ),
  ).toMatch(/server-only shared Effect BFF assembly helper/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { fixtureApi } from '../shared/api.ts';
      const defineEffectBff = () => undefined;
      defineEffectBff({ api: fixtureApi, layer: fakeLayer });
    `),
    ),
  ).toMatch(/server-only shared Effect BFF assembly helper/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { fixtureApi } from '../shared/api.ts';
      const decoy = "defineEffectBff({ api: fixtureApi, layer: fakeLayer })";
    `),
    ),
  ).toMatch(/server-only shared Effect BFF assembly helper/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { fixtureApi } from '../shared/api.ts';
      const unrelated = Layer.mergeAll(groupLayer);
      const assembleEffectBffRuntime = () => undefined;
      assembleEffectBffRuntime({ api: fixtureApi, handlers: unrelated });
    `),
    ),
  ).toMatch(/server-only shared Effect BFF assembly helper/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const unrelated = Layer.mergeAll(groupLayer);
      assembleEffectBffRuntime({ api: otherApi, handlers: unrelated });
    `),
    ),
  ).toMatch(/API imported from \.\.\/shared\/api\.ts/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const unrelated = Layer.mergeAll(groupLayer);
      const handlers = unrelated;
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `),
    ),
  ).toMatch(/explicitly composed Layer/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer).pipe(() => Layer.empty);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `),
    ),
  ).toMatch(/explicitly composed Layer/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const groupLayer = HttpApiBuilder.group(
        fixtureApi,
        'fixture',
        (handlers) => handlers.handle('reachable', () => undefined),
      );
      const handlers = Layer.mergeAll(groupLayer);
      const transport = Layer.mergeAll(transportLayer).pipe(() => Layer.empty);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers, transport: transport });
    `),
    ),
  ).toMatch(/transport/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.thisDoesNotExist(groupLayer);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `),
    ),
  ).toMatch(/explicitly composed Layer/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer);
      function fake(assembleEffectBffRuntime) {
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `),
    ),
  ).toMatch(/unshadowed/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      {
        const { assembleEffectBffRuntime } = fakeRuntime;
        const handlers = Layer.mergeAll(groupLayer);
        assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `),
    ),
  ).toMatch(/unshadowed/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      try {
        runFixture();
      } catch (Layer) {
        const handlers = Layer.mergeAll(groupLayer);
        assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `),
    ),
  ).toMatch(/unshadowed/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixture = {
        create(Layer) {
          const handlers = Layer.mergeAll(groupLayer);
          return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
        },
      };
    `),
    ),
  ).toMatch(/unshadowed/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      function fake(Layer) {
        const handlers = Layer.mergeAll(groupLayer);
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `),
    ),
  ).toMatch(/unshadowed/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      const fakeImport = \`
        import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
        import { fixtureApi } from '../shared/api.ts';
      \`;
      const fixtureApi = {};
      const handlers = Layer.mergeAll(groupLayer);
      const assembleEffectBffRuntime = (input) => input;
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `),
    ),
  ).toMatch(/server-only shared Effect BFF assembly helper/u);
  expect(
    violationText(
      strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fakeHandlers = "Layer.mergeAll(groupLayer)";
      assembleEffectBffRuntime({ api: fixtureApi, handlers: fakeHandlers });
    `),
    ),
  ).toMatch(/explicitly composed Layer/u);
});

it.live(
  'published lint validators reject comment, string, and local strict-root spoofs',
  Effect.fn(function* governanceScenario2() {
    const codeToolsRoot = yield* Effect.promise(() =>
      realpath(path.join(workspaceRoot, 'node_modules/@modern-js/code-tools')),
    );
    const formats = [
      'dist/cjs/oxlint-plugin/rules/strict-effect-api-boundaries.cjs',
      'dist/esm/oxlint-plugin/rules/strict-effect-api-boundaries.js',
      'dist/esm-node/oxlint-plugin/rules/strict-effect-api-boundaries.js',
    ] as const;
    const apiServiceSource: unknown = yield* Effect.promise(
      () => import(pathToFileURL(path.join(generatorRoot, generatedApiServiceModule)).href),
    );
    const apiServiceGenerator = yield* Schema.decodeUnknownEffect(ApiServiceGeneratorModuleSchema)(
      apiServiceSource,
    );
    const generatedSource = apiServiceGenerator.createApiServiceEntry(
      'app',
      {
        api: { consumedBy: [], prefix: generatedApiPrefix, stem: generatedFixtureId },
        id: generatedFixtureId,
      },
      generatedSharedApiImport,
    );
    const generatedRpcSource = apiServiceGenerator.createApiServiceEntry(
      'app',
      {
        api: {
          consumedBy: [],
          prefix: generatedApiPrefix,
          protocol: 'rpc',
          stem: generatedFixtureId,
        },
        id: generatedFixtureId,
      },
      generatedSharedRpcImport,
    );
    const generatedRpcContractSource = `
    import { RpcGroup } from 'effect/unstable/rpc';
    export const inventoryStockRpcGroup = RpcGroup.make();
  `;
    expect(
      strictEffectRuntimeTopologyViolation(generatedRpcSource, (specifier) =>
        specifier === generatedSharedRpcImport
          ? {
              id: 'inventory-stock/shared/rpc.ts',
              resolveImport: unexpectedTopologyImport,
              source: generatedRpcContractSource,
            }
          : unexpectedTopologyImport(specifier),
      ),
    ).toBe(undefined);
    expect(
      violationText(
        strictEffectRuntimeTopologyViolation(generatedRpcSource, (specifier) =>
          specifier === generatedSharedRpcImport
            ? {
                id: 'inventory-stock/shared/rpc.ts',
                resolveImport: unexpectedTopologyImport,
                source: 'export const inventoryStockRpcGroup = { toLayer: () => undefined };',
              }
            : unexpectedTopologyImport(specifier),
        ),
      ),
    ).toMatch(/server-only shared Effect BFF assembly helper/u);
    const lintRoot = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-strict-api-lint-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );

    const fixtureRoot = path.join(lintRoot, 'verticals/fixture');
    const fixtureApiEntryPath = path.join(fixtureRoot, apiIndexFile);
    yield* Effect.promise(() => mkdir(path.join(fixtureRoot, 'api'), { recursive: true }));
    yield* Effect.promise(() => mkdir(path.join(fixtureRoot, 'shared'), { recursive: true }));
    yield* Effect.promise(() =>
      writeFile(path.join(fixtureRoot, sharedApiFile), governedApiModuleSource),
    );
    yield* Effect.promise(() =>
      writeFile(
        path.join(fixtureRoot, 'shared/rpc.ts'),
        'export const fixtureRpcGroup = { toLayer: () => undefined };\n',
      ),
    );
    yield* Effect.promise(() =>
      writeFile(
        path.join(fixtureRoot, 'api/shadowed-group.ts'),
        `
      export { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      namespace HttpApiBuilder {
        export const group = () => Layer.empty;
      }
      export const shadowedGroup = HttpApiBuilder.group(
        fixtureApi,
        'fixture',
        (handlers) => handlers.handle('reachable', () => undefined),
      );
    `,
      ),
    );
    const foreignRoot = path.join(lintRoot, 'verticals/foreign');
    yield* Effect.promise(() => mkdir(path.join(foreignRoot, 'shared'), { recursive: true }));
    yield* Effect.promise(() => mkdir(path.join(foreignRoot, 'api'), { recursive: true }));
    yield* Effect.promise(() =>
      writeFile(path.join(foreignRoot, sharedApiFile), `${fixtureApiModuleSource}\n`),
    );
    yield* Effect.promise(() =>
      writeFile(
        path.join(foreignRoot, 'api/group.ts'),
        `
      import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      export const foreignGroup = HttpApiBuilder.group(
        fixtureApi,
        'fixture',
        (handlers) => handlers.handle('reachable', () => undefined),
      );
    `,
      ),
    );
    const generatedRoot = path.join(lintRoot, 'verticals/inventory-stock');
    yield* Effect.promise(() => mkdir(path.join(generatedRoot, 'shared'), { recursive: true }));
    yield* Effect.promise(() =>
      writeFile(path.join(generatedRoot, sharedApiFile), 'export const inventoryStockApi = {};\n'),
    );
    yield* Effect.promise(() =>
      writeFile(path.join(generatedRoot, 'shared/rpc.ts'), generatedRpcContractSource),
    );
    const invalidSources = [
      ...adversarialStrictRuntimeSources,
      ...governedLayerAliasMutations.map(([before, after]) =>
        governedLayerAliasFixture.replace(before, after),
      ),
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      import { shadowedGroup } from './shadowed-group.ts';
      const handlers = Layer.mergeAll(shadowedGroup);
      export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      import { foreignGroup } from '../../foreign/api/group.ts';
      const handlers = Layer.mergeAll(foreignGroup);
      export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      `
      import { fake as defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(Layer.provide(fixtureHandlers));
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      `
      import { defineEffectBff, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = Layer.empty;
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      `
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const defineEffectBff = () => undefined;
      const fixtureLayer = Layer.empty;
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      `
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const decoy = "defineEffectBff({ api: fixtureApi, layer: Layer.empty })";
      // defineEffectBff({ api: fixtureApi, layer: Layer.empty });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fakeHandlers = "Layer.mergeAll(groupLayer)";
      assembleEffectBffRuntime({ api: fixtureApi, handlers: fakeHandlers });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer);
      function fake(assembleEffectBffRuntime) {
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      function fake(Layer) {
        const handlers = Layer.mergeAll(groupLayer);
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.thisDoesNotExist(groupLayer);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
        () => Layer.empty,
      );
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer).pipe(() => Layer.empty);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer);
      const transport = Layer.mergeAll(transportLayer).pipe(() => Layer.empty);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers, transport: transport });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      {
        const { assembleEffectBffRuntime } = fakeRuntime;
        const handlers = Layer.mergeAll(groupLayer);
        assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      try {
        runFixture();
      } catch (Layer) {
        const handlers = Layer.mergeAll(groupLayer);
        assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixture = {
        create(Layer) {
          const handlers = Layer.mergeAll(groupLayer);
          return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
        },
      };
    `,
      `
      import { fake as assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      `
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      const fakeImports = \`
        import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
        import { fixtureApi } from '../shared/api.ts';
      \`;
      const fixtureApi = {};
      const handlers = Layer.mergeAll(groupLayer);
      const assembleEffectBffRuntime = (input) => input;
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
    ] as const;

    const modules = yield* Effect.all(
      formats.map(
        Effect.fn(function* governanceScenario3(moduleFormat) {
          const imported: unknown = yield* Effect.promise(
            () => import(pathToFileURL(path.join(codeToolsRoot, moduleFormat)).href),
          );
          return {
            module: yield* Schema.decodeUnknownEffect(StrictEffectApiBoundaryRuleModuleSchema)(
              imported,
            ),
            moduleFormat,
          };
        }),
      ),
      { concurrency: 'unbounded' },
    );
    for (const { module, moduleFormat } of modules) {
      for (const source of invalidSources) {
        const messages: string[] = [];
        const listener = module.createStrictEffectApiBoundariesRule().create({
          filename: fixtureApiEntryPath,
          getSourceCode: () => ({ getText: () => source, text: source }),
          report: ({ message }) => {
            messages.push(message);
          },
        });
        listener.Program({});
        expect(
          messages.some((message) =>
            /server-only shared Effect BFF assembly helper|explicitly composed handler Layer/u.test(
              message,
            ),
          ),
          `${moduleFormat} accepted a fake strict runtime root`,
        ).toBeTruthy();
      }
      const legacySource = `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer: Layer.Layer<never> = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
      );
      export default defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `;
      const legacyMessages: string[] = [];
      module
        .createStrictEffectApiBoundariesRule()
        .create({
          filename: fixtureApiEntryPath,
          getSourceCode: () => ({ getText: () => legacySource, text: legacySource }),
          report: ({ message }) => {
            legacyMessages.push(message);
          },
        })
        .Program({});
      expect(
        legacyMessages.some((message) =>
          /server-only shared Effect BFF assembly helper|explicitly composed handler Layer/u.test(
            message,
          ),
        ),
        `${moduleFormat} accepted a legacy runtime root without the shared assembly helper`,
      ).toBe(true);
      const generatedMessages: string[] = [];
      module
        .createStrictEffectApiBoundariesRule()
        .create({
          filename: path.join(generatedRoot, apiIndexFile),
          getSourceCode: () => ({ getText: () => generatedSource, text: generatedSource }),
          report: ({ message }) => {
            generatedMessages.push(message);
          },
        })
        .Program({});
      expect(
        generatedMessages.some((message) =>
          /server-only shared Effect BFF assembly helper|explicitly composed handler Layer/u.test(
            message,
          ),
        ),
        `${moduleFormat} rejected exact generated helper output: ${generatedMessages.join(' | ')}`,
      ).toBe(false);
      const generatedRpcMessages: string[] = [];
      module
        .createStrictEffectApiBoundariesRule()
        .create({
          filename: path.join(generatedRoot, apiIndexFile),
          getSourceCode: () => ({ getText: () => generatedRpcSource, text: generatedRpcSource }),
          report: ({ message }) => {
            generatedRpcMessages.push(message);
          },
        })
        .Program({});
      expect(
        generatedRpcMessages.some((message) =>
          /server-only shared Effect BFF assembly helper|explicitly composed handler Layer|\.\.\/shared\/api\.ts/u.test(
            message,
          ),
        ),
        `${moduleFormat} rejected exact generated RPC output: ${generatedRpcMessages.join(' | ')}`,
      ).toBe(false);
      for (const source of [...validAdversarialStrictRuntimeSources, governedLayerAliasFixture]) {
        const messages: string[] = [];
        module
          .createStrictEffectApiBoundariesRule()
          .create({
            filename: fixtureApiEntryPath,
            getSourceCode: () => ({ getText: () => source, text: source }),
            report: ({ message }) => {
              messages.push(message);
            },
          })
          .Program({});
        expect(
          messages.some((message) =>
            /server-only shared Effect BFF assembly helper|explicitly composed handler Layer/u.test(
              message,
            ),
          ),
          `${moduleFormat} rejected a valid strict runtime root: ${messages.join(' | ')}`,
        ).toBe(false);
      }
    }
  }),
);

it.live(
  'a minimal generated MicroVertical typechecks and serves its runtime',
  Effect.fn(function* governanceScenario4() {
    const apiServiceSource: unknown = yield* Effect.promise(
      () => import(pathToFileURL(path.join(generatorRoot, generatedApiServiceModule)).href),
    );
    const apiServiceGenerator = yield* Schema.decodeUnknownEffect(ApiServiceGeneratorModuleSchema)(
      apiServiceSource,
    );
    const sharedApiSource: unknown = yield* Effect.promise(
      () =>
        import(
          pathToFileURL(
            path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/api/shared.js'),
          ).href
        ),
    );
    const sharedApiGenerator = yield* Schema.decodeUnknownEffect(SharedApiGeneratorModuleSchema)(
      sharedApiSource,
    );
    const descriptor = {
      api: { consumedBy: [], prefix: generatedApiPrefix, stem: generatedFixtureId },
      id: generatedFixtureId,
    } as const;
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() =>
        mkdtemp(path.join(workspaceRoot, 'verticals/party-registry/.generated-runtime-')),
      ),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    yield* writeText(
      fixture,
      apiIndexFile,
      apiServiceGenerator.createApiServiceEntry('app', descriptor, generatedSharedApiImport),
    );
    yield* writeText(fixture, sharedApiFile, sharedApiGenerator.createSharedApi('app', descriptor));
    yield* writeText(
      fixture,
      buildMarkerFile,
      `export const ultramodernApiMarker = {
        appId: '${generatedFixtureId}',
        build: 'test',
        buildMarker: 'test',
        deployProfile: 'node',
        packageName: '@app/inventory-stock',
        sourceRevision: 'test',
        surface: 'api',
        unitId: 'vertical/inventory-stock',
        version: '0.1.0',
      } as const;\n`,
    );
    yield* writeJson(fixture, tsconfigFile, {
      compilerOptions: { composite: false, noEmit: true, types: ['node'] },
      extends: '../../../tsconfig.base.json',
      include: ['api/**/*.ts', 'shared/**/*.ts'],
    });
    execFileSync(path.join(workspaceRoot, 'node_modules/.bin/tsc'), ['-p', tsconfigFile], {
      cwd: fixture,
      encoding: 'utf-8',
    });
    yield* writeText(
      fixture,
      'runtime-proof.mjs',
      `import { makeInventoryStockApiRuntime } from './api/index.ts';
      const runtime = makeInventoryStockApiRuntime();
      const server = runtime.createHandler();
      try {
        const response = await server.handler(
          new Request('http://localhost/inventory-stock/readiness'),
        );
        if (response.status !== 200) throw new Error(\`expected 200, received \${response.status}\`);
        const body = await response.json();
        if (body.status !== 'ready') throw new Error('generated readiness response was invalid');
      } finally {
        await server.dispose();
      }\n`,
    );
    runNode([path.join(fixture, 'runtime-proof.mjs')], { cwd: fixture });
  }),
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
    return yield* Schema.decodeUnknownEffect(ReleaseEnvelopeSchema)(
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
          const envelope = yield* Schema.decodeUnknownEffect(ReleaseEnvelopeSchema)(
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
          const staged = yield* Schema.decodeUnknownEffect(ReleaseEnvelopeSchema)(
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
          const envelope = yield* Schema.decodeUnknownEffect(ReleaseEnvelopeSchema)(
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
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GlobalVarsSchema))(output);
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
    const rspackFixture =
      yield* Schema.decodeUnknownEffect(RspackModuleFixtureSchema)(rspackModule);
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
      const compiler = yield* Schema.decodeUnknownEffect(CompilerFixtureSchema)({
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
        const stats = yield* Schema.decodeUnknownEffect(CompilerStatsFixtureSchema)({
          hasErrors: statsSource.hasErrors,
          toString: statsSource.toString,
        });
        const hasErrors = stats.hasErrors.bind(statsSource)();
        const errorText = stats.toString.bind(statsSource)({ all: false, errors: true });
        expect(hasErrors, errorText).toBe(false);
      }).pipe(Effect.ensuring(Effect.promise(() => closeCompiler())));
      const compiledReaderModule: unknown = require(path.join(temporaryRoot, 'reader.cjs'));
      const compiledReader =
        yield* Schema.decodeUnknownEffect(CompiledReaderSchema)(compiledReaderModule);
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
  Effect.fn(function* governanceScenario5() {
    yield* Effect.all(
      ['esm', 'esm-node', 'cjs'].map(
        Effect.fn(function* governanceScenario6(moduleFormat) {
          const generatorModulePath = publishedGeneratorModulePath(moduleFormat);
          const descriptorPath = generatorModulePath('descriptors');
          const descriptorSource: unknown =
            moduleFormat === 'cjs'
              ? require(descriptorPath)
              : yield* Effect.promise(() => import(pathToFileURL(descriptorPath).href));
          const descriptorModule =
            yield* Schema.decodeUnknownEffect(DescriptorModuleSchema)(descriptorSource);
          const componentPath = generatorModulePath('demo-components');
          const componentSource: unknown =
            moduleFormat === 'cjs'
              ? require(componentPath)
              : yield* Effect.promise(() => import(pathToFileURL(componentPath).href));
          const componentModule =
            yield* Schema.decodeUnknownEffect(ComponentModuleSchema)(componentSource);
          const federationPath = generatorModulePath('module-federation/config');
          const federationSource: unknown =
            moduleFormat === 'cjs'
              ? require(federationPath)
              : yield* Effect.promise(() => import(pathToFileURL(federationPath).href));
          const federationModule = yield* Schema.decodeUnknownEffect(FederationConfigModuleSchema)(
            federationSource,
          );
          const buildModulePath = generatorModulePath('module-federation/reexport-module');
          const buildModuleSource: unknown =
            moduleFormat === 'cjs'
              ? require(buildModulePath)
              : yield* Effect.promise(() => import(pathToFileURL(buildModulePath).href));
          const buildModule = yield* Schema.decodeUnknownEffect(BuildModuleGeneratorSchema)(
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
          const descriptor = yield* Schema.decodeUnknownEffect(WorkspaceAppFixtureSchema, {
            onExcessProperty: 'preserve',
          })(createVerticalDescriptor(partyId, 4102), { onExcessProperty: 'preserve' });
          const app = { ...descriptor, exposes: {} };
          const generated = {
            'backend-federation.config.ts': yield* Schema.decodeUnknownEffect(Schema.String)(
              createBackendModuleFederationConfig(app),
            ),
            [buildMarkerFile]: yield* Schema.decodeUnknownEffect(Schema.String)(
              createUltramodernBuildModule('app', app),
            ),
            'modern.config.ts': yield* Schema.decodeUnknownEffect(Schema.String)(
              createAppModernConfig('app', app),
            ),
            'src/routes/layout.tsx': yield* Schema.decodeUnknownEffect(Schema.String)(
              createLayout(app.id),
            ),
          };
          yield* Effect.all(
            Object.entries(generated).map(
              Effect.fn(function* governanceScenario7([fileName, source]) {
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
  'all published scaffold formats generate the shared MicroVertical API baseline',
  Effect.fn(function* governanceScenario8() {
    yield* Effect.all(
      ['esm', 'esm-node', 'cjs'].map(
        Effect.fn(function* governanceScenario9(moduleFormat) {
          const generatorModulePath = publishedGeneratorModulePath(moduleFormat);
          const descriptorPath = generatorModulePath('descriptors');
          const sharedApiPath = generatorModulePath(generatedSharedApiModule);
          const clientPath = generatorModulePath('api/client');
          const servicePath = generatorModulePath(generatedServiceModuleName);
          const descriptorSource: unknown =
            moduleFormat === 'cjs'
              ? require(descriptorPath)
              : yield* Effect.promise(() => import(pathToFileURL(descriptorPath).href));
          const sharedApiSource: unknown =
            moduleFormat === 'cjs'
              ? require(sharedApiPath)
              : yield* Effect.promise(() => import(pathToFileURL(sharedApiPath).href));
          const clientSource: unknown =
            moduleFormat === 'cjs'
              ? require(clientPath)
              : yield* Effect.promise(() => import(pathToFileURL(clientPath).href));
          const serviceSource: unknown =
            moduleFormat === 'cjs'
              ? require(servicePath)
              : yield* Effect.promise(() => import(pathToFileURL(servicePath).href));
          const descriptorModule =
            yield* Schema.decodeUnknownEffect(DescriptorModuleSchema)(descriptorSource);
          const sharedApiModule =
            yield* Schema.decodeUnknownEffect(SharedApiGeneratorSchema)(sharedApiSource);
          const clientModule =
            yield* Schema.decodeUnknownEffect(ApiClientGeneratorSchema)(clientSource);
          const serviceModule =
            yield* Schema.decodeUnknownEffect(ApiServiceGeneratorSchema)(serviceSource);
          const descriptor = yield* Schema.decodeUnknownEffect(WorkspaceAppFixtureSchema, {
            onExcessProperty: 'preserve',
          })(descriptorModule.createVerticalDescriptor(inventoryStockId, 4103), {
            onExcessProperty: 'preserve',
          });
          const app = { ...descriptor, exposes: {} };
          const contract = sharedApiModule.createSharedApi(generatedProofScope, app);
          const client = clientModule.createApiClient(app, generatedClientContractImport);
          const service = serviceModule.createApiServiceEntry(
            generatedProofScope,
            app,
            generatedSharedApiImport,
          );

          expect(contract, moduleFormat).toMatch(/MicroVerticalBuildMarkerSchema/u);
          expect(contract, moduleFormat).toMatch(/MicroVerticalReadinessSchema/u);
          expect(contract, moduleFormat).toMatch(/createMicroVerticalOperationContext/u);
          expect(contract, moduleFormat).toMatch(/@generated-proof\/shared-contracts/u);
          expect(contract, moduleFormat).not.toMatch(/export interface OperationContext/u);
          expect(client, moduleFormat).toMatch(/client\.foundation\.readiness\(\{\}\)/u);
          expect(client, moduleFormat).not.toMatch(/client\.inventoryStock\.readiness/u);
          expect(service, moduleFormat).toMatch(/microVerticalOperationAttributes/u);
          expect(service, moduleFormat).toMatch(/@generated-proof\/shared-contracts/u);
          expect(service, moduleFormat).not.toMatch(/const operationAttributes/u);
          const generatedBaselineExpectation = {
            additionalPaths: {},
            apiPrefix: `/${inventoryStockId}-api`,
            basePath: `/${inventoryStockId}-api/${inventoryStockId}`,
            effectClientPackage,
            ownerId: inventoryStockId,
            readinessPath: `/${inventoryStockId}-api/${inventoryStockId}/readiness`,
            sharedContractsPackage: generatedSharedContractsPackage,
          } as const;
          expect(
            yield* microVerticalApiBaselineViolation(
              inventoryStockId,
              contract,
              generatedBaselineExpectation,
            ),
          ).toBe(undefined);

          const customStemApp = {
            ...app,
            api: { ...app.api, prefix: warehouseApiPrefix, stem: warehouseItemsApiStem },
          };
          const customStemContract = sharedApiModule.createSharedApi(
            generatedProofScope,
            customStemApp,
          );
          expect(
            yield* microVerticalApiBaselineViolation(warehouseItemsApiStem, customStemContract, {
              ...generatedBaselineExpectation,
              apiPrefix: warehouseApiPrefix,
              basePath: `/warehouse-api/${warehouseItemsApiStem}`,
              readinessPath: `/warehouse-api/${warehouseItemsApiStem}/readiness`,
            }),
          ).toBe(undefined);

          const checkoutDescriptor = yield* Schema.decodeUnknownEffect(WorkspaceAppFixtureSchema, {
            onExcessProperty: 'preserve',
          })(descriptorModule.createVerticalDescriptor(checkoutId, 4105), {
            onExcessProperty: 'preserve',
          });
          const checkoutContract = sharedApiModule.createSharedApi(generatedProofScope, {
            ...checkoutDescriptor,
            exposes: {},
          });
          const checkoutClient = clientModule.createApiClient(
            checkoutDescriptor,
            generatedClientContractImport,
          );
          expect(
            yield* microVerticalApiBaselineViolation(checkoutId, checkoutContract, {
              additionalPaths: {
                checkoutCartPath: '/checkout-api/checkout/cart',
              },
              ownerId: checkoutId,
              sharedContractsPackage: generatedSharedContractsPackage,
            }),
            `${moduleFormat} checkout cart operations must retain baseline validation`,
          ).toBe(undefined);
          expect(checkoutClient, moduleFormat).toMatch(/client\.foundation\.readiness\(\{\}\)/u);
          expect(checkoutClient, moduleFormat).not.toMatch(/client\.checkout\.readiness/u);
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.live(
  'all published scaffold formats emit the executable AST baseline validator',
  Effect.fn(function* governanceScenario10() {
    const scratchRoot = path.join(workspaceRoot, 'packages/shared-contracts/.scratch');
    yield* Effect.promise(() => mkdir(scratchRoot, { recursive: true }));
    const proofRoot = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(scratchRoot, 'generated-baseline-validator-proof-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );

    const expectedHelper = yield* Effect.promise(() =>
      readFile(
        path.join(workspaceRoot, 'scripts/microvertical-api-baseline-boundary.mts'),
        'utf-8',
      ),
    );

    yield* Effect.all(
      ['esm', 'esm-node', 'cjs'].map(
        Effect.fn(function* governanceScenario11(moduleFormat) {
          const extension = moduleFormat === 'cjs' ? 'cjs' : 'js';
          const modulePath = path.join(
            generatorRoot,
            `dist/${moduleFormat}/ultramodern-workspace/workspace-scripts.${extension}`,
          );
          const moduleSource: unknown =
            moduleFormat === 'cjs'
              ? require(modulePath)
              : yield* Effect.promise(() => import(pathToFileURL(modulePath).href));
          const generator = yield* Schema.decodeUnknownEffect(WorkspaceScriptsGeneratorSchema)(
            moduleSource,
          );
          const artifacts = generator.migratedWorkspaceScriptArtifacts({
            hasBackendSurface: true,
            shellOnly: false,
          });
          const helper = artifacts.find(
            ({ relativePath }) =>
              relativePath === 'scripts/microvertical-api-baseline-boundary.mts',
          );
          const checker = artifacts.find(
            ({ relativePath }) => relativePath === apiBoundaryCheckerPath,
          );
          expect(helper, `${moduleFormat} must emit the AST baseline helper`).toBeTruthy();
          expect(checker, `${moduleFormat} must emit the API checker`).toBeDefined();
          if (helper === undefined || checker === undefined) {
            yield* Effect.die(new Error(`${moduleFormat} omitted baseline validator artifacts`));
            return;
          }
          expect(
            yield* normalizedGeneratedSource(
              'microvertical-api-baseline-boundary.mts',
              helper.content,
            ),
            `${moduleFormat} must emit the exact repository validator`,
          ).toBe(
            yield* normalizedGeneratedSource(
              'microvertical-api-baseline-boundary.mts',
              expectedHelper,
            ),
          );
          const formatRoot = path.join(proofRoot, moduleFormat);
          yield* writeText(formatRoot, helper.relativePath, helper.content);
          yield* writeText(formatRoot, checker.relativePath, checker.content);
          expect(checker.content).toMatch(/microVerticalApiBaselineViolation/u);
          expect(
            runNode([path.join(formatRoot, checker.relativePath)], {
              env: { ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
            }),
            moduleFormat,
          ).toMatch(/UltraModern API boundary check passed/u);

          const generatorModulePath = publishedGeneratorModulePath(moduleFormat);
          const descriptorSource: unknown =
            moduleFormat === 'cjs'
              ? require(generatorModulePath('descriptors'))
              : yield* Effect.promise(
                  () => import(pathToFileURL(generatorModulePath('descriptors')).href),
                );
          const sharedApiSource: unknown =
            moduleFormat === 'cjs'
              ? require(generatorModulePath(generatedSharedApiModule))
              : yield* Effect.promise(
                  () => import(pathToFileURL(generatorModulePath(generatedSharedApiModule)).href),
                );
          const descriptorModule =
            yield* Schema.decodeUnknownEffect(DescriptorModuleSchema)(descriptorSource);
          const sharedApiModule =
            yield* Schema.decodeUnknownEffect(SharedApiGeneratorSchema)(sharedApiSource);
          const checkoutDescriptor = descriptorModule.createVerticalDescriptor('shopping', 4105);
          const checkoutStemDescriptor = {
            ...checkoutDescriptor,
            api: { prefix: checkoutApiPrefix, stem: checkoutId },
            exposes: {},
          };
          const servicePath = generatorModulePath(generatedServiceModuleName);
          const serviceSource: unknown =
            moduleFormat === 'cjs'
              ? require(servicePath)
              : yield* Effect.promise(() => import(pathToFileURL(servicePath).href));
          const serviceModule =
            yield* Schema.decodeUnknownEffect(ApiServiceGeneratorSchema)(serviceSource);
          const checkoutWorkspace = path.join(formatRoot, 'checkout-workspace');
          yield* writeText(
            checkoutWorkspace,
            'verticals/shopping/shared/api.ts',
            sharedApiModule.createSharedApi(generatedProofScope, checkoutStemDescriptor),
          );
          yield* writeText(
            checkoutWorkspace,
            'verticals/shopping/api/index.ts',
            serviceModule.createApiServiceEntry(
              generatedProofScope,
              checkoutStemDescriptor,
              generatedSharedApiImport,
            ),
          );
          yield* writeText(
            checkoutWorkspace,
            'verticals/shopping/src/api/checkout-client.ts',
            'export const checkoutClient = true;\n',
          );
          yield* writeText(
            checkoutWorkspace,
            'verticals/shopping/modern.config.ts',
            `export default {
  bff: {
    runtimeFramework: 'effect',
    effect: { entry: './api/index', strictEffectApproach: true },
  },
};
`,
          );
          yield* writeJson(checkoutWorkspace, 'verticals/shopping/package.json', {
            exports: {
              './api': './shared/api.ts',
              './api/client': './src/api/checkout-client.ts',
            },
          });
          yield* writeJson(checkoutWorkspace, 'packages/shared-contracts/package.json', {
            name: generatedSharedContractsPackage,
          });
          yield* writeJson(checkoutWorkspace, topologyReferencePath, {
            verticals: [
              {
                api: {
                  basePath: '/checkout-api/checkout',
                  bff: { prefix: checkoutApiPrefix, strictEffectApproach: true },
                  readiness: { endpoint: '/checkout/readiness' },
                  runtime: 'effect',
                  serverEntry: 'verticals/shopping/api/index.ts',
                },
                id: 'shopping',
                path: 'verticals/shopping',
              },
            ],
          });
          yield* writeText(
            checkoutWorkspace,
            'verticals/shopping/dist-cloudflare/api/index.js',
            'export const handler = () => new Response();',
          );
          yield* writeText(
            checkoutWorkspace,
            'verticals/retired/node_modules/cache.js',
            'export const cached = true;',
          );
          expect(
            runNode([path.join(formatRoot, checker.relativePath)], {
              env: { ULTRAMODERN_WORKSPACE_ROOT: checkoutWorkspace },
            }),
            `${moduleFormat} ignores generated output and retired package caches`,
          ).toMatch(/UltraModern API boundary check passed/u);
          yield* writeText(
            checkoutWorkspace,
            'verticals/shopping/api/unsafe.ts',
            'export const response = new Response();',
          );
          expect(() =>
            runNode([path.join(formatRoot, checker.relativePath)], {
              env: { ULTRAMODERN_WORKSPACE_ROOT: checkoutWorkspace },
            }),
          ).toThrow(/API modules must not hand-build Response objects/u);
          yield* writeJson(checkoutWorkspace, 'verticals/retired/package.json', {
            name: '@generated-proof/retired',
          });
          expect(() =>
            runNode([path.join(formatRoot, checker.relativePath)], {
              env: { ULTRAMODERN_WORKSPACE_ROOT: checkoutWorkspace },
            }),
          ).toThrow(/verticals\/retired\/api\/index\.ts is required/u);
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.live(
  'two generated MicroVertical root contracts execute invariant readiness endpoints',
  Effect.fn(function* governanceScenario12() {
    const proofRoot = yield* Effect.acquireRelease(
      Effect.promise(() =>
        mkdtemp(path.join(workspaceRoot, `verticals/${partyId}/.generated-api-baseline-`)),
      ),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );

    const descriptorSource: unknown = yield* Effect.promise(
      () =>
        import(
          pathToFileURL(
            path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/descriptors.js'),
          ).href
        ),
    );
    const sharedApiSource: unknown = yield* Effect.promise(
      () =>
        import(
          pathToFileURL(
            path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/api/shared.js'),
          ).href
        ),
    );
    const apiServiceSource: unknown = yield* Effect.promise(
      () =>
        import(
          pathToFileURL(
            path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/api/service.js'),
          ).href
        ),
    );
    const apiClientSource: unknown = yield* Effect.promise(
      () =>
        import(
          pathToFileURL(
            path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/api/client.js'),
          ).href
        ),
    );
    const descriptorModule =
      yield* Schema.decodeUnknownEffect(DescriptorModuleSchema)(descriptorSource);
    const sharedApiModule =
      yield* Schema.decodeUnknownEffect(SharedApiGeneratorSchema)(sharedApiSource);
    const apiServiceModule =
      yield* Schema.decodeUnknownEffect(ApiServiceGeneratorSchema)(apiServiceSource);
    const apiClientModule =
      yield* Schema.decodeUnknownEffect(ApiClientGeneratorSchema)(apiClientSource);
    const fixtures = [
      {
        id: inventoryStockId,
        port: 4103,
        prefix: '/inventory-stock-api',
        readinessExport: 'getInventoryStockReadiness',
        stem: inventoryStockId,
      },
      {
        id: 'order-management',
        port: 4104,
        prefix: '/order-management-api',
        readinessExport: 'getOrderManagementReadiness',
        stem: 'order-management',
      },
      {
        id: 'shopping',
        port: 4105,
        prefix: checkoutApiPrefix,
        readinessExport: 'getCheckoutReadiness',
        stem: checkoutId,
      },
    ] as const;

    const generatedProofs = yield* Effect.all(
      fixtures.map(
        Effect.fn(function* governanceScenario13(fixture) {
          const descriptor = yield* Schema.decodeUnknownEffect(WorkspaceAppFixtureSchema, {
            onExcessProperty: 'preserve',
          })(descriptorModule.createVerticalDescriptor(fixture.id, fixture.port), {
            onExcessProperty: 'preserve',
          });
          expect(descriptor.api).toBeTruthy();
          const generatedDescriptor = {
            ...descriptor,
            api: { ...descriptor.api, prefix: fixture.prefix, stem: fixture.stem },
            exposes: {},
          };
          const contract = sharedApiModule.createSharedApi('app', generatedDescriptor);
          const basePath = `${fixture.prefix}/${fixture.stem}`;
          expect(
            yield* microVerticalApiBaselineViolation(fixture.stem, contract, {
              additionalPaths:
                fixture.stem === checkoutId ? { checkoutCartPath: `${basePath}/cart` } : {},
              apiPrefix: fixture.prefix,
              basePath,
              effectClientPackage,
              ownerId: fixture.id,
              readinessPath: `${basePath}/readiness`,
              sharedContractsPackage: '@app/shared-contracts',
            }),
          ).toBe(undefined);
          const ownerRoot = path.join(proofRoot, fixture.id);
          yield* writeText(ownerRoot, 'shared/api.ts', contract);
          yield* writeText(
            ownerRoot,
            buildMarkerFile,
            `export const ultramodernApiMarker = {
  appId: '${fixture.id}',
  build: '${fixture.id}-build',
  buildMarker: '${fixture.id}-build',
  deployProfile: 'cloudflare-ssr-mf-effect-v1',
  kind: 'microvertical-delivery-unit',
  packageName: '@app/${fixture.id}',
  schemaVersion: 1,
  sourceRevision: 'revision-123',
  surface: 'api',
  unitId: 'app/${fixture.id}',
  version: '0.1.0',
} as const;
`,
          );
          yield* writeText(
            ownerRoot,
            apiIndexFile,
            apiServiceModule.createApiServiceEntry(
              'app',
              generatedDescriptor,
              generatedSharedApiImport,
            ),
          );
          const clientEntryPath = `src/api/${fixture.id}-client.ts`;
          yield* writeText(
            ownerRoot,
            clientEntryPath,
            apiClientModule.createApiClient(generatedDescriptor, generatedClientContractImport),
          );
          yield* writeJson(ownerRoot, 'package.json', { type: 'module' });
          yield* writeJson(ownerRoot, tsconfigFile, {
            compilerOptions: {
              allowImportingTsExtensions: true,
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              noEmit: true,
              skipLibCheck: true,
              strict: true,
              target: 'ES2023',
            },
            include: ['api/**/*.ts', 'shared/**/*.ts', 'src/**/*.ts'],
          });
          runNode(
            [
              path.join(workspaceRoot, 'node_modules/@typescript/native-preview/bin/tsc'),
              '-p',
              ownerRoot,
            ],
            { cwd: workspaceRoot },
          );
          const generatedModuleSource: unknown = yield* Effect.promise(
            () => import(pathToFileURL(path.join(ownerRoot, apiIndexFile)).href),
          );
          const generatedClientSource: unknown = yield* Effect.promise(
            () => import(pathToFileURL(path.join(ownerRoot, clientEntryPath)).href),
          );
          const generatedModule = yield* Schema.decodeUnknownEffect(
            GeneratedApiRuntimeModuleSchema,
          )(generatedModuleSource);
          const generatedClient = yield* Schema.decodeUnknownEffect(
            Schema.Record(Schema.String, Schema.Unknown),
          )(generatedClientSource);
          const getReadiness = yield* Schema.decodeUnknownEffect(callable<GetGeneratedReadiness>())(
            generatedClient[fixture.readinessExport],
          );
          return { fixture, generatedModule, getReadiness };
        }),
      ),
      { concurrency: 'unbounded' },
    );
    const handlers = new Map<string, GeneratedHttpHandler>(
      yield* Effect.all(
        generatedProofs.map(({ fixture, generatedModule }) =>
          Effect.acquireRelease(
            Effect.sync(() => generatedModule.default.createHandler()),
            (handler) => Effect.promise(() => handler.dispose()),
          ).pipe(Effect.map((handler) => [fixture.stem, handler] as const)),
        ),
      ),
    );
    rs.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const request = new Request(input, init);
      const stem = new URL(request.url).pathname.split('/').find((segment) => segment.length > 0);
      const handler = stem === undefined ? undefined : handlers.get(stem);
      return handler === undefined
        ? Promise.resolve(new Response(undefined, { status: 503 }))
        : handler.handler(request);
    });
    const readinessValues = yield* Effect.all(
      generatedProofs.map(
        Effect.fn(function* verifyGeneratedReadiness({ fixture, getReadiness }) {
          const handler = handlers.get(fixture.stem);
          expect(handler).toBeDefined();
          if (handler === undefined) {
            return yield* Effect.die(new Error(`Missing generated handler for ${fixture.stem}`));
          }
          const directResponse = yield* Effect.promise(() =>
            handler.handler(new Request(`http://localhost/${fixture.stem}/readiness`)),
          );
          expect(directResponse.status).toBe(200);
          const directReadiness = yield* Schema.decodeUnknownEffect(MicroVerticalReadinessSchema)(
            yield* Effect.promise(() => directResponse.json()),
          );
          const clientReadiness = yield* Schema.decodeUnknownEffect(MicroVerticalReadinessSchema)(
            yield* getReadiness({ baseUrl: 'http://localhost' }),
          );
          expect(clientReadiness).toEqual(directReadiness);
          return clientReadiness;
        }),
      ),
      { concurrency: 'unbounded' },
    );

    expect(readinessValues[0]?.marker.appId).not.toBe(readinessValues[1]?.marker.appId);
    expect('kind' in (readinessValues[0]?.marker ?? {})).toBe(false);
    expect('schemaVersion' in (readinessValues[0]?.marker ?? {})).toBe(false);
    expect(readinessValues[0]?.checks).toEqual(readinessValues[1]?.checks);
    expect(readinessValues[0]?.status).toBe(readinessValues[1]?.status);
    expect(readinessValues[0]?.versionSkew).toBe(readinessValues[1]?.versionSkew);
  }),
);

it.live(
  'generated shared-contracts baseline template is lint-clean and type-safe',
  Effect.fn(function* governanceScenario17() {
    const scratchRoot = path.join(workspaceRoot, 'packages/shared-contracts/.scratch');
    yield* Effect.promise(() => mkdir(scratchRoot, { recursive: true }));
    const proofRoot = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(scratchRoot, 'generated-baseline-template-proof-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );

    const templateSource = yield* Effect.promise(() =>
      readFile(path.join(generatorRoot, 'templates/packages/shared-contracts-index.ts'), 'utf-8'),
    );
    const baselineEnd = templateSource.indexOf(
      'export type UltramodernPublicSitemapChangeFrequency',
    );
    expect(baselineEnd).not.toBe(-1);
    const generatedSource = templateSource.slice(0, baselineEnd);
    yield* writeText(proofRoot, generatedBaselineTemplateEntry, generatedSource);
    yield* writeJson(proofRoot, tsconfigFile, {
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: 'ES2022',
      },
      include: [generatedBaselineTemplateEntry],
    });
    const generatedFile = path.join(proofRoot, generatedBaselineTemplateEntry);
    runNode([path.join(workspaceRoot, 'node_modules/oxlint/bin/oxlint'), generatedFile], {
      cwd: workspaceRoot,
    });
    runNode(
      [
        path.join(workspaceRoot, 'node_modules/@typescript/native-preview/bin/tsc'),
        '-p',
        proofRoot,
      ],
      { cwd: workspaceRoot },
    );
  }),
);

it.live(
  'baseline imports require values even with comments after the type keyword',
  Effect.fn(function* governanceScenario18() {
    const contract = yield* Effect.promise(() =>
      readFile(path.join(workspaceRoot, `verticals/${partyId}/shared/api.ts`), 'utf-8'),
    );
    expect(yield* microVerticalApiBaselineViolation(partyId, contract)).toBe(undefined);
    for (const declaration of [
      'import type ',
      'import type/* comment */ ',
      'import /* comment */ ',
    ]) {
      const mutated = contract.replace(
        'import {\n  MicroVerticalBuildMarkerSchema,',
        `${declaration}{\n  MicroVerticalBuildMarkerSchema,`,
      );
      const violation = yield* microVerticalApiBaselineViolation(partyId, mutated);
      if (declaration.startsWith('import type')) {
        expect(violation ?? '').toMatch(/import exact baseline primitives/u);
      } else {
        expect(violation).toBe(undefined);
      }
    }
  }),
);

it.live(
  'repository checker respects custom readiness prefixes and diagnoses missing topology',
  Effect.fn(function* governanceScenario19() {
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-baseline-topology-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );

    const generatorModulePath = (name: string): string =>
      path.join(generatorRoot, `dist/esm-node/ultramodern-workspace/${name}.js`);
    const descriptors = yield* Schema.decodeUnknownEffect(DescriptorModuleSchema)(
      yield* Effect.promise(() => import(pathToFileURL(generatorModulePath('descriptors')).href)),
    );
    const shared = yield* Schema.decodeUnknownEffect(SharedApiGeneratorSchema)(
      yield* Effect.promise(
        () => import(pathToFileURL(generatorModulePath(generatedSharedApiModule)).href),
      ),
    );
    const service = yield* Schema.decodeUnknownEffect(ApiServiceGeneratorSchema)(
      yield* Effect.promise(
        () => import(pathToFileURL(generatorModulePath(generatedServiceModuleName)).href),
      ),
    );
    const app = {
      ...descriptors.createVerticalDescriptor(inventoryStockId, 4103),
      api: { prefix: warehouseApiPrefix, stem: warehouseItemsApiStem },
      exposes: {},
    };
    const ownerPath = `verticals/${inventoryStockId}`;
    const readinessContract = shared
      .createSharedApi('app', app)
      .replace(
        /(?<foundation>\.addHttpApi\(warehouseItemsFoundationApi\))[\s\S]*?(?=export const warehouseItemsOperationContexts)/u,
        '$<foundation>;\n\n',
      )
      .replace(
        /(?<declaration>export const warehouseItemsOperationContexts = \{)[\s\S]*?(?= {2}readiness:)/u,
        '$<declaration>\n',
      );
    yield* writeText(fixture, `${ownerPath}/shared/api.ts`, readinessContract);
    yield* writeText(
      fixture,
      `${ownerPath}/api/index.ts`,
      service.createApiServiceEntry('app', app, generatedSharedApiImport),
    );
    yield* writeText(
      fixture,
      `${ownerPath}/src/api/warehouse-client.ts`,
      'export const client = true;\n',
    );
    yield* writeJson(fixture, `${ownerPath}/package.json`, { exports: {} });
    const api = {
      basePath: '/warehouse-api/warehouse-items',
      bff: { prefix: warehouseApiPrefix, strictEffectApproach: true },
      readiness: { endpoint: '/warehouse-items/readiness' },
      runtime: 'effect',
      serverEntry: `${ownerPath}/api/index.ts`,
    };
    const vertical = { api, id: inventoryStockId, path: ownerPath };
    yield* writeJson(fixture, topologyReferencePath, { verticals: [vertical] });
    const check = (): string =>
      runNode([path.join(workspaceRoot, apiBoundaryCheckerPath)], {
        env: { ULTRAMODERN_WORKSPACE_ROOT: fixture },
      });
    expect(check()).toMatch(/UltraModern API boundary check passed/u);
    const cases = [
      { expected: /topology must declare this MicroVertical owner/u, verticals: [] },
      {
        expected: /topology must declare api\.basePath/u,
        verticals: [
          {
            ...vertical,
            api: {
              bff: api.bff,
              readiness: api.readiness,
              runtime: api.runtime,
              serverEntry: api.serverEntry,
            },
          },
        ],
      },
      {
        expected: /topology must declare api\.bff\.prefix/u,
        verticals: [{ ...vertical, api: { ...api, bff: { strictEffectApproach: true } } }],
      },
    ];
    for (const entry of cases) {
      yield* writeJson(fixture, topologyReferencePath, { verticals: entry.verticals });
      const result = spawnSync(
        process.execPath,
        [path.join(workspaceRoot, apiBoundaryCheckerPath)],
        {
          encoding: 'utf-8',
          env: { ULTRAMODERN_WORKSPACE_ROOT: fixture },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(entry.expected);
      expect(result.stderr).not.toMatch(/exact owner and API path metadata/u);
    }
  }),
);

it.live(
  'static validation rejects a MicroVertical root contract without readiness baseline',
  Effect.fn(function* governanceScenario20() {
    const contract = yield* Effect.promise(() =>
      readFile(path.join(workspaceRoot, `verticals/${partyId}/shared/api.ts`), 'utf-8'),
    );
    expect(yield* microVerticalApiBaselineViolation(partyId, contract)).toBe(undefined);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace("HttpApiEndpoint.get('readiness'", "HttpApiEndpoint.get('health'"),
        ),
      ),
    ).toMatch(/exact readiness endpoint/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace('...MicroVerticalReadinessSchema.fields,', '...Schema.Unknown.fields,'),
        ),
      ),
    ).toMatch(/shared readiness schema/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            'success: partyRegistryReadinessSchema',
            'success: Schema.String /* success: partyRegistryReadinessSchema */',
          ),
        ),
      ),
    ).toMatch(/exact readiness endpoint/u);
    const readinessEndpointDecoy =
      "HttpApiEndpoint.get('readiness', '/party-registry/readiness', { success: partyRegistryReadinessSchema })";
    const foundationComposition = '.addHttpApi(partyRegistryFoundationApi)';
    const sharedBaselineImport = `import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@app/shared-contracts';`;
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace("from '@app/shared-contracts';", "from '@app/copied-contracts';"),
        ),
      ),
    ).toMatch(/import exact baseline primitives from the shared contracts package/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            "from '@modern-js/plugin-bff/effect-client';",
            "from '@evil/fake-effect-client';",
          ),
        ),
      ),
    ).toMatch(/import exact Effect API primitives from the framework client package/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            sharedBaselineImport,
            `const MicroVerticalBuildMarkerSchema = Schema.Struct({ copied: Schema.String });
const MicroVerticalReadinessSchema = Schema.Struct({ copied: Schema.String });
const createMicroVerticalOperationContext = <Value>(value: Value): Value => value;`,
          ),
        ),
      ),
    ).toMatch(/import exact baseline primitives from the shared contracts package/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract
            .replace("HttpApiEndpoint.get('readiness'", "HttpApiEndpoint.get('health'")
            .replace(
              "HttpApi.make('PartyRegistryFoundationApi')",
              `HttpApi.make("${readinessEndpointDecoy}")`,
            ),
        ),
      ),
    ).toMatch(/exact readiness endpoint/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(foundationComposition, ''),
        ),
      ),
    ).toMatch(/explicitly compose its readiness foundation API/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            foundationComposition,
            `${foundationComposition}
  .pipe(() => HttpApi.make('DiscardedPartyRegistryApi'))`,
          ),
        ),
      ),
    ).toMatch(/explicitly compose its readiness foundation API/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            `  ),
);`,
            `  ),
).pipe(() => HttpApi.make('DiscardedPartyRegistryFoundationApi'));`,
          ),
        ),
      ),
    ).toMatch(/directly compose its exact readiness endpoint/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract
            .replace(foundationComposition, '')
            .replace(
              "HttpApi.make('PartyRegistryApi')",
              "HttpApi.make('.addHttpApi(partyRegistryFoundationApi)')",
            ),
        ),
      ),
    ).toMatch(/explicitly compose its readiness foundation API/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract
            .replaceAll('partyRegistryFoundationApi', 'renamedFoundationApi')
            .replace('.addHttpApi(renamedFoundationApi)', ''),
        ),
      ),
    ).toMatch(/directly compose its exact readiness endpoint/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace('...MicroVerticalBuildMarkerSchema.fields,', 'build: Schema.String,'),
        ),
      ),
    ).toMatch(/shared build marker schema/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            `export const partyRegistryReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: partyRegistryMarkerSchema,
});`,
            `export const partyRegistryReadinessSchema = (
  MicroVerticalReadinessSchema,
  Schema.Struct({ marker: partyRegistryMarkerSchema, status: Schema.String })
);`,
          ),
        ),
      ),
    ).toMatch(/consume the shared readiness schema/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            `export const partyRegistryReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: partyRegistryMarkerSchema,
});`,
            'export const partyRegistryReadinessSchema = MicroVerticalReadinessSchema;',
          ),
        ),
      ),
    ).toMatch(/consume the shared readiness schema/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            `export const partyRegistryApi = HttpApi.make('PartyRegistryApi')
  .addHttpApi(partyRegistryFoundationApi)`,
            `export const partyRegistryApi = HttpApi.make('PartyRegistryApi').pipe(
  (api) => (api.addHttpApi(partyRegistryFoundationApi), api),
)`,
          ),
        ),
      ),
    ).toMatch(/explicitly compose its readiness foundation API/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          `${contract.replace(
            'export const partyRegistryApi =',
            'export const partyRegistryApiDecoy =',
          )}\nexport const partyRegistryApi = HttpApi.make('PartyRegistryApi');\n`,
        ),
      ),
    ).toMatch(/explicitly compose its readiness foundation API/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          `${contract.replace(
            'export const partyRegistryFoundationApi =',
            'export const partyRegistryFoundationApiDecoy =',
          )}\nexport const partyRegistryFoundationApi = HttpApi.make('PartyRegistryFoundationApi');\n`,
        ),
      ),
    ).toMatch(/exact readiness endpoint/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          `${contract.replace(
            'export const partyRegistryApiContract =',
            'export const partyRegistryApiContractDecoy =',
          )}\nexport const partyRegistryApiContract = { ownerId: 'party-registry' };\n`,
        ),
      ),
    ).toMatch(/exact owner and API path metadata/u);

    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            '...MicroVerticalBuildMarkerSchema.fields,',
            '...MicroVerticalBuildMarkerSchema.fields,\n  build: Schema.Number,',
          ),
        ),
      ),
    ).toMatch(/without overriding shared fields/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            "const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));",
            'const AppIdSchema = Schema.Number;',
          ),
        ),
      ),
    ).toMatch(/shared build marker schema/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            '...MicroVerticalReadinessSchema.fields,',
            '...MicroVerticalReadinessSchema.fields,\n  status: Schema.String,',
          ),
        ),
      ),
    ).toMatch(/without overriding shared fields/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            "HttpApiGroup.make('foundation')",
            "HttpApiGroup.make('not-foundation')",
          ),
        ),
      ),
    ).toMatch(/exact readiness endpoint and foundation identity/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace("HttpApi.make('PartyRegistryApi')", "HttpApi.make('WrongApi')"),
        ),
      ),
    ).toMatch(/explicitly compose its readiness foundation API/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            'export const partyRegistryOperationContexts =',
            'export const renamedOperationContexts =',
          ),
        ),
      ),
    ).toMatch(/construct every operation with the shared context constructor/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace(
            "operationId: 'PartyRegistryApi:/reads/ares-lookup'",
            "operationId: 'WrongApi:unrelated'",
          ),
        ),
      ),
    ).toMatch(/construct every operation with the shared context constructor/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          contract.replace("routePath: '/reads/ares-lookup'", "routePath: '/not-an-endpoint'"),
        ),
      ),
    ).toMatch(/construct every operation with the shared context constructor/u);
    expect(
      violationText(
        yield* microVerticalApiBaselineViolation(
          partyId,
          `${contract.replace(
            `readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'PartyRegistryApi:/party-registry/readiness',
    routePath: '/party-registry/readiness',
  }),`,
            `readiness: {
    method: 'GET',
    operationId: 'PartyRegistryApi:/party-registry/readiness',
    routePath: '/party-registry/readiness',
  },`,
          )}
createMicroVerticalOperationContext({
  method: 'GET',
  operationId: 'PartyRegistryApi:/party-registry/readiness',
  routePath: '/party-registry/readiness',
});
`,
        ),
      ),
    ).toMatch(/construct every operation with the shared context constructor/u);

    for (const [label, mutated] of [
      ['missing apiPrefix', contract.replace("  apiPrefix: '/party-registry-api',\n", '')],
      [
        'missing basePath',
        contract.replace("  basePath: '/party-registry-api/party-registry',\n", ''),
      ],
      ['missing ownerId', contract.replace("  ownerId: 'party-registry',\n", '')],
      [
        'wrong apiPrefix',
        contract.replace("apiPrefix: '/party-registry-api'", "apiPrefix: '/evil-api'"),
      ],
      [
        'wrong basePath',
        contract.replace(
          "basePath: '/party-registry-api/party-registry'",
          "basePath: '/party-registry-api/evil'",
        ),
      ],
      ['wrong ownerId', contract.replace("ownerId: 'party-registry'", "ownerId: 'evil-owner'")],
      [
        'wrong readinessPath',
        contract.replace(
          "readinessPath: '/party-registry-api/party-registry/readiness'",
          "readinessPath: '/evil-prefix/party-registry/readiness'",
        ),
      ],
      [
        'coordinated topology drift',
        contract
          .replace("apiPrefix: '/party-registry-api'", "apiPrefix: '/evil-api'")
          .replace(
            "basePath: '/party-registry-api/party-registry'",
            "basePath: '/evil-api/party-registry'",
          )
          .replace(
            "readinessPath: '/party-registry-api/party-registry/readiness'",
            "readinessPath: '/evil-api/party-registry/readiness'",
          ),
      ],
      [
        'forbidden credential metadata',
        contract.replace(
          partyReadinessMetadataLine,
          `${partyReadinessMetadataLine}\n  credential: 'secret',`,
        ),
      ],
      [
        'forbidden credential path metadata',
        contract.replace(
          partyReadinessMetadataLine,
          `${partyReadinessMetadataLine}\n  credentialPath: '/party-registry-api/party-registry/secret',`,
        ),
      ],
      [
        'unknown path metadata',
        contract.replace(
          partyReadinessMetadataLine,
          `${partyReadinessMetadataLine}\n  unknownPath: '/party-registry-api/party-registry/unknown',`,
        ),
      ],
      [
        'spread metadata',
        contract.replace(
          'export const partyRegistryApiContract = {',
          'const copiedMetadata = {};\nexport const partyRegistryApiContract = {\n  ...copiedMetadata,',
        ),
      ],
    ] as const) {
      expect(
        violationText(yield* microVerticalApiBaselineViolation(partyId, mutated)),
        label,
      ).toMatch(/exact owner and API path metadata/u);
    }
  }),
);

it('MicroVertical baseline validation resolves an API stem independently from its directory', () => {
  expect(
    configuredMicroVerticalApiStem('verticals/inventory', [
      {
        api: { readiness: { endpoint: `/${warehouseItemsApiStem}/readiness` } },
        id: 'inventory',
        path: 'verticals/inventory',
      },
    ]),
  ).toBe(warehouseItemsApiStem);
});

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

const validateApp = (
  app: ApiOnlyAppFixture,
  applicationPublicUrl: string,
): Effect.Effect<typeof CloudflareEvidenceSchema.Type, unknown> =>
  Effect.gen(function* validateGeneratedCloudflareProof() {
    const output: unknown = yield* Effect.promise(() => {
      const framework = Schema.decodeUnknownSync(
        Schema.Struct({
          validateApp:
            callable<
              (
                fixture: ApiOnlyAppFixture,
                publicUrl: string,
              ) => Promise<typeof CloudflareEvidenceSchema.Type>
            >(),
        }),
      )(cloudflareProofModule);
      return framework.validateApp(app, applicationPublicUrl);
    });
    return yield* Schema.decodeUnknownEffect(CloudflareEvidenceSchema)(output);
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
      const inspection = yield* Schema.decodeUnknownEffect(ModuleFederationInspectionModuleSchema)(
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
      path.join(workspaceRoot, topologyReferencePath),
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
      path.join(workspaceRoot, topologyReferencePath),
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
globalThis.fetch = input => {
  const route = new URL(String(input)).pathname;
  appendFileSync(requestedPath, route + '\\n');
  if (route === manifestPath) {
    return Promise.resolve(Response.json({ metaData: { publicPath: publicUrl + '/' } }, { headers }));
  }
  if (route === readinessPath) {
    return Promise.resolve(Response.json({
      checks: { api: 'ready', moduleFederation: 'ready', ssr: 'ready' },
      marker: { build: buildMarker },
      status: 'ready',
    }, { headers }));
  }
  return Promise.resolve(Response.json({ error: 'No owner route or locale exists' }, { headers, status: 404 }));
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

it('proves generated Layer bindings and API aliases without accepting unused neighbors', () => {
  const source = governedLayerAliasFixture;
  const resolveImport = (specifier: string) =>
    specifier === generatedSharedApiImport
      ? {
          id: 'owner/shared/api.ts',
          resolveImport: unexpectedTopologyImport,
          source: governedApiModuleSource,
        }
      : unexpectedTopologyImport(specifier);
  expect(strictEffectRuntimeTopologyViolation(source, resolveImport)).toBe(undefined);
  for (const [before, after] of governedLayerAliasMutations) {
    expect(source.includes(before)).toBeTruthy();
    expect(
      strictEffectRuntimeTopologyViolation(source.replace(before, after), resolveImport),
    ).not.toBe(undefined);
  }
});

it.live(
  'accepts only the trusted final identity terminator in a governed API slot',
  Effect.fn(function* governanceScenario21() {
    const identityTerminator = '.pipe(identity)';
    const source = yield* Effect.promise(() =>
      readFile(path.join(workspaceRoot, 'verticals/party-registry/shared/api.ts'), 'utf-8'),
    );
    expect(source.includes(identityTerminator)).toBeTruthy();
    expect(yield* microVerticalApiBaselineViolation(partyId, source)).toBe(undefined);
    const mutations = [
      source.replace(
        "import { Brand, identity } from 'effect';",
        "import { Brand } from 'effect';\nimport { identity } from './counterfeit.ts';",
      ),
      source.replace(identityTerminator, '.pipe(unrelatedIdentity)'),
      source.replace(identityTerminator, '.pipe(() => HttpApi.make("DiscardedApi"))'),
      source.replace(identityTerminator, '.pipe(identity).addHttpApi(partyRegistryFoundationApi)'),
    ];
    for (const mutated of mutations) {
      expect(mutated).not.toBe(source);
      expect(violationText(yield* microVerticalApiBaselineViolation(partyId, mutated))).toMatch(
        /explicitly compose its readiness foundation API/u,
      );
    }
  }),
);

afterEach(() => {
  rs.restoreAllMocks();
});
