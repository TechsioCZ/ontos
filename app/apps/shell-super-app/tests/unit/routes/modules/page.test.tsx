import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { afterEach, beforeEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Schema } from 'effect';
import type { ReactNode } from 'react';

import {
  LegalEntityIdSchema,
  ResolvedModuleTargetSchema,
  SafeTenantIdentitySchema,
} from '../../../../shared/api.ts';
import ContactsPage from '../../../../src/routes/[lang]/contacts/page.tsx';
import type { ModuleTargetPageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/page.data.ts';
import ModuleTargetPage from '../../../../src/routes/[lang]/modules/[moduleId]/page.tsx';

type ResolvedPageModel = Extract<
  ModuleTargetPageModel,
  { readonly state: 'resolved' }
>;

const {
  findApprovedVerticalPageClientMock,
  loadRemotePageMock,
  remotePropsMock,
  useLoaderDataMock,
} = rstest.hoisted(() => ({
  findApprovedVerticalPageClientMock: rstest.fn(),
  loadRemotePageMock: rstest.fn(),
  remotePropsMock: rstest.fn(),
  useLoaderDataMock: rstest.fn(),
}));

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ t: (key: string) => key }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useLoaderData: useLoaderDataMock,
}));

rstest.mock('@techsio/ui-kit/atoms/status-text', () => ({
  StatusText: ({ children }: { readonly children: ReactNode }) => (
    <span>{children}</span>
  ),
}));

rstest.mock('../../../../src/runtime/browser-effect-runtime.ts', () => ({
  runBrowserEffect: runEffectTestPromise,
}));

rstest.mock('../../../../src/api/vertical-clients.ts', () => ({
  findApprovedVerticalPageClient: findApprovedVerticalPageClientMock,
}));

rstest.mock('../../../../src/routes/shell-frame.tsx', () => ({
  AuthenticatedDashboardLayout: ({
    children,
  }: {
    readonly children: ReactNode;
  }) => <main>{children}</main>,
}));

rstest.mock('../../../../src/routes/use-shell-controls.ts', () => ({
  useShellControls: () => ({
    handleLegalEntityChange: rstest.fn(),
    handleLogout: rstest.fn(),
    handleSearch: rstest.fn(),
    handleTenantChange: rstest.fn(),
    legalEntitySwitchFailed: false,
    legalEntitySwitchPending: false,
    logoutFailed: false,
    logoutPending: false,
    tenantSwitchFailed: false,
    tenantSwitchPending: false,
  }),
}));

const shell: ResolvedPageModel['shell'] = {
  contextState: 'authenticated' as const,
  identity: Schema.decodeUnknownSync(SafeTenantIdentitySchema)({
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  }),
  legalEntities: { items: [], state: 'available' as const },
  navigation: {
    items: [],
    state: 'available' as const,
    unavailableDeployments: [],
  },
  selectedLegalEntityId: Schema.decodeUnknownSync(LegalEntityIdSchema)(
    '20000000-0000-4000-8000-000000000001'
  ),
  state: 'authenticated' as const,
  tenants: { items: [], state: 'available' as const },
};

const targetFixture = (
  componentKey: string,
  entrypointKey: string,
  writable = true
) =>
  Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    appId: 'contacts',
    componentKey,
    entrypointKey,
    moduleId: 'contacts.core',
    writable,
  });

const resolvedModel: ResolvedPageModel = {
  routeParams: { id: 'customer-1' },
  shell,
  state: 'resolved',
  target: targetFixture(
    'contacts.core.page-customers',
    'contacts.core.page.customers'
  ),
};

interface ExactPageCase {
  readonly componentKey: string;
  readonly entrypointKey: string;
  readonly renderedText: string;
  readonly routeParams: ResolvedPageModel['routeParams'];
  readonly writable: boolean;
}

const exactPageCases: ExactPageCase[] = [
  {
    componentKey: 'contacts.core.page-customers-list',
    entrypointKey: 'contacts.core.page.customers-list',
    renderedText: 'contacts.core.page-customers-list:static',
    routeParams: {},
    writable: true,
  },
  {
    componentKey: 'contacts.core.page-customer-detail',
    entrypointKey: 'contacts.core.page.customer-detail',
    renderedText:
      'contacts.core.page-customer-detail:11111111-1111-4111-8111-111111111111',
    routeParams: { id: '11111111-1111-4111-8111-111111111111' },
    writable: true,
  },
  {
    componentKey: 'contacts.core.page-customer-edit',
    entrypointKey: 'contacts.core.page.customer-edit',
    renderedText: 'contacts.core.page-customer-edit:customer-1',
    routeParams: { id: 'customer-1' },
    writable: false,
  },
  {
    componentKey: 'contacts.core.page-customer-create',
    entrypointKey: 'contacts.core.page.customer-create',
    renderedText: 'contacts.core.page-customer-create:untrusted-route-context',
    routeParams: { id: 'untrusted-route-context' },
    writable: true,
  },
  {
    componentKey: 'contacts.core.page-contact-detail',
    entrypointKey: 'contacts.core.page.contact-detail',
    renderedText:
      'contacts.core.page-contact-detail:11111111-1111-4111-8111-111111111111',
    routeParams: {
      contactId: '33333333-3333-4333-8333-333333333333',
      id: '11111111-1111-4111-8111-111111111111',
    },
    writable: true,
  },
  {
    componentKey: 'contacts.core.page-contact-edit',
    entrypointKey: 'contacts.core.page.contact-edit',
    renderedText:
      'contacts.core.page-contact-edit:11111111-1111-4111-8111-111111111111',
    routeParams: {
      contactId: '33333333-3333-4333-8333-333333333333',
      id: '11111111-1111-4111-8111-111111111111',
    },
    writable: false,
  },
  {
    componentKey: 'contacts.core.page-contact-create',
    entrypointKey: 'contacts.core.page.contact-create',
    renderedText:
      'contacts.core.page-contact-create:11111111-1111-4111-8111-111111111111',
    routeParams: { id: '11111111-1111-4111-8111-111111111111' },
    writable: false,
  },
];

beforeEach(() => {
  loadRemotePageMock.mockResolvedValue({
    default: ({
      routeParams,
      target,
    }: {
      readonly routeParams: Readonly<Record<string, string>>;
      readonly target: {
        readonly componentKey: string;
        readonly writable: boolean;
      };
    }) => {
      remotePropsMock({ routeParams, target });
      return (
        <div>{`${target.componentKey}:${routeParams['id'] ?? 'static'}`}</div>
      );
    },
  });
  findApprovedVerticalPageClientMock.mockReturnValue({
    load: loadRemotePageMock,
  });
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test.each([
  'selection_required',
  'forbidden',
  'not_found',
  'unavailable',
] as const)(
  'does not consult or invoke the private registry for a %s exact-page response',
  (state) => {
    useLoaderDataMock.mockReturnValue({
      shell,
      state,
    } satisfies ModuleTargetPageModel);
    render(<ModuleTargetPage />);
    expect(findApprovedVerticalPageClientMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).not.toHaveBeenCalled();
  }
);

test('invokes the exact private page loader only after a resolved authenticated response', async () => {
  useLoaderDataMock.mockReturnValue(resolvedModel);
  render(<ModuleTargetPage />);
  expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(
    resolvedModel.target
  );
  await waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1));
  expect(
    await screen.findByText('contacts.core.page-customers:customer-1')
  ).toBeTruthy();
});

test('reads loader data from the active Party Registry owner route', () => {
  useLoaderDataMock.mockImplementation(
    ({ from }: { readonly from: string }) => {
      if (from !== '/$lang/contacts') {
        throw new Error(
          `Invariant failed: Could not find an active match from "${from}"`
        );
      }
      return resolvedModel;
    }
  );

  expect(() => render(<ContactsPage />)).not.toThrow();
  expect(useLoaderDataMock).toHaveBeenCalledWith({
    from: '/$lang/contacts',
    structuralSharing: false,
  });
});

test('maps an unreachable approved remote to its safe local diagnostic', async () => {
  loadRemotePageMock.mockRejectedValueOnce(new Error('private remote error'));
  useLoaderDataMock.mockReturnValue(resolvedModel);

  render(<ModuleTargetPage />);

  expect(
    await screen.findByText('shell.moduleTarget.unavailable')
  ).toBeTruthy();
});

test('rejects a malformed remote module before React receives it', async () => {
  loadRemotePageMock.mockResolvedValueOnce({ default: 'not a component' });
  useLoaderDataMock.mockReturnValue(resolvedModel);

  render(<ModuleTargetPage />);

  expect(
    await screen.findByText('shell.moduleTarget.incompatible')
  ).toBeTruthy();
  expect(remotePropsMock).not.toHaveBeenCalled();
});

test('passes an empty route-parameter record to a resolved static page', async () => {
  useLoaderDataMock.mockReturnValue({ ...resolvedModel, routeParams: {} });
  render(<ModuleTargetPage />);
  await waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1));
  expect(
    await screen.findByText('contacts.core.page-customers:static')
  ).toBeTruthy();
});

test.each(exactPageCases)(
  'loads the approved $componentKey remote once with its exact route context and resolved target',
  async ({
    componentKey,
    entrypointKey,
    renderedText,
    routeParams,
    writable,
  }) => {
    const exactModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams,
      target: targetFixture(componentKey, entrypointKey, writable),
    };
    useLoaderDataMock.mockReturnValue(exactModel);

    render(<ModuleTargetPage />);

    expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(
      exactModel.target
    );
    await waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1));
    expect(remotePropsMock).toHaveBeenCalledWith({
      routeParams,
      target: exactModel.target,
    });
    expect(await screen.findByText(renderedText)).toBeTruthy();
  }
);
