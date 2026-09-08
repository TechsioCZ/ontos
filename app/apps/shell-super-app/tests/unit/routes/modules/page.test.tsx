import { afterEach, beforeEach, expect, rstest, it } from '@app/effect-rstest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import type { ReactNode } from 'react';
import {
  LegalEntityIdSchema,
  ResolvedModuleTargetSchema,
  SafeTenantIdentitySchema,
} from '../../../../shared/api.ts';
import ContactsPage from '../../../../src/routes/[lang]/contacts/page.tsx';
import ModuleTargetPage from '../../../../src/routes/[lang]/modules/[moduleId]/page.tsx';
import type { ModuleTargetPageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/page.data.ts';

type ResolvedPageModel = Extract<ModuleTargetPageModel, { readonly state: 'resolved' }>;

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
  StatusText: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
}));

rstest.mock('../../../../src/api/vertical-clients.ts', () => ({
  findApprovedVerticalPageClient: findApprovedVerticalPageClientMock,
}));

rstest.mock('../../../../src/routes/shell-frame.tsx', () => ({
  AuthenticatedDashboardLayout: ({ children }: { readonly children: ReactNode }) => (
    <main>{children}</main>
  ),
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
  navigation: { items: [], state: 'available' as const, unavailableDeployments: [] },
  selectedLegalEntityId: Schema.decodeUnknownSync(LegalEntityIdSchema)(
    '20000000-0000-4000-8000-000000000001',
  ),
  state: 'authenticated' as const,
  tenants: { items: [], state: 'available' as const },
};

const targetFixture = (componentKey: string, entrypointKey: string, writable = true) =>
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
  target: targetFixture('contacts.core.page-customers', 'contacts.core.page.customers'),
};

beforeEach(() => {
  loadRemotePageMock.mockResolvedValue({
    default: ({
      routeParams,
      target,
    }: {
      readonly routeParams: Readonly<Record<string, string>>;
      readonly target: { readonly componentKey: string; readonly writable: boolean };
    }) => {
      remotePropsMock({ routeParams, target });
      return <div>{`${target.componentKey}:${routeParams['id'] ?? 'static'}`}</div>;
    },
  });
  findApprovedVerticalPageClientMock.mockReturnValue({ load: loadRemotePageMock });
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

it.each(['selection_required', 'forbidden', 'not_found', 'unavailable'] as const)(
  'does not consult or invoke the private registry for a %s exact-page response',
  (state) => {
    useLoaderDataMock.mockReturnValue({ shell, state } satisfies ModuleTargetPageModel);
    render(<ModuleTargetPage />);
    expect(findApprovedVerticalPageClientMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).not.toHaveBeenCalled();
  },
);

it.live('invokes the exact private page loader only after a resolved authenticated response', () =>
  Effect.gen(function* invokesTheExactPrivatePageLoader() {
    useLoaderDataMock.mockReturnValue(resolvedModel);
    render(<ModuleTargetPage />);
    expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(resolvedModel.target);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(
      yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1')),
    ).toBeTruthy();
  }),
);

it('reads loader data from the active Party Registry owner route', () => {
  useLoaderDataMock.mockImplementation(({ from }: { readonly from: string }) => {
    if (from !== '/$lang/contacts') {
      throw new Error(`Invariant failed: Could not find an active match from "${from}"`);
    }
    return resolvedModel;
  });

  expect(() => render(<ContactsPage />)).not.toThrow();
  expect(useLoaderDataMock).toHaveBeenCalledWith({
    from: '/$lang/contacts',
    structuralSharing: false,
  });
});

it.live('maps an unreachable approved remote to its safe local diagnostic', () =>
  Effect.gen(function* mapsAnUnreachableApprovedRemoteTo() {
    loadRemotePageMock.mockRejectedValueOnce(new Error('private remote error'));
    useLoaderDataMock.mockReturnValue(resolvedModel);

    render(<ModuleTargetPage />);

    expect(
      yield* Effect.promise(() => screen.findByText('shell.moduleTarget.unavailable')),
    ).toBeTruthy();
  }),
);

it.live('rejects a malformed remote module before React receives it', () =>
  Effect.gen(function* rejectsAMalformedRemoteModuleBefore() {
    loadRemotePageMock.mockResolvedValueOnce({ default: 'not a component' });
    useLoaderDataMock.mockReturnValue(resolvedModel);

    render(<ModuleTargetPage />);

    expect(
      yield* Effect.promise(() => screen.findByText('shell.moduleTarget.incompatible')),
    ).toBeTruthy();
    expect(remotePropsMock).not.toHaveBeenCalled();
  }),
);

it.live('passes an empty route-parameter record to a resolved static page', () =>
  Effect.gen(function* passesAnEmptyRouteParameterRecord() {
    useLoaderDataMock.mockReturnValue({ ...resolvedModel, routeParams: {} });
    render(<ModuleTargetPage />);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(
      yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:static')),
    ).toBeTruthy();
  }),
);

it.live('loads the generated Customers list page as a static exact target', () =>
  Effect.gen(function* loadsTheGeneratedCustomersListPage() {
    const customersListModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: {},
      target: targetFixture(
        'contacts.core.page-customers-list',
        'contacts.core.page.customers-list',
      ),
    };
    useLoaderDataMock.mockReturnValue(customersListModel);
    render(<ModuleTargetPage />);
    expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(customersListModel.target);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(
      yield* Effect.promise(() => screen.findByText('contacts.core.page-customers-list:static')),
    ).toBeTruthy();
  }),
);

it.live('loads the approved Customer-detail remote once with the exact declared Customer ID', () =>
  Effect.gen(function* loadsTheApprovedCustomerDetailRemote() {
    const customerDetailModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: '11111111-1111-4111-8111-111111111111' },
      target: targetFixture(
        'contacts.core.page-customer-detail',
        'contacts.core.page.customer-detail',
      ),
    };
    useLoaderDataMock.mockReturnValue(customerDetailModel);
    render(<ModuleTargetPage />);
    expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(customerDetailModel.target);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(
      yield* Effect.promise(() =>
        screen.findByText(
          'contacts.core.page-customer-detail:11111111-1111-4111-8111-111111111111',
        ),
      ),
    ).toBeTruthy();
  }),
);

it.live('loads the approved Contact-detail remote once with both exact hierarchical IDs', () =>
  Effect.gen(function* loadsTheApprovedContactDetailRemote() {
    const contactDetailModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: {
        contactId: '33333333-3333-4333-8333-333333333333',
        id: '11111111-1111-4111-8111-111111111111',
      },
      target: targetFixture(
        'contacts.core.page-contact-detail',
        'contacts.core.page.contact-detail',
      ),
    };
    useLoaderDataMock.mockReturnValue(contactDetailModel);
    render(<ModuleTargetPage />);

    expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(contactDetailModel.target);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(remotePropsMock).toHaveBeenCalledWith({
      routeParams: contactDetailModel.routeParams,
      target: contactDetailModel.target,
    });
  }),
);

it.live('passes ContactEdit both hierarchical IDs and the resolved fail-closed target', () =>
  Effect.gen(function* passesContactEditBothHierarchicalIDsAnd() {
    const contactEditModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: {
        contactId: '33333333-3333-4333-8333-333333333333',
        id: '11111111-1111-4111-8111-111111111111',
      },
      target: targetFixture(
        'contacts.core.page-contact-edit',
        'contacts.core.page.contact-edit',
        false,
      ),
    };
    useLoaderDataMock.mockReturnValue(contactEditModel);
    render(<ModuleTargetPage />);

    expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(contactEditModel.target);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(remotePropsMock).toHaveBeenCalledWith({
      routeParams: contactEditModel.routeParams,
      target: contactEditModel.target,
    });
  }),
);

it.live('passes CustomerEdit its exact ID and fail-closed writable target', () =>
  Effect.gen(function* passesCustomerEditItsExactIDAnd() {
    const customerEditModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'customer-1' },
      target: targetFixture(
        'contacts.core.page-customer-edit',
        'contacts.core.page.customer-edit',
        false,
      ),
    };
    useLoaderDataMock.mockReturnValue(customerEditModel);
    render(<ModuleTargetPage />);

    expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(customerEditModel.target);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(remotePropsMock).toHaveBeenCalledWith({
      routeParams: { id: 'customer-1' },
      target: customerEditModel.target,
    });
    expect(
      yield* Effect.promise(() => screen.findByText('contacts.core.page-customer-edit:customer-1')),
    ).toBeTruthy();
  }),
);

it.live('passes CustomerCreate its bounded route context and resolved writable target', () =>
  Effect.gen(function* passesCustomerCreateItsBoundedRouteContext() {
    const customerCreateModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'untrusted-route-context' },
      target: targetFixture(
        'contacts.core.page-customer-create',
        'contacts.core.page.customer-create',
      ),
    };
    useLoaderDataMock.mockReturnValue(customerCreateModel);
    render(<ModuleTargetPage />);

    expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(customerCreateModel.target);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(remotePropsMock).toHaveBeenCalledWith({
      routeParams: { id: 'untrusted-route-context' },
      target: customerCreateModel.target,
    });
    expect(
      yield* Effect.promise(() =>
        screen.findByText('contacts.core.page-customer-create:untrusted-route-context'),
      ),
    ).toBeTruthy();
  }),
);

it.live('passes ContactCreate its exact ID and fail-closed writable target', () =>
  Effect.gen(function* passesContactCreateItsExactIDAnd() {
    const contactCreateModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: '11111111-1111-4111-8111-111111111111' },
      target: targetFixture(
        'contacts.core.page-contact-create',
        'contacts.core.page.contact-create',
        false,
      ),
    };
    useLoaderDataMock.mockReturnValue(contactCreateModel);
    render(<ModuleTargetPage />);

    expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(contactCreateModel.target);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(remotePropsMock).toHaveBeenCalledWith({
      routeParams: { id: '11111111-1111-4111-8111-111111111111' },
      target: contactCreateModel.target,
    });
    expect(
      yield* Effect.promise(() =>
        screen.findByText('contacts.core.page-contact-create:11111111-1111-4111-8111-111111111111'),
      ),
    ).toBeTruthy();
  }),
);
