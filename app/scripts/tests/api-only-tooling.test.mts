/// <reference types="node" />

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Predicate, Schema } from 'effect';
import { transform } from 'esbuild';
import { format } from 'oxfmt';

import { strictEffectRuntimeTopologyViolation } from '../ultramodern-api-boundary-rules.mts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const partyId = 'party-registry';
const generatedFixtureId = 'inventory-stock';
const generatedApiPrefix = '/inventory-stock-api';
const generatedApiServiceModule = 'dist/esm-node/ultramodern-workspace/api/service.js';
const generatedSharedApiImport = '../shared/api.ts';
const generatedSharedRpcImport = '../shared/rpc.ts';
const apiIndexFile = 'api/index.ts';
const sharedApiFile = 'shared/api.ts';
const fixtureApiModuleSource = 'export const fixtureApi = {};';
const mfManifestPath = '/mf-manifest.json';
const readinessPath = '/party-registry-api/party-registry/readiness';
const localePath = '/locales/en/party-registry.json';
const apiSmokePath = '/api-smoke';
const compiledUiAssetPath = 'static/js/index.js';
const ssrBundlePath = 'bundles/index.js';
const apiBundlePath = 'api/index.js';
const routesManifestFile = 'routes-manifest.json';
const mfManifestFile = 'mf-manifest.json';

const unexpectedTopologyImport = (specifier: string): never => {
  throw new Error(`Unexpected strict-topology import: ${specifier}`);
};

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
  readonly verifyBuildOutputReleaseEnvelope: (root: string, target: string) => Promise<void>;
  readonly verifyNodeReleaseEnvelopeStaging: (input: {
    readonly outputDirectory: string;
  }) => Promise<void>;
}

interface WorkspaceAppFixture {
  readonly exposes: Readonly<Record<string, string>>;
  readonly id: typeof AppIdSchema.Type;
}
type CreateApiServiceEntry = (
  scope: string,
  app: {
    readonly api: {
      readonly consumedBy: readonly string[];
      readonly prefix: string;
      readonly protocol?: 'rest' | 'rpc';
      readonly stem: string;
    };
    readonly id: string;
  },
  contractImportPath: string,
) => string;
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
type CreateSharedApi = (app: {
  readonly api: {
    readonly consumedBy: readonly string[];
    readonly prefix: string;
    readonly stem: string;
  };
  readonly id: string;
}) => string;
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

const loadReleaseFramework = async (modulePath: string): Promise<ReleaseFramework> => {
  const source: unknown = await import(pathToFileURL(modulePath).href);
  const framework = Schema.decodeUnknownSync(ReleaseFrameworkModuleSchema)(source);
  const emitFrameworkMicroVerticalReleaseEnvelope =
    framework.emitFrameworkMicroVerticalReleaseEnvelope.bind(source);
  const emitNodeStagedReleaseEnvelope = framework.emitNodeStagedReleaseEnvelope.bind(source);
  const verifyBuildOutputReleaseEnvelope = framework.verifyBuildOutputReleaseEnvelope.bind(source);
  const verifyNodeReleaseEnvelopeStaging = framework.verifyNodeReleaseEnvelopeStaging.bind(source);
  return {
    emitFrameworkMicroVerticalReleaseEnvelope: async (input) => {
      const output: unknown = await emitFrameworkMicroVerticalReleaseEnvelope(input);
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
  filePath: string,
): Promise<JsonSchema['Type']> =>
  Schema.decodeUnknownSync(schema)(JSON.parse(await readFile(filePath, 'utf-8')));

const writeJson = async <Value extends object>(
  root: string,
  logicalPath: string,
  value: Value,
): Promise<void> => {
  await mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true });
  await writeFile(path.join(root, logicalPath), JSON.stringify(value));
};

const writeText = async (root: string, logicalPath: string, value: string): Promise<void> => {
  await mkdir(path.dirname(path.join(root, logicalPath)), { recursive: true });
  await writeFile(path.join(root, logicalPath), value);
};

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
const releaseFramework = await loadReleaseFramework(
  path.join(releaseFrameworkRoot, 'esm-node/ultramodern-release-envelope/framework-output.mjs'),
);

void test('MicroVertical templates use the shared strict Effect BFF assembly primitive', async () => {
  const apiServiceModule: unknown = await import(
    pathToFileURL(path.join(generatorRoot, generatedApiServiceModule)).href
  );
  const apiServiceGenerator = Schema.decodeUnknownSync(ApiServiceGeneratorModuleSchema)(
    apiServiceModule,
  );
  const packageModule: unknown = await import(
    pathToFileURL(path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/package-json.js'))
      .href
  );
  const packageGenerator = Schema.decodeUnknownSync(PackageGeneratorModuleSchema)(packageModule);
  const source = apiServiceGenerator.createApiServiceEntry(
    'fixture',
    {
      api: { consumedBy: [], prefix: generatedApiPrefix, stem: generatedFixtureId },
      id: generatedFixtureId,
    },
    generatedSharedApiImport,
  );

  assert.match(
    source,
    /import \{ assembleEffectBffRuntime \} from '@fixture\/shared-contracts\/server\/effect-bff-runtime';/u,
  );
  assert.match(source, /const apiHandlersLive = Layer\.mergeAll\(/u);
  assert.match(source, /assembleEffectBffRuntime\(\{[\s\S]*handlers: apiHandlersLive/u);
  assert.doesNotMatch(source, /\bdefineEffectBff\b/u);

  const sharedContractsPackage = packageGenerator.createSharedPackage(
    'fixture',
    'shared-contracts',
    'fixture contracts',
    { modernPackageVersion: '3.8.2', strategy: 'install' },
  );
  assert.equal(
    sharedContractsPackage.exports['./server/effect-bff-runtime'],
    './src/effect-bff-runtime.ts',
  );
  assert.equal(sharedContractsPackage.dependencies['@modern-js/plugin-bff'], '3.8.2');
  assert.equal(sharedContractsPackage.dependencies.effect, '4.0.0-beta.107');
  assert.match(
    await readFile(path.join(generatorRoot, 'templates/packages/effect-bff-runtime.ts'), 'utf-8'),
    /export const assembleEffectBffRuntime/u,
  );
  assert.match(
    await readFile(
      path.join(generatorRoot, 'templates/workspace-scripts/check-ultramodern-api-boundaries.mts'),
      'utf-8',
    ),
    /strictEffectRuntimeTopologyViolation/u,
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

// oxlint-disable-next-line complexity -- This table-driven contract test keeps each distinct validator failure observable.
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
    strictEffectRuntimeTopologyViolation(importedHandlers, resolveImportedHandlers),
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
  assert.match(
    strictEffectRuntimeTopologyViolation(importedHandlers, resolveForeignHandlers) ?? '',
    /explicitly composed Layer/u,
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
    undefined,
  );
  for (const [index, source] of validAdversarialStrictRuntimeSources.entries()) {
    assert.equal(
      strictEffectRuntimeTopologyViolation(source),
      undefined,
      `valid adversarial source ${index + 1}`,
    );
  }
  for (const source of adversarialStrictRuntimeSources) {
    assert.notEqual(strictEffectRuntimeTopologyViolation(source), undefined);
  }
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer: Layer.Layer<never> = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
      );
      export default defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `) ?? '',
    /server-only shared Effect BFF assembly helper/u,
  );
  assert.match(
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
    `) ?? '',
    /explicitly composed Layer/u,
  );
  assert.match(
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
    `) ?? '',
    /return or export the assembled strict Effect BFF runtime/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { defineEffectBff, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = Layer.empty;
      export default defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `) ?? '',
    /server-only shared Effect BFF assembly helper/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(() => Layer.empty);
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `) ?? '',
    /server-only shared Effect BFF assembly helper/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fixtureLayer = HttpApiBuilder.layer(fixtureApi).pipe(
        Layer.provide(fixtureHandlers),
        () => Layer.empty,
      );
      defineEffectBff({ api: fixtureApi, layer: fixtureLayer });
    `) ?? '',
    /server-only shared Effect BFF assembly helper/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { fixtureApi } from '../shared/api.ts';
      const defineEffectBff = () => undefined;
      defineEffectBff({ api: fixtureApi, layer: fakeLayer });
    `) ?? '',
    /server-only shared Effect BFF assembly helper/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { fixtureApi } from '../shared/api.ts';
      const decoy = "defineEffectBff({ api: fixtureApi, layer: fakeLayer })";
    `) ?? '',
    /server-only shared Effect BFF assembly helper/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { fixtureApi } from '../shared/api.ts';
      const unrelated = Layer.mergeAll(groupLayer);
      const assembleEffectBffRuntime = () => undefined;
      assembleEffectBffRuntime({ api: fixtureApi, handlers: unrelated });
    `) ?? '',
    /server-only shared Effect BFF assembly helper/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const unrelated = Layer.mergeAll(groupLayer);
      assembleEffectBffRuntime({ api: otherApi, handlers: unrelated });
    `) ?? '',
    /API imported from \.\.\/shared\/api\.ts/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const unrelated = Layer.mergeAll(groupLayer);
      const handlers = unrelated;
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `) ?? '',
    /explicitly composed Layer/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer).pipe(() => Layer.empty);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `) ?? '',
    /explicitly composed Layer/u,
  );
  assert.match(
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
    `) ?? '',
    /transport/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.thisDoesNotExist(groupLayer);
      assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
    `) ?? '',
    /explicitly composed Layer/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const handlers = Layer.mergeAll(groupLayer);
      function fake(assembleEffectBffRuntime) {
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `) ?? '',
    /unshadowed/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      {
        const { assembleEffectBffRuntime } = fakeRuntime;
        const handlers = Layer.mergeAll(groupLayer);
        assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `) ?? '',
    /unshadowed/u,
  );
  assert.match(
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
    `) ?? '',
    /unshadowed/u,
  );
  assert.match(
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
    `) ?? '',
    /unshadowed/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      function fake(Layer) {
        const handlers = Layer.mergeAll(groupLayer);
        return assembleEffectBffRuntime({ api: fixtureApi, handlers: handlers });
      }
    `) ?? '',
    /unshadowed/u,
  );
  assert.match(
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
    `) ?? '',
    /server-only shared Effect BFF assembly helper/u,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(`
      import { assembleEffectBffRuntime } from '@fixture/shared-contracts/server/effect-bff-runtime';
      import { Layer } from '@modern-js/plugin-bff/effect-edge';
      import { fixtureApi } from '../shared/api.ts';
      const fakeHandlers = "Layer.mergeAll(groupLayer)";
      assembleEffectBffRuntime({ api: fixtureApi, handlers: fakeHandlers });
    `) ?? '',
    /explicitly composed Layer/u,
  );
});

void test('published lint validators reject comment, string, and local strict-root spoofs', async (context) => {
  const codeToolsRoot = await realpath(
    path.join(workspaceRoot, 'node_modules/@modern-js/code-tools'),
  );
  const formats = [
    'dist/cjs/oxlint-plugin/rules/strict-effect-api-boundaries.cjs',
    'dist/esm/oxlint-plugin/rules/strict-effect-api-boundaries.js',
    'dist/esm-node/oxlint-plugin/rules/strict-effect-api-boundaries.js',
  ] as const;
  const apiServiceSource: unknown = await import(
    pathToFileURL(path.join(generatorRoot, generatedApiServiceModule)).href
  );
  const apiServiceGenerator = Schema.decodeUnknownSync(ApiServiceGeneratorModuleSchema)(
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
  assert.equal(
    strictEffectRuntimeTopologyViolation(generatedRpcSource, (specifier) =>
      specifier === generatedSharedRpcImport
        ? {
            id: 'inventory-stock/shared/rpc.ts',
            resolveImport: unexpectedTopologyImport,
            source: generatedRpcContractSource,
          }
        : unexpectedTopologyImport(specifier),
    ),
    undefined,
  );
  assert.match(
    strictEffectRuntimeTopologyViolation(generatedRpcSource, (specifier) =>
      specifier === generatedSharedRpcImport
        ? {
            id: 'inventory-stock/shared/rpc.ts',
            resolveImport: unexpectedTopologyImport,
            source: 'export const inventoryStockRpcGroup = { toLayer: () => undefined };',
          }
        : unexpectedTopologyImport(specifier),
    ) ?? '',
    /server-only shared Effect BFF assembly helper/u,
  );
  const lintRoot = await mkdtemp(path.join(os.tmpdir(), 'ontos-strict-api-lint-'));
  context.after(async () => await rm(lintRoot, { force: true, recursive: true }));
  const fixtureRoot = path.join(lintRoot, 'verticals/fixture');
  const fixtureApiEntryPath = path.join(fixtureRoot, apiIndexFile);
  await mkdir(path.join(fixtureRoot, 'api'), { recursive: true });
  await mkdir(path.join(fixtureRoot, 'shared'), { recursive: true });
  await writeFile(path.join(fixtureRoot, sharedApiFile), `${fixtureApiModuleSource}\n`);
  await writeFile(
    path.join(fixtureRoot, 'shared/rpc.ts'),
    'export const fixtureRpcGroup = { toLayer: () => undefined };\n',
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
    `,
  );
  const foreignRoot = path.join(lintRoot, 'verticals/foreign');
  await mkdir(path.join(foreignRoot, 'shared'), { recursive: true });
  await mkdir(path.join(foreignRoot, 'api'), { recursive: true });
  await writeFile(path.join(foreignRoot, sharedApiFile), `${fixtureApiModuleSource}\n`);
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
    `,
  );
  const generatedRoot = path.join(lintRoot, 'verticals/inventory-stock');
  await mkdir(path.join(generatedRoot, 'shared'), { recursive: true });
  await writeFile(
    path.join(generatedRoot, sharedApiFile),
    'export const inventoryStockApi = {};\n',
  );
  await writeFile(path.join(generatedRoot, 'shared/rpc.ts'), generatedRpcContractSource);
  const invalidSources = [
    ...adversarialStrictRuntimeSources,
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
        module: Schema.decodeUnknownSync(StrictEffectApiBoundaryRuleModuleSchema)(imported),
        moduleFormat,
      };
    }),
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
      assert.ok(
        messages.some((message) =>
          /server-only shared Effect BFF assembly helper|explicitly composed handler Layer/u.test(
            message,
          ),
        ),
        `${moduleFormat} accepted a fake strict runtime root`,
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
    assert.equal(
      legacyMessages.some((message) =>
        /server-only shared Effect BFF assembly helper|explicitly composed handler Layer/u.test(
          message,
        ),
      ),
      true,
      `${moduleFormat} accepted a legacy runtime root without the shared assembly helper`,
    );
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
    assert.equal(
      generatedMessages.some((message) =>
        /server-only shared Effect BFF assembly helper|explicitly composed handler Layer/u.test(
          message,
        ),
      ),
      false,
      `${moduleFormat} rejected exact generated helper output: ${generatedMessages.join(' | ')}`,
    );
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
    assert.equal(
      generatedRpcMessages.some((message) =>
        /server-only shared Effect BFF assembly helper|explicitly composed handler Layer|\.\.\/shared\/api\.ts/u.test(
          message,
        ),
      ),
      false,
      `${moduleFormat} rejected exact generated RPC output: ${generatedRpcMessages.join(' | ')}`,
    );
    for (const source of validAdversarialStrictRuntimeSources) {
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
      assert.equal(
        messages.some((message) =>
          /server-only shared Effect BFF assembly helper|explicitly composed handler Layer/u.test(
            message,
          ),
        ),
        false,
        `${moduleFormat} rejected a valid strict runtime root: ${messages.join(' | ')}`,
      );
    }
  }
});

void test('a minimal generated MicroVertical typechecks and serves its runtime', async () => {
  const apiServiceSource: unknown = await import(
    pathToFileURL(path.join(generatorRoot, generatedApiServiceModule)).href
  );
  const apiServiceGenerator = Schema.decodeUnknownSync(ApiServiceGeneratorModuleSchema)(
    apiServiceSource,
  );
  const sharedApiSource: unknown = await import(
    pathToFileURL(path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/api/shared.js'))
      .href
  );
  const sharedApiGenerator = Schema.decodeUnknownSync(SharedApiGeneratorModuleSchema)(
    sharedApiSource,
  );
  const descriptor = {
    api: { consumedBy: [], prefix: generatedApiPrefix, stem: generatedFixtureId },
    id: generatedFixtureId,
  } as const;
  const fixture = await mkdtemp(
    path.join(workspaceRoot, 'verticals/party-registry/.generated-runtime-'),
  );
  try {
    await writeText(
      fixture,
      apiIndexFile,
      apiServiceGenerator.createApiServiceEntry('app', descriptor, generatedSharedApiImport),
    );
    await writeText(fixture, sharedApiFile, sharedApiGenerator.createSharedApi(descriptor));
    await writeText(
      fixture,
      'shared/ultramodern-build.ts',
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
    await writeJson(fixture, 'tsconfig.json', {
      compilerOptions: { composite: false, noEmit: true, types: ['node'] },
      extends: '../../../tsconfig.base.json',
      include: ['api/**/*.ts', 'shared/**/*.ts'],
    });
    execFileSync(path.join(workspaceRoot, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], {
      cwd: fixture,
      encoding: 'utf-8',
    });
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
      }\n`,
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
  const putJson = async <Value extends object>(logicalPath: string, value: Value): Promise<void> =>
    await writeJson(root, logicalPath, value);
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
    routeAssets: { index: { assets: [`https://assets.example.test/app/${compiledUiAssetPath}`] } },
  });
  await putJson('route.json', { routes: [{ bundle: ssrBundlePath }] });
  await putJson('package.json', { type: 'module' });
  await Promise.all(
    [compiledUiAssetPath, ssrBundlePath, apiBundlePath, 'index.js', 'backendRemoteEntry.cjs'].map(
      async (file) => await putText(file, 'console.log("compiled fixture");'),
    ),
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
          `ultramodern-release-envelope/framework-output.${extension}`,
        ),
      );
      const envelope = await framework.emitFrameworkMicroVerticalReleaseEnvelope({
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
      await framework.verifyNodeReleaseEnvelopeStaging({ outputDirectory: fixture.root });
    }),
  );
  const fixture = await releaseFixture(context);
  await fixture.emit();
  await fixture.putText(compiledUiAssetPath, 'console.log("tampered");');
  await assert.rejects(
    async () => await releaseFramework.verifyBuildOutputReleaseEnvelope(fixture.root, 'node'),
    /digest|hash|size/iu,
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
          `ultramodern-release-envelope/framework-output.${extension}`,
        ),
      );
      const envelope = await framework.emitFrameworkMicroVerticalReleaseEnvelope({
        apiOnly: false,
        distDirectory: fixture.root,
        target: 'node',
      });
      assert.ok(envelope.surfaces.uiClient.includes(compiledUiAssetPath));
    }),
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
        reference,
      );
    }),
  );
  const baseline = await releaseFixture(context);
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
  await Promise.all(
    invalidManifests.map(async (manifest) => {
      const fixture = await releaseFixture(context);
      await fixture.putJson(mfManifestFile, manifest);
      await assert.rejects(
        fixture.emit,
        /UI\/client manifest references no compiled execution module/u,
      );
    }),
  );
  const fixture = await releaseFixture(context);
  await rm(path.join(fixture.root, routesManifestFile));
  await assert.rejects(fixture.emit, /ENOENT/u);
});

void test('empty MF producers cannot bypass backend, SSR, revision, or identity proof', async (context) => {
  await Promise.all(
    [apiBundlePath, ssrBundlePath, 'backendRemoteEntry.cjs'].map(async (file) => {
      const fixture = await releaseFixture(context);
      await rm(path.join(fixture.root, file));
      await assert.rejects(
        fixture.emit,
        /compiled Node Effect API|SSR artifacts|emitted together/u,
      );
    }),
  );
  const fixture = await releaseFixture(context);
  await fixture.putJson('backend-mf-manifest.json', {
    backendFederation: {
      deliveryUnit: { ...fixture.artifact.deliveryUnit, sourceRevision: 'b'.repeat(40) },
    },
  });
  await assert.rejects(fixture.emit, /must match/u);
  const workspaceArtifact = {
    ...fixture.artifact,
    deliveryUnit: { ...fixture.artifact.deliveryUnit, sourceRevision: 'workspace' },
    surfaces: {
      api: { ...fixture.artifact.surfaces.api, sourceRevision: 'workspace' },
      ui: { ...fixture.artifact.surfaces.ui, sourceRevision: 'workspace' },
    },
  };
  await fixture.putJson('ultramodern-build.json', workspaceArtifact);
  await assert.rejects(fixture.emit, /workspace/u);
});

const GlobalVarsSchema = Schema.Struct({ ULTRAMODERN_SHELL_ORIGIN: Schema.String });

const evaluatePartyBuildGlobalVars = async (shellOrigin: string) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ontos-party-config-'));
  try {
    const harnessPath = path.join(temporaryRoot, 'read-config.mjs');
    const configSource = await readFile(
      path.join(workspaceRoot, 'verticals/party-registry/modern.config.ts'),
      'utf-8',
    );
    const effectModuleUrl = pathToFileURL(
      require.resolve('effect', { paths: [workspaceRoot] }),
    ).href;
    const { code } = await transform(configSource, { format: 'cjs', loader: 'ts' });
    await writeFile(
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
    );
    const output = runNode([harnessPath]);
    return Schema.decodeUnknownSync(Schema.fromJsonString(GlobalVarsSchema))(output);
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
  const partyRoot = path.join(workspaceRoot, 'verticals/party-registry');
  const source = await readFile(path.join(partyRoot, apiIndexFile), 'utf-8');
  const reader =
    /(?<reader>declare const ULTRAMODERN_SHELL_ORIGIN[\s\S]+?const shellOrigin = readShellOrigin\(\);)/u.exec(
      source,
    )?.groups?.reader;
  assert.notEqual(reader, undefined, 'compile the actual API origin-reader boundary');
  const appToolsPath = require.resolve('@modern-js/app-tools/config', { paths: [partyRoot] });
  const rspackModule: unknown = require(require.resolve('@rspack/core', { paths: [appToolsPath] }));
  const rspackFixture = Schema.decodeUnknownSync(RspackModuleFixtureSchema)(rspackModule);
  const temporaryRoot = await mkdtemp(path.join(partyRoot, 'node_modules/.ontos-compiled-cors-'));
  try {
    const entry = path.join(temporaryRoot, 'reader.ts');
    await writeFile(
      entry,
      `import { Schema } from 'effect';\nimport { resolvePartyRegistryShellOrigin, partyRegistryCorsAllowedOrigins } from ${JSON.stringify(path.join(partyRoot, 'api/read-server-support.ts'))};\n${reader}\nexport const allowedOrigins = partyRegistryCorsAllowedOrigins(shellOrigin);\n`,
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
    try {
      const statsSource = await runCompiler();
      assert.ok(statsSource);
      const stats = Schema.decodeUnknownSync(CompilerStatsFixtureSchema)({
        hasErrors: statsSource.hasErrors,
        toString: statsSource.toString,
      });
      const hasErrors = stats.hasErrors.bind(statsSource)();
      const errorText = stats.toString.bind(statsSource)({ all: false, errors: true });
      assert.equal(hasErrors, false, errorText);
    } finally {
      await closeCompiler();
    }
    const compiledReaderModule: unknown = require(path.join(temporaryRoot, 'reader.cjs'));
    const compiledReader = Schema.decodeUnknownSync(CompiledReaderSchema)(compiledReaderModule);
    assert.deepEqual([...compiledReader.allowedOrigins], [shellOrigin]);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

const normalizedGeneratedSource = async (fileName: string, source: string) => {
  const result = await format(fileName, source, { singleQuote: true, sortImports: true });
  assert.deepEqual(result.errors, []);
  return result.code.replaceAll(/^\s*\n/gmu, '');
};

void test('all published scaffold formats retain lint-safe Party infrastructure parity', async () => {
  await Promise.all(
    ['esm', 'esm-node', 'cjs'].map(async (moduleFormat) => {
      const extension = moduleFormat === 'cjs' ? 'cjs' : 'js';
      const generatorModulePath = (name: string): string =>
        path.join(generatorRoot, `dist/${moduleFormat}/ultramodern-workspace/${name}.${extension}`);
      const descriptorPath = generatorModulePath('descriptors');
      const descriptorSource: unknown =
        moduleFormat === 'cjs'
          ? require(descriptorPath)
          : await import(pathToFileURL(descriptorPath).href);
      const descriptorModule = Schema.decodeUnknownSync(DescriptorModuleSchema)(descriptorSource);
      const componentPath = generatorModulePath('demo-components');
      const componentSource: unknown =
        moduleFormat === 'cjs'
          ? require(componentPath)
          : await import(pathToFileURL(componentPath).href);
      const componentModule = Schema.decodeUnknownSync(ComponentModuleSchema)(componentSource);
      const federationPath = generatorModulePath('module-federation/config');
      const federationSource: unknown =
        moduleFormat === 'cjs'
          ? require(federationPath)
          : await import(pathToFileURL(federationPath).href);
      const federationModule = Schema.decodeUnknownSync(FederationConfigModuleSchema)(
        federationSource,
      );
      const buildModulePath = generatorModulePath('module-federation/reexport-module');
      const buildModuleSource: unknown =
        moduleFormat === 'cjs'
          ? require(buildModulePath)
          : await import(pathToFileURL(buildModulePath).href);
      const buildModule = Schema.decodeUnknownSync(BuildModuleGeneratorSchema)(buildModuleSource);
      const createVerticalDescriptor =
        descriptorModule.createVerticalDescriptor.bind(descriptorSource);
      const createLayout = componentModule.createLayout.bind(componentSource);
      const createAppModernConfig = federationModule.createAppModernConfig.bind(federationSource);
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
      await Promise.all(
        Object.entries(generated).map(async ([fileName, source]) => {
          const actual = await readFile(
            path.join(workspaceRoot, 'verticals/party-registry', fileName),
            'utf-8',
          );
          assert.equal(
            await normalizedGeneratedSource(fileName, source),
            await normalizedGeneratedSource(fileName, actual),
            `${moduleFormat}: ${fileName} must match the controlled scaffold`,
          );
        }),
      );
    }),
  );
});

void test('full-stack Party Registry keeps backend and Contacts component tests executable', async () => {
  const packageJson = await readJson(
    PackageJsonSchema,
    path.join(workspaceRoot, 'verticals/party-registry/package.json'),
  );
  assert.equal(packageJson.scripts['test:component'], 'rstest --config rstest.config.ts');
  assert.equal(packageJson.scripts['test:unit'], 'node --test tests/unit/*.test.ts');
  assert.equal(packageJson.scripts['test:integration'], 'node --test tests/integration/*.test.ts');
  assert.match(
    await readFile(path.join(workspaceRoot, 'verticals/party-registry/rstest.config.ts'), 'utf-8'),
    /tests\/components/u,
  );
});
const cloudflareProofModule: unknown = await import(
  pathToFileURL(
    path.join(generatorRoot, 'templates/workspace-scripts/ultramodern-cloudflare-proof.mjs'),
  ).href
);
const cloudflareProof = Schema.decodeUnknownSync(CloudflareProofModuleSchema)(
  cloudflareProofModule,
);
const validateCloudflareApp = cloudflareProof.validateApp.bind(cloudflareProofModule);
const validateApp = async (
  app: ApiOnlyAppFixture,
  applicationPublicUrl: string,
): Promise<typeof CloudflareEvidenceSchema.Type> => {
  const output: unknown = await validateCloudflareApp(app, applicationPublicUrl);
  return Schema.decodeUnknownSync(CloudflareEvidenceSchema)(output);
};
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
    return Response.json(body, { headers: { 'access-control-allow-origin': '*' } });
  });
  return requested;
};

void test('API-only proof keeps manifest, readiness, service-binding and JSON proofs without invented pages/locales', async (context) => {
  const requested = mockPublicResponses(context);
  const evidence = await validateApp(apiOnlyApp(), publicUrl);
  assert.deepEqual(requested, [mfManifestPath, readinessPath, '/binding', apiSmokePath]);
  for (const proof of [
    'mf-manifest',
    'api-marker',
    'delivery-unit-api-marker',
    'service-binding-api-marker',
    'json-smoke-value',
  ]) {
    assert.ok(evidence.assertions.some((entry) => entry.type === proof && entry.status === 'pass'));
  }
  assert.equal(
    evidence.assertions.some((entry) => entry.type === 'ssr' || entry.type === 'i18n-marker'),
    false,
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
  await assert.rejects(validateApp(app, publicUrl), /SSR route returned HTTP 503/u);
  assert.deepEqual(requested, ['/en']);
});

void test('declared namespace locale remains mandatory independently of SSR', async (context) => {
  const requested = mockPublicResponses(context, localePath);
  const app = apiOnlyApp();
  Object.assign(app.deploy.cloudflare.routes, { locale: localePath });
  await assert.rejects(validateApp(app, publicUrl), /locale JSON returned HTTP 503/u);
  assert.deepEqual(requested, [mfManifestPath, localePath]);
});

for (const field of ['ssr', 'locale']) {
  void test(`an invalid declared ${field} route cannot disable its proof`, async (context) => {
    mockPublicResponses(context);
    const app = apiOnlyApp();
    Object.assign(app.deploy.cloudflare.routes, { [field]: '' });
    await assert.rejects(
      validateApp(app, publicUrl),
      /declared .* route must be a root-relative path/u,
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
          `dist/${variant}/ultramodern-workspace/mf-validation/inspect.${extension}`,
        ),
      ).href
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
    assert.deepEqual(
      inspect('// @ultramodern-mf no-exposes\nexport default { dts: false, exposes: {} };').dts,
      {},
    );
    assert.throws(
      () => inspect('export default { dts: false, exposes: { "./Page": "./page.tsx" } };'),
      /DTS cannot be disabled for exposed app/u,
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
    validateModuleFederationTypes({ appDirs: [appDir], workspaceRoot: fixture });
  await writeFile(
    configPath,
    '// @ultramodern-mf no-exposes\nexport default { dts: false, exposes: {} };',
  );
  assert.equal(validate().hostOnlyAppCount, 1);
  await writeFile(configPath, 'export default { dts: false, exposes: {} };');
  assert.throws(validate, /without an explicit host-only\/no-exposes declaration/u);
  await writeFile(
    configPath,
    'export default { dts: { tsConfigPath: "./tsconfig.mf-types.json", generateTypes: { compilerInstance: "effect-tsgo" } }, exposes: { "./Page": "./page.tsx" } };',
  );
  assert.throws(validate, /Missing Module Federation DTS archive/u);
});

void test('Party deployment declares no fake SSR/locale URL while retaining backend contracts', async () => {
  const topology = await readJson(
    TopologySchema,
    path.join(workspaceRoot, 'topology/reference-topology.json'),
  );
  const party = topology.verticals.find((entry) => entry.id === partyId);
  assert.ok(party);
  assert.equal(party.cloudflare.routes.ssr, undefined);
  assert.equal(party.cloudflare.routes.locale, undefined);
  assert.equal(party.cloudflare.routes.mfManifest, mfManifestPath);
  assert.equal(party.cloudflare.routes.apiReadiness, readinessPath);
  assert.equal(
    party.backendFederation.exposes['./effect-api'].contract,
    'verticals/party-registry/shared/api.ts',
  );
  assert.equal(
    party.backendFederation.exposes['./effect-api'].openapi,
    '/party-registry-api/openapi.json',
  );
});

void test('Party Registry is the sole deployment owner for Contacts capabilities', async () => {
  const topology = await readJson(
    TopologySchema,
    path.join(workspaceRoot, 'topology/reference-topology.json'),
  );
  const overlay = await readJson(
    OverlaySchema,
    path.join(workspaceRoot, 'topology/local-overlays/development.json'),
  );
  const zerops = await readFile(path.join(workspaceRoot, 'zerops.yaml'), 'utf-8');
  const partySetup = zerops.split(`  - setup: '${partyId}'`)[1]?.split('  - setup:')[0];
  assert.ok(partySetup);
  assert.equal(zerops.includes("  - setup: 'contacts'"), false);
  assert.equal(
    topology.verticals.some((entry) => entry.id === 'contacts'),
    false,
  );
  const party = topology.verticals.find((entry) => entry.id === partyId);
  assert.ok(party);
  assert.equal(overlay.ports[party.id], 4102);
  assert.equal(overlay.apis[party.id], 'http://localhost:4102/party-registry-api');
  assert.ok(partySetup.includes('ULTRAMODERN_ZEROPS_SERVICE: party-registry'));
  assert.ok(party.moduleFederation.exposes.includes('./PageContacts'));
});

void test('installed Cloudflare CLI preserves API-only routes when synthesizing the real Party contract', async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'ontos-api-only-proof-'));
  context.after(async (): Promise<void> => {
    await rm(fixture, { force: true, recursive: true });
  });
  await mkdir(path.join(fixture, '.modernjs'));
  await writeFile(
    path.join(fixture, '.modernjs/ultramodern.json'),
    await readFile(path.join(workspaceRoot, '.modernjs/ultramodern.json')),
  );
  const build = await readJson(
    BuildArtifactSchema,
    path.join(workspaceRoot, 'verticals/party-registry/shared/ultramodern-build.json'),
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
`,
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
  const requestedSource = await readFile(requestedPath, 'utf-8');
  const requested = requestedSource.trimEnd().split('\n');
  assert.deepEqual(requested, [mfManifestPath, readinessPath, readinessPath]);
  const report = await readJson(CloudflareReportSchema, reportPath);
  assert.equal(report.status, 'pass');
  assert.equal(report.results[0].appId, 'party-registry');
  assert.ok(report.results[0].assertions.every((entry) => entry.status === 'pass'));
});
