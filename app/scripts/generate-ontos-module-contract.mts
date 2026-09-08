#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import {
  Effect,
  Exit,
  FileSystem,
  flow,
  ManagedRuntime,
  Path,
  Predicate,
  Schema,
  Stream,
} from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { HttpApi } from 'effect/unstable/httpapi';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  OntosDeploymentAppIdSchema,
  OntosModuleDeploymentContractSchema,
  OntosModuleIdSchema,
  extractVerticalRuntimeSafeDescriptors,
} from '../packages/core-runtime/src/index.ts';
import type {
  OntosModuleDeploymentContract,
  OntosModuleManifest,
  VerticalRuntimeRegistration,
} from '../packages/core-runtime/src/index.ts';
import {
  MODULE_CONTRACT_GENERATOR_HEADER,
  MODULE_MANIFEST_ACTION_SLOT_END,
  MODULE_MANIFEST_ACTION_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_REGISTRATION_ACTION_SLOT_END,
  MODULE_REGISTRATION_ACTION_SLOT_START,
  MODULE_REGISTRATION_IMPORT_SLOT_END,
  MODULE_REGISTRATION_IMPORT_SLOT_START,
  MODULE_REGISTRATION_WORKER_SLOT_END,
  MODULE_REGISTRATION_WORKER_SLOT_START,
  ONTOS_MODULE_CONTRACT_PACKAGE_SCHEMA_VERSION,
  toCamelCase,
  toPascalCase,
} from './scaffolding/shared.mts';

export const OntosModuleContractTargetSchema = Schema.Literals([
  'cloudflare-dist',
  'dist',
]);
export type OntosModuleContractTarget =
  typeof OntosModuleContractTargetSchema.Type;

interface GenerateInput {
  readonly target: OntosModuleContractTarget;
  readonly vertical: string;
  readonly workspaceRoot?: string;
}

export interface DeriveOntosModuleContractInput {
  readonly vertical: string;
  readonly workspaceRoot?: string;
}

interface LoadedOwnerValues {
  readonly manifest: OntosModuleManifest;
  readonly registration: VerticalRuntimeRegistration;
}

export class OntosModuleContractGenerationError extends Schema.TaggedError<OntosModuleContractGenerationError>()(
  'OntosModuleContractGenerationError',
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }
) {}

const ModulePackageSchema = Schema.Struct({
  modernjs: Schema.optional(
    Schema.Struct({
      appId: Schema.optional(OntosDeploymentAppIdSchema),
      ontosModule: Schema.optional(
        Schema.Struct({
          moduleId: Schema.optional(OntosModuleIdSchema),
          schemaVersion: Schema.optional(Schema.Number),
        })
      ),
    })
  ),
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
});

const ReferenceTopologySchema = Schema.Struct({
  verticals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        deliveryUnit: Schema.optional(
          Schema.Struct({ buildMarker: Schema.optional(Schema.String) })
        ),
        id: Schema.optional(Schema.String),
        moduleFederation: Schema.optional(
          Schema.Struct({ name: Schema.optional(Schema.String) })
        ),
        package: Schema.optional(Schema.String),
        path: Schema.optional(Schema.String),
      })
    )
  ),
});

const isOntosModuleManifest = (cause: unknown): cause is OntosModuleManifest =>
  Predicate.isObject(cause);
const isVerticalRuntimeRegistration = (
  cause: unknown
): cause is VerticalRuntimeRegistration => Predicate.isObject(cause);
const LoadedOwnerModuleSchema = Schema.Struct({
  manifest: Schema.declare(isOntosModuleManifest),
  registration: Schema.declare(isVerticalRuntimeRegistration),
});
const decodeLoadedOwnerModule = Schema.decodeUnknownPromise(
  LoadedOwnerModuleSchema
);

const PackageJsonTextSchema = Schema.fromJsonString(ModulePackageSchema);
const ReferenceTopologyTextSchema = Schema.fromJsonString(
  ReferenceTopologySchema
);
const ContractJsonTextSchema = Schema.fromJsonString(
  OntosModuleDeploymentContractSchema,
  {
    space: 2,
  }
);
const JsonDocumentTextSchema = Schema.fromJsonString(Schema.Unknown, {
  space: 2,
});
const JsonStringTextSchema = Schema.fromJsonString(Schema.String);

const canonicalSlugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const outputRootByTarget: Readonly<Record<OntosModuleContractTarget, string>> =
  Object.freeze({
    'cloudflare-dist': 'dist-cloudflare',
    dist: 'dist',
  });

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const require = createRequire(import.meta.url);
const moduleContractRuntime = ManagedRuntime.make(NodeServices.layer);

const failure = (
  message: string,
  cause?: unknown
): OntosModuleContractGenerationError =>
  new OntosModuleContractGenerationError({ cause, message });

const repositoryEsbuildPath = (): string => {
  const createEntry = require.resolve('@modern-js/ultramodern-create');
  return require.resolve('esbuild/bin/esbuild', {
    paths: [path.dirname(createEntry)],
  });
};

const assertPlainTarget = (value: string, label: string, pattern: RegExp) =>
  pattern.test(value)
    ? Effect.succeed(value)
    : Effect.fail(failure(`${label} must be one safe generated identifier`));

const assertOwnerSlots = (verticalDirectory: string) =>
  Effect.gen(function* assertOwnerSlotsEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const platformPath = yield* Path.Path;
    const owners = [
      {
        path: platformPath.join(verticalDirectory, 'vertical.manifest.ts'),
        slots: [
          MODULE_MANIFEST_IMPORT_SLOT_START,
          MODULE_MANIFEST_IMPORT_SLOT_END,
          MODULE_MANIFEST_ACTION_SLOT_START,
          MODULE_MANIFEST_ACTION_SLOT_END,
        ],
      },
      {
        path: platformPath.join(verticalDirectory, 'vertical.registration.ts'),
        slots: [
          MODULE_REGISTRATION_IMPORT_SLOT_START,
          MODULE_REGISTRATION_IMPORT_SLOT_END,
          MODULE_REGISTRATION_ACTION_SLOT_START,
          MODULE_REGISTRATION_ACTION_SLOT_END,
          MODULE_REGISTRATION_WORKER_SLOT_START,
          MODULE_REGISTRATION_WORKER_SLOT_END,
        ],
      },
    ] as const;
    const ownerContents = yield* Effect.forEach(
      owners,
      (owner) =>
        fileSystem.readFileString(owner.path).pipe(
          Effect.map((content) => ({ ...owner, content })),
          Effect.mapError((cause) =>
            failure(`unable to read module contract owner ${owner.path}`, cause)
          )
        ),
      { concurrency: 'unbounded' }
    );
    for (const owner of ownerContents) {
      const { content } = owner;
      if (!content.startsWith(`${MODULE_CONTRACT_GENERATOR_HEADER}\n`)) {
        yield* failure(
          `module contract owner is missing its generated header: ${owner.path}`
        );
      }
      for (const slot of owner.slots) {
        if (
          !content.includes(slot) ||
          content.indexOf(slot) !== content.lastIndexOf(slot)
        ) {
          yield* failure(
            `module contract owner must contain exactly one ${slot} slot`
          );
        }
      }
    }
  });

const loadOwnerValues = (
  workspaceRoot: string,
  verticalDirectory: string,
  vertical: string
) =>
  Effect.scoped(
    Effect.gen(function* loadOwnerValuesEffect() {
      const fileSystem = yield* FileSystem.FileSystem;
      const platformPath = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const temporaryDirectory = yield* fileSystem
        .makeTempDirectoryScoped({
          directory: verticalDirectory,
          prefix: '.ontos-contract-',
        })
        .pipe(
          Effect.mapError((cause) =>
            failure(
              'unable to create the module contract temporary directory',
              cause
            )
          )
        );
      const entryPath = platformPath.join(temporaryDirectory, 'entry.mts');
      const bundlePath = platformPath.join(temporaryDirectory, 'bundle.mjs');
      const manifestPath = platformPath.join(
        verticalDirectory,
        'vertical.manifest.ts'
      );
      const registrationPath = platformPath.join(
        verticalDirectory,
        'vertical.registration.ts'
      );
      const prefix = toCamelCase(vertical);
      const encodedManifestPath = yield* Schema.encodeEffect(
        JsonStringTextSchema
      )(manifestPath).pipe(
        Effect.mapError((cause) =>
          failure('unable to encode the manifest owner path', cause)
        )
      );
      const encodedRegistrationPath = yield* Schema.encodeEffect(
        JsonStringTextSchema
      )(registrationPath).pipe(
        Effect.mapError((cause) =>
          failure('unable to encode the registration owner path', cause)
        )
      );
      const entry = `import { ${prefix}Manifest as manifest } from ${encodedManifestPath};\nimport { ${prefix}Registration as registration } from ${encodedRegistrationPath};\nexport { manifest, registration };\n`;
      yield* fileSystem
        .writeFileString(entryPath, entry)
        .pipe(
          Effect.mapError((cause) =>
            failure('unable to write the module contract bundle entry', cause)
          )
        );
      const esbuildPath = yield* Effect.try({
        catch: (cause) =>
          failure('unable to resolve the repository esbuild executable', cause),
        try: repositoryEsbuildPath,
      });
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(
            esbuildPath,
            [
              entryPath,
              '--bundle',
              '--format=esm',
              '--platform=node',
              '--packages=external',
              `--outfile=${bundlePath}`,
            ],
            { cwd: workspaceRoot }
          )
        )
        .pipe(
          Effect.mapError((cause) =>
            failure('module contract owner bundle failed', cause)
          )
        );
      const bundleOutput = yield* Stream.mkString(
        handle.all.pipe(Stream.decodeText())
      ).pipe(
        Effect.mapError((cause) =>
          failure('unable to collect module contract bundle output', cause)
        )
      );
      const bundleExitCode = yield* handle.exitCode.pipe(
        Effect.mapError((cause) =>
          failure('unable to read module contract bundle exit code', cause)
        )
      );
      if (bundleExitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* failure(
          `module contract owner bundle failed: ${bundleOutput.trim()}`
        );
      }
      return yield* Effect.tryPromise({
        catch: (cause) =>
          failure('unable to import the bundled module contract owners', cause),
        try: async (): Promise<LoadedOwnerValues> =>
          await decodeLoadedOwnerModule(
            await import(
              `${pathToFileURL(bundlePath).href}?build=${randomUUID()}`
            )
          ),
      });
    })
  );

const componentExposes = (verticalDirectory: string) =>
  Effect.gen(function* componentExposesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const platformPath = yield* Path.Path;
    const config = yield* fileSystem
      .readFileString(
        platformPath.join(verticalDirectory, 'module-federation.config.ts')
      )
      .pipe(
        Effect.mapError((cause) =>
          failure('unable to read the Module Federation configuration', cause)
        )
      );
    const exposes = new Set<string>();
    const pattern =
      /['"](?<key>\.\/[A-Za-z][A-Za-z0-9_-]*)['"]\s*:\s*['"][^'"]+['"]/gu;
    for (const match of config.matchAll(pattern)) {
      const key = match.groups?.key;
      if (key !== undefined) {
        exposes.add(key);
      }
    }
    return exposes;
  });

const toKebab = (value: string): string =>
  value
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, '$<lower>-$<upper>')
    .replaceAll('_', '-')
    .toLowerCase();

const sorted = <Value,>(
  values: readonly Value[],
  compare: (left: Value, right: Value) => number
): readonly Value[] => {
  const result: Value[] = [];
  for (const value of values) {
    const insertionIndex = result.findIndex(
      (existing) => compare(value, existing) < 0
    );
    if (insertionIndex === -1) {
      result.push(value);
    } else {
      result.splice(insertionIndex, 0, value);
    }
  }
  return result;
};

const deriveApiOperationKeys = (api: HttpApi.Top): readonly string[] =>
  sorted(
    Object.values(api.groups).flatMap((group) =>
      Object.values(group.endpoints).map((endpoint) =>
        group.topLevel
          ? endpoint.identifier
          : `${group.identifier}.${endpoint.identifier}`
      )
    ),
    (left, right) => left.localeCompare(right)
  );

const deriveContract = (
  workspaceRoot: string,
  vertical: string,
  owner: LoadedOwnerValues
) =>
  Effect.gen(function* deriveContractEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const platformPath = yield* Path.Path;
    const verticalDirectory = platformPath.join(
      workspaceRoot,
      'verticals',
      vertical
    );
    const packageJsonSource = yield* fileSystem
      .readFileString(platformPath.join(verticalDirectory, 'package.json'))
      .pipe(
        Effect.mapError((cause) =>
          failure('unable to read the vertical package metadata', cause)
        )
      );
    const packageJson = yield* Schema.decodeUnknownEffect(
      PackageJsonTextSchema
    )(packageJsonSource).pipe(
      Effect.mapError((cause) =>
        failure('vertical package metadata is invalid', cause)
      )
    );
    const topologySource = yield* fileSystem
      .readFileString(
        platformPath.join(workspaceRoot, 'topology/reference-topology.json')
      )
      .pipe(
        Effect.mapError((cause) =>
          failure('unable to read the reference topology', cause)
        )
      );
    const topology = yield* Schema.decodeUnknownEffect(
      ReferenceTopologyTextSchema
    )(topologySource).pipe(
      Effect.mapError((cause) =>
        failure('reference topology is invalid', cause)
      )
    );
    const matchesOwnerModule = () =>
      packageJson.modernjs?.ontosModule?.moduleId ===
        owner.manifest.module.id &&
      packageJson.modernjs.ontosModule.schemaVersion ===
        ONTOS_MODULE_CONTRACT_PACKAGE_SCHEMA_VERSION;
    const validateDeploymentIdentity = Effect.gen(
      function* validateDeploymentIdentityEffect() {
        const appId = packageJson.modernjs?.appId;
        const topologyEntries = topology.verticals?.filter(
          (entry) =>
            entry.id === appId &&
            entry.package === packageJson.name &&
            entry.path === `verticals/${vertical}`
        );
        if (appId === undefined || topologyEntries?.length !== 1) {
          return yield* failure(
            'vertical package and topology deployment identity do not match exactly'
          );
        }
        if (!matchesOwnerModule()) {
          return yield* failure(
            'generated package module marker does not match the owner manifest'
          );
        }
        const [topologyEntry] = topologyEntries;
        if (
          topologyEntry === undefined ||
          topologyEntry.moduleFederation?.name === undefined
        ) {
          return yield* failure(
            'vertical topology Module Federation boundary is missing'
          );
        }
        const moduleFederationName = topologyEntry.moduleFederation.name;

        return { appId, moduleFederationName, topologyEntry };
      }
    );
    const { appId, moduleFederationName, topologyEntry } =
      yield* validateDeploymentIdentity;
    const exposes = yield* componentExposes(verticalDirectory);
    const validatePublicDescriptors = Effect.gen(
      function* validatePublicDescriptorsEffect() {
        const componentKeys = Object.keys(
          owner.manifest.publicSurface.components
        );
        for (const key of componentKeys) {
          if (!exposes.has(`./${toPascalCase(key)}`)) {
            return yield* failure(
              `public component ${key} has no matching Module Federation exposure`
            );
          }
        }
        const safeRuntime = extractVerticalRuntimeSafeDescriptors(
          owner.registration
        );
        const manifestActionKeys = sorted(
          owner.manifest.publicSurface.actions.map(
            ({ descriptor }) => descriptor.actionKey
          ),
          (left, right) => left.localeCompare(right)
        );
        const runtimeActionKeys = safeRuntime.actions.map(
          ({ actionKey }) => actionKey
        );
        if (
          manifestActionKeys.length !== runtimeActionKeys.length ||
          manifestActionKeys.some(
            (actionKey, index) => actionKey !== runtimeActionKeys[index]
          )
        ) {
          return yield* failure(
            'manifest Actions and private runtime Action descriptors do not match'
          );
        }

        return { componentKeys, safeRuntime };
      }
    );
    const { componentKeys, safeRuntime } = yield* validatePublicDescriptors;
    const events = yield* Effect.forEach(
      owner.manifest.publicSurface.events,
      (event) =>
        Schema.encodeEffect(JsonDocumentTextSchema)(
          Schema.toJsonSchemaDocument(event.payloadSchema)
        ).pipe(
          Effect.map((payloadDocument) => ({
            key: event.key,
            owningModuleId: event.owningModuleId,
            payloadContract: sha256(`${payloadDocument}\n`),
            referencesResourceTypes: event.referencesResourceTypes,
            tense: event.tense,
            visibility: event.visibility,
          })),
          Effect.mapError((cause) =>
            failure(
              `unable to encode the ${event.key} event payload contract`,
              cause
            )
          )
        ),
      { concurrency: 'unbounded' }
    );
    const apiContracts = yield* Effect.forEach(
      Object.entries(owner.manifest.publicSurface.api),
      ([key, value]) => {
        if (!HttpApi.isHttpApi(value)) {
          return Effect.fail(failure(`public API ${key} is not an HttpApi`));
        }
        return Effect.succeed({
          key: `${owner.manifest.module.id}.${toKebab(key)}`,
          operationKeys: deriveApiOperationKeys(value),
        });
      }
    );
    const contract = {
      deployment: {
        appId,
        buildMarker:
          topologyEntry.deliveryUnit?.buildMarker ??
          sha256(`${appId}:${packageJson.version ?? '0.0.0'}`).slice(0, 16),
      },
      manifest: {
        activation: owner.manifest.activation,
        module: owner.manifest.module,
        publicSurface: {
          actions: safeRuntime.actions,
          api: sorted(apiContracts, (left, right) =>
            left.key.localeCompare(right.key)
          ),
          components: sorted(
            componentKeys.map((key) => ({
              expose: `./${toPascalCase(key)}`,
              key: `${owner.manifest.module.id}.${toKebab(key)}`,
              mfBoundaryId: moduleFederationName,
            })),
            (left, right) => left.key.localeCompare(right.key)
          ),
          events: sorted(events, (left, right) =>
            left.key.localeCompare(right.key)
          ),
          reports: owner.manifest.publicSurface.reports,
          resourceTypes: owner.manifest.publicSurface.resourceTypes,
          search: owner.manifest.publicSurface.search,
          shellContributions: owner.manifest.publicSurface.shellContributions,
        },
      },
      runtime: { outboxSubscriptions: safeRuntime.outboxSubscriptions },
      schemaVersion: ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
    } as const;
    return yield* Schema.decodeUnknownEffect(
      OntosModuleDeploymentContractSchema,
      {
        onExcessProperty: 'error',
      }
    )(contract).pipe(
      Effect.mapError((cause) =>
        failure('derived OntOS module contract is invalid', cause)
      )
    );
  });

const deriveOntosModuleDeploymentContractEffect = (
  input: DeriveOntosModuleContractInput
) =>
  Effect.gen(function* deriveDeploymentContractProgram() {
    const platformPath = yield* Path.Path;
    const workspaceRoot = platformPath.resolve(
      input.workspaceRoot ?? platformPath.join(import.meta.dirname, '..')
    );
    const vertical = yield* assertPlainTarget(
      input.vertical,
      'vertical',
      canonicalSlugPattern
    );
    const verticalDirectory = platformPath.join(
      workspaceRoot,
      'verticals',
      vertical
    );
    yield* assertOwnerSlots(verticalDirectory);
    const owner = yield* loadOwnerValues(
      workspaceRoot,
      verticalDirectory,
      vertical
    );
    return yield* deriveContract(workspaceRoot, vertical, owner);
  });

/** Derives and validates one contract without writing deployment output. */
export const deriveOntosModuleDeploymentContract: (
  input: DeriveOntosModuleContractInput
) => Promise<OntosModuleDeploymentContract> = flow(
  deriveOntosModuleDeploymentContractEffect,
  moduleContractRuntime.runPromise
);

const generateOntosModuleContractEffect = (input: GenerateInput) =>
  Effect.gen(function* generateContractProgram() {
    const fileSystem = yield* FileSystem.FileSystem;
    const platformPath = yield* Path.Path;
    const workspaceRoot = platformPath.resolve(
      input.workspaceRoot ?? platformPath.join(import.meta.dirname, '..')
    );
    const vertical = yield* assertPlainTarget(
      input.vertical,
      'vertical',
      canonicalSlugPattern
    );
    const target = yield* Schema.decodeUnknownEffect(
      OntosModuleContractTargetSchema
    )(input.target).pipe(
      Effect.mapError(() => failure('target must be dist or cloudflare-dist'))
    );
    const verticalDirectory = platformPath.join(
      workspaceRoot,
      'verticals',
      vertical
    );
    const contract = yield* deriveOntosModuleDeploymentContractEffect({
      vertical,
      workspaceRoot,
    });
    const encodedContract = yield* Schema.encodeEffect(ContractJsonTextSchema)(
      contract
    ).pipe(
      Effect.mapError((cause) =>
        failure('unable to encode the OntOS module contract', cause)
      )
    );
    const content = `${encodedContract}\n`;
    const bytes = Buffer.byteLength(content);
    if (bytes > ONTOS_MODULE_CONTRACT_MAX_BYTES) {
      return yield* failure(
        'generated OntOS module contract exceeds the 1 MiB deployment limit'
      );
    }
    const outputPath = platformPath.join(
      verticalDirectory,
      outputRootByTarget[target],
      'public',
      ONTOS_MODULE_CONTRACT_PATH.slice(1)
    );
    yield* fileSystem
      .makeDirectory(platformPath.dirname(outputPath), { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          failure(
            'unable to create the module contract output directory',
            cause
          )
        )
      );
    const temporaryPath = `${outputPath}.tmp-${randomUUID()}`;
    yield* fileSystem
      .writeFileString(temporaryPath, content)
      .pipe(
        Effect.mapError((cause) =>
          failure('unable to write the temporary module contract', cause)
        )
      );
    yield* fileSystem
      .rename(temporaryPath, outputPath)
      .pipe(
        Effect.mapError((cause) =>
          failure('unable to publish the generated module contract', cause)
        )
      );
    const etag = `"${sha256(content)}"`;
    const headersPath = platformPath.join(
      verticalDirectory,
      outputRootByTarget[target],
      'public',
      '_headers'
    );
    const headers = `${ONTOS_MODULE_CONTRACT_PATH}\n  Cache-Control: no-cache\n  Content-Type: application/json\n  ETag: ${etag}\n`;
    yield* fileSystem
      .writeFileString(headersPath, headers)
      .pipe(
        Effect.mapError((cause) =>
          failure('unable to write the module contract response headers', cause)
        )
      );
    return { bytes, etag, path: outputPath };
  });

export const generateOntosModuleContract: (input: GenerateInput) => Promise<{
  readonly bytes: number;
  readonly etag: string;
  readonly path: string;
}> = flow(generateOntosModuleContractEffect, moduleContractRuntime.runPromise);

const verticalFlag = Flag.string('vertical');
const targetFlag = Flag.choice('target', ['cloudflare-dist', 'dist']);
const cli = Command.make(
  'generate-ontos-module-contract',
  { target: targetFlag, vertical: verticalFlag },
  ({ target, vertical }) =>
    generateOntosModuleContractEffect({ target, vertical }).pipe(
      Effect.flatMap((result) =>
        Effect.logInfo(
          `Generated ${result.path} (${result.bytes} bytes, ETag ${result.etag})`
        )
      )
    )
);

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const exit = await moduleContractRuntime.runPromiseExit(
    Command.run({ version: '1.0.0' })(cli).pipe(
      Effect.tapError((error) => Effect.logError(error))
    )
  );
  if (Exit.isFailure(exit)) {
    process.exitCode = 1;
  }
}
