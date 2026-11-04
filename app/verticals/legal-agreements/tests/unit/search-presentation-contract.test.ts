import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { coreShellRouteParameterNames, interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';

import { legalAgreementsManifest } from '../../vertical.manifest.ts';

const moduleId = 'legal.agreements';
const shell = legalAgreementsManifest.publicSurface.shellContributions;
const components = new Set(
  Object.keys(legalAgreementsManifest.publicSurface.components).map((key) => `${moduleId}.${key}`),
);

const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = legalAgreementsManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = legalAgreementsManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
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

it('binds legal.agreements.contracts to its exact owner page and selector', () => {
  const contribution = contributionOf('legal.agreements.contracts');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('legal.agreements.contracts');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('legal.agreements');
  expect(descriptor.resourceType).toBe('legal.agreements.contract');
  expect(resourceOf('legal.agreements.contract').capabilities).toEqual({
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
      icon: 'icon-[mdi--file-sign]',
      key: 'contract',
      label: {
        cs: 'Smlouvy',
        en: 'Contracts',
      },
      order: 130,
    },
    record: {
      pageKey: 'legal.agreements.page.records',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'legal.agreements.page.records');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/smlouvy');
  expect(page.componentKey).toBe('legal.agreements.page-records');
  expect(page.expose).toBe('./PageRecords');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('legal.agreements');
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
  expect(target.pageKey).toBe('legal.agreements.page.records');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'resourceId', value: 'item-6692/?#ě' }]);
});

it('binds legal.agreements.documents to its exact owner page and selector', () => {
  const contribution = contributionOf('legal.agreements.documents');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('legal.agreements.documents');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('legal.agreements');
  expect(descriptor.resourceType).toBe('legal.agreements.document');
  expect(resourceOf('legal.agreements.document').capabilities).toEqual({
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
      icon: 'icon-[mdi--file-document-outline]',
      key: 'legalDocument',
      label: {
        cs: 'Právní dokumenty',
        en: 'Legal documents',
      },
      order: 140,
    },
    record: {
      pageKey: 'legal.agreements.page.records',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'legal.agreements.page.records');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/smlouvy');
  expect(page.componentKey).toBe('legal.agreements.page-records');
  expect(page.expose).toBe('./PageRecords');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('legal.agreements');
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
  expect(target.pageKey).toBe('legal.agreements.page.records');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'documentId', value: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }]);
});
