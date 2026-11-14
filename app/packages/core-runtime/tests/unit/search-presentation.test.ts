import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CoreSearchPresentationCatalogSchema,
  CoreSearchPresentationDeclarationSchema,
  CoreSearchPresentationDetailSchema,
  CoreSearchPresentationOpaqueIdSchema,
  CoreSystemSearchPresentationSchema,
  coreSearchPresentationBindingIssue,
  coreSystemSearchPresentationBindingIssue,
  interpretCoreSearchPresentation,
  interpretCoreSearchPresentationEntry,
  interpretCoreSystemSearchPresentation,
  isCoreSearchPresentationOpaqueId,
  resolveCoreSearchPresentationCatalog,
  resolveCoreSearchPresentationDetail,
} from '../../src/search/search-contract.ts';
import type {
  CoreSearchPresentationCatalog,
  CoreSearchPresentationEntry,
  CoreSearchPresentationIssue,
} from '../../src/search/search-contract.ts';

const fixtures = {
  family: {
    icon: 'icon-[mdi--shape-outline]',
    key: 'fixtureFamily',
    label: { cs: 'Rodina', en: 'Family' },
    order: 10,
  },
  group: {
    icon: 'icon-[mdi--shape]',
    key: 'fixtureGroup',
    label: { cs: 'Skupina', en: 'Group' },
    order: 20,
  },
  item: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  moduleId: 'fixture.owner',
  otherModuleId: 'fixture.other',
  pageKey: 'fixture.owner.page.items',
  resourceType: 'fixture.owner.item',
  revision: 'a'.repeat(64),
  searchKey: 'fixture.owner.search.items',
} as const;

const decodeDeclaration = <Value>(value: Value) =>
  Schema.decodeUnknownSync(CoreSearchPresentationDeclarationSchema, { onExcessProperty: 'error' })(value);

const pathDeclaration = () => ({
  agendaPageKeys: ['fixture.owner.page.item-archive'],
  family: fixtures.family,
  group: fixtures.group,
  record: {
    pageKey: fixtures.pageKey,
    selector: {
      idEncoding: 'native' as const,
      idFormat: 'uuid' as const,
      kind: 'path' as const,
      parameterName: 'itemId',
    },
  },
  refinement: { kind: 'matched_variant' as const, parameterName: 'variantId' },
  scope: 'company' as const,
});

const pathDeclarationWithoutRefinement = () => {
  const declaration = pathDeclaration();
  return {
    agendaPageKeys: declaration.agendaPageKeys,
    family: declaration.family,
    group: declaration.group,
    record: declaration.record,
    scope: declaration.scope,
  };
};

const agendaOnlyDeclaration = () => ({
  agendaPageKeys: ['fixture.owner.page.item-archive'],
  family: fixtures.family,
  group: fixtures.group,
  scope: 'company' as const,
});

const queryDeclaration = () => ({
  family: fixtures.family,
  group: fixtures.group,
  record: {
    pageKey: fixtures.pageKey,
    selector: {
      idEncoding: 'native' as const,
      idFormat: 'opaque' as const,
      kind: 'query' as const,
      parameterName: 'resourceId',
    },
  },
  scope: 'company' as const,
});

const entry = (overrides: Partial<CoreSearchPresentationEntry> = {}): CoreSearchPresentationEntry => ({
  ownerModuleId: fixtures.moduleId,
  presentation: pathDeclaration(),
  resourceType: fixtures.resourceType,
  searchKey: fixtures.searchKey,
  ...overrides,
});

const catalog = (entries: readonly CoreSearchPresentationEntry[] = [entry()]) => ({
  compositionRevision: fixtures.revision,
  entries,
  schemaVersion: '1' as const,
});

const binding = (overrides: Partial<Parameters<typeof coreSearchPresentationBindingIssue>[1]> = {}) => ({
  compositionRevision: fixtures.revision,
  ownerModuleId: fixtures.moduleId,
  resourceType: fixtures.resourceType,
  searchKey: fixtures.searchKey,
  ...overrides,
});

const issueOf = (result: Result.Result<unknown, CoreSearchPresentationIssue>): CoreSearchPresentationIssue => {
  if (Result.isSuccess(result)) {
    throw new Error('Expected a typed presentation failure');
  }
  return result.failure;
};

const resolvedCatalog = (): CoreSearchPresentationCatalog =>
  Result.getOrThrow(resolveCoreSearchPresentationCatalog(catalog()));

const opaqueSchemaAccepts = (value: string) =>
  Result.isSuccess(Schema.decodeUnknownResult(CoreSearchPresentationOpaqueIdSchema)(value));

it('round-trips bounded generic declarations through strict JSON without executable properties', () => {
  const declaration = pathDeclaration();
  expect(decodeDeclaration(declaration)).toEqual(declaration);
  const json = JSON.stringify(declaration);
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(CoreSearchPresentationDeclarationSchema))(json)).toEqual(
    declaration,
  );
  expect(json).not.toMatch(/function|handler|=>|require\(|import\s/u);
  expect(() => decodeDeclaration({ ...declaration, exec: () => null })).toThrow();
  expect(() =>
    decodeDeclaration({
      ...declaration,
      record: {
        pageKey: fixtures.pageKey,
        selector: { ...declaration.record.selector, expression: 'record.id' },
      },
    }),
  ).toThrow();
  expect(() => decodeDeclaration({ ...declaration, agendaPageKeys: [fixtures.pageKey, fixtures.pageKey] })).toThrow();
  expect(() => decodeDeclaration({ ...declaration, agendaPageKeys: [fixtures.pageKey] })).toThrow();
  expect(() =>
    decodeDeclaration({ ...declaration, refinement: { kind: 'matched_variant', parameterName: 'itemId' } }),
  ).toThrow();
  expect(() =>
    decodeDeclaration({ ...declaration, refinement: { kind: 'any_leaf', parameterName: 'leaf' } }),
  ).toThrow();
  expect(() =>
    decodeDeclaration({
      ...declaration,
      group: { ...fixtures.group, icon: 'icon-[mdi--shape]?role=admin' },
    }),
  ).toThrow();
  expect(() =>
    decodeDeclaration({
      ...declaration,
      family: { ...fixtures.family, order: 10_001 },
    }),
  ).toThrow();
  expect(() =>
    decodeDeclaration({
      ...declaration,
      record: {
        ...declaration.record,
        selector: { ...declaration.record.selector, parameterName: 'constructor' },
      },
    }),
  ).toThrow();
  expect(() =>
    decodeDeclaration({
      ...declaration,
      agendaPageKeys: Array.from({ length: 9 }, (_, index) => `fixture.owner.page.archive-${index}`),
    }),
  ).toThrow();
  expect(() => decodeDeclaration(pathDeclarationWithoutRefinement())).not.toThrow();
  expect(() => decodeDeclaration({ ...pathDeclarationWithoutRefinement(), scope: 'tenant' })).not.toThrow();
  expect(() =>
    decodeDeclaration({
      ...pathDeclarationWithoutRefinement(),
      record: {
        pageKey: fixtures.pageKey,
        selector: {
          idEncoding: 'selected_company_dot_prefix',
          idFormat: 'uuid',
          kind: 'path',
          parameterName: 'itemId',
        },
      },
      scope: 'tenant',
    }),
  ).toThrow();
  expect(() => decodeDeclaration({ ...pathDeclaration(), scope: 'tenant' })).toThrow();
});

it('resolves one bounded wire catalog and rejects duplicates, metadata conflicts, overflow and extras', () => {
  const resolved = resolvedCatalog();
  expect(resolved.schemaVersion).toBe('1');
  expect(resolved.entries).toHaveLength(1);
  expect(Object.isFrozen(resolved)).toBe(true);
  expect(coreSearchPresentationBindingIssue(resolved, binding())).toBeUndefined();
  expect(coreSearchPresentationBindingIssue(resolved, binding({ compositionRevision: 'b'.repeat(64) }))?.code).toBe(
    'binding_mismatch',
  );
  expect(coreSearchPresentationBindingIssue(resolved, binding({ ownerModuleId: fixtures.otherModuleId }))?.code).toBe(
    'binding_mismatch',
  );
  expect(coreSearchPresentationBindingIssue(resolved, binding({ resourceType: 'fixture.owner.other' }))?.code).toBe(
    'binding_mismatch',
  );
  expect(coreSearchPresentationBindingIssue(resolved, binding({ searchKey: 'fixture.owner.search.other' }))?.code).toBe(
    'binding_mismatch',
  );
  const detail = Result.getOrThrow(resolveCoreSearchPresentationDetail(resolved, binding()));
  expect(detail.entry).toEqual(entry());
  expect(detail.compositionRevision).toBe(fixtures.revision);
  expect(() =>
    Schema.decodeUnknownSync(CoreSearchPresentationDetailSchema, { onExcessProperty: 'error' })({
      ...detail,
      executable: 'record.id',
    }),
  ).toThrow();

  const duplicate = resolveCoreSearchPresentationCatalog(
    catalog([entry(), entry({ ownerModuleId: fixtures.otherModuleId })]),
  );
  expect(issueOf(duplicate).code).toBe('catalog_invalid');

  const conflictingGroup = resolveCoreSearchPresentationCatalog(
    catalog([
      entry(),
      entry({
        ownerModuleId: fixtures.otherModuleId,
        presentation: {
          ...pathDeclaration(),
          group: { ...fixtures.group, label: { cs: 'Jiná', en: 'Other' } },
        },
        searchKey: 'fixture.other.search.items',
      }),
    ]),
  );
  expect(issueOf(conflictingGroup).code).toBe('catalog_invalid');

  const conflictingFamily = resolveCoreSearchPresentationCatalog(
    catalog([
      entry(),
      entry({
        ownerModuleId: fixtures.otherModuleId,
        presentation: {
          ...pathDeclaration(),
          family: { ...fixtures.family, order: 11 },
        },
        searchKey: 'fixture.other.search.items',
      }),
    ]),
  );
  expect(issueOf(conflictingFamily).code).toBe('catalog_invalid');

  const overflowing = resolveCoreSearchPresentationCatalog(
    catalog(Array.from({ length: 65 }, (_, index) => entry({ searchKey: `fixture.owner.search.item-${index}` }))),
  );
  expect(issueOf(overflowing).code).toBe('catalog_invalid');

  const executable = resolveCoreSearchPresentationCatalog({
    ...catalog(),
    render: () => null,
  });
  expect(issueOf(executable).code).toBe('catalog_invalid');
  expect(
    Schema.is(CoreSearchPresentationCatalogSchema)(
      catalog([entry(), entry({ ownerModuleId: fixtures.otherModuleId })]),
    ),
  ).toBe(false);
});

it('interprets exact named path and query targets, variant refinement and unavailable outcomes', () => {
  const resolved = resolvedCatalog();
  const target = Result.getOrThrow(
    interpretCoreSearchPresentation(resolved, binding(), {
      matchedVariantId: 'variant-01',
      recordId: fixtures.item,
    }),
  );
  expect(target).toEqual({
    familyKey: 'fixtureFamily',
    groupKey: 'fixtureGroup',
    kind: 'record',
    pageKey: fixtures.pageKey,
    pathParameters: [{ name: 'itemId', value: fixtures.item }],
    queryParameters: [{ name: 'variantId', value: 'variant-01' }],
    selectorKind: 'path',
  });
  const withoutVariant = Result.getOrThrow(
    interpretCoreSearchPresentation(resolved, binding(), { recordId: fixtures.item }),
  );
  expect(withoutVariant.queryParameters).toEqual([]);

  const queryEntry = entry({ presentation: queryDeclaration() });
  const queryCatalog = Result.getOrThrow(resolveCoreSearchPresentationCatalog(catalog([queryEntry])));
  const queryTarget = Result.getOrThrow(
    interpretCoreSearchPresentation(queryCatalog, binding(), { recordId: 'item-01' }),
  );
  expect(queryTarget.pathParameters).toEqual([]);
  expect(queryTarget.queryParameters).toEqual([{ name: 'resourceId', value: 'item-01' }]);

  const agendaOnly = entry({ presentation: agendaOnlyDeclaration() });
  const noTarget = interpretCoreSearchPresentationEntry(agendaOnly, { recordId: fixtures.item });
  expect(issueOf(noTarget).code).toBe('no_record_target');
  const noRefinement = interpretCoreSearchPresentationEntry(
    entry({ presentation: pathDeclarationWithoutRefinement() }),
    { matchedVariantId: 'variant-01', recordId: fixtures.item },
  );
  expect(issueOf(noRefinement).code).toBe('unsupported_refinement');
  const opaqueVariant = 'item-6692/?#ě';
  const opaqueTarget = Result.getOrThrow(
    interpretCoreSearchPresentationEntry(entry(), {
      matchedVariantId: opaqueVariant,
      recordId: fixtures.item,
    }),
  );
  expect(opaqueTarget.pathParameters).toEqual([{ name: 'itemId', value: fixtures.item }]);
  expect(opaqueTarget.queryParameters).toEqual([{ name: 'variantId', value: opaqueVariant }]);
  const unicodeQueryTarget = Result.getOrThrow(
    interpretCoreSearchPresentationEntry(queryEntry, { recordId: opaqueVariant }),
  );
  expect(unicodeQueryTarget.queryParameters).toEqual([{ name: 'resourceId', value: opaqueVariant }]);
  const badVariant = interpretCoreSearchPresentationEntry(entry(), {
    matchedVariantId: 'x'.repeat(301),
    recordId: fixtures.item,
  });
  expect(issueOf(badVariant).code).toBe('invalid_refinement');
  const badUuid = interpretCoreSearchPresentationEntry(entry(), { recordId: 'not-a-uuid' });
  expect(issueOf(badUuid).code).toBe('invalid_record_id');
  expect(opaqueSchemaAccepts(opaqueVariant)).toBe(true);
  expect(opaqueSchemaAccepts('bad%2Fvalue')).toBe(true);
  expect(opaqueSchemaAccepts('')).toBe(false);
  expect(opaqueSchemaAccepts('x'.repeat(301))).toBe(false);
  expect(isCoreSearchPresentationOpaqueId(opaqueVariant)).toBe(true);
  expect(isCoreSearchPresentationOpaqueId('x'.repeat(301))).toBe(false);
});

it('strips only one verified selected-company UUID prefix and never guesses another', () => {
  const company = '11111111-1111-4111-8111-111111111111';
  const prefixed = entry({
    presentation: {
      ...pathDeclarationWithoutRefinement(),
      record: {
        pageKey: fixtures.pageKey,
        selector: {
          idEncoding: 'selected_company_dot_prefix',
          idFormat: 'uuid',
          kind: 'path',
          parameterName: 'itemId',
        },
      },
    },
  });
  const target = Result.getOrThrow(
    interpretCoreSearchPresentationEntry(prefixed, {
      recordId: `${company}.${fixtures.item}`,
      selectedLegalEntityId: company,
    }),
  );
  expect(target.pathParameters).toEqual([{ name: 'itemId', value: fixtures.item }]);
  expect(
    issueOf(interpretCoreSearchPresentationEntry(prefixed, { recordId: `${company}.${fixtures.item}` })).code,
  ).toBe('missing_selected_company');
  expect(
    issueOf(
      interpretCoreSearchPresentationEntry(prefixed, {
        recordId: `22222222-2222-4222-8222-222222222222.${fixtures.item}`,
        selectedLegalEntityId: company,
      }),
    ).code,
  ).toBe('selected_company_prefix_mismatch');
  expect(
    issueOf(
      interpretCoreSearchPresentationEntry(prefixed, {
        recordId: `${company}.`,
        selectedLegalEntityId: company,
      }),
    ).code,
  ).toBe('selected_company_prefix_mismatch');
  expect(
    issueOf(
      interpretCoreSearchPresentationEntry(prefixed, {
        recordId: `${company}.${fixtures.item}`,
        selectedLegalEntityId: 'not-a-uuid',
      }),
    ).code,
  ).toBe('missing_selected_company');
});

it('keeps the system branch separate, native and bound to the actual authority', () => {
  const authority = {
    entrypointKey: 'fixture.system.entrypoint',
    navigationPath: '/fixture/native',
    ownerModuleId: 'fixture.system',
    resourceType: 'fixture.system.record',
    searchKey: 'fixture.system.search.records',
  } as const;
  const system = {
    ...authority,
    family: fixtures.family,
    group: fixtures.group,
    idEncoding: 'native',
    idFormat: 'opaque',
    kind: 'system',
    queryParameterName: 'person',
    schemaVersion: '1',
    scope: 'company',
  } as const;
  const decoded = Schema.decodeUnknownSync(CoreSystemSearchPresentationSchema, { onExcessProperty: 'error' })(system);
  expect(coreSystemSearchPresentationBindingIssue(decoded, authority)).toBeUndefined();
  expect(
    coreSystemSearchPresentationBindingIssue(decoded, { ...authority, navigationPath: '/fixture/other' })?.code,
  ).toBe('system_binding_mismatch');
  expect(
    coreSystemSearchPresentationBindingIssue(decoded, { ...authority, entrypointKey: 'fixture.system.other' })?.code,
  ).toBe('system_binding_mismatch');
  expect(
    coreSystemSearchPresentationBindingIssue(decoded, { ...authority, resourceType: 'fixture.system.other' })?.code,
  ).toBe('system_binding_mismatch');
  expect(
    coreSystemSearchPresentationBindingIssue(decoded, { ...authority, searchKey: 'fixture.system.other' })?.code,
  ).toBe('system_binding_mismatch');
  const qualifiedPersonId = '11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222';
  const target = Result.getOrThrow(interpretCoreSystemSearchPresentation(decoded, { recordId: qualifiedPersonId }));
  expect(target).toEqual({
    kind: 'system_record',
    navigationPath: '/fixture/native',
    queryParameters: [{ name: 'person', value: qualifiedPersonId }],
  });
  expect(issueOf(interpretCoreSystemSearchPresentation(decoded, { recordId: 'x'.repeat(301) })).code).toBe(
    'invalid_record_id',
  );
  expect(() =>
    Schema.decodeUnknownSync(CoreSystemSearchPresentationSchema, { onExcessProperty: 'error' })({
      ...system,
      pageKey: fixtures.pageKey,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(CoreSystemSearchPresentationSchema, { onExcessProperty: 'error' })({
      ...system,
      scope: 'tenant',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(CoreSystemSearchPresentationSchema, { onExcessProperty: 'error' })({
      ...system,
      idEncoding: 'selected_company_dot_prefix',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(CoreSystemSearchPresentationSchema, { onExcessProperty: 'error' })({
      ...system,
      navigationPath: '/fixture/:id',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(CoreSystemSearchPresentationSchema, { onExcessProperty: 'error' })({
      ...system,
      navigationPath: '/cs/fixture/native',
    }),
  ).toThrow();
  expect(() =>
    decodeDeclaration({
      ...pathDeclaration(),
      kind: 'system',
      navigationPath: '/fixture/native',
    }),
  ).toThrow();
});
