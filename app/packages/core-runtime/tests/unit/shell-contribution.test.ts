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

/**
 * O62: a protected Shell carrier must declare its access; an unprotected one carries none.
 * The negative controls below strip or mutate exactly one carrier at a time.
 */
const readDeclaration = (resource = 'unit') => ({
  key: `${moduleId}.${resource}.read`,
  kind: 'read' as const,
  modes: ['run'] as const,
  placement: { group: 'units', level: 'basic' as const },
  risk: 'routine' as const,
  selectors: [] as const,
});

/** A media attachment is a write carrier, so it declares an action instead of a read. */
const writeDeclaration = (resource = 'media') => ({
  key: `${moduleId}.${resource}.write`,
  kind: 'action' as const,
  modes: ['run'] as const,
  placement: { group: 'units', level: 'manage' as const },
  risk: 'routine' as const,
  selectors: [] as const,
});

const full = () => ({
  mediaAttachments: [
    {
      accessDeclaration: writeDeclaration(),
      actionKey: `${moduleId}.attach-media`,
      apiKey: `${moduleId}.resource-api`,
      contributionKey: `${moduleId}.media.unit`,
      entrypoint: { ...entrypoint('api'), access: 'write' as const },
      resourceType: `${moduleId}.unit`,
    },
  ],
  navigation: [
    {
      accessDeclaration: readDeclaration('navigation'),
      contributionKey: `${moduleId}.navigation.dashboard`,
      entrypoint: entrypoint('page'),
      groupKey: 'shell.navigation.primary',
      order: 10,
      pageKey: `${moduleId}.page.dashboard`,
    },
  ],
  pages: [
    {
      accessDeclaration: readDeclaration('page'),
      componentKey: `${moduleId}.dashboard`,
      contributionKey: `${moduleId}.page.dashboard`,
      entrypoint: entrypoint('page'),
      expose: './Dashboard',
      routePath: '/property-dashboard',
    },
  ],
  publicComponents: [
    {
      accessDeclaration: readDeclaration('component'),
      componentKey: `${moduleId}.dashboard`,
      contributionKey: `${moduleId}.component.dashboard`,
      entrypoint: entrypoint('public_component'),
      expose: './Dashboard',
    },
  ],
  reports: [
    {
      accessDeclaration: readDeclaration('report'),
      contributionKey: `${moduleId}.report.inventory`,
      entrypoint: entrypoint('report'),
      reportKey: `${moduleId}.inventory`,
    },
  ],
  resourceDetails: [
    {
      accessDeclaration: readDeclaration('resource'),
      apiKey: `${moduleId}.resource-api`,
      contributionKey: `${moduleId}.resource.unit`,
      entrypoint: entrypoint('api'),
      resourceType: `${moduleId}.unit`,
    },
  ],
  search: [
    {
      accessDeclaration: readDeclaration('search'),
      contributionKey: `${moduleId}.search.unit`,
      entrypoint: entrypoint('search'),
      searchKey: `${moduleId}.unit-search`,
    },
  ],
  timelines: [
    {
      accessDeclaration: readDeclaration('timeline'),
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
  // The declaration still names the old module, so the cross-owner entrypoint is refused there first.
  expect(() => validateShellContributions(crossOwner, references)).toThrow(/must be billing\.core/u);
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

it('keeps the declaration of a protected Shell carrier through validation', () => {
  const validated = validateShellContributions(full(), references);
  expect(first(validated.navigation).accessDeclaration?.key).toBe(`${moduleId}.navigation.read`);
  expect(first(validated.pages).accessDeclaration?.key).toBe(`${moduleId}.page.read`);
});

/** Removes the carrier a fixture declares, so a negative control can prove it is required. */
const withoutDeclaration = <Value extends { readonly accessDeclaration?: unknown }>(contribution: Value) => {
  const { accessDeclaration, ...rest } = contribution;
  expect(accessDeclaration === undefined).toBe(false);
  return rest;
};

it('requires an access declaration on every protected Shell carrier (O62)', () => {
  const baseline = full();
  const candidates = [
    { ...baseline, mediaAttachments: [withoutDeclaration(first(baseline.mediaAttachments))] },
    { ...baseline, navigation: [withoutDeclaration(first(baseline.navigation))] },
    { ...baseline, pages: [withoutDeclaration(first(baseline.pages))] },
    { ...baseline, publicComponents: [withoutDeclaration(first(baseline.publicComponents))] },
    { ...baseline, reports: [withoutDeclaration(first(baseline.reports))] },
    { ...baseline, resourceDetails: [withoutDeclaration(first(baseline.resourceDetails))] },
    { ...baseline, search: [withoutDeclaration(first(baseline.search))] },
    { ...baseline, timelines: [withoutDeclaration(first(baseline.timelines))] },
  ];
  for (const candidate of candidates) {
    expect(() => validateShellContributions(candidate, references)).toThrow(/must declare accessDeclaration/u);
  }
  // Negative control: an unprotected carrier is never asked for a declaration.
  const protectedEntrypoint = first(baseline.pages).entrypoint;
  const unprotected = validateShellContributions(
    {
      ...baseline,
      publicComponents: [
        {
          ...withoutDeclaration(first(baseline.publicComponents)),
          entrypoint: {
            ...protectedEntrypoint,
            authorization: { kind: 'authenticated_principal' as const },
            entrypointKey: `${moduleId}.public-component.primary`,
            role: 'public_component' as const,
          },
        },
      ],
    },
    references,
  );
  expect('accessDeclaration' in first(unprotected.publicComponents)).toBe(false);
});

it('applies the same carrier rules to the v2 protected page classification (CUTOVER-PLAN §4.2)', () => {
  const baseline = full();
  const protectedPage = first(baseline.pages);
  const v2 = {
    ...baseline,
    pages: [
      {
        ...protectedPage,
        entrypoint: { ...protectedPage.entrypoint, authorization: { kind: 'protected' as const } },
      },
    ],
  };
  const validated = validateShellContributions(v2, references);
  expect(first(validated.pages).entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(first(validated.pages).accessDeclaration?.key).toBe(`${moduleId}.page.read`);

  // Negative control: `protected` replaces both legacy kinds, so the declaration stays mandatory.
  const withoutCarrier = {
    ...v2,
    pages: [withoutDeclaration(first(v2.pages))],
  };
  expect(() => validateShellContributions(withoutCarrier, references)).toThrow(/must declare accessDeclaration/u);
});

it('rejects an access declaration on an unprotected or read-incompatible Shell contribution', () => {
  for (const contribution of [
    {
      ...first(full().navigation),
      accessDeclaration: readDeclaration('navigation'),
      entrypoint: { ...entrypoint('page'), authorization: { kind: 'authenticated_principal' as const } },
    },
    { ...first(full().navigation), accessDeclaration: { ...readDeclaration(), kind: 'action' as const } },
    { ...first(full().navigation), accessDeclaration: { ...readDeclaration(), key: 'other.module.unit.read' } },
    { ...first(full().navigation), accessDeclaration: { ...readDeclaration(), agentPolicy: 'run' } },
  ]) {
    expect(() => validateShellContributions({ ...full(), navigation: [contribution] }, references)).toThrow();
  }
});
