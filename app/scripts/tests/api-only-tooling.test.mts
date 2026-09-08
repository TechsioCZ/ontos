/// <reference types="node" />

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { Predicate, Schema } from 'effect';
import type { Effect as EffectType } from 'effect/Effect';
import { build as bundleSource, transform } from 'esbuild';
import { format } from 'oxfmt';

import { MicroVerticalReadinessSchema } from '../../packages/shared-contracts/src/microvertical-api-baseline.ts';
import { hasValidGovernedHttpCompositionRoot } from '../generated-governed-http-boundary.mts';
import {
  hasGeneratedOperationGatewayContract,
  hasGeneratedOperationPrincipalContract,
} from '../generated-module-api-boundary.mts';
import {
  configuredMicroVerticalApiStem,
  microVerticalApiBaselineViolation as microVerticalApiBaselineViolationForFile,
} from '../microvertical-api-baseline-boundary.mts';
import type { MicroVerticalApiBaselineExpectation } from '../microvertical-api-baseline-boundary.mts';
import { moduleFederationBridgeViolation } from '../module-federation-bridge-boundary.mts';
import { strictEffectRuntimeTopologyViolation } from '../ultramodern-api-boundary-rules.mts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const partyId = 'party-registry';
const partyDirectory = 'verticals/party-registry';
const partySharedApiPath = `${partyDirectory}/shared/api.ts`;
const generatedFixtureId = 'inventory-stock';
const generatedApiPrefix = '/inventory-stock-api';
const generatedServiceModuleName = 'api/service';
const generatedApiServiceModule =
  'dist/esm-node/ultramodern-workspace/api/service.js';
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
const generatedClientContractImport = '../../shared/api.ts';
const generatedSharedApiModule = 'api/shared';
const generatedProofScope = 'generated-proof';
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

const microVerticalApiBaselineViolation = (
  stem: string,
  source: string,
  expectation?: Partial<MicroVerticalApiBaselineExpectation>
): string | undefined => {
  const fixture = mkdtempSync(
    path.join(os.tmpdir(), 'ontos-microvertical-api-test-')
  );
  const contractPath = path.join(fixture, 'api.ts');
  try {
    writeFileSync(contractPath, source);
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
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
};

const unexpectedTopologyImport = (specifier: string): never => {
  throw new Error(`Unexpected strict-topology import: ${specifier}`);
};

const generatorRoot = await realpath(
  path.join(workspaceRoot, 'node_modules/@modern-js/ultramodern-create')
);
const require = createRequire(import.meta.url);
const generatorModulePathFor =
  (moduleFormat: string) =>
  (name: string): string =>
    path.join(
      generatorRoot,
      `dist/${moduleFormat}/ultramodern-workspace/${name}.${moduleFormat === 'cjs' ? 'cjs' : 'js'}`
    );

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
interface ReleaseEnvelope {
  readonly surfaces: {
    readonly apiBackend: readonly string[];
    readonly ssr: readonly string[];
    readonly uiClient: readonly string[];
  };
}

interface ReleaseFramework {
  readonly emitFrameworkMicroVerticalReleaseEnvelope: (input: {
    readonly apiOnly: boolean;
    readonly distDirectory: string;
    readonly target: string;
  }) => Promise<ReleaseEnvelope>;
  readonly emitNodeStagedReleaseEnvelope: (input: {
    readonly distDirectory: string;
    readonly outputDirectory: string;
  }) => Promise<ReleaseEnvelope>;
  readonly verifyBuildOutputReleaseEnvelope: (
    root: string,
    target: string
  ) => Promise<void>;
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
  }
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
type CreateVerticalDescriptor = (
  appId: string,
  port: number
) => WorkspaceAppFixture;
type CreateLayout = (appId: typeof AppIdSchema.Type) => string;
type CreateAppModernConfig = (
  applicationRoot: string,
  app: WorkspaceAppFixture
) => string;
type CreateBackendModuleFederationConfig = (app: WorkspaceAppFixture) => string;
type CreateUltramodernBuildModule = (
  applicationRoot: string,
  app: WorkspaceAppFixture
) => string;
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
type CreateSharedApi = (
  app: ApiGeneratorFixture,
  options: ApiGeneratorOptions
) => string;
type CreateApiClient = (
  app: WorkspaceAppFixture,
  contractImportPath: string,
  options: ApiGeneratorOptions
) => string;
type CreateApiServiceEntry = (
  app: ApiGeneratorFixture,
  contractImportPath: string,
  options: ApiGeneratorOptions
) => string;
interface GeneratedWorkspaceScriptArtifact {
  readonly content: string;
  readonly relativePath: string;
}
type MigratedWorkspaceScriptArtifacts = (options: {
  readonly hasBackendSurface: boolean;
  readonly shellOnly: boolean;
}) => readonly GeneratedWorkspaceScriptArtifact[];
interface GeneratedHttpHandler {
  readonly dispose: () => Promise<void>;
  readonly handler: (request: Request) => Promise<Response>;
}
type CreateGeneratedHttpHandler = () => GeneratedHttpHandler;
type GeneratedReadiness = typeof MicroVerticalReadinessSchema.Type;
type GeneratedReadinessEffect = EffectType<GeneratedReadiness>;
type GetGeneratedReadiness = (options?: {
  readonly baseUrl?: string | URL;
}) => GeneratedReadinessEffect;
type RunGeneratedEffect = (
  effect: GeneratedReadinessEffect
) => Promise<GeneratedReadiness>;
type ValidateCloudflareApp = (
  app: ApiOnlyAppFixture,
  applicationPublicUrl: string
) => Promise<typeof CloudflareEvidenceSchema.Type>;
type ValidateModuleFederationTypes = (input: {
  readonly appDirs: readonly string[];
  readonly workspaceRoot: string;
}) => typeof ModuleFederationValidationResultSchema.Type;
type InspectModuleFederationConfigSource = (
  source: string,
  appDirectory: string,
  configFile: string
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
  definitions: Readonly<Record<string, string>>
) => RspackPluginFixture;
type RspackModuleFixture = RspackFactory & {
  readonly DefinePlugin: DefinePluginConstructor;
  readonly rspack: RspackFactory;
};
interface CompilerStatsFixture {
  readonly hasErrors: () => boolean;
  readonly toString: (options: {
    readonly all: boolean;
    readonly errors: boolean;
  }) => string;
}
interface CompilerFixture {
  readonly close: (onComplete: (error?: Error | null) => void) => void;
  readonly run: (
    onComplete: (
      error: Error | null,
      stats?: CompilerStatsFixture | null
    ) => void
  ) => void;
}

const callable = <Callable extends (...argumentsList: never[]) => void>() =>
  Schema.Opaque<Callable>()(
    Schema.Unknown.pipe(Schema.refine(Predicate.isFunction))
  );
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
  emitNodeStagedReleaseEnvelope:
    callable<ReleaseFramework['emitNodeStagedReleaseEnvelope']>(),
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
    })
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
  createStrictEffectApiBoundariesRule:
    callable<StrictEffectApiBoundaryRuleFactory>(),
});
const ComponentModuleSchema = Schema.Struct({
  createLayout: callable<CreateLayout>(),
});
const FederationConfigModuleSchema = Schema.Struct({
  createAppModernConfig: callable<CreateAppModernConfig>(),
  createBackendModuleFederationConfig:
    callable<CreateBackendModuleFederationConfig>(),
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
const WorkspaceScriptsGeneratorSchema = Schema.Struct({
  migratedWorkspaceScriptArtifacts:
    callable<MigratedWorkspaceScriptArtifacts>(),
});
const GeneratedApiRuntimeModuleSchema = Schema.Struct({
  default: Schema.Struct({
    createHandler: callable<CreateGeneratedHttpHandler>(),
  }),
});
const CloudflareEvidenceSchema = Schema.Struct({
  assertions: Schema.Array(
    Schema.Struct({ status: Schema.String, type: Schema.String })
  ),
});
const CloudflareProofModuleSchema = Schema.Struct({
  validateApp: callable<ValidateCloudflareApp>(),
});
const ModuleFederationValidationModuleSchema = Schema.Struct({
  validateModuleFederationTypes: callable<ValidateModuleFederationTypes>(),
});
const ModuleFederationValidationResultSchema = Schema.Struct({
  hostOnlyAppCount: Schema.Number,
});
const ModuleFederationInspectionModuleSchema = Schema.Struct({
  inspectModuleFederationConfigSource:
    callable<InspectModuleFederationConfigSource>(),
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
        exposes: Schema.Record(
          Schema.String,
          Schema.Struct({ contract: Schema.String, openapi: Schema.String })
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
    })
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
    })
  ),
  status: Schema.String,
});

const loadReleaseFramework = async (
  modulePath: string
): Promise<ReleaseFramework> => {
  const source: unknown = await import(pathToFileURL(modulePath).href);
  const framework = Schema.decodeUnknownSync(ReleaseFrameworkModuleSchema)(
    source
  );
  const emitFrameworkMicroVerticalReleaseEnvelope =
    framework.emitFrameworkMicroVerticalReleaseEnvelope.bind(source);
  const emitNodeStagedReleaseEnvelope =
    framework.emitNodeStagedReleaseEnvelope.bind(source);
  const verifyBuildOutputReleaseEnvelope =
    framework.verifyBuildOutputReleaseEnvelope.bind(source);
  const verifyNodeReleaseEnvelopeStaging =
    framework.verifyNodeReleaseEnvelopeStaging.bind(source);
  return {
    emitFrameworkMicroVerticalReleaseEnvelope: async (input) => {
      const output: unknown =
        await emitFrameworkMicroVerticalReleaseEnvelope(input);
      return Schema.decodeUnknownSync(ReleaseEnvelopeSchema)(output);
    },
    emitNodeStagedReleaseEnvelope: async (input) => {
      const output: unknown = await emitNodeStagedReleaseEnvelope(input);
      return Schema.decodeUnknownSync(ReleaseEnvelopeSchema)(output);
    },
    verifyBuildOutputReleaseEnvelope: async (root, target) => {
      await verifyBuildOutputReleaseEnvelope(root, target);
    },
    verifyNodeReleaseEnvelopeStaging: async (input) => {
      await verifyNodeReleaseEnvelopeStaging(input);
    },
  };
};

const readJson = async <JsonSchema extends Schema.ConstraintDecoder<unknown>>(
  schema: JsonSchema,
  filePath: string
): Promise<JsonSchema['Type']> =>
  Schema.decodeUnknownSync(schema)(
    JSON.parse(await readFile(filePath, 'utf-8'))
  );

const writeJson = async <Value extends object>(
  root: string,
  logicalPath: string,
  value: Value
): Promise<void> => {
  await mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true });
  await writeFile(path.join(root, logicalPath), JSON.stringify(value));
};

const writeText = async (
  root: string,
  logicalPath: string,
  value: string
): Promise<void> => {
  await mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true });
  await writeFile(path.join(root, logicalPath), value);
};

const runNode = (
  argumentsList: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  } = {}
): string =>
  execFileSync(process.execPath, argumentsList, {
    cwd: options.cwd,
    encoding: 'utf-8',
    env: options.env,
  } satisfies ExecFileSyncOptionsWithStringEncoding);

const appToolsRequire = createRequire(
  await realpath(
    path.join(
      workspaceRoot,
      'verticals/party-registry/node_modules/@modern-js/app-tools/package.json'
    )
  )
);
const releaseFrameworkRoot = path.resolve(
  path.dirname(
    appToolsRequire.resolve(
      '@modern-js/app-tools-extensions/release-envelope/framework-output'
    )
  ),
  '../..'
);
const releaseFramework = await loadReleaseFramework(
  path.join(
    releaseFrameworkRoot,
    'esm-node/release-envelope/framework-output.mjs'
  )
);

void test('MicroVertical templates use the shared strict Effect BFF assembly primitive', async () => {
  const apiServiceModule: unknown = await import(
    pathToFileURL(path.join(generatorRoot, generatedApiServiceModule)).href
  );
  const apiServiceGenerator = Schema.decodeUnknownSync(
    ApiServiceGeneratorModuleSchema
  )(apiServiceModule);
  const packageModule: unknown = await import(
    pathToFileURL(
      path.join(
        generatorRoot,
        'dist/esm-node/ultramodern-workspace/package-json.js'
      )
    ).href
  );
  const packageGenerator = Schema.decodeUnknownSync(
    PackageGeneratorModuleSchema
  )(packageModule);
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
    { scope: 'fixture' }
  );

  assert.match(
    source,
    /import \{ assembleEffectBffRuntime \} from '@fixture\/shared-contracts\/server\/effect-bff-runtime';/u
  );
  assert.match(source, /const apiHandlersLive = Layer\.mergeAll\(/u);
  assert.match(
    source,
    /assembleEffectBffRuntime\(\{[\s\S]*handlers: apiHandlersLive/u
  );
  assert.doesNotMatch(source, /\bdefineEffectBff\b/u);

  const sharedContractsPackage = packageGenerator.createSharedPackage(
    'fixture',
    'shared-contracts',
    'fixture contracts',
    { modernPackageVersion: '3.8.2', strategy: 'install' }
  );
  assert.equal(
    sharedContractsPackage.exports['./server/effect-bff-runtime'],
    './src/effect-bff-runtime.ts'
  );
  assert.equal(
    sharedContractsPackage.dependencies['@modern-js/plugin-bff'],
    '3.8.2'
  );
  assert.equal(sharedContractsPackage.dependencies.effect, '4.0.0-rc.112');
  assert.match(
    await readFile(
      path.join(generatorRoot, 'templates/packages/effect-bff-runtime.ts'),
      'utf-8'
    ),
    /export const assembleEffectBffRuntime/u
  );
  assert.match(
    await readFile(
      path.join(
        generatorRoot,
        'templates/workspace-scripts/check-ultramodern-api-boundaries.mts'
      ),
      'utf-8'
    ),
    /strictEffectRuntimeTopologyViolation/u
  );
});

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

void test('static API validation proves the imported helper call topology', () => {
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
  assert.equal(strictEffectRuntimeTopologyViolation(valid), undefined);
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
  assert.equal(
    strictEffectRuntimeTopologyViolation(
      importedHandlers,
      resolveImportedHandlers
    ),
    undefined
  );
  const foreignGroupModule = groupModule.replace(
    `from '${generatedSharedApiImport}'`,
    "from '../../foreign/shared/api.ts'"
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
  assert.match(
    strictEffectRuntimeTopologyViolation(
      importedHandlers,
      resolveForeignHandlers
    ) ?? '',
    /explicitly composed Layer/u
  );
  assert.equal(
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
    undefined
  );
  for (const [
    index,
    source,
  ] of validAdversarialStrictRuntimeSources.entries()) {
    assert.equal(
      strictEffectRuntimeTopologyViolation(source),
      undefined,
      `valid adversarial source ${index + 1}`
    );
  }
  for (const source of adversarialStrictRuntimeSources) {
    assert.notEqual(strictEffectRuntimeTopologyViolation(source), undefined);
  }
  for (const [label, source, expected] of [
    [
      'defineEffectBff with a typed layer annotation',
      `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
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
      /explicitly composed Layer/u,
    ],
    [
      'runtime assembled behind an unreachable branch',
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
      import { defineEffectBff, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = Layer.empty;
      export default defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      /server-only shared Effect BFF assembly helper/u,
    ],
    [
      'defineEffectBff layer piped to an empty layer',
      `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(() => Layer.empty);
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `,
      /server-only shared Effect BFF assembly helper/u,
    ],
    [
      'defineEffectBff layer piped past its provided handlers',
      `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
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
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
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
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
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
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
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
    `,
      /transport/u,
    ],
    [
      'handlers built by an unknown Layer member',
      `
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
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
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
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
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
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
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
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
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
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
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
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
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
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
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fakeHandlers = "Layer.mergeAll(groupLayer)";
      assembleEffectBffRuntime({ api: fixtureApi, handlers: fakeHandlers });
    `,
      /explicitly composed Layer/u,
    ],
  ] as const) {
    assert.match(
      strictEffectRuntimeTopologyViolation(source) ?? '',
      expected,
      label
    );
  }
});

/** Every published rule format must report the same violations for the same candidate root. */
const strictBoundaryReports = (
  module: typeof StrictEffectApiBoundaryRuleModuleSchema.Type,
  filename: string,
  source: string
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
      message
    )
  );

void test('published lint validators reject comment, string, and local strict-root spoofs', async (context) => {
  const codeToolsRoot = await realpath(
    path.join(workspaceRoot, 'node_modules/@modern-js/code-tools')
  );
  const formats = [
    'dist/cjs/oxlint-plugin/rules/strict-effect-api-boundaries.cjs',
    'dist/esm/oxlint-plugin/rules/strict-effect-api-boundaries.js',
    'dist/esm-node/oxlint-plugin/rules/strict-effect-api-boundaries.js',
  ] as const;
  const apiServiceSource: unknown = await import(
    pathToFileURL(path.join(generatorRoot, generatedApiServiceModule)).href
  );
  const apiServiceGenerator = Schema.decodeUnknownSync(
    ApiServiceGeneratorModuleSchema
  )(apiServiceSource);
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
    { scope: 'app' }
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
    { scope: 'app' }
  );
  const generatedRpcContractSource = `
    import { RpcGroup } from 'effect/unstable/rpc';
    export const inventoryStockRpcGroup = RpcGroup.make();
  `;
  assert.equal(
    strictEffectRuntimeTopologyViolation(generatedRpcSource, (specifier) =>
      specifier === generatedSharedRpcImport
        ? {
            id: 'inventory-stock/shared/rpc.ts',
            resolveImport: unexpectedTopologyImport,
            source: generatedRpcContractSource,
          }
        : unexpectedTopologyImport(specifier)
    ),
    undefined
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(generatedRpcSource, (specifier) =>
      specifier === generatedSharedRpcImport
        ? {
            id: 'inventory-stock/shared/rpc.ts',
            resolveImport: unexpectedTopologyImport,
            source:
              'export const inventoryStockRpcGroup = { toLayer: () => undefined };',
          }
        : unexpectedTopologyImport(specifier)
    ) ?? '',
    /server-only shared Effect BFF assembly helper/u
  );
  const lintRoot = await mkdtemp(
    path.join(os.tmpdir(), 'ontos-strict-api-lint-')
  );
  context.after(
    async () => await rm(lintRoot, { force: true, recursive: true })
  );
  const fixtureRoot = path.join(lintRoot, 'verticals/fixture');
  const fixtureApiEntryPath = path.join(fixtureRoot, apiIndexFile);
  await mkdir(path.join(fixtureRoot, 'api'), { recursive: true });
  await mkdir(path.join(fixtureRoot, 'shared'), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, sharedApiFile),
    governedApiModuleSource
  );
  await writeFile(
    path.join(fixtureRoot, 'shared/rpc.ts'),
    'export const fixtureRpcGroup = { toLayer: () => undefined };\n'
  );
  await writeFile(
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
    `
  );
  const foreignRoot = path.join(lintRoot, 'verticals/foreign');
  await mkdir(path.join(foreignRoot, 'shared'), { recursive: true });
  await mkdir(path.join(foreignRoot, 'api'), { recursive: true });
  await writeFile(
    path.join(foreignRoot, sharedApiFile),
    `${fixtureApiModuleSource}\n`
  );
  await writeFile(
    path.join(foreignRoot, 'api/group.ts'),
    `
      import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      export const foreignGroup = HttpApiBuilder.group(
        fixtureApi,
        'fixture',
        (handlers) => handlers.handle('reachable', () => undefined),
      );
    `
  );
  const generatedRoot = path.join(lintRoot, 'verticals/inventory-stock');
  await mkdir(path.join(generatedRoot, 'shared'), { recursive: true });
  await writeFile(
    path.join(generatedRoot, sharedApiFile),
    'export const inventoryStockApi = {};\n'
  );
  await writeFile(
    path.join(generatedRoot, 'shared/rpc.ts'),
    generatedRpcContractSource
  );
  const invalidSources = [
    ...adversarialStrictRuntimeSources,
    ...governedLayerAliasMutations.map(([before, after]) =>
      governedLayerAliasFixture.replace(before, after)
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

  const modules = await Promise.all(
    formats.map(async (moduleFormat) => {
      const imported: unknown = await import(
        pathToFileURL(path.join(codeToolsRoot, moduleFormat)).href
      );
      return {
        module: Schema.decodeUnknownSync(
          StrictEffectApiBoundaryRuleModuleSchema
        )(imported),
        moduleFormat,
      };
    })
  );
  for (const { module, moduleFormat } of modules) {
    for (const source of invalidSources) {
      assert.ok(
        reportsAssemblyViolation(
          strictBoundaryReports(module, fixtureApiEntryPath, source)
        ),
        `${moduleFormat} accepted a fake strict runtime root`
      );
    }
    const legacySource = `
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer: Layer.Layer<never> = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
      );
      export default defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `;
    assert.equal(
      reportsAssemblyViolation(
        strictBoundaryReports(module, fixtureApiEntryPath, legacySource)
      ),
      true,
      `${moduleFormat} accepted a legacy runtime root without the shared assembly helper`
    );
    const generatedMessages = strictBoundaryReports(
      module,
      path.join(generatedRoot, apiIndexFile),
      generatedSource
    );
    assert.equal(
      reportsAssemblyViolation(generatedMessages),
      false,
      `${moduleFormat} rejected exact generated helper output: ${generatedMessages.join(' | ')}`
    );
    const generatedRpcMessages = strictBoundaryReports(
      module,
      path.join(generatedRoot, apiIndexFile),
      generatedRpcSource
    );
    assert.equal(
      generatedRpcMessages.some((message) =>
        /server-only shared Effect BFF assembly helper|explicitly composed handler Layer|\.\.\/shared\/api\.ts/u.test(
          message
        )
      ),
      false,
      `${moduleFormat} rejected exact generated RPC output: ${generatedRpcMessages.join(' | ')}`
    );
    for (const source of [
      ...validAdversarialStrictRuntimeSources,
      governedLayerAliasFixture,
    ]) {
      const messages = strictBoundaryReports(
        module,
        fixtureApiEntryPath,
        source
      );
      assert.equal(
        reportsAssemblyViolation(messages),
        false,
        `${moduleFormat} rejected a valid strict runtime root: ${messages.join(' | ')}`
      );
    }
  }
});

void test('a minimal generated MicroVertical typechecks and serves its runtime', async () => {
  const apiServiceSource: unknown = await import(
    pathToFileURL(path.join(generatorRoot, generatedApiServiceModule)).href
  );
  const apiServiceGenerator = Schema.decodeUnknownSync(
    ApiServiceGeneratorModuleSchema
  )(apiServiceSource);
  const sharedApiSource: unknown = await import(
    pathToFileURL(
      path.join(
        generatorRoot,
        'dist/esm-node/ultramodern-workspace/api/shared.js'
      )
    ).href
  );
  const sharedApiGenerator = Schema.decodeUnknownSync(
    SharedApiGeneratorModuleSchema
  )(sharedApiSource);
  const descriptor = {
    api: {
      consumedBy: [],
      prefix: generatedApiPrefix,
      stem: generatedFixtureId,
    },
    id: generatedFixtureId,
  } as const;
  const fixture = await mkdtemp(
    path.join(workspaceRoot, 'verticals/party-registry/.generated-runtime-')
  );
  try {
    await writeText(
      fixture,
      apiIndexFile,
      apiServiceGenerator.createApiServiceEntry(
        descriptor,
        generatedSharedApiImport,
        { scope: 'app' }
      )
    );
    await writeText(
      fixture,
      sharedApiFile,
      sharedApiGenerator.createSharedApi(descriptor, { scope: 'app' })
    );
    await writeText(
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
      } as const;\n`
    );
    await writeJson(fixture, tsconfigFile, {
      compilerOptions: { composite: false, noEmit: true, types: ['node'] },
      extends: '../../../tsconfig.base.json',
      include: ['api/**/*.ts', 'shared/**/*.ts'],
    });
    execFileSync(
      path.join(workspaceRoot, 'node_modules/.bin/tsc'),
      ['-p', tsconfigFile],
      {
        cwd: fixture,
        encoding: 'utf-8',
      }
    );
    await writeText(
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
      }\n`
    );
    runNode([path.join(fixture, 'runtime-proof.mjs')], { cwd: fixture });
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

const releaseFixture = async (context: TestContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ontos-empty-producer-'));
  context.after(async (): Promise<void> => {
    await rm(root, { force: true, recursive: true });
  });
  const baseArtifact = await readJson(
    BuildArtifactSchema,
    path.join(
      workspaceRoot,
      'verticals/party-registry/shared/ultramodern-build.json'
    )
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
  const putJson = async <Value extends object>(
    logicalPath: string,
    value: Value
  ): Promise<void> => await writeJson(root, logicalPath, value);
  const putText = async (logicalPath: string, value: string): Promise<void> =>
    await writeText(root, logicalPath, value);
  await putJson('ultramodern-build.json', artifact);
  await putJson('backend-mf-manifest.json', {
    backendFederation: {
      deliveryUnit: artifact.deliveryUnit,
      versionBoundary: { deliveryUnit: artifact.deliveryUnit },
    },
  });
  await putJson(mfManifestFile, manifest);
  await putJson(routesManifestFile, {
    routeAssets: {
      index: {
        assets: [`https://assets.example.test/app/${compiledUiAssetPath}`],
      },
    },
  });
  await putJson('route.json', { routes: [{ bundle: ssrBundlePath }] });
  await putJson('package.json', { type: 'module' });
  await Promise.all(
    [
      compiledUiAssetPath,
      ssrBundlePath,
      apiBundlePath,
      'index.js',
      'backendRemoteEntry.cjs',
    ].map(
      async (file) => await putText(file, 'console.log("compiled fixture");')
    )
  );
  const emit = async () =>
    await releaseFramework.emitFrameworkMicroVerticalReleaseEnvelope({
      apiOnly: false,
      distDirectory: root,
      target: 'node',
    });
  return { artifact, emit, manifest, putJson, putText, root };
};

void test('empty MF producers retain complete build and Node staged release evidence in every framework format', async (context) => {
  await Promise.all(
    ['cjs', 'esm', 'esm-node'].map(async (moduleFormat) => {
      const fixture = await releaseFixture(context);
      const extension = moduleFormat === 'cjs' ? 'js' : 'mjs';
      const framework = await loadReleaseFramework(
        path.join(
          releaseFrameworkRoot,
          moduleFormat,
          `release-envelope/framework-output.${extension}`
        )
      );
      const envelope =
        await framework.emitFrameworkMicroVerticalReleaseEnvelope({
          apiOnly: false,
          distDirectory: fixture.root,
          target: 'node',
        });
      assert.ok(envelope.surfaces.uiClient.includes(compiledUiAssetPath));
      assert.deepEqual(envelope.surfaces.ssr, [ssrBundlePath]);
      assert.deepEqual(envelope.surfaces.apiBackend, [apiBundlePath]);
      await framework.verifyBuildOutputReleaseEnvelope(fixture.root, 'node');
      const staged = await framework.emitNodeStagedReleaseEnvelope({
        distDirectory: fixture.root,
        outputDirectory: fixture.root,
      });
      assert.ok(staged.surfaces.uiClient.includes(compiledUiAssetPath));
      await framework.verifyNodeReleaseEnvelopeStaging({
        outputDirectory: fixture.root,
      });
    })
  );
  const fixture = await releaseFixture(context);
  await fixture.emit();
  await fixture.putText(compiledUiAssetPath, 'console.log("tampered");');
  await assert.rejects(
    async () =>
      await releaseFramework.verifyBuildOutputReleaseEnvelope(
        fixture.root,
        'node'
      ),
    /digest|hash|size/iu
  );
});

void test('empty MF producers bind root-relative route assets when publicPath is auto', async (context) => {
  await Promise.all(
    ['cjs', 'esm', 'esm-node'].map(async (moduleFormat) => {
      const fixture = await releaseFixture(context);
      fixture.manifest.metaData.publicPath = 'auto';
      await fixture.putJson(mfManifestFile, fixture.manifest);
      await fixture.putJson(routesManifestFile, {
        routeAssets: { index: { assets: [`/${compiledUiAssetPath}`] } },
      });
      const extension = moduleFormat === 'cjs' ? 'js' : 'mjs';
      const framework = await loadReleaseFramework(
        path.join(
          releaseFrameworkRoot,
          moduleFormat,
          `release-envelope/framework-output.${extension}`
        )
      );
      const envelope =
        await framework.emitFrameworkMicroVerticalReleaseEnvelope({
          apiOnly: false,
          distDirectory: fixture.root,
          target: 'node',
        });
      assert.ok(envelope.surfaces.uiClient.includes(compiledUiAssetPath));
    })
  );
});

void test('empty-producer fallback rejects undeclared, foreign, traversing, missing, and nonbrowser assets', async (context) => {
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
  await Promise.all(
    references.map(async (reference) => {
      const fixture = await releaseFixture(context);
      await fixture.putJson(routesManifestFile, {
        routeAssets: { index: { assets: [reference] } },
      });
      await assert.rejects(
        fixture.emit,
        /UI\/client manifest references no compiled execution module/u,
        reference
      );
    })
  );
  const baseline = await releaseFixture(context);
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
  await Promise.all(
    invalidManifests.map(async (manifest) => {
      const fixture = await releaseFixture(context);
      await fixture.putJson(mfManifestFile, manifest);
      await assert.rejects(
        fixture.emit,
        /UI\/client manifest references no compiled execution module/u
      );
    })
  );
  const fixture = await releaseFixture(context);
  await rm(path.join(fixture.root, routesManifestFile));
  await assert.rejects(fixture.emit, /ENOENT/u);
});

void test('empty MF producers cannot bypass backend, SSR, revision, or identity proof', async (context) => {
  await Promise.all(
    [apiBundlePath, ssrBundlePath, 'backendRemoteEntry.cjs'].map(
      async (file) => {
        const fixture = await releaseFixture(context);
        await rm(path.join(fixture.root, file));
        await assert.rejects(
          fixture.emit,
          /compiled Node Effect API|SSR artifacts|emitted together/u
        );
      }
    )
  );
  const fixture = await releaseFixture(context);
  await fixture.putJson('backend-mf-manifest.json', {
    backendFederation: {
      deliveryUnit: {
        ...fixture.artifact.deliveryUnit,
        sourceRevision: 'b'.repeat(40),
      },
    },
  });
  await assert.rejects(fixture.emit, /must match/u);
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
  await fixture.putJson('ultramodern-build.json', workspaceArtifact);
  await assert.rejects(fixture.emit, /workspace/u);
});

const GlobalVarsSchema = Schema.Struct({
  ULTRAMODERN_SHELL_ORIGIN: Schema.String,
});

const evaluatePartyBuildGlobalVars = async (shellOrigin: string) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), 'ontos-party-config-')
  );
  try {
    const harnessPath = path.join(temporaryRoot, 'read-config.mjs');
    const configSource = await readFile(
      path.join(workspaceRoot, 'verticals/party-registry/modern.config.ts'),
      'utf-8'
    );
    const effectModuleUrl = pathToFileURL(
      require.resolve('effect', { paths: [workspaceRoot] })
    ).href;
    const { code } = await transform(configSource, {
      define: {
        'import.meta.url': JSON.stringify(
          pathToFileURL(
            path.join(
              workspaceRoot,
              'verticals/party-registry/modern.config.ts'
            )
          ).href
        ),
      },
      format: 'cjs',
      loader: 'ts',
    });
    await writeFile(
      harnessPath,
      `import * as effect from ${JSON.stringify(effectModuleUrl)};
import * as sharedBuild from ${JSON.stringify(pathToFileURL(path.join(workspaceRoot, 'packages/shared-contracts/tooling/modern-config.ts')).href)};
import { runInNewContext } from 'node:vm';
import * as nodeUrl from 'node:url';
import * as nodePath from 'node:path';
const framework = {
  ...sharedBuild,
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
  URL,
  require: specifier => specifier === 'effect' ? effect : specifier === 'node:url' ? nodeUrl : specifier === 'node:path' ? nodePath : framework,
});
process.stdout.write(JSON.stringify(module.exports.default.source.globalVars));
`
    );
    const output = runNode([harnessPath]);
    return Schema.decodeUnknownSync(Schema.fromJsonString(GlobalVarsSchema))(
      output
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

void test('Party build configuration injects the exact nonlocal Shell origin into the API runtime', async () => {
  const shellOrigin = 'https://operations.example.test';
  const globalVars = await evaluatePartyBuildGlobalVars(shellOrigin);
  assert.equal(globalVars.ULTRAMODERN_SHELL_ORIGIN, shellOrigin);
});

void test('compiled Party CORS reader uses the nonlocal DefinePlugin origin without a runtime global', async () => {
  const shellOrigin = 'https://operations.example.test';
  const globalVars = await evaluatePartyBuildGlobalVars(shellOrigin);
  const partyRoot = path.join(workspaceRoot, partyDirectory);
  const source = await readFile(path.join(partyRoot, apiIndexFile), 'utf-8');
  const reader =
    /(?<reader>declare const ULTRAMODERN_SHELL_ORIGIN[\s\S]+?const shellOrigin = readShellOrigin\(\);)/u.exec(
      source
    )?.groups?.reader;
  assert.notEqual(
    reader,
    undefined,
    'compile the actual API origin-reader boundary'
  );
  const appToolsPath = require.resolve('@modern-js/app-tools/config', {
    paths: [partyRoot],
  });
  const rsbuildPath = require.resolve('@rsbuild/core', {
    paths: [appToolsPath],
  });
  const rspackModule: unknown = require(
    require.resolve('@rspack/core', { paths: [rsbuildPath] })
  );
  const rspackFixture = Schema.decodeUnknownSync(RspackModuleFixtureSchema)(
    rspackModule
  );
  const temporaryRoot = await mkdtemp(
    path.join(partyRoot, 'node_modules/.ontos-compiled-cors-')
  );
  try {
    const entry = path.join(temporaryRoot, 'reader.ts');
    await writeFile(
      entry,
      `import { Schema } from 'effect';\nimport { resolvePartyRegistryShellOrigin, partyRegistryCorsAllowedOrigins } from ${JSON.stringify(path.join(partyRoot, 'api/read-server-support.ts'))};\n${reader}\nexport const allowedOrigins = partyRegistryCorsAllowedOrigins(shellOrigin);\n`
    );
    const definePlugin = new rspackFixture.DefinePlugin(
      Object.fromEntries(
        Object.entries(globalVars).map(([key, value]) => [
          key,
          JSON.stringify(value),
        ])
      )
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
    const compiler = Schema.decodeUnknownSync(CompilerFixtureSchema)({
      close: compilerSource.close,
      run: compilerSource.run,
    });
    const runCompiler = promisify(compiler.run.bind(compilerSource));
    const closeCompiler = promisify(compiler.close.bind(compilerSource));
    try {
      const statsSource = await runCompiler();
      assert.ok(statsSource);
      const stats = Schema.decodeUnknownSync(CompilerStatsFixtureSchema)({
        hasErrors: statsSource.hasErrors,
        toString: statsSource.toString,
      });
      const hasErrors = stats.hasErrors.bind(statsSource)();
      const errorText = stats.toString.bind(statsSource)({
        all: false,
        errors: true,
      });
      assert.equal(hasErrors, false, errorText);
    } finally {
      await closeCompiler();
    }
    const compiledReaderModule: unknown = require(
      path.join(temporaryRoot, 'reader.cjs')
    );
    const compiledReader =
      Schema.decodeUnknownSync(CompiledReaderSchema)(compiledReaderModule);
    assert.deepEqual([...compiledReader.allowedOrigins], [shellOrigin]);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

const normalizedGeneratedSource = async (fileName: string, source: string) => {
  const result = await format(fileName, source, {
    singleQuote: true,
    sortImports: true,
  });
  assert.deepEqual(result.errors, []);
  return result.code.replaceAll(/^\s*\n/gmu, '');
};
const ScaffoldSemanticKindSchema = Schema.Literals(['backend', 'layout']);
type ScaffoldSemanticKind = typeof ScaffoldSemanticKindSchema.Type;
const scaffoldSemanticKinds = new Map<string, ScaffoldSemanticKind>([
  ['backend-federation.config.ts', 'backend'],
  ['src/routes/layout.tsx', 'layout'],
]);

// Evaluate only controlled scaffolds with inert dependency adapters in a separate Node process.
// No application server, deployment, real plugin or environment file is loaded by this harness.
const evaluateScaffoldSemantics = async (
  source: string,
  kind: ScaffoldSemanticKind
): Promise<string> => {
  const scratchRoot = path.join(workspaceRoot, '.scratch');
  await mkdir(scratchRoot, { recursive: true });
  const fixture = await mkdtemp(path.join(scratchRoot, 'scaffold-semantics-'));
  try {
    const effectUrl = pathToFileURL(require.resolve('effect')).href;
    const { code } = await transform(source, {
      define: {
        'import.meta.url': JSON.stringify('file:///fixture/config.ts'),
      },
      format: 'cjs',
      jsxFactory: 'element',
      loader: kind === 'layout' ? 'tsx' : 'ts',
    });
    const harnessPath = path.join(fixture, 'evaluate.mjs');
    await writeFile(
      harnessPath,
      `
import * as effect from ${JSON.stringify(effectUrl)};
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const kind = ${JSON.stringify(kind)};
const pluginNames = ['appTools', 'bffPlugin', 'i18nPlugin', 'tanstackRouterPlugin', 'moduleFederationPlugin', 'pluginTailwindcss', 'ultramodernReleaseEnvelopePlugin'];
const framework = {
  ...Object.fromEntries(pluginNames.map(name => [name, () => ({ name })])),
  builtinModules: [], createRequire: () => name => ({ version: name === 'effect/package.json' ? '4.0.0-rc.112' : '3.9.0-ultramodern.2' }),
  defineConfig: config => config, presetUltramodern: config => config,
  createModuleFederationConfig: config => config,
  getBuildConfigEnvironment: () => undefined, ultramodernLocalisedUrls: {},
};
const module = { exports: {} };
runInNewContext(${JSON.stringify(code)}, {
  module, exports: module.exports, URL,
  element: (type, props, ...children) => ({ type, props, children }),
  require: specifier => {
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
process.stdout.write(JSON.stringify(evidence));
`
    );
    return runNode([harnessPath]);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
};

const evaluatedInfrastructureSource = async (
  fileName: string,
  source: string,
  cloudflare: boolean,
  injection: Readonly<Record<string, string>>
): Promise<string> => {
  const partyRoot = path.join(workspaceRoot, partyDirectory);
  const result = await bundleSource({
    bundle: true,
    define: {
      'import.meta.resolve': '__resolve',
      'import.meta.url': JSON.stringify(
        pathToFileURL(path.join(partyRoot, fileName)).href
      ),
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
  });
  const code = result.outputFiles[0]?.text;
  assert.ok(code);
  const effectUrl = pathToFileURL(require.resolve('effect')).href;
  const buildIdentityUrl = pathToFileURL(
    createRequire(path.join(partyRoot, fileName)).resolve(
      '@app/shared-contracts/ultramodern-build'
    )
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
  appTools: plugin('appTools'), bffPlugin: plugin('bff'), i18nPlugin: plugin('i18n'),
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
process.stdout.write(JSON.stringify({ exported: module.exports, observations }, normalize));
`,
  ]);
};

void test('all published scaffold formats retain Party infrastructure behavior and source parity', async () => {
  await Promise.all(
    ['esm', 'esm-node', 'cjs'].map(async (moduleFormat) => {
      const generatorModulePath = generatorModulePathFor(moduleFormat);
      const descriptorPath = generatorModulePath('descriptors');
      const descriptorSource: unknown =
        moduleFormat === 'cjs'
          ? require(descriptorPath)
          : await import(pathToFileURL(descriptorPath).href);
      const descriptorModule = Schema.decodeUnknownSync(DescriptorModuleSchema)(
        descriptorSource
      );
      const componentPath = generatorModulePath('demo-components');
      const componentSource: unknown =
        moduleFormat === 'cjs'
          ? require(componentPath)
          : await import(pathToFileURL(componentPath).href);
      const componentModule = Schema.decodeUnknownSync(ComponentModuleSchema)(
        componentSource
      );
      const federationPath = generatorModulePath('module-federation/config');
      const federationSource: unknown =
        moduleFormat === 'cjs'
          ? require(federationPath)
          : await import(pathToFileURL(federationPath).href);
      const federationModule = Schema.decodeUnknownSync(
        FederationConfigModuleSchema
      )(federationSource);
      const buildModulePath = generatorModulePath(
        'module-federation/reexport-module'
      );
      const buildModuleSource: unknown =
        moduleFormat === 'cjs'
          ? require(buildModulePath)
          : await import(pathToFileURL(buildModulePath).href);
      const buildModule = Schema.decodeUnknownSync(BuildModuleGeneratorSchema)(
        buildModuleSource
      );
      const createVerticalDescriptor =
        descriptorModule.createVerticalDescriptor.bind(descriptorSource);
      const createLayout = componentModule.createLayout.bind(componentSource);
      const createAppModernConfig =
        federationModule.createAppModernConfig.bind(federationSource);
      const createBackendModuleFederationConfig =
        federationModule.createBackendModuleFederationConfig.bind(
          federationSource
        );
      const createUltramodernBuildModule =
        buildModule.createUltramodernBuildModule.bind(buildModuleSource);
      const descriptor: unknown = createVerticalDescriptor(partyId, 4102);
      Schema.asserts(WorkspaceAppFixtureSchema, descriptor);
      const app = { ...descriptor, exposes: {} };
      const generated = {
        'backend-federation.config.ts': Schema.decodeUnknownSync(Schema.String)(
          createBackendModuleFederationConfig(app)
        ),
        [buildMarkerFile]: Schema.decodeUnknownSync(Schema.String)(
          createUltramodernBuildModule('app', app)
        ),
        'modern.config.ts': Schema.decodeUnknownSync(Schema.String)(
          createAppModernConfig('app', app)
        ),
        'src/routes/layout.tsx': Schema.decodeUnknownSync(Schema.String)(
          createLayout(app.id)
        ),
      };
      await Promise.all(
        Object.entries(generated).map(async ([fileName, source]) => {
          const actual = await readFile(
            path.join(workspaceRoot, partyDirectory, fileName),
            'utf-8'
          );
          if (fileName === 'modern.config.ts' || fileName === buildMarkerFile) {
            const injections: Readonly<Record<string, string>>[] = [
              {},
              {
                ULTRAMODERN_BUILD_MARKER: 'executed-build',
                ULTRAMODERN_SOURCE_REVISION: 'a'.repeat(40),
              },
            ];
            await Promise.all(
              [false, true].flatMap((cloudflare) =>
                injections.map(async (injection) => {
                  const [expected, evaluated] = await Promise.all([
                    evaluatedInfrastructureSource(
                      fileName,
                      source,
                      cloudflare,
                      injection
                    ),
                    evaluatedInfrastructureSource(
                      fileName,
                      actual,
                      cloudflare,
                      injection
                    ),
                  ]);
                  const decode = Schema.decodeUnknownSync(
                    Schema.fromJsonString(Schema.Json)
                  );
                  assert.deepEqual(
                    decode(expected),
                    decode(evaluated),
                    `${moduleFormat}: ${fileName} must preserve evaluated configuration, build identity and plugin behavior`
                  );
                })
              )
            );
            return;
          }
          const kind = scaffoldSemanticKinds.get(fileName);
          assert.ok(kind, `Unknown scaffold ${fileName}`);
          assert.equal(
            await evaluateScaffoldSemantics(source, kind),
            await evaluateScaffoldSemantics(actual, kind),
            `${moduleFormat}: ${fileName} must preserve typed runtime, ownership and release gates`
          );
        })
      );
    })
  );
});

void test('all published scaffold formats generate the shared MicroVertical API baseline', async () => {
  await Promise.all(
    ['esm', 'esm-node', 'cjs'].map(async (moduleFormat) => {
      const generatorModulePath = generatorModulePathFor(moduleFormat);
      const descriptorPath = generatorModulePath('descriptors');
      const sharedApiPath = generatorModulePath(generatedSharedApiModule);
      const clientPath = generatorModulePath('api/client');
      const servicePath = generatorModulePath(generatedServiceModuleName);
      const descriptorSource: unknown =
        moduleFormat === 'cjs'
          ? require(descriptorPath)
          : await import(pathToFileURL(descriptorPath).href);
      const sharedApiSource: unknown =
        moduleFormat === 'cjs'
          ? require(sharedApiPath)
          : await import(pathToFileURL(sharedApiPath).href);
      const clientSource: unknown =
        moduleFormat === 'cjs'
          ? require(clientPath)
          : await import(pathToFileURL(clientPath).href);
      const serviceSource: unknown =
        moduleFormat === 'cjs'
          ? require(servicePath)
          : await import(pathToFileURL(servicePath).href);
      const descriptorModule = Schema.decodeUnknownSync(DescriptorModuleSchema)(
        descriptorSource
      );
      const sharedApiModule = Schema.decodeUnknownSync(
        SharedApiGeneratorSchema
      )(sharedApiSource);
      const clientModule = Schema.decodeUnknownSync(ApiClientGeneratorSchema)(
        clientSource
      );
      const serviceModule = Schema.decodeUnknownSync(ApiServiceGeneratorSchema)(
        serviceSource
      );
      const descriptor: unknown = descriptorModule.createVerticalDescriptor(
        inventoryStockId,
        4103
      );
      Schema.asserts(WorkspaceAppFixtureSchema, descriptor);
      const app = { ...descriptor, exposes: {} };
      const contract = sharedApiModule.createSharedApi(app, {
        scope: generatedProofScope,
      });
      const client = clientModule.createApiClient(
        app,
        generatedClientContractImport,
        { scope: generatedProofScope }
      );
      const service = serviceModule.createApiServiceEntry(
        app,
        generatedSharedApiImport,
        { scope: generatedProofScope }
      );

      assert.match(contract, /MicroVerticalBuildMarkerSchema/u, moduleFormat);
      assert.match(contract, /MicroVerticalReadinessSchema/u, moduleFormat);
      assert.match(
        contract,
        /createMicroVerticalOperationContext/u,
        moduleFormat
      );
      assert.match(
        contract,
        /@generated-proof\/shared-contracts/u,
        moduleFormat
      );
      assert.doesNotMatch(
        contract,
        /export interface OperationContext/u,
        moduleFormat
      );
      assert.match(
        client,
        /client\.foundation\.readiness\(\{\}\)/u,
        moduleFormat
      );
      assert.doesNotMatch(
        client,
        /client\.inventoryStock\.readiness/u,
        moduleFormat
      );
      assert.match(service, /microVerticalOperationAttributes/u, moduleFormat);
      assert.match(
        service,
        /@generated-proof\/shared-contracts/u,
        moduleFormat
      );
      assert.doesNotMatch(service, /const operationAttributes/u, moduleFormat);
      const generatedBaselineExpectation = {
        additionalPaths: {},
        apiPrefix: `/${inventoryStockId}-api`,
        basePath: `/${inventoryStockId}-api/${inventoryStockId}`,
        effectClientPackage,
        ownerId: inventoryStockId,
        readinessPath: `/${inventoryStockId}-api/${inventoryStockId}/readiness`,
        sharedContractsPackage: generatedSharedContractsPackage,
      } as const;
      assert.equal(
        microVerticalApiBaselineViolation(
          inventoryStockId,
          contract,
          generatedBaselineExpectation
        ),
        undefined
      );

      const customStemApp = {
        ...app,
        api: {
          ...app.api,
          prefix: warehouseApiPrefix,
          stem: warehouseItemsApiStem,
        },
      };
      const customStemContract = sharedApiModule.createSharedApi(
        customStemApp,
        { scope: generatedProofScope }
      );
      assert.equal(
        microVerticalApiBaselineViolation(
          warehouseItemsApiStem,
          customStemContract,
          {
            ...generatedBaselineExpectation,
            apiPrefix: warehouseApiPrefix,
            basePath: `/warehouse-api/${warehouseItemsApiStem}`,
            readinessPath: `/warehouse-api/${warehouseItemsApiStem}/readiness`,
          }
        ),
        undefined
      );

      const checkoutDescriptor: unknown =
        descriptorModule.createVerticalDescriptor(checkoutId, 4105);
      Schema.asserts(WorkspaceAppFixtureSchema, checkoutDescriptor);
      const checkoutContract = sharedApiModule.createSharedApi(
        {
          ...checkoutDescriptor,
          exposes: {},
        },
        { scope: generatedProofScope }
      );
      const checkoutClient = clientModule.createApiClient(
        checkoutDescriptor,
        generatedClientContractImport,
        { scope: generatedProofScope }
      );
      assert.equal(
        microVerticalApiBaselineViolation(checkoutId, checkoutContract, {
          additionalPaths: {
            checkoutCartPath: '/checkout-api/checkout/cart',
          },
          ownerId: checkoutId,
          sharedContractsPackage: generatedSharedContractsPackage,
        }),
        undefined,
        `${moduleFormat} checkout cart operations must retain baseline validation`
      );
      assert.match(
        checkoutClient,
        /client\.foundation\.readiness\(\{\}\)/u,
        moduleFormat
      );
      assert.doesNotMatch(
        checkoutClient,
        /client\.checkout\.readiness/u,
        moduleFormat
      );
    })
  );
});

/**
 * Generator proofs compile real output, so each one gets its own scratch root inside the
 * shared-contracts package and drops it when the owning test finishes.
 */
const makeProofRoot = async (
  context: TestContext,
  prefix: string
): Promise<string> => {
  const scratchRoot = path.join(
    workspaceRoot,
    'packages/shared-contracts/.scratch'
  );
  await mkdir(scratchRoot, { recursive: true });
  const proofRoot = await mkdtemp(path.join(scratchRoot, `${prefix}-`));
  context.after(async (): Promise<void> => {
    await rm(proofRoot, { force: true, recursive: true });
  });
  return proofRoot;
};

void test('all published scaffold formats emit the executable AST baseline validator', async (context) => {
  const proofRoot = await makeProofRoot(
    context,
    'generated-baseline-validator-proof'
  );
  const expectedHelper = await readFile(
    path.join(workspaceRoot, 'scripts/microvertical-api-baseline-boundary.mts'),
    'utf-8'
  );

  await Promise.all(
    ['esm', 'esm-node', 'cjs'].map(async (moduleFormat) => {
      const extension = moduleFormat === 'cjs' ? 'cjs' : 'js';
      const modulePath = path.join(
        generatorRoot,
        `dist/${moduleFormat}/ultramodern-workspace/workspace-scripts.${extension}`
      );
      const moduleSource: unknown =
        moduleFormat === 'cjs'
          ? require(modulePath)
          : await import(pathToFileURL(modulePath).href);
      const generator = Schema.decodeUnknownSync(
        WorkspaceScriptsGeneratorSchema
      )(moduleSource);
      const artifacts = generator.migratedWorkspaceScriptArtifacts({
        hasBackendSurface: true,
        shellOnly: false,
      });
      const helper = artifacts.find(
        ({ relativePath }) =>
          relativePath === 'scripts/microvertical-api-baseline-boundary.mts'
      );
      const checker = artifacts.find(
        ({ relativePath }) => relativePath === apiBoundaryCheckerPath
      );
      assert.ok(helper, `${moduleFormat} must emit the AST baseline helper`);
      assert.ok(checker, `${moduleFormat} must emit the API checker`);
      assert.equal(
        helper.content,
        expectedHelper,
        `${moduleFormat} must emit byte-exact baseline source`
      );
      assert.equal(
        await normalizedGeneratedSource(
          'microvertical-api-baseline-boundary.mts',
          helper.content
        ),
        await normalizedGeneratedSource(
          'microvertical-api-baseline-boundary.mts',
          expectedHelper
        ),
        `${moduleFormat} must emit the exact repository validator`
      );
      const formatRoot = path.join(proofRoot, moduleFormat);
      await writeText(formatRoot, helper.relativePath, helper.content);
      await writeText(formatRoot, checker.relativePath, checker.content);
      assert.match(checker.content, /microVerticalApiBaselineViolation/u);
      assert.match(
        runNode([path.join(formatRoot, checker.relativePath)], {
          env: { ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
        }),
        /UltraModern API boundary check passed/u,
        moduleFormat
      );

      const generatorModulePath = generatorModulePathFor(moduleFormat);
      const descriptorSource: unknown =
        moduleFormat === 'cjs'
          ? require(generatorModulePath('descriptors'))
          : await import(
              pathToFileURL(generatorModulePath('descriptors')).href
            );
      const sharedApiSource: unknown =
        moduleFormat === 'cjs'
          ? require(generatorModulePath(generatedSharedApiModule))
          : await import(
              pathToFileURL(generatorModulePath(generatedSharedApiModule)).href
            );
      const descriptorModule = Schema.decodeUnknownSync(DescriptorModuleSchema)(
        descriptorSource
      );
      const sharedApiModule = Schema.decodeUnknownSync(
        SharedApiGeneratorSchema
      )(sharedApiSource);
      const checkoutDescriptor = descriptorModule.createVerticalDescriptor(
        'shopping',
        4105
      );
      const checkoutStemDescriptor = {
        ...checkoutDescriptor,
        api: { prefix: checkoutApiPrefix, stem: checkoutId },
        exposes: {},
      };
      const servicePath = generatorModulePath(generatedServiceModuleName);
      const serviceSource: unknown =
        moduleFormat === 'cjs'
          ? require(servicePath)
          : await import(pathToFileURL(servicePath).href);
      const serviceModule = Schema.decodeUnknownSync(ApiServiceGeneratorSchema)(
        serviceSource
      );
      const checkoutWorkspace = path.join(formatRoot, 'checkout-workspace');
      await writeText(
        checkoutWorkspace,
        'verticals/shopping/shared/api.ts',
        sharedApiModule.createSharedApi(checkoutStemDescriptor, {
          scope: generatedProofScope,
        })
      );
      await writeText(
        checkoutWorkspace,
        'verticals/shopping/api/index.ts',
        serviceModule.createApiServiceEntry(
          checkoutStemDescriptor,
          generatedSharedApiImport,
          { scope: generatedProofScope }
        )
      );
      await writeText(
        checkoutWorkspace,
        'verticals/shopping/src/api/checkout-client.ts',
        'export const checkoutClient = true;\n'
      );
      await writeText(
        checkoutWorkspace,
        'verticals/shopping/modern.config.ts',
        `export default {
  bff: {
    runtimeFramework: 'effect',
    effect: { entry: './api/index', strictEffectApproach: true },
  },
};
`
      );
      await writeJson(checkoutWorkspace, 'verticals/shopping/package.json', {
        exports: {
          './api': './shared/api.ts',
          './api/client': './src/api/checkout-client.ts',
        },
      });
      await writeJson(
        checkoutWorkspace,
        'packages/shared-contracts/package.json',
        {
          name: generatedSharedContractsPackage,
        }
      );
      await writeJson(checkoutWorkspace, topologyReferencePath, {
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
      await writeText(
        checkoutWorkspace,
        'apps/shell-super-app/src/api/vertical-clients.ts',
        'export const verticalClients = {};\n'
      );
      const invalidApiSource = `import { Schema } from 'effect';
export const response = new Response('generated');
export const responseSchema = Schema.Unknown;
`;
      await writeText(
        checkoutWorkspace,
        'verticals/shopping/dist-cloudflare/api/index.js',
        invalidApiSource
      );
      await writeText(
        checkoutWorkspace,
        'apps/shell-super-app/dist-cloudflare/api/index.js',
        invalidApiSource
      );
      assert.match(
        runNode([path.join(formatRoot, checker.relativePath)], {
          env: { ULTRAMODERN_WORKSPACE_ROOT: checkoutWorkspace },
        }),
        /UltraModern API boundary check passed/u,
        `${moduleFormat} checkout workspace`
      );
      const authoredApiPath = 'verticals/shopping/api/invalid.ts';
      await writeText(checkoutWorkspace, authoredApiPath, invalidApiSource);
      const authoredResult = spawnSync(
        process.execPath,
        [path.join(formatRoot, checker.relativePath)],
        {
          encoding: 'utf-8',
          env: { ULTRAMODERN_WORKSPACE_ROOT: checkoutWorkspace },
        }
      );
      assert.equal(authoredResult.status, 1, moduleFormat);
      assert.match(
        authoredResult.stderr,
        /verticals\/shopping\/api\/invalid\.ts: API modules must not hand-build Response objects/u,
        moduleFormat
      );
      assert.match(
        authoredResult.stderr,
        /verticals\/shopping\/api\/invalid\.ts: API modules must use concrete request, response and error schemas/u,
        moduleFormat
      );
      assert.doesNotMatch(
        authoredResult.stderr,
        /dist-cloudflare/u,
        moduleFormat
      );
    })
  );
});

void test('two generated MicroVertical root contracts execute invariant readiness endpoints', async (context) => {
  const proofRoot = await mkdtemp(
    path.join(workspaceRoot, `verticals/${partyId}/.generated-api-baseline-`)
  );
  context.after(async (): Promise<void> => {
    await rm(proofRoot, { force: true, recursive: true });
  });
  const descriptorSource: unknown = await import(
    pathToFileURL(
      path.join(
        generatorRoot,
        'dist/esm-node/ultramodern-workspace/descriptors.js'
      )
    ).href
  );
  const sharedApiSource: unknown = await import(
    pathToFileURL(
      path.join(
        generatorRoot,
        'dist/esm-node/ultramodern-workspace/api/shared.js'
      )
    ).href
  );
  const apiServiceSource: unknown = await import(
    pathToFileURL(
      path.join(
        generatorRoot,
        'dist/esm-node/ultramodern-workspace/api/service.js'
      )
    ).href
  );
  const apiClientSource: unknown = await import(
    pathToFileURL(
      path.join(
        generatorRoot,
        'dist/esm-node/ultramodern-workspace/api/client.js'
      )
    ).href
  );
  const descriptorModule = Schema.decodeUnknownSync(DescriptorModuleSchema)(
    descriptorSource
  );
  const sharedApiModule = Schema.decodeUnknownSync(SharedApiGeneratorSchema)(
    sharedApiSource
  );
  const apiServiceModule = Schema.decodeUnknownSync(ApiServiceGeneratorSchema)(
    apiServiceSource
  );
  const apiClientModule = Schema.decodeUnknownSync(ApiClientGeneratorSchema)(
    apiClientSource
  );
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

  const generatedProofs = await Promise.all(
    fixtures.map(async (fixture) => {
      const descriptor: unknown = descriptorModule.createVerticalDescriptor(
        fixture.id,
        fixture.port
      );
      Schema.asserts(WorkspaceAppFixtureSchema, descriptor);
      assert.ok(descriptor.api);
      const generatedDescriptor = {
        ...descriptor,
        api: { ...descriptor.api, prefix: fixture.prefix, stem: fixture.stem },
        exposes: {},
      };
      const contract = sharedApiModule.createSharedApi(generatedDescriptor, {
        scope: 'app',
      });
      const basePath = `${fixture.prefix}/${fixture.stem}`;
      assert.equal(
        microVerticalApiBaselineViolation(fixture.stem, contract, {
          additionalPaths:
            fixture.stem === checkoutId
              ? { checkoutCartPath: `${basePath}/cart` }
              : {},
          apiPrefix: fixture.prefix,
          basePath,
          effectClientPackage,
          ownerId: fixture.id,
          readinessPath: `${basePath}/readiness`,
          sharedContractsPackage: '@app/shared-contracts',
        }),
        undefined
      );
      const ownerRoot = path.join(proofRoot, fixture.id);
      await writeText(ownerRoot, 'shared/api.ts', contract);
      await writeText(
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
`
      );
      await writeText(
        ownerRoot,
        apiIndexFile,
        apiServiceModule.createApiServiceEntry(
          generatedDescriptor,
          generatedSharedApiImport,
          { scope: 'app' }
        )
      );
      const clientEntryPath = `src/api/${fixture.id}-client.ts`;
      await writeText(
        ownerRoot,
        clientEntryPath,
        apiClientModule.createApiClient(
          generatedDescriptor,
          generatedClientContractImport,
          { scope: 'app' }
        )
      );
      await writeJson(ownerRoot, 'package.json', { type: 'module' });
      await writeJson(ownerRoot, tsconfigFile, {
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
          path.join(
            workspaceRoot,
            'node_modules/@typescript/native-preview/bin/tsc'
          ),
          '-p',
          ownerRoot,
        ],
        { cwd: workspaceRoot }
      );
      const generatedModuleSource: unknown = await import(
        pathToFileURL(path.join(ownerRoot, apiIndexFile)).href
      );
      const generatedClientSource: unknown = await import(
        pathToFileURL(path.join(ownerRoot, clientEntryPath)).href
      );
      const generatedModule = Schema.decodeUnknownSync(
        GeneratedApiRuntimeModuleSchema
      )(generatedModuleSource);
      const generatedClient = Schema.decodeUnknownSync(
        Schema.Record(Schema.String, Schema.Unknown)
      )(generatedClientSource);
      const getReadiness = Schema.decodeUnknownSync(
        callable<GetGeneratedReadiness>()
      )(generatedClient[fixture.readinessExport]);
      const runEffectRequest = Schema.decodeUnknownSync(
        callable<RunGeneratedEffect>()
      )(generatedClient.runEffectRequest);
      return { fixture, generatedModule, getReadiness, runEffectRequest };
    })
  );
  const handlers = new Map<string, GeneratedHttpHandler>(
    generatedProofs.map(({ fixture, generatedModule }) => [
      fixture.stem,
      generatedModule.default.createHandler(),
    ])
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const stem = new URL(request.url).pathname
      .split('/')
      .find((segment) => segment.length > 0);
    const handler = stem === undefined ? undefined : handlers.get(stem);
    return handler === undefined
      ? new Response(undefined, { status: 503 })
      : await handler.handler(request);
  };
  let readinessValues: (typeof MicroVerticalReadinessSchema.Type)[];
  try {
    readinessValues = await Promise.all(
      generatedProofs.map(
        async ({ fixture, getReadiness, runEffectRequest }) => {
          const handler = handlers.get(fixture.stem);
          assert.ok(handler);
          const directResponse = await handler.handler(
            new Request(`http://localhost/${fixture.stem}/readiness`)
          );
          assert.equal(directResponse.status, 200);
          const directReadiness = Schema.decodeUnknownSync(
            MicroVerticalReadinessSchema
          )(await directResponse.json());
          const clientReadiness = Schema.decodeUnknownSync(
            MicroVerticalReadinessSchema
          )(
            await runEffectRequest(
              getReadiness({ baseUrl: 'http://localhost' })
            )
          );
          assert.deepEqual(clientReadiness, directReadiness);
          return clientReadiness;
        }
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all(
      [...handlers.values()].map(async (handler) => await handler.dispose())
    );
  }

  const [firstReadiness, secondReadiness] = readinessValues;
  assert.ok(firstReadiness !== undefined);
  assert.ok(secondReadiness !== undefined);
  assert.notEqual(firstReadiness.marker.appId, secondReadiness.marker.appId);
  assert.equal('kind' in firstReadiness.marker, false);
  assert.equal('schemaVersion' in firstReadiness.marker, false);
  assert.deepEqual(firstReadiness.checks, secondReadiness.checks);
  assert.equal(firstReadiness.status, secondReadiness.status);
  assert.equal(firstReadiness.versionSkew, secondReadiness.versionSkew);
});

void test('generated shared-contracts baseline template is lint-clean and type-safe', async (context) => {
  const proofRoot = await makeProofRoot(
    context,
    'generated-baseline-template-proof'
  );
  const templateSource = await readFile(
    path.join(generatorRoot, 'templates/packages/shared-contracts-index.ts'),
    'utf-8'
  );
  const baselineEnd = templateSource.indexOf(
    'export type UltramodernPublicSitemapChangeFrequency'
  );
  assert.notEqual(baselineEnd, -1);
  const generatedSource = templateSource.slice(0, baselineEnd);
  await writeText(proofRoot, generatedBaselineTemplateEntry, generatedSource);
  await writeJson(proofRoot, tsconfigFile, {
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
  runNode(
    [path.join(workspaceRoot, 'node_modules/oxlint/bin/oxlint'), generatedFile],
    {
      cwd: workspaceRoot,
    }
  );
  runNode(
    [
      path.join(
        workspaceRoot,
        'node_modules/@typescript/native-preview/bin/tsc'
      ),
      '-p',
      proofRoot,
    ],
    { cwd: workspaceRoot }
  );
});

void test('baseline imports require values even with comments after the type keyword', async () => {
  const contract = await readFile(
    path.join(workspaceRoot, `verticals/${partyId}/shared/api.ts`),
    'utf-8'
  );
  assert.equal(microVerticalApiBaselineViolation(partyId, contract), undefined);
  for (const declaration of [
    'import type ',
    'import type/* comment */ ',
    'import /* comment */ ',
  ]) {
    const mutated = contract.replace(
      'import {\n  MicroVerticalBuildMarkerSchema,',
      `${declaration}{\n  MicroVerticalBuildMarkerSchema,`
    );
    const violation = microVerticalApiBaselineViolation(partyId, mutated);
    if (declaration.startsWith('import type')) {
      assert.match(violation ?? '', /import exact baseline primitives/u);
    } else {
      assert.equal(violation, undefined);
    }
  }
});

void test('repository checker respects custom readiness prefixes and diagnoses missing topology', async (context) => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), 'ontos-baseline-topology-')
  );
  context.after(async (): Promise<void> => {
    await rm(fixture, { force: true, recursive: true });
  });
  const generatorModulePath = (name: string): string =>
    path.join(generatorRoot, `dist/esm-node/ultramodern-workspace/${name}.js`);
  const descriptors = Schema.decodeUnknownSync(DescriptorModuleSchema)(
    await import(pathToFileURL(generatorModulePath('descriptors')).href)
  );
  const shared = Schema.decodeUnknownSync(SharedApiGeneratorSchema)(
    await import(
      pathToFileURL(generatorModulePath(generatedSharedApiModule)).href
    )
  );
  const service = Schema.decodeUnknownSync(ApiServiceGeneratorSchema)(
    await import(
      pathToFileURL(generatorModulePath(generatedServiceModuleName)).href
    )
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
      '$<foundation>;\n\n'
    )
    .replace(
      /(?<declaration>export const warehouseItemsOperationContexts = \{)[\s\S]*?(?= {2}readiness:)/u,
      '$<declaration>\n'
    );
  await writeText(fixture, `${ownerPath}/shared/api.ts`, readinessContract);
  await writeText(
    fixture,
    `${ownerPath}/api/index.ts`,
    service.createApiServiceEntry(app, generatedSharedApiImport, {
      scope: 'app',
    })
  );
  await writeText(
    fixture,
    `${ownerPath}/src/api/warehouse-client.ts`,
    'export const client = true;\n'
  );
  await writeJson(fixture, `${ownerPath}/package.json`, { exports: {} });
  const api = {
    basePath: '/warehouse-api/warehouse-items',
    bff: { prefix: warehouseApiPrefix, strictEffectApproach: true },
    readiness: { endpoint: '/warehouse-items/readiness' },
    runtime: 'effect',
    serverEntry: `${ownerPath}/api/index.ts`,
  };
  const vertical = { api, id: inventoryStockId, path: ownerPath };
  await writeJson(fixture, topologyReferencePath, { verticals: [vertical] });
  const check = (): string =>
    runNode([path.join(workspaceRoot, apiBoundaryCheckerPath)], {
      env: { ULTRAMODERN_WORKSPACE_ROOT: fixture },
    });
  assert.match(check(), /UltraModern API boundary check passed/u);
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
      verticals: [
        { ...vertical, api: { ...api, bff: { strictEffectApproach: true } } },
      ],
    },
  ];
  for (const entry of cases) {
    writeFileSync(
      path.join(fixture, topologyReferencePath),
      JSON.stringify({ verticals: entry.verticals })
    );
    const result = spawnSync(
      process.execPath,
      [path.join(workspaceRoot, apiBoundaryCheckerPath)],
      {
        encoding: 'utf-8',
        env: { ULTRAMODERN_WORKSPACE_ROOT: fixture },
      }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, entry.expected);
    assert.doesNotMatch(result.stderr, /exact owner and API path metadata/u);
  }
});

void test('static validation rejects a MicroVertical root contract without readiness baseline', async () => {
  const contract = await readFile(
    path.join(workspaceRoot, `verticals/${partyId}/shared/api.ts`),
    'utf-8'
  );
  assert.equal(microVerticalApiBaselineViolation(partyId, contract), undefined);
  const readinessEndpointDecoy =
    "HttpApiEndpoint.get('readiness', '/party-registry/readiness', { success: partyRegistryReadinessSchema })";
  const foundationComposition = '.addHttpApi(partyRegistryFoundationApi)';
  const sharedBaselineImport = `import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@app/shared-contracts';`;
  for (const [label, mutated, expected] of [
    [
      'renamed readiness endpoint',
      contract.replace(
        "HttpApiEndpoint.get('readiness'",
        "HttpApiEndpoint.get('health'"
      ),
      /exact readiness endpoint/u,
    ],
    [
      'foreign readiness schema fields',
      contract.replace(
        '...MicroVerticalReadinessSchema.fields,',
        '...Schema.Unknown.fields,'
      ),
      /shared readiness schema/u,
    ],
    [
      'readiness success schema commented out',
      contract.replace(
        'success: partyRegistryReadinessSchema',
        'success: Schema.String /* success: partyRegistryReadinessSchema */'
      ),
      /exact readiness endpoint/u,
    ],
    [
      'baseline primitives imported from a copied package',
      contract.replace(
        "from '@app/shared-contracts';",
        "from '@app/copied-contracts';"
      ),
      /import exact baseline primitives from the shared contracts package/u,
    ],
    [
      'Effect API primitives imported from a foreign client',
      contract.replace(
        "from '@modern-js/plugin-bff/effect-client';",
        "from '@evil/fake-effect-client';"
      ),
      /import exact Effect API primitives from the framework client package/u,
    ],
    [
      'baseline primitives redefined locally',
      contract.replace(
        sharedBaselineImport,
        `const MicroVerticalBuildMarkerSchema = Schema.Struct({ copied: Schema.String });
const MicroVerticalReadinessSchema = Schema.Struct({ copied: Schema.String });
const createMicroVerticalOperationContext = <Value>(value: Value): Value => value;`
      ),
      /import exact baseline primitives from the shared contracts package/u,
    ],
    [
      'renamed readiness endpoint with a decoy API name',
      contract
        .replace(
          "HttpApiEndpoint.get('readiness'",
          "HttpApiEndpoint.get('health'"
        )
        .replace(
          "HttpApi.make('PartyRegistryFoundationApi')",
          `HttpApi.make("${readinessEndpointDecoy}")`
        ),
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
  .pipe(() => HttpApi.make('DiscardedPartyRegistryApi'))`
      ),
      /explicitly compose its readiness foundation API/u,
    ],
    [
      'foundation endpoint discarded by a pipe',
      contract.replace(
        `  ),
);`,
        `  ),
).pipe(() => HttpApi.make('DiscardedPartyRegistryFoundationApi'));`
      ),
      /directly compose its exact readiness endpoint/u,
    ],
    [
      'missing foundation composition with a decoy API name',
      contract
        .replace(foundationComposition, '')
        .replace(
          "HttpApi.make('PartyRegistryApi')",
          "HttpApi.make('.addHttpApi(partyRegistryFoundationApi)')"
        ),
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
      contract.replace(
        '...MicroVerticalBuildMarkerSchema.fields,',
        'build: Schema.String,'
      ),
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
);`
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
        'export const partyRegistryReadinessSchema = MicroVerticalReadinessSchema;'
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
)`
      ),
      /explicitly compose its readiness foundation API/u,
    ],
    [
      'decoy API declaration shadowed by an uncomposed API',
      `${contract.replace(
        'export const partyRegistryApi =',
        'export const partyRegistryApiDecoy ='
      )}\nexport const partyRegistryApi = HttpApi.make('PartyRegistryApi');\n`,
      /explicitly compose its readiness foundation API/u,
    ],
    [
      'decoy foundation API declaration without a readiness endpoint',
      `${contract.replace(
        'export const partyRegistryFoundationApi =',
        'export const partyRegistryFoundationApiDecoy ='
      )}\nexport const partyRegistryFoundationApi = HttpApi.make('PartyRegistryFoundationApi');\n`,
      /exact readiness endpoint/u,
    ],
    [
      'decoy contract declaration without path metadata',
      `${contract.replace(
        'export const partyRegistryApiContract =',
        'export const partyRegistryApiContractDecoy ='
      )}\nexport const partyRegistryApiContract = { ownerId: 'party-registry' };\n`,
      /exact owner and API path metadata/u,
    ],
    [
      'build marker overriding a shared field',
      contract.replace(
        '...MicroVerticalBuildMarkerSchema.fields,',
        '...MicroVerticalBuildMarkerSchema.fields,\n  build: Schema.Number,'
      ),
      /without overriding shared fields/u,
    ],
    [
      'foreign AppId schema',
      contract.replace(
        "const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));",
        'const AppIdSchema = Schema.Number;'
      ),
      /shared build marker schema/u,
    ],
    [
      'readiness schema overriding a shared field',
      contract.replace(
        '...MicroVerticalReadinessSchema.fields,',
        '...MicroVerticalReadinessSchema.fields,\n  status: Schema.String,'
      ),
      /without overriding shared fields/u,
    ],
    [
      'renamed foundation group',
      contract.replace(
        "HttpApiGroup.make('foundation')",
        "HttpApiGroup.make('not-foundation')"
      ),
      /exact readiness endpoint and foundation identity/u,
    ],
    [
      'renamed root API',
      contract.replace(
        "HttpApi.make('PartyRegistryApi')",
        "HttpApi.make('WrongApi')"
      ),
      /explicitly compose its readiness foundation API/u,
    ],
    [
      'renamed operation contexts',
      contract.replace(
        'export const partyRegistryOperationContexts =',
        'export const renamedOperationContexts ='
      ),
      /construct every operation with the shared context constructor/u,
    ],
    [
      'foreign operation id',
      contract.replace(
        "operationId: 'PartyRegistryApi:/reads/ares-lookup'",
        "operationId: 'WrongApi:unrelated'"
      ),
      /construct every operation with the shared context constructor/u,
    ],
    [
      'foreign route path',
      contract.replace(
        "routePath: '/reads/ares-lookup'",
        "routePath: '/not-an-endpoint'"
      ),
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
  },`
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
      contract.replace(
        "  basePath: '/party-registry-api/party-registry',\n",
        ''
      ),
      /exact owner and API path metadata/u,
    ],
    [
      'missing ownerId',
      contract.replace("  ownerId: 'party-registry',\n", ''),
      /exact owner and API path metadata/u,
    ],
    [
      'wrong apiPrefix',
      contract.replace(
        "apiPrefix: '/party-registry-api'",
        "apiPrefix: '/evil-api'"
      ),
      /exact owner and API path metadata/u,
    ],
    [
      'wrong basePath',
      contract.replace(
        "basePath: '/party-registry-api/party-registry'",
        "basePath: '/party-registry-api/evil'"
      ),
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
        "readinessPath: '/evil-prefix/party-registry/readiness'"
      ),
      /exact owner and API path metadata/u,
    ],
    [
      'coordinated topology drift',
      contract
        .replace("apiPrefix: '/party-registry-api'", "apiPrefix: '/evil-api'")
        .replace(
          "basePath: '/party-registry-api/party-registry'",
          "basePath: '/evil-api/party-registry'"
        )
        .replace(
          "readinessPath: '/party-registry-api/party-registry/readiness'",
          "readinessPath: '/evil-api/party-registry/readiness'"
        ),
      /exact owner and API path metadata/u,
    ],
    [
      'forbidden credential metadata',
      contract.replace(
        partyReadinessMetadataLine,
        `${partyReadinessMetadataLine}\n  credential: 'secret',`
      ),
      /exact owner and API path metadata/u,
    ],
    [
      'forbidden credential path metadata',
      contract.replace(
        partyReadinessMetadataLine,
        `${partyReadinessMetadataLine}\n  credentialPath: '/party-registry-api/party-registry/secret',`
      ),
      /exact owner and API path metadata/u,
    ],
    [
      'unknown path metadata',
      contract.replace(
        partyReadinessMetadataLine,
        `${partyReadinessMetadataLine}\n  unknownPath: '/party-registry-api/party-registry/unknown',`
      ),
      /exact owner and API path metadata/u,
    ],
    [
      'spread metadata',
      contract.replace(
        'export const partyRegistryApiContract = {',
        'const copiedMetadata = {};\nexport const partyRegistryApiContract = {\n  ...copiedMetadata,'
      ),
      /exact owner and API path metadata/u,
    ],
  ] as const) {
    assert.match(
      microVerticalApiBaselineViolation(partyId, mutated) ?? '',
      expected,
      label
    );
  }
});

void test('MicroVertical baseline validation resolves an API stem independently from its directory', () => {
  assert.equal(
    configuredMicroVerticalApiStem('verticals/inventory', [
      {
        api: { readiness: { endpoint: `/${warehouseItemsApiStem}/readiness` } },
        id: 'inventory',
        path: 'verticals/inventory',
      },
    ]),
    warehouseItemsApiStem
  );
});

void test('full-stack Party Registry keeps backend and Contacts component tests executable', async () => {
  const packageJson = await readJson(
    PackageJsonSchema,
    path.join(workspaceRoot, 'verticals/party-registry/package.json')
  );
  assert.equal(
    packageJson.scripts['test:component'],
    'rstest --config rstest.config.ts'
  );
  assert.equal(
    packageJson.scripts['test:unit'],
    'node --test tests/unit/*.test.ts'
  );
  assert.equal(
    packageJson.scripts['test:integration'],
    'node --test tests/integration/*.test.ts'
  );
  assert.match(
    await readFile(
      path.join(workspaceRoot, 'verticals/party-registry/rstest.config.ts'),
      'utf-8'
    ),
    /tests\/components/u
  );
});
const cloudflareProofModule: unknown = await import(
  pathToFileURL(
    path.join(
      generatorRoot,
      'templates/workspace-scripts/ultramodern-cloudflare-proof.mjs'
    )
  ).href
);
const cloudflareProof = Schema.decodeUnknownSync(CloudflareProofModuleSchema)(
  cloudflareProofModule
);
const validateCloudflareApp = cloudflareProof.validateApp.bind(
  cloudflareProofModule
);
const validateApp = async (
  app: ApiOnlyAppFixture,
  applicationPublicUrl: string
): Promise<typeof CloudflareEvidenceSchema.Type> => {
  const output: unknown = await validateCloudflareApp(
    app,
    applicationPublicUrl
  );
  return Schema.decodeUnknownSync(CloudflareEvidenceSchema)(output);
};
const federationValidationModule: unknown = await import(
  pathToFileURL(
    path.join(
      generatorRoot,
      'dist/esm-node/ultramodern-workspace/mf-validation/validate.js'
    )
  ).href
);
const federationValidation = Schema.decodeUnknownSync(
  ModuleFederationValidationModuleSchema
)(federationValidationModule);
const validateInstalledModuleFederationTypes =
  federationValidation.validateModuleFederationTypes.bind(
    federationValidationModule
  );
const validateModuleFederationTypes = (input: {
  readonly appDirs: readonly string[];
  readonly workspaceRoot: string;
}): typeof ModuleFederationValidationResultSchema.Type => {
  const output: unknown = validateInstalledModuleFederationTypes(input);
  return Schema.decodeUnknownSync(ModuleFederationValidationResultSchema)(
    output
  );
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
      jsonSmokeChecks: [
        { expect: { status: 'ready' }, id: 'api', route: apiSmokePath },
      ],
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

const mockPublicResponses = (context: TestContext, failedPath?: string) => {
  const requested: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const route = new URL(String(input)).pathname;
    requested.push(route);
    if (route === failedPath) {
      return new Response('unavailable', { status: 503 });
    }
    const body =
      route === mfManifestPath
        ? { metaData: { publicPath: `${publicUrl}/` } }
        : { marker: { build: buildMarker }, status: 'ready' };
    return Response.json(body, {
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  return requested;
};

void test('API-only proof keeps manifest, readiness, service-binding and JSON proofs without invented pages/locales', async (context) => {
  const requested = mockPublicResponses(context);
  const evidence = await validateApp(apiOnlyApp(), publicUrl);
  assert.deepEqual(requested, [
    mfManifestPath,
    readinessPath,
    '/binding',
    apiSmokePath,
  ]);
  for (const proof of [
    'mf-manifest',
    'api-marker',
    'delivery-unit-api-marker',
    'service-binding-api-marker',
    'json-smoke-value',
  ]) {
    assert.ok(
      evidence.assertions.some(
        (entry) => entry.type === proof && entry.status === 'pass'
      )
    );
  }
  assert.equal(
    evidence.assertions.some(
      (entry) => entry.type === 'ssr' || entry.type === 'i18n-marker'
    ),
    false
  );
});

for (const [route, error] of [
  [mfManifestPath, /MF manifest returned HTTP 503/u],
  [readinessPath, /Effect readiness returned HTTP 503/u],
  ['/binding', /service binding PARTY_WORKER returned HTTP 503/u],
  [apiSmokePath, /JSON smoke api returned HTTP 503/u],
] as const) {
  void test(`API-only proof still fails closed for ${route}`, async (context) => {
    mockPublicResponses(context, route);
    await assert.rejects(validateApp(apiOnlyApp(), publicUrl), error);
  });
}

void test('full-stack declared SSR remains mandatory', async (context) => {
  const requested = mockPublicResponses(context, '/en');
  const app = apiOnlyApp();
  Object.assign(app.deploy.cloudflare.routes, {
    locale: localePath,
    ssr: '/en',
  });
  await assert.rejects(
    validateApp(app, publicUrl),
    /SSR route returned HTTP 503/u
  );
  assert.deepEqual(requested, ['/en']);
});

void test('declared namespace locale remains mandatory independently of SSR', async (context) => {
  const requested = mockPublicResponses(context, localePath);
  const app = apiOnlyApp();
  Object.assign(app.deploy.cloudflare.routes, { locale: localePath });
  await assert.rejects(
    validateApp(app, publicUrl),
    /locale JSON returned HTTP 503/u
  );
  assert.deepEqual(requested, [mfManifestPath, localePath]);
});

for (const field of ['ssr', 'locale']) {
  void test(`an invalid declared ${field} route cannot disable its proof`, async (context) => {
    mockPublicResponses(context);
    const app = apiOnlyApp();
    Object.assign(app.deploy.cloudflare.routes, { [field]: '' });
    await assert.rejects(
      validateApp(app, publicUrl),
      /declared .* route must be a root-relative path/u
    );
  });
}

for (const variant of ['cjs', 'esm', 'esm-node']) {
  void test(`${variant} inspector permits dts:false only with zero frontend exposes`, async () => {
    const extension = variant === 'cjs' ? 'cjs' : 'js';
    const inspectionModule: unknown = await import(
      pathToFileURL(
        path.join(
          generatorRoot,
          `dist/${variant}/ultramodern-workspace/mf-validation/inspect.${extension}`
        )
      ).href
    );
    const inspection = Schema.decodeUnknownSync(
      ModuleFederationInspectionModuleSchema
    )(inspectionModule);
    const inspectInstalledModuleFederationConfig =
      inspection.inspectModuleFederationConfigSource.bind(inspectionModule);
    const inspect = (
      source: string
    ): typeof ModuleFederationInspectionSchema.Type => {
      const output: unknown = inspectInstalledModuleFederationConfig(
        source,
        'verticals/api',
        'module-federation.config.ts'
      );
      return Schema.decodeUnknownSync(ModuleFederationInspectionSchema)(output);
    };
    assert.deepEqual(
      inspect(
        '// @ultramodern-mf no-exposes\nexport default { dts: false, exposes: {} };'
      ).dts,
      {}
    );
    assert.throws(
      () =>
        inspect(
          'export default { dts: false, exposes: { "./Page": "./page.tsx" } };'
        ),
      /DTS cannot be disabled for exposed app/u
    );
  });
}

void test('MF proof accepts explicit API-only intent but keeps exposed-app archives mandatory', async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'ontos-api-only-mf-'));
  context.after(async (): Promise<void> => {
    await rm(fixture, { force: true, recursive: true });
  });
  const appDir = 'verticals/api';
  await mkdir(path.join(fixture, appDir), { recursive: true });
  const configPath = path.join(fixture, appDir, 'module-federation.config.ts');
  const validate = () =>
    validateModuleFederationTypes({
      appDirs: [appDir],
      workspaceRoot: fixture,
    });
  await writeFile(
    configPath,
    '// @ultramodern-mf no-exposes\nexport default { dts: false, exposes: {} };'
  );
  assert.equal(validate().hostOnlyAppCount, 1);
  await writeFile(configPath, 'export default { dts: false, exposes: {} };');
  assert.throws(
    validate,
    /without an explicit host-only\/no-exposes declaration/u
  );
  await writeFile(
    configPath,
    'export default { dts: { tsConfigPath: "./tsconfig.mf-types.json", generateTypes: { compilerInstance: "effect-tsgo" } }, exposes: { "./Page": "./page.tsx" } };'
  );
  assert.throws(validate, /Missing Module Federation DTS archive/u);
});

void test('Party deployment declares no fake SSR/locale URL while retaining backend contracts', async () => {
  const topology = await readJson(
    TopologySchema,
    path.join(workspaceRoot, topologyReferencePath)
  );
  const party = topology.verticals.find((entry) => entry.id === partyId);
  assert.ok(party);
  assert.equal(party.cloudflare.routes.ssr, undefined);
  assert.equal(party.cloudflare.routes.locale, undefined);
  assert.equal(party.cloudflare.routes.mfManifest, mfManifestPath);
  assert.equal(party.cloudflare.routes.apiReadiness, readinessPath);
  assert.equal(
    party.backendFederation.exposes['./effect-api'].contract,
    partySharedApiPath
  );
  assert.equal(
    party.backendFederation.exposes['./effect-api'].openapi,
    '/party-registry-api/openapi.json'
  );
});

void test('Party Registry is the sole deployment owner for Contacts capabilities', async () => {
  const topology = await readJson(
    TopologySchema,
    path.join(workspaceRoot, topologyReferencePath)
  );
  const overlay = await readJson(
    OverlaySchema,
    path.join(workspaceRoot, 'topology/local-overlays/development.json')
  );
  const zerops = await readFile(
    path.join(workspaceRoot, 'zerops.yaml'),
    'utf-8'
  );
  const partySetup = zerops
    .split(`  - setup: '${partyId}'`)[1]
    ?.split('  - setup:')[0];
  assert.ok(partySetup);
  assert.equal(zerops.includes("  - setup: 'contacts'"), false);
  assert.equal(
    topology.verticals.some((entry) => entry.id === 'contacts'),
    false
  );
  const party = topology.verticals.find((entry) => entry.id === partyId);
  assert.ok(party);
  assert.equal(overlay.ports[party.id], 4102);
  assert.equal(
    overlay.apis[party.id],
    'http://localhost:4102/party-registry-api'
  );
  assert.ok(partySetup.includes('ULTRAMODERN_ZEROPS_SERVICE: party-registry'));
  assert.ok(party.moduleFederation.exposes.includes('./PageContacts'));
});

void test('installed Cloudflare CLI preserves API-only routes when synthesizing the real Party contract', async (context) => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), 'ontos-api-only-proof-')
  );
  context.after(async (): Promise<void> => {
    await rm(fixture, { force: true, recursive: true });
  });
  await mkdir(path.join(fixture, '.modernjs'));
  await writeFile(
    path.join(fixture, '.modernjs/ultramodern.json'),
    await readFile(path.join(workspaceRoot, '.modernjs/ultramodern.json'))
  );
  const build = await readJson(
    BuildArtifactSchema,
    path.join(
      workspaceRoot,
      'verticals/party-registry/shared/ultramodern-build.json'
    )
  );
  const requestedPath = path.join(fixture, 'requested-routes.txt');
  const fetchMockPath = path.join(fixture, 'cloudflare-fetch-mock.mjs');
  await writeFile(
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
`
  );
  const reportPath = path.join(fixture, 'proof.json');
  runNode(
    [
      '--import',
      pathToFileURL(fetchMockPath).href,
      path.join(
        generatorRoot,
        'templates/workspace-scripts/proof-cloudflare-version.mjs'
      ),
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
    }
  );
  const requestedSource = await readFile(requestedPath, 'utf-8');
  const requested = requestedSource.trimEnd().split('\n');
  assert.deepEqual(requested, [mfManifestPath, readinessPath, readinessPath]);
  const report = await readJson(CloudflareReportSchema, reportPath);
  assert.equal(report.status, 'pass');
  assert.equal(report.results[0].appId, 'party-registry');
  assert.ok(
    report.results[0].assertions.every((entry) => entry.status === 'pass')
  );
});

void test('proves generated Layer bindings and API aliases without accepting unused neighbors', () => {
  const source = governedLayerAliasFixture;
  const resolveImport = (specifier: string) =>
    specifier === generatedSharedApiImport
      ? {
          id: 'owner/shared/api.ts',
          resolveImport: unexpectedTopologyImport,
          source: governedApiModuleSource,
        }
      : unexpectedTopologyImport(specifier);
  assert.equal(
    strictEffectRuntimeTopologyViolation(source, resolveImport),
    undefined
  );
  for (const [before, after] of governedLayerAliasMutations) {
    assert.ok(source.includes(before));
    assert.notEqual(
      strictEffectRuntimeTopologyViolation(
        source.replace(before, after),
        resolveImport
      ),
      undefined
    );
  }
});

void test('accepts only the trusted final identity terminator in a governed API slot', async () => {
  const identityTerminator = '.pipe(identity)';
  const source = await readFile(
    path.join(workspaceRoot, partySharedApiPath),
    'utf-8'
  );
  assert.ok(source.includes(identityTerminator));
  assert.equal(microVerticalApiBaselineViolation(partyId, source), undefined);
  const mutations = [
    source.replace(
      "import { Brand, identity } from 'effect';",
      "import { Brand } from 'effect';\nimport { identity } from './counterfeit.ts';"
    ),
    source.replace(identityTerminator, '.pipe(unrelatedIdentity)'),
    source.replace(
      identityTerminator,
      '.pipe(() => HttpApi.make("DiscardedApi"))'
    ),
    source.replace(
      identityTerminator,
      '.pipe(identity).addHttpApi(partyRegistryFoundationApi)'
    ),
  ];
  for (const mutated of mutations) {
    assert.notEqual(mutated, source);
    assert.match(
      microVerticalApiBaselineViolation(partyId, mutated) ?? '',
      /explicitly compose its readiness foundation API/u
    );
  }
});

// Consumer adaptation is compared by governed semantics, not generated byte equality.
void test('consumer migration preserves native tooling and governed safety', async (context) => {
  const source = async (relativePath: string) =>
    await readFile(path.join(workspaceRoot, relativePath), 'utf-8');
  await context.test(
    'authenticated cohort and scoped release-age policy remain pinned',
    async () => {
      const releaseVersion = '3.9.0-ultramodern.2';
      const cohort = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            aliases: Schema.Record(Schema.String, Schema.String),
            packages: Schema.Array(
              Schema.Struct({
                sourceName: Schema.String,
                targetName: Schema.String,
                version: Schema.Literal(releaseVersion),
              })
            ),
            release: Schema.Struct({ version: Schema.Literal(releaseVersion) }),
            source: Schema.Struct({
              commit: Schema.Literal(
                'd2c75828230edf92775feca796c0960af754508f'
              ),
            }),
          })
        )
      )(await source('.modernjs/release-cohort.json'));
      assert.equal(
        cohort.aliases['@modern-js/ultramodern-create'],
        '@bleedingdev/modern-js-ultramodern-create'
      );
      assert.equal(cohort.aliases['@modern-js/create'], undefined);
      assert.equal(
        new Set(cohort.packages.map((entry) => entry.sourceName)).size,
        cohort.packages.length
      );
      for (const entry of cohort.packages) {
        assert.equal(cohort.aliases[entry.sourceName], entry.targetName);
      }
      const workspace = await source('pnpm-workspace.yaml');
      for (const line of [
        'minimumReleaseAge: 1440',
        'minimumReleaseAgeStrict: true',
        'minimumReleaseAgeIgnoreMissingTime: false',
      ]) {
        assert.equal(
          workspace.split('\n').filter((candidate) => candidate === line)
            .length,
          1
        );
      }
      const exclusions =
        /^minimumReleaseAgeExclude:\n(?<entries>(?:[ \t]+[^\n]*\n)*)/mu.exec(
          workspace
        )?.groups?.entries;
      assert.ok(exclusions !== undefined && exclusions.length > 0);
      const allowed = new Set(
        cohort.packages.map((entry) => `${entry.targetName}@${entry.version}`)
      );
      const declared = exclusions
        .trim()
        .split('\n')
        .map((line) => line.trim().replaceAll(/^-\s*['"]?|['"]$/gu, ''));
      assert.ok(declared.length > 0);
      for (const entry of declared) {
        assert.ok(
          allowed.has(entry),
          `Release-age exception must name an exact authenticated package: ${entry}`
        );
      }
      const validator = await source(
        'scripts/validate-ultramodern-workspace.mts'
      );
      assert.match(validator, /authenticated release cohort projection/u);
      assert.ok(validator.includes(cohort.source.commit));
      assert.doesNotMatch(validator, /['"]@modern-js\/create['"]/u);
    }
  );
  await context.test(
    'current generator handoff preserves arguments and nonzero failures',
    async () => {
      const scratchRoot = path.join(workspaceRoot, '.scratch');
      await mkdir(scratchRoot, { recursive: true });
      const fixture = await mkdtemp(
        path.join(scratchRoot, 'consumer-migration-')
      );
      try {
        const executable = path.join(fixture, 'generator.mjs');
        await writeFile(
          executable,
          `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), root: process.env.ULTRAMODERN_WORKSPACE_ROOT })); process.exitCode = 37;`
        );
        const wrappers = [
          ['migrate-strict-effect.mts', 'migrate-strict-effect'],
          ['ultramodern-typecheck.mts', 'typecheck'],
        ] as const;
        const wrapperSources = await Promise.all(
          wrappers.map(async ([file]) => await source(`scripts/${file}`))
        );
        const runner = await source('scripts/shared/ultramodern-command.mts');
        const commandFailure = await source(
          'scripts/ultramodern-command-failure.mts'
        );
        assert.match(runner, /'ultramodern-create'/u);
        assert.doesNotMatch(runner, /['"]modern-js-create['"]/u);
        assert.match(commandFailure, /Schema\.TaggedError/u);
        for (const [index, [file, command]] of wrappers.entries()) {
          const script = wrapperSources[index] ?? '';
          assert.match(script, /runUltramodernScript/u);
          assert.doesNotMatch(script, /['"]modern-js-create['"]/u);
          assert.match(script, /Effect\.runPromiseExit/u);
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
            }
          );
          assert.equal(result.status, 37, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout), {
            args: ['ultramodern', command, '--fixture-argument'],
            root: fixture,
          });
          const missing = spawnSync(
            process.execPath,
            [path.join(workspaceRoot, 'scripts', file)],
            {
              cwd: fixture,
              encoding: 'utf-8',
              env: {
                PATH: fixture,
                ULTRAMODERN_CREATE_BIN: '',
                ULTRAMODERN_WORKSPACE_ROOT: fixture,
              },
            }
          );
          assert.equal(missing.status, 1);
          assert.match(
            missing.stdout + missing.stderr,
            /Failed to launch ultramodern-create from PATH/u
          );
        }
      } finally {
        await rm(fixture, { force: true, recursive: true });
      }
    }
  );
  await context.test(
    'native route, isolated materialization and workerd adaptations survive',
    async () => {
      const files = [
        'generate-tanstack-routes.mts',
        'materialize-zerops-runtime.mjs',
        'proof-workerd-ssr.mts',
      ];
      const scripts = await Promise.all(
        files.map(async (file) => await source(`scripts/${file}`))
      );
      for (const [index, file] of files.entries()) {
        const script = scripts[index] ?? '';
        assert.match(script, /Effect\.gen/u, file);
        assert.match(script, /FileSystem/u, file);
        assert.doesNotMatch(
          script,
          /import\s*\{[^}]*spawnSync[^}]*\}\s*from\s*['"]node:child_process/u,
          file
        );
        assert.doesNotMatch(script, /['"]modern-js-create['"]/u, file);
      }
      const materializer = await source(
        'scripts/materialize-zerops-runtime.mjs'
      );
      assert.match(materializer, /Flag\.boolean\('worker'\)/u);
      assert.match(materializer, /appPackage\.name !== packageName/u);
      assert.match(materializer, /makeTempDirectoryScoped/u);
      assert.match(materializer, /removeIncompatiblePlatformDependencies/u);
      assert.doesNotMatch(materializer, /--skip-build/u);
      const proof = await source('scripts/proof-workerd-ssr.mts');
      assert.match(proof, /WorkerdProofError extends Schema\.TaggedError/u);
      assert.match(proof, /findReleaseMarkers/u);
      assert.match(proof, /not tied to its executed release identity/u);
      assert.match(proof, /check\.body \?\? null/u);
      assert.match(proof, /check\.expect \?\? null/u);
      assert.match(proof, /Exit\.isFailure\(exit\)/u);
    }
  );
  await context.test(
    'custom Party contracts remain accepted and forged auth remains rejected',
    async () => {
      const principal = await source(
        'verticals/party-registry/api/auth/action-principal.ts'
      );
      const gateway = await source(
        'verticals/party-registry/src/api/action-gateway.ts'
      );
      const sharedApi = await source(partySharedApiPath);
      const handlerRoot = await source('verticals/party-registry/api/index.ts');
      assert.equal(hasGeneratedOperationPrincipalContract(principal), true);
      assert.equal(
        hasGeneratedOperationGatewayContract(gateway, partyId),
        true
      );
      assert.equal(
        hasValidGovernedHttpCompositionRoot(sharedApi, handlerRoot),
        true
      );
      assert.equal(
        microVerticalApiBaselineViolation(partyId, sharedApi),
        undefined
      );
      for (const [before, after] of [
        [
          'makeMicroverticalHttpPrincipalAuthentication(verifyOperationPrincipal)',
          'makeMicroverticalHttpPrincipalAuthentication(forgedPrincipal)',
        ],
        [
          "'@app/core-runtime/http/principal-authentication'",
          "'./counterfeit.ts'",
        ],
      ]) {
        assert.ok(principal.includes(before));
        assert.equal(
          hasGeneratedOperationPrincipalContract(
            principal.replace(before, after)
          ),
          false
        );
      }
      const audience = "ACTION_GATEWAY_AUDIENCE = 'party-registry'";
      assert.ok(gateway.includes(audience));
      assert.equal(
        hasGeneratedOperationGatewayContract(
          gateway.replace(audience, "ACTION_GATEWAY_AUDIENCE = 'other-owner'"),
          partyId
        ),
        false
      );
      // Exercise the complete Core/Party server, client, permission and transport negative matrix.
      const governed = spawnSync(
        process.execPath,
        [
          '--test',
          '--test-name-pattern=governed',
          'scripts/tests/module-entrypoint-boundaries.test.mts',
        ],
        {
          cwd: workspaceRoot,
          encoding: 'utf-8',
          env: { PATH: path.dirname(process.execPath) },
        }
      );
      assert.equal(governed.status, 0, governed.stdout + governed.stderr);
      assert.match(governed.stdout, /governed servers bind/u);
      assert.match(governed.stdout, /rejects generated governed clients/u);
    }
  );
  await context.test(
    'manifest-aware bridge accepts TanStack without permitting disguised router capability',
    () => {
      const imported =
        "import { createModuleFederationConfig as createConfig } from '@module-federation/modern-js-v3';";
      const config = (body: string) =>
        `${imported} export default createConfig(${body});`;
      const disabled = '{ bridge: { enableBridgeRouter: false } }';
      const enabled = '{ bridge: { enableBridgeRouter: true } }';
      assert.equal(
        moduleFederationBridgeViolation(config(disabled), {}),
        undefined
      );
      assert.equal(
        moduleFederationBridgeViolation(
          `${imported} const config = createConfig(${disabled}); export default config;`,
          {}
        ),
        undefined
      );
      assert.equal(
        moduleFederationBridgeViolation(config(enabled), {
          dependencies: { 'react-router': '7.18.0' },
        }),
        undefined
      );
      assert.equal(
        moduleFederationBridgeViolation(config(enabled), {
          devDependencies: { 'react-router-dom': '7.18.0' },
        }),
        undefined
      );
      for (const candidate of [
        config(enabled),
        config('{}'),
        config('{ bridge: {} }'),
        config('{ bridge: { enableBridgeRouter: Boolean(false) } }'),
        config('{ bridge: { enableBridgeRouter: false, ...override } }'),
        config('{ bridge: { enableBridgeRouter: false, [key]: true } }'),
        config(
          '{ bridge: { enableBridgeRouter: false, enableBridgeRouter: true } }'
        ),
        config('{ bridge: { enableBridgeRouter: false }, ...override }'),
        config(disabled).replace('import {', 'import type {'),
        `${imported} function decoy(createConfig) { return createConfig(${disabled}); } export default otherConfig;`,
        `function createConfig(value) { return value; } export default createConfig(${disabled});`,
      ]) {
        assert.notEqual(
          moduleFederationBridgeViolation(candidate, {}),
          undefined,
          candidate
        );
      }
    }
  );
});
