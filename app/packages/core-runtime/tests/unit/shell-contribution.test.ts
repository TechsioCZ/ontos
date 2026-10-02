import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { validateShellContributions } from '../../src/modules/shell-contribution.ts';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Any));

const moduleId = 'property.registry';
const first = <Value>(values: readonly Value[]): Value => {
  const [value] = values;
  if (value === undefined) {
    throw new Error('Expected a fixture item');
  }
  return value;
};
const entrypoint = (role: 'api' | 'page' | 'public_component' | 'report' | 'search') => ({
  access: 'read' as const,
  authorization: {
    kind: 'context_permission' as const,
    permission: 'module.access',
  },
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
      expose: './Dashboard',
      routePath: '/property-dashboard',
    },
  ],
  publicComponents: [
    {
      componentKey: `${moduleId}.dashboard`,
      contributionKey: `${moduleId}.component.dashboard`,
      entrypoint: entrypoint('public_component'),
      expose: './Dashboard',
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

it('accepts exact empty and full Shell contribution contracts with deterministic JSON data', () => {
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
  expect(validateShellContributions(empty, references)).toEqual(empty);
  const decoded = validateShellContributions(full(), references);
  expect(structuredClone(decoded)).toEqual(decoded);
  expect(encodeJson(decoded)).not.toMatch(/handler|sourcePath|remote|import/iu);
});

it('accepts safe dynamic page templates as plain serialized data', () => {
  const dynamic = full();
  dynamic.pages[0] = {
    ...first(dynamic.pages),
    routePath: '/contacts/customers/:id/edit',
  };
  const decoded = validateShellContributions(dynamic, references);
  expect(decoded.pages[0]?.routePath).toBe('/contacts/customers/:id/edit');
  expect(structuredClone(decoded)).toEqual(decoded);
  expect(encodeJson(decoded)).not.toMatch(/handler|loader|sourcePath|remote|import/iu);
});

it('requires explicit native Federation selectors for pages and public components', () => {
  const baseline = full();
  const { expose: pageExpose, ...pageWithoutExpose } = first(baseline.pages);
  const { expose: componentExpose, ...componentWithoutExpose } = first(baseline.publicComponents);
  expect(() => validateShellContributions({ ...baseline, pages: [pageWithoutExpose] }, references)).toThrow();
  expect(() =>
    validateShellContributions({ ...baseline, publicComponents: [componentWithoutExpose] }, references),
  ).toThrow();
  const decoded = validateShellContributions(baseline, references);
  expect(decoded.pages[0]?.expose).toBe(pageExpose);
  expect(decoded.publicComponents[0]?.expose).toBe(componentExpose);
  const nested = validateShellContributions(
    { ...baseline, pages: [{ ...first(baseline.pages), expose: './pages/PartyDashboard.v2' }] },
    references,
  );
  expect(nested.pages[0]?.expose).toBe('./pages/PartyDashboard.v2');
});

for (const expose of [
  '',
  'Dashboard',
  './',
  '../Dashboard',
  './pages/../Dashboard',
  './pages//Dashboard',
  './Dashboard/',
  './Dashboard?mode=edit',
  './Dashboard#edit',
  './%2e%2e/Dashboard',
  String.raw`./pages\Dashboard`,
  './https://private.example/Dashboard',
  `./${'D'.repeat(199)}`,
] as const) {
  it(`rejects unsafe native Federation selector ${expose}`, () => {
    const baseline = full();
    expect(() =>
      validateShellContributions({ ...baseline, pages: [{ ...first(baseline.pages), expose }] }, references),
    ).toThrow();
    expect(() =>
      validateShellContributions(
        { ...baseline, publicComponents: [{ ...first(baseline.publicComponents), expose }] },
        references,
      ),
    ).toThrow();
  });
}

it('rejects extra keys, duplicates, cross-owner entrypoints, and missing references', () => {
  expect(() => validateShellContributions({ ...full(), route: '/private' }, references)).toThrow();
  const duplicate = full();
  duplicate.publicComponents[0] = {
    ...first(duplicate.publicComponents),
    contributionKey: first(duplicate.pages).contributionKey,
  };
  expect(() => validateShellContributions(duplicate, references)).toThrow(/duplicate/u);
  const crossOwner = full();
  crossOwner.pages[0] = {
    ...first(crossOwner.pages),
    entrypoint: {
      ...first(crossOwner.pages).entrypoint,
      moduleKey: 'billing.core',
    },
  };
  expect(() => validateShellContributions(crossOwner, references)).toThrow(/owner/u);
  expect(() =>
    validateShellContributions(full(), {
      ...references,
      componentKeys: new Set(),
    }),
  ).toThrow();
});

it('rejects incompatible entrypoint roles and arbitrary transport metadata', () => {
  const baseline = full();
  expect(() =>
    validateShellContributions(
      {
        ...baseline,
        search: [{ ...first(baseline.search), entrypoint: entrypoint('page') }],
      },
      references,
    ),
  ).toThrow();
  expect(() =>
    validateShellContributions(
      {
        ...baseline,
        pages: [
          {
            ...first(baseline.pages),
            entrypoint: {
              ...first(baseline.pages).entrypoint,
              access: 'write',
            },
          },
        ],
      },
      references,
    ),
  ).toThrow();
  expect(() =>
    validateShellContributions(
      {
        ...baseline,
        mediaAttachments: [
          {
            ...first(baseline.mediaAttachments),
            entrypoint: {
              ...first(baseline.mediaAttachments).entrypoint,
              access: 'read',
            },
          },
        ],
      },
      references,
    ),
  ).toThrow();
  expect(() =>
    validateShellContributions(
      {
        ...baseline,
        pages: [{ ...first(baseline.pages), remote: 'private/remote' }],
      },
      references,
    ),
  ).toThrow();
  const withUnsafeRoute = full();
  withUnsafeRoute.pages[0] = {
    ...first(withUnsafeRoute.pages),
    routePath: '/modules/:module-id',
  };
  expect(() => validateShellContributions(withUnsafeRoute, references)).toThrow();
});

for (const routePath of [
  '/cs/contacts/customers/:id',
  '/en/contacts/customers/:id',
  '/de/contacts/customers/:id',
  '/pt-br/contacts/customers/:id',
  '/contacts/customers/:id/',
  '/contacts//customers/:id',
  '/contacts/customers/:id?mode=edit',
  '/contacts/customers/:id#edit',
  '/contacts/customers/%2e%2e/:id',
  '/contacts/customers/*',
  '/contacts/customers/:id?',
  '/contacts/customers/:id*',
  '/contacts/customers/:id+',
  '/contacts/customers/:customer-id',
  '/contacts/customers/:1id',
  '/contacts/customers/:constructor',
  '/contacts/customers/:prototype',
  '/contacts/customers/:id/edit/:id',
] as const) {
  it(`rejects unsafe or ambiguous page route template ${routePath}`, () => {
    const candidate = full();
    candidate.pages[0] = { ...first(candidate.pages), routePath };
    expect(() => validateShellContributions(candidate, references)).toThrow();
  });
}
