import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellContributionsSchema } from '@app/core-runtime';
import { coreShellRouteParameterNames, interpretCoreSearchPresentationEntry } from '@app/core-runtime/search-contract';
import { projectsManifest } from '../../vertical.manifest.ts';

const shell = projectsManifest.publicSurface.shellContributions;
const contributionOf = (searchKey: string) => {
  const contribution = shell.search.find((candidate) => candidate.searchKey === searchKey);
  if (contribution === undefined) {
    throw new Error(`Missing search contribution ${searchKey}`);
  }
  return contribution;
};

const descriptorOf = (searchKey: string) => {
  const descriptor = projectsManifest.publicSurface.search.find(({ key }) => key === searchKey);
  if (descriptor === undefined) {
    throw new Error(`Missing search descriptor ${searchKey}`);
  }
  return descriptor;
};

const resourceOf = (resourceType: string) => {
  const resource = projectsManifest.publicSurface.resourceTypes.find(({ key }) => key === resourceType);
  if (resource === undefined) {
    throw new Error(`Missing resource ${resourceType}`);
  }
  return resource;
};

const pageOf = (pageKey: string) => {
  const page = shell.pages.find(({ contributionKey }) => contributionKey === pageKey);
  if (page === undefined) {
    throw new Error(`Missing page ${pageKey}`);
  }
  return page;
};

it('round-trips the exact owner shell contribution wire shape', () => {
  expect(shell.search.filter(({ presentation }) => presentation !== undefined)).toHaveLength(1);
  const decoded = Schema.decodeUnknownSync(OntosShellContributionsSchema, { onExcessProperty: 'error' })(
    structuredClone(shell),
  );
  expect(decoded).toEqual(shell);
});

it('binds projects.core.projects to its exact owner page and selector', () => {
  const contribution = contributionOf('projects.core.projects');
  const { presentation } = contribution;
  if (presentation === undefined) {
    throw new Error('Missing presentation');
  }
  const descriptor = descriptorOf('projects.core.projects');
  expect(descriptor.accessFiltering).toBe('tenant_scope');
  expect(descriptor.owningModuleId).toBe('projects.core');
  expect(descriptor.resourceType).toBe('projects.project');
  expect(resourceOf('projects.project').capabilities).toEqual({
    graphVisible: false,
    linkable: true,
    mediaAttachable: false,
    searchable: false,
    timelineVisible: false,
  });
  const expected = {
    family: {
      icon: 'icon-[mdi--account-multiple-check-outline]',
      key: 'work',
      label: {
        cs: 'Lidé a úkoly',
        en: 'People and tasks',
      },
      order: 60,
    },
    group: {
      icon: 'icon-[mdi--folder-outline]',
      key: 'project',
      label: {
        cs: 'Projekty',
        en: 'Projects',
      },
      order: 240,
    },
    record: {
      pageKey: 'projects.core.page.create-project',
      selector: {
        idEncoding: 'native',
        idFormat: 'uuid',
        kind: 'query',
        parameterName: 'projectId',
      },
    },
    scope: 'tenant',
  };
  expect(presentation).toEqual(expected);
  expect(presentation.agendaPageKeys).toBeUndefined();
  expect(presentation.refinement).toBeUndefined();
  const page = pageOf('projects.core.page.create-project');
  expect(page.routePath).toBe('/projects/create-project');
  expect(coreShellRouteParameterNames(page.routePath)).toEqual([]);

  const projectId = '30000000-0000-4000-8000-000000000001';
  const interpreted = interpretCoreSearchPresentationEntry(
    {
      ownerModuleId: descriptor.owningModuleId,
      presentation,
      resourceType: descriptor.resourceType,
      searchKey: contribution.searchKey,
    },
    { recordId: projectId },
  );
  expect(Result.isSuccess(interpreted)).toBe(true);
  if (Result.isSuccess(interpreted)) {
    expect(interpreted.success).toMatchObject({
      kind: 'record',
      pageKey: 'projects.core.page.create-project',
      pathParameters: [],
      queryParameters: [{ name: 'projectId', value: projectId }],
      selectorKind: 'query',
    });
  }
});
