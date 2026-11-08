import { getDocumentCompositionRevision } from '@app/shared-contracts';
import { CatchBoundary } from '@tanstack/react-router' with { rstest: 'importActual' };
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, rstest, it } from 'effect-rstest';
import type { HTMLAttributes, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';

import type { ModulePageProps } from '@app/shared-contracts/page-data';

import { ResolvedModuleTargetSchema, SafeTenantIdentitySchema } from '../../../../shared/api.ts';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts';
import {
  moduleEntrypointLoadIdentity,
  pinBrowserModuleTarget,
} from '../../../../src/routes/module-entrypoint-loader.ts';
import { ModuleRenderFailure } from '../../../../src/routes/module-render-failure.tsx';
import type { ModuleTargetPageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';
import ModuleTargetPage, { ModuleTargetView } from '../../../../src/routes/[lang]/modules/[moduleId]/page.tsx';
import { prepareModulePage } from '../../../../src/routes/remote-page-loader.ts';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';

type ResolvedPageModel = Extract<ModuleTargetPageModel, { readonly state: 'resolved' }>;

const {
  getInstanceMock,
  loadRemotePageMock,
  navigateMock,
  registerRemotesMock,
  reloadRequiredMock,
  remotePropsMock,
  useLoaderDataMock,
} = rstest.hoisted(() => ({
  getInstanceMock: rstest.fn(),
  loadRemotePageMock: rstest.fn(),
  navigateMock: rstest.fn(),
  registerRemotesMock: rstest.fn(),
  reloadRequiredMock: rstest.fn(),
  remotePropsMock: rstest.fn(),
  useLoaderDataMock: rstest.fn(),
}));

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'en', t: (key: string) => key }),
}));

rstest.mock('@tanstack/react-router', () => ({
  CatchBoundary,
  useLoaderData: useLoaderDataMock,
  useNavigate: () => navigateMock,
}));

rstest.mock('@techsio/ui-kit/atoms/status-text', () => ({
  StatusText: ({ children, role }: HTMLAttributes<HTMLSpanElement>) => <span role={role}>{children}</span>,
}));

rstest.mock('@module-federation/modern-js-v3/runtime', () => ({ getInstance: getInstanceMock }));

rstest.mock('../../../../src/routes/shell-frame.tsx', () => ({
  AuthenticatedDashboardLayout: ({ children }: { readonly children: ReactNode }) => (
    <main data-testid="shell-framing">{children}</main>
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
    reloadRequired: reloadRequiredMock(),
    tenantSwitchFailed: false,
    tenantSwitchPending: false,
  }),
}));

const shell: ResolvedPageModel['shell'] = { ...authenticatedShellFixture(), compositionRevision: 'c'.repeat(64) };

/**
 * Loaded page modules stay loaded for the document (a revisit renders at once), so every test opens its own remote:
 * a remote loaded by one test must not make the next test's first load a revisit.
 */
let remoteSequence = 0;
let remoteName = 'previouslyUnknownContacts0';

const targetFixture = (componentKey: string, entrypointKey: string, writable = true) =>
  Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    appId: 'contacts',
    componentKey,
    compositionRevision: 'c'.repeat(64),
    entrypointKey,
    federation: {
      expose: `./${componentKey}`,
      manifest: {
        sha256: 'a'.repeat(64),
        url: 'https://assets.example.test/contacts/release-a/mf-manifest.json',
      },
      remoteName,
    },
    moduleId: 'contacts.core',
    routeParameters: {},
    writable,
  });

const makeResolvedModel = (): ResolvedPageModel => ({
  routeParams: { id: 'customer-1' },
  search: '?tab=open',
  shell,
  state: 'resolved',
  target: targetFixture('contacts.core.page-customers', 'contacts.core.page.customers'),
});
let resolvedModel = makeResolvedModel();

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
    renderedText: 'contacts.core.page-customer-detail:11111111-1111-4111-8111-111111111111',
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
    renderedText: 'contacts.core.page-contact-detail:11111111-1111-4111-8111-111111111111',
    routeParams: {
      contactId: '33333333-3333-4333-8333-333333333333',
      id: '11111111-1111-4111-8111-111111111111',
    },
    writable: true,
  },
  {
    componentKey: 'contacts.core.page-contact-edit',
    entrypointKey: 'contacts.core.page.contact-edit',
    renderedText: 'contacts.core.page-contact-edit:11111111-1111-4111-8111-111111111111',
    routeParams: {
      contactId: '33333333-3333-4333-8333-333333333333',
      id: '11111111-1111-4111-8111-111111111111',
    },
    writable: false,
  },
  {
    componentKey: 'contacts.core.page-contact-create',
    entrypointKey: 'contacts.core.page.contact-create',
    renderedText: 'contacts.core.page-contact-create:11111111-1111-4111-8111-111111111111',
    routeParams: { id: '11111111-1111-4111-8111-111111111111' },
    writable: false,
  },
];

const fixtureRemotePage = ({
  routeParams,
  target,
}: {
  readonly routeParams: Readonly<Record<string, string>>;
  readonly target: ResolvedPageModel['target'];
}) => {
  remotePropsMock({ routeParams, target });
  return <div>{`${target.componentKey}:${routeParams['id'] ?? 'static'}`}</div>;
};

const FailingRemoteFixture = (): never => {
  throw new Error('1296_PRIVATE_RENDER_SENTINEL');
};

const blockedPageFixture = (index: number) => {
  const appId = `load-blocker-${index}`;
  const componentKey = `${appId}.core.page`;
  const blockerRemoteName = `loadBlocker${index}`;
  const target = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    ...targetFixture(componentKey, `${appId}.core.page.show`),
    appId,
    federation: {
      expose: `./${componentKey}`,
      manifest: {
        sha256: 'a'.repeat(64),
        url: `https://assets.example.test/${appId}/release-a/mf-manifest.json`,
      },
      remoteName: blockerRemoteName,
    },
    moduleId: `${appId}.core`,
  });
  return {
    model: { ...resolvedModel, target },
    pending: Promise.withResolvers<{ readonly default: typeof fixtureRemotePage }>(),
    request: `${blockerRemoteName}/${componentKey}`,
  };
};

beforeEach(() => {
  rstest.resetAllMocks();
  remoteSequence += 1;
  remoteName = `previouslyUnknownContacts${remoteSequence}`;
  resolvedModel = makeResolvedModel();
  navigateMock.mockImplementation(() => Promise.resolve());
  reloadRequiredMock.mockReturnValue(false);
  loadRemotePageMock.mockResolvedValue({ default: fixtureRemotePage });
  getInstanceMock.mockReturnValue({
    loadRemote: loadRemotePageMock,
    name: 'shellSuperApp',
    registerRemotes: registerRemotesMock,
  });
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

it('sends an anonymous visitor of a protected module to sign-in and back', () => {
  window.history.replaceState(null, '', '/en/prehledy/statistiky?group=month');
  useLoaderDataMock.mockReturnValue({
    shell: { state: 'anonymous' },
    state: 'selection_required',
  } satisfies ModuleTargetPageModel);
  render(<ModuleTargetPage />);
  expect(navigateMock).toHaveBeenCalledWith({
    href: '/en/login?returnTo=%2Fen%2Fprehledy%2Fstatistiky%3Fgroup%3Dmonth',
    replace: true,
  });
  expect(screen.getByText('shell.moduleTarget.sign_in_required')).toBeTruthy();
  expect(screen.queryByText('shell.moduleTarget.selection_required')).toBeNull();
  window.history.replaceState(null, '', '/');
});

it.each(['selection_required', 'forbidden', 'not_found', 'reload_required', 'unavailable'] as const)(
  'does not initialize or load Federation for a %s exact-page response',
  (state) => {
    useLoaderDataMock.mockReturnValue({
      shell,
      state,
    } satisfies ModuleTargetPageModel);
    render(<ModuleTargetPage />);
    expect(getInstanceMock).not.toHaveBeenCalled();
    expect(registerRemotesMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).not.toHaveBeenCalled();
  },
);

it.live('does not register or load an owner when disposed during native SDK acquisition', () =>
  Effect.gen(function* disposesBeforeNativeSdkSettles() {
    // Build the real shared runtime first so its initial service acquisition cannot delay the pin.
    yield* browserRuntime.contextEffect;
    useLoaderDataMock.mockReturnValue(resolvedModel);
    const view = render(<ModuleTargetPage />);
    const revision = yield* getDocumentCompositionRevision(document);
    expect(revision).toBe('c'.repeat(64));
    expect(getInstanceMock).not.toHaveBeenCalled();

    act(() => view.unmount());
    const sdk = yield* Effect.tryPromise(() => import('@module-federation/modern-js-v3/runtime'));
    expect(sdk.getInstance).toBe(getInstanceMock);
    yield* Effect.promise(() =>
      act(async () => {
        await Promise.resolve();
      }),
    );

    expect(getInstanceMock).not.toHaveBeenCalled();
    expect(registerRemotesMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).not.toHaveBeenCalled();
    expect(remotePropsMock).not.toHaveBeenCalled();
  }),
);

it.live('registers and loads a previously unknown approved remote only after authentication', () =>
  Effect.gen(function* invokesTheExactPrivatePageLoader() {
    useLoaderDataMock.mockReturnValue(resolvedModel);
    render(<ModuleTargetPage />);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(registerRemotesMock).toHaveBeenCalledWith([
      {
        entry: resolvedModel.target.federation.manifest.url,
        name: resolvedModel.target.federation.remoteName,
      },
    ]);
    expect(loadRemotePageMock).toHaveBeenCalledWith(`${remoteName}/contacts.core.page-customers`);
    expect(yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'))).toBeTruthy();
  }),
);

it.live('maps an unreachable approved remote to its safe local diagnostic', () =>
  Effect.gen(function* mapsAnUnreachableApprovedRemoteTo() {
    loadRemotePageMock.mockRejectedValue(new Error('private remote error'));
    useLoaderDataMock.mockReturnValue(resolvedModel);

    render(<ModuleTargetPage />);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.unavailable'))).toBeTruthy();
  }),
);

it.live('contains a remote render exception while the Shell framing and healthy exposed page remain mounted', () =>
  Effect.gen(function* containsOnlyTheFailedRemoteTree() {
    const healthyModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'healthy-owner' },
      target: targetFixture('contacts.core.page-customer-detail', 'contacts.core.page.customer-detail'),
    };
    loadRemotePageMock.mockResolvedValueOnce({ default: FailingRemoteFixture });

    render(<ModuleTargetView initialModel={resolvedModel} />);
    render(<ModuleTargetView initialModel={healthyModel} />);

    expect((yield* Effect.promise(() => screen.findByRole('alert'))).textContent).toContain(
      'shell.moduleTarget.render_failed',
    );
    expect(
      yield* Effect.promise(() => screen.findByText('contacts.core.page-customer-detail:healthy-owner')),
    ).toBeTruthy();
    expect(screen.getAllByTestId('shell-framing')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'shell.moduleTarget.reload_page' }).getAttribute('type')).toBe('button');
    expect(document.body.textContent).not.toContain('1296_PRIVATE_RENDER_SENTINEL');
  }),
);

it.live('keeps a failed equivalent target contained and resets only for the newly approved expose', () =>
  Effect.gen(function* resetsForTheExactApprovedExposedResult() {
    loadRemotePageMock.mockResolvedValueOnce({ default: FailingRemoteFixture });
    const view = render(<ModuleTargetView initialModel={resolvedModel} />);
    yield* Effect.promise(() => screen.findByRole('alert'));
    const equivalentModel: ResolvedPageModel = {
      ...resolvedModel,
      target: targetFixture(resolvedModel.target.componentKey, resolvedModel.target.entrypointKey),
    };

    view.rerender(<ModuleTargetView initialModel={equivalentModel} />);

    expect(screen.getByRole('alert').textContent).toContain('shell.moduleTarget.render_failed');
    expect(loadRemotePageMock).toHaveBeenCalledTimes(1);
    const nextModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'correct-next-expose' },
      target: targetFixture('contacts.core.page-customer-detail', 'contacts.core.page.customer-detail'),
    };
    view.rerender(<ModuleTargetView initialModel={nextModel} />);

    expect(
      yield* Effect.promise(() => screen.findByText('contacts.core.page-customer-detail:correct-next-expose')),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(loadRemotePageMock).toHaveBeenCalledTimes(2);
    expect(loadRemotePageMock).toHaveBeenLastCalledWith(`${remoteName}/contacts.core.page-customer-detail`);
  }),
);

it.live('requests a full document reload instead of locally executing the failed entrypoint again', () =>
  Effect.gen(function* recoveryRequiresFreshDocumentAdmission() {
    loadRemotePageMock.mockResolvedValueOnce({ default: FailingRemoteFixture });
    const view = render(<ModuleTargetView initialModel={resolvedModel} />);
    yield* Effect.promise(() => screen.findByRole('alert'));

    yield* Effect.promise(() =>
      userEvent.setup().click(screen.getByRole('button', { name: 'shell.moduleTarget.reload_page' })),
    );
    yield* Effect.promise(() =>
      waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ reloadDocument: true, to: '.' })),
    );
    expect(loadRemotePageMock).toHaveBeenCalledTimes(1);
    // The navigation driver is controlled here. The browser test proves actual document
    // replacement and native permission revocation; this unit supplies its denied model.
    view.rerender(<ModuleTargetView initialModel={{ shell, state: 'forbidden' }} />);

    expect(screen.getByText('shell.moduleTarget.forbidden')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(loadRemotePageMock).toHaveBeenCalledTimes(1);
  }),
);

it.live('never restores previous caller content when a changed tenant and principal receive a typed denial', () =>
  Effect.gen(function* keepsCurrentContextDenialsOutsideTheBoundary() {
    const view = render(<ModuleTargetView initialModel={resolvedModel} />);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'));
    loadRemotePageMock.mockResolvedValueOnce({ default: FailingRemoteFixture });
    view.rerender(
      <ModuleTargetView
        initialModel={{
          ...resolvedModel,
          target: targetFixture('contacts.core.page-customer-detail', 'contacts.core.page.customer-detail'),
        }}
      />,
    );
    yield* Effect.promise(() => screen.findByRole('alert'));
    const deniedShell: ResolvedPageModel['shell'] = {
      ...shell,
      identity: Schema.decodeUnknownSync(SafeTenantIdentitySchema)({
        ...shell.identity,
        principalId: 'current-principal',
        tenantId: 'current-tenant',
      }),
    };
    remotePropsMock.mockClear();

    view.rerender(<ModuleTargetView initialModel={{ shell: deniedShell, state: 'forbidden' }} />);

    expect(screen.getByText('shell.moduleTarget.forbidden')).toBeTruthy();
    expect(screen.queryByText('contacts.core.page-customers:customer-1')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(remotePropsMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).toHaveBeenCalledTimes(2);
  }),
);

it.live(
  'resets the actual framework boundary for a separately pinned R2 DOM document in a controlled reset-key test',
  () =>
    Effect.gen(function* checksRevisionResetWithoutClaimingBrowserNavigation() {
      const nextTarget = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
        ...resolvedModel.target,
        compositionRevision: 'd'.repeat(64),
      });
      const nextDocument = document.implementation.createHTMLDocument();
      yield* pinBrowserModuleTarget(nextTarget, nextDocument);
      expect(yield* getDocumentCompositionRevision(nextDocument)).toBe(nextTarget.compositionRevision);
      const view = render(
        <CatchBoundary
          errorComponent={() => (
            <ModuleRenderFailure
              onReload={() => {
                navigateMock();
              }}
            />
          )}
          getResetKey={() => moduleEntrypointLoadIdentity(resolvedModel.target).result}
        >
          <FailingRemoteFixture />
        </CatchBoundary>,
      );
      expect(screen.getByRole('alert').textContent).toContain('shell.moduleTarget.render_failed');
      // This exercises the real boundary's reset with controlled approved-target fixtures,
      // not a browser navigation or publication proof. The existing R1 document stays pinned.
      view.rerender(
        <CatchBoundary
          errorComponent={() => (
            <ModuleRenderFailure
              onReload={() => {
                navigateMock();
              }}
            />
          )}
          getResetKey={() => moduleEntrypointLoadIdentity(nextTarget).result}
        >
          <div>controlled R2 result</div>
        </CatchBoundary>,
      );
      expect(screen.getByText('controlled R2 result')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(yield* getDocumentCompositionRevision(document)).toBe(resolvedModel.target.compositionRevision);
    }),
);

it.live(
  'keeps a caller load timeout as its typed diagnostic rather than a render failure',
  () =>
    Effect.gen(function* separatesLoadTimeoutFromRenderFailure() {
      const pending = Promise.withResolvers<{ readonly default: typeof fixtureRemotePage }>();
      loadRemotePageMock.mockReturnValueOnce(pending.promise);
      try {
        render(<ModuleTargetView initialModel={resolvedModel} />);
        expect(
          yield* Effect.promise(() => screen.findByText('shell.moduleTarget.timeout', {}, { timeout: 7000 })),
        ).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByRole('button', { name: 'shell.moduleTarget.reload_page' })).toBeNull();
      } finally {
        yield* Effect.promise(() =>
          act(async () => {
            pending.resolve({ default: fixtureRemotePage });
            await pending.promise;
          }),
        );
      }
    }),
  15_000,
);

it.live('shares equivalent cloned targets while an unmounted caller cannot cancel the remaining page', () =>
  Effect.gen(function* sharesPhysicalWorkAcrossIndependentPages() {
    const pending = Promise.withResolvers<{ readonly default: typeof fixtureRemotePage }>();
    loadRemotePageMock.mockReturnValueOnce(pending.promise);
    const secondModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'second-caller' },
      target: targetFixture(resolvedModel.target.componentKey, resolvedModel.target.entrypointKey, false),
    };
    expect(secondModel.target).not.toBe(resolvedModel.target);
    try {
      const first = render(<ModuleTargetView initialModel={resolvedModel} />);
      render(<ModuleTargetView initialModel={secondModel} />);
      yield* Effect.promise(() => waitFor(() => expect(getInstanceMock).toHaveBeenCalledTimes(1)));
      expect(document.querySelectorAll('[data-module-page-skeleton]')).toHaveLength(2);
      expect(loadRemotePageMock).toHaveBeenCalledTimes(1);
      expect(registerRemotesMock).toHaveBeenCalledTimes(1);

      act(() => first.unmount());
      yield* Effect.promise(() =>
        act(async () => {
          pending.resolve({ default: fixtureRemotePage });
          await pending.promise;
        }),
      );

      expect(yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:second-caller'))).toBeTruthy();
      expect(remotePropsMock).toHaveBeenCalledWith({
        routeParams: secondModel.routeParams,
        target: secondModel.target,
      });
      expect(remotePropsMock).not.toHaveBeenCalledWith({
        routeParams: resolvedModel.routeParams,
        target: resolvedModel.target,
      });
      expect(loadRemotePageMock).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve({ default: fixtureRemotePage });
    }
  }),
);

it.live('does not let the first queued page caller abort the shared SDK thunk needed by a second caller', () =>
  Effect.gen(function* startsQueuedWorkForItsRemainingCaller() {
    const blockers = Array.from({ length: 8 }, (_, index) => blockedPageFixture(index));
    const secondModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'remaining-queued-caller' },
      target: targetFixture(resolvedModel.target.componentKey, resolvedModel.target.entrypointKey),
    };
    loadRemotePageMock.mockImplementation((entrypoint: string) => {
      const blocker = blockers.find(({ request }) => request === entrypoint);
      return blocker === undefined ? Promise.resolve({ default: fixtureRemotePage }) : blocker.pending.promise;
    });
    try {
      for (const blocker of blockers) {
        render(<ModuleTargetView initialModel={blocker.model} />);
      }
      yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(8)));
      const first = render(<ModuleTargetView initialModel={resolvedModel} />);
      render(<ModuleTargetView initialModel={secondModel} />);
      yield* Effect.promise(() => waitFor(() => expect(getInstanceMock).toHaveBeenCalledTimes(9)));
      expect(document.querySelectorAll('[data-module-page-skeleton]')).toHaveLength(10);
      expect(loadRemotePageMock).toHaveBeenCalledTimes(8);

      act(() => first.unmount());
      yield* Effect.promise(() =>
        act(async () => {
          blockers[0]?.pending.resolve({ default: fixtureRemotePage });
          await blockers[0]?.pending.promise;
        }),
      );

      expect(
        yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:remaining-queued-caller')),
      ).toBeTruthy();
      expect(loadRemotePageMock).toHaveBeenCalledTimes(9);
      expect(loadRemotePageMock).toHaveBeenCalledWith(`${remoteName}/contacts.core.page-customers`);
      expect(remotePropsMock).toHaveBeenCalledWith({
        routeParams: secondModel.routeParams,
        target: secondModel.target,
      });
    } finally {
      yield* Effect.promise(() =>
        act(async () => {
          for (const blocker of blockers) {
            blocker.pending.resolve({ default: fixtureRemotePage });
          }
          await Promise.all(blockers.map(({ pending }) => pending.promise));
        }),
      );
    }
  }),
);

it.live('keeps concurrent exposes of one approved remote distinct through staggered SDK settlement', () =>
  Effect.gen(function* rendersOnlyEachRequestedExport() {
    const first = Promise.withResolvers<{ readonly default: () => ReactNode }>();
    const second = Promise.withResolvers<{ readonly default: () => ReactNode }>();
    const secondModel: ResolvedPageModel = {
      ...resolvedModel,
      target: targetFixture('contacts.core.page-customer-detail', 'contacts.core.page.customer-detail'),
    };
    loadRemotePageMock.mockImplementation((entrypoint: string) => {
      if (entrypoint === `${remoteName}/contacts.core.page-customers`) {
        return first.promise;
      }
      return second.promise;
    });
    try {
      render(<ModuleTargetView initialModel={resolvedModel} />);
      render(<ModuleTargetView initialModel={secondModel} />);
      yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(2)));
      yield* Effect.promise(() =>
        act(async () => {
          first.resolve({ default: () => <div>exact exposed list component</div> });
          await first.promise;
        }),
      );
      yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(2)));
      expect(loadRemotePageMock).toHaveBeenCalledWith(`${remoteName}/contacts.core.page-customers`);
      expect(loadRemotePageMock).toHaveBeenCalledWith(`${remoteName}/contacts.core.page-customer-detail`);
      expect(screen.getAllByText('exact exposed list component')).toHaveLength(1);
      expect(screen.queryByText('exact exposed detail component')).toBeNull();
      yield* Effect.promise(() =>
        act(async () => {
          second.resolve({ default: () => <div>exact exposed detail component</div> });
          await second.promise;
        }),
      );
      expect(yield* Effect.promise(() => screen.findByText('exact exposed detail component'))).toBeTruthy();
      expect(screen.getAllByText('exact exposed list component')).toHaveLength(1);
    } finally {
      first.resolve({ default: () => <div>exact exposed list component</div> });
      second.resolve({ default: () => <div>exact exposed detail component</div> });
    }
  }),
);

it.live('passes changed route context to already loaded code without reusing previous page props', () =>
  Effect.gen(function* keepsRouteContextSeparateFromLoadedCode() {
    const view = render(<ModuleTargetView initialModel={resolvedModel} />);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'));
    remotePropsMock.mockClear();
    const nextModel: ResolvedPageModel = { ...resolvedModel, routeParams: { id: 'current-route-context' } };

    view.rerender(<ModuleTargetView initialModel={nextModel} />);

    expect(screen.getByText('contacts.core.page-customers:current-route-context')).toBeTruthy();
    expect(screen.queryByText('contacts.core.page-customers:customer-1')).toBeNull();
    expect(remotePropsMock).toHaveBeenCalledWith({ routeParams: nextModel.routeParams, target: nextModel.target });
    expect(loadRemotePageMock).toHaveBeenCalledTimes(1);
  }),
);

it.live('unmounts loaded code when the current governed page resolution becomes forbidden', () =>
  Effect.gen(function* neverTreatsLoadedCodeAsPageAdmission() {
    const view = render(<ModuleTargetView initialModel={resolvedModel} />);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'));
    remotePropsMock.mockClear();

    view.rerender(<ModuleTargetView initialModel={{ shell, state: 'forbidden' }} />);

    expect(screen.getByText('shell.moduleTarget.forbidden')).toBeTruthy();
    expect(screen.queryByText('contacts.core.page-customers:customer-1')).toBeNull();
    expect(remotePropsMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).toHaveBeenCalledTimes(1);
  }),
);

it.live('rejects a malformed remote module before React receives it', () =>
  Effect.gen(function* rejectsAMalformedRemoteModuleBefore() {
    loadRemotePageMock.mockResolvedValueOnce({ default: 'not a component' });
    useLoaderDataMock.mockReturnValue(resolvedModel);

    render(<ModuleTargetPage />);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.incompatible'))).toBeTruthy();
    expect(remotePropsMock).not.toHaveBeenCalled();
  }),
);

it.live('passes an empty route-parameter record to a resolved static page', () =>
  Effect.gen(function* passesAnEmptyRouteParameterRecord() {
    useLoaderDataMock.mockReturnValue({ ...resolvedModel, routeParams: {} });
    render(<ModuleTargetPage />);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    expect(yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:static'))).toBeTruthy();
  }),
);

it.live.each(exactPageCases)(
  'loads the approved $componentKey remote once with its exact route context and resolved target',
  ({ componentKey, entrypointKey, renderedText, routeParams, writable }) =>
    Effect.gen(function* loadsTheApprovedExactRemoteOnce() {
      const exactModel: ResolvedPageModel = {
        ...resolvedModel,
        routeParams,
        target: targetFixture(componentKey, entrypointKey, writable),
      };
      useLoaderDataMock.mockReturnValue(exactModel);

      render(<ModuleTargetPage />);

      yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
      expect(loadRemotePageMock).toHaveBeenCalledWith(`${remoteName}/${componentKey}`);
      expect(remotePropsMock).toHaveBeenCalledWith({
        routeParams,
        target: exactModel.target,
      });
      expect(yield* Effect.promise(() => screen.findByText(renderedText))).toBeTruthy();
    }),
);

it('does not initialize Federation or execute remote UI during server rendering', () => {
  useLoaderDataMock.mockReturnValue(resolvedModel);

  const html = renderToString(<ModuleTargetPage />);

  expect(html).toContain('shell.moduleTarget.loading');
  expect(getInstanceMock).not.toHaveBeenCalled();
  expect(registerRemotesMock).not.toHaveBeenCalled();
  expect(loadRemotePageMock).not.toHaveBeenCalled();
});

it.live('maps a null native remote result to a local compatibility diagnostic', () =>
  Effect.gen(function* rejectsNullRemoteResult() {
    loadRemotePageMock.mockResolvedValueOnce(null);
    useLoaderDataMock.mockReturnValue(resolvedModel);

    render(<ModuleTargetPage />);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.incompatible'))).toBeTruthy();
    expect(remotePropsMock).not.toHaveBeenCalled();
  }),
);

it.live('fails locally when the native host is unavailable', () =>
  Effect.gen(function* rejectsUnavailableNativeHost() {
    getInstanceMock.mockReturnValueOnce(null);
    useLoaderDataMock.mockReturnValue(resolvedModel);

    render(<ModuleTargetPage />);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.unavailable'))).toBeTruthy();
    expect(registerRemotesMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).not.toHaveBeenCalled();
  }),
);

it.live('requires reload before admitting a different composition into the same document', () =>
  Effect.gen(function* rejectsMixedDocumentRevisions() {
    useLoaderDataMock.mockReturnValue(resolvedModel);
    const view = render(<ModuleTargetPage />);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'));
    loadRemotePageMock.mockClear();
    registerRemotesMock.mockClear();
    remotePropsMock.mockClear();
    useLoaderDataMock.mockReturnValue({
      ...resolvedModel,
      target: { ...resolvedModel.target, compositionRevision: 'd'.repeat(64) },
    });

    view.rerender(<ModuleTargetPage />);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.reload_required'))).toBeTruthy();
    expect(remotePropsMock).not.toHaveBeenCalled();
    expect(registerRemotesMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).not.toHaveBeenCalled();
  }),
);

it.live('does not load a remote when native registration fails', () =>
  Effect.gen(function* rejectsFailedNativeRegistration() {
    registerRemotesMock.mockImplementation(() => {
      throw new Error('native registration unavailable');
    });
    useLoaderDataMock.mockReturnValue(resolvedModel);

    render(<ModuleTargetPage />);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.unavailable'))).toBeTruthy();
    expect(loadRemotePageMock).not.toHaveBeenCalled();
  }),
);

it.live('ignores a previous remote load that settles after navigation to another approved target', () =>
  Effect.gen(function* ignoresStaleLoadAfterNavigation() {
    const oldRemote = Promise.withResolvers<{ readonly default: () => ReactNode }>();
    loadRemotePageMock.mockReturnValueOnce(oldRemote.promise);
    useLoaderDataMock.mockReturnValue(resolvedModel);
    const view = render(<ModuleTargetPage />);
    yield* Effect.promise(() => waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1)));
    const nextModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'customer-2' },
      target: targetFixture('contacts.core.page-customer-detail', 'contacts.core.page.customer-detail'),
    };
    useLoaderDataMock.mockReturnValue(nextModel);

    view.rerender(<ModuleTargetPage />);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customer-detail:customer-2'));
    yield* Effect.promise(() =>
      act(async () => {
        oldRemote.resolve({ default: () => <div>stale previous remote</div> });
        await oldRemote.promise;
      }),
    );

    expect(screen.queryByText('stale previous remote')).toBeNull();
    expect(screen.getByText('contacts.core.page-customer-detail:customer-2')).toBeTruthy();
    expect(remotePropsMock).not.toHaveBeenCalledWith({
      routeParams: resolvedModel.routeParams,
      target: resolvedModel.target,
    });
  }),
);

it('suppresses a resolved remote owner when Shell document admission requires reload', () => {
  reloadRequiredMock.mockReturnValue(true);
  useLoaderDataMock.mockReturnValue(resolvedModel);

  render(<ModuleTargetPage />);

  expect(screen.getByText('shell.moduleTarget.reload_required')).toBeTruthy();
  expect(getInstanceMock).not.toHaveBeenCalled();
  expect(registerRemotesMock).not.toHaveBeenCalled();
  expect(loadRemotePageMock).not.toHaveBeenCalled();
  expect(remotePropsMock).not.toHaveBeenCalled();
});

it.live('unmounts an already loaded owner when current Shell admission requires reload', () =>
  Effect.gen(function* unmountsOwnerAfterAdmissionConflict() {
    useLoaderDataMock.mockReturnValue(resolvedModel);
    const view = render(<ModuleTargetPage />);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'));
    remotePropsMock.mockClear();
    loadRemotePageMock.mockClear();
    reloadRequiredMock.mockReturnValue(true);

    view.rerender(<ModuleTargetPage />);

    expect(screen.getByText('shell.moduleTarget.reload_required')).toBeTruthy();
    expect(screen.queryByText('contacts.core.page-customers:customer-1')).toBeNull();
    expect(remotePropsMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).not.toHaveBeenCalled();
  }),
);

it('shows reload guidance for a Shell model rejected by document admission', () => {
  useLoaderDataMock.mockReturnValue({
    shell: { state: 'reload_required' },
    state: 'reload_required',
  } satisfies ModuleTargetPageModel);

  render(<ModuleTargetPage />);

  expect(screen.getByText('shell.moduleTarget.reload_required')).toBeTruthy();
  expect(screen.queryByText('shell.moduleTarget.selection_required')).toBeNull();
  expect(getInstanceMock).not.toHaveBeenCalled();
  expect(registerRemotesMock).not.toHaveBeenCalled();
  expect(loadRemotePageMock).not.toHaveBeenCalled();
});

it.live('rejects an approved remote name that collides with the native Shell host', () =>
  Effect.gen(function* rejectsNativeHostIdentityCollision() {
    useLoaderDataMock.mockReturnValue({
      ...resolvedModel,
      target: {
        ...resolvedModel.target,
        federation: { ...resolvedModel.target.federation, remoteName: 'shellSuperApp' },
      },
    } satisfies ResolvedPageModel);

    render(<ModuleTargetPage />);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.incompatible'))).toBeTruthy();
    expect(registerRemotesMock).not.toHaveBeenCalled();
    expect(loadRemotePageMock).not.toHaveBeenCalled();
    expect(remotePropsMock).not.toHaveBeenCalled();
  }),
);

const expectedPageProps = (model: ResolvedPageModel): ModulePageProps => ({
  context: {
    displayName: 'Ada Lovelace',
    legalEntityId: '20000000-0000-4000-8000-000000000001',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
  routeParams: model.routeParams,
  search: model.search,
});

it.live('a cold page shows one neutral skeleton, then its content once code and primary data are ready', () =>
  Effect.gen(function* revealsAfterPreparation() {
    const data = Promise.withResolvers<true>();
    const preloadPage = rstest.fn(async (_props: ModulePageProps) => {
      await data.promise;
    });
    loadRemotePageMock.mockResolvedValueOnce({
      default: (props: ModulePageProps) => {
        remotePropsMock(props);
        return <div>prepared page</div>;
      },
      preloadPage,
    });
    useLoaderDataMock.mockReturnValue(resolvedModel);
    const view = render(<ModuleTargetPage />);
    expect(view.container.querySelector('[data-module-page-skeleton]')).not.toBeNull();
    yield* Effect.promise(() => waitFor(() => expect(preloadPage).toHaveBeenCalledTimes(1)));
    // The code is loaded, but the page waits for its data instead of showing its own loading state.
    expect(screen.queryByText('prepared page')).toBeNull();
    expect(view.container.querySelector('[data-module-page-skeleton]')).not.toBeNull();
    yield* Effect.promise(() =>
      act(async () => {
        data.resolve(true);
        await data.promise;
      }),
    );
    expect(yield* Effect.promise(() => screen.findByText('prepared page'))).toBeTruthy();
    expect(view.container.querySelector('[data-module-page-skeleton]')).toBeNull();
    // The page receives exactly the props its preload received, plus its target.
    expect(preloadPage).toHaveBeenCalledWith(expectedPageProps(resolvedModel));
    expect(remotePropsMock).toHaveBeenCalledWith({ ...expectedPageProps(resolvedModel), target: resolvedModel.target });
  }),
);

it.live('a prepared page renders its content in the first commit, without any placeholder', () =>
  Effect.gen(function* rendersPreparedPageAtOnce() {
    const preloadPage = rstest.fn((_props: ModulePageProps) => Promise.resolve());
    loadRemotePageMock.mockResolvedValueOnce({
      default: () => <div>ready at once</div>,
      preloadPage,
    });
    const prepared = yield* prepareModulePage(
      resolvedModel.target,
      expectedPageProps(resolvedModel),
      '/en/contacts',
      '5 seconds',
    );
    expect(Option.isSome(prepared)).toBe(true);
    expect(preloadPage).toHaveBeenCalledWith(expectedPageProps(resolvedModel));
    useLoaderDataMock.mockReturnValue(resolvedModel);

    const view = render(<ModuleTargetPage />);

    expect(screen.getByText('ready at once')).toBeTruthy();
    expect(view.container.querySelector('[data-module-page-skeleton]')).toBeNull();
    expect(screen.queryByText('shell.moduleTarget.loading')).toBeNull();
  }),
);

it('server rendering emits the neutral skeleton, without visible loading text', () => {
  useLoaderDataMock.mockReturnValue(resolvedModel);

  const html = renderToString(<ModuleTargetPage />);

  expect(html).toContain('data-module-page-skeleton');
  expect(html).toContain('aria-busy="true"');
});
