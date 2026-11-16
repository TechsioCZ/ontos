import type { CoreSearchPresentationEntry, CoreSystemSearchPresentation } from '@app/core-runtime/search-contract';
import { Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../shared/browser-api.ts';
import type { ShellSearchResult } from '../../shared/browser-api.ts';
import {
  ownerRecordTarget,
  recordAgendaPaths,
  shellSearchFamilies,
  shellSearchFamiliesInOrder,
  shellSearchGroupOf,
  shellSearchLinkTarget,
  shellSearchPresentationIndex,
  shellSearchRecordTarget,
  shellSearchResourceTypesForGroups,
  shellSearchResultTarget,
} from '../../src/routes/shell-search-resource-types.ts';
import type {
  ShellSearchPresentationIndex,
  ShellSearchPresentationPage,
} from '../../src/routes/shell-search-resource-types.ts';
import { groupShellSearchResults, groupShellSearchSuggestions } from '../../src/routes/shell-search-suggestions.ts';

const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const selectedLegalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');
const otherCompanyId = '00000000-0000-4000-8000-000000000299';
const compositionRevision = 'a'.repeat(64);
let sequence = 0;

const label = (cs: string, en: string) => ({ cs, en });
const metadata = (key: string, order: number, cs: string, en: string) => ({
  icon: 'icon-[mdi--file-outline]' as const,
  key,
  label: label(cs, en),
  order,
});

interface EntryOptions {
  readonly agendaPageKeys?: readonly string[];
  readonly family?: { readonly key: string; readonly order: number };
  readonly group?: { readonly key: string; readonly order: number };
  readonly ownerModuleId?: string;
  readonly record?: {
    readonly idEncoding?: 'native' | 'selected_company_dot_prefix';
    readonly idFormat?: 'opaque' | 'uuid';
    readonly pageKey: string;
    readonly parameterName: string;
    readonly selectorKind?: 'path' | 'query';
  };
  readonly refinement?: { readonly parameterName: string };
  readonly resourceType: string;
  readonly scope?: 'company' | 'tenant';
  readonly searchKey?: string;
}

interface MutablePresentation {
  agendaPageKeys?: readonly string[];
  family: ReturnType<typeof metadata>;
  group: ReturnType<typeof metadata>;
  record?: {
    pageKey: string;
    selector: {
      idEncoding: 'native' | 'selected_company_dot_prefix';
      idFormat: 'opaque' | 'uuid';
      kind: 'path' | 'query';
      parameterName: string;
    };
  };
  refinement?: { kind: 'matched_variant'; parameterName: string };
  scope: 'company' | 'tenant';
}

const entry = (options: EntryOptions): CoreSearchPresentationEntry => {
  const family = options.family ?? { key: 'companies', order: 10 };
  const group = options.group ?? { key: 'counterparty', order: 10 };
  const presentation: MutablePresentation = {
    family: metadata(family.key, family.order, 'Firmy', 'Companies'),
    group: metadata(group.key, group.order, 'Protiúčty', 'Counterparties'),
    scope: options.scope ?? 'company',
  };
  if (options.record !== undefined) {
    presentation.record = {
      pageKey: options.record.pageKey,
      selector: {
        idEncoding: options.record.idEncoding ?? 'native',
        idFormat: options.record.idFormat ?? 'opaque',
        kind: options.record.selectorKind ?? 'query',
        parameterName: options.record.parameterName,
      },
    };
  }
  if (options.refinement !== undefined) {
    presentation.refinement = { kind: 'matched_variant', parameterName: options.refinement.parameterName };
  }
  if (options.agendaPageKeys !== undefined) {
    presentation.agendaPageKeys = [...options.agendaPageKeys];
  }
  return {
    ownerModuleId: options.ownerModuleId ?? 'party.registry',
    presentation,
    resourceType: options.resourceType,
    searchKey: options.searchKey ?? `${options.ownerModuleId ?? 'party.registry'}.search.record`,
  };
};

const page = (ownerModuleId: string, pageKey: string, routePath: string): ShellSearchPresentationPage => ({
  ownerModuleId: Schema.decodeUnknownSync(ModuleIdSchema)(ownerModuleId),
  pageKey,
  routePath,
});

const indexOf = (
  entries: readonly CoreSearchPresentationEntry[],
  pages: readonly ShellSearchPresentationPage[] = [],
  system?: CoreSystemSearchPresentation,
): ShellSearchPresentationIndex => {
  const business = { compositionRevision, entries: [...entries], schemaVersion: '1' as const };
  const inventory = system === undefined ? { business, pages: [...pages] } : { business, pages: [...pages], system };
  const index = shellSearchPresentationIndex(inventory, compositionRevision);
  if (index === undefined) {
    throw new Error('test inventory must be valid and current');
  }
  return index;
};

const resourceHit = (
  moduleId: string,
  resourceType: string,
  title: string,
  resourceId?: string,
  options: { readonly matchedVariant?: { id: string; name?: string } } = {},
): Extract<ShellSearchResult, { readonly kind: 'resource' }> => {
  sequence += 1;
  const hit: Extract<ShellSearchResult, { readonly kind: 'resource' }> = {
    kind: 'resource',
    ref: {
      moduleId: Schema.decodeUnknownSync(ModuleIdSchema)(moduleId),
      resourceId: Schema.decodeUnknownSync(ResourceIdSchema)(
        resourceId ?? `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      ),
      resourceType,
      tenantId,
    },
    selectedLegalEntityId,
    title,
  };
  return options.matchedVariant === undefined ? hit : { ...hit, matchedVariant: options.matchedVariant };
};

const partyRef = {
  moduleId: Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
  resourceId: Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000901'),
  resourceType: 'party.registry.party',
  tenantId,
};

test('an exact same-owner path page opens with the captured named parameter and opaque value', () => {
  const counterpartyId = Schema.decodeUnknownSync(ResourceIdSchema)('ea2200ab-4308-491e-8e33-ca3871a8fa55');
  const hit = {
    currentRoles: ['CUSTOMER' as const],
    kind: 'counterparty' as const,
    legalEntity: { legalEntityId: selectedLegalEntityId, tenantId },
    party: { archived: false, matchedViaAlias: true, ref: partyRef, title: 'Eva Bílá' },
    ref: { ...partyRef, resourceId: counterpartyId, resourceType: 'party.registry.counterparty' },
    title: 'Eva Bílá',
  } satisfies ShellSearchResult;
  const index = indexOf(
    [
      entry({
        record: { idFormat: 'uuid', pageKey: 'customers', parameterName: 'id', selectorKind: 'path' },
        resourceType: 'party.registry.counterparty',
      }),
    ],
    [page('party.registry', 'customers', '/prodej/zakaznici/:id')],
  );
  expect(shellSearchResultTarget(hit, index)).toEqual({
    params: { id: counterpartyId },
    to: '/prodej/zakaznici/$id',
  });
  expect(shellSearchResultTarget({ ...hit, party: { ...hit.party, archived: true } }, index)).toEqual(
    shellSearchResultTarget(hit, index),
  );
});

test('a query page keeps the owner value raw in the search record; only the redirect adapter encodes it', () => {
  const opaqueId = 'item-6692/?#ě';
  const hit = resourceHit(
    'demo.merchandise',
    'demo.merchandise.product',
    'Adaptéry',
    `${selectedLegalEntityId}.${opaqueId}`,
    { matchedVariant: { id: 'variant-ě/1', name: 'Adaptér 18 mm' } },
  );
  const index = indexOf(
    [
      entry({
        ownerModuleId: 'demo.merchandise',
        record: {
          idEncoding: 'selected_company_dot_prefix',
          idFormat: 'opaque',
          pageKey: 'products',
          parameterName: 'resourceId',
        },
        refinement: { parameterName: 'variantId' },
        resourceType: 'demo.merchandise.product',
      }),
    ],
    [page('demo.merchandise', 'products', '/provoz/produkty')],
  );
  expect(shellSearchResultTarget(hit, index)).toEqual({
    search: { resourceId: opaqueId, variantId: 'variant-ě/1' },
    to: '/provoz/produkty',
  });
  // The model never pre-encodes: a browser URL adapter owns the single encoding step.
  expect(new URLSearchParams({ resourceId: opaqueId }).get('resourceId')).toBe(opaqueId);
});

test.each([
  ['another company', `${otherCompanyId}.item-1`, selectedLegalEntityId],
  ['no company on the result', `${selectedLegalEntityId}.item-1`, undefined],
  ['an unqualified ID', 'item-1', selectedLegalEntityId],
  ['a prefix without the separator', `${selectedLegalEntityId}item-1`, selectedLegalEntityId],
] as const)('a company-qualified record with %s never opens an owner page', (_case, resourceId, company) => {
  const hit = resourceHit('demo.merchandise', 'demo.merchandise.product', 'Produkt', resourceId);
  const index = indexOf(
    [
      entry({
        ownerModuleId: 'demo.merchandise',
        record: {
          idEncoding: 'selected_company_dot_prefix',
          pageKey: 'products',
          parameterName: 'resourceId',
        },
        resourceType: 'demo.merchandise.product',
      }),
    ],
    [page('demo.merchandise', 'products', '/provoz/produkty')],
  );
  expect(shellSearchRecordTarget(index, hit.ref, company)).toBeUndefined();
  const target = shellSearchLinkTarget(index, hit.ref, hit.title, company);
  expect(target).toMatchObject({ to: '/resources/$moduleId/$resourceType/$resourceId' });
  expect('state' in target ? target.state({}) : undefined).toEqual({ searchHitTitle: 'Produkt' });
});

test('a declared variant refines only its own product destination; an undeclared variant never becomes a parameter', () => {
  const productId = `${selectedLegalEntityId}.00000000-0000-4000-8000-000000000401`;
  const declared = entry({
    ownerModuleId: 'demo.merchandise',
    record: { idEncoding: 'selected_company_dot_prefix', pageKey: 'products', parameterName: 'resourceId' },
    refinement: { parameterName: 'variantId' },
    resourceType: 'demo.merchandise.product',
  });
  const pages = [page('demo.merchandise', 'products', '/provoz/produkty')];
  const withVariant = resourceHit('demo.merchandise', 'demo.merchandise.product', 'Adaptér', productId, {
    matchedVariant: { id: 'variant-1' },
  });
  expect(shellSearchResultTarget(withVariant, indexOf([declared], pages))).toEqual({
    search: { resourceId: productId.slice(selectedLegalEntityId.length + 1), variantId: 'variant-1' },
    to: '/provoz/produkty',
  });
  // The same admitted product provider without a declared refinement keeps the parent destination.
  expect(
    shellSearchResultTarget(
      withVariant,
      indexOf(
        [
          entry({
            ownerModuleId: 'demo.merchandise',
            record: {
              idEncoding: 'selected_company_dot_prefix',
              pageKey: 'products',
              parameterName: 'resourceId',
            },
            resourceType: 'demo.merchandise.product',
          }),
        ],
        pages,
      ),
    ),
  ).toEqual({
    search: { resourceId: productId.slice(selectedLegalEntityId.length + 1) },
    to: '/provoz/produkty',
  });
  // A 301-character refinement is not a bounded opaque ID and never opens a destination.
  expect(
    shellSearchResultTarget(
      resourceHit('demo.merchandise', 'demo.merchandise.product', 'Adaptér', productId, {
        matchedVariant: { id: 'x'.repeat(301) },
      }),
      indexOf([declared], pages),
    ),
  ).toMatchObject({ to: '/resources/$moduleId/$resourceType/$resourceId' });
});

test('an ambiguous owner binding, a missing page or a foreign page never becomes an owner destination', () => {
  const hit = resourceHit('party.registry', 'party.registry.party', 'Eva');
  const pages = [page('party.registry', 'parties', '/prodej/strany/:id')];
  const ambiguous = indexOf(
    [
      entry({
        record: { pageKey: 'parties', parameterName: 'id', selectorKind: 'path' },
        resourceType: 'party.registry.party',
      }),
      entry({
        record: { pageKey: 'parties', parameterName: 'id', selectorKind: 'path' },
        resourceType: 'party.registry.party',
        searchKey: 'party.registry.search.other',
      }),
    ],
    pages,
  );
  expect(shellSearchResultTarget(hit, ambiguous)).toMatchObject({
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
  const missingPage = indexOf(
    [
      entry({
        record: { pageKey: 'parties', parameterName: 'id', selectorKind: 'path' },
        resourceType: 'party.registry.party',
      }),
    ],
    [],
  );
  expect(shellSearchResultTarget(hit, missingPage)).toMatchObject({
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
  const foreignPage = indexOf(
    [
      entry({
        record: { pageKey: 'parties', parameterName: 'id', selectorKind: 'path' },
        resourceType: 'party.registry.party',
      }),
    ],
    [page('demo.crm', 'parties', '/prodej/strany/:id')],
  );
  expect(shellSearchResultTarget(hit, foreignPage)).toMatchObject({
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
  expect(ownerRecordTarget(foreignPage, hit.ref, selectedLegalEntityId)).toBeUndefined();
});

test('a different captured revision is not an inventory: no owner target, agendas or families', () => {
  const hit = resourceHit('party.registry', 'party.registry.party', 'Eva');
  const stale = shellSearchPresentationIndex(
    {
      business: {
        compositionRevision: 'b'.repeat(64),
        entries: [entry({ record: { pageKey: 'parties', parameterName: 'id' }, resourceType: 'party.registry.party' })],
        schemaVersion: '1',
      },
      pages: [page('party.registry', 'parties', '/prodej/strany')],
    },
    compositionRevision,
  );
  expect(stale).toBeUndefined();
  expect(recordAgendaPaths(stale, hit.ref)).toBeUndefined();
  expect(shellSearchFamilies(stale)).toEqual([]);
  expect(shellSearchResultTarget(hit, stale)).toMatchObject({
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
});

test('the finite Core-system branch keeps the native navigation path and the full qualified ID', () => {
  const qualifiedId = `${selectedLegalEntityId}.00000000-0000-4000-8000-000000000901`;
  const system: CoreSystemSearchPresentation = {
    entrypointKey: 'core.identity.system-search',
    family: metadata('people', 20, 'Lidé', 'People'),
    group: metadata('person', 20, 'Osoby', 'People'),
    idEncoding: 'native',
    idFormat: 'opaque',
    kind: 'system',
    navigationPath: '/sprava/lide-a-role',
    ownerModuleId: 'core.identity',
    queryParameterName: 'person',
    resourceType: 'core.identity.person',
    schemaVersion: '1',
    scope: 'company',
    searchKey: 'core.identity.search.people',
  };
  const index = indexOf([], [], system);
  const hit = resourceHit('core.identity', 'core.identity.person', 'Jana Nováková', qualifiedId);
  expect(shellSearchResultTarget(hit, index)).toEqual({
    search: { person: qualifiedId },
    to: '/sprava/lide-a-role',
  });
  expect(recordAgendaPaths(index, hit.ref)).toBeUndefined();
  expect(shellSearchGroupOf(hit, index)).toMatchObject({ key: 'person', label: { en: 'People' } });

  // A business contract must never also claim the exact same Core-native ref.
  const both = indexOf(
    [
      entry({
        ownerModuleId: 'core.identity',
        record: { pageKey: 'people', parameterName: 'person' },
        resourceType: 'core.identity.person',
      }),
    ],
    [page('core.identity', 'people', '/sprava/lide-a-role')],
    system,
  );
  expect(shellSearchResultTarget(hit, both)).toMatchObject({
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
});

test('declared agenda pages resolve only inside the same owner; undeclared or unresolved agendas stay empty', () => {
  const hit = resourceHit('work.tasks', 'work.tasks.task', 'Úkol');
  const declared = indexOf(
    [
      entry({
        agendaPageKeys: ['tasks'],
        ownerModuleId: 'work.tasks',
        resourceType: 'work.tasks.task',
      }),
    ],
    [page('work.tasks', 'tasks', '/ukoly')],
  );
  expect(recordAgendaPaths(declared, hit.ref)).toEqual(['/ukoly']);
  const missing = indexOf(
    [entry({ agendaPageKeys: ['tasks'], ownerModuleId: 'work.tasks', resourceType: 'work.tasks.task' })],
    [page('demo.crm', 'tasks', '/ukoly')],
  );
  expect(recordAgendaPaths(missing, hit.ref)).toEqual([]);
  const undeclared = indexOf([entry({ ownerModuleId: 'work.tasks', resourceType: 'work.tasks.task' })]);
  expect(recordAgendaPaths(undeclared, hit.ref)).toBeUndefined();
});

test('families, groups and exact resource types come from the validated inventory in declared order', () => {
  const index = indexOf([
    entry({
      family: { key: 'finance', order: 30 },
      group: { key: 'invoice', order: 30 },
      ownerModuleId: 'finance.billing',
      resourceType: 'finance.billing.invoice',
    }),
    entry({
      family: { key: 'companies', order: 10 },
      group: { key: 'counterparty', order: 20 },
      resourceType: 'party.registry.counterparty',
    }),
    entry({
      family: { key: 'companies', order: 10 },
      group: { key: 'client', order: 10 },
      ownerModuleId: 'demo.crm',
      resourceType: 'demo.crm.client',
    }),
  ]);
  const families = shellSearchFamilies(index);
  expect(families.map(({ key }) => key)).toEqual(['companies', 'finance']);
  expect(families[0]?.groups.map(({ key }) => key)).toEqual(['client', 'counterparty']);
  expect(families[0]?.resourceTypes).toEqual(['demo.crm.client', 'party.registry.counterparty']);
  expect(shellSearchFamiliesInOrder(['finance', 'companies', 'unknown'], families)).toEqual(['companies', 'finance']);
  expect(shellSearchResourceTypesForGroups(index, ['counterparty'])).toEqual(['party.registry.counterparty']);
  expect(shellSearchResourceTypesForGroups(index, ['unknown'])).toEqual([]);
  expect(shellSearchResourceTypesForGroups(undefined, ['counterparty'])).toEqual([]);
});

test('a genuinely unpresented hit stays in the generic group after every declared group, in owner order', () => {
  const results = [
    resourceHit('inventory.stock', 'inventory.stock.item', 'Sklad'),
    resourceHit('work.tasks', 'work.tasks.task', 'Zavolat'),
    resourceHit('party.registry', 'party.registry.counterparty', 'Odběratel'),
    resourceHit('work.tasks', 'work.tasks.task', 'Revize'),
  ];
  const index = indexOf([
    entry({
      family: { key: 'work', order: 20 },
      group: { key: 'task', order: 20 },
      ownerModuleId: 'work.tasks',
      resourceType: 'work.tasks.task',
    }),
    entry({
      group: { key: 'counterparty', order: 10 },
      resourceType: 'party.registry.counterparty',
    }),
  ]);
  const groups = groupShellSearchResults(results, index);
  expect(groups.map(({ presentation }) => presentation.key)).toEqual(['counterparty', 'task', 'resource']);
  expect(groups.find(({ presentation }) => presentation.key === 'task')?.items.map(({ title }) => title)).toEqual([
    'Zavolat',
    'Revize',
  ]);
  expect(groups.at(-1)?.presentation.label).toBeUndefined();
  const suggestions = groupShellSearchSuggestions(results, index, 1);
  const tasks = suggestions.find(({ presentation }) => presentation.key === 'task');
  expect(tasks?.total).toBe(2);
  expect(tasks?.suggestions.map(({ title }) => title)).toEqual(['Zavolat']);
});
