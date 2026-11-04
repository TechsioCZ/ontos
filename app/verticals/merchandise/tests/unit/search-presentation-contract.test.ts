import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { coreShellRouteParameterNames, interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';

import { merchandiseManifest } from '../../vertical.manifest.ts';

const moduleId = 'demo.merchandise';
const shell = merchandiseManifest.publicSurface.shellContributions;
const components = new Set(
  Object.keys(merchandiseManifest.publicSurface.components).map((key) => `${moduleId}.${key}`),
);

const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = merchandiseManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = merchandiseManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
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

it('binds demo.merchandise.products to its exact owner page and selector', () => {
  const contribution = contributionOf('demo.merchandise.products');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('demo.merchandise.products');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('demo.merchandise');
  expect(descriptor.resourceType).toBe('demo.merchandise.product');
  expect(resourceOf('demo.merchandise.product').capabilities).toEqual({
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
      icon: 'icon-[mdi--package-variant-closed]',
      key: 'product',
      label: {
        cs: 'Produkty',
        en: 'Products',
      },
      order: 70,
    },
    record: {
      pageKey: 'demo.merchandise.page.product-detail',
      selector: {
        idEncoding: 'selected_company_dot_prefix',
        idFormat: 'opaque',
        kind: 'path',
        parameterName: 'id',
      },
    },
    refinement: {
      kind: 'matched_variant',
      parameterName: 'variantId',
    },
    scope: 'company',
  };
  expect(presentation).toEqual(expected);
  expect(presentation.agendaPageKeys).toBeUndefined();
  const { record } = presentation;
  if (record === undefined) {
    throw new Error('Missing record target');
  }
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'demo.merchandise.page.product-detail');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/provoz/produkty/:id');
  expect(page.componentKey).toBe('demo.merchandise.page-product-detail');
  expect(page.expose).toBe('./PageProductDetail');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('demo.merchandise');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual(['id']);
  const company = '11111111-1111-4111-8111-111111111111';
  const recordId = `${company}.produkt-6692/?#ě`;
  const target = Result.getOrThrow(
    interpretCoreSearchPresentationEntry(
      {
        ownerModuleId: moduleId,
        presentation,
        resourceType: descriptor.resourceType,
        searchKey: contribution.searchKey,
      },
      { matchedVariantId: 'variant-6692/?#ě', recordId, selectedLegalEntityId: company },
    ),
  );
  expect(target.pageKey).toBe('demo.merchandise.page.product-detail');
  expect(target.pathParameters).toEqual([{ name: 'id', value: 'produkt-6692/?#ě' }]);
  expect(target.queryParameters).toEqual([{ name: 'variantId', value: 'variant-6692/?#ě' }]);
});

it('binds demo.merchandise.orders to its exact owner page and selector', () => {
  const contribution = contributionOf('demo.merchandise.orders');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('demo.merchandise.orders');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('demo.merchandise');
  expect(descriptor.resourceType).toBe('demo.merchandise.order');
  expect(resourceOf('demo.merchandise.order').capabilities).toEqual({
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
      icon: 'icon-[mdi--cart-outline]',
      key: 'order',
      label: {
        cs: 'Objednávky',
        en: 'Orders',
      },
      order: 90,
    },
    record: {
      pageKey: 'demo.merchandise.page.orders',
      selector: {
        idEncoding: 'selected_company_dot_prefix',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'orderId',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'demo.merchandise.page.orders');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/prodej/objednavky');
  expect(page.componentKey).toBe('demo.merchandise.page-orders');
  expect(page.expose).toBe('./PageOrders');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('demo.merchandise');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual([]);
  const company = '11111111-1111-4111-8111-111111111111';
  const recordId = `${company}.objednavka-6692/?#ě`;
  const target = Result.getOrThrow(
    interpretCoreSearchPresentationEntry(
      {
        ownerModuleId: moduleId,
        presentation,
        resourceType: descriptor.resourceType,
        searchKey: contribution.searchKey,
      },
      { recordId, selectedLegalEntityId: company },
    ),
  );
  expect(target.pageKey).toBe('demo.merchandise.page.orders');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'orderId', value: 'objednavka-6692/?#ě' }]);
});
