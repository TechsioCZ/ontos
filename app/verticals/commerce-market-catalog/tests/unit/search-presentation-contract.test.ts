import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { coreShellRouteParameterNames, interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';

import { commerceMarketCatalogManifest } from '../../vertical.manifest.ts';

const moduleId = 'commerce.market-catalog';
const shell = commerceMarketCatalogManifest.publicSurface.shellContributions;
const components = new Set(
  Object.keys(commerceMarketCatalogManifest.publicSurface.components).map((key) => `${moduleId}.${key}`),
);

const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = commerceMarketCatalogManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = commerceMarketCatalogManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
  if (resource === undefined) {
    throw new Error(`Missing resource ${resourceType}`);
  }
  return resource;
};

it('round-trips the exact owner shell contribution wire shape', () => {
  expect(shell.search.filter(({ presentation }) => presentation !== undefined)).toHaveLength(1);
  const decoded = Schema.decodeUnknownSync(OntosShellContributionsSchema, { onExcessProperty: 'error' })(
    structuredClone(shell),
  );
  expect(decoded).toEqual(shell);
});

it('binds commerce.market-catalog.markets to its exact owner page and selector', () => {
  const contribution = contributionOf('commerce.market-catalog.markets');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('commerce.market-catalog.markets');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('commerce.market-catalog');
  expect(descriptor.resourceType).toBe('commerce.market-catalog.market');
  expect(resourceOf('commerce.market-catalog.market').capabilities).toEqual({
    graphVisible: false,
    linkable: false,
    mediaAttachable: false,
    searchable: true,
    timelineVisible: false,
  });
  const expected = {
    family: {
      icon: 'icon-[mdi--handshake-outline]',
      key: 'sales',
      label: {
        cs: 'Obchod a CRM',
        en: 'Sales and CRM',
      },
      order: 30,
    },
    group: {
      icon: 'icon-[mdi--earth]',
      key: 'market',
      label: {
        cs: 'Trhy',
        en: 'Markets',
      },
      order: 210,
    },
    record: {
      pageKey: 'commerce.market-catalog.page.market-detail',
      selector: {
        idEncoding: 'native',
        idFormat: 'uuid',
        kind: 'path',
        parameterName: 'marketId',
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
  const page = shell.pages.find(
    ({ contributionKey }) => contributionKey === 'commerce.market-catalog.page.market-detail',
  );
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/prodej/eshopy/trhy/:marketId');
  expect(page.componentKey).toBe('commerce.market-catalog.page-market-detail');
  expect(page.expose).toBe('./PageMarketDetail');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('commerce.market-catalog');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual(['marketId']);
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
  expect(target.pageKey).toBe('commerce.market-catalog.page.market-detail');
  expect(target.pathParameters).toEqual([{ name: 'marketId', value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }]);
  expect(target.queryParameters).toEqual([]);
});
