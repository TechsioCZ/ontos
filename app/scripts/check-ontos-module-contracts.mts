#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node';
import { Effect, Equal, FileSystem, Layer, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_PATH,
  OntosDeploymentAppIdSchema,
  OntosModuleDeploymentContractSchema,
  OntosModuleIdSchema,
  buildInstalledModuleCatalog,
} from '../packages/core-runtime/src/index.ts';
import type {
  InstalledDeploymentContractInput,
  OntosModuleDeploymentContract,
} from '../packages/core-runtime/src/index.ts';
import { deriveOntosModuleDeploymentContract } from './generate-ontos-module-contract.mts';
import {
  MODULE_CONTRACT_GENERATOR_HEADER,
  MODULE_MANIFEST_ACTION_SLOT_END,
  MODULE_MANIFEST_ACTION_SLOT_START,
  MODULE_MANIFEST_API_SLOT_END,
  MODULE_MANIFEST_API_SLOT_START,
  MODULE_MANIFEST_COMPONENT_SLOT_END,
  MODULE_MANIFEST_COMPONENT_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_MANIFEST_REPORT_SLOT_END,
  MODULE_MANIFEST_REPORT_SLOT_START,
  MODULE_MANIFEST_SEARCH_SLOT_END,
  MODULE_MANIFEST_SEARCH_SLOT_START,
  MODULE_MANIFEST_SHELL_COMPONENT_SLOT_END,
  MODULE_MANIFEST_SHELL_COMPONENT_SLOT_START,
  MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
  MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
  MODULE_MANIFEST_SHELL_PAGE_SLOT_END,
  MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
  MODULE_MANIFEST_SHELL_REPORT_SLOT_END,
  MODULE_MANIFEST_SHELL_REPORT_SLOT_START,
  MODULE_MANIFEST_SHELL_SEARCH_SLOT_END,
  MODULE_MANIFEST_SHELL_SEARCH_SLOT_START,
  MODULE_REGISTRATION_ACTION_SLOT_END,
  MODULE_REGISTRATION_ACTION_SLOT_START,
  MODULE_REGISTRATION_API_SLOT_END,
  MODULE_REGISTRATION_API_SLOT_START,
  MODULE_REGISTRATION_COMPONENT_SLOT_END,
  MODULE_REGISTRATION_COMPONENT_SLOT_START,
  MODULE_REGISTRATION_IMPORT_SLOT_END,
  MODULE_REGISTRATION_IMPORT_SLOT_START,
  MODULE_REGISTRATION_PAGE_SLOT_END,
  MODULE_REGISTRATION_PAGE_SLOT_START,
  MODULE_REGISTRATION_REPORT_SLOT_END,
  MODULE_REGISTRATION_REPORT_SLOT_START,
  MODULE_REGISTRATION_SEARCH_SLOT_END,
  MODULE_REGISTRATION_SEARCH_SLOT_START,
  MODULE_REGISTRATION_WORKER_SLOT_END,
  MODULE_REGISTRATION_WORKER_SLOT_START,
  ONTOS_MODULE_CONTRACT_PACKAGE_SCHEMA_VERSION,
} from './scaffolding/shared.mts';

const TopologySchema = Schema.Struct({
  verticals: Schema.Array(
    Schema.Struct({
      id: OntosDeploymentAppIdSchema,
      path: Schema.String,
    })
  ),
});

const DevelopmentOverlaySchema = Schema.Struct({
  ontosModuleManifests: Schema.Record(Schema.String, Schema.String),
});

const ModulePackageSchema = Schema.Struct({
  modernjs: Schema.Struct({
    appId: OntosDeploymentAppIdSchema,
    ontosModule: Schema.Struct({
      moduleId: OntosModuleIdSchema,
      schemaVersion: Schema.Number,
    }),
  }),
  scripts: Schema.Record(Schema.String, Schema.String),
});

export class OntosModuleContractCheckError extends Schema.TaggedError<OntosModuleContractCheckError>()(
  'OntosModuleContractCheckError',
  { reason: Schema.String }
) {}

const failure = (reason: string): OntosModuleContractCheckError =>
  new OntosModuleContractCheckError({ reason });

const sourceExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

type TopologyVertical = (typeof TopologySchema.Type.verticals)[number];

const walkSourceFiles = (
  directory: string
): Effect.Effect<readonly string[], PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* walkSourceDirectory() {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(directory))) {
      return [];
    }
    const entries = yield* fileSystem.readDirectory(directory);
    const files = yield* Effect.all(
      entries.map((entry) =>
        Effect.gen(function* inspectSourceEntry() {
          if (entry === 'node_modules' || entry.startsWith('dist')) {
            return [];
          }
          const target = path.join(directory, entry);
          const info = yield* fileSystem.stat(target);
          if (info.type === 'Directory') {
            return yield* walkSourceFiles(target);
          }
          if (sourceExtensions.has(path.extname(entry))) {
            return [target];
          }
          return [];
        })
      )
    );
    return files.flat();
  });

const checkSharedSourceFile = (
  fileSystem: FileSystem.FileSystem,
  filePath: string
) =>
  Effect.gen(function* checkSharedSource() {
    const content = yield* fileSystem.readFileString(filePath);
    if (
      /(?:from\s+|import\s*\(|require\s*\()\s*['"][^'"]*(?:vertical\.manifest|vertical\.registration)(?:\.ts)?['"]/u.test(
        content
      )
    ) {
      yield* failure(
        `${filePath} imports a private deployment manifest or registration`
      );
    }
    if (
      /(?:from\s+|import\s*\(|require\s*\()\s*['"][^'"]*(?:verticals\/|@app\/(?!core-runtime(?:\/|['"])))[^'"]*\/(?:src|routes|providers|handlers|repositories|db|vertical\.registration)(?:\/|['"])/u.test(
        content
      )
    ) {
      yield* failure(`${filePath} imports production vertical private source`);
    }
  });

const checkOwnerSourceFile = (
  fileSystem: FileSystem.FileSystem,
  ownerRoot: string,
  filePath: string
) =>
  Effect.gen(function* checkOwnerSource() {
    const content = yield* fileSystem.readFileString(filePath);
    const imports = [
      ...content.matchAll(
        /(?:from\s+|import\s*\(|require\s*\()\s*['"](?<specifier>[^'"]+)['"]/gu
      ),
    ];
    const hasPrivateOwnerImportViolation = imports.some((match) => {
      const specifier = match.groups?.specifier;
      if (
        specifier === undefined ||
        !/vertical\.(?:manifest|registration)(?:\.ts)?$/u.test(specifier)
      ) {
        return false;
      }
      if (!specifier.startsWith('.')) {
        return true;
      }
      const resolved = path.resolve(path.dirname(filePath), specifier);
      return !resolved.startsWith(`${ownerRoot}${path.sep}`);
    });
    if (hasPrivateOwnerImportViolation) {
      yield* failure(
        `${filePath} imports another deployment's private owner file`
      );
    }
  });

const checkOwnerDirectory = (
  fileSystem: FileSystem.FileSystem,
  ownerRoot: string
) =>
  walkSourceFiles(ownerRoot).pipe(
    Effect.flatMap((ownerFiles) =>
      Effect.all(
        ownerFiles.map((filePath) =>
          checkOwnerSourceFile(fileSystem, ownerRoot, filePath)
        )
      )
    )
  );

const assertNoPrivateDeploymentImports = (
  workspaceRoot: string,
  verticals: readonly TopologyVertical[]
) =>
  Effect.gen(function* checkPrivateDeploymentImports() {
    const fileSystem = yield* FileSystem.FileSystem;
    const sharedRoots = [
      path.join(workspaceRoot, 'apps/shell-super-app'),
      path.join(workspaceRoot, 'packages/core-runtime'),
    ];
    const sharedFiles = yield* Effect.all(sharedRoots.map(walkSourceFiles));
    yield* Effect.all(
      sharedFiles
        .flat()
        .map((filePath) => checkSharedSourceFile(fileSystem, filePath))
    );
    yield* Effect.all(
      verticals.map((vertical) => {
        const ownerRoot = path.join(workspaceRoot, vertical.path);
        return checkOwnerDirectory(fileSystem, ownerRoot);
      })
    );
  });

const occursExactlyOnce = (content: string, marker: string): boolean =>
  content.includes(marker) &&
  content.indexOf(marker) === content.lastIndexOf(marker);

const validateOwner = (filePath: string, markers: readonly string[]) =>
  Effect.gen(function* validateGeneratedOwner() {
    const fileSystem = yield* FileSystem.FileSystem;
    const content = yield* fileSystem.readFileString(filePath);
    if (!content.startsWith(`${MODULE_CONTRACT_GENERATOR_HEADER}\n`)) {
      return yield* failure(
        `${filePath} is not a generated module-contract owner`
      );
    }
    const invalidMarker = markers.find(
      (marker) => !occursExactlyOnce(content, marker)
    );
    if (invalidMarker !== undefined) {
      return yield* failure(
        `${filePath} must contain exactly one ${invalidMarker}`
      );
    }
    const moduleId = /^\/\/ @ontos-module-id (?<moduleId>[^\s]+)$/mu.exec(
      content
    )?.groups?.moduleId;
    if (moduleId === undefined) {
      return yield* failure(
        `${filePath} is missing its generated module ID marker`
      );
    }
    return moduleId;
  });

const validateEmittedContract = (
  verticalDirectory: string,
  target: string,
  expected: OntosModuleDeploymentContract
) =>
  Effect.gen(function* validateGeneratedContract() {
    const fileSystem = yield* FileSystem.FileSystem;
    const publicDirectory = path.join(verticalDirectory, target, 'public');
    if (!(yield* fileSystem.exists(publicDirectory))) {
      return;
    }
    const contractPath = path.join(
      publicDirectory,
      ONTOS_MODULE_CONTRACT_PATH.slice(1)
    );
    if (!(yield* fileSystem.exists(contractPath))) {
      yield* failure(
        `${target} output is missing ${ONTOS_MODULE_CONTRACT_PATH}`
      );
    }
    const content = yield* fileSystem.readFile(contractPath);
    if (content.byteLength > ONTOS_MODULE_CONTRACT_MAX_BYTES) {
      yield* failure(`${contractPath} exceeds the 1 MiB contract limit`);
    }
    const serialized = new TextDecoder().decode(content);
    const contract = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(OntosModuleDeploymentContractSchema),
      { onExcessProperty: 'error' }
    )(serialized);
    if (
      contract.deployment.appId !== expected.deployment.appId ||
      contract.manifest.module.id !== expected.manifest.module.id
    ) {
      yield* failure(
        `${contractPath} identity does not match its generated owner metadata`
      );
    }
    if (!Equal.equals(contract, expected)) {
      yield* failure(
        `${contractPath} is stale relative to its authored module contract`
      );
    }
    if (
      /sourcePath|importPath|exportPath|registrationPath|handlerPath|migrationPath/u.test(
        serialized
      )
    ) {
      yield* failure(
        `${contractPath} contains forbidden private path metadata`
      );
    }
    const validateResponseHeaders = Effect.gen(
      function* validateResponseHeadersEffect() {
        const headersPath = path.join(publicDirectory, '_headers');
        const headers = yield* fileSystem.readFileString(headersPath);
        if (
          !headers.includes('Cache-Control: no-cache') ||
          !headers.includes('Content-Type: application/json') ||
          !/^ {2}ETag: "[a-f0-9]{64}"$/mu.test(headers)
        ) {
          yield* failure(
            `${headersPath} is missing the immutable module-contract response headers`
          );
        }
      }
    );
    yield* validateResponseHeaders;
  });

const manifestMarkers = [
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_ACTION_SLOT_START,
  MODULE_MANIFEST_ACTION_SLOT_END,
  MODULE_MANIFEST_API_SLOT_START,
  MODULE_MANIFEST_API_SLOT_END,
  MODULE_MANIFEST_COMPONENT_SLOT_START,
  MODULE_MANIFEST_COMPONENT_SLOT_END,
  MODULE_MANIFEST_REPORT_SLOT_START,
  MODULE_MANIFEST_REPORT_SLOT_END,
  MODULE_MANIFEST_SEARCH_SLOT_START,
  MODULE_MANIFEST_SEARCH_SLOT_END,
  MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
  MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
  MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
  MODULE_MANIFEST_SHELL_PAGE_SLOT_END,
  MODULE_MANIFEST_SHELL_COMPONENT_SLOT_START,
  MODULE_MANIFEST_SHELL_COMPONENT_SLOT_END,
  MODULE_MANIFEST_SHELL_REPORT_SLOT_START,
  MODULE_MANIFEST_SHELL_REPORT_SLOT_END,
  MODULE_MANIFEST_SHELL_SEARCH_SLOT_START,
  MODULE_MANIFEST_SHELL_SEARCH_SLOT_END,
] as const;

const registrationMarkers = [
  MODULE_REGISTRATION_IMPORT_SLOT_START,
  MODULE_REGISTRATION_IMPORT_SLOT_END,
  MODULE_REGISTRATION_ACTION_SLOT_START,
  MODULE_REGISTRATION_ACTION_SLOT_END,
  MODULE_REGISTRATION_API_SLOT_START,
  MODULE_REGISTRATION_API_SLOT_END,
  MODULE_REGISTRATION_COMPONENT_SLOT_START,
  MODULE_REGISTRATION_COMPONENT_SLOT_END,
  MODULE_REGISTRATION_PAGE_SLOT_START,
  MODULE_REGISTRATION_PAGE_SLOT_END,
  MODULE_REGISTRATION_REPORT_SLOT_START,
  MODULE_REGISTRATION_REPORT_SLOT_END,
  MODULE_REGISTRATION_SEARCH_SLOT_START,
  MODULE_REGISTRATION_SEARCH_SLOT_END,
  MODULE_REGISTRATION_WORKER_SLOT_START,
  MODULE_REGISTRATION_WORKER_SLOT_END,
] as const;

const checkVertical = (
  workspaceRoot: string,
  vertical: TopologyVertical,
  contractUrl: string
) =>
  Effect.gen(function* checkVerticalContract() {
    const fileSystem = yield* FileSystem.FileSystem;
    const appId = vertical.id;
    const relativePath = vertical.path;
    const verticalDirectory = path.join(workspaceRoot, relativePath);
    const packageSource = yield* fileSystem.readFileString(
      path.join(verticalDirectory, 'package.json')
    );
    const packageJson = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ModulePackageSchema),
      { onExcessProperty: 'preserve' }
    )(packageSource);
    const manifestPath = path.join(verticalDirectory, 'vertical.manifest.ts');
    const registrationPath = path.join(
      verticalDirectory,
      'vertical.registration.ts'
    );
    const [manifestModuleId, registrationModuleId] = yield* Effect.all([
      validateOwner(manifestPath, manifestMarkers),
      validateOwner(registrationPath, registrationMarkers),
    ]);
    if (
      packageJson.modernjs.appId !== appId ||
      packageJson.modernjs.ontosModule.moduleId !== manifestModuleId ||
      registrationModuleId !== manifestModuleId ||
      packageJson.modernjs.ontosModule.schemaVersion !==
        ONTOS_MODULE_CONTRACT_PACKAGE_SCHEMA_VERSION
    ) {
      return yield* failure(
        `${appId} package, manifest, registration, and topology identities disagree`
      );
    }
    const verticalName = path.basename(relativePath);
    if (
      !packageJson.scripts.build?.includes(
        `--vertical ${verticalName} --target dist`
      ) ||
      !packageJson.scripts['cloudflare:build']?.includes(
        `--vertical ${verticalName} --target cloudflare-dist`
      )
    ) {
      return yield* failure(
        `${appId} build scripts do not emit both module-contract deployment targets`
      );
    }
    if (!contractUrl.endsWith(ONTOS_MODULE_CONTRACT_PATH)) {
      return yield* failure(
        `${appId} development module-contract URL is invalid`
      );
    }
    const derived = yield* Effect.tryPromise({
      catch: () =>
        failure(`${appId} authored module contract could not be derived`),
      try: async () =>
        await deriveOntosModuleDeploymentContract({
          vertical: verticalName,
          workspaceRoot,
        }),
    });
    if (
      derived.deployment.appId !== appId ||
      derived.manifest.module.id !== manifestModuleId
    ) {
      return yield* failure(
        `${appId} authored module contract disagrees with generated owner metadata`
      );
    }
    yield* Effect.all([
      validateEmittedContract(verticalDirectory, 'dist', derived),
      validateEmittedContract(verticalDirectory, 'dist-cloudflare', derived),
    ]);
    return {
      contract: derived,
      expectedAppId: derived.deployment.appId,
    } satisfies InstalledDeploymentContractInput;
  });

const checkOntosModuleContractsEffect = (workspaceRoot: string) =>
  Effect.gen(function* checkWorkspaceContracts() {
    const fileSystem = yield* FileSystem.FileSystem;
    const topologySource = yield* fileSystem.readFileString(
      path.join(workspaceRoot, 'topology/reference-topology.json')
    );
    const topology = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(TopologySchema),
      {
        onExcessProperty: 'preserve',
      }
    )(topologySource);
    yield* assertNoPrivateDeploymentImports(workspaceRoot, topology.verticals);
    const overlaySource = yield* fileSystem.readFileString(
      path.join(workspaceRoot, 'topology/local-overlays/development.json')
    );
    const overlay = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(DevelopmentOverlaySchema),
      { onExcessProperty: 'preserve' }
    )(overlaySource);
    const appIds = topology.verticals.map((vertical) => vertical.id);
    const allowlistKeys = Object.keys(overlay.ontosModuleManifests);
    const keysMatch =
      allowlistKeys.length === appIds.length &&
      appIds.every((appId) =>
        Object.hasOwn(overlay.ontosModuleManifests, appId)
      );
    if (!keysMatch) {
      yield* failure(
        'development ontosModuleManifests keys must exactly match topology verticals'
      );
    }
    const contracts = yield* Effect.all(
      topology.verticals.map((vertical) =>
        checkVertical(
          workspaceRoot,
          vertical,
          overlay.ontosModuleManifests[vertical.id]
        )
      )
    );
    const moduleIds = contracts.map(
      (entry) => entry.contract.manifest.module.id
    );
    const duplicateModuleId = moduleIds.find(
      (moduleId, index) => moduleIds.indexOf(moduleId) !== index
    );
    if (duplicateModuleId !== undefined) {
      yield* failure(`duplicate OntOS module ID ${duplicateModuleId}`);
    }
    buildInstalledModuleCatalog(contracts);
  });

export const checkOntosModuleContracts = (workspaceRoot = process.cwd()) =>
  checkOntosModuleContractsEffect(workspaceRoot);

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const programLayer = Layer.effectDiscard(
    checkOntosModuleContracts().pipe(
      Effect.tap(() => Effect.logInfo('OntOS module contracts validated'))
    )
  ).pipe(Layer.provide(NodeFileSystem.layer));
  NodeRuntime.runMain(Effect.scoped(Layer.build(programLayer)));
}
