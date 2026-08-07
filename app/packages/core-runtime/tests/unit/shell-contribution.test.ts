/* eslint-disable typescript/no-non-null-assertion, unicorn/prefer-structured-clone -- Mutation fixtures intentionally target known tuple members and verify JSON round trips. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateShellContributions } from '../../src/modules/shell-contribution.ts';

const moduleId = 'property.registry';
const entrypoint = (role: 'api' | 'page' | 'public_component' | 'report' | 'search') => ({
  access: role === 'api' ? ('read' as const) : ('read' as const),
  entrypointKey: `${moduleId}.${role.replace('_', '-')}.primary`,
  moduleKey: moduleId,
  role,
  scope: 'tenant' as const,
});
const references = {
  actionKeys: new Set([`${moduleId}.attach-media`]),
  apiKeys: new Set([`${moduleId}.resource-api`]),
  componentKeys: new Set([`${moduleId}.dashboard`]),
  moduleId,
  reportKeys: new Set([`${moduleId}.inventory`]),
  resourceTypeKeys: new Set([`${moduleId}.unit`]),
  searchKeys: new Set([`${moduleId}.unit-search`]),
};

const full = () => ({
  mediaAttachments: [
    {
      actionKey: `${moduleId}.attach-media`,
      apiKey: `${moduleId}.resource-api`,
      contributionKey: `${moduleId}.media.unit`,
      entrypoint: { ...entrypoint('api'), access: 'write' as const },
      resourceType: `${moduleId}.unit`,
    },
  ],
  navigation: [
    {
      contributionKey: `${moduleId}.navigation.dashboard`,
      entrypoint: entrypoint('page'),
      groupKey: 'shell.navigation.primary',
      order: 10,
      pageKey: `${moduleId}.page.dashboard`,
    },
  ],
  pages: [
    {
      componentKey: `${moduleId}.dashboard`,
      contributionKey: `${moduleId}.page.dashboard`,
      entrypoint: entrypoint('page'),
    },
  ],
  publicComponents: [
    {
      componentKey: `${moduleId}.dashboard`,
      contributionKey: `${moduleId}.component.dashboard`,
      entrypoint: entrypoint('public_component'),
    },
  ],
  reports: [
    {
      contributionKey: `${moduleId}.report.inventory`,
      entrypoint: entrypoint('report'),
      reportKey: `${moduleId}.inventory`,
    },
  ],
  resourceDetails: [
    {
      apiKey: `${moduleId}.resource-api`,
      contributionKey: `${moduleId}.resource.unit`,
      entrypoint: entrypoint('api'),
      resourceType: `${moduleId}.unit`,
    },
  ],
  search: [
    {
      contributionKey: `${moduleId}.search.unit`,
      entrypoint: entrypoint('search'),
      searchKey: `${moduleId}.unit-search`,
    },
  ],
  timelines: [
    {
      apiKey: `${moduleId}.resource-api`,
      contributionKey: `${moduleId}.timeline.unit`,
      entrypoint: entrypoint('api'),
      resourceType: `${moduleId}.unit`,
    },
  ],
});

test('accepts exact empty and full Shell contribution contracts with deterministic JSON data', () => {
  const empty = {
    mediaAttachments: [],
    navigation: [],
    pages: [],
    publicComponents: [],
    reports: [],
    resourceDetails: [],
    search: [],
    timelines: [],
  };
  assert.deepEqual(validateShellContributions(empty, references), empty);
  const decoded = validateShellContributions(full(), references);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), decoded);
  assert.doesNotMatch(JSON.stringify(decoded), /handler|sourcePath|remote|import/iu);
});

test('rejects extra keys, duplicates, cross-owner entrypoints, and missing references', () => {
  assert.throws(() => validateShellContributions({ ...full(), route: '/private' }, references));
  const duplicate = full();
  duplicate.publicComponents[0] = {
    ...duplicate.publicComponents[0]!,
    contributionKey: duplicate.pages[0]!.contributionKey,
  };
  assert.throws(() => validateShellContributions(duplicate, references), /duplicate/u);
  const crossOwner = full();
  crossOwner.pages[0] = {
    ...crossOwner.pages[0]!,
    entrypoint: { ...crossOwner.pages[0]!.entrypoint, moduleKey: 'billing.core' },
  };
  assert.throws(() => validateShellContributions(crossOwner, references), /owner/u);
  assert.throws(() =>
    validateShellContributions(full(), { ...references, componentKeys: new Set() }),
  );
});

test('rejects incompatible entrypoint roles and arbitrary transport metadata', () => {
  const incompatible = full();
  incompatible.search[0] = {
    ...incompatible.search[0]!,
    entrypoint: entrypoint('page') as never,
  };
  assert.throws(() => validateShellContributions(incompatible, references));
  const incompatibleAccess = full();
  incompatibleAccess.pages[0] = {
    ...incompatibleAccess.pages[0]!,
    entrypoint: { ...incompatibleAccess.pages[0]!.entrypoint, access: 'write' } as never,
  };
  assert.throws(() => validateShellContributions(incompatibleAccess, references));
  const incompatibleMediaAccess = full();
  incompatibleMediaAccess.mediaAttachments[0] = {
    ...incompatibleMediaAccess.mediaAttachments[0]!,
    entrypoint: {
      ...incompatibleMediaAccess.mediaAttachments[0]!.entrypoint,
      access: 'read',
    } as never,
  };
  assert.throws(() => validateShellContributions(incompatibleMediaAccess, references));
  const withRemote = full();
  withRemote.pages[0] = { ...withRemote.pages[0]!, remote: 'private/remote' } as never;
  assert.throws(() => validateShellContributions(withRemote, references));
});
