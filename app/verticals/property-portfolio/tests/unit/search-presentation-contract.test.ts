import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { coreShellRouteParameterNames, interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';

import { propertyPortfolioManifest } from '../../vertical.manifest.ts';

const moduleId = 'property.portfolio';
const shell = propertyPortfolioManifest.publicSurface.shellContributions;
const components = new Set(
  Object.keys(propertyPortfolioManifest.publicSurface.components).map((key) => `${moduleId}.${key}`),
);

const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = propertyPortfolioManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = propertyPortfolioManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
  if (resource === undefined) {
    throw new Error(`Missing resource ${resourceType}`);
  }
  return resource;
};

it('round-trips the exact owner shell contribution wire shape', () => {
  expect(shell.search.filter(({ presentation }) => presentation !== undefined)).toHaveLength(3);
  const decoded = Schema.decodeUnknownSync(OntosShellContributionsSchema, { onExcessProperty: 'error' })(
    structuredClone(shell),
  );
  expect(decoded).toEqual(shell);
});

it('binds property.portfolio.properties to its exact owner page and selector', () => {
  const contribution = contributionOf('property.portfolio.properties');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('property.portfolio.properties');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('property.portfolio');
  expect(descriptor.resourceType).toBe('property.portfolio.property');
  expect(resourceOf('property.portfolio.property').capabilities).toEqual({
    graphVisible: false,
    linkable: false,
    mediaAttachable: false,
    searchable: true,
    timelineVisible: false,
  });
  const expected = {
    family: {
      icon: 'icon-[mdi--home-city-outline]',
      key: 'property',
      label: {
        cs: 'Nemovitosti a nájmy',
        en: 'Real estate and leases',
      },
      order: 50,
    },
    group: {
      icon: 'icon-[mdi--office-building-outline]',
      key: 'property',
      label: {
        cs: 'Nemovitosti',
        en: 'Properties',
      },
      order: 150,
    },
    record: {
      pageKey: 'property.portfolio.page.records',
      selector: {
        idEncoding: 'native',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'resourceId',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'property.portfolio.page.records');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/nemovitosti');
  expect(page.componentKey).toBe('property.portfolio.page-records');
  expect(page.expose).toBe('./PageRecords');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('property.portfolio');
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
  expect(target.pageKey).toBe('property.portfolio.page.records');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'resourceId', value: 'item-6692/?#ě' }]);
});

it('binds property.portfolio.units to its exact owner page and selector', () => {
  const contribution = contributionOf('property.portfolio.units');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('property.portfolio.units');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('property.portfolio');
  expect(descriptor.resourceType).toBe('property.portfolio.unit');
  expect(resourceOf('property.portfolio.unit').capabilities).toEqual({
    graphVisible: false,
    linkable: false,
    mediaAttachable: false,
    searchable: true,
    timelineVisible: false,
  });
  const expected = {
    family: {
      icon: 'icon-[mdi--home-city-outline]',
      key: 'property',
      label: {
        cs: 'Nemovitosti a nájmy',
        en: 'Real estate and leases',
      },
      order: 50,
    },
    group: {
      icon: 'icon-[mdi--door]',
      key: 'unit',
      label: {
        cs: 'Jednotky',
        en: 'Units',
      },
      order: 160,
    },
    record: {
      pageKey: 'property.portfolio.page.records',
      selector: {
        idEncoding: 'native',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'resourceId',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'property.portfolio.page.records');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/nemovitosti');
  expect(page.componentKey).toBe('property.portfolio.page-records');
  expect(page.expose).toBe('./PageRecords');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('property.portfolio');
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
  expect(target.pageKey).toBe('property.portfolio.page.records');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'resourceId', value: 'item-6692/?#ě' }]);
});

it('binds property.portfolio.assets to its exact owner page and selector', () => {
  const contribution = contributionOf('property.portfolio.assets');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('property.portfolio.assets');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('property.portfolio');
  expect(descriptor.resourceType).toBe('property.portfolio.asset');
  expect(resourceOf('property.portfolio.asset').capabilities).toEqual({
    graphVisible: false,
    linkable: false,
    mediaAttachable: false,
    searchable: false,
    timelineVisible: false,
  });
  const expected = {
    family: {
      icon: 'icon-[mdi--home-city-outline]',
      key: 'property',
      label: {
        cs: 'Nemovitosti a nájmy',
        en: 'Real estate and leases',
      },
      order: 50,
    },
    group: {
      icon: 'icon-[mdi--toolbox-outline]',
      key: 'asset',
      label: {
        cs: 'Majetek',
        en: 'Assets',
      },
      order: 180,
    },
    record: {
      pageKey: 'property.portfolio.page.records',
      selector: {
        idEncoding: 'native',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'resourceId',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'property.portfolio.page.records');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/nemovitosti');
  expect(page.componentKey).toBe('property.portfolio.page-records');
  expect(page.expose).toBe('./PageRecords');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('property.portfolio');
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
  expect(target.pageKey).toBe('property.portfolio.page.records');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'resourceId', value: 'item-6692/?#ě' }]);
});
