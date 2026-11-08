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
  generatedProviderOwnerProjection,
  hasExactGeneratedProviderIdentityTopology,
  hasGeneratedModuleApiReadContract,
  hasGeneratedProviderManifest,
  hasGeneratedProviderReadContract,
  hasMatchingGeneratedProviderAuthorization,
} from '../generated-module-api-boundary.mts';
import type {
  GeneratedProviderManifestSources,
  GeneratedReadAuthorization,
} from '../generated-module-api-boundary.mts';

const readSource = (file: string): string => readFileSync(path.resolve(import.meta.dirname, '../..', file), 'utf-8');

const sourceExists = (file: string): boolean => existsSync(path.resolve(import.meta.dirname, '../..', file));

const crmActivitiesFile = 'verticals/crm-activities/src/api/records.read.ts';
const crmModuleId = 'crm.activities';
const crmName = 'records';
const pricingFile = 'verticals/pricing/src/api/commitment-confirmation-verification.read.ts';
const pricingModuleId = 'commerce.pricing';
const pricingName = 'commitment-confirmation-verification';
const FACILITY_MODULE_ID = 'facility.operations';
const PROTECTED_AUTHORIZATION = "authorization: { kind: 'protected' }";
const PUBLIC_AUTHORIZATION = "authorization: { kind: 'public' }";
const SEARCH_ENTRYPOINT_CONSTANT = 'const searchEntrypointKey =';
const MUTABLE_SEARCH_ENTRYPOINT = 'let searchEntrypointKey =';
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
  ['verticals/facility-operations/src/api/records.read.ts', FACILITY_MODULE_ID, 'records'],
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
    (source) => source.replace(PROTECTED_AUTHORIZATION, PUBLIC_AUTHORIZATION),
  ],
  ['an entrypoint that is not a read', (source) => source.replace("access: 'read'", "access: 'write'")],
  [
    'a classification carrying an extra capability',
    (source) =>
      source.replace(PROTECTED_AUTHORIZATION, "authorization: { kind: 'protected', permission: 'module.access' }"),
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
 * The generated search providers whose owner splits its declaration: the manifest root spreads the owner's
 * runtime manifest from its sibling `vertical.runtime-declaration.ts`, which names the module id, the search
 * entrypoint key, and the authorization through immutable module-local constants. The proof projects the
 * original owning objects and binds every alias back to those same programs, never to a synthetic text.
 */
const aliasedSearchProviders = [
  ['verticals/work-tasks', 'work.tasks', 'tasks'],
  ['verticals/sales-pipeline', 'demo.sales-pipeline', 'opportunities'],
] as const;

const RUNTIME_DECLARATION_FILE = 'vertical.runtime-declaration.ts';

interface ProviderOwner {
  readonly manifest: string;
  readonly registration: string;
  readonly sources?: GeneratedProviderManifestSources;
}

/** The checker's view of an owner: the projected original objects for a split owner, the manifest otherwise. */
const providerOwnerView = (
  manifestSource: string,
  registration: string,
  runtimeDeclarationSource?: string,
): ProviderOwner => {
  if (runtimeDeclarationSource === undefined) {
    return { manifest: manifestSource, registration };
  }
  const sources = { manifestSource, runtimeDeclarationSource };
  return { manifest: generatedProviderOwnerProjection(sources) ?? '', registration, sources };
};

const providerOwner = (ownerPath: string): ProviderOwner =>
  providerOwnerView(
    readSource(`${ownerPath}/vertical.manifest.ts`),
    readSource(`${ownerPath}/vertical.registration.ts`),
    sourceExists(`${ownerPath}/${RUNTIME_DECLARATION_FILE}`)
      ? readSource(`${ownerPath}/${RUNTIME_DECLARATION_FILE}`)
      : undefined,
  );
const providerRead = (ownerPath: string, name: string): string =>
  readSource(`${ownerPath}/src/search/${name}.provider.ts`);

const ownerAccepts = (owner: ProviderOwner, provider: string, moduleId: string, name: string): boolean =>
  hasGeneratedProviderManifest(owner.manifest, moduleId, name, 'search', owner.sources) &&
  hasMatchingGeneratedProviderAuthorization(provider, owner.manifest, moduleId, name, 'search', owner.sources) &&
  hasExactGeneratedProviderIdentityTopology(owner.manifest, owner.registration, moduleId, owner.sources);

const providerAccepted = (ownerPath: string, moduleId: string, name: string): boolean =>
  ownerAccepts(providerOwner(ownerPath), providerRead(ownerPath, name), moduleId, name);

it('proves native provider metadata that shares immutable authorization objects and identity templates', () => {
  for (const { moduleId, names, ownerPath } of [
    {
      moduleId: FACILITY_MODULE_ID,
      names: ['assets', 'devices', 'documents', 'meters'],
      ownerPath: 'verticals/facility-operations',
    },
    { moduleId: 'demo.merchandise', names: ['orders', 'products'], ownerPath: 'verticals/merchandise' },
    { moduleId: 'demo.crm', names: ['clients', 'contacts'], ownerPath: 'verticals/crm' },
  ]) {
    expect(sourceExists(`${ownerPath}/${RUNTIME_DECLARATION_FILE}`), ownerPath).toBe(true);
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

it('refuses shared authorization objects that are mutable, mutated, or widened in the split declaration', () => {
  const ownerPath = 'verticals/facility-operations';
  const moduleId = FACILITY_MODULE_ID;
  const manifest = readSource(`${ownerPath}/vertical.manifest.ts`);
  const registration = readSource(`${ownerPath}/vertical.registration.ts`);
  const declaration = readSource(`${ownerPath}/${RUNTIME_DECLARATION_FILE}`);
  const provider = providerRead(ownerPath, 'assets');
  const original = "const restrictedAccess = { kind: 'protected' } as const;";
  expect(declaration).toContain(original);
  const forged = [
    ['a mutable shared authorization object', original.replace('const restrictedAccess', 'let restrictedAccess')],
    ['a public shared authorization object', original.replace("kind: 'protected'", "kind: 'public'")],
    ['a mutated shared authorization object', `${original}\nrestrictedAccess.kind = 'public';`],
    ['an escaped shared authorization object', `${original}\nexport const leakedAccess = [restrictedAccess];`],
  ] as const;
  for (const [defect, replacement] of forged) {
    const forgedDeclaration = declaration.replace(original, replacement);
    expect(forgedDeclaration, defect).not.toBe(declaration);
    expect(
      ownerAccepts(providerOwnerView(manifest, registration, forgedDeclaration), provider, moduleId, 'assets'),
      defect,
    ).toBe(false);
  }
});

it('proves the actual split search providers that name their identity through immutable runtime constants', () => {
  for (const [ownerPath, moduleId, name] of aliasedSearchProviders) {
    const declaration = readSource(`${ownerPath}/${RUNTIME_DECLARATION_FILE}`);
    const manifest = readSource(`${ownerPath}/vertical.manifest.ts`);
    expect(declaration, ownerPath).toContain(SEARCH_ENTRYPOINT_CONSTANT);
    expect(declaration, ownerPath).toContain('const moduleKey =');
    expect(manifest, ownerPath).toContain(`from './${RUNTIME_DECLARATION_FILE}';`);
    expect(providerAccepted(ownerPath, moduleId, name), ownerPath).toBe(true);
    // The projection alone proves nothing: its constants live in the original declaration program.
    const owner = providerOwner(ownerPath);
    expect(hasGeneratedProviderManifest(owner.manifest, moduleId, name, 'search'), ownerPath).toBe(false);
    expect(hasExactGeneratedProviderIdentityTopology(owner.manifest, owner.registration, moduleId), ownerPath).toBe(
      false,
    );
    // The provider read itself still binds its own immutable `searchKey` and stays on the v2 protected read.
    expect(hasGeneratedProviderReadContract(providerRead(ownerPath, name), moduleId, name, 'search'), ownerPath).toBe(
      true,
    );
  }
});

it('refuses a forged, mutable, foreign, or mismatched provider identity behind those constants', () => {
  const [[ownerPath, moduleId, name]] = aliasedSearchProviders;
  const manifest = readSource(`${ownerPath}/vertical.manifest.ts`);
  const declaration = readSource(`${ownerPath}/${RUNTIME_DECLARATION_FILE}`);
  const registration = readSource(`${ownerPath}/vertical.registration.ts`);
  const provider = providerRead(ownerPath, name);
  const forgedDeclarations = [
    [
      'a search entrypoint constant that names another read',
      declaration.replace(
        "const searchEntrypointKey = 'work.tasks.search.tasks';",
        "const searchEntrypointKey = 'work.tasks.search.other';",
      ),
    ],
    [
      'a module constant that names another owner',
      declaration.replace("const moduleKey = 'work.tasks';", "const moduleKey = 'other.owner';"),
    ],
    [
      'a mutable search entrypoint constant',
      declaration.replace(SEARCH_ENTRYPOINT_CONSTANT, MUTABLE_SEARCH_ENTRYPOINT),
    ],
    [
      'a rebound search entrypoint constant',
      `${declaration.replace(SEARCH_ENTRYPOINT_CONSTANT, MUTABLE_SEARCH_ENTRYPOINT)}\nsearchEntrypointKey = 'work.tasks.search.tasks';\n`,
    ],
    [
      'a second binding for the search entrypoint constant',
      `${declaration}\nconst searchEntrypointKey = 'work.tasks.search.tasks';\n`,
    ],
    [
      'a search key that names another read',
      declaration.replace("searchKey: 'work.tasks.tasks'", "searchKey: 'work.tasks.other'"),
    ],
    [
      'a widened search authorization',
      declaration.replace(
        "authorization: { kind: 'protected' },\n            entrypointKey: searchEntrypointKey,",
        "authorization: { kind: 'public' },\n            entrypointKey: searchEntrypointKey,",
      ),
    ],
  ] as const;
  for (const [defect, forgedDeclaration] of forgedDeclarations) {
    expect(forgedDeclaration, defect).not.toBe(declaration);
    expect(
      parseSync(RUNTIME_DECLARATION_FILE, forgedDeclaration, { astType: 'ts', lang: 'ts', sourceType: 'module' })
        .errors,
      defect,
    ).toEqual([]);
    expect(
      ownerAccepts(providerOwnerView(manifest, registration, forgedDeclaration), provider, moduleId, name),
      defect,
    ).toBe(false);
  }
  const forgedManifests = [
    [
      'a descriptor key that names another read',
      manifest.replace("key: 'work.tasks.tasks'", "key: 'work.tasks.other'"),
    ],
    [
      'a runtime manifest imported from a foreign owner',
      manifest.replace(`from './${RUNTIME_DECLARATION_FILE}';`, `from '../crm/${RUNTIME_DECLARATION_FILE}';`),
    ],
    [
      'a module id borrowed from a private implementation module',
      manifest
        .replace(
          "import { defineOntosModuleManifest } from '@app/core-runtime';",
          "import { defineOntosModuleManifest } from '@app/core-runtime';\nimport { privateModuleKey } from './src/private/module-key.ts';",
        )
        .replace('owningModuleId: moduleKey,', 'owningModuleId: privateModuleKey,'),
    ],
  ] as const;
  for (const [defect, forgedManifest] of forgedManifests) {
    expect(forgedManifest, defect).not.toBe(manifest);
    expect(
      ownerAccepts(providerOwnerView(forgedManifest, registration, declaration), provider, moduleId, name),
      defect,
    ).toBe(false);
  }
  // A projection that is not the exact text of the original owning objects cannot borrow their bindings.
  const owner = providerOwner(ownerPath);
  const displaced = {
    ...owner,
    manifest: owner.manifest.replace("key: 'work.tasks.tasks'", "key: 'work.tasks.other'"),
  };
  expect(ownerAccepts(displaced, provider, moduleId, name)).toBe(false);
  // The registration is the third leg of the topology: a renamed entry proves nothing about this read.
  const renamedRegistration = registration.replace('tasks: () =>', 'other: () =>');
  expect(renamedRegistration).not.toBe(registration);
  expect(hasExactGeneratedProviderIdentityTopology(owner.manifest, renamedRegistration, moduleId, owner.sources)).toBe(
    false,
  );
  // The provider read binds its own constant; a different read key is not this provider.
  const forgedProvider = provider.replace(
    "const searchKey = 'work.tasks.search.tasks';",
    "const searchKey = 'work.tasks.search.other';",
  );
  expect(forgedProvider).not.toBe(provider);
  expect(hasGeneratedProviderReadContract(forgedProvider, moduleId, name, 'search')).toBe(false);
  expect(ownerAccepts(owner, provider.replace(PROTECTED_AUTHORIZATION, PUBLIC_AUTHORIZATION), moduleId, name)).toBe(
    false,
  );
});

it('keeps an unsplit owner manifest as its own binding program', () => {
  // An owner without a runtime declaration proves its constants against the manifest it authored.
  const unsplit = `const moduleKey = 'work.tasks';
const searchEntrypointKey = 'work.tasks.search.tasks';
export const workTasksManifest = defineOntosModuleManifest({
  publicSurface: {
    reports: [
      // <generated-module-manifest-reports>
      // </generated-module-manifest-reports>
    ],
    search: [
      // <generated-module-manifest-search>
      { key: 'work.tasks.tasks', owningModuleId: moduleKey, resourceType: 'work.tasks.task' },
      // </generated-module-manifest-search>
    ],
    shellContributions: {
      reports: [
        // <generated-module-shell-reports>
        // </generated-module-shell-reports>
      ],
      search: [
        // <generated-module-shell-search>
        searchContribution({
          contributionKey: searchEntrypointKey,
          entrypoint: {
            access: 'read',
            authorization: { kind: 'protected' },
            entrypointKey: searchEntrypointKey,
            moduleKey,
            role: 'search',
            scope: 'tenant',
          },
          searchKey: 'work.tasks.tasks',
        }),
        // </generated-module-shell-search>
      ],
    },
  },
});
`;
  const [[ownerPath, moduleId, name]] = aliasedSearchProviders;
  const registration = readSource(`${ownerPath}/vertical.registration.ts`);
  const owner = providerOwnerView(unsplit, registration);
  expect(ownerAccepts(owner, providerRead(ownerPath, name), moduleId, name)).toBe(true);
  for (const [defect, forged] of [
    ['a mutable constant', unsplit.replace(SEARCH_ENTRYPOINT_CONSTANT, MUTABLE_SEARCH_ENTRYPOINT)],
    [
      'a foreign module constant',
      unsplit.replace("const moduleKey = 'work.tasks';", "const moduleKey = 'other.owner';"),
    ],
  ] as const) {
    expect(
      ownerAccepts(providerOwnerView(forged, registration), providerRead(ownerPath, name), moduleId, name),
      defect,
    ).toBe(false);
  }
});
