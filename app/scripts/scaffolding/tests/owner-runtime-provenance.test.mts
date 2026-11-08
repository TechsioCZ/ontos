import { readFileSync } from 'node:fs';
import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { hasValidGovernedHttpCompositionRoot } from '../../generated-governed-http-boundary.mts';
import {
  discoverOntosModuleEffect,
  isModuleManifestImport,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  readGeneratedSlotEntries,
  validRuntimeDeclarationViews,
} from '../shared.mts';

const readOwner = (path: string) => readFileSync(new URL(`../../../verticals/${path}`, import.meta.url), 'utf-8');
const backend = readOwner('party-registry/vertical.runtime-declaration.ts');
const manifest = readOwner('party-registry/vertical.manifest.ts');
const registration = readOwner('party-registry/vertical.registration.ts');
const fullSurfaceSpread = '...partyRegistryRuntimeManifest.publicSurface,';
const mcpProperty = 'mcp: partyRegistryMcpContribution,';
const validateParty = (backendSource = backend, manifestSource = manifest, registrationSource = registration) =>
  validRuntimeDeclarationViews(backendSource, manifestSource, registrationSource, 'partyRegistry', 'party.registry');

it('accepts the actual full Party manifest with its optional MCP contribution and without MCP', () => {
  expect(manifest).toContain(mcpProperty);
  expect(validateParty()).toBe(true);
  expect(validateParty(backend, manifest.replace(mcpProperty, ''))).toBe(true);
});

it('does not permit MCP on the backend-only view or unknown/duplicate/computed full-surface keys', () => {
  const withBackendMcp = backend.replace('publicSurface: {', 'publicSurface: { mcp: partyRegistryMcpContribution,');
  expect(withBackendMcp).not.toBe(backend);
  expect(() => validateParty(withBackendMcp)).toThrow(/shared declaration provenance/u);
  for (const invalid of [
    manifest.replace(fullSurfaceSpread, `${fullSurfaceSpread}\n  unrelated: [],`),
    manifest.replace(mcpProperty, `${mcpProperty}\n  ${mcpProperty}`),
    manifest.replace(mcpProperty, '[mcp]: partyRegistryMcpContribution,'),
  ]) {
    expect(invalid).not.toBe(manifest);
    expect(() => validateParty(backend, invalid)).toThrow(/shared declaration provenance/u);
  }
});

it('retains exact owner imports, module identity, declaration spreads and registration provenance', () => {
  for (const [b, m, r] of [
    [
      backend,
      manifest.replace("from './vertical.runtime-declaration.ts'", "from '../foreign/vertical.runtime-declaration.ts'"),
      registration,
    ],
    [backend, manifest.replace(fullSurfaceSpread, '...foreignRuntimeManifest.publicSurface,'), registration],
    [backend.replace("id: 'party.registry'", "id: 'foreign.module'"), manifest, registration],
    [backend, manifest, registration.replace('...partyRegistryRuntimeDeclaration,', '...foreignRuntimeDeclaration,')],
  ]) {
    expect([b, m, r]).not.toEqual([backend, manifest, registration]);
    expect(() => validateParty(b, m, r)).toThrow(/shared declaration provenance/u);
  }
});

it('accepts current Merchandise manifest imports except the retained legacy permission declarations', () => {
  const imports = readGeneratedSlotEntries(
    readOwner('merchandise/vertical.manifest.ts'),
    MODULE_MANIFEST_IMPORT_SLOT_START,
    MODULE_MANIFEST_IMPORT_SLOT_END,
  );
  const retiredPermissionImport =
    /^import \{ merchandise(?:Read|Write)AllPermission \} from '\.\/shared\/permissions\/merchandise-(?:read|write)-all\.ts';$/u;
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.filter((entry) => !retiredPermissionImport.test(entry)).every(isModuleManifestImport)).toBe(true);
  expect(
    imports.filter((entry) => !isModuleManifestImport(entry)).every((entry) => retiredPermissionImport.test(entry)),
  ).toBe(true);
});

it('does not accept legacy permission or foreign developer imports in the canonical manifest slot', () => {
  for (const entry of [
    "import { merchandiseReadAllPermission } from './shared/permissions/merchandise-read-all.ts';",
    "import { merchandiseWriteAllPermission } from './shared/permissions/merchandise-write-all.ts';",
    "import { fakeRead } from '../foreign/src/api/fake.read.ts';",
    "import { recordsRead } from './src/services/records.read.ts';",
    "import { fakeAction } from '../foreign/src/actions/fake.action.ts';",
  ]) {
    expect(isModuleManifestImport(entry)).toBe(false);
  }
});

it.effect('actual owner discovery reaches the legitimate shared MCP declaration without writing owner files', () =>
  Effect.gen(function* discoverPartyOwner() {
    const root = new URL('../../../', import.meta.url).pathname;
    const discovered = yield* discoverOntosModuleEffect(root, 'party-registry');
    expect(discovered.runtimeDeclaration?.content).toContain('export const partyRegistryRuntimeManifest');
    expect(discovered.moduleId).toBe('party.registry');
  }).pipe(Effect.provide(NodeServices.layer)),
);

const crmApi = readOwner('crm/shared/api.ts');
const crmRoot = readOwner('crm/api/index.ts');
const runtimeCall = 'const apiRuntime = makeCrmApiRuntime();';
const factoryStart = 'export const makeCrmApiRuntime = () =>';
const handlers = 'handlers: governedResolvedApiHandlersLive,';

it('accepts the actual executed zero-argument CRM assembler factory and resolves bindings rather than names', () => {
  expect(crmRoot).toContain(factoryStart);
  expect(crmRoot).toContain(runtimeCall);
  expect(hasValidGovernedHttpCompositionRoot(crmApi, crmRoot)).toBe(true);
  const typed = crmRoot.replace(
    factoryStart,
    'export const makeCrmApiRuntime = (): ReturnType<typeof assembleEffectBffRuntime> =>',
  );
  expect(hasValidGovernedHttpCompositionRoot(crmApi, typed)).toBe(true);
  const renamed = crmRoot.replaceAll('makeCrmApiRuntime', 'buildOwnerRuntime');
  expect(hasValidGovernedHttpCompositionRoot(crmApi, renamed)).toBe(true);
});

it('rejects unused/wrong factories, wrong handlers, mismatched arguments and unbound default calls', () => {
  for (const invalid of [
    crmRoot.replace(runtimeCall, 'const apiRuntime = unrelatedRuntime;'),
    crmRoot.replace(
      runtimeCall,
      'export const unrelatedFactory = () => Effect.succeed(null);\nconst apiRuntime = unrelatedFactory();',
    ),
    crmRoot.replace(handlers, 'handlers: apiHandlersLive,'),
    crmRoot.replace('api: crmApi,', 'api: unrelatedApi,'),
    crmRoot.replace('export default apiRuntime;', 'export default makeCrmApiRuntime();'),
    crmRoot.replace(runtimeCall, 'const apiRuntime = makeCrmApiRuntime(unboundInput);'),
    crmRoot.replace(factoryStart, 'export const makeCrmApiRuntime = (unboundInput: unknown) =>'),
    crmRoot.replace("from '@modern-js/bff-effect/assembly'", "from './counterfeit-assembly.ts'"),
    crmRoot.replace(
      "from '@app/core-runtime/modules/active-application-composition'",
      "from './counterfeit-composition.ts'",
    ),
    crmRoot.replace(
      'GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive)',
      'apiHandlersLive.pipe(GovernedReadLayer.provide(governedReadApiHandlersLive))',
    ),
  ]) {
    expect(invalid).not.toBe(crmRoot);
    expect(hasValidGovernedHttpCompositionRoot(crmApi, invalid)).toBe(false);
  }
});
