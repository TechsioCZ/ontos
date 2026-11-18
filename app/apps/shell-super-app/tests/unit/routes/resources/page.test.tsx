import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';

import {
  ShellNavigationItemSchema,
  ShellReloadRequiredProblemSchema,
  ShellResourceResponseSchema,
  ShellTargetForbiddenProblemSchema,
} from '../../../../shared/browser-api.ts';
import type { MediaAttachmentResponse, ShellResourceResponse } from '../../../../shared/browser-api.ts';
import type { ResourcePageModel } from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/resource-page-model.ts';
import ResourcePage from '../../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/page.tsx';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts';
import { makeShellBff } from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';
import { shellTestCopy } from '../../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../../support/shell-router.tsx';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';

type ReadyModel = Extract<ResourcePageModel, { readonly state: 'ready' }>;
type ClosedState = Exclude<ResourcePageModel['state'], 'ready'>;

const copy = {
  'shell.auth.logout.failed': 'Logout failed',
  'shell.dashboard.unavailable': 'The dashboard is unavailable',
  'shell.moduleTarget.reload_required': 'Reload this page to continue',
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
};

const resourcePath = '/en/resources/billing.invoices/invoice/invoice-42';
const billingNavigation = Schema.decodeUnknownSync(ShellNavigationItemSchema)({
  appId: 'billing-app',
  enabled: true,
  groupKey: 'shell.navigation.modules',
  href: '/modules/billing.invoices',
  label: 'Billing',
  moduleId: 'billing.invoices',
  order: 10,
  state: 'active',
  unavailable: false,
  writable: true,
});
const authenticatedShell = authenticatedShellFixture();
const shell: ReadyModel['shell'] = {
  ...authenticatedShell,
  navigation: { items: [billingNavigation], state: 'available', unavailableDeployments: [] },
};

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

/** The resource route of a real router loading the given model; the page runs its Effects observed. */
const renderResourcePage = (model: ResourcePageModel) =>
  Effect.gen(function* renderResourceRoute() {
    const runs = rstest.spyOn(browserRuntime, 'runPromise');
    yield* renderShellRoute(
      makeShellRouter({
        page: {
          component: ResourcePage,
          loaderData: () => model,
          path: 'resources/$moduleId/$resourceType/$resourceId',
        },
        url: resourcePath,
      }),
      shellTestCopy('en', copy),
    );
    return runs;
  });

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
const billingLink = () => screen.getByRole('link', { name: 'Billing' });
const dashboardHeading = () => screen.getByRole('heading', { level: 1 });

beforeEach(() => {
  // The browser stands on the resource page, so only the page's own state marks a navigation item current.
  window.history.replaceState(null, '', resourcePath);
});

afterEach(cleanup);

it.effect.each([
  {
    blockedText: 'Reload this page to continue',
    shellState: 'reload_required' as const,
  },
  {
    blockedText: 'The dashboard is unavailable',
    shellState: 'unavailable' as const,
  },
  {
    blockedText: 'Select a legal entity first',
    shellState: 'anonymous' as const,
  },
])(
  'refuses the whole page for a $shellState shell without a dashboard or an attach seam',
  ({ blockedText, shellState }) =>
    Effect.gen(function* refusesTheWholePage() {
      const runs = yield* renderResourcePage({ shell: { state: shellState }, state: 'unavailable' });

      expect(screen.getByText(blockedText)).toBeTruthy();
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByRole('region', { name: 'Media' })).toBeNull();
      expect(screen.queryByRole('complementary')).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
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
    expect(screen.queryByRole('button')).toBeNull();
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
      expect(screen.queryByRole('region', { name: 'Media' })).toBeNull();
      expect(screen.queryByText('Media')).toBeNull();
      expect(screen.queryByText('Timeline')).toBeNull();
      expect(dashboardHeading().textContent).toBe('Resource');
      expect(billingLink().getAttribute('aria-current')).toBeNull();
      expect(screen.getByRole('combobox', { name: 'shell.dashboard.tenant.accessibleLabel' })).toBeTruthy();
      expect(runs).not.toHaveBeenCalled();
    }),
);

it.effect('titles the dashboard from the resource and scopes it to the owning module', () =>
  Effect.gen(function* titlesTheDashboard() {
    yield* renderResourcePage(readyModel());

    expect(dashboardHeading().textContent).toBe('Invoice 42');
    expect(billingLink().getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 2, name: 'Invoice 42' })).toBeTruthy();
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('1 250,00 CZK')).toBeTruthy();
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

    expect(screen.queryByRole('button')).toBeNull();
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
