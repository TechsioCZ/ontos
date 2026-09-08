import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts' with {
  rstest: 'importActual',
};
import { afterEach, beforeEach, expect, rstest, it } from 'effect-rstest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Deferred, Effect, Schema } from 'effect';
import type { ReactNode } from 'react';
import {
  ShellResourceResponseSchema,
  ShellTargetForbiddenProblemSchema,
} from '../../../../shared/api.ts';
import type { MediaAttachmentResponse, ShellResourceResponse } from '../../../../shared/api.ts';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';
import ResourcePage from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/page.tsx';
import type { ResourcePageModel } from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/page.data.ts';

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
  shellControlsMock,
  useLoaderDataMock,
} = rstest.hoisted(() => {
  const renders: DashboardPageProps[] = [];
  return {
    attachResourceMediaMock: rstest.fn(),
    browserRunPromiseMock: rstest.fn(),
    dashboardRenders: renders,
    shellControlsMock: rstest.fn(),
    useLoaderDataMock: rstest.fn(),
  };
});

const translations = new Map(
  Object.entries({
    'shell.auth.logout.failed': 'Logout failed',
    'shell.dashboard.unavailable': 'The dashboard is unavailable',
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
    'shell.resource.selection_required': 'Select a legal entity first',
    'shell.resource.timeline.empty': 'No timeline entries yet',
    'shell.resource.timeline.lagging': 'The timeline is catching up',
    'shell.resource.timeline.title': 'Timeline',
    'shell.resource.title': 'Resource',
    'shell.resource.unavailable': 'This resource is unavailable',
  }),
);

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'en',
    t: (key: string) => translations.get(key) ?? key,
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useLoaderData: useLoaderDataMock,
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
  AuthenticatedDashboardLayout: ({
    children,
    ...props
  }: DashboardPageProps & { readonly children: ReactNode }) => {
    dashboardRenders.push(props);
    return (
      <main>
        <h1>{props.title}</h1>
        {children}
      </main>
    );
  },
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
  { blockedText: 'The dashboard is unavailable', shellState: 'unavailable' as const },
  { blockedText: 'Select a legal entity first', shellState: 'anonymous' as const },
])(
  'refuses the whole page for a $shellState shell without a dashboard or an attach seam',
  ({ blockedText, shellState }) => {
    renderResourcePage({ shell: { state: shellState }, state: 'unavailable' });

    expect(screen.getByText(blockedText)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
    expect(dashboardRenders).toHaveLength(0);
    expect(shellControlsMock).toHaveBeenCalledWith(undefined);
    expect(attachResourceMediaMock).not.toHaveBeenCalled();
    expect(browserRunPromiseMock).not.toHaveBeenCalled();
  },
);

const closedStates: readonly { readonly closedText: string; readonly state: ClosedState }[] = [
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
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
    expect(screen.queryByText('Timeline')).toBeNull();
    expect(lastDashboardProps().title).toBe('Resource');
    expect(lastDashboardProps().currentModuleId).toBeUndefined();
    expect(shellControlsMock).toHaveBeenCalledWith(shell);
    expect(attachResourceMediaMock).not.toHaveBeenCalled();
    expect(browserRunPromiseMock).not.toHaveBeenCalled();
  },
);

it('titles the dashboard from the resource and scopes it to the owning module', () => {
  renderResourcePage(readyModel());

  expect(lastDashboardProps().title).toBe('Invoice 42');
  expect(lastDashboardProps().currentModuleId).toBe('billing.invoices');
  expect(screen.getByRole('heading', { level: 2, name: 'Invoice 42' })).toBeTruthy();
  expect(screen.getByText('Status')).toBeTruthy();
  expect(screen.getByText('1 250,00 CZK')).toBeTruthy();
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
  { blockedText: 'Media attachment is unavailable', reason: 'unavailable' as const },
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
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('Attaching media…')).toBeTruthy()),
    );
    expect(attachButton().hasAttribute('disabled')).toBe(true);

    yield* Effect.promise(() => user.click(attachButton()));
    expect(attachResourceMediaMock).toHaveBeenCalledTimes(1);
    expect(browserRunPromiseMock).toHaveBeenCalledTimes(1);

    yield* Deferred.succeed(gate, attachedResponse);
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('Media attached')).toBeTruthy()),
    );
    expect(attachButton().hasAttribute('disabled')).toBe(false);
  }),
);

it.live('attaches media for the loaded resource reference and reports success once', () =>
  Effect.gen(function* attachesMediaForTheLoadedResource() {
    const user = userEvent.setup();
    const model = readyModel();
    renderResourcePage(model);

    yield* Effect.promise(() => user.click(attachButton()));
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('Media attached')).toBeTruthy()),
    );

    expect(attachResourceMediaMock).toHaveBeenCalledTimes(1);
    expect(attachResourceMediaMock).toHaveBeenCalledWith(model.resource.ref);
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
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('Attaching the media failed')).toBeTruthy()),
    );

    expect(screen.queryByText('Media attached')).toBeNull();
    expect(screen.queryByText('Attaching media…')).toBeNull();
    expect(attachButton().hasAttribute('disabled')).toBe(false);
  }),
);

it.live('retries after a failure and replaces the failure status with success', () =>
  Effect.gen(function* retriesAfterAFailure() {
    attachResourceMediaMock.mockReturnValueOnce(Effect.fail(forbiddenProblem));
    const user = userEvent.setup();
    renderResourcePage(readyModel());

    yield* Effect.promise(() => user.click(attachButton()));
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('Attaching the media failed')).toBeTruthy()),
    );

    yield* Effect.promise(() => user.click(attachButton()));
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('Media attached')).toBeTruthy()),
    );

    expect(attachResourceMediaMock).toHaveBeenCalledTimes(2);
    expect(browserRunPromiseMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Attaching the media failed')).toBeNull();
  }),
);
