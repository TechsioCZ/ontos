import { expect, it } from 'effect-rstest';

import {
  hasGeneratedProviderManifestOwnerDeclared as hasGeneratedProviderManifest,
  hasGeneratedProviderReadContractOwnerDeclared as hasGeneratedProviderReadContract,
  hasMatchingGeneratedProviderAuthorization,
} from '../generated-module-api-boundary.mts';

const moduleId = 'party.registry';
const providerName = 'counterparties';
const protectedAuthorization = "authorization: { kind: 'protected' }";
const manifest = `
import { defineOntosModuleManifest } from '@app/core-runtime';
const OWNER = 'party.registry' as const;
export const manifest = defineOntosModuleManifest({
  search: [
    // <generated-module-manifest-search>
    { key: 'party.registry.counterparties', owningModuleId: OWNER },
    // </generated-module-manifest-search>
  ],
  reports: [
    // <generated-module-manifest-reports>
    // </generated-module-manifest-reports>
  ],
  shellContributions: {
    search: [
      // <generated-module-shell-search>
      searchContribution({
        contributionKey: 'party.registry.search.counterparties',
        entrypoint: {
          access: 'read',
          ${protectedAuthorization},
          entrypointKey: 'party.registry.search.counterparties',
          moduleKey: OWNER,
          role: 'search',
          scope: 'tenant',
        },
        searchKey: 'party.registry.counterparties',
      }),
      // </generated-module-shell-search>
    ],
    reports: [
      // <generated-module-shell-reports>
      // </generated-module-shell-reports>
    ],
  },
});
`;
const provider = `
import { defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
export const counterpartiesEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  ${protectedAuthorization},
  entrypointKey: 'party.registry.search.counterparties',
  moduleKey: 'party.registry',
  role: 'search',
});
export const counterpartiesRead = defineRead({
  accessKind: 'search',
  entrypoint: counterpartiesEntrypoint,
  legalEntityScope: 'optional',
  owningModuleKey: 'party.registry',
  readKey: 'party.registry.search.counterparties',
  schemaVersion: '1',
});
`;
const constantOwnerProvider = `
const OWNER = 'party.registry' as const;
${provider.replace("moduleKey: 'party.registry'", 'moduleKey: OWNER').replace("owningModuleKey: 'party.registry'", 'owningModuleKey: OWNER')}
`;
const matchesManifest = (source: string) => hasGeneratedProviderManifest(source, moduleId, providerName, 'search');
const matchesAuthorization = (source: string) =>
  hasMatchingGeneratedProviderAuthorization(provider, source, moduleId, providerName, 'search');

it('recognizes immutable module-local identities in protected decoded contributions', () => {
  expect(matchesManifest(manifest)).toBe(true);
  expect(matchesAuthorization(manifest)).toBe(true);
  expect(matchesManifest(manifest.replaceAll(' as const', ''))).toBe(true);
});

it('resolves the same immutable owner in the provider read without accepting a shadowed owner', () => {
  expect(hasGeneratedProviderReadContract(constantOwnerProvider, moduleId, providerName, 'search')).toBe(true);
  expect(
    hasGeneratedProviderReadContract(
      `${constantOwnerProvider}\nfunction shadow(OWNER: string) { return OWNER; }`,
      moduleId,
      providerName,
      'search',
    ),
  ).toBe(false);
});

it('still rejects a wrong owner', () => {
  expect(matchesManifest(manifest.replace("const OWNER = 'party.registry'", "const OWNER = 'wrong.owner'"))).toBe(
    false,
  );
});

it('does not infer identities from mutable, computed, reassigned or shadowed bindings', () => {
  for (const source of [
    manifest.replace('const OWNER =', 'let OWNER ='),
    manifest.replace("'party.registry' as const", "loadOwner('party.registry')"),
    `${manifest}\nOWNER = 'wrong.owner';`,
    `${manifest}\nfunction shadow(OWNER: string) { return OWNER; }`,
    `${manifest}\nfunction shadow() { const OWNER = 'wrong.owner'; return { moduleKey: OWNER }; }`,
    manifest.replace("const OWNER = 'party.registry' as const;", "// const OWNER = 'party.registry' as const;"),
  ]) {
    expect(matchesManifest(source)).toBe(false);
  }
});

it('keeps exact descriptor and entrypoint checks when literals are resolved', () => {
  expect(matchesManifest(manifest.replace("role: 'search'", "role: 'report'"))).toBe(false);
  expect(
    matchesManifest(
      manifest.replace("searchKey: 'party.registry.counterparties'", "searchKey: 'party.registry.other'"),
    ),
  ).toBe(false);
  expect(matchesManifest(manifest.replace('moduleKey: OWNER,', 'moduleKey: OWNER, ...untrusted,'))).toBe(false);
});
