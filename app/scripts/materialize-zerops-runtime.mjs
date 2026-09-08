#!/usr/bin/env node
/// <reference types="node" />

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Layer, Path, Predicate, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

const packageJsonFile = 'package.json';
const workspacePackageDirectories = ['packages', 'apps', 'verticals'];
const DependencyMapSchema = Schema.Record(Schema.String, Schema.String);
const PlatformFieldSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const RuntimePackageSchema = Schema.Struct({
  cpu: Schema.optional(PlatformFieldSchema),
  dependencies: Schema.optional(DependencyMapSchema),
  exports: Schema.optional(Schema.Json),
  name: Schema.optional(Schema.String),
  optionalDependencies: Schema.optional(DependencyMapSchema),
  os: Schema.optional(PlatformFieldSchema),
  private: Schema.optional(Schema.Boolean),
  scripts: Schema.optional(DependencyMapSchema),
  version: Schema.optional(Schema.String),
});
const CompactConfigSchema = Schema.Struct({
  packageSource: Schema.optional(
    Schema.Struct({
      aliasPackageNamePrefix: Schema.optional(Schema.String),
      aliasScope: Schema.optional(Schema.String),
      modernPackageVersion: Schema.optional(Schema.String),
    }),
  ),
});
const decodeRuntimePackage = Schema.decodeUnknownEffect(RuntimePackageSchema, {
  onExcessProperty: 'preserve',
});
const decodeRuntimePackageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimePackageSchema),
  { onExcessProperty: 'preserve' },
);
const decodeCompactConfigJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CompactConfigSchema),
  { onExcessProperty: 'preserve' },
);
/** @typedef {typeof Schema.Json.Type} JsonValue */
/** @type {import('effect/Schema').Codec<JsonValue, JsonValue>} */
const JsonValueSchema = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Number,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
);
const JsonRecordSchema = Schema.Record(Schema.String, JsonValueSchema);
const decodeDependencyMap = Schema.decodeUnknownEffect(DependencyMapSchema);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(JsonValueSchema, { space: 2 }));
const isJsonRecord = Schema.is(JsonRecordSchema);

/** @typedef {typeof RuntimePackageSchema.Type} RuntimePackage */
/** @typedef {typeof CompactConfigSchema.Type} CompactConfig */

class MaterializationError extends Error {
  /** @param {string} message - Error message. */
  constructor(message) {
    super(message);
    this.name = 'MaterializationError';
  }
}

/** @param {string} message - Error message. */
const fail = (message) => Effect.fail(new MaterializationError(message));

/**
 * @param {string} label - Argument label.
 * @param {string} candidate - Path candidate.
 * @param {import('effect/Path').Path} pathService - Path service.
 */
const assertRelativePath = (label, candidate, pathService) => {
  if (pathService.isAbsolute(candidate) || candidate.split(/[\\/]/u).includes('..')) {
    return fail(`${label} must be a workspace-relative path`);
  }
  return Effect.void;
};

/**
 * @param {string} label - Path label.
 * @param {string} targetPath - Resolved path.
 * @param {string} workspaceRoot - Workspace root.
 * @param {import('effect/Path').Path} pathService - Path service.
 */
const assertInsideWorkspace = (label, targetPath, workspaceRoot, pathService) => {
  const relativePath = pathService.relative(workspaceRoot, targetPath);
  if (relativePath.startsWith('..') || pathService.isAbsolute(relativePath)) {
    return fail(`${label} resolved outside the workspace`);
  }
  return Effect.void;
};

/** @param {string} filePath - Package manifest path. */
const readRuntimePackage = (filePath) =>
  Effect.gen(function* readRuntimePackageEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(filePath);
    return yield* decodeRuntimePackageJson(source);
  });

/** @param {string} filePath - Optional package manifest path. */
const readOptionalRuntimePackage = (filePath) =>
  Effect.gen(function* readOptionalRuntimePackageEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(filePath);
    return exists ? yield* readRuntimePackage(filePath) : null;
  });

/** @param {string} filePath - Optional compact configuration path. */
const readOptionalCompactConfig = (filePath) =>
  Effect.gen(function* readOptionalCompactConfigEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(filePath);
    if (!exists) {
      return null;
    }
    const source = yield* fileSystem.readFileString(filePath);
    return yield* decodeCompactConfigJson(source);
  });

/**
 * @param {string} filePath - Destination path.
 * @param {JsonValue} json - JSON value.
 */
const writeJson = (filePath, json) =>
  Effect.gen(function* writeJsonEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* encodeJson(json);
    yield* fileSystem.writeFileString(filePath, `${source}\n`);
  });

/**
 * @param {Readonly<Record<string, string>> | undefined} dependencies - Dependency section.
 * @param {string} aliasPrefix - Generated package alias prefix.
 * @param {string} modernPackageVersion - Modern.js package version.
 */
const normalizeDependencySection = (dependencies, aliasPrefix, modernPackageVersion) => {
  if (dependencies === undefined) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(dependencies).flatMap(([dependencyName, dependencyVersion]) => {
      if (!dependencyName.startsWith(aliasPrefix)) {
        return [[dependencyName, dependencyVersion]];
      }
      const officialPackageName = `@modern-js/${dependencyName.slice(aliasPrefix.length)}`;
      return [
        [dependencyName, modernPackageVersion],
        [officialPackageName, `npm:${dependencyName}@${modernPackageVersion}`],
      ];
    }),
  );
};

/**
 * @param {RuntimePackage} runtimeManifest - Runtime package manifest.
 * @param {string} workspaceRoot - Workspace root.
 * @param {import('effect/Path').Path} pathService - Path service.
 */
const normalizeRuntimePackageDependencies = (runtimeManifest, workspaceRoot, pathService) =>
  Effect.gen(function* normalizeRuntimePackageDependenciesEffect() {
    const compactConfig = yield* readOptionalCompactConfig(
      pathService.join(workspaceRoot, '.modernjs/ultramodern.json'),
    );
    const modernPackageVersion = compactConfig?.packageSource?.modernPackageVersion;
    const aliasScope = compactConfig?.packageSource?.aliasScope;
    const aliasPackageNamePrefix = compactConfig?.packageSource?.aliasPackageNamePrefix;
    if (
      modernPackageVersion === undefined ||
      aliasScope === undefined ||
      aliasPackageNamePrefix === undefined
    ) {
      return runtimeManifest;
    }

    const aliasPrefix = `@${aliasScope}/${aliasPackageNamePrefix}`;
    const dependencies = normalizeDependencySection(
      runtimeManifest.dependencies,
      aliasPrefix,
      modernPackageVersion,
    );
    const optionalDependencies = normalizeDependencySection(
      runtimeManifest.optionalDependencies,
      aliasPrefix,
      modernPackageVersion,
    );
    const normalizedManifest = { ...runtimeManifest };
    if (dependencies !== null) {
      normalizedManifest.dependencies = dependencies;
    }
    if (optionalDependencies !== null) {
      normalizedManifest.optionalDependencies = optionalDependencies;
    }
    return yield* decodeRuntimePackage(normalizedManifest);
  });

/**
 * @param {string | ReadonlyArray<string> | undefined} field - Platform constraint.
 * @param {string} currentValue - Current platform value.
 */
const platformFieldAllows = (field, currentValue) => {
  /** @type {ReadonlyArray<string>} */
  let values = [];
  if (Predicate.isString(field)) {
    values = [field];
  } else if (Array.isArray(field)) {
    values = field;
  }
  if (values.some((item) => item === `!${currentValue}` || item === '!*')) {
    return false;
  }
  const allowed = values.filter((item) => !item.startsWith('!'));
  return allowed.length === 0 || allowed.includes(currentValue) || allowed.includes('any');
};

/** @param {RuntimePackage} dependencyManifest - Installed dependency manifest. */
const isCurrentPlatformSupported = (dependencyManifest) =>
  platformFieldAllows(dependencyManifest.os, process.platform) &&
  platformFieldAllows(dependencyManifest.cpu, process.arch);

/**
 * @param {string} dependencyName - Dependency package name.
 * @param {string} dependencyVersion - Dependency package version.
 * @param {string} appRoot - Application root.
 * @param {string} workspaceRoot - Workspace root.
 * @param {import('effect/Path').Path} pathService - Path service.
 */
const readInstalledDependencyPackage = (
  dependencyName,
  dependencyVersion,
  appRoot,
  workspaceRoot,
  pathService,
) =>
  Effect.gen(function* readInstalledDependencyPackageEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const dependencySegments = dependencyName.split('/');
    const directCandidates = [
      pathService.join(appRoot, 'node_modules', ...dependencySegments, packageJsonFile),
      pathService.join(workspaceRoot, 'node_modules', ...dependencySegments, packageJsonFile),
    ];
    for (const candidate of directCandidates) {
      const dependencyManifest = yield* readOptionalRuntimePackage(candidate);
      if (
        dependencyManifest?.name === dependencyName &&
        dependencyManifest.version === dependencyVersion
      ) {
        return dependencyManifest;
      }
    }

    const virtualStore = pathService.join(workspaceRoot, 'node_modules/.pnpm');
    if (!(yield* fileSystem.exists(virtualStore))) {
      return null;
    }
    const encodedName = dependencyName.replaceAll('/', '+');
    const storeEntries = yield* fileSystem.readDirectory(virtualStore);
    for (const storeEntry of storeEntries.filter((item) => item.startsWith(`${encodedName}@`))) {
      const candidate = pathService.join(
        virtualStore,
        storeEntry,
        'node_modules',
        ...dependencySegments,
        packageJsonFile,
      );
      const dependencyManifest = yield* readOptionalRuntimePackage(candidate);
      if (
        dependencyManifest?.name === dependencyName &&
        dependencyManifest.version === dependencyVersion
      ) {
        return dependencyManifest;
      }
    }
    return null;
  });

/**
 * @param {Readonly<Record<string, string>> | undefined} dependencies - Dependency section.
 * @param {string} appRoot - Application root.
 * @param {string} workspaceRoot - Workspace root.
 * @param {import('effect/Path').Path} pathService - Path service.
 */
const removeIncompatibleDependencySection = (dependencies, appRoot, workspaceRoot, pathService) => {
  if (dependencies === undefined) {
    return Effect.succeed(null);
  }
  return Effect.filter(
    Object.entries(dependencies),
    ([dependencyName, dependencyVersion]) =>
      Effect.gen(function* filterCompatibleDependencyEffect() {
        const dependencyManifest = yield* readInstalledDependencyPackage(
          dependencyName,
          dependencyVersion,
          appRoot,
          workspaceRoot,
          pathService,
        );
        const compatible =
          dependencyManifest === null || isCurrentPlatformSupported(dependencyManifest);
        if (!compatible) {
          yield* Effect.log(
            `[ultramodern:zerops] excluded ${dependencyName}@${dependencyVersion} from ${process.platform}/${process.arch} runtime`,
          );
        }
        return compatible;
      }),
    { concurrency: 'unbounded' },
  ).pipe(Effect.flatMap((entries) => decodeDependencyMap(Object.fromEntries(entries))));
};

/**
 * @param {RuntimePackage} runtimeManifest - Runtime package manifest.
 * @param {string} appRoot - Application root.
 * @param {string} workspaceRoot - Workspace root.
 * @param {import('effect/Path').Path} pathService - Path service.
 */
const removeIncompatiblePlatformDependencies = (
  runtimeManifest,
  appRoot,
  workspaceRoot,
  pathService,
) =>
  Effect.all(
    [
      removeIncompatibleDependencySection(
        runtimeManifest.dependencies,
        appRoot,
        workspaceRoot,
        pathService,
      ),
      removeIncompatibleDependencySection(
        runtimeManifest.optionalDependencies,
        appRoot,
        workspaceRoot,
        pathService,
      ),
    ],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.flatMap(([dependencies, optionalDependencies]) => {
      const compatibleManifest = { ...runtimeManifest };
      if (dependencies !== null) {
        compatibleManifest.dependencies = dependencies;
      }
      if (optionalDependencies !== null) {
        compatibleManifest.optionalDependencies = optionalDependencies;
      }
      return decodeRuntimePackage(compatibleManifest);
    }),
  );

/**
 * @param {string} absoluteDirectory - Workspace package parent directory.
 * @param {import('effect/Path').Path} pathService - Path service.
 */
const collectPackageDirectoryEntries = (absoluteDirectory, pathService) =>
  Effect.gen(function* collectPackageDirectoryEntriesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(absoluteDirectory))) {
      return [];
    }
    const entries = yield* fileSystem.readDirectory(absoluteDirectory);
    const packageEntries = yield* Effect.forEach(
      entries,
      (item) =>
        Effect.gen(function* collectPackageManifestEffect() {
          const packageDirectory = pathService.join(absoluteDirectory, item);
          const packageManifest = yield* readOptionalRuntimePackage(
            pathService.join(packageDirectory, packageJsonFile),
          );
          return packageManifest?.name === undefined
            ? null
            : [packageManifest.name, packageDirectory];
        }),
      { concurrency: 'unbounded' },
    );
    return packageEntries.filter((entry) => entry !== null);
  });

/**
 * @param {string} workspaceRoot - Workspace root.
 * @param {import('effect/Path').Path} pathService - Path service.
 */
const collectWorkspacePackages = (workspaceRoot, pathService) =>
  Effect.gen(function* collectWorkspacePackagesEffect() {
    const packageEntries = yield* Effect.forEach(
      workspacePackageDirectories,
      (directory) => {
        const absoluteDirectory = pathService.join(workspaceRoot, directory);
        return collectPackageDirectoryEntries(absoluteDirectory, pathService);
      },
      { concurrency: 'unbounded' },
    );
    return new Map(packageEntries.flat());
  });

/**
 * @param {RuntimePackage} runtimeManifest - Runtime package manifest.
 * @param {ReadonlyMap<string, string>} workspacePackages - Workspace package locations.
 */
const removeWorkspaceDependencies = (runtimeManifest, workspacePackages) => {
  /** @param {Readonly<Record<string, string>> | undefined} dependencies - Dependency section. */
  const filterSection = (dependencies) => {
    if (dependencies === undefined) {
      return { dependencies: null, localDependencies: [] };
    }
    const entries = Object.entries(dependencies);
    return {
      dependencies: Object.fromEntries(
        entries.filter(([dependencyName]) => !workspacePackages.has(dependencyName)),
      ),
      localDependencies: entries
        .filter(([dependencyName]) => workspacePackages.has(dependencyName))
        .map(([dependencyName]) => dependencyName),
    };
  };
  const runtimeDependencies = filterSection(runtimeManifest.dependencies);
  const runtimeOptionalDependencies = filterSection(runtimeManifest.optionalDependencies);
  const installPackage = structuredClone(runtimeManifest);
  if (runtimeDependencies.dependencies !== null) {
    installPackage.dependencies = runtimeDependencies.dependencies;
  }
  if (runtimeOptionalDependencies.dependencies !== null) {
    installPackage.optionalDependencies = runtimeOptionalDependencies.dependencies;
  }
  return {
    installPackage,
    localDependencies: [
      ...runtimeDependencies.localDependencies,
      ...runtimeOptionalDependencies.localDependencies,
    ],
  };
};

/**
 * @param {string} sourceDirectory - Source directory.
 * @param {string} targetDirectory - Target directory.
 * @param {import('effect/Path').Path} pathService - Path service.
 * @returns {import('effect/Effect').Effect<void, unknown, import('effect/FileSystem').FileSystem>} Copy effect.
 */
const copyDirectoryWithoutNodeModules = (sourceDirectory, targetDirectory, pathService) =>
  Effect.gen(function* copyDirectoryWithoutNodeModulesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(targetDirectory, { recursive: true });
    const entries = yield* fileSystem.readDirectory(sourceDirectory);
    yield* Effect.forEach(
      entries.filter((item) => item !== 'node_modules'),
      (item) => {
        const sourcePath = pathService.join(sourceDirectory, item);
        const targetPath = pathService.join(targetDirectory, item);
        return fileSystem
          .stat(sourcePath)
          .pipe(
            Effect.flatMap((info) =>
              info.type === 'Directory'
                ? copyDirectoryWithoutNodeModules(sourcePath, targetPath, pathService)
                : fileSystem.copy(sourcePath, targetPath, { overwrite: true }),
            ),
          );
      },
      { concurrency: 'unbounded', discard: true },
    );
  });

/**
 * @param {JsonValue} exportTarget - Package exports value.
 * @returns {JsonValue} Rewritten package exports value.
 */
const rewriteTsExports = (exportTarget) => {
  if (Predicate.isString(exportTarget)) {
    return exportTarget.replace(/\.ts$/u, '.js');
  }
  if (Array.isArray(exportTarget)) {
    return exportTarget.map(rewriteTsExports);
  }
  if (isJsonRecord(exportTarget)) {
    /** @type {Readonly<Record<string, JsonValue>>} */
    const rewritten = Object.fromEntries(
      Object.entries(exportTarget).map(([key, entry]) => [key, rewriteTsExports(entry)]),
    );
    return rewritten;
  }
  return exportTarget;
};

/** @param {string} directory - Directory to scan. */
const listTsFiles = (directory) =>
  Effect.gen(function* listTsFilesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const entries = yield* fileSystem.readDirectory(directory, { recursive: true });
    return entries
      .filter((item) => item.endsWith('.ts') && !item.endsWith('.d.ts'))
      .map((item) => `${directory}/${item}`);
  });

/** @param {string} parameters - TypeScript parameter source. */
const stripParameterTypes = (parameters) =>
  parameters.replaceAll(/(?<parameter>[A-Za-z_$][\w$]*)\??:\s*[^,]+/gu, '$<parameter>');

/** @param {string} _match - Full match. @param {string} parameters - Parameter source. */
const rewriteArrowParameters = (_match, parameters) => `(${stripParameterTypes(parameters)}) =>`;

/** @param {string} _match - Full match. @param {string} name - Function name. @param {string} parameters - Parameter source. */
const rewriteFunctionParameters = (_match, name, parameters) =>
  `function${name}(${stripParameterTypes(parameters)})`;

/** @param {string} source - TypeScript source. */
const transpileGeneratedPackageTs = (source) =>
  source
    .replaceAll(/^\s*import\s+type\s+[^;]+;\s*$/gmu, '')
    .replaceAll(/^\s*export\s+type\s+[^;]+;\s*$/gmu, '')
    .replaceAll(/^\s*type\s+\w+\s*=\s*[^;]+;\s*$/gmu, '')
    .replaceAll(/^\s*interface\s+\w+\s*\{[^}]*\}\s*$/gmsu, '')
    .replaceAll(
      /\b(?<declaration>const|let|var)\s+(?<binding>[A-Za-z_$][\w$]*)\s*:\s*[^=]+=/gu,
      '$<declaration> $<binding> =',
    )
    .replaceAll(/\((?<parameters>[^)]*)\)\s*:\s*[^=]+=>/gu, rewriteArrowParameters)
    .replaceAll(/\((?<parameters>[^)]*)\)\s*=>/gu, rewriteArrowParameters)
    .replaceAll(/function(?<name>\s+\w+\s*)\((?<parameters>[^)]*)\)/gu, rewriteFunctionParameters)
    .replaceAll(/\s+as\s+const\b/gu, '')
    .replaceAll(/\s+satisfies\s+[A-Za-z_$][\w$]*(?:<[^>]+>)?/gu, '');

/** @param {string} packageDirectory - Copied workspace package directory. */
const makeWorkspacePackageRuntimeSafe = (packageDirectory) =>
  Effect.gen(function* makeWorkspacePackageRuntimeSafeEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const packageManifestPath = pathService.join(packageDirectory, packageJsonFile);
    const packageManifest = yield* readOptionalRuntimePackage(packageManifestPath);
    if (packageManifest !== null) {
      const runtimeSafePackage = { ...packageManifest };
      if (packageManifest.exports !== undefined) {
        runtimeSafePackage.exports = rewriteTsExports(packageManifest.exports);
      }
      const runtimeSafeManifest = yield* decodeRuntimePackage(runtimeSafePackage);
      yield* writeJson(packageManifestPath, runtimeSafeManifest);
    }
    const tsFiles = yield* listTsFiles(packageDirectory);
    yield* Effect.forEach(
      tsFiles,
      (tsFile) =>
        Effect.gen(function* transpileWorkspacePackageFileEffect() {
          const source = yield* fileSystem.readFileString(tsFile);
          yield* fileSystem.writeFileString(
            tsFile.replace(/\.ts$/u, '.js'),
            transpileGeneratedPackageTs(source),
          );
        }),
      { concurrency: 'unbounded', discard: true },
    );
  });

/**
 * @param {string} workspacePackageName - Workspace package name.
 * @param {ReadonlyMap<string, string>} workspacePackages - Workspace package locations.
 * @param {string} runtimeDir - Runtime directory.
 * @param {import('effect/Path').Path} pathService - Path service.
 */
const copyWorkspacePackage = (workspacePackageName, workspacePackages, runtimeDir, pathService) => {
  const sourceDirectory = workspacePackages.get(workspacePackageName);
  if (sourceDirectory === undefined) {
    return Effect.void;
  }
  return Effect.gen(function* copyWorkspacePackageEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const targetDirectory = pathService.join(
      runtimeDir,
      'node_modules',
      ...workspacePackageName.split('/'),
    );
    yield* fileSystem.remove(targetDirectory, { force: true, recursive: true });
    yield* fileSystem.makeDirectory(pathService.dirname(targetDirectory), { recursive: true });
    yield* copyDirectoryWithoutNodeModules(sourceDirectory, targetDirectory, pathService);
    yield* makeWorkspacePackageRuntimeSafe(targetDirectory);
  });
};

/**
 * @param {RuntimePackage} runtimeManifest - Runtime package manifest.
 * @param {string} appId - Application identifier.
 * @param {string} runtimeDir - Runtime directory.
 * @param {string} workspaceRoot - Workspace root.
 * @param {import('effect/Path').Path} pathService - Path service.
 */
const installRuntimeDependencies = (
  runtimeManifest,
  appId,
  runtimeDir,
  workspaceRoot,
  pathService,
) =>
  Effect.gen(function* installRuntimeDependenciesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const installDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: `ultramodern-zerops-${appId}-`,
    });
    const workspacePackages = yield* collectWorkspacePackages(workspaceRoot, pathService);
    const { installPackage, localDependencies } = removeWorkspaceDependencies(
      runtimeManifest,
      workspacePackages,
    );
    yield* writeJson(pathService.join(installDir, packageJsonFile), installPackage);
    const installCommand = ChildProcess.make(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--omit=dev', '--no-audit', '--fund=false', '--legacy-peer-deps'],
      { cwd: installDir, stderr: 'inherit', stdin: 'inherit', stdout: 'inherit' },
    );
    const installExitCode = yield* childProcessSpawner.exitCode(installCommand);
    if (installExitCode !== 0) {
      yield* fail(`npm install failed with exit code ${installExitCode}`);
    }
    yield* fileSystem.remove(pathService.join(runtimeDir, 'node_modules'), {
      force: true,
      recursive: true,
    });
    const installedModules = pathService.join(installDir, 'node_modules');
    if (yield* fileSystem.exists(installedModules)) {
      yield* fileSystem.copy(installedModules, pathService.join(runtimeDir, 'node_modules'));
    }
    yield* Effect.forEach(
      localDependencies,
      (dependency) => copyWorkspacePackage(dependency, workspacePackages, runtimeDir, pathService),
      { discard: true },
    );
  });

const materializeCommand = Command.make(
  'materialize-zerops-runtime',
  {
    appId: Flag.string('app'),
    packageDir: Flag.string('package-dir'),
    packageName: Flag.string('package'),
    worker: Flag.boolean('worker').pipe(Flag.withDefault(false)),
  },
  ({ appId, packageDir, packageName, worker }) =>
    Effect.gen(function* materializeCommandEffect() {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const workspaceRoot = pathService.resolve(
        yield* Config.string('ULTRAMODERN_WORKSPACE_ROOT').pipe(Config.withDefault(process.cwd())),
      );
      yield* assertRelativePath('--package-dir', packageDir, pathService);
      const appRoot = pathService.resolve(workspaceRoot, packageDir);
      const appOutputDir = pathService.join(appRoot, '.output');
      const runtimeDir = pathService.join(
        workspaceRoot,
        '.zerops/runtime',
        worker ? `${appId}-worker` : appId,
      );
      yield* Effect.all(
        [
          assertInsideWorkspace('package directory', appRoot, workspaceRoot, pathService),
          assertInsideWorkspace('runtime directory', runtimeDir, workspaceRoot, pathService),
        ],
        { discard: true },
      );

      const appPackage = yield* readRuntimePackage(pathService.join(appRoot, packageJsonFile));
      const prepareRuntimeDirectory = Effect.gen(function* prepareRuntimeDirectoryEffect() {
        if (appPackage.name !== packageName) {
          yield* fail(`--package must match ${packageDir}/package.json name`);
        }
        if (!worker && !(yield* fileSystem.exists(appOutputDir))) {
          yield* fail(
            `Modern.js package build must produce ${pathService.relative(workspaceRoot, appOutputDir)} before runtime materialization`,
          );
        }

        yield* fileSystem.remove(runtimeDir, { force: true, recursive: true });
        yield* fileSystem.makeDirectory(pathService.dirname(runtimeDir), { recursive: true });
        yield* worker
          ? fileSystem.makeDirectory(runtimeDir, { recursive: true })
          : fileSystem.copy(appOutputDir, runtimeDir);
        const entryPath = pathService.join(runtimeDir, 'index.js');
        if (!worker && !(yield* fileSystem.exists(entryPath))) {
          yield* fail(
            `Modern.js Node deploy output is missing ${pathService.relative(workspaceRoot, entryPath)}`,
          );
        }
      });
      yield* prepareRuntimeDirectory;
      const packageJsonPath = pathService.join(runtimeDir, packageJsonFile);
      /** @type {RuntimePackage} */
      let runtimePackage = (yield* readOptionalRuntimePackage(packageJsonPath)) ?? {};
      if (worker) {
        const outboxWorkerModule = yield* Effect.tryPromise({
          catch: (cause) => new MaterializationError(String(cause)),
          try: async () => await import('./materialize-outbox-worker.mjs'),
        });
        runtimePackage = yield* Effect.tryPromise({
          catch: (cause) => new MaterializationError(String(cause)),
          try: async () =>
            await outboxWorkerModule.materializeOutboxWorker({
              appId,
              packageDir,
              packageName,
              runtimeDir,
              workspaceRoot,
            }),
        }).pipe(Effect.flatMap(decodeRuntimePackage));
      }
      runtimePackage = yield* normalizeRuntimePackageDependencies(
        runtimePackage,
        workspaceRoot,
        pathService,
      );
      runtimePackage = yield* removeIncompatiblePlatformDependencies(
        runtimePackage,
        appRoot,
        workspaceRoot,
        pathService,
      );
      runtimePackage = yield* decodeRuntimePackage({
        ...runtimePackage,
        name: runtimePackage.name ?? `${appId}-zerops-runtime`,
        private: true,
        scripts: {
          ...runtimePackage.scripts,
          serve: runtimePackage.scripts?.serve ?? 'node index.js',
        },
      });
      yield* writeJson(packageJsonPath, runtimePackage);
      yield* installRuntimeDependencies(
        runtimePackage,
        appId,
        runtimeDir,
        workspaceRoot,
        pathService,
      );
      yield* Effect.log(
        `[ultramodern:zerops] materialized ${appId} runtime at ${pathService.relative(
          workspaceRoot,
          runtimeDir,
        )}`,
      );
    }),
);

const program = Command.run(materializeCommand, { version: '1.0.0' });

const executableLayer = Layer.effectDiscard(program).pipe(Layer.provide(NodeServices.layer));
await Effect.runPromise(Effect.scoped(Layer.build(executableLayer)));
