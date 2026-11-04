import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { coreShellRouteParameterNames, interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';

import { partyRegistryManifest } from '../../vertical.manifest.ts';

const moduleId = 'party.registry';
const shell = partyRegistryManifest.publicSurface.shellContributions;
const components = new Set(
  Object.keys(partyRegistryManifest.publicSurface.components).map((key) => `${moduleId}.${key}`),
);

const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = partyRegistryManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = partyRegistryManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
  if (resource === undefined) {
    throw new Error(`Missing resource ${resourceType}`);
  }
  return resource;
};

it('round-trips the exact owner shell contribution wire shape', () => {
  expect(shell.search.filter(({ presentation }) => presentation !== undefined)).toHaveLength(2);
  const decoded = Schema.decodeUnknownSync(OntosShellContributionsSchema, { onExcessProperty: 'error' })(
    structuredClone(shell),
  );
  expect(decoded).toEqual(shell);
});

it('binds party.registry.counterparties to its exact owner page and selector', () => {
  const contribution = contributionOf('party.registry.counterparties');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('party.registry.counterparties');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('party.registry');
  expect(descriptor.resourceType).toBe('party.registry.counterparty');
  expect(resourceOf('party.registry.counterparty').capabilities).toEqual({
    graphVisible: false,
    linkable: false,
    mediaAttachable: false,
    searchable: false,
    timelineVisible: true,
  });
  const expected = {
    family: {
      icon: 'icon-[mdi--handshake-outline]',
      key: 'companies',
      label: {
        cs: 'Zákazníci a dodavatelé',
        en: 'Customers and suppliers',
      },
      order: 20,
    },
    group: {
      icon: 'icon-[mdi--handshake-outline]',
      key: 'counterparty',
      label: {
        cs: 'Zákazníci a dodavatelé',
        en: 'Customers and suppliers',
      },
      order: 10,
    },
    record: {
      pageKey: 'party.registry.page.customer-detail',
      selector: {
        idEncoding: 'native',
        idFormat: 'uuid',
        kind: 'path',
        parameterName: 'id',
      },
    },
    scope: 'company',
  };
  expect(presentation).toEqual(expected);
  expect(presentation.agendaPageKeys).toBeUndefined();
  const { record } = presentation;
  if (record === undefined) {
    throw new Error('Missing record target');
  }
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'party.registry.page.customer-detail');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/prodej/zakaznici/:id');
  expect(page.componentKey).toBe('party.registry.page-customer-detail');
  expect(page.expose).toBe('./PageCustomerDetail');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('party.registry');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual(['id']);
  const recordId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const target = Result.getOrThrow(
    interpretCoreSearchPresentationEntry(
      {
        ownerModuleId: moduleId,
        presentation,
        resourceType: descriptor.resourceType,
        searchKey: contribution.searchKey,
      },
      { recordId },
    ),
  );
  expect(target.pageKey).toBe('party.registry.page.customer-detail');
  expect(target.pathParameters).toEqual([{ name: 'id', value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }]);
  expect(target.queryParameters).toEqual([]);
});

it('binds party.registry.parties to its exact owner page and selector', () => {
  const contribution = contributionOf('party.registry.parties');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('party.registry.parties');
  expect(descriptor.accessFiltering).toBe('tenant_scope');
  expect(descriptor.owningModuleId).toBe('party.registry');
  expect(descriptor.resourceType).toBe('party.registry.party');
  expect(resourceOf('party.registry.party').capabilities).toEqual({
    graphVisible: false,
    linkable: true,
    mediaAttachable: false,
    searchable: true,
    timelineVisible: true,
  });
  const expected = {
    family: {
      icon: 'icon-[mdi--account-group-outline]',
      key: 'people',
      label: {
        cs: 'Lidé',
        en: 'People',
      },
      order: 10,
    },
    group: {
      icon: 'icon-[mdi--card-account-details-outline]',
      key: 'party',
      label: {
        cs: 'Kontakty',
        en: 'Contacts',
      },
      order: 20,
    },
    record: {
      pageKey: 'party.registry.page.party-identity',
      selector: {
        idEncoding: 'native',
        idFormat: 'uuid',
        kind: 'path',
        parameterName: 'partyId',
      },
    },
    scope: 'tenant',
  };
  expect(presentation).toEqual(expected);
  expect(presentation.agendaPageKeys).toBeUndefined();
  const { record } = presentation;
  if (record === undefined) {
    throw new Error('Missing record target');
  }
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'party.registry.page.party-identity');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/prodej/strany/:partyId');
  expect(page.componentKey).toBe('party.registry.page-party-identity');
  expect(page.expose).toBe('./PagePartyIdentity');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('party.registry');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual(['partyId']);
  const recordId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const target = Result.getOrThrow(
    interpretCoreSearchPresentationEntry(
      {
        ownerModuleId: moduleId,
        presentation,
        resourceType: descriptor.resourceType,
        searchKey: contribution.searchKey,
      },
      { recordId },
    ),
  );
  expect(target.pageKey).toBe('party.registry.page.party-identity');
  expect(target.pathParameters).toEqual([{ name: 'partyId', value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }]);
  expect(target.queryParameters).toEqual([]);
});
