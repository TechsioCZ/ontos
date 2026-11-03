import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, rstest, it } from 'effect-rstest';
import type { ReactNode } from 'react';

import {
  ShellReloadRequiredProblemSchema,
  ShellResourceDetailResponseSchema as ShellResourceResponseSchema,
  ShellNavigationItemSchema,
  ShellTargetForbiddenProblemSchema,
} from '../../../../shared/api.ts';
import type {
  MediaAttachmentResponse,
  ShellResourceDetailResponse as ShellResourceResponse,
} from '../../../../shared/api.ts';
import type { ResourcePageModel } from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/resource-page-model.ts';
import ResourcePage from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/page.tsx';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts' with {
  rstest: 'importActual',
};
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';

type ReadyModel = Extract<ResourcePageModel, { readonly state: 'ready' }>;
type ClosedState = Exclude<ResourcePageModel['state'], 'ready'>;

interface DashboardPageProps {
  readonly currentModuleId?: string;
  readonly title: string;
}

const {
  attachResourceMediaMock,
  browserRunPromiseMock,
  dashboardRenders,
  navigateMock,
  routeParams,
  routerHistoryState,
  shellControlsMock,
  useLoaderDataMock,
} = rstest.hoisted(() => {
  const renders: DashboardPageProps[] = [];
  return {
    attachResourceMediaMock: rstest.fn(),
    browserRunPromiseMock: rstest.fn(),
    dashboardRenders: renders,
    navigateMock: rstest.fn(),
    routeParams: { moduleId: 'billing.invoices', resourceId: '', resourceType: '' },
    routerHistoryState: { searchHitTitle: '' },
    shellControlsMock: rstest.fn(),
    useLoaderDataMock: rstest.fn(),
  };
});

const translations = new Map(
  Object.entries({
    'shell.auth.logout.failed': 'Logout failed',
    'shell.dashboard.unavailable': 'The dashboard is unavailable',
    'shell.moduleTarget.reload_required': 'Reload this page to continue',
    'shell.recovery.home': 'Back to home',
    'shell.recovery.retry': 'Try again',
    'shell.resource.detail_not_supported':
      'This app has no record view for this type yet. Open the agenda it belongs to.',
    'shell.resource.detail_not_supported_title': 'Record details are not available here',
    'shell.resource.forbidden': 'You cannot open this resource',
    'shell.resource.media.absent': 'This resource has no media',
    'shell.resource.media.attach': 'Attach media',
    'shell.resource.media.failed': 'Attaching the media failed',
    'shell.resource.media.forbidden': 'You cannot attach media here',
    'shell.resource.media.pending': 'Attaching media…',
    'shell.resource.media.read_only': 'This module is read only',
    'shell.resource.media.success': 'Media attached',
    'shell.resource.media.title': 'Media',
    'shell.resource.media.unavailable': 'Media attachment is unavailable',
    'shell.resource.not_found': 'This resource does not exist',
    'shell.resource.open_in_agenda': 'Open in its agenda',
    'shell.resource.selection_required': 'Select a legal entity first',
    'shell.resource.timeline.empty': 'No timeline entries yet',
    'shell.resource.timeline.lagging': 'The timeline is catching up',
    'shell.resource.timeline.title': 'Timeline',
    'shell.resource.title': 'Resource',
    'shell.resource.unavailable': 'This resource is unavailable',
  }),
);

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  Link: ({ children, to }: { readonly children: ReactNode; readonly to: string }) => <a href={to}>{children}</a>,
  useModernI18n: () => ({
    language: 'en',
    t: (key: string) => translations.get(key) ?? key,
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useLoaderData: useLoaderDataMock,
  useNavigate: () => navigateMock,
  useParams: () => routeParams,
  useRouterState: ({
    select,
  }: {
    readonly select: (state: { location: { state: typeof routerHistoryState } }) => string | undefined;
  }) => select({ location: { state: routerHistoryState } }),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  attachResourceMedia: attachResourceMediaMock,
}));

rstest.mock('../../../../src/runtime/browser-effect-runtime.ts', () => ({
  browserRuntime: { runPromise: browserRunPromiseMock },
}));

rstest.mock('../../../../src/routes/use-shell-controls.ts', () => ({
  useShellControls: shellControlsMock,
}));

rstest.mock('../../../../src/routes/shell-frame.tsx', () => ({
  AuthenticatedDashboardLayout: ({ children, ...props }: DashboardPageProps & { readonly children: ReactNode }) => {
    dashboardRenders.push(props);
    return (
      <main>
        <h1>{props.title}</h1>
        {children}
      </main>
    );
  },
  // One group per call holding each admitted destination as an enabled link, labelled in English.
  buildShellNavigation: ({
    navigation,
  }: {
    readonly navigation: readonly { readonly href?: string; readonly label: { readonly en: string } }[];
  }) => ({
    groups: [
      {
        links: navigation.map((item) => ({
          enabled: true,
          href: item.href ?? null,
          icon: 'icon-[mdi--file-outline]',
          key: item.label.en,
          label: item.label.en,
        })),
      },
    ],
  }),
  ShellRouteLink: ({
    children,
    search,
    to,
  }: {
    readonly children: ReactNode;
    readonly search?: Readonly<Record<string, string>>;
    readonly to: string;
  }) => <a href={search === undefined ? to : `${to}?${new URLSearchParams(search).toString()}`}>{children}</a>,
}));

const shell: ReadyModel['shell'] = authenticatedShellFixture();

const attachedResponse: MediaAttachmentResponse = { attached: true };

const resourceFixture = (
  overrides: Partial<Schema.Codec.Encoded<typeof ShellResourceResponseSchema>> = {},
): ShellResourceResponse =>
  Schema.decodeUnknownSync(ShellResourceResponseSchema)({
    detail: {
      fields: [
        { label: 'Status', value: 'Open' },
        { label: 'Amount', value: '1 250,00 CZK' },
      ],
      title: 'Invoice 42',
    },
    media: { enabled: true, reason: 'available' },
    projectionLagging: false,
    ref: {
      moduleId: 'billing.invoices',
      resourceId: 'invoice-42',
      resourceType: 'invoice',
    },
    timeline: [
      {
        occurredAt: '2026-01-02T03:04:05.000Z',
        summary: 'Invoice issued',
        timelineEntryId: 'timeline-1',
      },
    ],
    ...overrides,
  });

const readyModel = (resource: ShellResourceResponse = resourceFixture()): ReadyModel => ({
  resource,
  shell,
  state: 'ready',
});

const forbiddenProblem = Schema.decodeUnknownSync(ShellTargetForbiddenProblemSchema)({
  _tag: 'ShellTargetForbiddenProblem',
  detail: 'The principal cannot attach media to this resource.',
  status: 403,
  title: 'Shell target forbidden',
  type: 'https://ontos.dev/problems/shell-target-forbidden',
});

const reloadRequiredProblem = Schema.decodeUnknownSync(ShellReloadRequiredProblemSchema)({
  _tag: 'ShellReloadRequiredProblem',
  detail: 'This document belongs to a previous application release.',
  status: 409,
  title: 'Application reload required',
  type: 'https://ontos.dev/problems/shell-reload-required',
});

const attachButton = () => screen.getByRole('button');

const lastDashboardProps = (): DashboardPageProps => {
  const props = dashboardRenders.at(-1);
  if (props === undefined) {
    throw new Error('The dashboard layout was never rendered.');
  }
  return props;
};

const renderResourcePage = (model: ResourcePageModel) => {
  useLoaderDataMock.mockReturnValue(model);
  return render(<ResourcePage />);
};

beforeEach(() => {
  browserRunPromiseMock.mockImplementation(browserRuntime.runPromise);
  attachResourceMediaMock.mockReturnValue(Effect.succeed(attachedResponse));
  shellControlsMock.mockReturnValue({
    handleLegalEntityChange: rstest.fn(),
    handleLogout: rstest.fn(),
    handleSearch: rstest.fn(),
    handleTenantChange: rstest.fn(),
    legalEntitySwitchFailed: false,
    legalEntitySwitchPending: false,
    logoutFailed: false,
    logoutPending: false,
    reloadRequired: false,
    tenantSwitchFailed: false,
    tenantSwitchPending: false,
  });
});

afterEach(() => {
  cleanup();
  dashboardRenders.length = 0;
  rstest.clearAllMocks();
});

it.each([
  {
    blockedText: 'Reload this page to continue',
    shellState: 'reload_required' as const,
  },
  {
    blockedText: 'The dashboard is unavailable',
    shellState: 'unavailable' as const,
  },
])(
  'refuses the whole page for a $shellState shell without a dashboard or an attach seam',
  ({ blockedText, shellState }) => {
    renderResourcePage({ shell: { state: shellState }, state: 'unavailable' });

    expect(screen.getByText(blockedText)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
    expect(dashboardRenders).toHaveLength(0);
    expect(shellControlsMock).toHaveBeenCalledWith(undefined);
    expect(attachResourceMediaMock).not.toHaveBeenCalled();
    expect(browserRunPromiseMock).not.toHaveBeenCalled();
  },
);

it('sends a browser without a live session to sign-in instead of a bare error line', () => {
  renderResourcePage({ shell: { reason: 'account_forbidden', state: 'anonymous' }, state: 'selection_required' });

  expect(navigateMock).toHaveBeenCalledWith({ href: '/en/login?reason=account_forbidden', replace: true });
  expect(screen.getByText('shell.moduleTarget.sign_in_required')).toBeTruthy();
  expect(screen.queryByText('Select a legal entity first')).toBeNull();
  expect(screen.queryByText('Media')).toBeNull();
  expect(dashboardRenders).toHaveLength(0);
  expect(attachResourceMediaMock).not.toHaveBeenCalled();
});

it('refuses media attachment when document hydration requires a reload', () => {
  shellControlsMock.mockReturnValueOnce({ reloadRequired: true });
  renderResourcePage(readyModel());

  expect(screen.getByText('Reload this page to continue')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
  expect(dashboardRenders).toHaveLength(0);
  expect(attachResourceMediaMock).not.toHaveBeenCalled();
});

const closedStates: readonly {
  readonly closedText: string;
  readonly state: ClosedState;
}[] = [
  { closedText: 'You cannot open this resource', state: 'forbidden' },
  { closedText: 'This resource does not exist', state: 'not_found' },
  { closedText: 'Select a legal entity first', state: 'selection_required' },
  { closedText: 'This resource is unavailable', state: 'unavailable' },
];

it.each(closedStates)(
  'keeps a $state resource inside the dashboard with no media seam at all',
  ({ closedText, state }) => {
    renderResourcePage({ shell, state });

    expect(screen.getByText(closedText)).toBeTruthy();
    // The frame shows the state once as the page heading; the panel below it has no second heading.
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
    expect(screen.queryByText('Timeline')).toBeNull();
    // A record page names the missing record, not a missing page.
    expect(lastDashboardProps().title).toBe(
      new Map([
        ['not_found', 'shell.recovery.recordMissing'],
        ['forbidden', 'shell.recovery.forbidden'],
      ]).get(state) ?? 'shell.recovery.unavailable',
    );
    expect(lastDashboardProps().currentModuleId).toBeUndefined();
    expect(shellControlsMock).toHaveBeenCalledWith(shell);
    expect(attachResourceMediaMock).not.toHaveBeenCalled();
    expect(browserRunPromiseMock).not.toHaveBeenCalled();
  },
);

const navigationItem = (moduleId: string, label: string, href: string) => ({
  appId: 'billing-app',
  enabled: true,
  entrypointKey: `${moduleId}.page`,
  groupKey: 'shell.navigation.finance',
  href,
  icon: 'icon-[mdi--file-outline]',
  label: { cs: label, en: label },
  moduleId,
  order: 1,
  state: 'active',
  unavailable: false,
  writable: true,
});

it('offers the owning module agendas when the Shell cannot show the record itself', () => {
  const withAgendas = Schema.decodeUnknownSync(Schema.Array(ShellNavigationItemSchema))([
    navigationItem('billing.invoices', 'Invoices', '/en/finance/invoices'),
    navigationItem('crm.records', 'Customers', '/en/crm'),
  ]);
  renderResourcePage({
    shell: {
      ...authenticatedShellFixture(),
      navigation: {
        deniedAppIds: [],
        items: withAgendas,
        moduleIds: [],
        state: 'available',
        unavailableDeployments: [],
      },
    },
    state: 'not_found',
  });

  const agendas = screen.getByRole('navigation', { name: 'Open in its agenda' });
  expect([...agendas.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Invoices', '/en/finance/invoices'],
  ]);
});

const financeInvoice = {
  moduleId: 'finance.billing',
  resourceId: '00000000-0000-4000-8000-000000000401',
  resourceType: 'finance.billing.invoice',
};

it.each([
  { closedText: 'This resource does not exist', state: 'not_found' as const, titleKey: 'shell.recovery.recordMissing' },
  { closedText: 'This resource is unavailable', state: 'unavailable' as const, titleKey: 'shell.recovery.unavailable' },
  { closedText: 'You cannot open this resource', state: 'forbidden' as const, titleKey: 'shell.recovery.forbidden' },
])('never renders a $state record from a search history title', ({ closedText, state, titleKey }) => {
  routerHistoryState.searchHitTitle = 'Faktura 2026/14';
  Object.assign(routeParams, financeInvoice);
  try {
    renderResourcePage({
      shell: {
        ...authenticatedShellFixture(),
        navigation: {
          deniedAppIds: [],
          items: Schema.decodeUnknownSync(Schema.Array(ShellNavigationItemSchema))([
            navigationItem('finance.billing', 'Faktury', '/finance'),
          ]),
          moduleIds: [],
          state: 'available',
          unavailableDeployments: [],
        },
      },
      state,
    });

    expect(lastDashboardProps().title).toBe(titleKey);
    expect(screen.getByText(closedText)).toBeTruthy();
    expect(screen.queryByText('Faktura 2026/14')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the record' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
    expect(screen.queryByText('Timeline')).toBeNull();
    expect(screen.queryByText('Status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' }) === null).toBe(state !== 'unavailable');
    expect(screen.queryByRole('navigation', { name: 'Open in its agenda' }) === null).toBe(state === 'forbidden');
  } finally {
    routerHistoryState.searchHitTitle = '';
    Object.assign(routeParams, { moduleId: 'billing.invoices', resourceId: '', resourceType: '' });
  }
});

const shellWithNavigation = (items: readonly ReturnType<typeof navigationItem>[]) => ({
  ...authenticatedShellFixture(),
  navigation: {
    deniedAppIds: [],
    items: Schema.decodeUnknownSync(Schema.Array(ShellNavigationItemSchema))(items),
    moduleIds: [],
    state: 'available' as const,
    unavailableDeployments: [],
  },
});

it('links a facility record only to its agenda, never to a record page or the searched title', () => {
  routerHistoryState.searchHitTitle = 'Plynová kotelna';
  try {
    const company = authenticatedShellFixture().selectedLegalEntityId ?? '';
    Object.assign(routeParams, {
      moduleId: 'facility.operations',
      resourceId: `${company}.TEC-001`,
      resourceType: 'facility.operations.asset',
    });
    renderResourcePage({
      shell: shellWithNavigation([navigationItem('facility.operations', 'Majetek', '/provoz/majetek')]),
      state: 'not_found',
    });

    expect(lastDashboardProps().title).toBe('shell.recovery.recordMissing');
    expect(screen.getByText('This resource does not exist')).toBeTruthy();
    expect(screen.queryByText('Plynová kotelna')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the record' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Majetek' }).getAttribute('href')).toBe('/provoz/majetek');
    expect(document.body.textContent).not.toContain('TEC-001');
  } finally {
    routerHistoryState.searchHitTitle = '';
    Object.assign(routeParams, { moduleId: 'billing.invoices', resourceId: '', resourceType: '' });
  }
});

it('links a person only to people administration, without treating the search title as the record', () => {
  routerHistoryState.searchHitTitle = 'Jana Nováková';
  Object.assign(routeParams, {
    moduleId: 'core.identity',
    resourceId: '00000000-0000-4000-8000-000000000201.00000000-0000-4000-8000-000000000001',
    resourceType: 'core.identity.person',
  });
  try {
    const { unmount } = renderResourcePage({
      shell: shellWithNavigation([
        navigationItem('shell-super-app', 'People and roles', '/sprava/lide-a-role'),
        navigationItem('billing.invoices', 'Invoices', '/finance'),
      ]),
      state: 'not_found',
    });
    expect(lastDashboardProps().title).toBe('shell.recovery.recordMissing');
    expect(screen.queryByText('Jana Nováková')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the record' })).toBeNull();
    const agendas = screen.getByRole('navigation', { name: 'Open in its agenda' });
    expect([...agendas.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/sprava/lide-a-role',
    ]);
    unmount();

    renderResourcePage({
      shell: shellWithNavigation([navigationItem('billing.invoices', 'Invoices', '/finance')]),
      state: 'not_found',
    });
    expect(screen.queryByRole('navigation', { name: 'Open in its agenda' })).toBeNull();
    expect(screen.getByText('This resource does not exist')).toBeTruthy();
  } finally {
    routerHistoryState.searchHitTitle = '';
    Object.assign(routeParams, { moduleId: 'billing.invoices', resourceId: '', resourceType: '' });
  }
});

it('explains a record type without a Shell detail view instead of inventing a missing record', () => {
  routerHistoryState.searchHitTitle = 'Petr Dvořák';
  Object.assign(routeParams, {
    moduleId: 'party.registry',
    resourceId: 'ea2200ab-4308-491e-8e33-ca3871a8fa55',
    resourceType: 'party.registry.party',
  });
  try {
    renderResourcePage({
      detailSupport: 'not_supported',
      shell: shellWithNavigation([navigationItem('party.registry', 'Zákazníci', '/prodej/zakaznici')]),
      state: 'unavailable',
    });

    expect(lastDashboardProps().title).toBe('Record details are not available here');
    expect(
      screen.getByText('This app has no record view for this type yet. Open the agenda it belongs to.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to home' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Zákazníci' }).getAttribute('href')).toBe('/prodej/zakaznici');
    expect(screen.queryByText('Petr Dvořák')).toBeNull();
    expect(screen.queryByText('This resource is unavailable')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
    expect(screen.queryByText('Status')).toBeNull();
    expect(screen.queryByText('Timeline')).toBeNull();
  } finally {
    routerHistoryState.searchHitTitle = '';
    Object.assign(routeParams, { moduleId: 'billing.invoices', resourceId: '', resourceType: '' });
  }
});

it('titles the dashboard from the authorized detail and ignores a history title', () => {
  routerHistoryState.searchHitTitle = 'Faktura 2026/14';
  try {
    renderResourcePage(readyModel());

    expect(lastDashboardProps().title).toBe('Invoice 42');
    expect(lastDashboardProps().currentModuleId).toBe('billing.invoices');
    expect(screen.getByRole('heading', { level: 2, name: 'Invoice 42' })).toBeTruthy();
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('1 250,00 CZK')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach media' })).toBeTruthy();
    expect(screen.getByText('2026-01-02T03:04:05.000Z')).toBeTruthy();
    expect(screen.queryByText('Faktura 2026/14')).toBeNull();
  } finally {
    routerHistoryState.searchHitTitle = '';
  }
});

it('renders one timeline entry per projection row with its ISO instant', () => {
  renderResourcePage(readyModel());

  expect(screen.getByText('2026-01-02T03:04:05.000Z')).toBeTruthy();
  expect(screen.getByText(/Invoice issued/u)).toBeTruthy();
  expect(screen.queryByText('No timeline entries yet')).toBeNull();
  expect(screen.queryByText('The timeline is catching up')).toBeNull();
});

it('announces an empty and a lagging timeline projection', () => {
  renderResourcePage(readyModel(resourceFixture({ projectionLagging: true, timeline: [] })));

  expect(screen.getByText('No timeline entries yet')).toBeTruthy();
  expect(screen.getByText('The timeline is catching up')).toBeTruthy();
});

const disabledMediaCases = [
  { blockedText: 'This module is read only', reason: 'read_only' as const },
  { blockedText: 'This resource has no media', reason: 'absent' as const },
  { blockedText: 'You cannot attach media here', reason: 'forbidden' as const },
  {
    blockedText: 'Media attachment is unavailable',
    reason: 'unavailable' as const,
  },
];

it.live.each(disabledMediaCases)(
  'disables the attach seam and explains a $reason media policy without running an Effect',
  ({ blockedText, reason }) =>
    Effect.gen(function* refusesADisabledAttachSeam() {
      const user = userEvent.setup();
      renderResourcePage(readyModel(resourceFixture({ media: { enabled: false, reason } })));

      expect(screen.getByText(blockedText)).toBeTruthy();
      expect(attachButton().hasAttribute('disabled')).toBe(true);

      yield* Effect.promise(() => user.click(attachButton()));

      expect(attachResourceMediaMock).not.toHaveBeenCalled();
      expect(browserRunPromiseMock).not.toHaveBeenCalled();
      expect(screen.queryByText('Media attached')).toBeNull();
      expect(screen.queryByText('Attaching the media failed')).toBeNull();
    }),
);

it('marks the attachment pending inside the very click that starts it', () => {
  const gate = Deferred.makeUnsafe<MediaAttachmentResponse>();
  attachResourceMediaMock.mockReturnValue(Deferred.await(gate));
  renderResourcePage(readyModel());

  act(() => {
    attachButton().click();
  });

  expect(attachButton().hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Attaching media…')).toBeTruthy();
});

it('starts one attachment for a double click, because the first click already disabled the seam', () => {
  const gate = Deferred.makeUnsafe<MediaAttachmentResponse>();
  attachResourceMediaMock.mockReturnValue(Deferred.await(gate));
  renderResourcePage(readyModel());

  act(() => {
    attachButton().click();
  });
  act(() => {
    attachButton().click();
  });

  expect(attachResourceMediaMock).toHaveBeenCalledTimes(1);
  expect(browserRunPromiseMock).toHaveBeenCalledTimes(1);
});

it.live('holds the attach seam disabled for the whole in-flight attachment', () =>
  Effect.gen(function* holdsTheAttachSeamDisabled() {
    const gate = yield* Deferred.make<MediaAttachmentResponse>();
    attachResourceMediaMock.mockReturnValue(Deferred.await(gate));
    const user = userEvent.setup();
    renderResourcePage(readyModel());

    yield* Effect.promise(() => user.click(attachButton()));
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Attaching media…')).toBeTruthy()));
    expect(attachButton().hasAttribute('disabled')).toBe(true);

    yield* Effect.promise(() => user.click(attachButton()));
    expect(attachResourceMediaMock).toHaveBeenCalledTimes(1);
    expect(browserRunPromiseMock).toHaveBeenCalledTimes(1);

    yield* Deferred.succeed(gate, attachedResponse);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Media attached')).toBeTruthy()));
    expect(attachButton().hasAttribute('disabled')).toBe(false);
  }),
);

it.live('attaches media for the loaded resource reference and reports success once', () =>
  Effect.gen(function* attachesMediaForTheLoadedResource() {
    const user = userEvent.setup();
    const model = readyModel();
    renderResourcePage(model);

    yield* Effect.promise(() => user.click(attachButton()));
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Media attached')).toBeTruthy()));

    expect(attachResourceMediaMock).toHaveBeenCalledTimes(1);
    expect(attachResourceMediaMock).toHaveBeenCalledWith({
      ...model.resource.ref,
      compositionRevision: shell.state === 'authenticated' ? shell.compositionRevision : undefined,
    });
    expect(screen.queryByText('Attaching media…')).toBeNull();
    expect(screen.queryByText('Attaching the media failed')).toBeNull();
    expect(attachButton().hasAttribute('disabled')).toBe(false);
  }),
);

it.live('settles a typed attachment failure into its own status without a defect', () =>
  Effect.gen(function* settlesATypedAttachmentFailure() {
    attachResourceMediaMock.mockReturnValue(Effect.fail(forbiddenProblem));
    const user = userEvent.setup();
    renderResourcePage(readyModel());

    yield* Effect.promise(() => user.click(attachButton()));
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Attaching the media failed')).toBeTruthy()));

    expect(screen.queryByText('Media attached')).toBeNull();
    expect(screen.queryByText('Attaching media…')).toBeNull();
    expect(attachButton().hasAttribute('disabled')).toBe(false);
  }),
);

it.live('removes the media seam when attachment admission requires a fresh document', () =>
  Effect.gen(function* staleAttachmentRequiresANewDocument() {
    attachResourceMediaMock.mockReturnValue(Effect.fail(reloadRequiredProblem));
    const user = userEvent.setup();
    renderResourcePage(readyModel());

    yield* Effect.promise(() => user.click(attachButton()));
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Reload this page to continue')).toBeTruthy()));

    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
    expect(screen.queryByText('Media attached')).toBeNull();
    expect(attachResourceMediaMock).toHaveBeenCalledTimes(1);
  }),
);

it.live('retries after a failure and replaces the failure status with success', () =>
  Effect.gen(function* retriesAfterAFailure() {
    attachResourceMediaMock.mockReturnValueOnce(Effect.fail(forbiddenProblem));
    const user = userEvent.setup();
    renderResourcePage(readyModel());

    yield* Effect.promise(() => user.click(attachButton()));
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Attaching the media failed')).toBeTruthy()));

    yield* Effect.promise(() => user.click(attachButton()));
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Media attached')).toBeTruthy()));

    expect(attachResourceMediaMock).toHaveBeenCalledTimes(2);
    expect(browserRunPromiseMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Attaching the media failed')).toBeNull();
  }),
);
