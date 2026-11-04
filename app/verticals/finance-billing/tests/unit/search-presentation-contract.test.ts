import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { coreShellRouteParameterNames, interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';

import { financeBillingManifest } from '../../vertical.manifest.ts';

const moduleId = 'finance.billing';
const shell = financeBillingManifest.publicSurface.shellContributions;
const components = new Set(
  Object.keys(financeBillingManifest.publicSurface.components).map((key) => `${moduleId}.${key}`),
);

const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = financeBillingManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = financeBillingManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
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

it('binds finance.billing.invoices to its exact owner page and selector', () => {
  const contribution = contributionOf('finance.billing.invoices');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('finance.billing.invoices');
  expect(descriptor.accessFiltering).toBe('legal_entity_scope');
  expect(descriptor.owningModuleId).toBe('finance.billing');
  expect(descriptor.resourceType).toBe('finance.billing.invoice');
  expect(resourceOf('finance.billing.invoice').capabilities).toEqual({
    graphVisible: false,
    linkable: false,
    mediaAttachable: false,
    searchable: false,
    timelineVisible: false,
  });
  const expected = {
    family: {
      icon: 'icon-[mdi--cash-multiple]',
      key: 'finance',
      label: {
        cs: 'Finance',
        en: 'Finance',
      },
      order: 40,
    },
    group: {
      icon: 'icon-[mdi--receipt-text-outline]',
      key: 'invoice',
      label: {
        cs: 'Faktury',
        en: 'Invoices',
      },
      order: 110,
    },
    record: {
      pageKey: 'finance.billing.page.records',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'finance.billing.page.records');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/finance');
  expect(page.componentKey).toBe('finance.billing.page-records');
  expect(page.expose).toBe('./PageRecords');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('finance.billing');
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
  expect(target.pageKey).toBe('finance.billing.page.records');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'resourceId', value: 'item-6692/?#ě' }]);
});

it('binds finance.billing.documents to its exact owner page and selector', () => {
  const contribution = contributionOf('finance.billing.documents');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('finance.billing.documents');
  expect(descriptor.accessFiltering).toBe('legal_entity_scope');
  expect(descriptor.owningModuleId).toBe('finance.billing');
  expect(descriptor.resourceType).toBe('finance.billing.document');
  expect(resourceOf('finance.billing.document').capabilities).toEqual({
    graphVisible: false,
    linkable: false,
    mediaAttachable: false,
    searchable: false,
    timelineVisible: false,
  });
  const expected = {
    family: {
      icon: 'icon-[mdi--cash-multiple]',
      key: 'finance',
      label: {
        cs: 'Finance',
        en: 'Finance',
      },
      order: 40,
    },
    group: {
      icon: 'icon-[mdi--file-document-multiple-outline]',
      key: 'financeDocument',
      label: {
        cs: 'Finanční doklady',
        en: 'Finance documents',
      },
      order: 120,
    },
    record: {
      pageKey: 'finance.billing.page.records',
      selector: {
        idEncoding: 'native',
        idFormat: 'uuid',
        kind: 'query',
        parameterName: 'documentId',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'finance.billing.page.records');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/finance');
  expect(page.componentKey).toBe('finance.billing.page-records');
  expect(page.expose).toBe('./PageRecords');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('finance.billing');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual([]);
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
  expect(target.pageKey).toBe('finance.billing.page.records');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'documentId', value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }]);
});
