#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_PATH,
  buildInstalledModuleCatalog,
  decodeOntosModuleDeploymentContract,
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

type JsonObject = Readonly<Record<string, unknown>>;

const object = (value: unknown, label: string): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
};

const readJson = (filePath: string): JsonObject =>
  object(JSON.parse(fs.readFileSync(filePath, 'utf-8')), filePath);

const sourceExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);

const walkSourceFiles = (directory: string): string[] => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('dist')) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walkSourceFiles(target)
      : sourceExtensions.has(path.extname(entry.name))
        ? [target]
        : [];
  });
};

const assertNoPrivateDeploymentImports = (
  workspaceRoot: string,
  verticals: readonly JsonObject[],
): void => {
  const sharedRoots = [
    path.join(workspaceRoot, 'apps/shell-super-app'),
    path.join(workspaceRoot, 'packages/core-runtime'),
  ];
  for (const filePath of sharedRoots.flatMap(walkSourceFiles)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (
      /(?:from\s+|import\s*\(|require\s*\()\s*['"][^'"]*(?:vertical\.manifest|vertical\.registration)(?:\.ts)?['"]/u.test(
        content,
      )
    ) {
      throw new Error(`${filePath} imports a private deployment manifest or registration`);
    }
  }
  for (const vertical of verticals) {
    const ownerRoot = path.join(workspaceRoot, String(vertical['path']));
    for (const filePath of walkSourceFiles(ownerRoot)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const imports = content.matchAll(
        /(?:from\s+|import\s*\(|require\s*\()\s*['"](?<specifier>[^'"]+)['"]/gu,
      );
      for (const match of imports) {
        const specifier = match.groups?.['specifier'];
        if (
          specifier === undefined ||
          !/vertical\.(?:manifest|registration)(?:\.ts)?$/u.test(specifier)
        ) {
          continue;
        }
        if (!specifier.startsWith('.')) {
          throw new Error(`${filePath} imports another deployment's private owner file`);
        }
        const resolved = path.resolve(path.dirname(filePath), specifier);
        if (!resolved.startsWith(`${ownerRoot}${path.sep}`)) {
          throw new Error(`${filePath} imports another deployment's private owner file`);
        }
      }
    }
  }
};

const exactlyOnce = (content: string, marker: string, filePath: string): void => {
  if (!content.includes(marker) || content.indexOf(marker) !== content.lastIndexOf(marker)) {
    throw new Error(`${filePath} must contain exactly one ${marker}`);
  }
};

const validateOwner = (filePath: string, markers: readonly string[]): string => {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.startsWith(`${MODULE_CONTRACT_GENERATOR_HEADER}\n`)) {
    throw new Error(`${filePath} is not a generated module-contract owner`);
  }
  for (const marker of markers) {
    exactlyOnce(content, marker, filePath);
  }
  const moduleId = content.match(/^\/\/ @ontos-module-id (?<moduleId>[^\s]+)$/mu)?.groups?.[
    'moduleId'
  ];
  if (moduleId === undefined) {
    throw new Error(`${filePath} is missing its generated module ID marker`);
  }
  return moduleId;
};

const validateEmittedContract = (
  verticalDirectory: string,
  target: string,
  expected: OntosModuleDeploymentContract,
): void => {
  const publicDirectory = path.join(verticalDirectory, target, 'public');
  if (!fs.existsSync(publicDirectory)) {
    return;
  }
  const contractPath = path.join(publicDirectory, ONTOS_MODULE_CONTRACT_PATH.slice(1));
  if (!fs.existsSync(contractPath)) {
    throw new Error(`${target} output is missing ${ONTOS_MODULE_CONTRACT_PATH}`);
  }
  const content = fs.readFileSync(contractPath);
  if (content.byteLength > ONTOS_MODULE_CONTRACT_MAX_BYTES) {
    throw new Error(`${contractPath} exceeds the 1 MiB contract limit`);
  }
  const contract = decodeOntosModuleDeploymentContract(JSON.parse(content.toString('utf-8')));
  if (
    contract.deployment.appId !== expected.deployment.appId ||
    contract.manifest.module.id !== expected.manifest.module.id
  ) {
    throw new Error(`${contractPath} identity does not match its generated owner metadata`);
  }
  if (JSON.stringify(contract) !== JSON.stringify(expected)) {
    throw new Error(`${contractPath} is stale relative to its authored module contract`);
  }
  const serialized = content.toString('utf-8');
  if (
    /sourcePath|importPath|exportPath|registrationPath|handlerPath|migrationPath/u.test(serialized)
  ) {
    throw new Error(`${contractPath} contains forbidden private path metadata`);
  }
  const headersPath = path.join(publicDirectory, '_headers');
  const headers = fs.readFileSync(headersPath, 'utf-8');
  if (
    !headers.includes('Cache-Control: no-cache') ||
    !headers.includes('Content-Type: application/json') ||
    !/^ {2}ETag: "[a-f0-9]{64}"$/mu.test(headers)
  ) {
    throw new Error(`${headersPath} is missing the immutable module-contract response headers`);
  }
};

export const checkOntosModuleContracts = async (workspaceRoot = process.cwd()): Promise<void> => {
  const topology = readJson(path.join(workspaceRoot, 'topology/reference-topology.json'));
  const verticalsValue = topology['verticals'];
  if (!Array.isArray(verticalsValue)) {
    throw new TypeError('reference topology verticals must be an array');
  }
  const verticals = verticalsValue.map((value) => object(value, 'topology vertical'));
  assertNoPrivateDeploymentImports(workspaceRoot, verticals);
  const appIds = verticals.map((vertical) => String(vertical['id']));
  const overlay = readJson(path.join(workspaceRoot, 'topology/local-overlays/development.json'));
  const allowlist = object(overlay['ontosModuleManifests'] ?? {}, 'ontosModuleManifests');
  const allowlistKeys = Object.keys(allowlist).toSorted((left, right) => left.localeCompare(right));
  const expectedKeys = [...appIds].toSorted((left, right) => left.localeCompare(right));
  if (JSON.stringify(allowlistKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error('development ontosModuleManifests keys must exactly match topology verticals');
  }
  const claimedModules = new Set<string>();
  const derivedContracts: InstalledDeploymentContractInput[] = [];
  for (const vertical of verticals) {
    const appId = String(vertical['id']);
    const relativePath = String(vertical['path']);
    const verticalDirectory = path.join(workspaceRoot, relativePath);
    const packageJson = readJson(path.join(verticalDirectory, 'package.json'));
    const modernjs = object(packageJson['modernjs'], `${appId} modernjs`);
    const ontosModule = object(modernjs['ontosModule'], `${appId} modernjs.ontosModule`);
    const manifestPath = path.join(verticalDirectory, 'vertical.manifest.ts');
    const registrationPath = path.join(verticalDirectory, 'vertical.registration.ts');
    const manifestModuleId = validateOwner(manifestPath, [
      MODULE_MANIFEST_IMPORT_SLOT_START,
      MODULE_MANIFEST_IMPORT_SLOT_END,
      MODULE_MANIFEST_ACTION_SLOT_START,
      MODULE_MANIFEST_ACTION_SLOT_END,
    ]);
    const registrationModuleId = validateOwner(registrationPath, [
      MODULE_REGISTRATION_IMPORT_SLOT_START,
      MODULE_REGISTRATION_IMPORT_SLOT_END,
      MODULE_REGISTRATION_ACTION_SLOT_START,
      MODULE_REGISTRATION_ACTION_SLOT_END,
      MODULE_REGISTRATION_WORKER_SLOT_START,
      MODULE_REGISTRATION_WORKER_SLOT_END,
    ]);
    if (
      modernjs['appId'] !== appId ||
      ontosModule['moduleId'] !== manifestModuleId ||
      registrationModuleId !== manifestModuleId ||
      ontosModule['schemaVersion'] !== ONTOS_MODULE_CONTRACT_PACKAGE_SCHEMA_VERSION
    ) {
      throw new Error(`${appId} package, manifest, registration, and topology identities disagree`);
    }
    if (claimedModules.has(manifestModuleId)) {
      throw new Error(`duplicate OntOS module ID ${manifestModuleId}`);
    }
    claimedModules.add(manifestModuleId);
    const buildScript = String(object(packageJson['scripts'], `${appId} scripts`)['build'] ?? '');
    const cloudflareBuildScript = String(
      object(packageJson['scripts'], `${appId} scripts`)['cloudflare:build'] ?? '',
    );
    if (
      !buildScript.includes(`--vertical ${path.basename(relativePath)} --target dist`) ||
      !cloudflareBuildScript.includes(
        `--vertical ${path.basename(relativePath)} --target cloudflare-dist`,
      )
    ) {
      throw new Error(`${appId} build scripts do not emit both module-contract deployment targets`);
    }
    const contractUrl = allowlist[appId];
    if (typeof contractUrl !== 'string' || !contractUrl.endsWith(ONTOS_MODULE_CONTRACT_PATH)) {
      throw new Error(`${appId} development module-contract URL is invalid`);
    }
    const derived = await deriveOntosModuleDeploymentContract({
      vertical: path.basename(relativePath),
      workspaceRoot,
    });
    if (derived.deployment.appId !== appId || derived.manifest.module.id !== manifestModuleId) {
      throw new Error(`${appId} authored module contract disagrees with generated owner metadata`);
    }
    derivedContracts.push({ contract: derived, expectedAppId: derived.deployment.appId });
    validateEmittedContract(verticalDirectory, 'dist', derived);
    validateEmittedContract(verticalDirectory, 'dist-cloudflare', derived);
  }
  buildInstalledModuleCatalog(derivedContracts);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await checkOntosModuleContracts();
    console.log('OntOS module contracts validated');
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Unknown module-contract validation failure',
    );
    process.exitCode = 1;
  }
}
