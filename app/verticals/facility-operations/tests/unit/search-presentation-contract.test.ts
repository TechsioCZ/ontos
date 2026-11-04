import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { coreShellRouteParameterNames, interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';

import { facilityOperationsManifest } from '../../vertical.manifest.ts';

const moduleId = 'facility.operations';
const shell = facilityOperationsManifest.publicSurface.shellContributions;
const components = new Set(
  Object.keys(facilityOperationsManifest.publicSurface.components).map((key) => `${moduleId}.${key}`),
);

const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = facilityOperationsManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = facilityOperationsManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
  if (resource === undefined) {
    throw new Error(`Missing resource ${resourceType}`);
  }
  return resource;
};

it('round-trips the exact owner shell contribution wire shape', () => {
  expect(shell.search.filter(({ presentation }) => presentation !== undefined)).toHaveLength(4);
  const decoded = Schema.decodeUnknownSync(OntosShellContributionsSchema, { onExcessProperty: 'error' })(
    structuredClone(shell),
  );
  expect(decoded).toEqual(shell);
});

it('binds facility.operations.assets to its exact owner page and selector', () => {
  const contribution = contributionOf('facility.operations.assets');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('facility.operations.assets');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('facility.operations');
  expect(descriptor.resourceType).toBe('facility.operations.asset');
  expect(resourceOf('facility.operations.asset').capabilities).toEqual({
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
      icon: 'icon-[mdi--toolbox-outline]',
      key: 'asset',
      label: {
        cs: 'Majetek',
        en: 'Assets',
      },
      order: 180,
    },
    record: {
      pageKey: 'facility.operations.page.assets',
      selector: {
        idEncoding: 'selected_company_dot_prefix',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'asset',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'facility.operations.page.assets');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/provoz/majetek');
  expect(page.componentKey).toBe('facility.operations.page-assets');
  expect(page.expose).toBe('./PageAssets');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('facility.operations');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual([]);
  const company = '11111111-1111-4111-8111-111111111111';
  const recordId = `${company}.asset-6692/?#ě`;
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
  expect(target.pageKey).toBe('facility.operations.page.assets');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'asset', value: 'asset-6692/?#ě' }]);
});

it('binds facility.operations.devices to its exact owner page and selector', () => {
  const contribution = contributionOf('facility.operations.devices');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('facility.operations.devices');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('facility.operations');
  expect(descriptor.resourceType).toBe('facility.operations.device');
  expect(resourceOf('facility.operations.device').capabilities).toEqual({
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
      icon: 'icon-[mdi--gauge]',
      key: 'device',
      label: {
        cs: 'Zařízení a měřidla',
        en: 'Devices and meters',
      },
      order: 190,
    },
    record: {
      pageKey: 'facility.operations.page.security',
      selector: {
        idEncoding: 'selected_company_dot_prefix',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'device',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'facility.operations.page.security');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/provoz/bezpecnost');
  expect(page.componentKey).toBe('facility.operations.page-security');
  expect(page.expose).toBe('./PageSecurity');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('facility.operations');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual([]);
  const company = '11111111-1111-4111-8111-111111111111';
  const recordId = `${company}.device-6692/?#ě`;
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
  expect(target.pageKey).toBe('facility.operations.page.security');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'device', value: 'device-6692/?#ě' }]);
});

it('binds facility.operations.meters to its exact owner page and selector', () => {
  const contribution = contributionOf('facility.operations.meters');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('facility.operations.meters');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('facility.operations');
  expect(descriptor.resourceType).toBe('facility.operations.meter');
  expect(resourceOf('facility.operations.meter').capabilities).toEqual({
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
      icon: 'icon-[mdi--gauge]',
      key: 'device',
      label: {
        cs: 'Zařízení a měřidla',
        en: 'Devices and meters',
      },
      order: 190,
    },
    record: {
      pageKey: 'facility.operations.page.meters',
      selector: {
        idEncoding: 'selected_company_dot_prefix',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'meter',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'facility.operations.page.meters');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/provoz/meridla');
  expect(page.componentKey).toBe('facility.operations.page-meters');
  expect(page.expose).toBe('./PageMeters');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('facility.operations');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual([]);
  const company = '11111111-1111-4111-8111-111111111111';
  const recordId = `${company}.meter-6692/?#ě`;
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
  expect(target.pageKey).toBe('facility.operations.page.meters');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'meter', value: 'meter-6692/?#ě' }]);
});

it('binds facility.operations.documents to its exact owner page and selector', () => {
  const contribution = contributionOf('facility.operations.documents');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('facility.operations.documents');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('facility.operations');
  expect(descriptor.resourceType).toBe('facility.operations.document');
  expect(resourceOf('facility.operations.document').capabilities).toEqual({
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
      icon: 'icon-[mdi--folder-file-outline]',
      key: 'facilityDocument',
      label: {
        cs: 'Provozní dokumenty',
        en: 'Operations documents',
      },
      order: 200,
    },
    record: {
      pageKey: 'facility.operations.page.documents',
      selector: {
        idEncoding: 'selected_company_dot_prefix',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'doc',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'facility.operations.page.documents');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/provoz/dokumenty');
  expect(page.componentKey).toBe('facility.operations.page-documents');
  expect(page.expose).toBe('./PageDocuments');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('facility.operations');
  expect(page.entrypoint.scope).toBe('tenant');
  expect(components.has(page.componentKey)).toBe(true);
  expect(coreShellRouteParameterNames(page.routePath)).toEqual([]);
  const company = '11111111-1111-4111-8111-111111111111';
  const recordId = `${company}.doc-6692/?#ě`;
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
  expect(target.pageKey).toBe('facility.operations.page.documents');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'doc', value: 'doc-6692/?#ě' }]);
});
