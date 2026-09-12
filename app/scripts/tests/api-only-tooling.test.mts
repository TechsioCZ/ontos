import { execFileSync, spawnSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type {
  emitFrameworkMicroVerticalReleaseEnvelope,
  emitNodeStagedReleaseEnvelope,
  verifyBuildOutputReleaseEnvelope,
  verifyNodeReleaseEnvelopeStaging,
} from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import type { defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import { Cause, Effect, Predicate, Schema } from 'effect';
import { describe, afterEach, expect, it, rs } from 'effect-rstest';
import { build as bundleSource, transform } from 'esbuild';

import { MicroVerticalReadinessSchema } from '@modern-js/bff-effect/microvertical-api';
import { hasValidGovernedHttpCompositionRoot } from '../generated-governed-http-boundary.mts';
import {
  hasGeneratedOperationGatewayContract,
  hasGeneratedOperationPrincipalContract,
} from '../generated-module-api-boundary.mts';
import {
  configuredMicroVerticalApiStem,
  microVerticalApiBaselineViolation as microVerticalApiBaselineViolationForFile,
} from '@modern-js/code-tools/microvertical-api-boundary';
import type { MicroVerticalApiBaselineExpectation } from '@modern-js/code-tools/microvertical-api-boundary';
import { moduleFederationBridgeViolation } from '../module-federation-bridge-boundary.mts';
import { strictEffectRuntimeTopologyViolation } from '../ultramodern-api-boundary-rules.mts';

const EXPECTED_PROOF_VALUE = 'Expected a defined proof value';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

const modernConfigFile = 'modern.config.ts';
const packageJsonFile = 'package.json';
const ultramodernConfigFile = '.modernjs/ultramodern.json';

const partyId = 'party-registry';

const partyDirectory = 'verticals/party-registry';
const partySharedApiPath = `${partyDirectory}/shared/api.ts`;
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
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
const generatedClientContractImport = '../../shared/api.ts';

const generatedSharedApiModule = 'api/shared';

const frameworkBaselinePackage = '@modern-js/bff-effect/microvertical-api';
const frameworkBaselinePackageDirectory = path.dirname(
  createRequire(import.meta.url).resolve('@modern-js/bff-effect/package.json'),
);
const effectClientPackage = '@modern-js/bff-effect/effect-client';

const apiBoundaryCheckerPath = 'scripts/check-ultramodern-api-boundaries.mts';

const topologyReferencePath = 'topology/reference-topology.json';

const checkoutId = 'checkout';

const checkoutApiPrefix = '/checkout-api';

const inventoryStockId = 'inventory-stock';

const warehouseItemsApiStem = 'warehouse-items';

const warehouseApiPrefix = '/warehouse-api';

const partyReadinessMetadataLine = "  readinessPath: '/party-registry-api/party-registry/readiness',";

const microVerticalApiBaselineViolation = Effect.fn(function* inspectMicroVerticalBaseline(
  stem: string,
  source: string,
  expectation?: Partial<MicroVerticalApiBaselineExpectation>,
) {
  const ownerShared = path.join(workspaceRoot, `verticals/${stem}/shared`);
  const ownerExists = existsSync(ownerShared);
  const fixture = yield* Effect.acquireRelease(
    Effect.promise(() =>
      ownerExists
        ? mkdtemp(path.join(ownerShared, '.api-fixture-')).then(async (directory) => {
            await rm(directory, { force: true, recursive: true });
            return ownerShared;
          })
        : mkdtemp(path.join(workspaceRoot, 'node_modules/.ontos-microvertical-api-test-')),
    ),
    (directory) =>
      Effect.promise(() =>
        directory === ownerShared ? Promise.resolve() : rm(directory, { force: true, recursive: true }),
      ),
  );
  const contractPath = path.join(fixture, fixture === ownerShared ? `.api-fixture-${randomUUID()}.ts` : 'api.ts');
  yield* Effect.acquireRelease(
    Effect.promise(() => writeFile(contractPath, source).then(() => contractPath)),
    () => Effect.promise(() => rm(contractPath, { force: true })),
  );
  return microVerticalApiBaselineViolationForFile(stem, contractPath, {
    additionalPaths: {},
    apiPrefix: `/${stem}-api`,
    baselinePackage: frameworkBaselinePackage,
    baselinePackageDirectory: frameworkBaselinePackageDirectory,
    basePath: `/${stem}-api/${stem}`,
    effectClientPackage,
    ownerId: stem,
    readinessPath: `/${stem}-api/${stem}/readiness`,
    ...expectation,
  });
});

const unexpectedTopologyImport = (specifier: string): never => {
  throw new Error(`Unexpected strict-topology import: ${specifier}`);
};

const generatorRoot = await realpath(path.join(workspaceRoot, 'node_modules/@modern-js/ultramodern-create'));

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
    api: Schema.Struct({
      ...IdentitySchema.fields,
      surface: Schema.Literal('api'),
    }),
    ui: Schema.Struct({
      ...IdentitySchema.fields,
      surface: Schema.Literal('ui'),
    }),
  }),
});

interface ReleaseFramework {
  readonly emitFrameworkMicroVerticalReleaseEnvelope: typeof emitFrameworkMicroVerticalReleaseEnvelope;
  readonly emitNodeStagedReleaseEnvelope: typeof emitNodeStagedReleaseEnvelope;
  readonly verifyBuildOutputReleaseEnvelope: typeof verifyBuildOutputReleaseEnvelope;
  readonly verifyNodeReleaseEnvelopeStaging: typeof verifyNodeReleaseEnvelopeStaging;
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
interface ApiGeneratorOptions {
  readonly scope: string;
}
type CreateSharedApi = (app: ApiGeneratorFixture, options: ApiGeneratorOptions) => string;
type CreateApiClient = (app: WorkspaceAppFixture, contractImportPath: string, options: ApiGeneratorOptions) => string;

type CreateApiServiceEntry = (
  app: ApiGeneratorFixture,
  contractImportPath: string,
  options: ApiGeneratorOptions,
) => string;

type CreateGeneratedHttpHandler = () => GeneratedHttpHandler;

type GeneratedReadiness = typeof MicroVerticalReadinessSchema.Type;

type GeneratedReadinessEffect = Effect.Effect<GeneratedReadiness, unknown>;

type GetGeneratedReadiness = (options?: { readonly baseUrl?: string | URL }) => GeneratedReadinessEffect;

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

type DefinePluginConstructor = new (definitions: Readonly<Record<string, string>>) => RspackPluginFixture;

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
  readonly run: (onComplete: (error: Error | null, stats?: CompilerStatsFixture | null) => void) => void;
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
  emitFrameworkMicroVerticalReleaseEnvelope: callable<ReleaseFramework['emitFrameworkMicroVerticalReleaseEnvelope']>(),
  emitNodeStagedReleaseEnvelope: callable<ReleaseFramework['emitNodeStagedReleaseEnvelope']>(),
  verifyBuildOutputReleaseEnvelope: callable<ReleaseFramework['verifyBuildOutputReleaseEnvelope']>(),
  verifyNodeReleaseEnvelopeStaging: callable<ReleaseFramework['verifyNodeReleaseEnvelopeStaging']>(),
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

const ComponentModuleSchema = Schema.Struct({
  createLayout: callable<CreateLayout>(),
});

const FederationConfigModuleSchema = Schema.Struct({
  createAppModernConfig: callable<CreateAppModernConfig>(),
  createBackendModuleFederationConfig: callable<CreateBackendModuleFederationConfig>(),
});

const BuildModuleGeneratorSchema = Schema.Struct({
  createUltramodernBuildModule: callable<CreateUltramodernBuildModule>(),
});

const SharedApiGeneratorSchema = Schema.Struct({
  createSharedApi: callable<CreateSharedApi>(),
});

const ApiClientGeneratorSchema = Schema.Struct({
  createApiClient: callable<CreateApiClient>(),
});

const ApiServiceGeneratorSchema = Schema.Struct({
  createApiServiceEntry: callable<CreateApiServiceEntry>(),
});

const GeneratedApiRuntimeModuleSchema = Schema.Struct({
  default: Schema.Struct({
    createHandler: callable<CreateGeneratedHttpHandler>(),
  }),
});

const CloudflareEvidenceSchema = Schema.Struct({
  assertions: Schema.Array(Schema.Struct({ status: Schema.String, type: Schema.String })),
});

const ModuleFederationValidationModuleSchema = Schema.Struct({
  validateModuleFederationTypes: callable<ValidateModuleFederationTypes>(),
});

const ModuleFederationValidationResultSchema = Schema.Struct({
  hostOnlyAppCount: Schema.Number,
});

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

const CompiledReaderSchema = Schema.Struct({
  allowedOrigins: Schema.Array(Schema.String),
});

const PackageJsonSchema = Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String),
});

const TopologySchema = Schema.Struct({
  verticals: Schema.Array(
    Schema.Struct({
      backendFederation: Schema.Struct({
        exposes: Schema.Record(Schema.String, Schema.Struct({ contract: Schema.String, openapi: Schema.String })),
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
    const emitFrameworkMicroVerticalReleaseEnvelope = framework.emitFrameworkMicroVerticalReleaseEnvelope.bind(source);
    const emitNodeStagedReleaseEnvelope = framework.emitNodeStagedReleaseEnvelope.bind(source);
    const verifyBuildOutputReleaseEnvelope = framework.verifyBuildOutputReleaseEnvelope.bind(source);
    const verifyNodeReleaseEnvelopeStaging = framework.verifyNodeReleaseEnvelopeStaging.bind(source);
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
    yield* Effect.promise(() => mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true }));
    yield* Effect.promise(() => writeFile(path.join(root, logicalPath), JSON.stringify(value)));
  });

const writeText = (root: string, logicalPath: string, value: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* scenario4() {
    yield* Effect.promise(() => mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true }));
    yield* Effect.promise(() => writeFile(path.join(root, logicalPath), value));
  });

const runNode = (
  argumentsList: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): string =>
  execFileSync(process.execPath, argumentsList, {
    cwd: options.cwd,
    encoding: 'utf-8',
    env: options.env,
  } satisfies ExecFileSyncOptionsWithStringEncoding);

const appToolsRequire = createRequire(
  await realpath(path.join(workspaceRoot, 'verticals/party-registry/node_modules/@modern-js/app-tools/package.json')),
);
const releaseFrameworkRoot = path.resolve(
  path.dirname(appToolsRequire.resolve('@modern-js/app-tools-extensions/release-envelope/framework-output')),
  '../..',
);

it.live(
  'MicroVertical templates use the shared strict Effect BFF assembly primitive',
  Effect.fn(function* governanceScenario1() {
    const apiServiceModule: unknown = yield* Effect.promise(
      () => import(pathToFileURL(path.join(generatorRoot, generatedApiServiceModule)).href),
    );
    const apiServiceGenerator = yield* Schema.decodeUnknownEffect(ApiServiceGeneratorModuleSchema)(apiServiceModule);
    const packageModule: unknown = yield* Effect.promise(
      () => import(pathToFileURL(path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/package-json.js')).href),
    );
    const packageGenerator = yield* Schema.decodeUnknownEffect(PackageGeneratorModuleSchema)(packageModule);
    const source = apiServiceGenerator.createApiServiceEntry(
      {
        api: {
          consumedBy: [],
          prefix: generatedApiPrefix,
          stem: generatedFixtureId,
        },
        id: generatedFixtureId,
      },
      generatedSharedApiImport,
      { scope: 'fixture' },
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
    expect(sharedContractsPackage.exports['./server/effect-bff-runtime']).toBe('./src/effect-bff-runtime.ts');
    expect(sharedContractsPackage.dependencies['@modern-js/plugin-bff']).toBe('3.8.2');
    expect(sharedContractsPackage.dependencies.effect).toBe('4.0.0-rc.112');
    expect(
      yield* Effect.promise(() =>
        readFile(path.join(generatorRoot, 'templates/packages/effect-bff-runtime.ts'), 'utf-8'),
      ),
    ).toMatch(/export \{ assembleEffectBffRuntime \} from '@modern-js\/bff-effect\/assembly'/u);
  }),
);

const expressionRuntimeFixture = `
import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { fixtureApi } from '../shared/api.ts';
const groupLayer = HttpApiBuilder.group(fixtureApi, 'fixture', handlers => handlers.handle('reachable', () => undefined));
const handlers = Layer.mergeAll(groupLayer);
export const makeRuntime = () => assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
const apiRuntime = makeRuntime();
export default apiRuntime;
`;

const adversarialStrictRuntimeSources = [
  ...(
    [
      ['handlers: handlers });', 'handlers: handlers }) && fakeRuntime;'],
      [
        'const apiRuntime = makeRuntime();',
        'function dead() { const apiRuntime = makeRuntime(); } const apiRuntime = fakeRuntime;',
      ],
      ['export default apiRuntime;', 'export default fakeRuntime;'],
      ['() => assembleEffectBffRuntime', '(assembleEffectBffRuntime) => assembleEffectBffRuntime'],
    ] as const
  ).map(([before, after]) => expressionRuntimeFixture.replace(before, after)),

  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const groupLayer = HttpApiBuilder.group(fixtureApi, 'fixture', (handlers) => handlers);
    const handlers = Layer.mergeAll(groupLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers }) && fakeRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    function fake(Layer: { mergeAll: typeof Layer.mergeAll }): unknown {
      const handlers = Layer.mergeAll(groupLayer);
      return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    }
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    try { runFixture(); } catch ({ Layer }) {
      const handlers = Layer.mergeAll(groupLayer);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    }
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer) satisfies Layer.Layer<any>
      ? fakeHandlers
      : fakeHandlers;
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer);
    const proof = assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    function unrelated() { const proof = fakeRuntime; return proof; }
    export default fakeRuntime;
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { groupLayer, fakeHandlers } from './group.ts';
    const handlers = Layer.mergeAll(groupLayer.pipe(() => fakeHandlers));
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    const HttpApiBuilder = { group: () => fakeHandlers };
    const groupLayer = HttpApiBuilder.group(fixtureApi, 'fixture', () => fakeHandlers);
    const handlers = Layer.mergeAll(groupLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    export { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
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
    import { HttpApiBuilder, Layer, SomeOtherExport as HttpRouter } from '@modern-js/bff-effect/effect-edge';
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
    import { defineEffectBff, HttpApi, Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { defineEffectBff, HttpApi, Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    import { arbitraryLayer } from 'anything';
    const handlers = Layer.mergeAll(arbitraryLayer);
    export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
  `,
] as const;

const validAdversarialStrictRuntimeSources = [
  expressionRuntimeFixture,
  `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
    import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
    import { fixtureApi } from '../shared/api.ts';
    export const fixtureGroupLayer = HttpApiBuilder.group(
      fixtureApi,
      'fixture',
      (handlers) => handlers.handle('reachable', () => undefined),
    );
  `;
  const aggregateModule = `
    import { Layer } from '@modern-js/bff-effect/effect-edge';
    import { fixtureGroupLayer } from './fixture-group.ts';
    export const fixtureHandlers = Layer.mergeAll(fixtureGroupLayer);
  `;
  const importedHandlers = `
    import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
    import { Layer } from '@modern-js/bff-effect/effect-edge';
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
  expect(strictEffectRuntimeTopologyViolation(importedHandlers, resolveImportedHandlers)).toBe(undefined);
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
  expect(strictEffectRuntimeTopologyViolation(importedHandlers, resolveForeignHandlers) ?? '').toMatch(
    /explicitly composed Layer/u,
  );
  expect(
    strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime as assemble } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
    expect(strictEffectRuntimeTopologyViolation(source), `valid adversarial source ${index + 1}`).toBe(undefined);
  }
  for (const source of adversarialStrictRuntimeSources) {
    expect(strictEffectRuntimeTopologyViolation(source)).not.toBe(undefined);
  }
  for (const [label, source, expected] of [
    [
      'defineEffectBff with a typed layer annotation',
      `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer: Layer.Layer<never> = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
      );
      export default defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      /server-only shared Effect BFF assembly helper/u,
    ],
    [
      'handlers composed only inside an unreachable function',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      import { groupLayer } from './group.ts';
      function decoy() {
        const handlers = Layer.mergeAll(groupLayer);
        return handlers;
      }
      const handlers = Layer.empty;
      export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      /explicitly composed Layer/u,
    ],
    [
      'runtime assembled behind an unreachable branch',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
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
    `,
      /return or export the assembled strict Effect BFF runtime/u,
    ],
    [
      'defineEffectBff with an empty layer',
      `
      import { defineEffectBff, Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = Layer.empty;
      export default defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      /server-only shared Effect BFF assembly helper/u,
    ],
    [
      'defineEffectBff layer piped to an empty layer',
      `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(() => Layer.empty);
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      /server-only shared Effect BFF assembly helper/u,
    ],
    [
      'defineEffectBff layer piped past its provided handlers',
      `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
        () => Layer.empty,
      );
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      /server-only shared Effect BFF assembly helper/u,
    ],
    [
      'locally defined defineEffectBff',
      `
      import { fixtureApi } from '../shared/api.ts';
      const defineEffectBff = () => undefined;
      defineEffectBff({ api: fixtureApi, layer: fakeLayer });
    `,
      /server-only shared Effect BFF assembly helper/u,
    ],
    [
      'defineEffectBff call inside a string literal',
      `
      import { fixtureApi } from '../shared/api.ts';
      const decoy = "defineEffectBff({ api: fixtureApi, layer: fakeLayer })";
    `,
      /server-only shared Effect BFF assembly helper/u,
    ],
    [
      'locally defined assembleEffectBffRuntime',
      `
      import { fixtureApi } from '../shared/api.ts';
      const unrelated = Layer.mergeAll(groupLayer);
      const assembleEffectBffRuntime = () => undefined;
      assembleEffectBffRuntime({ api: fixtureApi, handlers: unrelated });
    `,
      /server-only shared Effect BFF assembly helper/u,
    ],
    [
      'assembly of a foreign API binding',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const unrelated = Layer.mergeAll(groupLayer);
      assembleEffectBffRuntime({ api: otherApi, handlers: unrelated });
    `,
      /API imported from \.\.\/shared\/api\.ts/u,
    ],
    [
      'handlers aliased from an uncomposed binding',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const unrelated = Layer.mergeAll(groupLayer);
      const handlers = unrelated;
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      /explicitly composed Layer/u,
    ],
    [
      'handlers piped to an empty layer',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer).pipe(() => Layer.empty);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      /explicitly composed Layer/u,
    ],
    [
      'transport piped to an empty layer',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const groupLayer = HttpApiBuilder.group(
        fixtureApi,
        'fixture',
        (handlers) => handlers.handle('reachable', () => undefined),
      );
      const handlers = Layer.mergeAll(groupLayer);
      const transport = Layer.mergeAll(transportLayer).pipe(() => Layer.empty);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers, transport: transport });
    `,
      /transport/u,
    ],
    [
      'handlers built by an unknown Layer member',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.thisDoesNotExist(groupLayer);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      /explicitly composed Layer/u,
    ],
    [
      'assembly helper shadowed by a function parameter',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer);
      function fake(assembleEffectBffRuntime) {
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      /unshadowed/u,
    ],
    [
      'assembly helper shadowed by a block destructuring',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      {
        const { assembleEffectBffRuntime } = fakeRuntime;
        const handlers = Layer.mergeAll(groupLayer);
        assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      /unshadowed/u,
    ],
    [
      'Layer shadowed by a catch binding',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      try {
        runFixture();
      } catch (Layer) {
        const handlers = Layer.mergeAll(groupLayer);
        assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      /unshadowed/u,
    ],
    [
      'Layer shadowed by an object method parameter',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixture = {
        create(Layer) {
          const handlers = Layer.mergeAll(groupLayer);
          return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
        },
      };
    `,
      /unshadowed/u,
    ],
    [
      'Layer shadowed by a function parameter',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      function fake(Layer) {
        const handlers = Layer.mergeAll(groupLayer);
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      /unshadowed/u,
    ],
    [
      'imports declared only inside a template literal',
      `
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      const fakeImport = \`
        import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
        import { fixtureApi } from '../shared/api.ts';
      \`;
      const fixtureApi = {};
      const handlers = Layer.mergeAll(groupLayer);
      const assembleEffectBffRuntime = (input) => input;
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      /server-only shared Effect BFF assembly helper/u,
    ],
    [
      'handlers assigned from a string literal',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fakeHandlers = "Layer.mergeAll(groupLayer)";
      assembleEffectBffRuntime({ api: fixtureApi, handlers: fakeHandlers });
    `,
      /explicitly composed Layer/u,
    ],
  ] as const) {
    expect(strictEffectRuntimeTopologyViolation(source) ?? '', label).toMatch(expected);
  }
});

const strictBoundaryReports = (
  module: typeof StrictEffectApiBoundaryRuleModuleSchema.Type,
  filename: string,
  source: string,
): readonly string[] => {
  const messages: string[] = [];
  module
    .createStrictEffectApiBoundariesRule()
    .create({
      filename,
      getSourceCode: () => ({ getText: () => source, text: source }),
      report: ({ message }) => {
        messages.push(message);
      },
    })
    .Program({});
  return messages;
};

const reportsAssemblyViolation = (messages: readonly string[]): boolean =>
  messages.some((message) =>
    /server-only shared Effect BFF assembly helper|explicitly composed handler Layer|Generated API entries must export defineEffectBff|Generated API entries must implement handlers through HttpApiBuilder/u.test(
      message,
    ),
  );

it.live(
  'published lint validators reject comment, string, and local strict-root spoofs',
  Effect.fn(function* mergedScenario2() {
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
    const apiServiceGenerator = Schema.decodeUnknownSync(ApiServiceGeneratorModuleSchema)(apiServiceSource);
    const generatedSource = apiServiceGenerator.createApiServiceEntry(
      {
        api: {
          consumedBy: [],
          prefix: generatedApiPrefix,
          stem: generatedFixtureId,
        },
        id: generatedFixtureId,
      },
      generatedSharedApiImport,
      { scope: 'app' },
    );
    const generatedRpcSource = apiServiceGenerator.createApiServiceEntry(
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
      { scope: 'app' },
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
      strictEffectRuntimeTopologyViolation(generatedRpcSource, (specifier) =>
        specifier === generatedSharedRpcImport
          ? {
              id: 'inventory-stock/shared/rpc.ts',
              resolveImport: unexpectedTopologyImport,
              source: 'export const inventoryStockRpcGroup = { toLayer: () => undefined };',
            }
          : unexpectedTopologyImport(specifier),
      ) ?? '',
    ).toMatch(/server-only shared Effect BFF assembly helper/u);
    const lintRoot = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-strict-api-lint-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );

    const fixtureRoot = path.join(lintRoot, 'verticals/fixture');
    const fixtureApiEntryPath = path.join(fixtureRoot, apiIndexFile);
    yield* Effect.promise(() => mkdir(path.join(fixtureRoot, 'api'), { recursive: true }));
    yield* Effect.promise(() => mkdir(path.join(fixtureRoot, 'shared'), { recursive: true }));
    yield* Effect.promise(() => writeFile(path.join(fixtureRoot, sharedApiFile), governedApiModuleSource));
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
      export { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
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
    yield* Effect.promise(() => writeFile(path.join(foreignRoot, sharedApiFile), `${fixtureApiModuleSource}\n`));
    yield* Effect.promise(() =>
      writeFile(
        path.join(foreignRoot, 'api/group.ts'),
        `
      import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
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
    yield* Effect.promise(() => mkdir(path.join(generatedRoot, 'api'), { recursive: true }));
    yield* Effect.promise(() => mkdir(path.join(generatedRoot, 'shared'), { recursive: true }));
    yield* Effect.promise(() =>
      writeFile(path.join(generatedRoot, sharedApiFile), 'export const inventoryStockApi = {};\n'),
    );
    yield* Effect.promise(() => writeFile(path.join(generatedRoot, 'shared/rpc.ts'), generatedRpcContractSource));
    const invalidSources = [
      ...adversarialStrictRuntimeSources,
      ...governedLayerAliasMutations.map(([before, after]) => governedLayerAliasFixture.replace(before, after)),
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      import { shadowedGroup } from './shadowed-group.ts';
      const handlers = Layer.mergeAll(shadowedGroup);
      export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      import { foreignGroup } from '../../foreign/api/group.ts';
      const handlers = Layer.mergeAll(foreignGroup);
      export default assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      `
      import { fake as defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(Layer.provide(fixtureHandlers));
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      `
      import { defineEffectBff, Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = Layer.empty;
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      `
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const defineEffectBff = () => undefined;
      const fixtureLayer = Layer.empty;
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      `
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const decoy = "defineEffectBff({ api: fixtureApi, layer: Layer.empty })";
      // defineEffectBff({ api: fixtureApi, layer: Layer.empty });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fakeHandlers = "Layer.mergeAll(groupLayer)";
      assembleEffectBffRuntime({ api: fixtureApi, handlers: fakeHandlers });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer);
      function fake(assembleEffectBffRuntime) {
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      function fake(Layer) {
        const handlers = Layer.mergeAll(groupLayer);
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.thisDoesNotExist(groupLayer);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
        () => Layer.empty,
      );
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer).pipe(() => Layer.empty);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer);
      const transport = Layer.mergeAll(transportLayer).pipe(() => Layer.empty);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers, transport: transport });
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      {
        const { assembleEffectBffRuntime } = fakeRuntime;
        const handlers = Layer.mergeAll(groupLayer);
        assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `,
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/bff-effect/effect-edge';
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
      import { Layer } from '@modern-js/bff-effect/effect-edge';
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
      import { Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `,
      `
      import { Layer } from '@modern-js/bff-effect/effect-edge';
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
        Effect.fn(function* mergedScenario1(moduleFormat) {
          const imported: unknown = yield* Effect.promise(
            () => import(pathToFileURL(path.join(codeToolsRoot, moduleFormat)).href),
          );
          return {
            module: Schema.decodeUnknownSync(StrictEffectApiBoundaryRuleModuleSchema)(imported),
            moduleFormat,
          };
        }),
      ),
      // CJS require(ESM) cannot race the same Babel module's async import.
      { concurrency: 1 },
    );
    for (const { module, moduleFormat } of modules) {
      for (const source of invalidSources) {
        expect(
          reportsAssemblyViolation(strictBoundaryReports(module, fixtureApiEntryPath, source)),
          `${moduleFormat} accepted a fake strict runtime root`,
        ).toBeTruthy();
      }
      const legacySource = `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer: Layer.Layer<never> = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
      );
      export default defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `;
      expect(
        reportsAssemblyViolation(strictBoundaryReports(module, fixtureApiEntryPath, legacySource)),
        `${moduleFormat} accepted a legacy runtime root without the shared assembly helper`,
      ).toBe(true);
      const generatedMessages = strictBoundaryReports(module, path.join(generatedRoot, apiIndexFile), generatedSource);
      expect(
        reportsAssemblyViolation(generatedMessages),
        `${moduleFormat} rejected exact generated helper output: ${generatedMessages.join(' | ')}`,
      ).toBe(false);
      const generatedRpcMessages = strictBoundaryReports(
        module,
        path.join(generatedRoot, apiIndexFile),
        generatedRpcSource,
      );
      expect(
        generatedRpcMessages.some((message) =>
          /server-only shared Effect BFF assembly helper|explicitly composed handler Layer|\.\.\/shared\/api\.ts/u.test(
            message,
          ),
        ),
        `${moduleFormat} rejected exact generated RPC output: ${generatedRpcMessages.join(' | ')}`,
      ).toBe(false);
      for (const source of [...validAdversarialStrictRuntimeSources, governedLayerAliasFixture]) {
        const messages = strictBoundaryReports(module, fixtureApiEntryPath, source);
        expect(
          reportsAssemblyViolation(messages),
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
    const apiServiceGenerator = yield* Schema.decodeUnknownEffect(ApiServiceGeneratorModuleSchema)(apiServiceSource);
    const sharedApiSource: unknown = yield* Effect.promise(
      () => import(pathToFileURL(path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/api/shared.js')).href),
    );
    const sharedApiGenerator = yield* Schema.decodeUnknownEffect(SharedApiGeneratorModuleSchema)(sharedApiSource);
    const descriptor = {
      api: {
        consumedBy: [],
        prefix: generatedApiPrefix,
        stem: generatedFixtureId,
      },
      id: generatedFixtureId,
    } as const;
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(workspaceRoot, 'verticals/party-registry/.generated-runtime-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    yield* writeText(
      fixture,
      apiIndexFile,
      apiServiceGenerator.createApiServiceEntry(descriptor, generatedSharedApiImport, {
        scope: 'app',
      }),
    );
    yield* writeText(fixture, sharedApiFile, sharedApiGenerator.createSharedApi(descriptor, { scope: 'app' }));
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

const releaseFixture = Effect.fn(function* scenario5(moduleFormat: 'cjs' | 'esm' | 'esm-node' = 'esm-node') {
  const extension = moduleFormat === 'cjs' ? 'js' : 'mjs';
  const releaseFramework = yield* loadReleaseFramework(
    path.join(releaseFrameworkRoot, moduleFormat, `release-envelope/framework-output.${extension}`),
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
  const putJson = <Value extends object>(logicalPath: string, value: Value): Effect.Effect<void, unknown> =>
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
      index: {
        assets: [`https://assets.example.test/app/${compiledUiAssetPath}`],
      },
    },
  });
  yield* putJson('route.json', { routes: [{ bundle: ssrBundlePath }] });
  yield* putJson(packageJsonFile, { type: 'module' });
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
      yield* Effect.promise(
        async () =>
          await releaseFramework.emitFrameworkMicroVerticalReleaseEnvelope({
            apiOnly: false,
            distDirectory: root,
            target: 'node',
          }),
      ),
    );
  });
  return {
    artifact,
    emit,
    framework: releaseFramework,
    manifest,
    putJson,
    putText,
    root,
  };
});

it.live(
  'empty MF producers retain complete build and Node staged release evidence in every framework format',
  Effect.fn(function* scenario10() {
    yield* Effect.all(
      (['cjs', 'esm', 'esm-node'] as const).map(
        Effect.fn(function* scenario11(moduleFormat) {
          const fixture = yield* releaseFixture(moduleFormat);
          const envelope = yield* fixture.emit();
          expect(envelope.surfaces.uiClient.includes(compiledUiAssetPath)).toBe(true);
          expect(envelope.surfaces.ssr).toEqual([ssrBundlePath]);
          expect(envelope.surfaces.apiBackend).toEqual([apiBundlePath]);
          yield* Effect.promise(
            async () => await fixture.framework.verifyBuildOutputReleaseEnvelope(fixture.root, 'node'),
          );
          const staged = yield* Schema.decodeUnknownEffect(ReleaseEnvelopeSchema)(
            yield* Effect.promise(
              async () =>
                await fixture.framework.emitNodeStagedReleaseEnvelope({
                  distDirectory: fixture.root,
                  outputDirectory: fixture.root,
                }),
            ),
          );
          expect(staged.surfaces.uiClient.includes(compiledUiAssetPath)).toBe(true);
          yield* Effect.promise(
            async () =>
              await fixture.framework.verifyNodeReleaseEnvelopeStaging({
                outputDirectory: fixture.root,
              }),
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
          return yield* Effect.promise(
            async () => await fixture.framework.verifyBuildOutputReleaseEnvelope(fixture.root, 'node'),
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
      (['cjs', 'esm', 'esm-node'] as const).map(
        Effect.fn(function* scenario14(moduleFormat) {
          const fixture = yield* releaseFixture(moduleFormat);
          fixture.manifest.metaData.publicPath = 'auto';
          yield* fixture.putJson(mfManifestFile, fixture.manifest);
          yield* fixture.putJson(routesManifestFile, {
            routeAssets: { index: { assets: [`/${compiledUiAssetPath}`] } },
          });
          const envelope = yield* fixture.emit();
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
      {
        metaData: baseline.manifest.metaData,
        remotes: baseline.manifest.remotes,
      },
      {
        exposes: baseline.manifest.exposes,
        metaData: baseline.manifest.metaData,
      },
      {
        ...baseline.manifest,
        metaData: {
          ...baseline.manifest.metaData,
          remoteEntry: { name: '', path: '' },
        },
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
        deliveryUnit: {
          ...fixture.artifact.deliveryUnit,
          sourceRevision: 'b'.repeat(40),
        },
      },
    });
    const failureCause6 = yield* Effect.flip(Effect.sandbox(fixture.emit()));
    expect(String(Cause.squash(failureCause6))).toMatch(/must match/u);
    const workspaceArtifact = {
      ...fixture.artifact,
      deliveryUnit: {
        ...fixture.artifact.deliveryUnit,
        sourceRevision: 'workspace',
      },
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

const GlobalVarsSchema = Schema.Struct({
  ULTRAMODERN_SHELL_ORIGIN: Schema.String,
});

const evaluatePartyBuildGlobalVars = Effect.fn(function* scenario20(shellOrigin: string) {
  const temporaryRoot = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-party-config-')));
  return yield* Effect.gen(function* useResource1() {
    const harnessPath = path.join(temporaryRoot, 'read-config.mjs');
    const configSource = yield* Effect.promise(() =>
      readFile(path.join(workspaceRoot, 'verticals/party-registry/modern.config.ts'), 'utf-8'),
    );
    const effectModuleUrl = pathToFileURL(require.resolve('effect', { paths: [workspaceRoot] })).href;
    const { code } = yield* Effect.promise(() =>
      transform(configSource, {
        define: {
          'import.meta.url': JSON.stringify(
            pathToFileURL(path.join(workspaceRoot, 'verticals/party-registry/modern.config.ts')).href,
          ),
        },
        format: 'cjs',
        loader: 'ts',
      }),
    );
    yield* Effect.promise(() =>
      writeFile(
        harnessPath,
        `import * as effect from ${JSON.stringify(effectModuleUrl)};
import * as sharedBuild from ${JSON.stringify(pathToFileURL(path.join(workspaceRoot, 'packages/shared-contracts/tooling/modern-config.ts')).href)};
import { runInNewContext } from 'node:vm';
import * as nodeUrl from 'node:url';
import * as nodePath from 'node:path';
const framework = {
  ...sharedBuild,
  appTools: () => ({}),
  ultramodernAppTools: () => ({}),
  ultramodernReleaseEnvelopePlugin: () => ({}),
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
  URL,
  require: specifier => specifier === 'effect' ? effect : specifier === 'node:url' ? nodeUrl : specifier === 'node:path' ? nodePath : framework,
});
process.stdout.write(JSON.stringify(module.exports.default.source.globalVars));
`,
      ),
    );
    const output = runNode([harnessPath]);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GlobalVarsSchema))(output);
  }).pipe(Effect.ensuring(Effect.promise(() => rm(temporaryRoot, { force: true, recursive: true }))));
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
    const partyRoot = path.join(workspaceRoot, partyDirectory);
    const source = yield* Effect.promise(() => readFile(path.join(partyRoot, 'api/index.ts'), 'utf-8'));
    const reader =
      /(?<reader>declare const ULTRAMODERN_SHELL_ORIGIN[\s\S]+?const shellOrigin = readShellOrigin\(\);)/u.exec(source)
        ?.groups?.reader;
    expect(reader, 'compile the actual API origin-reader boundary').not.toBe(undefined);
    const appToolsPath = require.resolve('@modern-js/app-tools-extensions/config', {
      paths: [partyRoot],
    });
    const rsbuildPath = require.resolve('@rsbuild/core', {
      paths: [appToolsPath],
    });
    const rspackModule: unknown = require(require.resolve('@rspack/core', { paths: [rsbuildPath] }));
    const rspackFixture = yield* Schema.decodeUnknownEffect(RspackModuleFixtureSchema)(rspackModule);
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
        Object.fromEntries(Object.entries(globalVars).map(([key, value]) => [key, JSON.stringify(value)])),
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
        output: {
          filename: 'reader.cjs',
          library: { type: 'commonjs2' },
          path: temporaryRoot,
        },
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
        const errorText = stats.toString.bind(statsSource)({
          all: false,
          errors: true,
        });
        expect(hasErrors, errorText).toBe(false);
      }).pipe(Effect.ensuring(Effect.promise(() => closeCompiler())));
      const compiledReaderModule: unknown = require(path.join(temporaryRoot, 'reader.cjs'));
      const compiledReader = yield* Schema.decodeUnknownEffect(CompiledReaderSchema)(compiledReaderModule);
      expect([...compiledReader.allowedOrigins]).toEqual([shellOrigin]);
    }).pipe(Effect.ensuring(Effect.promise(() => rm(temporaryRoot, { force: true, recursive: true }))));
  }),
);

const ScaffoldSemanticKindSchema = Schema.Literals(['backend', 'layout', 'service']);
type ScaffoldSemanticKind = typeof ScaffoldSemanticKindSchema.Type;
const scaffoldSemanticKinds = new Map<string, ScaffoldSemanticKind>([
  ['backend-federation.config.ts', 'backend'],
  ['src/routes/layout.tsx', 'layout'],
]);

// Evaluate only controlled scaffolds with inert dependency adapters in a separate Node process.
// No application server, deployment, real plugin or environment file is loaded by this harness.
const evaluateScaffoldSemantics = Effect.fn(function* evaluateScaffoldSemantics(
  source: string,
  kind: ScaffoldSemanticKind,
) {
  const scratchRoot = path.join(workspaceRoot, '.scratch');
  yield* Effect.promise(() => mkdir(scratchRoot, { recursive: true }));
  const fixture = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(scratchRoot, 'scaffold-semantics-'))),
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  );
  {
    const effectUrl = pathToFileURL(require.resolve('effect')).href;
    const { code } = yield* Effect.promise(() =>
      transform(source, {
        define: {
          'import.meta.url': JSON.stringify('file:///fixture/config.ts'),
        },
        format: 'cjs',
        jsxFactory: 'element',
        loader: kind === 'layout' ? 'tsx' : 'ts',
      }),
    );
    const harnessPath = path.join(fixture, 'evaluate.mjs');
    yield* Effect.promise(() =>
      writeFile(
        harnessPath,
        `
import * as effect from ${JSON.stringify(effectUrl)};
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const kind = ${JSON.stringify(kind)};
const pluginNames = ['appTools', 'ultramodernAppTools', 'bffPlugin', 'i18nPlugin', 'tanstackRouterPlugin', 'moduleFederationPlugin', 'pluginTailwindcss', 'ultramodernReleaseEnvelopePlugin'];
const framework = {
  ...Object.fromEntries(pluginNames.map(name => [name, () => ({ name })])),
  builtinModules: [], createRequire: () => name => ({ version: name === 'effect/package.json' ? '4.0.0-rc.112' : '3.9.0-ultramodern.2' }),
  defineConfig: config => config, presetUltramodern: config => config,
  createModuleFederationConfig: config => config,
  getBuildConfigEnvironment: () => undefined, ultramodernLocalisedUrls: {},
};
const module = { exports: {} };
const spans = [];
const contexts = Object.fromEntries(['readiness', 'list', 'get', 'create'].map(name => [name, { method: 'GET', operationId: name, routePath: '/' + name, source: 'server', traceId: 'trace-' + name }]));
const fixtureEffect = { succeed: () => ({ pipe: (...steps) => steps.reduce((value, step) => step(value), {}) }), withSpan: (name, options) => value => { spans.push({ name, attributes: options.attributes }); return value; } };
const fixtureHandlers = { handle: (_name, callback) => { callback({ query: {}, params: { id: 'starter-inventory-stock' }, payload: { title: 'Fixture' } }); return fixtureHandlers; } };
runInNewContext(${JSON.stringify(code)}, {
  module, exports: module.exports, URL,
  element: (type, props, ...children) => ({ type, props, children }),
  require: specifier => {
    if (kind === 'service') {
      if (specifier.endsWith('/server/effect-bff-runtime')) return { assembleEffectBffRuntime: value => value };
      if (specifier === '@modern-js/bff-effect/effect-edge') return { Effect: fixtureEffect, Layer: { mergeAll: (...layers) => layers }, HttpApiBuilder: { group: (_api, _group, configure) => configure(fixtureHandlers) } };
      if (specifier === '../shared/api.ts') return { inventoryStockApi: {}, inventoryStockOperationContexts: contexts };
      if (specifier === '../shared/ultramodern-build.ts') return { ultramodernApiMarker: {} };
    }
    if (specifier === 'effect') return effect;
    if (specifier === 'effect/Schema') return effect.Schema;
    if (specifier === 'node:url') return { fileURLToPath };
    if (specifier === 'node:path') return path;
    if (specifier === './package.json') return { dependencies: { '@module-federation/runtime': '2.9.0' } };
    if (specifier === '@modern-js/plugin-tanstack/runtime') return { Outlet: 'Outlet' };
    if (specifier === './index.css') return {};
    return framework;
  },
});
let evidence = module.exports;
if (kind === 'layout') evidence = evidence.default();
if (kind === 'backend') evidence = evidence.default;
if (kind === 'service') evidence = spans;
process.stdout.write(JSON.stringify(evidence));
`,
      ),
    );
    return runNode([harnessPath]);
  }
});

const evaluatedInfrastructureSource = Effect.fn(function* mergedScenario1(
  fileName: string,
  source: string,
  cloudflare: boolean,
  injection: Readonly<Record<string, string>>,
  contractOnly = false,
) {
  const partyRoot = path.join(workspaceRoot, partyDirectory);
  const result = yield* Effect.promise(() =>
    bundleSource({
      alias: {
        '@modern-js/runtime-extensions/build-identity': createRequire(path.join(partyRoot, fileName)).resolve(
          '@modern-js/runtime-extensions/build-identity',
        ),
      },
      bundle: true,
      define: {
        'import.meta.resolve': '__resolve',
        'import.meta.url': JSON.stringify(pathToFileURL(path.join(partyRoot, fileName)).href),
      },
      external: ['./src/routes/ultramodern-route-metadata'],
      format: 'cjs',
      packages: 'external',
      platform: 'node',
      stdin: {
        contents: source,
        loader: 'ts',
        resolveDir: path.dirname(path.join(partyRoot, fileName)),
      },
      write: false,
    }),
  );
  const code = result.outputFiles[0]?.text;
  expect(code).toBeTruthy();
  if (!code) {
    throw new Error(EXPECTED_PROOF_VALUE);
  }
  const effectUrl = pathToFileURL(require.resolve('effect')).href;
  const buildIdentityUrl = pathToFileURL(
    createRequire(path.join(partyRoot, fileName)).resolve('@app/shared-contracts/ultramodern-build'),
  ).href;
  return runNode([
    '--input-type=module',
    '-e',
    `
import * as effect from ${JSON.stringify(effectUrl)};
import * as buildIdentity from ${JSON.stringify(buildIdentityUrl)};
import * as nodeModule from 'node:module';
import * as nodePath from 'node:path';
import * as nodeUrl from 'node:url';
import { runInNewContext } from 'node:vm';
const environment = {
  MODERNJS_DEPLOY: ${JSON.stringify(cloudflare ? 'cloudflare' : 'node')},
  ULTRAMODERN_MF_DEV_ORIGIN: 'https://shell.example.test',
  ULTRAMODERN_PUBLIC_URL_PARTY_REGISTRY: 'https://party.example.test',
  ZE_CI_TOKEN: 'proof-token',
};
const plugin = name => options => ({ name, options });
const framework = {
  appTools: plugin('appTools'), ultramodernAppTools: plugin('ultramodernAppTools'), bffPlugin: plugin('bff'), i18nPlugin: plugin('i18n'),
  ultramodernReleaseEnvelopePlugin: plugin('ultramodernReleaseEnvelopePlugin'),
  moduleFederationPlugin: plugin('moduleFederation'), pluginTailwindcss: plugin('tailwind'),
  tanstackRouterPlugin: plugin('tanstack'), withZephyr: plugin('zephyr'),
  defineConfig: value => value, presetUltramodern: (value, identity) => ({ ...value, identity }),
  getBuildConfigEnvironment: name => environment[name],
  withBuildConfigEnvironment: (_name, _value, configuration) => configuration,
  ultramodernLocalisedUrls: {},
};
const moduleShim = { ...nodeModule, createRequire: () => Object.assign(() => ({}), { resolve: name => '/dependencies/' + name }) };
const module = { exports: {} };
runInNewContext(${JSON.stringify(code)}, {
  exports: module.exports, module, URL,
  ...${JSON.stringify(injection)},
  __resolve: name => 'file:///dependencies/' + name,
  require: name => ({ effect, '@app/shared-contracts/ultramodern-build': buildIdentity, 'node:module': moduleShim, 'node:path': nodePath, 'node:url': nodeUrl }[name] ?? framework),
});
const configuration = module.exports.default;
const observations = {};
if (configuration?.tools) {
  const chainValues = [];
  const output = { uniqueName: name => { chainValues.push(name); return output; }, chunkLoadingGlobal: name => { chainValues.push(name); return output; } };
  configuration.tools.bundlerChain?.({ output });
  observations.chain = chainValues;
  observations.plugins = [];
  for (const entry of configuration.plugins ?? []) entry.setup?.({ modifyRspackConfig: value => observations.plugins.push(value) });
  const plugins = {
    DefinePlugin: class { constructor(definitions) { this.definitions = definitions; } },
    NormalModuleReplacementPlugin: class { constructor(pattern, replace) {
      this.pattern = pattern;
      this.results = ['./handler.ts', './handler.ts?loaderId=x&retain=false', './other.ts?modern-bff-runtime-source'].map(request => {
        const resource = { context: ${JSON.stringify(path.join(partyRoot, 'api'))}, request }; replace(resource); return resource;
      });
    } },
  };
  observations.rspack = ['client', 'workerSSR'].map(name => {
    const config = { resolve: {}, externals: [], plugins: [], node: {} };
    configuration.tools.rspack?.(config, { environment: { name }, rspack: plugins });
    const externalResults = [];
    for (const external of config.externals) for (const request of ['node:fs', 'fs', 'cloudflare:sockets', 'unrelated']) {
      external({ request, dependencyType: 'commonjs' }, (...args) => externalResults.push(args));
    }
    return { config, externalResults };
  });
}
const normalize = (_key, value) => {
  if (typeof value === 'function') return '[Function]';
  if (Object.prototype.toString.call(value) === '[object RegExp]') return String(value);
  return value;
};
const evidence = ${contractOnly} && configuration ? {
  bff: configuration.bff,
  builderPlugins: configuration.builderPlugins,
  deploy: configuration.deploy,
  identity: configuration.identity,
  html: configuration.html,
  output: configuration.output,
  buildCache: configuration.performance?.buildCache,
  plugins: configuration.plugins.map(entry => entry.name),
  devAssetPrefix: configuration.dev?.assetPrefix,
  devHeaders: configuration.dev?.server?.headers ?? configuration.tools?.devServer?.headers,
  port: configuration.server?.port,
  alias: configuration.source?.alias,
  siteUrl: configuration.source?.globalVars?.ULTRAMODERN_SITE_URL,
  mainEntryName: configuration.source?.mainEntryName,
  chain: observations.chain,
  pluginsBehavior: observations.plugins,
} : { exported: module.exports, observations };
process.stdout.write(JSON.stringify(evidence, normalize));
`,
  ]);
});

it.live(
  'all published scaffold formats retain Party infrastructure behavior and source parity',
  Effect.fn(function* mergedScenario4() {
    const canonicalModule: unknown = yield* Effect.promise(
      () => import(pathToFileURL(publishedGeneratorModulePath('esm-node')('module-federation/config')).href),
    );
    const canonical = Schema.decodeUnknownSync(FederationConfigModuleSchema)(canonicalModule);
    yield* Effect.all(
      ['esm', 'esm-node', 'cjs'].map(
        Effect.fn(function* mergedScenario3(moduleFormat) {
          const descriptorPath = publishedGeneratorModulePath(moduleFormat)('descriptors');
          const descriptorSource: unknown =
            moduleFormat === 'cjs'
              ? require(descriptorPath)
              : yield* Effect.promise(() => import(pathToFileURL(descriptorPath).href));
          const descriptorModule = Schema.decodeUnknownSync(DescriptorModuleSchema)(descriptorSource);
          const componentPath = publishedGeneratorModulePath(moduleFormat)('demo-components');
          const componentSource: unknown =
            moduleFormat === 'cjs'
              ? require(componentPath)
              : yield* Effect.promise(() => import(pathToFileURL(componentPath).href));
          const componentModule = Schema.decodeUnknownSync(ComponentModuleSchema)(componentSource);
          const federationPath = publishedGeneratorModulePath(moduleFormat)('module-federation/config');
          const federationSource: unknown =
            moduleFormat === 'cjs'
              ? require(federationPath)
              : yield* Effect.promise(() => import(pathToFileURL(federationPath).href));
          const federationModule = Schema.decodeUnknownSync(FederationConfigModuleSchema)(federationSource);
          const buildModulePath = publishedGeneratorModulePath(moduleFormat)('module-federation/reexport-module');
          const buildModuleSource: unknown =
            moduleFormat === 'cjs'
              ? require(buildModulePath)
              : yield* Effect.promise(() => import(pathToFileURL(buildModulePath).href));
          const buildModule = Schema.decodeUnknownSync(BuildModuleGeneratorSchema)(buildModuleSource);
          const createVerticalDescriptor = descriptorModule.createVerticalDescriptor.bind(descriptorSource);
          const createLayout = componentModule.createLayout.bind(componentSource);
          const createAppModernConfig = federationModule.createAppModernConfig.bind(federationSource);
          const createBackendModuleFederationConfig =
            federationModule.createBackendModuleFederationConfig.bind(federationSource);
          const createUltramodernBuildModule = buildModule.createUltramodernBuildModule.bind(buildModuleSource);
          const descriptor: unknown = createVerticalDescriptor(partyId, 4102);
          Schema.asserts(WorkspaceAppFixtureSchema, descriptor);
          const app = { ...descriptor, exposes: {} };
          const generated = {
            'backend-federation.config.ts': Schema.decodeUnknownSync(Schema.String)(
              createBackendModuleFederationConfig(app),
            ),
            [buildMarkerFile]: Schema.decodeUnknownSync(Schema.String)(createUltramodernBuildModule('app', app)),
            [modernConfigFile]: Schema.decodeUnknownSync(Schema.String)(createAppModernConfig('app', app)),
            'src/routes/layout.tsx': Schema.decodeUnknownSync(Schema.String)(createLayout(app.id)),
          };
          yield* Effect.all(
            Object.entries(generated).map(
              Effect.fn(function* mergedScenario2([fileName, source]) {
                const actual = yield* Effect.promise(() =>
                  readFile(path.join(workspaceRoot, partyDirectory, fileName), 'utf-8'),
                );
                if (fileName === modernConfigFile || fileName === 'shared/ultramodern-build.ts') {
                  const injections: Readonly<Record<string, string>>[] = [
                    {},
                    {
                      ULTRAMODERN_BUILD_MARKER: 'executed-build',
                      ULTRAMODERN_SOURCE_REVISION: 'a'.repeat(40),
                    },
                  ];
                  const evaluations: {
                    cloudflare: boolean;
                    injection: Readonly<Record<string, string>>;
                  }[] = [];
                  for (const cloudflare of [false, true]) {
                    for (const injection of injections) {
                      evaluations.push({ cloudflare, injection });
                    }
                  }
                  yield* Effect.forEach(
                    evaluations,
                    Effect.fn(function* evaluateInfrastructureInjection({ cloudflare, injection }) {
                      if (fileName === modernConfigFile) {
                        const canonicalSource = Schema.decodeUnknownSync(Schema.String)(
                          canonical.createAppModernConfig('app', app),
                        );
                        expect(
                          yield* evaluatedInfrastructureSource(fileName, source, cloudflare, injection),
                          `${moduleFormat} must retain complete published config behavior`,
                        ).toBe(yield* evaluatedInfrastructureSource(fileName, canonicalSource, cloudflare, injection));
                      }
                      const [expected, evaluated] = yield* Effect.all(
                        [
                          evaluatedInfrastructureSource(
                            fileName,
                            source,
                            cloudflare,
                            injection,
                            fileName === modernConfigFile,
                          ),
                          evaluatedInfrastructureSource(
                            fileName,
                            actual,
                            cloudflare,
                            injection,
                            fileName === modernConfigFile,
                          ),
                        ],
                        { concurrency: 'unbounded' },
                      );
                      const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
                      expect(
                        decode(expected),
                        `${moduleFormat}: ${fileName} must preserve evaluated configuration, build identity and plugin behavior`,
                      ).toEqual(decode(evaluated));
                    }),
                    { concurrency: 'unbounded' },
                  );
                  return;
                }
                const kind = scaffoldSemanticKinds.get(fileName);
                expect(kind, `Unknown scaffold ${fileName}`).toBeDefined();
                if (kind === undefined) {
                  throw new Error(`Unknown scaffold ${fileName}`);
                }
                expect(
                  yield* evaluateScaffoldSemantics(source, kind),
                  `${moduleFormat}: ${fileName} must preserve typed runtime, ownership and release gates`,
                ).toBe(yield* evaluateScaffoldSemantics(actual, kind));
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
  'two generated MicroVertical root contracts execute invariant readiness endpoints',
  Effect.fn(function* governanceScenario12() {
    const proofRoot = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(workspaceRoot, `verticals/${partyId}/.generated-api-baseline-`))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );

    const descriptorSource: unknown = yield* Effect.promise(
      () => import(pathToFileURL(path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/descriptors.js')).href),
    );
    const sharedApiSource: unknown = yield* Effect.promise(
      () => import(pathToFileURL(path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/api/shared.js')).href),
    );
    const apiServiceSource: unknown = yield* Effect.promise(
      () => import(pathToFileURL(path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/api/service.js')).href),
    );
    const apiClientSource: unknown = yield* Effect.promise(
      () => import(pathToFileURL(path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/api/client.js')).href),
    );
    const descriptorModule = yield* Schema.decodeUnknownEffect(DescriptorModuleSchema)(descriptorSource);
    const sharedApiModule = yield* Schema.decodeUnknownEffect(SharedApiGeneratorSchema)(sharedApiSource);
    const apiServiceModule = yield* Schema.decodeUnknownEffect(ApiServiceGeneratorSchema)(apiServiceSource);
    const apiClientModule = yield* Schema.decodeUnknownEffect(ApiClientGeneratorSchema)(apiClientSource);
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
            api: {
              ...descriptor.api,
              prefix: fixture.prefix,
              stem: fixture.stem,
            },
            exposes: {},
          };
          const contract = sharedApiModule.createSharedApi(generatedDescriptor, { scope: 'app' });
          const basePath = `${fixture.prefix}/${fixture.stem}`;
          expect(
            yield* microVerticalApiBaselineViolation(fixture.stem, contract, {
              additionalPaths: fixture.stem === checkoutId ? { checkoutCartPath: `${basePath}/cart` } : {},
              apiPrefix: fixture.prefix,
              baselinePackage: frameworkBaselinePackage,
              baselinePackageDirectory: frameworkBaselinePackageDirectory,
              basePath,
              effectClientPackage,
              ownerId: fixture.id,
              readinessPath: `${basePath}/readiness`,
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
            apiServiceModule.createApiServiceEntry(generatedDescriptor, generatedSharedApiImport, {
              scope: 'app',
            }),
          );
          const clientEntryPath = `src/api/${fixture.id}-client.ts`;
          yield* writeText(
            ownerRoot,
            clientEntryPath,
            apiClientModule.createApiClient(generatedDescriptor, generatedClientContractImport, {
              scope: 'app',
            }),
          );
          yield* writeJson(ownerRoot, packageJsonFile, { type: 'module' });
          yield* writeJson(ownerRoot, tsconfigFile, {
            compilerOptions: {
              allowImportingTsExtensions: true,
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              noEmit: true,
              skipLibCheck: false,
              strict: true,
              target: 'ES2023',
            },
            include: ['api/**/*.ts', 'shared/**/*.ts', 'src/**/*.ts'],
          });
          runNode(
            [
              path.join(path.dirname(require.resolve('@typescript/native-preview/package.json')), 'bin/tsgo'),
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
          const generatedModule = yield* Schema.decodeUnknownEffect(GeneratedApiRuntimeModuleSchema)(
            generatedModuleSource,
          );
          const generatedClient = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(
            generatedClientSource,
          );
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

    const [firstReadiness, secondReadiness] = readinessValues;
    expect(firstReadiness).toBeDefined();
    expect(secondReadiness).toBeDefined();
    if (firstReadiness === undefined || secondReadiness === undefined) {
      throw new Error('Expected both generated readiness results');
    }
    expect(firstReadiness.marker.appId).not.toBe(secondReadiness.marker.appId);
    expect('kind' in firstReadiness.marker).toBe(false);
    expect('schemaVersion' in firstReadiness.marker).toBe(false);
    expect(firstReadiness.checks).toEqual(secondReadiness.checks);
    expect(firstReadiness.status).toBe(secondReadiness.status);
    expect(firstReadiness.versionSkew).toBe(secondReadiness.versionSkew);
  }),
);

it.live(
  'baseline imports require values even with comments after the type keyword',
  Effect.fn(function* governanceScenario18() {
    const contract = yield* Effect.promise(() =>
      readFile(path.join(workspaceRoot, `verticals/${partyId}/shared/api.ts`), 'utf-8'),
    );
    expect(yield* microVerticalApiBaselineViolation(partyId, contract)).toBe(undefined);
    for (const declaration of ['import type ', 'import type/* comment */ ', 'import /* comment */ ']) {
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
      yield* Effect.promise(() => import(pathToFileURL(generatorModulePath(generatedSharedApiModule)).href)),
    );
    const service = yield* Schema.decodeUnknownEffect(ApiServiceGeneratorSchema)(
      yield* Effect.promise(() => import(pathToFileURL(generatorModulePath(generatedServiceModuleName)).href)),
    );
    const app = {
      ...descriptors.createVerticalDescriptor(inventoryStockId, 4103),
      api: { prefix: warehouseApiPrefix, stem: warehouseItemsApiStem },
      exposes: {},
    };
    const ownerPath = `verticals/${inventoryStockId}`;
    const readinessContract = shared
      .createSharedApi(app, { scope: 'app' })
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
      service.createApiServiceEntry(app, generatedSharedApiImport, {
        scope: 'app',
      }),
    );
    yield* writeText(fixture, `${ownerPath}/src/api/warehouse-client.ts`, 'export const client = true;\n');
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
      {
        expected: /topology must declare this MicroVertical owner/u,
        verticals: [],
      },
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
      yield* writeJson(fixture, topologyReferencePath, {
        verticals: entry.verticals,
      });
      const result = spawnSync(process.execPath, [path.join(workspaceRoot, apiBoundaryCheckerPath)], {
        encoding: 'utf-8',
        env: { ULTRAMODERN_WORKSPACE_ROOT: fixture },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(entry.expected);
      expect(result.stderr).not.toMatch(/exact owner and API path metadata/u);
    }
  }),
);

it.live(
  'static validation rejects a MicroVertical root contract without readiness baseline',
  Effect.fn(function* mergedScenario1() {
    const contract = yield* Effect.promise(() =>
      readFile(path.join(workspaceRoot, `verticals/${partyId}/shared/api.ts`), 'utf-8'),
    );
    expect(yield* microVerticalApiBaselineViolation(partyId, contract)).toBe(undefined);
    const readinessEndpointDecoy =
      "HttpApiEndpoint.get('readiness', '/party-registry/readiness', { success: partyRegistryReadinessSchema })";
    const foundationComposition = '.addHttpApi(partyRegistryFoundationApi)';
    const sharedBaselineImport = `import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';`;
    for (const [label, mutated, expected] of [
      [
        'renamed readiness endpoint',
        contract.replace("HttpApiEndpoint.get('readiness'", "HttpApiEndpoint.get('health'"),
        /exact readiness endpoint/u,
      ],
      [
        'foreign readiness schema fields',
        contract.replace('...MicroVerticalReadinessSchema.fields,', '...Schema.Unknown.fields,'),
        /shared readiness schema/u,
      ],
      [
        'readiness success schema commented out',
        contract.replace(
          'success: partyRegistryReadinessSchema',
          'success: Schema.String /* success: partyRegistryReadinessSchema */',
        ),
        /exact readiness endpoint/u,
      ],
      [
        'baseline primitives imported from a copied package',
        contract.replace("from '@modern-js/bff-effect/microvertical-api';", "from '@evil/copied-microvertical-api';"),
        /import exact baseline primitives from the framework baseline package/u,
      ],
      [
        'Effect API primitives imported from a foreign client',
        contract.replace("from '@modern-js/bff-effect/effect-client';", "from '@evil/fake-effect-client';"),
        /import exact Effect API primitives from the framework client package/u,
      ],
      [
        'baseline primitives redefined locally',
        contract.replace(
          sharedBaselineImport,
          `const MicroVerticalBuildMarkerSchema = Schema.Struct({ copied: Schema.String });
const MicroVerticalReadinessSchema = Schema.Struct({ copied: Schema.String });
const createMicroVerticalOperationContext = <Value>(value: Value): Value => value;`,
        ),
        /import exact baseline primitives from the framework baseline package/u,
      ],
      [
        'renamed readiness endpoint with a decoy API name',
        contract
          .replace("HttpApiEndpoint.get('readiness'", "HttpApiEndpoint.get('health'")
          .replace("HttpApi.make('PartyRegistryFoundationApi')", `HttpApi.make("${readinessEndpointDecoy}")`),
        /exact readiness endpoint/u,
      ],
      [
        'missing foundation API composition',
        contract.replace(foundationComposition, ''),
        /explicitly compose its readiness foundation API/u,
      ],
      [
        'foundation composition discarded by a pipe',
        contract.replace(
          foundationComposition,
          `${foundationComposition}
  .pipe(() => HttpApi.make('DiscardedPartyRegistryApi'))`,
        ),
        /explicitly compose its readiness foundation API/u,
      ],
      [
        'foundation endpoint discarded by a pipe',
        contract.replace(
          /(?<foundation>export const partyRegistryFoundationApi = [\s\S]*?);/u,
          "$<foundation>.pipe(() => HttpApi.make('DiscardedPartyRegistryFoundationApi'));",
        ),
        /directly compose its exact readiness endpoint/u,
      ],
      [
        'missing foundation composition with a decoy API name',
        contract
          .replace(foundationComposition, '')
          .replace("HttpApi.make('PartyRegistryApi')", "HttpApi.make('.addHttpApi(partyRegistryFoundationApi)')"),
        /explicitly compose its readiness foundation API/u,
      ],
      [
        'renamed foundation API without composition',
        contract
          .replaceAll('partyRegistryFoundationApi', 'renamedFoundationApi')
          .replace('.addHttpApi(renamedFoundationApi)', ''),
        /directly compose its exact readiness endpoint/u,
      ],
      [
        'hand-forked build marker fields',
        contract.replace('...MicroVerticalBuildMarkerSchema.fields,', 'build: Schema.String,'),
        /shared build marker schema/u,
      ],
      [
        'readiness schema built by a sequence expression',
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
        /consume the shared readiness schema/u,
      ],
      [
        'readiness schema aliased to the shared schema',
        contract.replace(
          `export const partyRegistryReadinessSchema = Schema.Struct({
  ...MicroVerticalReadinessSchema.fields,
  marker: partyRegistryMarkerSchema,
});`,
          'export const partyRegistryReadinessSchema = MicroVerticalReadinessSchema;',
        ),
        /consume the shared readiness schema/u,
      ],
      [
        'foundation composed inside a pipe callback',
        contract.replace(
          `export const partyRegistryApi = HttpApi.make('PartyRegistryApi')
  .addHttpApi(partyRegistryFoundationApi)`,
          `export const partyRegistryApi = HttpApi.make('PartyRegistryApi').pipe(
  (api) => (api.addHttpApi(partyRegistryFoundationApi), api),
)`,
        ),
        /explicitly compose its readiness foundation API/u,
      ],
      [
        'decoy API declaration shadowed by an uncomposed API',
        `${contract.replace(
          'export const partyRegistryApi =',
          'export const partyRegistryApiDecoy =',
        )}\nexport const partyRegistryApi = HttpApi.make('PartyRegistryApi');\n`,
        /explicitly compose its readiness foundation API/u,
      ],
      [
        'decoy foundation API declaration without a readiness endpoint',
        `${contract.replace(
          'export const partyRegistryFoundationApi =',
          'export const partyRegistryFoundationApiDecoy =',
        )}\nexport const partyRegistryFoundationApi = HttpApi.make('PartyRegistryFoundationApi');\n`,
        /exact readiness endpoint/u,
      ],
      [
        'decoy contract declaration without path metadata',
        `${contract.replace(
          'export const partyRegistryApiContract =',
          'export const partyRegistryApiContractDecoy =',
        )}\nexport const partyRegistryApiContract = { ownerId: 'party-registry' };\n`,
        /exact owner and API path metadata/u,
      ],
      [
        'build marker overriding a shared field',
        contract.replace(
          '...MicroVerticalBuildMarkerSchema.fields,',
          '...MicroVerticalBuildMarkerSchema.fields,\n  build: Schema.Number,',
        ),
        /without overriding shared fields/u,
      ],
      [
        'foreign AppId schema',
        contract.replace(
          "const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));",
          'const AppIdSchema = Schema.Number;',
        ),
        /shared build marker schema/u,
      ],
      [
        'readiness schema overriding a shared field',
        contract.replace(
          '...MicroVerticalReadinessSchema.fields,',
          '...MicroVerticalReadinessSchema.fields,\n  status: Schema.String,',
        ),
        /without overriding shared fields/u,
      ],
      [
        'renamed foundation group',
        contract.replace("HttpApiGroup.make('foundation')", "HttpApiGroup.make('not-foundation')"),
        /exact readiness endpoint and foundation identity/u,
      ],
      [
        'renamed root API',
        contract.replace("HttpApi.make('PartyRegistryApi')", "HttpApi.make('WrongApi')"),
        /explicitly compose its readiness foundation API/u,
      ],
      [
        'renamed operation contexts',
        contract.replace('export const partyRegistryOperationContexts =', 'export const renamedOperationContexts ='),
        /construct every operation with the shared context constructor/u,
      ],
      [
        'foreign operation id',
        contract.replace("operationId: 'PartyRegistryApi:/reads/ares-lookup'", "operationId: 'WrongApi:unrelated'"),
        /construct every operation with the shared context constructor/u,
      ],
      [
        'foreign route path',
        contract.replace("routePath: '/reads/ares-lookup'", "routePath: '/not-an-endpoint'"),
        /construct every operation with the shared context constructor/u,
      ],
      [
        'readiness context built without the shared constructor',
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
        /construct every operation with the shared context constructor/u,
      ],
      [
        'missing apiPrefix',
        contract.replace("  apiPrefix: '/party-registry-api',\n", ''),
        /exact owner and API path metadata/u,
      ],
      [
        'missing basePath',
        contract.replace("  basePath: '/party-registry-api/party-registry',\n", ''),
        /exact owner and API path metadata/u,
      ],
      ['missing ownerId', contract.replace("  ownerId: 'party-registry',\n", ''), /exact owner and API path metadata/u],
      [
        'wrong apiPrefix',
        contract.replace("apiPrefix: '/party-registry-api'", "apiPrefix: '/evil-api'"),
        /exact owner and API path metadata/u,
      ],
      [
        'wrong basePath',
        contract.replace("basePath: '/party-registry-api/party-registry'", "basePath: '/party-registry-api/evil'"),
        /exact owner and API path metadata/u,
      ],
      [
        'wrong ownerId',
        contract.replace("ownerId: 'party-registry'", "ownerId: 'evil-owner'"),
        /exact owner and API path metadata/u,
      ],
      [
        'wrong readinessPath',
        contract.replace(
          "readinessPath: '/party-registry-api/party-registry/readiness'",
          "readinessPath: '/evil-prefix/party-registry/readiness'",
        ),
        /exact owner and API path metadata/u,
      ],
      [
        'coordinated topology drift',
        contract
          .replace("apiPrefix: '/party-registry-api'", "apiPrefix: '/evil-api'")
          .replace("basePath: '/party-registry-api/party-registry'", "basePath: '/evil-api/party-registry'")
          .replace(
            "readinessPath: '/party-registry-api/party-registry/readiness'",
            "readinessPath: '/evil-api/party-registry/readiness'",
          ),
        /exact owner and API path metadata/u,
      ],
      [
        'forbidden credential metadata',
        contract.replace(partyReadinessMetadataLine, `${partyReadinessMetadataLine}\n  credential: 'secret',`),
        /exact owner and API path metadata/u,
      ],
      [
        'forbidden credential path metadata',
        contract.replace(
          partyReadinessMetadataLine,
          `${partyReadinessMetadataLine}\n  credentialPath: '/party-registry-api/party-registry/secret',`,
        ),
        /exact owner and API path metadata/u,
      ],
      [
        'unknown path metadata',
        contract.replace(
          partyReadinessMetadataLine,
          `${partyReadinessMetadataLine}\n  unknownPath: '/party-registry-api/party-registry/unknown',`,
        ),
        /exact owner and API path metadata/u,
      ],
      [
        'spread metadata',
        contract.replace(
          'export const partyRegistryApiContract = {',
          'const copiedMetadata = {};\nexport const partyRegistryApiContract = {\n  ...copiedMetadata,',
        ),
        /exact owner and API path metadata/u,
      ],
    ] as const) {
      expect(mutated, `${label} must mutate the fixture`).not.toBe(contract);
      expect((yield* microVerticalApiBaselineViolation(partyId, mutated)) ?? '', label).toMatch(expected);
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
  pathToFileURL(path.join(generatorRoot, 'templates/workspace-scripts/ultramodern-cloudflare-proof.mjs')).href
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
              (fixture: ApiOnlyAppFixture, publicUrl: string) => Promise<typeof CloudflareEvidenceSchema.Type>
            >(),
        }),
      )(cloudflareProofModule);
      return framework.validateApp(app, applicationPublicUrl);
    });
    return yield* Schema.decodeUnknownEffect(CloudflareEvidenceSchema)(output);
  });

const federationValidationModule: unknown = await import(
  pathToFileURL(path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/mf-validation/validate.js')).href
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
  readonly deliveryUnit: {
    readonly buildMarker: string;
    readonly unitId: string;
  };
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
    return Promise.resolve(Response.json(body, { headers: { 'access-control-allow-origin': '*' } }));
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
      expect(evidence.assertions.some((entry) => entry.type === proof && entry.status === 'pass')).toBe(true);
    }
    expect(evidence.assertions.some((entry) => entry.type === 'ssr' || entry.type === 'i18n-marker')).toBe(false);
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
      const failureCause8 = yield* Effect.flip(Effect.sandbox(validateApp(apiOnlyApp(), publicUrl)));
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
      expect(String(Cause.squash(failureCause11))).toMatch(/declared .* route must be a root-relative path/u);
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
              path.join(generatorRoot, `dist/${variant}/ultramodern-workspace/mf-validation/inspect.${extension}`),
            ).href
          ),
      );
      const inspection = yield* Schema.decodeUnknownEffect(ModuleFederationInspectionModuleSchema)(inspectionModule);
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
      expect(inspect('// @ultramodern-mf no-exposes\nexport default { dts: false, exposes: {} };').dts).toEqual({});
      expect(() => inspect('export default { dts: false, exposes: { "./Page": "./page.tsx" } };')).toThrow(
        /DTS cannot be disabled for exposed app/u,
      );
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
      validateModuleFederationTypes({
        appDirs: [appDir],
        workspaceRoot: fixture,
      });
    yield* Effect.promise(() =>
      writeFile(configPath, '// @ultramodern-mf no-exposes\nexport default { dts: false, exposes: {} };'),
    );
    expect(validate().hostOnlyAppCount).toBe(1);
    yield* Effect.promise(() => writeFile(configPath, 'export default { dts: false, exposes: {} };'));
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
    const topology = yield* readJson(TopologySchema, path.join(workspaceRoot, topologyReferencePath));
    const party = topology.verticals.find((entry) => entry.id === partyId);
    expect(party).toBeDefined();
    if (!party) {
      throw new Error('Party deployment is missing');
    }
    expect(party.cloudflare.routes.ssr).toBe(undefined);
    expect(party.cloudflare.routes.locale).toBe(undefined);
    expect(party.cloudflare.routes.mfManifest).toBe(mfManifestPath);
    expect(party.cloudflare.routes.apiReadiness).toBe(readinessPath);
    expect(party.backendFederation.exposes['./effect-api'].contract).toBe('verticals/party-registry/shared/api.ts');
    expect(party.backendFederation.exposes['./effect-api'].openapi).toBe('/party-registry-api/openapi.json');
  }),
);

it.live(
  'Party Registry is the sole deployment owner for Contacts capabilities',
  Effect.fn(function* scenario37() {
    const topology = yield* readJson(TopologySchema, path.join(workspaceRoot, topologyReferencePath));
    const overlay = yield* readJson(
      OverlaySchema,
      path.join(workspaceRoot, 'topology/local-overlays/development.json'),
    );
    const zerops = yield* Effect.promise(() => readFile(path.join(workspaceRoot, 'zerops.yaml'), 'utf-8'));
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
    const modernConfig = yield* Effect.promise(() => readFile(path.join(workspaceRoot, ultramodernConfigFile)));
    yield* Effect.promise(() => writeFile(path.join(fixture, ultramodernConfigFile), modernConfig));
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
    expect(strictEffectRuntimeTopologyViolation(source.replace(before, after), resolveImport)).not.toBe(undefined);
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

type GeneratedHttpHandler = ReturnType<ReturnType<typeof defineEffectBff>['createHandler']>;

afterEach(() => {
  rs.restoreAllMocks();
});

// Consumer adaptation is compared by governed semantics, not generated byte equality.
describe('consumer migration preserves native tooling and governed safety', () => {
  const source = (relativePath: string) =>
    Effect.promise(() => readFile(path.join(workspaceRoot, relativePath), 'utf-8'));
  it.live(
    'authenticated cohort and scoped release-age policy remain pinned',
    Effect.fn(function* consumerScenario() {
      const releaseVersion = '3.9.0-ultramodern.9';
      const cohort = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            aliases: Schema.Record(Schema.String, Schema.String),
            packages: Schema.Array(
              Schema.Struct({
                sourceName: Schema.String,
                targetName: Schema.String,
                version: Schema.Literal(releaseVersion),
              }),
            ),
            release: Schema.Struct({ version: Schema.Literal(releaseVersion) }),
            source: Schema.Struct({
              commit: Schema.Literal('40bd94bfc127ebc46180eb07684c82c26fedee62'),
            }),
          }),
        ),
      )(yield* source('.modernjs/release-cohort.json'));
      expect(cohort.aliases['@modern-js/ultramodern-create']).toBe('@bleedingdev/modern-js-ultramodern-create');
      expect(cohort.aliases['@modern-js/create']).toBe(undefined);
      expect(new Set(cohort.packages.map((entry) => entry.sourceName)).size).toBe(cohort.packages.length);
      for (const entry of cohort.packages) {
        expect(cohort.aliases[entry.sourceName]).toBe(entry.targetName);
      }
      const workspace = yield* source('pnpm-workspace.yaml');
      for (const line of [
        'minimumReleaseAge: 1440',
        'minimumReleaseAgeStrict: true',
        'minimumReleaseAgeIgnoreMissingTime: false',
      ]) {
        expect(workspace.split('\n').filter((candidate) => candidate === line).length).toBe(1);
      }
      const exclusions = /^minimumReleaseAgeExclude:\n(?<entries>(?:[ \t]+[^\n]*\n)*)/mu.exec(workspace)?.groups
        ?.entries;
      expect(exclusions !== undefined && exclusions.length > 0).toBeTruthy();
      if (exclusions === undefined) {
        throw new Error('Missing release-age exclusions');
      }
      const allowed = new Set(cohort.packages.map((entry) => `${entry.targetName}@${entry.version}`));
      const declared = exclusions
        .trim()
        .split('\n')
        .map((line) => line.trim().replaceAll(/^-\s*['"]?|['"]$/gu, ''));
      expect(declared.length > 0).toBeTruthy();
      for (const entry of declared) {
        expect(
          allowed.has(entry),
          `Release-age exception must name an exact authenticated package: ${entry}`,
        ).toBeTruthy();
      }
      // The vendored validator snapshot is gone: the workspace contract gate now runs the
      // authenticated cohort's own `ultramodern validate`, so the pin is proved against the
      // adoption manifest and the installed cohort package instead of a copied source block.
      const validator = yield* source('scripts/validate-ultramodern-workspace.mts');
      expect(validator).toMatch(/runUltramodernScript\(/u);
      expect(validator).toMatch(/command: 'validate'/u);
      expect(validator).not.toMatch(/['"]@modern-js\/create['"]/u);
      const adoption = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            generator: Schema.Struct({ version: Schema.Literal(releaseVersion) }),
            packageSource: Schema.Struct({
              aliasScope: Schema.Literal('bleedingdev'),
              modernPackageVersion: Schema.Literal(releaseVersion),
            }),
          }),
        ),
      )(yield* source(ultramodernConfigFile));
      const installedGenerator = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.Literal(releaseVersion) })),
      )(yield* Effect.promise(() => readFile(path.join(generatorRoot, packageJsonFile), 'utf-8')));
      expect(installedGenerator.name).toBe(cohort.aliases['@modern-js/ultramodern-create']);
      expect(installedGenerator.name.startsWith(`@${adoption.packageSource.aliasScope}/`)).toBeTruthy();
    }),
  );
  it.live(
    'current generator handoff preserves arguments and nonzero failures',
    Effect.fn(function* consumerScenario() {
      const scratchRoot = path.join(workspaceRoot, '.scratch');
      yield* Effect.promise(() => mkdir(scratchRoot, { recursive: true }));
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(scratchRoot, 'consumer-migration-'))),
        (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
      );
      {
        const executable = path.join(fixture, 'generator.mjs');
        yield* Effect.promise(() =>
          writeFile(
            executable,
            `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), root: process.env.ULTRAMODERN_WORKSPACE_ROOT })); process.exitCode = 37;`,
          ),
        );
        const wrappers = [['ultramodern-typecheck.mts', 'typecheck']] as const;
        const wrapperSources = yield* Effect.forEach(wrappers, ([file]) => source(`scripts/${file}`), {
          concurrency: 1,
        });
        const runner = yield* source('scripts/shared/ultramodern-command.mts');
        const commandFailure = yield* source('scripts/ultramodern-command-failure.mts');
        expect(runner).toMatch(/'ultramodern-create'/u);
        expect(runner).not.toMatch(/['"]modern-js-create['"]/u);
        expect(commandFailure).toMatch(/Schema\.TaggedError/u);
        for (const [index, [file, command]] of wrappers.entries()) {
          const script = wrapperSources[index] ?? '';
          expect(script).toMatch(/runUltramodernScript/u);
          expect(script).not.toMatch(/['"]modern-js-create['"]/u);
          expect(script).toMatch(/Effect\.runPromiseExit/u);
          const result = spawnSync(
            process.execPath,
            [path.join(workspaceRoot, 'scripts', file), '--fixture-argument'],
            {
              cwd: fixture,
              encoding: 'utf-8',
              env: {
                ULTRAMODERN_CREATE_BIN: executable,
                ULTRAMODERN_WORKSPACE_ROOT: fixture,
              },
            },
          );
          expect(result.status, result.stderr).toBe(37);
          expect(JSON.parse(result.stdout)).toEqual({
            args: ['ultramodern', command, '--fixture-argument'],
            root: fixture,
          });
          const missing = spawnSync(process.execPath, [path.join(workspaceRoot, 'scripts', file)], {
            cwd: fixture,
            encoding: 'utf-8',
            env: {
              PATH: fixture,
              ULTRAMODERN_CREATE_BIN: '',
              ULTRAMODERN_WORKSPACE_ROOT: fixture,
            },
          });
          expect(missing.status).toBe(1);
          expect(missing.stdout + missing.stderr).toMatch(/Failed to launch ultramodern-create from PATH/u);
        }
      }
    }),
  );
  it.live(
    'native route, isolated materialization and workerd adaptations survive',
    Effect.fn(function* consumerScenario() {
      const files = ['generate-tanstack-routes.mts', 'materialize-zerops-runtime.mjs', 'proof-workerd-ssr.mts'];
      const scripts = yield* Effect.forEach(files, (file) => source(`scripts/${file}`), {
        concurrency: 1,
      });
      for (const [index, file] of files.entries()) {
        const script = scripts[index] ?? '';
        expect(script, file).toMatch(/Effect\.gen/u);
        expect(script, file).toMatch(/FileSystem/u);
        expect(script, file).not.toMatch(/import\s*\{[^}]*spawnSync[^}]*\}\s*from\s*['"]node:child_process/u);
        expect(script, file).not.toMatch(/['"]modern-js-create['"]/u);
      }
      const materializer = yield* source('scripts/materialize-zerops-runtime.mjs');
      expect(materializer).toMatch(/Flag\.boolean\('worker'\)/u);
      expect(materializer).toMatch(/appPackage\.name !== packageName/u);
      expect(materializer).toMatch(/makeTempDirectoryScoped/u);
      expect(materializer).toMatch(/removeIncompatiblePlatformDependencies/u);
      expect(materializer).not.toMatch(/--skip-build/u);
      const proof = yield* source('scripts/proof-workerd-ssr.mts');
      expect(proof).toMatch(/WorkerdProofError extends Schema\.TaggedError/u);
      expect(proof).toMatch(/findReleaseMarkers/u);
      expect(proof).toMatch(/not tied to its executed release identity/u);
      expect(proof).toMatch(/check\.body \?\? null/u);
      expect(proof).toMatch(/check\.expect \?\? null/u);
      expect(proof).toMatch(/Exit\.isFailure\(exit\)/u);
    }),
  );
  it.live(
    'custom Party contracts remain accepted and forged auth remains rejected',
    Effect.fn(function* consumerScenario() {
      const principal = yield* source('verticals/party-registry/api/auth/action-principal.ts');
      const gateway = yield* source('verticals/party-registry/src/api/action-gateway.ts');
      const sharedApi = yield* source(partySharedApiPath);
      const handlerRoot = yield* source('verticals/party-registry/api/index.ts');
      expect(hasGeneratedOperationPrincipalContract(principal)).toBe(true);
      expect(hasGeneratedOperationGatewayContract(gateway, partyId)).toBe(true);
      expect(hasValidGovernedHttpCompositionRoot(sharedApi, handlerRoot)).toBe(true);
      expect(yield* microVerticalApiBaselineViolation(partyId, sharedApi)).toBe(undefined);
      for (const [before, after] of [
        [
          'makeMicroverticalHttpPrincipalAuthentication(verifyOperationPrincipal)',
          'makeMicroverticalHttpPrincipalAuthentication(forgedPrincipal)',
        ],
        ["'@app/core-runtime/http/principal-authentication'", "'./counterfeit.ts'"],
      ]) {
        expect(principal.includes(before)).toBeTruthy();
        expect(hasGeneratedOperationPrincipalContract(principal.replace(before, after))).toBe(false);
      }
      const audience = "ACTION_GATEWAY_AUDIENCE = 'party-registry'";
      expect(gateway.includes(audience)).toBeTruthy();
      expect(
        hasGeneratedOperationGatewayContract(
          gateway.replace(audience, "ACTION_GATEWAY_AUDIENCE = 'other-owner'"),
          partyId,
        ),
      ).toBe(false);
      // Exercise the complete Core/Party server, client, permission and transport negative matrix.
      const governed = spawnSync(
        process.execPath,
        [
          path.join(workspaceRoot, 'node_modules/@rstest/core/bin/rstest.js'),
          'run',
          '--project',
          'scripts',
          'scripts/tests/module-entrypoint-boundaries.test.mts',
          '--testNamePattern',
          'governed',
        ],
        {
          cwd: workspaceRoot,
          encoding: 'utf-8',
          env: { PATH: path.dirname(process.execPath) },
        },
      );
      expect(governed.status, governed.stdout + governed.stderr).toBe(0);
      expect(governed.stdout).toMatch(/governed servers bind/u);
      expect(governed.stdout).toMatch(/rejects generated governed clients/u);
    }),
  );
  it('manifest-aware bridge accepts TanStack without permitting disguised router capability', () => {
    const imported = "import { createModuleFederationConfig as createConfig } from '@module-federation/modern-js-v3';";
    const config = (body: string) => `${imported} export default createConfig(${body});`;
    const disabled = '{ bridge: { enableBridgeRouter: false } }';
    const enabled = '{ bridge: { enableBridgeRouter: true } }';
    expect(moduleFederationBridgeViolation(config(disabled), {})).toBe(undefined);
    expect(
      moduleFederationBridgeViolation(
        `${imported} const config = createConfig(${disabled}); export default config;`,
        {},
      ),
    ).toBe(undefined);
    expect(
      moduleFederationBridgeViolation(config(enabled), {
        dependencies: { 'react-router': '7.18.0' },
      }),
    ).toBe(undefined);
    expect(
      moduleFederationBridgeViolation(config(enabled), {
        devDependencies: { 'react-router-dom': '7.18.0' },
      }),
    ).toBe(undefined);
    for (const candidate of [
      config(enabled),
      config('{}'),
      config('{ bridge: {} }'),
      config('{ bridge: { enableBridgeRouter: Boolean(false) } }'),
      config('{ bridge: { enableBridgeRouter: false, ...override } }'),
      config('{ bridge: { enableBridgeRouter: false, [key]: true } }'),
      config('{ bridge: { enableBridgeRouter: false, enableBridgeRouter: true } }'),
      config('{ bridge: { enableBridgeRouter: false }, ...override }'),
      config(disabled).replace('import {', 'import type {'),
      `${imported} function decoy(createConfig) { return createConfig(${disabled}); } export default otherConfig;`,
      `function createConfig(value) { return value; } export default createConfig(${disabled});`,
    ]) {
      expect(moduleFederationBridgeViolation(candidate, {}), candidate).not.toBe(undefined);
    }
  });
});
