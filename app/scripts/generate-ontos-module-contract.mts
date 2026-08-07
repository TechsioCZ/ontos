#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from 'effect';
import type { HttpApi } from 'effect/unstable/httpapi';
import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  OntosModuleDeploymentContractSchema,
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
} from './scaffolding/shared.mts';

interface GenerateInput {
  readonly target: OntosModuleContractTarget;
  readonly vertical: string;
  readonly workspaceRoot?: string;
}

export interface DeriveOntosModuleContractInput {
  readonly vertical: string;
  readonly workspaceRoot?: string;
}

export type OntosModuleContractTarget = 'cloudflare-dist' | 'dist';

interface LoadedOwnerValues {
  readonly manifest: OntosModuleManifest;
  readonly registration: VerticalRuntimeRegistration;
}

const canonicalSlugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const outputRootByTarget: Readonly<Record<OntosModuleContractTarget, string>> = Object.freeze({
  'cloudflare-dist': 'dist-cloudflare',
  dist: 'dist',
});

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const stableJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const require = createRequire(import.meta.url);

const repositoryEsbuildPath = (): string => {
  const createEntry = require.resolve('@modern-js/create');
  return require.resolve('esbuild/bin/esbuild', { paths: [path.dirname(createEntry)] });
};

const assertPlainTarget = (value: string, label: string, pattern: RegExp): string => {
  if (!pattern.test(value)) {
    throw new Error(`${label} must be one safe generated identifier`);
  }
  return value;
};

const assertOwnerSlots = async (verticalDirectory: string): Promise<void> => {
  const owners = [
    {
      path: path.join(verticalDirectory, 'vertical.manifest.ts'),
      slots: [
        MODULE_MANIFEST_IMPORT_SLOT_START,
        MODULE_MANIFEST_IMPORT_SLOT_END,
        MODULE_MANIFEST_ACTION_SLOT_START,
        MODULE_MANIFEST_ACTION_SLOT_END,
      ],
    },
    {
      path: path.join(verticalDirectory, 'vertical.registration.ts'),
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
  const ownerContents = await Promise.all(
    owners.map(async (owner) => ({ ...owner, content: await readFile(owner.path, 'utf-8') })),
  );
  for (const owner of ownerContents) {
    const { content } = owner;
    if (!content.startsWith(`${MODULE_CONTRACT_GENERATOR_HEADER}\n`)) {
      throw new Error(`module contract owner is missing its generated header: ${owner.path}`);
    }
    for (const slot of owner.slots) {
      if (!content.includes(slot) || content.indexOf(slot) !== content.lastIndexOf(slot)) {
        throw new Error(`module contract owner must contain exactly one ${slot} slot`);
      }
    }
  }
};

const loadOwnerValues = async (
  workspaceRoot: string,
  verticalDirectory: string,
): Promise<LoadedOwnerValues> => {
  const temporaryDirectory = await mkdtemp(path.join(verticalDirectory, '.ontos-contract-'));
  const entryPath = path.join(temporaryDirectory, 'entry.mts');
  const bundlePath = path.join(temporaryDirectory, 'bundle.mjs');
  const manifestPath = path.join(verticalDirectory, 'vertical.manifest.ts');
  const registrationPath = path.join(verticalDirectory, 'vertical.registration.ts');
  try {
    await writeFile(
      entryPath,
      `import * as manifestOwner from ${JSON.stringify(manifestPath)};\nimport * as registrationOwner from ${JSON.stringify(registrationPath)};\nexport { manifestOwner, registrationOwner };\n`,
      'utf-8',
    );
    const bundle = spawnSync(
      repositoryEsbuildPath(),
      [
        entryPath,
        '--bundle',
        '--format=esm',
        '--platform=node',
        '--packages=external',
        `--outfile=${bundlePath}`,
      ],
      { cwd: workspaceRoot, encoding: 'utf-8' },
    );
    if (bundle.error !== undefined || bundle.status !== 0) {
      throw new Error(
        `module contract owner bundle failed: ${bundle.error?.message ?? bundle.stderr.trim()}`,
      );
    }
    const loaded = (await import(`${pathToFileURL(bundlePath).href}?build=${Date.now()}`)) as {
      readonly manifestOwner: Readonly<Record<string, unknown>>;
      readonly registrationOwner: Readonly<Record<string, unknown>>;
    };
    const manifests = Object.values(loaded.manifestOwner).filter(
      (value): value is OntosModuleManifest =>
        typeof value === 'object' &&
        value !== null &&
        'module' in value &&
        'publicSurface' in value,
    );
    const registrations = Object.values(loaded.registrationOwner).filter(
      (value): value is VerticalRuntimeRegistration =>
        typeof value === 'object' && value !== null && 'moduleId' in value,
    );
    if (manifests.length !== 1 || registrations.length !== 1) {
      throw new Error('owner files must export exactly one manifest and one runtime registration');
    }
    const [manifest] = manifests;
    const [registration] = registrations;
    if (manifest === undefined || registration === undefined) {
      throw new Error('module contract owner values are missing');
    }
    if (manifest.module.id !== registration.moduleId) {
      throw new Error('manifest and private registration module IDs do not match');
    }
    return { manifest, registration };
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};

const componentExposes = async (verticalDirectory: string): Promise<ReadonlySet<string>> => {
  const config = await readFile(
    path.join(verticalDirectory, 'module-federation.config.ts'),
    'utf-8',
  );
  const exposes = new Set<string>();
  const pattern = /['"](?<key>\.\/[A-Za-z][A-Za-z0-9_-]*)['"]\s*:\s*['"][^'"]+['"]/gu;
  for (const match of config.matchAll(pattern)) {
    const key = match.groups?.['key'];
    if (key !== undefined) {
      exposes.add(key);
    }
  }
  return exposes;
};

const toKebab = (value: string): string =>
  value
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, '$<lower>-$<upper>')
    .replaceAll('_', '-')
    .toLowerCase();

const deriveApiOperationKeys = (api: HttpApi.AnyWithProps): readonly string[] =>
  Object.values(api.groups)
    .flatMap((group) =>
      Object.values(group.endpoints).map((endpoint) =>
        group.topLevel ? endpoint.name : `${group.identifier}.${endpoint.name}`,
      ),
    )
    .toSorted((left, right) => left.localeCompare(right));

const deriveContract = async (
  workspaceRoot: string,
  vertical: string,
  owner: LoadedOwnerValues,
): Promise<OntosModuleDeploymentContract> => {
  const verticalDirectory = path.join(workspaceRoot, 'verticals', vertical);
  const packageJson = JSON.parse(
    await readFile(path.join(verticalDirectory, 'package.json'), 'utf-8'),
  ) as {
    readonly modernjs?: {
      readonly appId?: string;
      readonly ontosModule?: { readonly moduleId?: string; readonly schemaVersion?: number };
    };
    readonly name?: string;
    readonly version?: string;
  };
  const topology = JSON.parse(
    await readFile(path.join(workspaceRoot, 'topology/reference-topology.json'), 'utf-8'),
  ) as {
    readonly verticals?: readonly {
      readonly deliveryUnit?: { readonly buildMarker?: string };
      readonly id?: string;
      readonly moduleFederation?: { readonly name?: string };
      readonly package?: string;
      readonly path?: string;
    }[];
  };
  const appId = packageJson.modernjs?.appId;
  const topologyEntries = topology.verticals?.filter(
    (entry) =>
      entry.id === appId &&
      entry.package === packageJson.name &&
      entry.path === `verticals/${vertical}`,
  );
  if (typeof appId !== 'string' || topologyEntries?.length !== 1) {
    throw new Error('vertical package and topology deployment identity do not match exactly');
  }
  if (
    packageJson.modernjs?.ontosModule?.moduleId !== owner.manifest.module.id ||
    packageJson.modernjs.ontosModule.schemaVersion !== ONTOS_MODULE_CONTRACT_PACKAGE_SCHEMA_VERSION
  ) {
    throw new Error('generated package module marker does not match the owner manifest');
  }
  const [topologyEntry] = topologyEntries;
  if (topologyEntry === undefined || typeof topologyEntry.moduleFederation?.name !== 'string') {
    throw new Error('vertical topology Module Federation boundary is missing');
  }
  const exposes = await componentExposes(verticalDirectory);
  const componentKeys = Object.keys(owner.manifest.publicSurface.components);
  for (const key of componentKeys) {
    if (!exposes.has(`./${key}`)) {
      throw new Error(`public component ${key} has no matching Module Federation exposure`);
    }
  }
  const safeRuntime = extractVerticalRuntimeSafeDescriptors(owner.registration);
  const manifestActionKeys = owner.manifest.publicSurface.actions
    .map(({ descriptor }) => descriptor.actionKey)
    .toSorted((left, right) => left.localeCompare(right));
  if (
    JSON.stringify(manifestActionKeys) !==
    JSON.stringify(safeRuntime.actions.map(({ actionKey }) => actionKey))
  ) {
    throw new Error('manifest Actions and private runtime Action descriptors do not match');
  }
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
        api: Object.entries(owner.manifest.publicSurface.api)
          .map(([key, value]) => ({
            key: `${owner.manifest.module.id}.${toKebab(key)}`,
            operationKeys: deriveApiOperationKeys(value),
          }))
          .toSorted((left, right) => left.key.localeCompare(right.key)),
        components: componentKeys
          .map((key) => ({
            expose: `./${key}`,
            key: `${owner.manifest.module.id}.${toKebab(key)}`,
            mfBoundaryId: topologyEntry.moduleFederation?.name ?? '',
          }))
          .toSorted((left, right) => left.key.localeCompare(right.key)),
        events: owner.manifest.publicSurface.events
          .map((event) => ({
            key: event.key,
            owningModuleId: event.owningModuleId,
            payloadContract: sha256(stableJson(Schema.toJsonSchemaDocument(event.payloadSchema))),
            referencesResourceTypes: event.referencesResourceTypes,
            tense: event.tense,
            visibility: event.visibility,
          }))
          .toSorted((left, right) => left.key.localeCompare(right.key)),
        reports: owner.manifest.publicSurface.reports,
        resourceTypes: owner.manifest.publicSurface.resourceTypes,
        search: owner.manifest.publicSurface.search,
        shellContributions: owner.manifest.publicSurface.shellContributions,
      },
    },
    runtime: { outboxSubscriptions: safeRuntime.outboxSubscriptions },
    schemaVersion: ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  } as const;
  return Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema, {
    onExcessProperty: 'error',
  })(contract);
};

/** Derives and validates one contract without writing deployment output. */
export const deriveOntosModuleDeploymentContract = async (
  input: DeriveOntosModuleContractInput,
): Promise<OntosModuleDeploymentContract> => {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? path.join(import.meta.dirname, '..'));
  const vertical = assertPlainTarget(input.vertical, 'vertical', canonicalSlugPattern);
  const verticalDirectory = path.join(workspaceRoot, 'verticals', vertical);
  await assertOwnerSlots(verticalDirectory);
  const owner = await loadOwnerValues(workspaceRoot, verticalDirectory);
  return deriveContract(workspaceRoot, vertical, owner);
};

export const generateOntosModuleContract = async (
  input: GenerateInput,
): Promise<{ readonly bytes: number; readonly etag: string; readonly path: string }> => {
  const workspaceRoot = path.resolve(input.workspaceRoot ?? path.join(import.meta.dirname, '..'));
  const vertical = assertPlainTarget(input.vertical, 'vertical', canonicalSlugPattern);
  const { target } = input;
  if (target !== 'dist' && target !== 'cloudflare-dist') {
    throw new Error('target must be dist or cloudflare-dist');
  }
  const verticalDirectory = path.join(workspaceRoot, 'verticals', vertical);
  const contract = await deriveOntosModuleDeploymentContract({ vertical, workspaceRoot });
  const content = stableJson(contract);
  const bytes = Buffer.byteLength(content);
  if (bytes > ONTOS_MODULE_CONTRACT_MAX_BYTES) {
    throw new Error('generated OntOS module contract exceeds the 1 MiB deployment limit');
  }
  const outputPath = path.join(
    verticalDirectory,
    outputRootByTarget[target],
    'public',
    ONTOS_MODULE_CONTRACT_PATH.slice(1),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, content, 'utf-8');
  await rename(temporaryPath, outputPath);
  const etag = `"${sha256(content)}"`;
  const headersPath = path.join(
    verticalDirectory,
    outputRootByTarget[target],
    'public',
    '_headers',
  );
  const headers = `${ONTOS_MODULE_CONTRACT_PATH}\n  Cache-Control: no-cache\n  Content-Type: application/json\n  ETag: ${etag}\n`;
  await writeFile(headersPath, headers, 'utf-8');
  return { bytes, etag, path: outputPath };
};

const parseArguments = (arguments_: readonly string[]): GenerateInput => {
  const values: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if ((flag !== '--vertical' && flag !== '--target') || value === undefined) {
      throw new Error(
        'Usage: generate-ontos-module-contract --vertical <vertical> --target <target>',
      );
    }
    values[flag.slice(2)] = value;
  }
  const { target, vertical } = values;
  if (vertical === undefined || target === undefined) {
    throw new Error(
      'Usage: generate-ontos-module-contract --vertical <vertical> --target <target>',
    );
  }
  if (target !== 'dist' && target !== 'cloudflare-dist') {
    throw new Error('target must be dist or cloudflare-dist');
  }
  return { target, vertical };
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const result = await generateOntosModuleContract(parseArguments(process.argv.slice(2)));
    console.log(`Generated ${result.path} (${result.bytes} bytes, ETag ${result.etag})`);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Unknown module contract generation failure',
    );
    process.exitCode = 1;
  }
}
