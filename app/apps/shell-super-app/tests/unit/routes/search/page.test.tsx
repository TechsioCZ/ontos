import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { afterEach, beforeEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import type { ComponentProps, ReactNode } from 'react';

import {
  AppIdSchema,
  GroupKeySchema,
  LegalEntityIdSchema,
  ModuleIdSchema,
  PrincipalIdSchema,
  ResourceIdSchema,
  TenantIdSchema,
} from '../../../../shared/api.ts';
import type { HomePageModel } from '../../../../src/routes/[lang]/page.data.ts';
import type { SearchPageModel } from '../../../../src/routes/[lang]/search/page.data.ts';
import SearchPage from '../../../../src/routes/[lang]/search/page.tsx';
import { ultramodernLocalisedUrls } from '../../../../src/routes/ultramodern-route-metadata.ts';

type LocalizedLinkDoubleProps = Omit<ComponentProps<'a'>, 'href'> & {
  readonly children?: ReactNode;
  readonly href?: string | undefined;
  readonly params?: Readonly<Record<string, string>>;
  readonly to: string;
};

const {
  languageState,
  localizedLinkCalls,
  navigateMock,
  runBrowserEffectMock,
  signOutMock,
  switchLegalEntityMock,
  switchTenantMock,
  useLoaderDataMock,
} = rstest.hoisted(() => {
  const recordedLinkCalls: {
    href: string | undefined;
    params: Readonly<Record<string, string>> | undefined;
    to: string;
  }[] = [];
  return {
    languageState: { current: 'en' },
    localizedLinkCalls: recordedLinkCalls,
    navigateMock: rstest.fn(async () => {}),
    runBrowserEffectMock: rstest.fn(),
    signOutMock: rstest.fn(),
    switchLegalEntityMock: rstest.fn(),
    switchTenantMock: rstest.fn(),
    useLoaderDataMock: rstest.fn(),
  };
});

const localisedUrlPatterns = new Map<string, Readonly<Record<string, string>>>(
  Object.entries(ultramodernLocalisedUrls).map(
    ([canonicalPattern, localisedPatterns]): readonly [
      string,
      Readonly<Record<string, string>>,
    ] => [canonicalPattern, { cs: localisedPatterns.cs, en: localisedPatterns.en }],
  ),
);

/**
 * Resolves the destination the framework link would produce, using the
 * application's own canonical-to-localised route map instead of a hand-written
 * expectation, so the page is proven to hand over a language-agnostic target.
 */
const resolveLocalizedHref = (
  to: string,
  params: Readonly<Record<string, string>> | undefined,
  language: string,
): string => {
  const canonicalPattern = to.replaceAll('$', ':');
  const localisedPattern =
    localisedUrlPatterns.get(canonicalPattern)?.[language] ?? canonicalPattern;
  const segments = localisedPattern
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(':') ? encodeURIComponent(params?.[segment.slice(1)] ?? '') : segment,
    );
  return `/${[language, ...segments].join('/')}`;
};

const translations = new Map(
  Object.entries({
    'shell.auth.identity.title': 'Authenticated identity',
    'shell.auth.logout.action': 'Logout',
    'shell.auth.logout.failed': 'Logout failed',
    'shell.dashboard.account.label': 'Account menu',
    'shell.dashboard.brand': 'OntOS',
    'shell.dashboard.header.label': 'Dashboard header',
    'shell.dashboard.legalEntity.accessibleLabel': 'Current legal entity',
    'shell.dashboard.navigation.home': 'Home',
    'shell.dashboard.navigation.label': 'Dashboard navigation',
    'shell.dashboard.sidebar.label': 'Dashboard sidebar',
    'shell.dashboard.tenant.accessibleLabel': 'Current tenant',
    'shell.dashboard.unavailable': 'Dashboard unavailable',
    'shell.modules.state.readOnly': 'Read only',
    'shell.search.empty': 'No results',
    'shell.search.label': 'Search this legal entity',
    'shell.search.selection_required': 'Select a legal entity first',
    'shell.search.submit': 'Search',
    'shell.search.title': 'Search',
    'shell.search.unavailable': 'Search unavailable',
  }),
);

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  Link: ({ children, href, params, to, ...props }: LocalizedLinkDoubleProps) => {
    localizedLinkCalls.push({ href, params, to });
    return (
      <a href={resolveLocalizedHref(to, params, languageState.current)} {...props}>
        {children}
      </a>
    );
  },
  useLocalizedLocation: () => ({
    alternates: { cs: '/cs/hledat', en: '/en/search' },
  }),
  useModernI18n: () => ({
    language: languageState.current,
    t: (key: string) => translations.get(key) ?? key,
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useLoaderData: useLoaderDataMock,
  useNavigate: () => navigateMock,
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  signOut: signOutMock,
  switchLegalEntity: switchLegalEntityMock,
  switchTenant: switchTenantMock,
}));

rstest.mock('../../../../src/runtime/browser-effect-runtime.ts', () => ({
  runBrowserEffect: runBrowserEffectMock,
}));

const principalId = Schema.decodeUnknownSync(PrincipalIdSchema)(
  '00000000-0000-4000-8000-000000000001',
);
const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const legalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)(
  '00000000-0000-4000-8000-000000000201',
);
const inventoryAppId = Schema.decodeUnknownSync(AppIdSchema)('inventory-app');
const navigationGroupKey = Schema.decodeUnknownSync(GroupKeySchema)('shell.navigation.modules');
const inventoryModuleId = Schema.decodeUnknownSync(ModuleIdSchema)('inventory.stock');
const plainResourceId = Schema.decodeUnknownSync(ResourceIdSchema)('unit-1');
const awkwardResourceId = Schema.decodeUnknownSync(ResourceIdSchema)('unit #1/2');

const authenticatedShell = (): HomePageModel => ({
  contextState: 'authenticated',
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    principalId,
    tenantId,
  },
  legalEntities: {
    items: [{ legalEntityId, legalName: 'Alpha company' }],
    state: 'available',
  },
  navigation: {
    items: [
      {
        appId: inventoryAppId,
        enabled: true,
        groupKey: navigationGroupKey,
        href: '/modules/inventory.stock',
        label: 'Inventory',
        moduleId: inventoryModuleId,
        order: 10,
        state: 'read_only',
        unavailable: false,
        writable: false,
      },
    ],
    state: 'available',
    unavailableDeployments: [],
  },
  selectedLegalEntityId: legalEntityId,
  state: 'authenticated',
  tenants: {
    items: [{ name: 'Alpha tenant', tenantId }],
    state: 'available',
  },
});

const readyModel = (resourceType: string, resourceId: typeof plainResourceId): SearchPageModel => ({
  query: 'unit',
  response: {
    partial: false,
    results: [
      {
        kind: 'resource',
        ref: { moduleId: inventoryModuleId, resourceId, resourceType },
        title: 'Unit 1',
      },
    ],
  },
  shell: authenticatedShell(),
  state: 'ready',
});

const resourceLinkCalls = () =>
  localizedLinkCalls.filter((call) => call.to.startsWith('/resources'));

beforeEach(() => {
  runBrowserEffectMock.mockImplementation(
    async (effect: Effect.Effect<unknown, unknown>) => await runEffectTestPromise(effect),
  );
  signOutMock.mockReturnValue(Effect.succeed({ signedOut: true }));
  switchTenantMock.mockReturnValue(Effect.succeed({ selectedTenantId: tenantId }));
  switchLegalEntityMock.mockReturnValue(Effect.succeed({ selectedLegalEntityId: legalEntityId }));
  useLoaderDataMock.mockReturnValue(readyModel('stock-item', plainResourceId));
});

afterEach(() => {
  cleanup();
  languageState.current = 'en';
  localizedLinkCalls.length = 0;
  rstest.clearAllMocks();
});

test('a search result hands the canonical resource route to the framework link', () => {
  render(<SearchPage />);

  const [resultCall] = resourceLinkCalls();
  expect(resourceLinkCalls()).toHaveLength(1);
  expect(resultCall?.to).toBe('/resources/$moduleId/$resourceType/$resourceId');
  expect(resultCall?.params).toEqual({
    moduleId: 'inventory.stock',
    resourceId: 'unit-1',
    resourceType: 'stock-item',
  });
  expect(resultCall?.href).toBeUndefined();
  expect(screen.getByRole('link', { name: 'Unit 1' }).getAttribute('href')).toBe(
    '/en/resources/inventory.stock/stock-item/unit-1',
  );
});

test('a search result resolves the Czech resource route from the same canonical target', () => {
  languageState.current = 'cs';
  render(<SearchPage />);

  expect(resourceLinkCalls()[0]?.to).toBe('/resources/$moduleId/$resourceType/$resourceId');
  expect(screen.getByRole('link', { name: 'Unit 1' }).getAttribute('href')).toBe(
    '/cs/zdroje/inventory.stock/stock-item/unit-1',
  );
});

test('resource path segments stay percent-encoded per segment', () => {
  useLoaderDataMock.mockReturnValue(readyModel('stock item', awkwardResourceId));
  render(<SearchPage />);

  expect(resourceLinkCalls()[0]?.params).toEqual({
    moduleId: 'inventory.stock',
    resourceId: 'unit #1/2',
    resourceType: 'stock item',
  });
  expect(screen.getByRole('link', { name: 'Unit 1' }).getAttribute('href')).toBe(
    '/en/resources/inventory.stock/stock%20item/unit%20%231%2F2',
  );
});

test('an empty result set exposes no resource affordance', () => {
  useLoaderDataMock.mockReturnValue({
    query: 'unit',
    response: { partial: false, results: [] },
    shell: authenticatedShell(),
    state: 'ready',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  expect(screen.getByText('No results')).toBeTruthy();
  expect(resourceLinkCalls()).toHaveLength(0);
});

test('an unavailable search exposes no resource affordance', () => {
  useLoaderDataMock.mockReturnValue({
    query: 'unit',
    shell: authenticatedShell(),
    state: 'unavailable',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  expect(screen.getByText('Search unavailable')).toBeTruthy();
  expect(resourceLinkCalls()).toHaveLength(0);
});

test('a closed shell state exposes no navigable affordance at all', () => {
  useLoaderDataMock.mockReturnValue({
    query: 'unit',
    shell: { state: 'unavailable' },
    state: 'unavailable',
  } satisfies SearchPageModel);
  render(<SearchPage />);

  expect(screen.getByText('Dashboard unavailable')).toBeTruthy();
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  expect(localizedLinkCalls).toHaveLength(0);
});
