#!/usr/bin/env node
import { NodeFileSystem, NodePath, NodeRuntime } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { hasCompleteGeneratedModuleApiSeam } from './generated-governed-http-boundary.mts';
import {
  configuredMicroVerticalApiStem,
  microVerticalApiBaselineViolation,
} from './microvertical-api-baseline-boundary.mts';
import {
  privateOwnerImportViolation,
  strictEffectRuntimeTopologyViolation,
  usesStrictRpcRuntimeTopology,
  unconstrainedHttpApiContractSchemaViolation,
} from './ultramodern-api-boundary-rules.mts';

class ApiBoundaryCheckFailed extends Schema.TaggedError<ApiBoundaryCheckFailed>()(
  'ApiBoundaryCheckFailed',
  { failureCount: Schema.Int },
) {}

const PackageJsonSchema = Schema.Struct({
  exports: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const TopologySchema = Schema.Struct({
  verticals: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        api: Schema.optionalKey(
          Schema.Struct({
            basePath: Schema.optionalKey(Schema.String),
            bff: Schema.optionalKey(
              Schema.Struct({
                prefix: Schema.optionalKey(Schema.String),
                strictEffectApproach: Schema.optionalKey(Schema.Boolean),
              }),
            ),
            effect: Schema.optionalKey(Schema.Json),
            readiness: Schema.optionalKey(
              Schema.Struct({ endpoint: Schema.optionalKey(Schema.String) }),
            ),
            runtime: Schema.optionalKey(Schema.String),
            serverEntry: Schema.optionalKey(Schema.String),
          }),
        ),
        id: Schema.String,
        path: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const decodePackageJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJsonSchema));
const decodeTopology = Schema.decodeUnknownEffect(Schema.fromJsonString(TopologySchema));
const isFalsyJson = (value: Schema.Json | undefined): boolean =>
  value === undefined || value === null || value === false || value === 0 || value === '';

const ignoredDirectories = new Set([
  '.git',
  '.modern',
  '.output',
  'coverage',
  'dist',
  'dist-cloudflare',
  'node_modules',
  'repos',
]);

interface WorkspaceAccess {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workspaceRoot: string;
}

const listWorkspaceFiles = (
  { fileSystem, path, workspaceRoot }: WorkspaceAccess,
  startDirectory: string,
): Effect.Effect<string[], PlatformError> =>
  Effect.gen(function* listWorkspaceFilesEffect() {
    const absoluteStart = path.join(workspaceRoot, startDirectory);
    if (!(yield* fileSystem.exists(absoluteStart))) {
      return [];
    }

    const files: string[] = [];
    const visit = (directory: string): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* visitDirectoryEffect() {
        for (const entry of yield* fileSystem.readDirectory(directory)) {
          if (!ignoredDirectories.has(entry)) {
            const absoluteEntry = path.join(directory, entry);
            const info = yield* fileSystem.stat(absoluteEntry);
            if (info.type === 'Directory') {
              yield* visit(absoluteEntry);
            } else if (info.type === 'File') {
              const normalized = path
                .relative(workspaceRoot, absoluteEntry)
                .split(path.sep)
                .join('/');
              files.push(normalized);
            }
          }
        }
      });

    yield* visit(absoluteStart);
    return files;
  });

const checkApiBoundaries = Effect.gen(function* checkApiBoundariesEffect() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* Config.string('ULTRAMODERN_WORKSPACE_ROOT').pipe(
    Config.withDefault(path.resolve()),
  );
  const failures: string[] = [];
  const sourceByFile = new Map<string, string>();

  const exists = (relativePath: string) =>
    fileSystem.exists(path.join(workspaceRoot, relativePath));

  const readText = (relativePath: string) =>
    fileSystem.readFileString(path.join(workspaceRoot, relativePath), 'utf-8');

  const topology = (yield* exists('topology/reference-topology.json'))
    ? yield* readText('topology/reference-topology.json').pipe(Effect.flatMap(decodeTopology))
    : { verticals: [] };

  const verticalApiStem = (verticalPath: string): string =>
    configuredMicroVerticalApiStem(verticalPath, topology.verticals ?? []) ??
    path.basename(verticalPath);

  const topologyVertical = (verticalPath: string) =>
    (topology.verticals ?? []).find(
      (vertical) => (vertical.path ?? `verticals/${vertical.id}`) === verticalPath,
    );

  const fail = (message: string): void => {
    failures.push(message);
  };

  const assert = (condition: boolean, message: string): void => {
    if (!condition) {
      fail(message);
    }
  };

  const listFiles = (startDirectory: string) =>
    listWorkspaceFiles({ fileSystem, path, workspaceRoot }, startDirectory);

  const listDirectories = (startDirectory: string) =>
    Effect.gen(function* listDirectoriesEffect() {
      const absoluteStart = path.join(workspaceRoot, startDirectory);
      if (!(yield* fileSystem.exists(absoluteStart))) {
        return [];
      }

      const directories: string[] = [];
      for (const entry of yield* fileSystem.readDirectory(absoluteStart)) {
        if (!ignoredDirectories.has(entry)) {
          const info = yield* fileSystem.stat(path.join(absoluteStart, entry));
          if (info.type === 'Directory') {
            directories.push(path.join(startDirectory, entry));
          }
        }
      }
      return directories;
    });

  const assertNoPath = (relativePath: string, message: string) =>
    Effect.gen(function* assertNoPathEffect() {
      if (yield* exists(relativePath)) {
        fail(message);
      }
    });

  const assertContains = (
    relativePath: string,
    content: string,
    pattern: RegExp,
    message: string,
  ): void => {
    assert(pattern.test(content), `${relativePath}: ${message}`);
  };

  const assertNotContains = (
    relativePath: string,
    content: string,
    pattern: RegExp,
    message: string,
  ): void => {
    assert(!pattern.test(content), `${relativePath}: ${message}`);
  };

  const isGeneratedInfrastructureReadinessApi = (
    verticalPath: string,
    content: string,
  ): boolean => {
    const stem = verticalApiStem(verticalPath);
    const apiPrefix = topologyVertical(verticalPath)?.api?.bff?.prefix;
    const contractStem = stem.replaceAll(/-(?<letter>[a-z0-9])/gu, (_match, letter: string) =>
      letter.toUpperCase(),
    );
    const endpoints = [
      ...content.matchAll(
        /HttpApiEndpoint\.(?<method>get|post)\(\s*'(?<name>[^']+)'\s*,\s*'(?<route>[^']+)'/gu,
      ),
    ].map((match) => {
      const method = match.groups?.method ?? '';
      const name = match.groups?.name ?? '';
      const route = match.groups?.route ?? '';
      return `${method}:${name}:${route}`;
    });
    return (
      apiPrefix !== undefined &&
      endpoints.length === 1 &&
      [...content.matchAll(/\.addHttpApi\s*\(/gu)].length === 1 &&
      endpoints[0] === `get:readiness:/${stem}/readiness` &&
      content.includes(`export const ${contractStem}ApiContract = {`) &&
      content.includes(`readinessPath: '${apiPrefix}/${stem}/readiness'`)
    );
  };

  const assertPrivateOwnerImports = (file: string, content: string): void => {
    const imports = content.matchAll(
      /(?:from\s+|import\s*\(|require\s*\()\s*['"](?<specifier>[^'"]+)['"]/gu,
    );
    for (const match of imports) {
      const specifier = match.groups?.specifier;
      if (specifier !== undefined) {
        const violation = privateOwnerImportViolation(workspaceRoot, file, specifier);
        if (violation !== undefined) {
          fail(`${file}: ${violation}. Discover other deployments as allowlisted data.`);
        }
      }
    }
  };

  const appDirectories = yield* listDirectories('apps');
  const allVerticalDirectories = yield* listDirectories('verticals');
  for (const forbiddenPath of [
    ...appDirectories.flatMap((appPath) => [
      `${appPath}/api/effect`,
      `${appPath}/api/lambda`,
      `${appPath}/shared/effect`,
      `${appPath}/src/effect`,
    ]),
    ...allVerticalDirectories.flatMap((verticalPath) => [
      `${verticalPath}/api/effect`,
      `${verticalPath}/api/lambda`,
      `${verticalPath}/shared/effect`,
      `${verticalPath}/src/effect`,
    ]),
  ]) {
    yield* assertNoPath(
      forbiddenPath,
      `${forbiddenPath} is forbidden in UltraModern strictEffectApproach workspaces; use api/index.ts, shared/api.ts and src/api/* instead.`,
    );
  }

  const inspectGeneratedSources = Effect.gen(function* inspectGeneratedSourcesEffect() {
    const generatedFiles = [
      ...(yield* listFiles('apps')),
      ...(yield* listFiles('verticals')),
      ...(yield* listFiles('packages')),
    ];
    const textFiles = generatedFiles.filter((file) =>
      /\.(?:[cm]?[jt]sx?|json|md|mjs|mts|cts)$/u.test(file),
    );

    for (const file of textFiles) {
      sourceByFile.set(file, yield* readText(file));
    }

    for (const [file, content] of sourceByFile) {
      assertPrivateOwnerImports(file, content);
      const unconstrainedContractSchema = file.includes('/tests/')
        ? undefined
        : unconstrainedHttpApiContractSchemaViolation(content, { file, sources: sourceByFile });
      if (unconstrainedContractSchema !== undefined) {
        fail(`${file}: ${unconstrainedContractSchema}.`);
      }
      assertNotContains(
        file,
        content,
        /(?:from\s+|import\s*\(|require\s*\()\s*['"]@app\/[a-z0-9-]+\/(?:src|workers|worker-host)\//u,
        'cross-MicroVertical imports must use generated API clients, Module Federation, or schema-only Outbox exports rather than private source paths.',
      );

      if (/\/api\//u.test(file)) {
        assertNotContains(
          file,
          content,
          /\bnew\s+Response\s*\(|\bResponse\.json\s*\(/u,
          'API modules must not hand-build Response objects; model endpoints through Effect HttpApi and schemas.',
        );
        assertNotContains(
          file,
          content,
          /\b(?:request|req)\.(?:json|text|formData|arrayBuffer)\s*\(/u,
          'API modules must not manually parse request bodies; use HttpApiEndpoint payload/query/params schemas.',
        );
        assertNotContains(
          file,
          content,
          /\bexport\s+const\s+handler\b|\bexport\s+default\s+async\b/u,
          'API modules must not export raw request handlers; export defineEffectBff(...) from api/index.ts.',
        );
        assertNotContains(
          file,
          content,
          /\bcreateHandler\s*[:=]\s*(?!defineEffectBff\b)/u,
          'API modules must not define unbranded handler factories; use defineEffectBff(...).',
        );
        assertNotContains(
          file,
          content,
          /\bSchema\.(?:UnknownFromJsonString|Unknown|Any)\b/u,
          'API modules must use concrete request, response and error schemas; Schema.UnknownFromJsonString, Schema.Unknown and Schema.Any are forbidden in UltraModern API code.',
        );
      }

      assertNotContains(
        file,
        content,
        /@modern-js\/plugin-bff\/hono-server/u,
        'UltraModern API workspaces must not import Hono server helpers; use @modern-js/plugin-bff/effect-edge and HttpApi.',
      );
      assertNotContains(
        file,
        content,
        /\bruntimeFramework\s*(?::|=)\s*['"]hono['"]/u,
        'Generated UltraModern API apps must use the Effect runtime.',
      );
      assertNotContains(
        file,
        content,
        /\bstrictEffectApproach\s*(?::|=)\s*false\b/u,
        'Generated UltraModern API apps must keep strictEffectApproach enabled.',
      );
    }
  });
  yield* inspectGeneratedSources;

  const topologyResolverFor = (importer: string) => {
    const resolveImport = (specifier: string) => {
      if (!specifier.startsWith('.')) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The resolver's explicit miss value preserves its module-or-undefined contract.
        return undefined;
      }
      const unresolved = path.normalize(path.join(path.dirname(importer), specifier));
      const candidates = /\.[cm]?[jt]sx?$/u.test(unresolved)
        ? [unresolved]
        : [`${unresolved}.ts`, `${unresolved}.mts`, `${unresolved}/index.ts`];
      const id = candidates.find((candidate) => sourceByFile.has(candidate));
      const source = id === undefined ? undefined : sourceByFile.get(id);
      return id === undefined || source === undefined
        ? undefined
        : { id, resolveImport: topologyResolverFor(id), source };
    };
    return resolveImport;
  };

  const verticalDirectories: string[] = [];
  for (const verticalPath of allVerticalDirectories) {
    if (yield* exists(`${verticalPath}/package.json`)) {
      verticalDirectories.push(verticalPath);
    }
  }
  const shellClient = 'apps/shell-super-app/src/api/vertical-clients.ts';
  if ((yield* exists('apps/shell-super-app')) && verticalDirectories.length > 0) {
    assert(yield* exists(shellClient), `${shellClient} must aggregate vertical API clients.`);
  }

  /* oxlint-disable complexity -- The owner API surface gate intentionally keeps all fail-closed assertions together. expires: 2026-12-31. */
  const assertApiSurface = (appPath: string) =>
    Effect.gen(function* assertApiSurfaceEffect() {
      const apiEntry = `${appPath}/api/index.ts`;
      const backendEffectExpose = `${appPath}/api/effect-api.ts`;
      const sharedApi = `${appPath}/shared/api.ts`;
      const srcApiDirectory = `${appPath}/src/api`;
      const modernConfig = `${appPath}/modern.config.ts`;
      const packageJsonPath = `${appPath}/package.json`;

      assert(yield* exists(apiEntry), `${apiEntry} is required.`);
      assert(yield* exists(sharedApi), `${sharedApi} is required.`);
      assert(yield* exists(srcApiDirectory), `${srcApiDirectory} is required.`);

      if (yield* exists(srcApiDirectory)) {
        const clientFiles = (yield* listFiles(srcApiDirectory)).filter((file) =>
          file.endsWith('-client.ts'),
        );
        assert(clientFiles.length > 0, `${srcApiDirectory} must contain a generated API client.`);
      }

      if (yield* exists(apiEntry)) {
        const entry = yield* readText(apiEntry);
        const usesRpcRuntime = usesStrictRpcRuntimeTopology(entry, topologyResolverFor(apiEntry));
        const runtimeTopologyViolation = strictEffectRuntimeTopologyViolation(
          entry,
          topologyResolverFor(apiEntry),
        );
        if (runtimeTopologyViolation !== undefined) {
          fail(`${apiEntry}: ${runtimeTopologyViolation}.`);
        }
        assertContains(
          apiEntry,
          entry,
          /\bLayer\b/u,
          'must compose dependencies with Effect Layer.',
        );
        if (!usesRpcRuntime) {
          assertContains(
            apiEntry,
            entry,
            /from ['"]\.\.\/shared\/api\.ts['"]/u,
            'must import the contract from ../shared/api.ts.',
          );
        }
      }
      if (yield* exists(backendEffectExpose)) {
        const backendExpose = yield* readText(backendEffectExpose);
        assertContains(
          backendEffectExpose,
          backendExpose,
          /backendFederationContract/u,
          'must export backendFederationContract metadata.',
        );
        assertContains(
          backendEffectExpose,
          backendExpose,
          /role:\s*['"]microvertical-server['"]/u,
          'must describe the MicroVertical server role.',
        );
        assertContains(
          backendEffectExpose,
          backendExpose,
          /strictEffectApproach:\s*true/u,
          'must preserve strict Effect backend execution.',
        );
        assertContains(
          backendEffectExpose,
          backendExpose,
          /contractVersion:\s*['"]microvertical-server-effect-v1['"]/u,
          'must preserve the MicroVertical server contract version.',
        );
        assertContains(
          backendEffectExpose,
          backendExpose,
          /export\s*\{\s*default\s*,\s*default\s+as\s+runtime\s*\}\s+from\s+['"]\.\/index\.ts['"]/u,
          'must re-export the generated Effect BFF runtime as both default and runtime.',
        );
        assert(
          !/\b(?<member>request|handler)\s*:\s*async\s*\(/u.test(backendExpose),
          `${backendEffectExpose}: must not expose raw request handlers.`,
        );
      }

      if (yield* exists(sharedApi)) {
        const contract = yield* readText(sharedApi);
        assertContains(
          sharedApi,
          contract,
          /\bHttpApi\.make\b/u,
          'must declare the HttpApi contract.',
        );
        assertContains(
          sharedApi,
          contract,
          /\bHttpApiGroup\.make\b/u,
          'must declare HttpApi groups.',
        );
        assertContains(
          sharedApi,
          contract,
          /\bHttpApiEndpoint\./u,
          'must declare endpoints through HttpApiEndpoint.',
        );
        assertContains(
          sharedApi,
          contract,
          /\bSchema\./u,
          'must use Schema for request, response and error shapes.',
        );
        if (appPath.startsWith('verticals/')) {
          const apiStem = verticalApiStem(appPath);
          const vertical = topologyVertical(appPath);
          const basePath = vertical?.api?.basePath;
          const apiPrefix = vertical?.api?.bff?.prefix;
          if (vertical === undefined) {
            fail(`${sharedApi}: topology must declare this MicroVertical owner.`);
          } else if (basePath === undefined || basePath.length === 0) {
            fail(`${sharedApi}: topology must declare api.basePath.`);
          } else if (apiPrefix === undefined || apiPrefix.length === 0) {
            fail(`${sharedApi}: topology must declare api.bff.prefix.`);
          } else {
            const baselineViolation = microVerticalApiBaselineViolation(
              apiStem,
              path.join(workspaceRoot, sharedApi),
              {
                additionalPaths:
                  apiStem === 'checkout' ? { checkoutCartPath: `${basePath}/cart` } : {},
                apiPrefix,
                basePath,
                effectClientPackage: '@modern-js/plugin-bff/effect-client',
                ownerId: vertical.id,
                readinessPath: `${basePath}/readiness`,
                sharedContractsPackage: '@app/shared-contracts',
              },
            );
            assert(
              baselineViolation === undefined,
              `${sharedApi}: ${baselineViolation ?? 'invalid MicroVertical API baseline'}.`,
            );
          }
        }
      }

      if (yield* exists(modernConfig)) {
        const config = yield* readText(modernConfig);
        assertContains(
          modernConfig,
          config,
          /runtimeFramework:\s*['"]effect['"]/u,
          'must use bff.runtimeFramework: effect.',
        );
        assertContains(
          modernConfig,
          config,
          /entry:\s*['"]\.\/api\/index['"]/u,
          'must point bff.effect.entry at ./api/index.',
        );
        assertContains(
          modernConfig,
          config,
          /strictEffectApproach:\s*true/u,
          'must enable strictEffectApproach explicitly.',
        );
      }

      const validateApiPackage = Effect.gen(function* validateApiPackageEffect() {
        if (yield* exists(packageJsonPath)) {
          const packageJson = yield* readText(packageJsonPath).pipe(
            Effect.flatMap(decodePackageJson),
          );
          const isPrivateVerticalInfrastructureApi =
            appPath.startsWith('verticals/') &&
            (yield* exists(sharedApi)) &&
            isGeneratedInfrastructureReadinessApi(appPath, yield* readText(sharedApi));
          if (isPrivateVerticalInfrastructureApi) {
            assert(
              packageJson.exports?.['./api'] === undefined &&
                packageJson.exports?.['./api/client'] === undefined,
              `${packageJsonPath}: infrastructure-only vertical APIs must remain private deployment surfaces.`,
            );
          } else {
            assert(
              packageJson.exports?.['./api'] === './shared/api.ts',
              `${packageJsonPath}: package must export ./api from shared/api.ts.`,
            );
            assert(
              packageJson.exports?.['./api/client']?.startsWith('./src/api/') ?? false,
              `${packageJsonPath}: package must export ./api/client from src/api/*.`,
            );
          }
        }
      });
      yield* validateApiPackage;
    });
  /* oxlint-enable complexity */

  const inspectApiSurfaces = Effect.gen(function* inspectApiSurfacesEffect() {
    for (const appPath of appDirectories) {
      if (
        (yield* exists(`${appPath}/api/index.ts`)) ||
        (yield* exists(`${appPath}/shared/api.ts`))
      ) {
        yield* assertApiSurface(appPath);
      }
    }

    for (const verticalPath of verticalDirectories) {
      yield* assertApiSurface(verticalPath);
      const sharedApi = `${verticalPath}/shared/api.ts`;
      const sharedApiContent = (yield* exists(sharedApi)) ? yield* readText(sharedApi) : '';
      const verticalSources = new Map<string, string>();
      for (const file of yield* listFiles(verticalPath)) {
        verticalSources.set(file, yield* readText(file));
      }
      if (
        /\bHttpApiEndpoint\./u.test(sharedApiContent) &&
        !isGeneratedInfrastructureReadinessApi(verticalPath, sharedApiContent) &&
        !hasCompleteGeneratedModuleApiSeam(verticalSources, sharedApi)
      ) {
        fail(
          `${sharedApi}: module APIs require an approved Codesmith generator, structured api registration, verified trusted tenant context, and the server ModuleEntrypointGateway before an endpoint may be introduced.`,
        );
      }
    }
  });
  yield* inspectApiSurfaces;

  const inspectWorkspaceContracts = Effect.gen(function* inspectWorkspaceContractsEffect() {
    if (yield* exists('apps/shell-super-app/package.json')) {
      const shellPackageJson = yield* readText('apps/shell-super-app/package.json').pipe(
        Effect.flatMap(decodePackageJson),
      );
      assert(
        shellPackageJson.exports?.['./api/clients'] === './src/api/vertical-clients.ts',
        'apps/shell-super-app/package.json must export ./api/clients.',
      );
    }

    if (yield* exists('package.json')) {
      const rootPackageJson = yield* readText('package.json').pipe(
        Effect.flatMap(decodePackageJson),
      );
      assert(
        rootPackageJson.scripts?.['api:check'] ===
          'node ./scripts/check-ultramodern-api-boundaries.mts',
        'Root package.json must expose api:check.',
      );
      assert(
        rootPackageJson.scripts?.check?.includes('pnpm api:check') ?? false,
        'Root check script must include pnpm api:check.',
      );
    }

    const validateTopologyContracts = Effect.sync(() => {
      for (const vertical of topology.verticals ?? []) {
        if (vertical.api?.runtime === 'effect') {
          assert(
            vertical.api.bff?.strictEffectApproach === true,
            `${vertical.id} topology must mark strictEffectApproach as true.`,
          );
          assert(
            vertical.api.serverEntry?.endsWith('/api/index.ts') ?? false,
            `${vertical.id} topology must use api/index.ts as the server entry.`,
          );
        }
        assert(
          isFalsyJson(vertical.api?.effect),
          `${vertical.id} topology must describe the API directly, not under api.effect.`,
        );
      }
    });
    yield* validateTopologyContracts;
  });
  yield* inspectWorkspaceContracts;

  if (failures.length > 0) {
    yield* Console.error('UltraModern API boundary check failed:');
    for (const failure of failures) {
      yield* Console.error(`- ${failure}`);
    }
    return failures.length;
  }

  yield* Console.log('UltraModern API boundary check passed.');
  return 0;
});

const failureCount = await Effect.runPromise(
  checkApiBoundaries.pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
);
if (failureCount > 0) {
  NodeRuntime.runMain(Effect.fail(new ApiBoundaryCheckFailed({ failureCount })), {
    disableErrorReporting: true,
  });
}
