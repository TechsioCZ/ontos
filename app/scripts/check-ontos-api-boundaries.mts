#!/usr/bin/env node

import { NodeFileSystem, NodePath, NodeRuntime } from '@effect/platform-node';
import { configuredMicroVerticalApiStem } from '@modern-js/code-tools/microvertical-api-boundary';
import { Config, Console, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

import { hasCompleteGeneratedModuleApiSeam } from './generated-governed-http-boundary.mts';
import { moduleImportSources } from './check-ontos-module-contracts.mts';
import { privateOwnerImportViolation } from './ultramodern-api-boundary-rules.mts';

class ApiBoundaryCheckFailed extends Schema.TaggedError<ApiBoundaryCheckFailed>()('ApiBoundaryCheckFailed', {
  failureCount: Schema.Int,
}) {}

const PackageJsonSchema = Schema.Struct({
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
              }),
            ),
            readiness: Schema.optionalKey(Schema.Struct({ endpoint: Schema.optionalKey(Schema.String) })),
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

// The native CLI's baseline flag constrains the installed package identity. It does not
// replace the checker or its rules. Keep this command local and reject shell composition,
// workspace retargeting, duplicate flags, and flags that can skip the required check.
export const hasNativeApiCheckCommand = (
  script: string | undefined,
  verticalDirectories: readonly string[],
): boolean => {
  if (script === undefined || !/^[A-Za-z0-9_./@ \t-]+$/u.test(script)) {
    return false;
  }
  const [command, ...argumentsList] = script.trim().split(/\s+/u);
  if (command !== 'modern-api-check' || argumentsList.length % 2 !== 0) {
    return false;
  }
  const allowedBaselines = new Set([
    './node_modules/@modern-js/bff-effect',
    ...verticalDirectories.map((directory) => `./${directory}/node_modules/@modern-js/bff-effect`),
  ]);
  const flags = new Set<string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (flag === undefined || flags.has(flag)) {
      return false;
    }
    flags.add(flag);
    if (flag === '--rules') {
      if (value !== './scripts/api-contract-schema-rules.mts') {
        return false;
      }
    } else if (flag !== '--baseline-package-directory' || value === undefined || !allowedBaselines.has(value)) {
      return false;
    }
  }
  return flags.has('--rules');
};

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
              const normalized = path.relative(workspaceRoot, absoluteEntry).split(path.sep).join('/');
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
  const workspaceRoot = yield* Config.String('ULTRAMODERN_WORKSPACE_ROOT').pipe(Config.withDefault(path.resolve()));
  const failures: string[] = [];
  const sourceByFile = new Map<string, string>();

  const exists = (relativePath: string) => fileSystem.exists(path.join(workspaceRoot, relativePath));

  const readText = (relativePath: string) => fileSystem.readFileString(path.join(workspaceRoot, relativePath), 'utf-8');

  const topology = (yield* exists('topology/reference-topology.json'))
    ? yield* readText('topology/reference-topology.json').pipe(Effect.flatMap(decodeTopology))
    : { verticals: [] };

  const verticalApiStem = (verticalPath: string): string =>
    configuredMicroVerticalApiStem(verticalPath, topology.verticals ?? []) ?? path.basename(verticalPath);

  const topologyVertical = (verticalPath: string) =>
    (topology.verticals ?? []).find((vertical) => (vertical.path ?? `verticals/${vertical.id}`) === verticalPath);

  const fail = (message: string): void => {
    failures.push(message);
  };

  const assert = (condition: boolean, message: string): void => {
    if (!condition) {
      fail(message);
    }
  };

  const listFiles = (startDirectory: string) => listWorkspaceFiles({ fileSystem, path, workspaceRoot }, startDirectory);

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

  const assertNotContains = (relativePath: string, content: string, pattern: RegExp, message: string): void => {
    assert(!pattern.test(content), `${relativePath}: ${message}`);
  };

  const isGeneratedInfrastructureReadinessApi = (verticalPath: string, content: string): boolean => {
    const stem = verticalApiStem(verticalPath);
    const apiPrefix = topologyVertical(verticalPath)?.api?.bff?.prefix;
    const contractStem = stem.replaceAll(/-(?<letter>[a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase());
    const endpoints = [
      ...content.matchAll(/HttpApiEndpoint\.(?<method>get|post)\(\s*'(?<name>[^']+)'\s*,\s*'(?<route>[^']+)'/gu),
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

  const assertPrivateOwnerImports = (file: string, content: string) =>
    Effect.gen(function* inspectPrivateOwnerImports() {
      const imports = yield* moduleImportSources(file, content);
      for (const specifier of imports) {
        const violation = privateOwnerImportViolation(workspaceRoot, file, specifier);
        if (violation !== undefined) {
          fail(`${file}: ${violation}. Discover other deployments as allowlisted data.`);
        }
        assertNotContains(
          file,
          specifier,
          /^@app\/[a-z0-9-]+\/(?:src|workers|worker-host)\//u,
          'cross-MicroVertical imports must use generated API clients, Module Federation, or schema-only Outbox exports rather than private source paths.',
        );
      }
    });

  const allVerticalDirectories = yield* listDirectories('verticals');

  const inspectGeneratedSources = Effect.gen(function* inspectGeneratedSourcesEffect() {
    const generatedFiles = [
      ...(yield* listFiles('apps')),
      ...(yield* listFiles('verticals')),
      ...(yield* listFiles('packages')),
    ];
    const textFiles = generatedFiles.filter((file) => /\.(?:[cm]?[jt]sx?|json|md|mjs|mts|cts)$/u.test(file));

    for (const file of textFiles) {
      sourceByFile.set(file, yield* readText(file));
    }

    for (const [file, content] of sourceByFile) {
      if (/\.[cm]?[jt]sx?$/u.test(file)) {
        yield* assertPrivateOwnerImports(file, content);
      }
    }
  });
  yield* inspectGeneratedSources;

  const verticalDirectories: string[] = [];
  for (const verticalPath of allVerticalDirectories) {
    if (yield* exists(`${verticalPath}/package.json`)) {
      verticalDirectories.push(verticalPath);
    }
  }
  const assertVerticalBaseline = (appPath: string, sharedApi: string): void => {
    const vertical = topologyVertical(appPath);
    const basePath = vertical?.api?.basePath;
    const apiPrefix = vertical?.api?.bff?.prefix;
    if (vertical === undefined) {
      fail(`${sharedApi}: topology must declare this MicroVertical owner.`);
    } else if (basePath === undefined || basePath.length === 0) {
      fail(`${sharedApi}: topology must declare api.basePath.`);
    } else if (apiPrefix === undefined || apiPrefix.length === 0) {
      fail(`${sharedApi}: topology must declare api.bff.prefix.`);
    }
  };

  const inspectApiSurfaces = Effect.gen(function* inspectApiSurfacesEffect() {
    for (const verticalPath of verticalDirectories) {
      const sharedApi = `${verticalPath}/shared/api.ts`;
      const sharedApiContent = (yield* exists(sharedApi)) ? yield* readText(sharedApi) : '';
      assertVerticalBaseline(verticalPath, sharedApi);
      if (
        /\bHttpApiEndpoint\./u.test(sharedApiContent) &&
        !isGeneratedInfrastructureReadinessApi(verticalPath, sharedApiContent) &&
        !hasCompleteGeneratedModuleApiSeam(sourceByFile, sharedApi)
      ) {
        fail(
          `${sharedApi}: module APIs require an approved Codesmith generator, structured api registration, verified trusted tenant context, and the server ModuleEntrypointGateway before an endpoint may be introduced.`,
        );
      }
    }
  });
  yield* inspectApiSurfaces;

  const inspectWorkspaceContracts = Effect.gen(function* inspectWorkspaceContractsEffect() {
    if (yield* exists('package.json')) {
      const rootPackageJson = yield* readText('package.json').pipe(Effect.flatMap(decodePackageJson));
      assert(
        rootPackageJson.scripts?.['api:check:ontos'] === 'node ./scripts/check-ontos-api-boundaries.mts',
        'Root package.json must expose api:check:ontos.',
      );
      assert(
        hasNativeApiCheckCommand(rootPackageJson.scripts?.['api:check'], verticalDirectories),
        'Root api:check must run the published framework checker and OntOS schema rules.',
      );
      assert(
        rootPackageJson.scripts?.check?.split(' && ').includes('pnpm api:check') ?? false,
        'Root check script must include the published framework api:check.',
      );
      assert(
        rootPackageJson.scripts?.check?.includes('pnpm api:check:ontos') ?? false,
        'Root check script must include pnpm api:check:ontos.',
      );
    }
  });
  yield* inspectWorkspaceContracts;

  if (failures.length > 0) {
    yield* Console.error('OntOS API boundary check failed:');
    for (const failure of failures) {
      yield* Console.error(`- ${failure}`);
    }
    return failures.length;
  }

  yield* Console.log('OntOS API boundary check passed.');
  return 0;
});

if (process.argv[1] === import.meta.filename) {
  const failureCount = await Effect.runPromise(
    checkApiBoundaries.pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );
  if (failureCount > 0) {
    NodeRuntime.runMain(Effect.fail(new ApiBoundaryCheckFailed({ failureCount })), {
      disableErrorReporting: true,
    });
  }
}
