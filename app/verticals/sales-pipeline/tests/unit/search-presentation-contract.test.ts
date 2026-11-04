import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { coreShellRouteParameterNames, interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';

import { salesPipelineManifest } from '../../vertical.manifest.ts';

const moduleId = 'demo.sales-pipeline';
const shell = salesPipelineManifest.publicSurface.shellContributions;
const components = new Set(
  Object.keys(salesPipelineManifest.publicSurface.components).map((key) => `${moduleId}.${key}`),
);

const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = salesPipelineManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = salesPipelineManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
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

it('binds demo.sales-pipeline.opportunities to its exact owner page and selector', () => {
  const contribution = contributionOf('demo.sales-pipeline.opportunities');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('demo.sales-pipeline.opportunities');
  expect(descriptor.accessFiltering).toBe('resource_permission');
  expect(descriptor.owningModuleId).toBe('demo.sales-pipeline');
  expect(descriptor.resourceType).toBe('demo.sales-pipeline.opportunity');
  expect(resourceOf('demo.sales-pipeline.opportunity').capabilities).toEqual({
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
      icon: 'icon-[mdi--briefcase-outline]',
      key: 'opportunity',
      label: {
        cs: 'Obchodní příležitosti',
        en: 'Opportunities',
      },
      order: 60,
    },
    record: {
      pageKey: 'demo.sales-pipeline.page.records',
      selector: {
        idEncoding: 'native',
        idFormat: 'opaque',
        kind: 'query',
        parameterName: 'opportunityId',
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
  const page = shell.pages.find(({ contributionKey }) => contributionKey === 'demo.sales-pipeline.page.records');
  if (page === undefined) {
    throw new Error('Missing page contribution');
  }
  expect(page.routePath).toBe('/prodej/prilezitosti');
  expect(page.componentKey).toBe('demo.sales-pipeline.page-records');
  expect(page.expose).toBe('./PageRecords');
  expect(page.entrypoint.role).toBe('page');
  expect(page.entrypoint.moduleKey).toBe('demo.sales-pipeline');
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
  expect(target.pageKey).toBe('demo.sales-pipeline.page.records');
  expect(target.pathParameters).toEqual([]);
  expect(target.queryParameters).toEqual([{ name: 'opportunityId', value: 'item-6692/?#ě' }]);
});
