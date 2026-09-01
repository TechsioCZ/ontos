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
      routePath: '/property-dashboard',
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

test('accepts safe dynamic page templates as plain serialized data', () => {
  const dynamic = full();
  dynamic.pages[0] = {
    ...dynamic.pages[0]!,
    routePath: '/crm/customers/:id/edit',
  };
  const decoded = validateShellContributions(dynamic, references);
  assert.equal(decoded.pages[0]?.routePath, '/crm/customers/:id/edit');
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), decoded);
  assert.doesNotMatch(JSON.stringify(decoded), /handler|loader|sourcePath|remote|import/iu);
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
  const baseline = full();
  assert.throws(() =>
    validateShellContributions(
      {
        ...baseline,
        search: [{ ...baseline.search[0]!, entrypoint: entrypoint('page') }],
      },
      references,
    ),
  );
  assert.throws(() =>
    validateShellContributions(
      {
        ...baseline,
        pages: [
          {
            ...baseline.pages[0]!,
            entrypoint: { ...baseline.pages[0]!.entrypoint, access: 'write' },
          },
        ],
      },
      references,
    ),
  );
  assert.throws(() =>
    validateShellContributions(
      {
        ...baseline,
        mediaAttachments: [
          {
            ...baseline.mediaAttachments[0]!,
            entrypoint: {
              ...baseline.mediaAttachments[0]!.entrypoint,
              access: 'read',
            },
          },
        ],
      },
      references,
    ),
  );
  assert.throws(() =>
    validateShellContributions(
      {
        ...baseline,
        pages: [{ ...baseline.pages[0]!, remote: 'private/remote' }],
      },
      references,
    ),
  );
  const withUnsafeRoute = full();
  withUnsafeRoute.pages[0] = { ...withUnsafeRoute.pages[0]!, routePath: '/modules/:module-id' };
  assert.throws(() => validateShellContributions(withUnsafeRoute, references));
});

for (const routePath of [
  '/cs/crm/customers/:id',
  '/en/crm/customers/:id',
  '/de/crm/customers/:id',
  '/pt-br/crm/customers/:id',
  '/crm/customers/:id/',
  '/crm//customers/:id',
  '/crm/customers/:id?mode=edit',
  '/crm/customers/:id#edit',
  '/crm/customers/%2e%2e/:id',
  '/crm/customers/*',
  '/crm/customers/:id?',
  '/crm/customers/:id*',
  '/crm/customers/:id+',
  '/crm/customers/:customer-id',
  '/crm/customers/:1id',
  '/crm/customers/:id/edit/:id',
] as const) {
  test(`rejects unsafe or ambiguous page route template ${routePath}`, () => {
    const candidate = full();
    candidate.pages[0] = { ...candidate.pages[0]!, routePath };
    assert.throws(() => validateShellContributions(candidate, references));
  });
}
