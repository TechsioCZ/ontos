import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { coreShellRouteParameterNames, interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';

import { crmManifest } from '../../vertical.manifest.ts';

const moduleId = 'demo.crm';
const shell = crmManifest.publicSurface.shellContributions;
const components = new Set(Object.keys(crmManifest.publicSurface.components).map((key) => `${moduleId}.${key}`));

const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = crmManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = crmManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
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

it('binds demo.crm.clients to its exact owner page and selector', () => {
  const contribution = contributionOf('demo.crm.clients');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('demo.crm.clients');
  expect(descriptor.accessFiltering).toBe('legal_entity_scope');
  expect(descriptor.owningModuleId).toBe('demo.crm');
  expect(descriptor.resourceType).toBe('demo.crm.client');
  expect(resourceOf('demo.crm.client').capabilities).toEqual({
    graphVisible: false,
    linkable: false,
    mediaAttachable: false,
    searchable: false,
    timelineVisible: false,
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
      icon: 'icon-[mdi--account-tie-outline]',
      key: 'crmClient',
      label: {
        cs: 'Klienti',
        en: 'Clients',
      },
      order: 40,
    },
    record: {
      pageKey: 'demo.crm.page.clients',
      selector: {
        idEncoding: 'native',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'klient',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'demo.crm.page.clients');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/crm/klienti');
  expect(page.componentKey).toBe('demo.crm.page-clients');
  expect(page.expose).toBe('./PageClients');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('demo.crm');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual([]);
  const recordId = 'item-6692/?#ě';
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
  expect(target.pageKey).toBe('demo.crm.page.clients');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'klient', value: 'item-6692/?#ě' }]);
});

it('binds demo.crm.contacts to its exact owner page and selector', () => {
  const contribution = contributionOf('demo.crm.contacts');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('demo.crm.contacts');
  expect(descriptor.accessFiltering).toBe('legal_entity_scope');
  expect(descriptor.owningModuleId).toBe('demo.crm');
  expect(descriptor.resourceType).toBe('demo.crm.contact');
  expect(resourceOf('demo.crm.contact').capabilities).toEqual({
    graphVisible: false,
    linkable: false,
    mediaAttachable: false,
    searchable: false,
    timelineVisible: false,
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
      icon: 'icon-[mdi--card-account-phone-outline]',
      key: 'crmContact',
      label: {
        cs: 'Kontaktní osoby',
        en: 'Contact people',
      },
      order: 50,
    },
    record: {
      pageKey: 'demo.crm.page.clients',
      selector: {
        idEncoding: 'native',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'osoba',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'demo.crm.page.clients');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/crm/klienti');
  expect(page.componentKey).toBe('demo.crm.page-clients');
  expect(page.expose).toBe('./PageClients');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('demo.crm');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual([]);
  const recordId = 'item-6692/?#ě';
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
  expect(target.pageKey).toBe('demo.crm.page.clients');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'osoba', value: 'item-6692/?#ě' }]);
});
