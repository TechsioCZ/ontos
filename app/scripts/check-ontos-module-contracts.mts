#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeServices, NodeRuntime } from '@effect/platform-node';
import { Effect, Equal, FileSystem, Layer, Predicate, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { parseSync, Visitor } from 'oxc-parser';
import type { Argument, Expression } from 'oxc-parser';

import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_PATH,
  OntosDeploymentAppIdSchema,
  OntosModuleDeploymentContractSchema,
  OntosMcpToolCatalogJsonSchema,
  OntosModuleIdSchema,
  buildInstalledModuleCatalog,
  registeredWorkloadCallReceiverIssue,
} from '../packages/core-runtime/src/index.ts';
import type {
  InstalledDeploymentContractInput,
  OntosModuleDeploymentContract,
  RegisteredWorkloadCallReceiver,
} from '../packages/core-runtime/src/index.ts';
import { deriveOntosModuleDeploymentContract } from './generate-ontos-module-contract.mts';
import {
  MODULE_CONTRACT_GENERATOR_HEADER,
  readModuleRuntimeDeclarationEffect,
  toCamelCase,
  MODULE_MANIFEST_OPERATION_SLOT_START,
  MODULE_MANIFEST_OPERATION_SLOT_END,
  MODULE_REGISTRATION_READ_SLOT_START,
  MODULE_REGISTRATION_READ_SLOT_END,
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
    }),
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
  { cause: Schema.optional(Schema.Defect()), message: Schema.String, reason: Schema.String },
) {}

// `message` carries the full `${filePath} ${reason}` diagnostic; `reason` exposes the same text for
// callers that match on the failure cause alone.
const failure = (message: string, cause?: unknown): OntosModuleContractCheckError =>
  new OntosModuleContractCheckError({ cause, message, reason: message });

const sourceExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);

type TopologyVertical = (typeof TopologySchema.Type.verticals)[number];

const walkSourceFiles = (directory: string): Effect.Effect<readonly string[], PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* walkSourceDirectory() {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(directory))) {
      return [];
    }
    const entries = yield* fileSystem.readDirectory(directory);
    const files = yield* Effect.all(
      entries.map((entry) =>
        Effect.gen(function* inspectSourceEntry() {
          // Build output is not authored source: `.output` holds each unit's bundled server build
          // (~400 MiB of minified JS on a built tree), and parsing it exhausted an 8 GiB heap.
          if (entry === 'node_modules' || entry === '.output' || entry.startsWith('dist')) {
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
        }),
      ),
    );
    return files.flat();
  });

const staticModuleSource = (node: Expression | Argument | undefined): string | undefined => {
  if (node?.type === 'Literal' && Predicate.isString(node.value)) {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticModuleSource(node.left);
    const right = staticModuleSource(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};

// Keep known path prefixes in computed sources too. The previous checker rejected, for example,
// require('../verticals/crm/src/' + name); changing discovery must not lose that enforcement.
const moduleSourceCandidates = (node: Expression | Argument | undefined): readonly string[] => {
  const resolved = staticModuleSource(node);
  const candidates = resolved === undefined ? [] : [resolved];
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    // Only the leading path is a standalone prefix. Treating a right-hand filename fragment as
    // its own import would incorrectly reject an owner's '../' + 'vertical.manifest.ts'.
    return [...candidates, ...moduleSourceCandidates(node.left)];
  }
  if (node?.type === 'ConditionalExpression') {
    return [...moduleSourceCandidates(node.consequent), ...moduleSourceCandidates(node.alternate)];
  }
  if (
    node?.type === 'TSAsExpression' ||
    node?.type === 'TSTypeAssertion' ||
    node?.type === 'TSNonNullExpression' ||
    node?.type === 'TSSatisfiesExpression' ||
    node?.type === 'ParenthesizedExpression'
  ) {
    return moduleSourceCandidates(node.expression);
  }
  return candidates;
};

export const moduleImportSources = (filePath: string, content: string) => {
  const parseFailure = () => failure(`${filePath} could not be parsed for module-boundary import checks`);
  return Effect.gen(function* discoverModuleImports() {
    const parsed = yield* Effect.try({
      catch: parseFailure,
      try: () => parseSync(filePath, content, { astType: 'ts', sourceType: 'unambiguous' }),
    });
    if (parsed.errors.length > 0) {
      return yield* parseFailure();
    }
    return yield* Effect.try({
      catch: parseFailure,
      try: () => {
        const sources: string[] = [];
        new Visitor({
          CallExpression: (node) => {
            const { callee } = node;
            const isRequire =
              (callee.type === 'Identifier' && callee.name === 'require') ||
              (callee.type === 'MemberExpression' &&
                ((!callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'require') ||
                  (callee.computed && staticModuleSource(callee.property) === 'require')));
            if (isRequire) {
              sources.push(...moduleSourceCandidates(node.arguments[0]));
            }
          },
          ExportAllDeclaration: (node) => {
            sources.push(node.source.value);
          },
          ExportNamedDeclaration: (node) => {
            if (node.source !== null) {
              sources.push(node.source.value);
            }
          },
          ImportDeclaration: (node) => {
            sources.push(node.source.value);
          },
          ImportExpression: (node) => {
            sources.push(...moduleSourceCandidates(node.source));
          },
          TSImportEqualsDeclaration: (node) => {
            if (node.moduleReference.type === 'TSExternalModuleReference') {
              sources.push(node.moduleReference.expression.value);
            }
          },
          TSImportType: (node) => {
            sources.push(node.source.value);
          },
        }).visit(parsed.program);
        return [...new Set(sources)];
      },
    });
  });
};

/** Inspect executable/type import syntax, never strings or comments containing fixture source. */
export const checkModuleContractSourceImports = (filePath: string, content: string, ownerRoot?: string) =>
  Effect.gen(function* checkModuleContractImports() {
    const sources = yield* moduleImportSources(filePath, content);
    const privateOwnerFile = /vertical\.(?:manifest|registration|runtime-declaration)(?:\.ts)?$/u;
    if (ownerRoot !== undefined) {
      const hasPrivateOwnerImportViolation = sources.some((specifier) => {
        if (!privateOwnerFile.test(specifier)) {
          return false;
        }
        if (!specifier.startsWith('.')) {
          return true;
        }
        const resolved = path.resolve(path.dirname(filePath), specifier);
        return !resolved.startsWith(`${ownerRoot}${path.sep}`);
      });
      if (hasPrivateOwnerImportViolation) {
        return yield* failure(`${filePath} imports another deployment's private owner file`);
      }
      return yield* Effect.void;
    }
    if (sources.some((specifier) => privateOwnerFile.test(specifier))) {
      return yield* failure(`${filePath} imports a private deployment manifest or registration`);
    }
    if (
      sources.some((specifier) =>
        /(?:verticals\/|@app\/(?!core-runtime(?:\/|$)))[\s\S]*\/(?:src|routes|providers|handlers|repositories|db|vertical\.registration)(?:\/|$)/u.test(
          specifier,
        ),
      )
    ) {
      return yield* failure(`${filePath} imports production vertical private source`);
    }
    return yield* Effect.void;
  });

const checkSharedSourceFile = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem
    .readFileString(filePath)
    .pipe(Effect.flatMap((content) => checkModuleContractSourceImports(filePath, content)));

const checkOwnerSourceFile = (fileSystem: FileSystem.FileSystem, ownerRoot: string, filePath: string) =>
  fileSystem
    .readFileString(filePath)
    .pipe(Effect.flatMap((content) => checkModuleContractSourceImports(filePath, content, ownerRoot)));

const checkOwnerDirectory = (fileSystem: FileSystem.FileSystem, ownerRoot: string) =>
  walkSourceFiles(ownerRoot).pipe(
    Effect.flatMap((ownerFiles) =>
      Effect.all(ownerFiles.map((filePath) => checkOwnerSourceFile(fileSystem, ownerRoot, filePath))),
    ),
  );

const assertNoPrivateDeploymentImports = (workspaceRoot: string, verticals: readonly TopologyVertical[]) =>
  Effect.gen(function* checkPrivateDeploymentImports() {
    const fileSystem = yield* FileSystem.FileSystem;
    const sharedRoots = [
      path.join(workspaceRoot, 'apps/shell-super-app'),
      path.join(workspaceRoot, 'packages/core-runtime'),
    ];
    const sharedFiles = yield* Effect.all(sharedRoots.map(walkSourceFiles));
    yield* Effect.all(sharedFiles.flat().map((filePath) => checkSharedSourceFile(fileSystem, filePath)));
    yield* Effect.all(
      verticals.map((vertical) => {
        const ownerRoot = path.join(workspaceRoot, vertical.path);
        return checkOwnerDirectory(fileSystem, ownerRoot);
      }),
    );
  });

const occursExactlyOnce = (content: string, marker: string): boolean =>
  content.includes(marker) && content.indexOf(marker) === content.lastIndexOf(marker);

const validateOwner = (filePath: string, markers: readonly string[]) =>
  Effect.gen(function* validateGeneratedOwner() {
    const fileSystem = yield* FileSystem.FileSystem;
    const content = yield* fileSystem.readFileString(filePath);
    if (!content.startsWith(`${MODULE_CONTRACT_GENERATOR_HEADER}\n`)) {
      return yield* failure(`${filePath} is not a generated module-contract owner`);
    }
    const invalidMarker = markers.find((marker) => !occursExactlyOnce(content, marker));
    if (invalidMarker !== undefined) {
      return yield* failure(`${filePath} must contain exactly one ${invalidMarker}`);
    }
    const moduleId = /^\/\/ @ontos-module-id (?<moduleId>[^\s]+)$/mu.exec(content)?.groups?.moduleId;
    if (moduleId === undefined) {
      return yield* failure(`${filePath} is missing its generated module ID marker`);
    }
    return moduleId;
  });

const validateEmittedContract = (verticalDirectory: string, target: string, expected: OntosModuleDeploymentContract) =>
  Effect.gen(function* validateGeneratedContract() {
    const fileSystem = yield* FileSystem.FileSystem;
    const publicDirectory = path.join(verticalDirectory, target, 'public');
    if (!(yield* fileSystem.exists(publicDirectory))) {
      return;
    }
    const contractPath = path.join(publicDirectory, ONTOS_MODULE_CONTRACT_PATH.slice(1));
    if (!(yield* fileSystem.exists(contractPath))) {
      yield* failure(`${target} output is missing ${ONTOS_MODULE_CONTRACT_PATH}`);
    }
    const content = yield* fileSystem.readFile(contractPath);
    if (content.byteLength > ONTOS_MODULE_CONTRACT_MAX_BYTES) {
      yield* failure(`${contractPath} exceeds the 1 MiB contract limit`);
    }
    const serialized = new TextDecoder().decode(content);
    const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema), {
      onExcessProperty: 'error',
    })(serialized).pipe(Effect.mapError((cause) => failure(`${contractPath} has an invalid module contract`, cause)));
    if (
      contract.deployment.appId !== expected.deployment.appId ||
      contract.manifest.module.id !== expected.manifest.module.id
    ) {
      yield* failure(`${contractPath} identity does not match its generated owner metadata`);
    }
    if (!Equal.equals(contract, expected)) {
      yield* failure(`${contractPath} is stale relative to its authored module contract`);
    }
    if (/sourcePath|importPath|exportPath|registrationPath|handlerPath|migrationPath/u.test(serialized)) {
      yield* failure(`${contractPath} contains forbidden private path metadata`);
    }
    const toolCatalogReference = contract.manifest.publicSurface.mcp?.toolCatalog;
    if (toolCatalogReference !== undefined) {
      const toolCatalogPath = path.join(publicDirectory, toolCatalogReference.path.slice(1));
      if (!(yield* fileSystem.exists(toolCatalogPath))) {
        yield* failure(`${target} output is missing ${toolCatalogReference.path}`);
      }
      const toolCatalog = yield* fileSystem.readFile(toolCatalogPath);
      if (createHash('sha256').update(toolCatalog).digest('hex') !== toolCatalogReference.sha256) {
        yield* failure(`${toolCatalogPath} does not match the digest its contract pins`);
      }
      const tools = yield* Schema.decodeUnknownEffect(OntosMcpToolCatalogJsonSchema, { onExcessProperty: 'error' })(
        new TextDecoder().decode(toolCatalog),
      );
      if (tools.tools.length !== toolCatalogReference.toolCount) {
        yield* failure(`${toolCatalogPath} does not hold the tool count its contract declares`);
      }
    }
    const validateResponseHeaders = Effect.gen(function* validateResponseHeadersEffect() {
      const headersPath = path.join(publicDirectory, '_headers');
      const headers = yield* fileSystem.readFileString(headersPath);
      if (
        !headers.includes('Cache-Control: no-cache') ||
        !headers.includes('Content-Type: application/json') ||
        !/^ {2}ETag: "[a-f0-9]{64}"$/mu.test(headers)
      ) {
        yield* failure(`${headersPath} is missing the immutable module-contract response headers`);
      }
    });
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

const splitManifestMarkers = [
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_COMPONENT_SLOT_START,
  MODULE_MANIFEST_COMPONENT_SLOT_END,
  MODULE_MANIFEST_REPORT_SLOT_START,
  MODULE_MANIFEST_REPORT_SLOT_END,
  MODULE_MANIFEST_SEARCH_SLOT_START,
  MODULE_MANIFEST_SEARCH_SLOT_END,
];
const splitRegistrationMarkers = [
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
];
const splitDeclarationMarkers = [
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_ACTION_SLOT_START,
  MODULE_MANIFEST_ACTION_SLOT_END,
  MODULE_MANIFEST_API_SLOT_START,
  MODULE_MANIFEST_API_SLOT_END,
  MODULE_REGISTRATION_IMPORT_SLOT_START,
  MODULE_REGISTRATION_IMPORT_SLOT_END,
  MODULE_REGISTRATION_WORKER_SLOT_START,
  MODULE_REGISTRATION_WORKER_SLOT_END,
];
const shellMarkerPairs = [
  ['navigation', MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START, MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END],
  ['pages', MODULE_MANIFEST_SHELL_PAGE_SLOT_START, MODULE_MANIFEST_SHELL_PAGE_SLOT_END],
  ['publicComponents', MODULE_MANIFEST_SHELL_COMPONENT_SLOT_START, MODULE_MANIFEST_SHELL_COMPONENT_SLOT_END],
  ['reports', MODULE_MANIFEST_SHELL_REPORT_SLOT_START, MODULE_MANIFEST_SHELL_REPORT_SLOT_END],
  ['search', MODULE_MANIFEST_SHELL_SEARCH_SLOT_START, MODULE_MANIFEST_SHELL_SEARCH_SLOT_END],
] as const;

const literalProperty = (object: Expression | undefined, name: string): Expression | undefined => {
  if (object?.type !== 'ObjectExpression') {
    return undefined;
  }
  const properties = object.properties.filter(
    (property) =>
      property.type === 'Property' &&
      !property.computed &&
      property.key.type === 'Identifier' &&
      property.key.name === name,
  );
  const [property] = properties;
  return properties.length === 1 && property?.type === 'Property' ? property.value : undefined;
};
const splitShellProperties = (content: string, prefix: string) => {
  const parsed = parseSync('runtime-declaration.ts', content, { astType: 'ts', lang: 'ts', sourceType: 'module' });
  const declarations = parsed.program.body.flatMap((statement) =>
    statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration'
      ? statement.declaration.declarations.filter(
          (declaration) => declaration.id.type === 'Identifier' && declaration.id.name === `${prefix}RuntimeManifest`,
        )
      : [],
  );
  return declarations.length === 1
    ? literalProperty(literalProperty(declarations[0]?.init ?? undefined, 'publicSurface'), 'shellContributions')
    : undefined;
};

const validateSplitContributionMarkers = (
  content: string,
  verticalName: string,
  derived: OntosModuleDeploymentContract,
) =>
  Effect.gen(function* validateSplitContributionSlots() {
    const shell = splitShellProperties(content, toCamelCase(verticalName));
    for (const [key, start, end] of shellMarkerPairs) {
      const present = content.includes(start) || content.includes(end);
      const meaningful = derived.manifest.publicSurface.shellContributions[key].length > 0;
      if (present || meaningful) {
        const value = literalProperty(shell, key);
        if (
          value?.type !== 'ArrayExpression' ||
          !occursExactlyOnce(content, start) ||
          !occursExactlyOnce(content, end) ||
          content.indexOf(start) <= value.start ||
          content.indexOf(end) >= value.end ||
          content.indexOf(start) >= content.indexOf(end)
        ) {
          return yield* failure(`runtime declaration must contain exactly one owned ${start} pair for ${key}`);
        }
      }
    }
    return yield* Effect.void;
  });

const validateSplitMarkerOwnership = (manifest: string, registration: string, declaration: string) =>
  Effect.gen(function* validateSplitMarkerOwners() {
    const backendOnly = [
      ...splitDeclarationMarkers.filter(
        (marker) => marker !== MODULE_MANIFEST_IMPORT_SLOT_START && marker !== MODULE_MANIFEST_IMPORT_SLOT_END,
      ),
      MODULE_MANIFEST_OPERATION_SLOT_START,
      MODULE_MANIFEST_OPERATION_SLOT_END,
      MODULE_REGISTRATION_READ_SLOT_START,
      MODULE_REGISTRATION_READ_SLOT_END,
      ...shellMarkerPairs.flatMap(([, start, end]) => [start, end]),
    ];
    if (
      backendOnly.some((marker) => manifest.includes(marker) || registration.includes(marker)) ||
      splitRegistrationMarkers.some((marker) => manifest.includes(marker) || declaration.includes(marker)) ||
      [
        MODULE_MANIFEST_COMPONENT_SLOT_START,
        MODULE_MANIFEST_COMPONENT_SLOT_END,
        MODULE_MANIFEST_REPORT_SLOT_START,
        MODULE_MANIFEST_REPORT_SLOT_END,
        MODULE_MANIFEST_SEARCH_SLOT_START,
        MODULE_MANIFEST_SEARCH_SLOT_END,
      ].some((marker) => registration.includes(marker) || declaration.includes(marker))
    ) {
      return yield* failure('shared owner markers must occur only in their authoritative declaration or UI view');
    }
    return yield* Effect.void;
  });

const checkVertical = (workspaceRoot: string, vertical: TopologyVertical, contractUrl: string) =>
  Effect.gen(function* checkVerticalContract() {
    const fileSystem = yield* FileSystem.FileSystem;
    const appId = vertical.id;
    const relativePath = vertical.path;
    const verticalDirectory = path.join(workspaceRoot, relativePath);
    const packageSource = yield* fileSystem.readFileString(path.join(verticalDirectory, 'package.json'));
    const packageJson = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModulePackageSchema))(packageSource);
    const manifestPath = path.join(verticalDirectory, 'vertical.manifest.ts');
    const registrationPath = path.join(verticalDirectory, 'vertical.registration.ts');
    const [manifestSource, registrationSource] = yield* Effect.all([
      fileSystem.readFileString(manifestPath),
      fileSystem.readFileString(registrationPath),
    ]);
    const declaration = yield* readModuleRuntimeDeclarationEffect(
      verticalDirectory,
      path.basename(relativePath),
      manifestSource,
      registrationSource,
    ).pipe(Effect.mapError(() => failure(`${appId} shared owner declaration is invalid`)));
    const [manifestModuleId, registrationModuleId] = yield* Effect.all([
      validateOwner(manifestPath, declaration === undefined ? manifestMarkers : splitManifestMarkers),
      validateOwner(registrationPath, declaration === undefined ? registrationMarkers : splitRegistrationMarkers),
    ]);
    if (declaration !== undefined) {
      const deploymentMarker = /^\/\/ @ontos-deployment-app-id (?<appId>[^\s]+)$/mu.exec(declaration.content)?.groups
        ?.appId;
      if (deploymentMarker !== appId) {
        return yield* failure(`${appId} shared declaration deployment marker disagrees with its topology owner`);
      }
      const declarationModuleId = yield* validateOwner(declaration.path, splitDeclarationMarkers);
      if (declarationModuleId !== manifestModuleId) {
        return yield* failure(`${appId} shared declaration identity disagrees with its UI views`);
      }
      yield* validateSplitMarkerOwnership(manifestSource, registrationSource, declaration.content);
    }
    if (
      packageJson.modernjs.appId !== appId ||
      packageJson.modernjs.ontosModule.moduleId !== manifestModuleId ||
      registrationModuleId !== manifestModuleId ||
      packageJson.modernjs.ontosModule.schemaVersion !== ONTOS_MODULE_CONTRACT_PACKAGE_SCHEMA_VERSION
    ) {
      return yield* failure(`${appId} package, manifest, registration, and topology identities disagree`);
    }
    const verticalName = path.basename(relativePath);
    if (!packageJson.scripts.build?.includes(`--vertical ${verticalName} --target dist`)) {
      return yield* failure(`${appId} build script does not emit its module-contract deployment target`);
    }
    if (!contractUrl.endsWith(ONTOS_MODULE_CONTRACT_PATH)) {
      return yield* failure(`${appId} development module-contract URL is invalid`);
    }
    const derived = yield* deriveOntosModuleDeploymentContract({
      vertical: verticalName,
      workspaceRoot,
    }).pipe(Effect.mapError((cause) => failure(`${appId} authored module contract could not be derived`, cause)));
    if (declaration !== undefined) {
      yield* validateSplitContributionMarkers(declaration.content, verticalName, derived);
    }
    if (derived.deployment.appId !== appId || derived.manifest.module.id !== manifestModuleId) {
      return yield* failure(`${appId} authored module contract disagrees with generated owner metadata`);
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

/**
 * Every registered-workload call a module declares must reach a deployment whose published operation version declares
 * that declaration for that workload (demo divergence exception 8). The Shell drops any other call at runtime too.
 */
export const assertRegisteredWorkloadCallsReceived = (
  contracts: readonly (RegisteredWorkloadCallReceiver & {
    readonly manifest: {
      readonly registeredWorkloadCalls?: readonly Parameters<typeof registeredWorkloadCallReceiverIssue>[0][];
    };
  })[],
) =>
  Effect.forEach(
    contracts,
    (caller) =>
      Effect.forEach(
        caller.manifest.registeredWorkloadCalls ?? [],
        (call) => {
          const issue = registeredWorkloadCallReceiverIssue(
            call,
            contracts.find((candidate) => candidate.deployment.appId === call.audience),
          );
          return issue === undefined ? Effect.void : Effect.fail(failure(`${caller.deployment.appId} ${issue}`));
        },
        { discard: true },
      ),
    { discard: true },
  );

const symmyIntegration = 'symmy-integration';
const customerContext = 'commerce-customer-context';
/**
 * The reviewed callers of each registered workload (demo divergence exception 8). A receiver admits a registered
 * workload, not a calling module, so without this table any module could declare a call as another module's workload
 * and act as its principal wherever a tenant registered that workload (for example as Symmy's
 * `commerce.customer-context.source-write`, which lets Customer Context's owner overlay skip its Counterparty grant
 * check). Derived from the declarations in `verticals/*\/src/registered-workload-calls.ts`; a new workload, or a new
 * caller of an existing one, needs a reviewed entry here. Every write workload has exactly one caller; the five shared
 * workloads are read or check workloads that main's fixtures give to several source modules.
 */
export const REVIEWED_REGISTERED_WORKLOAD_CALLERS: ReadonlyMap<string, readonly [string, ...string[]]> = new Map<
  string,
  readonly [string, ...string[]]
>([
  ['commerce.assortment.symmy-fixture-currentness', ['assortment']],
  ['commerce.assortment.symmy-fixture-rule-import', [symmyIntegration]],
  ['commerce.catalog.symmy-product-import', [symmyIntegration]],
  ['commerce.catalog.symmy-product-read', ['pricing', symmyIntegration]],
  ['commerce.catalog.symmy-variant-localized-facts', [symmyIntegration]],
  ['commerce.catalog.symmy-variant-localized-facts-recovery', [symmyIntegration]],
  ['commerce.customer-context.organization-ico-facts.read', ['privacy']],
  ['commerce.customer-context.source-read', [symmyIntegration]],
  ['commerce.customer-context.source-write', [symmyIntegration]],
  ['commerce.inventory.source-read', [symmyIntegration]],
  ['commerce.inventory.source-write', [symmyIntegration]],
  ['commerce.market-catalog.source-read', ['pricing']],
  ['commerce.pricing.source-read', [symmyIntegration]],
  ['commerce.pricing.source-write', [symmyIntegration]],
  ['integration.symmy.source-organization-facts.read', ['privacy']],
  ['party.registry.source-read', [customerContext, 'privacy']],
  ['party.registry.source-write', [symmyIntegration]],
  ['payment.source-ingress', ['payment']],
  ['pricing.price-group-catalog.source-read', [customerContext, symmyIntegration]],
  ['pricing.price-group-catalog.source-write', [symmyIntegration]],
  ['privacy.core.organization-business-check', [customerContext, 'party-registry']],
  ['privacy.core.organization-profile-ico-check', [customerContext]],
  ['privacy.core.source-processing-check', [customerContext, 'party-registry', symmyIntegration]],
]);

/**
 * Every registered-workload call is declared by a reviewed caller of its workload: a workload without a reviewed
 * entry, or a module the entry does not name (a second declarer of a one-caller workload included), is refused.
 */
export const assertRegisteredWorkloadCallers = (
  contracts: readonly {
    readonly deployment: { readonly appId: string };
    readonly manifest: { readonly registeredWorkloadCalls?: readonly { readonly workloadKey: string }[] };
  }[],
  reviewedCallers: ReadonlyMap<string, readonly string[]> = REVIEWED_REGISTERED_WORKLOAD_CALLERS,
) =>
  Effect.forEach(
    contracts,
    ({ deployment: { appId }, manifest }) =>
      Effect.forEach(
        manifest.registeredWorkloadCalls ?? [],
        ({ workloadKey }) => {
          const callers = reviewedCallers.get(workloadKey);
          if (callers === undefined) {
            return Effect.fail(
              failure(`${appId} declares a call as registered workload ${workloadKey}, which has no reviewed caller`),
            );
          }
          return callers.includes(appId)
            ? Effect.void
            : Effect.fail(
                failure(
                  `${appId} declares a call as registered workload ${workloadKey}, whose reviewed callers are ${callers.join(', ')}`,
                ),
              );
        },
        { discard: true },
      ),
    { discard: true },
  );

const checkOntosModuleContractsEffect = (workspaceRoot: string) =>
  Effect.gen(function* checkWorkspaceContracts() {
    const fileSystem = yield* FileSystem.FileSystem;
    const topologySource = yield* fileSystem.readFileString(
      path.join(workspaceRoot, 'topology/reference-topology.json'),
    );
    const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TopologySchema))(topologySource);
    yield* assertNoPrivateDeploymentImports(workspaceRoot, topology.verticals);
    const overlaySource = yield* fileSystem.readFileString(
      path.join(workspaceRoot, 'topology/local-overlays/development.json'),
    );
    const overlay = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DevelopmentOverlaySchema))(overlaySource);
    const appIds = topology.verticals.map((vertical) => vertical.id);
    const allowlistKeys = Object.keys(overlay.ontosModuleManifests);
    const keysMatch =
      allowlistKeys.length === appIds.length &&
      appIds.every((appId) => Object.hasOwn(overlay.ontosModuleManifests, appId));
    if (!keysMatch) {
      yield* failure('development ontosModuleManifests keys must exactly match topology verticals');
    }
    const contracts = yield* Effect.all(
      topology.verticals.map((vertical) =>
        checkVertical(workspaceRoot, vertical, overlay.ontosModuleManifests[vertical.id]),
      ),
    );
    const moduleIds = contracts.map((entry) => entry.contract.manifest.module.id);
    const duplicateModuleId = moduleIds.find((moduleId, index) => moduleIds.indexOf(moduleId) !== index);
    if (duplicateModuleId !== undefined) {
      yield* failure(`duplicate OntOS module ID ${duplicateModuleId}`);
    }
    yield* assertRegisteredWorkloadCallers(contracts.map(({ contract }) => contract));
    yield* assertRegisteredWorkloadCallsReceived(contracts.map(({ contract }) => contract));
    buildInstalledModuleCatalog(contracts);
  });

export const checkOntosModuleContracts = (workspaceRoot = process.cwd()) =>
  checkOntosModuleContractsEffect(workspaceRoot);

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const programLayer = Layer.effectDiscard(
    checkOntosModuleContracts().pipe(Effect.tap(() => Effect.logInfo('OntOS module contracts validated'))),
  ).pipe(Layer.provide(NodeServices.layer));
  NodeRuntime.runMain(Effect.scoped(Layer.build(programLayer)));
}
