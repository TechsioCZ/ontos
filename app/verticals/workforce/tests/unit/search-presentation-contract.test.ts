import { Result, Schema } from 'effect';
import { interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { workforceManifest } from '../../vertical.manifest.ts';

const shell = workforceManifest.publicSurface.shellContributions;
const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = workforceManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = workforceManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
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

it('binds demo.workforce.employees to its exact owner page and selector', () => {
  const contribution = contributionOf('demo.workforce.employees');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('demo.workforce.employees');
  expect(descriptor.accessFiltering).toBe('legal_entity_scope');
  expect(descriptor.owningModuleId).toBe('demo.workforce');
  expect(descriptor.resourceType).toBe('demo.workforce.employee');
  expect(resourceOf('demo.workforce.employee').capabilities).toEqual({
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
      icon: 'icon-[mdi--badge-account-horizontal-outline]',
      key: 'employee',
      label: {
        cs: 'Zaměstnanci',
        en: 'Employees',
      },
      order: 230,
    },
    record: {
      pageKey: 'demo.workforce.page.records',
      selector: { idEncoding: 'native', idFormat: 'uuid', kind: 'query', parameterName: 'employeeId' },
    },
    scope: 'company',
  };
  expect(presentation).toEqual(expected);
  expect(presentation.agendaPageKeys).toBeUndefined();
  const page = shell.pages.find(({ contributionKey }) => contributionKey === presentation.record?.pageKey);
  expect(page?.routePath).toBe('/prodej/zamestnanci');
  expect(page?.entrypoint.moduleKey).toBe(workforceManifest.module.id);
  expect(
    Object.keys(workforceManifest.publicSurface.components).map((key) => `${workforceManifest.module.id}.${key}`),
  ).toContain(page?.componentKey);
  expect(page?.expose).toBe('./PageRecords');
  const employeeId = '50000000-0000-4000-8000-000000000002';
  const interpreted = interpretCoreSearchPresentationEntry(
    {
      ownerModuleId: descriptor.owningModuleId,
      presentation,
      resourceType: descriptor.resourceType,
      searchKey: descriptor.key,
    },
    { recordId: employeeId },
  );
  expect(Result.isSuccess(interpreted)).toBe(true);
  if (Result.isFailure(interpreted)) {
    throw new Error(interpreted.failure.message);
  }
  expect(interpreted.success.pathParameters).toEqual([]);
  expect(interpreted.success.queryParameters).toEqual([{ name: 'employeeId', value: employeeId }]);
  expect(presentation.refinement).toBeUndefined();
});
