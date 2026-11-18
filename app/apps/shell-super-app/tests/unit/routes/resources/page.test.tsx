import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';

import {
  ShellNavigationItemSchema,
  ShellReloadRequiredProblemSchema,
  ShellResourceDetailResponseSchema as ShellResourceResponseSchema,
  ShellTargetForbiddenProblemSchema,
} from '../../../../shared/browser-api.ts';
import type {
  MediaAttachmentResponse,
  ShellResourceDetailResponse as ShellResourceResponse,
} from '../../../../shared/browser-api.ts';
import type { ResourcePageModel } from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/resource-page-model.ts';
import ResourcePage from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/page.tsx';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';
import { shellTestCopy } from '../../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../../support/shell-router.tsx';
import type { ShellRouter } from '../../../support/shell-router.tsx';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';

type ReadyModel = Extract<ResourcePageModel, { readonly state: 'ready' }>;
type ClosedState = Exclude<ResourcePageModel['state'], 'ready'>;

const copy = {
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
};

const resourcePath = '/en/resources/billing.invoices/invoice/invoice-42';
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
/** A signed-in Shell whose navigation offers exactly the given destinations. */
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
const shell: ReadyModel['shell'] = shellWithNavigation([
  navigationItem('billing.invoices', 'Billing', '/modules/billing.invoices'),
]);

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

/** The resource route of a real router loading the given model at `path`; the page runs its Effects observed. */
const resourceRouter = (model: ResourcePageModel, path: string = resourcePath) =>
  makeShellRouter({
    page: {
      component: ResourcePage,
      loaderData: () => model,
      path: 'resources/$moduleId/$resourceType/$resourceId',
    },
    url: path,
  });
const renderResourceRoute = (router: ShellRouter) =>
  Effect.gen(function* renderObservedResourceRoute() {
    const runs = rstest.spyOn(browserRuntime, 'runPromise');
    yield* renderShellRoute(router, shellTestCopy('en', copy));
    return runs;
  });
const renderResourcePage = (model: ResourcePageModel) => renderResourceRoute(resourceRouter(model));

/**
 * The record page opened from a search hit: the found title travels in history state, never as evidence that the
 * record exists.
 */
const openFromSearch = (model: ResourcePageModel, searchHitTitle: string, path: string = resourcePath) => {
  window.history.replaceState(null, '', path);
  const router = resourceRouter(model, path);
  router.history.replace(path, { searchHitTitle });
  return renderResourceRoute(router);
};
const recordPath = ({
  moduleId,
  resourceId,
  resourceType,
}: Record<'moduleId' | 'resourceId' | 'resourceType', string>) =>
  `/en/resources/${moduleId}/${resourceType}/${resourceId}`;

/** Every Effect the page has handed to the browser runtime, settled. */
const pageEffectsSettled = (runs: { readonly mock: { readonly results: readonly { readonly value: unknown }[] } }) =>
  Effect.promise(() => Promise.allSettled(runs.mock.results.map((result) => result.value)));

/** The Shell BFF that attaches media, unless a test scripts the attachment otherwise. */
const mediaBff = (attachMedia: ShellBffScript['attachMedia'] = () => Effect.succeed(attachedResponse)) =>
  makeShellBff({ attachMedia });
const attachments = (bff: ReturnType<typeof mediaBff>) =>
  bff.requests.filter((received) => received.endpoint === 'attachMedia').map((received) => received.body);

const mediaSection = () => screen.getByRole('region', { name: 'Media' });
const attachButton = () => within(mediaSection()).getByRole('button');
/** The owning module's destination in the dashboard sidebar. */
const billingLink = () =>
  within(screen.getByRole('navigation', { name: 'shell.dashboard.navigation.label' })).getByRole('link', {
    name: 'Billing',
  });
const dashboardHeading = () => screen.getByRole('heading', { level: 1 });

beforeEach(() => {
  // The browser stands on the resource page, so only the page's own state marks a navigation item current.
  window.history.replaceState(null, '', resourcePath);
});

afterEach(() => {
  cleanup();
  rstest.restoreAllMocks();
});

it.effect.each([
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
  ({ blockedText, shellState }) =>
    Effect.gen(function* refusesTheWholePage() {
      const runs = yield* renderResourcePage({ shell: { state: shellState }, state: 'unavailable' });

      expect(screen.getByText(blockedText)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Media' })).toBeNull();
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(runs).not.toHaveBeenCalled();
    }),
);

it.effect('sends a browser without a live session to sign-in instead of a bare error line', () =>
  Effect.gen(function* signInRedirect() {
    const router = resourceRouter({
      shell: { reason: 'account_forbidden', state: 'anonymous' },
      state: 'selection_required',
    });
    const navigations = rstest.spyOn(router, 'navigate');
    const runs = yield* renderResourceRoute(router);

    expect(navigations).toHaveBeenCalledWith(
      // Sign-in returns to the record page the browser stands on.
      expect.objectContaining({
        href: `/en/login?returnTo=${encodeURIComponent(resourcePath)}&reason=account_forbidden`,
        replace: true,
      }),
    );
    expect(screen.getByText('shell.moduleTarget.sign_in_required')).toBeTruthy();
    expect(screen.queryByText('Select a legal entity first')).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(runs).not.toHaveBeenCalled();
  }),
);

it.effect('refuses media attachment when document hydration requires a reload', () =>
  Effect.gen(function* refusesAStaleDocument() {
    // The document was rendered by another release than the one this model was composed for.
    yield* pinDocumentCompositionRevision('1'.repeat(64), document);
    const runs = yield* renderResourcePage({
      ...readyModel(),
      shell: { ...shell, compositionRevision: '2'.repeat(64) },
    });

    expect(screen.getByText('Reload this page to continue')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(runs).not.toHaveBeenCalled();
  }),
);

const closedStates: readonly {
  readonly closedText: string;
  readonly state: ClosedState;
}[] = [
  { closedText: 'You cannot open this resource', state: 'forbidden' },
  { closedText: 'This resource does not exist', state: 'not_found' },
  { closedText: 'Select a legal entity first', state: 'selection_required' },
  { closedText: 'This resource is unavailable', state: 'unavailable' },
];

it.effect.each(closedStates)(
  'keeps a $state resource inside the dashboard with no media seam at all',
  ({ closedText, state }) =>
    Effect.gen(function* closedResource() {
      const runs = yield* renderResourcePage({ shell, state });

      expect(screen.getByText(closedText)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Media' })).toBeNull();
      expect(screen.queryByText('Media')).toBeNull();
      expect(screen.queryByText('Timeline')).toBeNull();
      // A record page names the missing record, not a missing page; the panel below it has no second heading.
      expect(dashboardHeading().textContent).toBe(
        new Map([
          ['not_found', 'shell.recovery.recordMissing'],
          ['forbidden', 'shell.recovery.forbidden'],
        ]).get(state) ?? 'shell.recovery.unavailable',
      );
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(billingLink().getAttribute('aria-current')).toBeNull();
      expect(screen.getByRole('combobox', { name: 'shell.dashboard.tenant.accessibleLabel' })).toBeTruthy();
      expect(runs).not.toHaveBeenCalled();
    }),
);

it.effect('offers the owning module agendas when the Shell cannot show the record itself', () =>
  Effect.gen(function* owningAgendas() {
    yield* renderResourcePage({
      shell: shellWithNavigation([
        navigationItem('billing.invoices', 'Invoices', '/finance/invoices'),
        navigationItem('crm.records', 'Customers', '/crm'),
      ]),
      state: 'not_found',
    });

    const agendas = screen.getByRole('navigation', { name: 'Open in its agenda' });
    expect([...agendas.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Invoices', '/en/finance/invoices'],
    ]);
  }),
);

const financeInvoice = {
  moduleId: 'finance.billing',
  resourceId: '00000000-0000-4000-8000-000000000401',
  resourceType: 'finance.billing.invoice',
};

it.effect.each([
  { closedText: 'This resource does not exist', state: 'not_found' as const, titleKey: 'shell.recovery.recordMissing' },
  { closedText: 'This resource is unavailable', state: 'unavailable' as const, titleKey: 'shell.recovery.unavailable' },
  { closedText: 'You cannot open this resource', state: 'forbidden' as const, titleKey: 'shell.recovery.forbidden' },
])('never renders a $state record from a search history title', ({ closedText, state, titleKey }) =>
  Effect.gen(function* closedSearchHit() {
    yield* openFromSearch(
      { shell: shellWithNavigation([navigationItem('finance.billing', 'Faktury', '/finance')]), state },
      'Faktura 2026/14',
      recordPath(financeInvoice),
    );

    expect(dashboardHeading().textContent).toBe(titleKey);
    expect(screen.getByText(closedText)).toBeTruthy();
    expect(screen.queryByText('Faktura 2026/14')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the record' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
    expect(screen.queryByText('Media')).toBeNull();
    expect(screen.queryByText('Timeline')).toBeNull();
    expect(screen.queryByText('Status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' }) === null).toBe(state !== 'unavailable');
    expect(screen.queryByRole('navigation', { name: 'Open in its agenda' }) === null).toBe(state === 'forbidden');
  }),
);

it.effect('links a facility record only to its agenda, never to a record page or the searched title', () =>
  Effect.gen(function* facilityRecord() {
    const company = authenticatedShellFixture().selectedLegalEntityId ?? '';
    yield* openFromSearch(
      {
        shell: shellWithNavigation([navigationItem('facility.operations', 'Majetek', '/provoz/majetek')]),
        state: 'not_found',
      },
      'Plynová kotelna',
      recordPath({
        moduleId: 'facility.operations',
        resourceId: `${company}.TEC-001`,
        resourceType: 'facility.operations.asset',
      }),
    );

    expect(dashboardHeading().textContent).toBe('shell.recovery.recordMissing');
    expect(screen.getByText('This resource does not exist')).toBeTruthy();
    expect(screen.queryByText('Plynová kotelna')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the record' })).toBeNull();
    const agendas = screen.getByRole('navigation', { name: 'Open in its agenda' });
    expect(within(agendas).getByRole('link', { name: 'Majetek' }).getAttribute('href')).toBe('/en/provoz/majetek');
    expect(document.body.textContent).not.toContain('TEC-001');
  }),
);

it.effect('links a person only to people administration, without treating the search title as the record', () =>
  Effect.gen(function* personRecord() {
    const person = recordPath({
      moduleId: 'core.identity',
      resourceId: '00000000-0000-4000-8000-000000000201.00000000-0000-4000-8000-000000000001',
      resourceType: 'core.identity.person',
    });
    yield* openFromSearch(
      {
        agendaPaths: ['/sprava/lide-a-role'],
        shell: shellWithNavigation([
          navigationItem('shell-super-app', 'People and roles', '/sprava/lide-a-role'),
          navigationItem('billing.invoices', 'Invoices', '/finance'),
        ]),
        state: 'not_found',
      },
      'Jana Nováková',
      person,
    );
    expect(dashboardHeading().textContent).toBe('shell.recovery.recordMissing');
    expect(screen.queryByText('Jana Nováková')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the record' })).toBeNull();
    const agendas = screen.getByRole('navigation', { name: 'Open in its agenda' });
    expect([...agendas.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/en/sprava/lide-a-role',
    ]);
    cleanup();

    yield* openFromSearch(
      { shell: shellWithNavigation([navigationItem('billing.invoices', 'Invoices', '/finance')]), state: 'not_found' },
      'Jana Nováková',
      person,
    );
    expect(screen.queryByRole('navigation', { name: 'Open in its agenda' })).toBeNull();
    expect(screen.getByText('This resource does not exist')).toBeTruthy();
  }),
);

it.effect('explains a record type without a Shell detail view instead of inventing a missing record', () =>
  Effect.gen(function* unsupportedDetail() {
    yield* openFromSearch(
      {
        detailSupport: 'not_supported',
        shell: shellWithNavigation([navigationItem('party.registry', 'Zákazníci', '/prodej/zakaznici')]),
        state: 'unavailable',
      },
      'Petr Dvořák',
      recordPath({
        moduleId: 'party.registry',
        resourceId: 'ea2200ab-4308-491e-8e33-ca3871a8fa55',
        resourceType: 'party.registry.party',
      }),
    );

    expect(dashboardHeading().textContent).toBe('Record details are not available here');
    expect(
      screen.getByText('This app has no record view for this type yet. Open the agenda it belongs to.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to home' })).toBeTruthy();
    const agendas = screen.getByRole('navigation', { name: 'Open in its agenda' });
    expect(within(agendas).getByRole('link', { name: 'Zákazníci' }).getAttribute('href')).toBe('/en/prodej/zakaznici');
    expect(screen.queryByText('Petr Dvořák')).toBeNull();
    expect(screen.queryByText('This resource is unavailable')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
    expect(screen.queryByText('Status')).toBeNull();
    expect(screen.queryByText('Timeline')).toBeNull();
  }),
);

it.effect(
  'titles the dashboard from the authorized detail, scopes it to the owning module and ignores a history title',
  () =>
    Effect.gen(function* titlesTheDashboard() {
      yield* openFromSearch(readyModel(), 'Faktura 2026/14');

      expect(dashboardHeading().textContent).toBe('Invoice 42');
      expect(billingLink().getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('heading', { level: 2, name: 'Invoice 42' })).toBeTruthy();
      expect(screen.getByText('Status')).toBeTruthy();
      expect(screen.getByText('1 250,00 CZK')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Attach media' })).toBeTruthy();
      expect(screen.getByText('2026-01-02T03:04:05.000Z')).toBeTruthy();
      expect(screen.queryByText('Faktura 2026/14')).toBeNull();
    }),
);

it.effect('renders one timeline entry per projection row with its ISO instant', () =>
  Effect.gen(function* timelineEntries() {
    yield* renderResourcePage(readyModel());

    expect(screen.getByText('2026-01-02T03:04:05.000Z')).toBeTruthy();
    expect(screen.getByText(/Invoice issued/u)).toBeTruthy();
    expect(screen.queryByText('No timeline entries yet')).toBeNull();
    expect(screen.queryByText('The timeline is catching up')).toBeNull();
  }),
);

it.effect('announces an empty and a lagging timeline projection', () =>
  Effect.gen(function* laggingTimeline() {
    yield* renderResourcePage(readyModel(resourceFixture({ projectionLagging: true, timeline: [] })));

    expect(screen.getByText('No timeline entries yet')).toBeTruthy();
    expect(screen.getByText('The timeline is catching up')).toBeTruthy();
  }),
);

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
  ({ blockedText, reason }) => {
    const bff = mediaBff();
    return Effect.gen(function* refusesADisabledAttachSeam() {
      const user = userEvent.setup();
      const runs = yield* renderResourcePage(readyModel(resourceFixture({ media: { enabled: false, reason } })));

      expect(screen.getByText(blockedText)).toBeTruthy();
      expect(attachButton().hasAttribute('disabled')).toBe(true);

      yield* Effect.promise(() => user.click(attachButton()));

      expect(runs).not.toHaveBeenCalled();
      expect(bff.requests).toEqual([]);
      expect(screen.queryByText('Media attached')).toBeNull();
      expect(screen.queryByText('Attaching the media failed')).toBeNull();
    }).pipe(Effect.provide(bff.browser));
  },
);

it.live(
  'marks the attachment pending inside the very click that starts it, and starts it once for a double click',
  () =>
    Effect.gen(function* pendingWithinTheClick() {
      const gate = yield* Deferred.make<MediaAttachmentResponse>();
      const bff = mediaBff(() => Deferred.await(gate));
      yield* Effect.gen(function* doubleClick() {
        const runs = yield* renderResourcePage(readyModel());

        act(() => {
          attachButton().click();
        });

        expect(attachButton().hasAttribute('disabled')).toBe(true);
        expect(screen.getByText('Attaching media…')).toBeTruthy();

        act(() => {
          attachButton().click();
        });
        expect(runs).toHaveBeenCalledTimes(1);

        yield* Deferred.succeed(gate, attachedResponse);
        yield* pageEffectsSettled(runs);
        expect(attachments(bff)).toHaveLength(1);
      }).pipe(Effect.provide(bff.browser));
    }),
);

it.live('holds the attach seam disabled for the whole in-flight attachment', () =>
  Effect.gen(function* holdsTheAttachSeamDisabled() {
    const gate = yield* Deferred.make<MediaAttachmentResponse>();
    const bff = mediaBff(() => Deferred.await(gate));
    yield* Effect.gen(function* inFlight() {
      const user = userEvent.setup();
      const runs = yield* renderResourcePage(readyModel());

      yield* Effect.promise(() => user.click(attachButton()));
      yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Attaching media…')).toBeTruthy()));
      expect(attachButton().hasAttribute('disabled')).toBe(true);

      yield* Effect.promise(() => user.click(attachButton()));
      expect(runs).toHaveBeenCalledTimes(1);

      yield* Deferred.succeed(gate, attachedResponse);
      yield* pageEffectsSettled(runs);
      yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Media attached')).toBeTruthy()));
      expect(attachButton().hasAttribute('disabled')).toBe(false);
      expect(attachments(bff)).toHaveLength(1);
    }).pipe(Effect.provide(bff.browser));
  }),
);

it.live('attaches media for the loaded resource reference and reports success once', () => {
  const bff = mediaBff();
  return Effect.gen(function* attachesMediaForTheLoadedResource() {
    const user = userEvent.setup();
    const model = readyModel();
    const runs = yield* renderResourcePage(model);

    yield* Effect.promise(() => user.click(attachButton()));
    yield* pageEffectsSettled(runs);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Media attached')).toBeTruthy()));

    expect(attachments(bff)).toEqual([
      {
        ...model.resource.ref,
        compositionRevision: shell.state === 'authenticated' ? shell.compositionRevision : undefined,
      },
    ]);
    expect(screen.queryByText('Attaching media…')).toBeNull();
    expect(screen.queryByText('Attaching the media failed')).toBeNull();
    expect(attachButton().hasAttribute('disabled')).toBe(false);
  }).pipe(Effect.provide(bff.browser));
});

it.live('settles a typed attachment failure into its own status without a defect', () => {
  const bff = mediaBff(() => Effect.fail(forbiddenProblem));
  return Effect.gen(function* settlesATypedAttachmentFailure() {
    const user = userEvent.setup();
    const runs = yield* renderResourcePage(readyModel());

    yield* Effect.promise(() => user.click(attachButton()));
    yield* pageEffectsSettled(runs);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Attaching the media failed')).toBeTruthy()));

    expect(screen.queryByText('Media attached')).toBeNull();
    expect(screen.queryByText('Attaching media…')).toBeNull();
    expect(attachButton().hasAttribute('disabled')).toBe(false);
  }).pipe(Effect.provide(bff.browser));
});

it.live('removes the media seam when attachment admission requires a fresh document', () => {
  const bff = mediaBff(() => Effect.fail(reloadRequiredProblem));
  return Effect.gen(function* staleAttachmentRequiresANewDocument() {
    const user = userEvent.setup();
    const runs = yield* renderResourcePage(readyModel());

    yield* Effect.promise(() => user.click(attachButton()));
    yield* pageEffectsSettled(runs);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Reload this page to continue')).toBeTruthy()));

    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach media' })).toBeNull();
    expect(screen.queryByText('Media attached')).toBeNull();
    expect(attachments(bff)).toHaveLength(1);
  }).pipe(Effect.provide(bff.browser));
});

it.live('retries after a failure and replaces the failure status with success', () => {
  let attempts = 0;
  const bff = mediaBff(() =>
    Effect.suspend(() => {
      attempts += 1;
      return attempts === 1 ? Effect.fail(forbiddenProblem) : Effect.succeed(attachedResponse);
    }),
  );
  return Effect.gen(function* retriesAfterAFailure() {
    const user = userEvent.setup();
    const runs = yield* renderResourcePage(readyModel());

    yield* Effect.promise(() => user.click(attachButton()));
    yield* pageEffectsSettled(runs);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Attaching the media failed')).toBeTruthy()));

    yield* Effect.promise(() => user.click(attachButton()));
    yield* pageEffectsSettled(runs);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText('Media attached')).toBeTruthy()));

    expect(attachments(bff)).toHaveLength(2);
    expect(runs).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Attaching the media failed')).toBeNull();
  }).pipe(Effect.provide(bff.browser));
});
