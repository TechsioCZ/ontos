/**
 * The native module-api Read rule proves one identity, end to end: the descriptor's own immutable Core
 * `defineRead` binding, the entrypoint that binding is connected to, and the module/read/schema IDs both
 * objects declare. This pins that proof to the actual generated Reads and refuses a forged, rebound,
 * shadowed, or mismatched identity, so a native-looking Read cannot pass on text that only resembles the
 * generated shape.
 *
 * `hasGeneratedModuleApiReadContract` is the module-api half; the governed-http seam adds the contribution,
 * callback, and policy halves around it. The negatives below mutate one identity fact at a time and still
 * parse, so a rejection is a semantic refusal rather than a syntax failure.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { toCamelCase } from '../boundary-source-structure.mts';
import {
  generatedModuleApiEntrypointReference,
  hasExactGeneratedProviderIdentityTopology,
  hasGeneratedModuleApiReadContract,
  hasGeneratedProviderManifest,
  hasGeneratedProviderReadContract,
  hasMatchingGeneratedProviderAuthorization,
} from '../generated-module-api-boundary.mts';
import type { GeneratedReadAuthorization } from '../generated-module-api-boundary.mts';

const readSource = (file: string): string => readFileSync(path.resolve(import.meta.dirname, '../..', file), 'utf-8');

const sourceExists = (file: string): boolean => existsSync(path.resolve(import.meta.dirname, '../..', file));

const crmActivitiesFile = 'verticals/crm-activities/src/api/records.read.ts';
const crmModuleId = 'crm.activities';
const crmName = 'records';
const pricingFile = 'verticals/pricing/src/api/commitment-confirmation-verification.read.ts';
const pricingModuleId = 'commerce.pricing';
const pricingName = 'commitment-confirmation-verification';
const protectedAuthorization: GeneratedReadAuthorization = { kind: 'protected' };

/** Prove the read the way the governed-http seam does: through the entrypoint its descriptor actually binds. */
const accepts = (
  source: string,
  moduleId: string,
  name: string,
  authorization: GeneratedReadAuthorization = protectedAuthorization,
): boolean => {
  const connected = generatedModuleApiEntrypointReference(source, `${toCamelCase(name)}Read`);
  return (
    connected !== undefined && hasGeneratedModuleApiReadContract(source, moduleId, name, authorization, connected.name)
  );
};

const nativeReads = [
  [crmActivitiesFile, crmModuleId, crmName],
  ['verticals/facility-operations/src/api/records.read.ts', 'facility.operations', 'records'],
  [
    'verticals/commerce-market-catalog/src/api/current-market-catalog.read.ts',
    'commerce.market-catalog',
    'current-market-catalog',
  ],
  [
    'verticals/commerce-customer-context/src/api/order-service-approval-evidence.read.ts',
    'commerce.customer-context',
    'order-service-approval-evidence',
  ],
  [pricingFile, pricingModuleId, pricingName],
] as const;

it('proves the real native module-api Reads through the entrypoint their descriptor binds', () => {
  for (const [file, moduleId, name] of nativeReads) {
    const source = readSource(file);
    expect(source, file).toContain(`readKey: '${moduleId}.api.${name}'`);
    expect(accepts(source, moduleId, name), file).toBe(true);
  }
});

it('resolves the entrypoint from the descriptor binding, never from a conventional name', () => {
  const source = readSource(pricingFile);
  const connected = generatedModuleApiEntrypointReference(source, 'commitmentConfirmationVerificationRead');
  expect(connected?.name).toBe('entrypoint');
  expect(connected?.shorthand).toBe(true);
  // The descriptor binds a shorthand `entrypoint`, so the conventional `${camel}Entrypoint` name is not the
  // proof; only the binding the descriptor actually resolves to is.
  expect(hasGeneratedModuleApiReadContract(source, pricingModuleId, pricingName, protectedAuthorization)).toBe(false);
  expect(accepts(source, pricingModuleId, pricingName)).toBe(true);
});

const crmActivities = readSource(crmActivitiesFile);

const forgedReads: readonly (readonly [string, (source: string) => string])[] = [
  ['a local `const defineRead` shadowing the Core import', (source) => `${source}\nconst defineRead = fake;\n`],
  ['a local `function defineRead` shadowing the Core import', (source) => `${source}\nfunction defineRead() {}\n`],
  ['a local `class defineRead` shadowing the Core import', (source) => `${source}\nclass defineRead {}\n`],
  [
    'a local `const defineTenantModuleEntrypoint` shadowing the Core import',
    (source) => `${source}\nconst defineTenantModuleEntrypoint = fake;\n`,
  ],
  [
    'a rebound `let` entrypoint binding',
    (source) => source.replace('const recordsEntrypoint =', 'let recordsEntrypoint ='),
  ],
  ['an entrypoint that escapes into another binding', (source) => `${source}\nconst leaked = recordsEntrypoint;\n`],
  [
    'a descriptor whose entrypoint names another binding',
    (source) => source.replace('entrypoint: recordsEntrypoint,', 'entrypoint: recordsRead,'),
  ],
  [
    'a shorthand alias whose property name is not `moduleKey`',
    (source) => source.replaceAll('moduleKey', 'MODULE_KEY'),
  ],
  [
    'an entrypoint on a different module',
    (source) => source.replace('  moduleKey,\n', "  moduleKey: 'other.owner',\n"),
  ],
  [
    'a read owned by a different module',
    (source) => source.replace('owningModuleKey: moduleKey,', "owningModuleKey: 'other.owner',"),
  ],
  [
    'a read key for a different read',
    (source) => source.replace("readKey: 'crm.activities.api.records'", "readKey: 'crm.activities.api.other'"),
  ],
  [
    'an entrypoint key for a different read',
    (source) =>
      source.replace("entrypointKey: 'crm.activities.api.records'", "entrypointKey: 'crm.activities.api.other'"),
  ],
  ['an entrypoint that is not the api role', (source) => source.replace("role: 'api'", "role: 'worker'")],
  [
    'a descriptor with a different schema version',
    (source) => source.replace("schemaVersion: '1'", "schemaVersion: '2'"),
  ],
  [
    'a non-protected entrypoint classification',
    (source) => source.replace("authorization: { kind: 'protected' }", "authorization: { kind: 'public' }"),
  ],
  ['an entrypoint that is not a read', (source) => source.replace("access: 'read'", "access: 'write'")],
  [
    'a classification carrying an extra capability',
    (source) =>
      source.replace(
        "authorization: { kind: 'protected' }",
        "authorization: { kind: 'protected', permission: 'module.access' }",
      ),
  ],
];

it('refuses forged, rebound, shadowed, and mismatched native Read identity', () => {
  for (const [defect, forge] of forgedReads) {
    const forged = forge(crmActivities);
    expect(forged, defect).not.toBe(crmActivities);
    // The forged source still parses, so the refusal below is the identity proof, not a syntax error.
    expect(
      parseSync(crmActivitiesFile, forged, { astType: 'ts', lang: 'ts', sourceType: 'module' }).errors,
      defect,
    ).toEqual([]);
    expect(accepts(forged, crmModuleId, crmName), defect).toBe(false);
  }
});

it('keeps the legitimate native identity spellings', () => {
  expect(accepts(crmActivities, crmModuleId, crmName)).toBe(true);
  // An uppercase alias used explicitly for both identity properties is the same proven identity.
  const uppercaseAlias = crmActivities
    .replace("const moduleKey = 'crm.activities';", "const MODULE_KEY = 'crm.activities';")
    .replace('  moduleKey,', '  moduleKey: MODULE_KEY,')
    .replace('owningModuleKey: moduleKey,', 'owningModuleKey: MODULE_KEY,');
  expect(uppercaseAlias).not.toBe(crmActivities);
  expect(accepts(uppercaseAlias, crmModuleId, crmName)).toBe(true);
});

/**
 * The generated search providers whose owner carries no runtime declaration: the manifest is its own proof
 * surface, and it names the module id, the search entrypoint key, and the read key through immutable
 * module-local constants. The proof follows those constants to the same identity a literal would carry.
 */
const aliasedSearchProviders = [
  ['verticals/work-tasks', 'work.tasks', 'tasks'],
  ['verticals/sales-pipeline', 'demo.sales-pipeline', 'opportunities'],
] as const;

const providerManifest = (ownerPath: string): string => readSource(`${ownerPath}/vertical.manifest.ts`);
const providerRegistration = (ownerPath: string): string => readSource(`${ownerPath}/vertical.registration.ts`);
const providerRead = (ownerPath: string, name: string): string =>
  readSource(`${ownerPath}/src/search/${name}.provider.ts`);

const providerAccepted = (ownerPath: string, moduleId: string, name: string): boolean =>
  hasGeneratedProviderManifest(providerManifest(ownerPath), moduleId, name, 'search') &&
  hasMatchingGeneratedProviderAuthorization(
    providerRead(ownerPath, name),
    providerManifest(ownerPath),
    moduleId,
    name,
    'search',
  ) &&
  hasExactGeneratedProviderIdentityTopology(providerManifest(ownerPath), providerRegistration(ownerPath), moduleId);

it('proves native provider metadata that shares immutable authorization objects and identity templates', () => {
  for (const { moduleId, names, ownerPath } of [
    {
      moduleId: 'facility.operations',
      names: ['assets', 'devices', 'documents', 'meters'],
      ownerPath: 'verticals/facility-operations',
    },
    { moduleId: 'demo.merchandise', names: ['orders', 'products'], ownerPath: 'verticals/merchandise' },
  ]) {
    for (const name of names) {
      expect(providerAccepted(ownerPath, moduleId, name), `${ownerPath}/${name}`).toBe(true);
    }
  }
  expect(
    hasGeneratedProviderReadContract(
      providerRead('verticals/projects', 'projects'),
      'projects.core',
      'projects',
      'search',
    ),
  ).toBe(true);
});

it('proves the actual declaration-less search providers that name their identity through immutable constants', () => {
  for (const [ownerPath, moduleId, name] of aliasedSearchProviders) {
    // The proof these owners need is the manifest itself: they publish no runtime declaration.
    expect(sourceExists(`${ownerPath}/vertical.runtime-declaration.ts`), ownerPath).toBe(false);
    const manifest = providerManifest(ownerPath);
    expect(manifest, ownerPath).toContain('const searchEntrypointKey =');
    expect(manifest, ownerPath).toContain('const moduleKey =');
    expect(providerAccepted(ownerPath, moduleId, name), ownerPath).toBe(true);
    // The provider read itself still binds its own immutable `searchKey` and stays on the v2 protected read.
    expect(hasGeneratedProviderReadContract(providerRead(ownerPath, name), moduleId, name, 'search'), ownerPath).toBe(
      true,
    );
  }
});

it('refuses a forged, mutable, or mismatched provider identity behind those constants', () => {
  const [[ownerPath, moduleId, name]] = aliasedSearchProviders;
  const manifest = providerManifest(ownerPath);
  const registration = providerRegistration(ownerPath);
  const provider = providerRead(ownerPath, name);
  const forged = [
    [
      'a search entrypoint constant that names another read',
      manifest.replace(
        "const searchEntrypointKey = 'work.tasks.search.tasks';",
        "const searchEntrypointKey = 'work.tasks.search.other';",
      ),
    ],
    [
      'a module constant that names another owner',
      manifest.replace("const moduleKey = 'work.tasks';", "const moduleKey = 'other.owner';"),
    ],
    [
      'a mutable search entrypoint constant',
      manifest.replace('const searchEntrypointKey =', 'let searchEntrypointKey ='),
    ],
    [
      'a second binding for the search entrypoint constant',
      `${manifest}\nconst searchEntrypointKey = 'work.tasks.search.tasks';\n`,
    ],
    [
      'a search key that names another read',
      manifest.replace("searchKey: 'work.tasks.tasks'", "searchKey: 'work.tasks.other'"),
    ],
    [
      'a descriptor key that names another read',
      manifest.replace("key: 'work.tasks.tasks'", "key: 'work.tasks.other'"),
    ],
  ] as const;
  for (const [defect, forgedManifest] of forged) {
    expect(forgedManifest, defect).not.toBe(manifest);
    expect(
      parseSync('manifest.ts', forgedManifest, { astType: 'ts', lang: 'ts', sourceType: 'module' }).errors,
      defect,
    ).toEqual([]);
    expect(hasGeneratedProviderManifest(forgedManifest, moduleId, name, 'search'), defect).toBe(false);
  }
  // The registration is the third leg of the topology: a renamed entry proves nothing about this read.
  const renamedRegistration = registration.replace('tasks: () =>', 'other: () =>');
  expect(renamedRegistration).not.toBe(registration);
  expect(hasExactGeneratedProviderIdentityTopology(manifest, renamedRegistration, moduleId)).toBe(false);
  // The provider read binds its own constant; a different read key is not this provider.
  const forgedProvider = provider.replace(
    "const searchKey = 'work.tasks.search.tasks';",
    "const searchKey = 'work.tasks.search.other';",
  );
  expect(forgedProvider).not.toBe(provider);
  expect(hasGeneratedProviderReadContract(forgedProvider, moduleId, name, 'search')).toBe(false);
});
