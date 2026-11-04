import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  shellSearchPresentationBindingIssue,
  validateShellContributions,
} from '../../src/modules/shell-contribution.ts';
import type { CoreSearchPresentationDeclaration } from '../../src/search/search-contract.ts';

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

/** The page fixture shape, including the optional record target these tests vary. */
interface PageContributionFixture {
  readonly componentKey: string;
  readonly contributionKey: string;
  readonly entrypoint: ReturnType<typeof entrypoint>;
  readonly expose: string;
  readonly recordTarget?: { readonly idParameter: string; readonly resourceType: string } | undefined;
  readonly routePath: string;
}

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
      icon: 'icon-[mdi--view-dashboard-outline]',
      label: { cs: 'Přehled', en: 'Dashboard' },
      order: 10,
      pageKey: `${moduleId}.page.dashboard`,
    },
  ],
  pages: [
    // SAFETY: The literal is the checked page fixture shape; the assertion only widens its inferred type for variants.
    {
      componentKey: `${moduleId}.dashboard`,
      contributionKey: `${moduleId}.page.dashboard`,
      entrypoint: entrypoint('page'),
      expose: './Dashboard',
      routePath: '/property-dashboard',
    } as PageContributionFixture,
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

it('accepts an owner page record destination and preserves it as plain serialized data', () => {
  const candidate = full();
  candidate.pages[0] = {
    ...first(candidate.pages),
    recordTarget: { idParameter: 'unitId', resourceType: `${moduleId}.unit` },
    routePath: '/property-units/:unitId',
  };
  const decoded = validateShellContributions(candidate, references);
  expect(decoded.pages[0]?.recordTarget).toEqual({ idParameter: 'unitId', resourceType: `${moduleId}.unit` });
  expect(encodeJson(decoded)).toContain(
    '"recordTarget":{"idParameter":"unitId","resourceType":"property.registry.unit"}',
  );
  // A page without the optional field keeps working, so the field is additive to every existing manifest.
  expect(validateShellContributions(full(), references).pages[0]?.recordTarget).toBeUndefined();
});

it('rejects a page record destination that does not bind its own route parameter or a declared resource type', () => {
  const candidate = full();
  const recordTarget = { idParameter: 'unitId', resourceType: `${moduleId}.unit` };
  const withRecordTarget = (
    routePath: string,
    target: { readonly idParameter: string; readonly resourceType: string } = recordTarget,
  ) => ({ ...candidate, pages: [{ ...first(candidate.pages), recordTarget: target, routePath }] });

  // The route carries no parameter at all.
  expect(() => validateShellContributions(withRecordTarget('/property-units'), references)).toThrow(/route parameter/u);
  // The route declares a different parameter than the record target names.
  expect(() => validateShellContributions(withRecordTarget('/property-units/:otherId'), references)).toThrow(
    /route parameter/u,
  );
  // The route declares more than the one parameter the record target selects.
  expect(() => validateShellContributions(withRecordTarget('/property-units/:unitId/:revision'), references)).toThrow(
    /route parameter/u,
  );
  // Another module's resource type, and a type this module never declares, are both foreign.
  for (const resourceType of ['party.registry.party', `${moduleId}.building`]) {
    expect(() =>
      validateShellContributions(
        withRecordTarget('/property-units/:unitId', { idParameter: 'unitId', resourceType }),
        references,
      ),
    ).toThrow(/undeclared/u);
  }
  // A parameter name that is not a plain route identifier.
  for (const idParameter of ['unit_id', '1unit', 'unit-id', '']) {
    expect(() =>
      validateShellContributions(
        withRecordTarget('/property-units/:unitId', { idParameter, resourceType: `${moduleId}.unit` }),
        references,
      ),
    ).toThrow();
  }
});

it('accepts only the explicit optional page legal-entity opt-in and leaves other pages unchanged', () => {
  const baseline = full();
  const plain = validateShellContributions(baseline, references);
  // Absent means required: a page that does not opt in carries no new field, so its serialized identity is unchanged.
  expect(plain.pages[0]?.legalEntityScope).toBeUndefined();
  expect(encodeJson(plain)).not.toContain('legalEntityScope');

  const optedIn = {
    ...baseline,
    pages: [{ ...first(baseline.pages), legalEntityScope: 'optional' as const }],
  };
  const decoded = validateShellContributions(optedIn, references);
  expect(decoded.pages[0]?.legalEntityScope).toBe('optional');
  expect(structuredClone(decoded)).toEqual(decoded);

  for (const legalEntityScope of ['required', 'forbidden', 'sometimes', 'OPTIONAL'] as const) {
    expect(() =>
      validateShellContributions({ ...baseline, pages: [{ ...first(baseline.pages), legalEntityScope }] }, references),
    ).toThrow();
  }
});

it('rejects two pages of one module that claim the same record destination', () => {
  const candidate = full();
  const firstPage = first(candidate.pages);
  candidate.pages = [
    {
      ...firstPage,
      recordTarget: { idParameter: 'unitId', resourceType: `${moduleId}.unit` },
      routePath: '/units/:unitId',
    },
    {
      ...firstPage,
      contributionKey: `${moduleId}.page.unit-archive`,
      recordTarget: { idParameter: 'unitId', resourceType: `${moduleId}.unit` },
      routePath: '/units/archive/:unitId',
    },
  ];
  expect(() => validateShellContributions(candidate, references)).toThrow(/ambiguous/u);
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

const searchPresentation = (): CoreSearchPresentationDeclaration => ({
  agendaPageKeys: [`${moduleId}.page.units`],
  family: {
    icon: 'icon-[mdi--office-building-outline]',
    key: 'property',
    label: { cs: 'Nemovitosti', en: 'Property' },
    order: 10,
  },
  group: {
    icon: 'icon-[mdi--door-open]',
    key: 'unit',
    label: { cs: 'Jednotky', en: 'Units' },
    order: 20,
  },
  record: {
    pageKey: `${moduleId}.page.dashboard`,
    selector: {
      idEncoding: 'native',
      idFormat: 'uuid',
      kind: 'path',
      parameterName: 'unitId',
    },
  },
  scope: 'company',
});

const presented = () => {
  const baseline = full();
  return {
    ...baseline,
    pages: [
      { ...first(baseline.pages), routePath: '/property-dashboard/:unitId' },
      {
        componentKey: `${moduleId}.dashboard`,
        contributionKey: `${moduleId}.page.units`,
        entrypoint: entrypoint('page'),
        expose: './Dashboard',
        routePath: '/property-units',
      },
    ],
    search: [
      {
        ...first(baseline.search),
        presentation: searchPresentation(),
      },
    ],
  };
};

const presentationReferences = {
  moduleId,
  resourceTypeKeys: new Set([`${moduleId}.unit`]),
  search: [
    {
      accessFiltering: 'legal_entity_scope' as const,
      key: `${moduleId}.unit-search`,
      owningModuleId: moduleId,
      resourceType: `${moduleId}.unit`,
    },
  ],
};

it('accepts exact same-owner presentation pages, path selectors and search bindings', () => {
  const decoded = validateShellContributions(presented(), references);
  expect(decoded.search[0]?.presentation?.record?.pageKey).toBe(`${moduleId}.page.dashboard`);
  expect(decoded.search[0]?.presentation?.agendaPageKeys).toEqual([`${moduleId}.page.units`]);
  expect(structuredClone(decoded)).toEqual(decoded);
  expect(encodeJson(decoded)).not.toMatch(/handler|loader|sourcePath|remote|import|expression/iu);
  expect(shellSearchPresentationBindingIssue(decoded, presentationReferences)).toBeUndefined();
});

it('accepts a concrete query selector and rejects a path selector outside the exact existing parameter', () => {
  const query = presented();
  query.pages[0] = { ...first(query.pages), routePath: '/property-dashboard' };
  const queryPresentation = first(query.search).presentation;
  query.search[0] = {
    ...first(query.search),
    presentation: {
      ...queryPresentation,
      record: {
        pageKey: `${moduleId}.page.dashboard`,
        selector: { idEncoding: 'native', idFormat: 'opaque', kind: 'query', parameterName: 'resourceId' },
      },
    },
  };
  expect(validateShellContributions(query, references).search[0]?.presentation?.record?.selector.kind).toBe('query');

  const wrongParameter = presented();
  const wrongPresentation = first(wrongParameter.search).presentation;
  if (wrongPresentation.record === undefined) {
    throw new Error('Expected a record fixture');
  }
  wrongParameter.search[0] = {
    ...first(wrongParameter.search),
    presentation: {
      ...wrongPresentation,
      record: {
        ...wrongPresentation.record,
        selector: { ...wrongPresentation.record.selector, parameterName: 'otherId' },
      },
    },
  };
  expect(() => validateShellContributions(wrongParameter, references)).toThrow(/only existing route parameter/u);

  const unbound = presented();
  unbound.pages[0] = { ...first(unbound.pages), routePath: '/property-dashboard/:unitId/:tab' };
  expect(() => validateShellContributions(unbound, references)).toThrow(/only existing route parameter/u);

  const queryWithParameter = presented();
  const queryWithParameterPresentation = first(queryWithParameter.search).presentation;
  queryWithParameter.search[0] = {
    ...first(queryWithParameter.search),
    presentation: {
      ...queryWithParameterPresentation,
      record: {
        pageKey: `${moduleId}.page.dashboard`,
        selector: { idEncoding: 'native', idFormat: 'uuid', kind: 'query', parameterName: 'resourceId' },
      },
    },
  };
  expect(() => validateShellContributions(queryWithParameter, references)).toThrow(/concrete page route/u);
});

it('rejects unknown, duplicate, foreign and ambiguous presentation page references', () => {
  const unknownRecord = presented();
  const recordPresentation = first(unknownRecord.search).presentation;
  if (recordPresentation.record === undefined) {
    throw new Error('Expected a record fixture');
  }
  unknownRecord.search[0] = {
    ...first(unknownRecord.search),
    presentation: {
      ...recordPresentation,
      record: { ...recordPresentation.record, pageKey: `${moduleId}.page.missing` },
    },
  };
  expect(() => validateShellContributions(unknownRecord, references)).toThrow(/undeclared page contribution/u);

  const unknownAgenda = presented();
  const agendaPresentation = first(unknownAgenda.search).presentation;
  unknownAgenda.search[0] = {
    ...first(unknownAgenda.search),
    presentation: { ...agendaPresentation, agendaPageKeys: [`${moduleId}.page.missing`] },
  };
  expect(() => validateShellContributions(unknownAgenda, references)).toThrow(/undeclared page contribution/u);

  const duplicateAgenda = presented();
  const duplicatePresentation = first(duplicateAgenda.search).presentation;
  duplicateAgenda.search[0] = {
    ...first(duplicateAgenda.search),
    presentation: {
      ...duplicatePresentation,
      agendaPageKeys: [`${moduleId}.page.units`, `${moduleId}.page.units`],
    },
  };
  expect(() => validateShellContributions(duplicateAgenda, references)).toThrow(/agenda page keys must be unique/u);

  const foreign = presented();
  const foreignPresentation = first(foreign.search).presentation;
  if (foreignPresentation.record === undefined) {
    throw new Error('Expected a record fixture');
  }
  foreign.search[0] = {
    ...first(foreign.search),
    presentation: {
      ...foreignPresentation,
      record: { ...foreignPresentation.record, pageKey: 'billing.core.page.dashboard' },
    },
  };
  expect(() => validateShellContributions(foreign, references)).toThrow(/undeclared page contribution/u);

  const omitted = presented();
  omitted.pages.pop();
  expect(() => validateShellContributions(omitted, references)).toThrow(/undeclared page contribution/u);
});

it('rejects shared group/family metadata disagreements and executable presentation fields', () => {
  const conflict = presented();
  const base = first(conflict.search);
  const secondSearch = {
    ...base,
    contributionKey: `${moduleId}.search.unit-two`,
    entrypoint: { ...entrypoint('search'), entrypointKey: `${moduleId}.search.secondary` },
    presentation: {
      ...base.presentation,
      group: {
        ...base.presentation.group,
        label: { cs: 'Jiná skupina', en: 'Other group' },
      },
    },
    searchKey: `${moduleId}.unit-search-two`,
  };
  expect(() =>
    validateShellContributions(
      { ...conflict, search: [...conflict.search, secondSearch] },
      {
        ...references,
        searchKeys: new Set([...references.searchKeys, `${moduleId}.unit-search-two`]),
      },
    ),
  ).toThrow(/group label\/icon\/order/u);

  const thirdSearch = {
    ...base,
    contributionKey: `${moduleId}.search.unit-three`,
    entrypoint: { ...entrypoint('search'), entrypointKey: `${moduleId}.search.tertiary` },
    presentation: {
      ...base.presentation,
      family: { ...base.presentation.family, order: 11 },
    },
    searchKey: `${moduleId}.unit-search-three`,
  };
  expect(() =>
    validateShellContributions(
      { ...conflict, search: [...conflict.search, thirdSearch] },
      {
        ...references,
        searchKeys: new Set([...references.searchKeys, `${moduleId}.unit-search-three`]),
      },
    ),
  ).toThrow(/family label\/icon\/order/u);

  const executable = presented();
  expect(() =>
    validateShellContributions(
      {
        ...executable,
        search: [
          {
            ...first(executable.search),
            presentation: { ...first(executable.search).presentation, render: 'items.map' },
          },
        ],
      },
      references,
    ),
  ).toThrow();

  const systemClaim = presented();
  expect(() =>
    validateShellContributions(
      {
        ...systemClaim,
        search: [
          {
            ...first(systemClaim.search),
            presentation: {
              ...first(systemClaim.search).presentation,
              kind: 'system',
              navigationPath: '/sprava/lide-a-role',
            },
          },
        ],
      },
      references,
    ),
  ).toThrow();
});

it('binds presentation scope and ownership to the actual declared search descriptor', () => {
  const decoded = validateShellContributions(presented(), references);
  expect(
    shellSearchPresentationBindingIssue(decoded, {
      ...presentationReferences,
      search: [{ ...first(presentationReferences.search), accessFiltering: 'tenant_scope' }],
    }),
  ).toMatch(/scope/u);
  expect(
    shellSearchPresentationBindingIssue(decoded, {
      ...presentationReferences,
      search: [{ ...first(presentationReferences.search), owningModuleId: 'billing.core' }],
    }),
  ).toMatch(/owner/u);
  expect(
    shellSearchPresentationBindingIssue(decoded, {
      ...presentationReferences,
      resourceTypeKeys: new Set(),
    }),
  ).toMatch(/resource type/u);
  expect(
    shellSearchPresentationBindingIssue(decoded, {
      ...presentationReferences,
      search: [],
    }),
  ).toMatch(/undeclared search descriptor/u);
});
