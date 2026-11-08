import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  corePeopleSystemSearchPresentation,
  corePeopleSystemSearchProvider,
} from '../../src/people/system-search-provider.ts';
import {
  CoreSearchPresentationDeclarationSchema,
  CoreSystemSearchPresentationSchema,
  coreSystemSearchPresentationBindingIssue,
  interpretCoreSystemSearchPresentation,
} from '../../src/search/search-contract.ts';

const systemAuthority = () => ({
  entrypointKey: corePeopleSystemSearchProvider.entrypoint.entrypointKey,
  navigationPath: corePeopleSystemSearchProvider.navigationPath,
  ownerModuleId: corePeopleSystemSearchProvider.descriptor.owningModuleId,
  resourceType: corePeopleSystemSearchProvider.resource.key,
  searchKey: corePeopleSystemSearchProvider.descriptor.key,
});

it('publishes one bounded Core system presentation from the existing native provider', () => {
  const decoded = Schema.decodeUnknownSync(CoreSystemSearchPresentationSchema, { onExcessProperty: 'error' })(
    corePeopleSystemSearchPresentation,
  );
  expect(decoded).toEqual(corePeopleSystemSearchPresentation);
  expect(decoded.kind).toBe('system');
  expect(decoded.navigationPath).toBe('/sprava/lide-a-role');
  expect(decoded.navigationPath).toBe(corePeopleSystemSearchProvider.navigationPath);
  expect(decoded.entrypointKey).toBe(corePeopleSystemSearchProvider.entrypoint.entrypointKey);
  expect(decoded.ownerModuleId).toBe(corePeopleSystemSearchProvider.descriptor.owningModuleId);
  expect(decoded.resourceType).toBe(corePeopleSystemSearchProvider.resource.key);
  expect(decoded.searchKey).toBe(corePeopleSystemSearchProvider.descriptor.key);
  expect(decoded.queryParameterName).toBe('person');
  expect(decoded.idEncoding).toBe('native');
  expect(decoded.idFormat).toBe('opaque');
  expect(decoded.scope).toBe('company');
  expect('pageKey' in decoded).toBe(false);
  expect(corePeopleSystemSearchProvider.legalEntityScope).toBe('required');
  expect(Object.hasOwn(corePeopleSystemSearchProvider, 'pageKey')).toBe(false);
  expect(coreSystemSearchPresentationBindingIssue(decoded, systemAuthority())).toBeUndefined();
  expect(
    coreSystemSearchPresentationBindingIssue(decoded, {
      ...systemAuthority(),
      navigationPath: '/sprava/jiny',
    })?.code,
  ).toBe('system_binding_mismatch');
  expect(
    coreSystemSearchPresentationBindingIssue(decoded, {
      ...systemAuthority(),
      searchKey: 'core.identity.search.other',
    })?.code,
  ).toBe('system_binding_mismatch');
});

it('interprets the full company-qualified person ID natively without inventing a page key', () => {
  const decoded = Schema.decodeUnknownSync(CoreSystemSearchPresentationSchema)(corePeopleSystemSearchPresentation);
  const qualifiedPersonId = '11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222';
  const target = Result.getOrThrow(interpretCoreSystemSearchPresentation(decoded, { recordId: qualifiedPersonId }));
  expect(target).toEqual({
    kind: 'system_record',
    navigationPath: '/sprava/lide-a-role',
    queryParameters: [{ name: 'person', value: qualifiedPersonId }],
  });
  const invalid = interpretCoreSystemSearchPresentation(decoded, { recordId: 'x'.repeat(301) });
  expect(Result.isFailure(invalid)).toBe(true);
  if (Result.isFailure(invalid)) {
    expect(invalid.failure.code).toBe('invalid_record_id');
  }
});

it('never lets a business presentation claim the separate Core-native branch', () => {
  expect(() =>
    Schema.decodeUnknownSync(CoreSearchPresentationDeclarationSchema, { onExcessProperty: 'error' })({
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
      kind: 'system',
      navigationPath: '/sprava/lide-a-role',
      scope: 'company',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(CoreSearchPresentationDeclarationSchema, { onExcessProperty: 'error' })({
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
      scope: 'company',
    }),
  ).not.toThrow();
});
