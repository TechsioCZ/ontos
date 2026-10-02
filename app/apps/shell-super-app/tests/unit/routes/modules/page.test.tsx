import { getDocumentCompositionRevision } from '@app/shared-contracts';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, rstest, it } from 'effect-rstest';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';

import { ResolvedModuleTargetSchema } from '../../../../shared/api.ts';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts';
import type { ModuleTargetPageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';
import ModuleTargetPage from '../../../../src/routes/[lang]/modules/[moduleId]/page.tsx';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';

type ResolvedPageModel = Extract<ModuleTargetPageModel, { readonly state: 'resolved' }>;

const {
  getInstanceMock,
  loadRemotePageMock,
  registerRemotesMock,
  reloadRequiredMock,
  remotePropsMock,
  useLoaderDataMock,
} = rstest.hoisted(() => ({
  getInstanceMock: rstest.fn(),
  loadRemotePageMock: rstest.fn(),
  registerRemotesMock: rstest.fn(),
  reloadRequiredMock: rstest.fn(),
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

rstest.mock('@module-federation/modern-js-v3/runtime', () => ({ getInstance: getInstanceMock }));

rstest.mock('../../../../src/routes/shell-frame.tsx', () => ({
  AuthenticatedDashboardLayout: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
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
      remoteName: 'previouslyUnknownContacts',
    },
    moduleId: 'contacts.core',
    routeParameters: {},
    writable,
  });

const resolvedModel: ResolvedPageModel = {
  routeParams: { id: 'customer-1' },
  shell,
  state: 'resolved',
  target: targetFixture('contacts.core.page-customers', 'contacts.core.page.customers'),
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

beforeEach(() => {
  reloadRequiredMock.mockReturnValue(false);
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
      return <div>{`${target.componentKey}:${routeParams['id'] ?? 'static'}`}</div>;
    },
  });
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
    expect(loadRemotePageMock).toHaveBeenCalledWith('previouslyUnknownContacts/contacts.core.page-customers');
    expect(yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'))).toBeTruthy();
  }),
);

it.live('maps an unreachable approved remote to its safe local diagnostic', () =>
  Effect.gen(function* mapsAnUnreachableApprovedRemoteTo() {
    loadRemotePageMock.mockRejectedValueOnce(new Error('private remote error'));
    useLoaderDataMock.mockReturnValue(resolvedModel);

    render(<ModuleTargetPage />);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.unavailable'))).toBeTruthy();
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
      expect(loadRemotePageMock).toHaveBeenCalledWith(`previouslyUnknownContacts/${componentKey}`);
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
    registerRemotesMock.mockImplementationOnce(() => {
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
