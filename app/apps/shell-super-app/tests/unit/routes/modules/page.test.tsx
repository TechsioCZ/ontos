import { getDocumentCompositionRevision, pinDocumentCompositionRevision } from '@app/shared-contracts';
import { CatchBoundary, RouterProvider, useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Deferred, Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';

import type { ModulePageProps } from '@app/shared-contracts/page-data';

import { ResolvedModuleTargetSchema, SafeTenantIdentitySchema } from '../../../../shared/browser-api.ts';
import type { ResolvedModuleTarget } from '../../../../shared/browser-api.ts';
import { browserRuntime } from '../../../../src/runtime/browser-effect-runtime.ts';
import {
  moduleEntrypointLoadIdentity,
  pinBrowserModuleTarget,
} from '../../../../src/routes/module-entrypoint-loader.ts';
import type { ModuleEntrypointNamespace } from '../../../../src/routes/module-entrypoint-loader.ts';
import { ModuleRenderFailure } from '../../../../src/routes/module-render-failure.tsx';
import type { ModuleTargetPageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/module-page-model.ts';
import ModuleTargetPage from '../../../../src/routes/[lang]/modules/[moduleId]/page.tsx';
import { prepareModulePage } from '../../../../src/routes/remote-page-loader.ts';
import { ShellI18n, shellTestCopy } from '../../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../../support/shell-router.tsx';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';
import { makeFederationHost, shellHostName } from './federation-host.ts';

type ResolvedPageModel = Extract<ModuleTargetPageModel, { readonly state: 'resolved' }>;

/** One execution of the remote page, with the loader data the router had committed for that render. */
interface RemotePageExecution {
  readonly admission: ModuleTargetPageModel;
  readonly props: RemotePageProps;
}

interface RemotePageProps {
  readonly routeParams: Readonly<Record<string, string>>;
  readonly target: ResolvedModuleTarget;
}

/** Real i18next without copy: every message renders as its own key. */
const translations = shellTestCopy('en', {});

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

const FailingRemoteFixture = (): never => {
  throw new Error('1296_PRIVATE_RENDER_SENTINEL');
};
const ExactListComponent = () => <div>exact exposed list component</div>;
const ExactDetailComponent = () => <div>exact exposed detail component</div>;
const StaleRemoteComponent = () => <div>stale previous remote</div>;
const ReadyAtOnce = () => <div>ready at once</div>;

/** The exposed-module request the native SDK makes for a target's page. */
const exposeRequest = (target: ResolvedModuleTarget) =>
  `${target.federation.remoteName}/${target.federation.expose.slice(2)}`;

/** An approved page of its own module owner and remote, scheduled independently of the contacts pages. */
const ownerPageFixture = (index: number): ResolvedPageModel => {
  const appId = `load-blocker-${index}`;
  const componentKey = `${appId}.core.page`;
  const target = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    ...targetFixture(componentKey, `${appId}.core.page.show`),
    appId,
    federation: {
      expose: `./${componentKey}`,
      manifest: {
        sha256: 'a'.repeat(64),
        url: `https://assets.example.test/${appId}/release-a/mf-manifest.json`,
      },
      remoteName: `loadBlocker${index}x${remoteSequence}`,
    },
    moduleId: `${appId}.core`,
  });
  return { ...resolvedModel, target };
};

/** A held exposed module the test settles once it has observed what it needs. */
const heldExpose = () => Deferred.makeUnsafe<ModuleEntrypointNamespace, Error>();

/**
 * The real native Federation host for one test. Its remotes expose `page`, which records the props
 * it rendered with; `scripted` answers single requests and every other request evaluates to `page`.
 */
const federation = (
  options: {
    readonly refusedRemotes?: readonly string[];
    readonly scripted?: (request: string) => Option.Option<Effect.Effect<ModuleEntrypointNamespace, Error>>;
  } = {},
) =>
  Effect.gen(function* federationForTest() {
    const renders: RemotePageProps[] = [];
    const executions: RemotePageExecution[] = [];
    const ExposedPage = ({ routeParams, target }: ModulePageProps & { readonly target: ResolvedModuleTarget }) => {
      const admission: ModuleTargetPageModel = useLoaderData({
        from: '/$lang/modules/$moduleId',
        structuralSharing: false,
      });
      renders.push({ routeParams, target });
      executions.push({ admission, props: { routeParams, target } });
      return <div>{`${target.componentKey}:${routeParams['id'] ?? 'static'}`}</div>;
    };
    const scripted = options.scripted ?? (() => Option.none());
    const host = yield* makeFederationHost({
      answer: (request) => Option.getOrElse(scripted(request), () => Effect.succeed({ default: ExposedPage })),
      refusedRemotes: options.refusedRemotes ?? [],
    });
    return { ...host, executions, page: ExposedPage, renders } as const;
  });

/** Answers each listed expose with its own module every time it is requested. */
const answering =
  (answers: Readonly<Record<string, Effect.Effect<ModuleEntrypointNamespace, Error>>>) => (request: string) =>
    Option.fromNullishOr(answers[request]);

/** Answers only the first request of each listed expose with its own module. */
const answeringOnce = (answers: Readonly<Record<string, Effect.Effect<ModuleEntrypointNamespace, Error>>>) => {
  const unanswered = new Map(Object.entries(answers));
  return (request: string) => {
    const answer = Option.fromNullishOr(unanswered.get(request));
    unanswered.delete(request);
    return answer;
  };
};

/** Lets React apply whatever the page scheduled. */
const reactSettled = Effect.promise(() => act(() => Promise.resolve()));

/**
 * The module page route of a real router, loading whatever model the holder carries. `show` changes
 * the loader data and revalidates the route, as the next governed resolution of the page does.
 */
const renderModulePage = (model: ModuleTargetPageModel, options: { readonly holdNavigation?: boolean } = {}) =>
  Effect.gen(function* renderModuleRoute() {
    const holder = { current: model };
    const router = makeShellRouter({
      page: { component: ModuleTargetPage, loaderData: () => holder.current, path: 'modules/$moduleId' },
      url: '/en/modules/contacts.core',
    });
    // A page that leaves for sign-in navigates as it mounts; the test records where it was sent instead.
    const navigations =
      options.holdNavigation === true
        ? rstest.spyOn(router, 'navigate').mockImplementation(() => Promise.resolve())
        : undefined;
    const view = yield* renderShellRoute(router, translations);
    // The router commits a revalidation through React itself, so it cannot run inside act;
    // act afterwards applies whatever the page scheduled in response.
    const show = (next: ModuleTargetPageModel) =>
      Effect.sync(() => {
        holder.current = next;
      }).pipe(Effect.andThen(Effect.promise(() => router.invalidate())), Effect.andThen(reactSettled));
    return { navigations, router, show, view } as const;
  });

/**
 * Changes the resolution from `previous` to `next` and returns every execution of the remote page,
 * from the first transition on, that ran under any loader data other than `previous`. Executions
 * under the previous admission before the router commits the change are expected.
 */
const executionsBeyond = (
  fx: { readonly executions: readonly RemotePageExecution[] },
  show: (model: ModuleTargetPageModel) => Effect.Effect<void>,
  previous: ModuleTargetPageModel,
  next: ModuleTargetPageModel,
) =>
  Effect.gen(function* executionsBeyondEffect() {
    const from = fx.executions.length;
    yield* show(next);
    return fx.executions.slice(from).filter(({ admission }) => admission !== previous);
  });

/**
 * Settles a held exposed module and waits until the native SDK has settled the load of `request`,
 * then lets React apply whatever the page scheduled in response.
 */
const settle = (
  fx: { readonly settled: (request: string) => Effect.Effect<void> },
  request: string,
  held: Deferred.Deferred<ModuleEntrypointNamespace, Error>,
  value: ModuleEntrypointNamespace,
) => Deferred.succeed(held, value).pipe(Effect.andThen(fx.settled(request)), Effect.andThen(reactSettled));

/** The fresh-document reload a render failure offers; this boundary test never follows it. */
const handleReload = constVoid;

/** The real framework boundary the page puts around an exposed page, keyed by the target's result. */
const moduleBoundary = (target: ResolvedModuleTarget, children: ReactNode) => (
  <ShellI18n translations={translations}>
    <CatchBoundary
      errorComponent={() => <ModuleRenderFailure onReload={handleReload} />}
      getResetKey={() => moduleEntrypointLoadIdentity(target).result}
    >
      {children}
    </CatchBoundary>
  </ShellI18n>
);

const shellSidebars = () => screen.getAllByRole('complementary', { name: 'shell.dashboard.sidebar.label' });

/** The Shell host the native SDK registry hands the page, as the page looks it up. */
const registeredShellHost = Effect.promise(() => import('@module-federation/modern-js-v3/runtime')).pipe(
  Effect.map(({ getInstance }) => getInstance((instance) => instance.name === shellHostName)),
);

beforeEach(() => {
  remoteSequence += 1;
  remoteName = `previouslyUnknownContacts${remoteSequence}`;
  resolvedModel = makeResolvedModel();
});

afterEach(cleanup);

it.live('sends an anonymous visitor of a protected module to sign-in and back', () =>
  Effect.gen(function* anonymousGoesToSignIn() {
    const fx = yield* federation();
    window.history.replaceState(null, '', '/en/prehledy/statistiky?group=month');
    try {
      const { navigations } = yield* renderModulePage(
        { shell: { state: 'anonymous' }, state: 'selection_required' },
        { holdNavigation: true },
      );
      expect(navigations).toHaveBeenCalledWith({
        href: '/en/login?returnTo=%2Fen%2Fprehledy%2Fstatistiky%3Fgroup%3Dmonth',
        replace: true,
      });
      expect(screen.getByText('shell.moduleTarget.sign_in_required')).toBeTruthy();
      expect(screen.queryByText('shell.moduleTarget.selection_required')).toBeNull();
      expect(fx.registered).toEqual([]);
    } finally {
      window.history.replaceState(null, '', '/');
    }
  }),
);

it.live.each(['selection_required', 'forbidden', 'not_found', 'reload_required', 'unavailable'] as const)(
  'does not initialize or load Federation for a %s exact-page response',
  (state) =>
    Effect.gen(function* closedResponseLeavesFederationAlone() {
      const fx = yield* federation();
      yield* renderModulePage({ shell, state } satisfies ModuleTargetPageModel);

      expect(screen.getByText(`shell.moduleTarget.${state}`)).toBeTruthy();
      expect(fx.registered).toEqual([]);
      expect(fx.requests).toEqual([]);
    }),
);

it.live('does not register or load an owner when disposed during native SDK acquisition', () =>
  Effect.gen(function* disposesBeforeNativeSdkSettles() {
    // Build the real shared runtime first so its initial service acquisition cannot delay the pin.
    yield* browserRuntime.contextEffect;
    const fx = yield* federation();
    const { view } = yield* renderModulePage(resolvedModel);
    act(() => view.unmount());

    expect(yield* getDocumentCompositionRevision(document)).toBe('c'.repeat(64));
    // The SDK the page acquires holds a Shell host it could have registered the owner with.
    expect(yield* registeredShellHost).toBe(fx.host);
    yield* Effect.promise(() =>
      act(async () => {
        await Promise.resolve();
      }),
    );

    expect(fx.registered).toEqual([]);
    expect(fx.requests).toEqual([]);
    expect(fx.renders).toEqual([]);
  }),
);

it.live('registers and loads a previously unknown approved remote only after authentication', () =>
  Effect.gen(function* invokesTheExactPrivatePageLoader() {
    const fx = yield* federation();
    yield* renderModulePage(resolvedModel);

    expect(yield* fx.nextRequest).toBe(`${remoteName}/contacts.core.page-customers`);
    expect(fx.registered).toEqual([
      {
        entry: resolvedModel.target.federation.manifest.url,
        name: resolvedModel.target.federation.remoteName,
      },
    ]);
    expect(yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'))).toBeTruthy();
  }),
);

it.live('maps an unreachable approved remote to its safe local diagnostic', () =>
  Effect.gen(function* mapsAnUnreachableApprovedRemoteTo() {
    yield* federation({
      // Every attempt fails: the Shell tries the code request once more before it gives up.
      scripted: answering({
        [exposeRequest(resolvedModel.target)]: Effect.fail(new Error('private remote error')),
      }),
    });
    yield* renderModulePage(resolvedModel);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.unavailable'))).toBeTruthy();
    expect(document.body.textContent).not.toContain('private remote error');
  }),
);

it.live('contains a remote render exception while the Shell framing and healthy exposed page remain mounted', () =>
  Effect.gen(function* containsOnlyTheFailedRemoteTree() {
    const diagnostics = rstest.spyOn(console, 'log');
    const healthyModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'healthy-owner' },
      target: targetFixture('contacts.core.page-customer-detail', 'contacts.core.page.customer-detail'),
    };
    yield* federation({
      scripted: answeringOnce({
        [exposeRequest(resolvedModel.target)]: Effect.succeed({ default: FailingRemoteFixture }),
      }),
    });

    yield* renderModulePage(resolvedModel);
    yield* renderModulePage(healthyModel);

    expect((yield* Effect.promise(() => screen.findByRole('alert'))).textContent).toContain(
      'shell.moduleTarget.render_failed',
    );
    expect(
      yield* Effect.promise(() => screen.findByText('contacts.core.page-customer-detail:healthy-owner')),
    ).toBeTruthy();
    expect(shellSidebars()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'shell.moduleTarget.reload_page' }).getAttribute('type')).toBe('button');
    expect(document.body.textContent).not.toContain('1296_PRIVATE_RENDER_SENTINEL');
    const output = JSON.stringify(diagnostics.mock.calls);
    expect(output).toContain('Remote module entrypoint failed');
    expect(output).toContain('contacts.core');
    expect(output).toContain('1296_PRIVATE_RENDER_SENTINEL');
    expect(output).toContain('render');
  }),
);

it.live('keeps a failed equivalent target contained and resets only for the newly approved expose', () =>
  Effect.gen(function* resetsForTheExactApprovedExposedResult() {
    const fx = yield* federation({
      scripted: answeringOnce({
        [exposeRequest(resolvedModel.target)]: Effect.succeed({ default: FailingRemoteFixture }),
      }),
    });
    const { show } = yield* renderModulePage(resolvedModel);
    yield* Effect.promise(() => screen.findByRole('alert'));
    const equivalentModel: ResolvedPageModel = {
      ...resolvedModel,
      target: targetFixture(resolvedModel.target.componentKey, resolvedModel.target.entrypointKey),
    };

    yield* show(equivalentModel);

    expect(screen.getByRole('alert').textContent).toContain('shell.moduleTarget.render_failed');
    expect(fx.requests).toHaveLength(1);
    const nextModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'correct-next-expose' },
      target: targetFixture('contacts.core.page-customer-detail', 'contacts.core.page.customer-detail'),
    };
    yield* show(nextModel);

    expect(
      yield* Effect.promise(() => screen.findByText('contacts.core.page-customer-detail:correct-next-expose')),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fx.requests).toEqual([
      `${remoteName}/contacts.core.page-customers`,
      `${remoteName}/contacts.core.page-customer-detail`,
    ]);
  }),
);

it.live('requests a full document reload instead of locally executing the failed entrypoint again', () =>
  Effect.gen(function* recoveryRequiresFreshDocumentAdmission() {
    const fx = yield* federation({
      scripted: answeringOnce({
        [exposeRequest(resolvedModel.target)]: Effect.succeed({ default: FailingRemoteFixture }),
      }),
    });
    const { router, show } = yield* renderModulePage(resolvedModel);
    yield* Effect.promise(() => screen.findByRole('alert'));
    // A full document reload leaves the page; the router reports the navigation it was asked for.
    const navigated = Deferred.makeUnsafe<Parameters<typeof router.navigate>[0]>();
    rstest.spyOn(router, 'navigate').mockImplementation(async (navigation) => {
      Deferred.doneUnsafe(navigated, Effect.succeed(navigation));
    });

    yield* Effect.promise(() =>
      userEvent.setup().click(screen.getByRole('button', { name: 'shell.moduleTarget.reload_page' })),
    );

    expect(yield* Deferred.await(navigated)).toMatchObject({ reloadDocument: true, to: '.' });
    expect(fx.requests).toHaveLength(1);
    // The browser test proves actual document replacement and native permission revocation;
    // this unit supplies the denied model the fresh document resolves.
    yield* show({ shell, state: 'forbidden' });

    expect(screen.getByText('shell.moduleTarget.forbidden')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fx.requests).toHaveLength(1);
  }),
);

it.live('never restores previous caller content when a changed tenant and principal receive a typed denial', () =>
  Effect.gen(function* keepsCurrentContextDenialsOutsideTheBoundary() {
    const detailModel: ResolvedPageModel = {
      ...resolvedModel,
      target: targetFixture('contacts.core.page-customer-detail', 'contacts.core.page.customer-detail'),
    };
    const fx = yield* federation({
      scripted: answeringOnce({
        [exposeRequest(detailModel.target)]: Effect.succeed({ default: FailingRemoteFixture }),
      }),
    });
    const { show } = yield* renderModulePage(resolvedModel);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'));
    yield* show(detailModel);
    yield* Effect.promise(() => screen.findByRole('alert'));
    const deniedShell: ResolvedPageModel['shell'] = {
      ...shell,
      identity: Schema.decodeUnknownSync(SafeTenantIdentitySchema)({
        ...shell.identity,
        principalId: 'current-principal',
        tenantId: 'current-tenant',
      }),
    };
    const denied: ModuleTargetPageModel = { shell: deniedShell, state: 'forbidden' };

    expect(yield* executionsBeyond(fx, show, detailModel, denied)).toEqual([]);

    expect(screen.getByText('shell.moduleTarget.forbidden')).toBeTruthy();
    expect(screen.queryByText('contacts.core.page-customers:customer-1')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fx.requests).toHaveLength(2);
  }),
);

it.live(
  'resets the actual framework boundary for a separately pinned R2 DOM document in a controlled reset-key test',
  () =>
    Effect.gen(function* checksRevisionResetWithoutClaimingBrowserNavigation() {
      // The current document is the R1 document every other page in this file renders into.
      yield* pinDocumentCompositionRevision(resolvedModel.target.compositionRevision, document);
      const nextTarget = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
        ...resolvedModel.target,
        compositionRevision: 'd'.repeat(64),
      });
      const nextDocument = document.implementation.createHTMLDocument();
      yield* pinBrowserModuleTarget(nextTarget, nextDocument);
      expect(yield* getDocumentCompositionRevision(nextDocument)).toBe(nextTarget.compositionRevision);
      const view = render(moduleBoundary(resolvedModel.target, <FailingRemoteFixture />));
      expect(screen.getByRole('alert').textContent).toContain('shell.moduleTarget.render_failed');
      // This exercises the real boundary's reset with controlled approved-target fixtures,
      // not a browser navigation or publication proof. The existing R1 document stays pinned.
      view.rerender(moduleBoundary(nextTarget, <div>controlled R2 result</div>));
      expect(screen.getByText('controlled R2 result')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(yield* getDocumentCompositionRevision(document)).toBe(resolvedModel.target.compositionRevision);
    }),
);

it.live(
  'keeps a caller load timeout as its typed diagnostic rather than a render failure',
  () =>
    Effect.gen(function* separatesLoadTimeoutFromRenderFailure() {
      const held = heldExpose();
      const fx = yield* federation({
        scripted: answeringOnce({ [exposeRequest(resolvedModel.target)]: Deferred.await(held) }),
      });
      try {
        yield* renderModulePage(resolvedModel);
        expect(
          yield* Effect.promise(() => screen.findByText('shell.moduleTarget.timeout', {}, { timeout: 7000 })),
        ).toBeTruthy();
        // The timeout is its own diagnostic, not the render-failure alert with its reload action.
        expect(screen.getByRole('alert').textContent).toContain('shell.moduleTarget.timeout');
        expect(screen.queryByText('shell.moduleTarget.render_failed')).toBeNull();
        expect(screen.queryByRole('button', { name: 'shell.moduleTarget.reload_page' })).toBeNull();
        expect(fx.requests).toHaveLength(1);
      } finally {
        yield* Deferred.succeed(held, { default: fx.page });
      }
    }),
  15_000,
);

it.live('shares equivalent cloned targets while an unmounted caller cannot cancel the remaining page', () =>
  Effect.gen(function* sharesPhysicalWorkAcrossIndependentPages() {
    const held = heldExpose();
    const fx = yield* federation({
      scripted: answeringOnce({ [exposeRequest(resolvedModel.target)]: Deferred.await(held) }),
    });
    const secondModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'second-caller' },
      target: targetFixture(resolvedModel.target.componentKey, resolvedModel.target.entrypointKey, false),
    };
    expect(secondModel.target).not.toBe(resolvedModel.target);
    try {
      const first = yield* renderModulePage(resolvedModel);
      yield* renderModulePage(secondModel);
      expect(yield* fx.nextRequest).toBe(exposeRequest(resolvedModel.target));
      expect(fx.registered).toHaveLength(1);

      act(() => first.view.unmount());
      yield* settle(fx, exposeRequest(resolvedModel.target), held, { default: fx.page });

      expect(yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:second-caller'))).toBeTruthy();
      expect(fx.renders).toContainEqual({ routeParams: secondModel.routeParams, target: secondModel.target });
      expect(fx.renders).not.toContainEqual({ routeParams: resolvedModel.routeParams, target: resolvedModel.target });
      // Both callers were served by the one physical SDK load.
      expect(fx.requests).toEqual([exposeRequest(resolvedModel.target)]);
      expect(fx.registered).toHaveLength(1);
    } finally {
      Deferred.doneUnsafe(held, Effect.succeed({ default: fx.page }));
    }
  }),
);

it.live('does not let the first queued page caller abort the shared SDK thunk needed by a second caller', () =>
  Effect.gen(function* startsQueuedWorkForItsRemainingCaller() {
    // Two running contacts pages fill the contacts owner's slots; five other owners and a final
    // sentinel owner fill the remaining physical SDK slots.
    const contactsBlockers = ['a', 'b'].map((suffix): ResolvedPageModel => ({
      ...resolvedModel,
      target: targetFixture(`contacts.core.page-blocker-${suffix}`, `contacts.core.page.blocker-${suffix}`),
    }));
    const ownerBlockers = Array.from({ length: 5 }, (_, index) => ownerPageFixture(index));
    const sentinel = ownerPageFixture(5);
    const blockers = [...contactsBlockers, ...ownerBlockers, sentinel];
    const held = new Map(blockers.map((model) => [exposeRequest(model.target), heldExpose()]));
    const fx = yield* federation({
      scripted: (request) => Option.map(Option.fromNullishOr(held.get(request)), Deferred.await),
    });
    const secondModel: ResolvedPageModel = {
      ...resolvedModel,
      routeParams: { id: 'remaining-queued-caller' },
      target: targetFixture(resolvedModel.target.componentKey, resolvedModel.target.entrypointKey),
    };
    const nextRequests = (count: number) => Effect.forEach(Array.from({ length: count }), () => fx.nextRequest);
    try {
      for (const blocker of [...contactsBlockers, ...ownerBlockers]) {
        yield* renderModulePage(blocker);
      }
      expect((yield* nextRequests(7)).toSorted()).toEqual(
        [...contactsBlockers, ...ownerBlockers].map((model) => exposeRequest(model.target)).toSorted(),
      );
      const first = yield* renderModulePage(resolvedModel);
      yield* renderModulePage(secondModel);
      yield* renderModulePage(sentinel);
      // The sentinel was admitted after both contacts callers queued, and took the last SDK slot.
      expect(yield* fx.nextRequest).toBe(exposeRequest(sentinel.target));
      expect(fx.requests).toHaveLength(8);
      expect(fx.requests).not.toContain(exposeRequest(resolvedModel.target));

      act(() => first.view.unmount());
      const freedRequest = exposeRequest(targetFixture('contacts.core.page-blocker-a', 'contacts.core.page.blocker-a'));
      const freed = held.get(freedRequest);
      expect(freed).toBeDefined();
      if (freed !== undefined) {
        yield* settle(fx, freedRequest, freed, { default: fx.page });
      }

      expect(yield* fx.nextRequest).toBe(exposeRequest(resolvedModel.target));
      expect(
        yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:remaining-queued-caller')),
      ).toBeTruthy();
      expect(fx.requests).toHaveLength(9);
      expect(fx.requests.filter((request) => request === exposeRequest(resolvedModel.target))).toHaveLength(1);
      expect(fx.renders).toContainEqual({ routeParams: secondModel.routeParams, target: secondModel.target });
      expect(fx.renders).not.toContainEqual({ routeParams: resolvedModel.routeParams, target: resolvedModel.target });
    } finally {
      for (const pending of held.values()) {
        Deferred.doneUnsafe(pending, Effect.succeed({ default: fx.page }));
      }
    }
  }),
);

it.live('keeps concurrent exposes of one approved remote distinct through staggered SDK settlement', () =>
  Effect.gen(function* rendersOnlyEachRequestedExport() {
    const first = heldExpose();
    const second = heldExpose();
    const secondModel: ResolvedPageModel = {
      ...resolvedModel,
      target: targetFixture('contacts.core.page-customer-detail', 'contacts.core.page.customer-detail'),
    };
    const fx = yield* federation({
      scripted: answering({
        [exposeRequest(resolvedModel.target)]: Deferred.await(first),
        [exposeRequest(secondModel.target)]: Deferred.await(second),
      }),
    });
    try {
      yield* renderModulePage(resolvedModel);
      yield* renderModulePage(secondModel);
      expect([yield* fx.nextRequest, yield* fx.nextRequest].toSorted()).toEqual([
        `${remoteName}/contacts.core.page-customer-detail`,
        `${remoteName}/contacts.core.page-customers`,
      ]);
      yield* settle(fx, exposeRequest(resolvedModel.target), first, { default: ExactListComponent });

      expect(yield* Effect.promise(() => screen.findAllByText('exact exposed list component'))).toHaveLength(1);
      expect(screen.queryByText('exact exposed detail component')).toBeNull();
      expect(fx.requests).toHaveLength(2);
      yield* settle(fx, exposeRequest(secondModel.target), second, { default: ExactDetailComponent });
      expect(yield* Effect.promise(() => screen.findByText('exact exposed detail component'))).toBeTruthy();
      expect(screen.getAllByText('exact exposed list component')).toHaveLength(1);
      expect(fx.requests).toHaveLength(2);
    } finally {
      Deferred.doneUnsafe(first, Effect.succeed({ default: ExactListComponent }));
      Deferred.doneUnsafe(second, Effect.succeed({ default: ExactDetailComponent }));
    }
  }),
);

it.live('passes changed route context to already loaded code without reusing previous page props', () =>
  Effect.gen(function* keepsRouteContextSeparateFromLoadedCode() {
    const fx = yield* federation();
    const { show } = yield* renderModulePage(resolvedModel);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'));
    const nextModel: ResolvedPageModel = { ...resolvedModel, routeParams: { id: 'current-route-context' } };

    yield* show(nextModel);

    expect(screen.getByText('contacts.core.page-customers:current-route-context')).toBeTruthy();
    expect(screen.queryByText('contacts.core.page-customers:customer-1')).toBeNull();
    // From its first render in the new route context, the loaded code never sees the previous props.
    const firstNextRender = fx.renders.findIndex(({ routeParams }) => routeParams === nextModel.routeParams);
    expect(firstNextRender).toBeGreaterThan(-1);
    expect(new Set(fx.renders.slice(firstNextRender))).toEqual(
      new Set([{ routeParams: nextModel.routeParams, target: nextModel.target }]),
    );
    expect(fx.requests).toHaveLength(1);
  }),
);

it.live('unmounts loaded code when the current governed page resolution becomes forbidden', () =>
  Effect.gen(function* neverTreatsLoadedCodeAsPageAdmission() {
    const fx = yield* federation();
    const { show } = yield* renderModulePage(resolvedModel);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'));
    const forbidden: ModuleTargetPageModel = { shell, state: 'forbidden' };

    expect(yield* executionsBeyond(fx, show, resolvedModel, forbidden)).toEqual([]);

    expect(screen.getByText('shell.moduleTarget.forbidden')).toBeTruthy();
    expect(screen.queryByText('contacts.core.page-customers:customer-1')).toBeNull();
    expect(fx.requests).toHaveLength(1);
  }),
);

it.live('rejects a malformed remote module before React receives it', () =>
  Effect.gen(function* rejectsAMalformedRemoteModuleBefore() {
    const fx = yield* federation({
      scripted: answeringOnce({
        [exposeRequest(resolvedModel.target)]: Effect.succeed({ default: 'not a component' }),
      }),
    });
    yield* renderModulePage(resolvedModel);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.incompatible'))).toBeTruthy();
    expect(fx.renders).toEqual([]);
  }),
);

it.live('passes an empty route-parameter record to a resolved static page', () =>
  Effect.gen(function* passesAnEmptyRouteParameterRecord() {
    const fx = yield* federation();
    yield* renderModulePage({ ...resolvedModel, routeParams: {} });

    expect(yield* fx.nextRequest).toBe(exposeRequest(resolvedModel.target));
    expect(yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:static'))).toBeTruthy();
    expect(fx.renders).toContainEqual({ routeParams: {}, target: resolvedModel.target });
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
      const fx = yield* federation();

      yield* renderModulePage(exactModel);

      expect(yield* fx.nextRequest).toBe(`${remoteName}/${componentKey}`);
      expect(yield* Effect.promise(() => screen.findByText(renderedText))).toBeTruthy();
      expect(fx.renders).toContainEqual({ routeParams, target: exactModel.target });
      expect(fx.requests).toHaveLength(1);
    }),
);

it.live(
  'does not initialize Federation or execute remote UI during server rendering, which emits the neutral skeleton',
  () =>
    Effect.gen(function* rendersOnlyTheLoadingStateOnTheServer() {
      const fx = yield* federation();
      const router = makeShellRouter({
        page: { component: ModuleTargetPage, loaderData: () => resolvedModel, path: 'modules/$moduleId' },
        url: '/en/modules/contacts.core',
      });
      yield* Effect.promise(() => router.load());

      const html = renderToString(
        <ShellI18n translations={translations}>
          <RouterProvider router={router} />
        </ShellI18n>,
      );

      // One neutral skeleton, the same markup the browser hydrates; its loading text is for assistive technology only.
      expect(html).toContain('data-module-page-skeleton');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('shell.moduleTarget.loading');
      expect(fx.registered).toEqual([]);
      expect(fx.requests).toEqual([]);
      expect(fx.renders).toEqual([]);
    }),
);

it.live('maps a null native remote result to a local compatibility diagnostic', () =>
  Effect.gen(function* rejectsNullRemoteResult() {
    const fx = yield* federation({
      scripted: answeringOnce({ [exposeRequest(resolvedModel.target)]: Effect.succeed(null) }),
    });
    yield* renderModulePage(resolvedModel);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.incompatible'))).toBeTruthy();
    expect(fx.renders).toEqual([]);
  }),
);

it.live('fails locally when the native host is unavailable', () =>
  Effect.gen(function* rejectsUnavailableNativeHost() {
    // No Shell host is registered with the native SDK for this document.
    expect(yield* registeredShellHost).toBeNull();
    yield* renderModulePage(resolvedModel);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.unavailable'))).toBeTruthy();
    expect(screen.queryByText('contacts.core.page-customers:customer-1')).toBeNull();
  }),
);

it.live('requires reload before admitting a different composition into the same document', () =>
  Effect.gen(function* rejectsMixedDocumentRevisions() {
    const fx = yield* federation();
    const { show } = yield* renderModulePage(resolvedModel);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'));
    const [registeredBefore, requestedBefore] = [fx.registered.length, fx.requests.length];
    const promoted: ResolvedPageModel = {
      ...resolvedModel,
      target: { ...resolvedModel.target, compositionRevision: 'd'.repeat(64) },
    };

    expect(yield* executionsBeyond(fx, show, resolvedModel, promoted)).toEqual([]);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.reload_required'))).toBeTruthy();
    expect(fx.registered).toHaveLength(registeredBefore);
    expect(fx.requests).toHaveLength(requestedBefore);
  }),
);

it.live('does not load a remote when native registration fails', () =>
  Effect.gen(function* rejectsFailedNativeRegistration() {
    const fx = yield* federation({ refusedRemotes: [resolvedModel.target.federation.remoteName] });
    yield* renderModulePage(resolvedModel);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.unavailable'))).toBeTruthy();
    expect(fx.registered).toEqual([]);
    expect(fx.requests).toEqual([]);
  }),
);

it.live('ignores a previous remote load that settles after navigation to another approved target', () =>
  Effect.gen(function* ignoresStaleLoadAfterNavigation() {
    const oldRemote = heldExpose();
    const fx = yield* federation({
      scripted: answeringOnce({ [exposeRequest(resolvedModel.target)]: Deferred.await(oldRemote) }),
    });
    try {
      const { show } = yield* renderModulePage(resolvedModel);
      expect(yield* fx.nextRequest).toBe(exposeRequest(resolvedModel.target));
      const nextModel: ResolvedPageModel = {
        ...resolvedModel,
        routeParams: { id: 'customer-2' },
        target: targetFixture('contacts.core.page-customer-detail', 'contacts.core.page.customer-detail'),
      };

      yield* show(nextModel);
      yield* Effect.promise(() => screen.findByText('contacts.core.page-customer-detail:customer-2'));
      yield* settle(fx, exposeRequest(resolvedModel.target), oldRemote, { default: StaleRemoteComponent });

      expect(screen.queryByText('stale previous remote')).toBeNull();
      expect(screen.getByText('contacts.core.page-customer-detail:customer-2')).toBeTruthy();
      expect(fx.renders).not.toContainEqual({ routeParams: resolvedModel.routeParams, target: resolvedModel.target });
    } finally {
      Deferred.doneUnsafe(oldRemote, Effect.succeed({ default: StaleRemoteComponent }));
    }
  }),
);

/** The same resolution, composed for another release than the one this document admitted. */
const otherReleaseModel = (): ResolvedPageModel => ({
  ...resolvedModel,
  shell: { ...shell, compositionRevision: 'e'.repeat(64) },
});

it.live('suppresses a resolved remote owner when Shell document admission requires reload', () =>
  Effect.gen(function* suppressesOwnerForAnotherRelease() {
    yield* pinDocumentCompositionRevision(resolvedModel.target.compositionRevision, document);
    const fx = yield* federation();

    yield* renderModulePage(otherReleaseModel());

    expect(screen.getByText('shell.moduleTarget.reload_required')).toBeTruthy();
    expect(fx.registered).toEqual([]);
    expect(fx.requests).toEqual([]);
    expect(fx.renders).toEqual([]);
  }),
);

it.live('unmounts an already loaded owner when current Shell admission requires reload', () =>
  Effect.gen(function* unmountsOwnerAfterAdmissionConflict() {
    const fx = yield* federation();
    const { show } = yield* renderModulePage(resolvedModel);
    yield* Effect.promise(() => screen.findByText('contacts.core.page-customers:customer-1'));
    const requestedBefore = fx.requests.length;

    expect(yield* executionsBeyond(fx, show, resolvedModel, otherReleaseModel())).toEqual([]);

    expect(screen.getByText('shell.moduleTarget.reload_required')).toBeTruthy();
    expect(screen.queryByText('contacts.core.page-customers:customer-1')).toBeNull();
    expect(fx.requests).toHaveLength(requestedBefore);
  }),
);

it.live('shows reload guidance for a Shell model rejected by document admission', () =>
  Effect.gen(function* showsReloadGuidance() {
    const fx = yield* federation();
    yield* renderModulePage({
      shell: { state: 'reload_required' },
      state: 'reload_required',
    } satisfies ModuleTargetPageModel);

    expect(screen.getByText('shell.moduleTarget.reload_required')).toBeTruthy();
    expect(screen.queryByText('shell.moduleTarget.selection_required')).toBeNull();
    expect(fx.registered).toEqual([]);
    expect(fx.requests).toEqual([]);
  }),
);

it.live('rejects an approved remote name that collides with the native Shell host', () =>
  Effect.gen(function* rejectsNativeHostIdentityCollision() {
    const fx = yield* federation();
    yield* renderModulePage({
      ...resolvedModel,
      target: {
        ...resolvedModel.target,
        federation: { ...resolvedModel.target.federation, remoteName: shellHostName },
      },
    } satisfies ResolvedPageModel);

    expect(yield* Effect.promise(() => screen.findByText('shell.moduleTarget.incompatible'))).toBeTruthy();
    expect(fx.registered).toEqual([]);
    expect(fx.requests).toEqual([]);
    expect(fx.renders).toEqual([]);
  }),
);

/** The props a page and its `preloadPage` both receive for `model` under the authenticated shell fixture. */
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

const skeletonOf = (container: HTMLElement) => container.querySelector('[data-module-page-skeleton]');

it.live('a cold page shows one neutral skeleton, then its content once code and primary data are ready', () =>
  Effect.gen(function* revealsAfterPreparation() {
    const preloaded = Deferred.makeUnsafe<ModulePageProps>();
    const data = Deferred.makeUnsafe<true>();
    const received: ModulePageProps[] = [];
    const PreparedPage = (props: ModulePageProps & { readonly target: ResolvedModuleTarget }) => {
      received.push(props);
      return <div>prepared page</div>;
    };
    const preloadPage = (props: ModulePageProps) =>
      browserRuntime.runPromise(Deferred.succeed(preloaded, props).pipe(Effect.andThen(Deferred.await(data))));
    yield* federation({
      scripted: answeringOnce({
        [exposeRequest(resolvedModel.target)]: Effect.succeed({ default: PreparedPage, preloadPage }),
      }),
    });
    const { view } = yield* renderModulePage(resolvedModel);
    expect(skeletonOf(view.container)).not.toBeNull();

    // The page's own preload received exactly the props the page will render with.
    expect(yield* Deferred.await(preloaded)).toEqual(expectedPageProps(resolvedModel));
    yield* reactSettled;
    // The code is loaded, but the page waits for its data instead of showing its own loading state.
    expect(screen.queryByText('prepared page')).toBeNull();
    expect(skeletonOf(view.container)).not.toBeNull();

    yield* Deferred.succeed(data, true);
    expect(yield* Effect.promise(() => screen.findByText('prepared page'))).toBeTruthy();
    expect(skeletonOf(view.container)).toBeNull();
    expect(received.at(-1)).toEqual({ ...expectedPageProps(resolvedModel), target: resolvedModel.target });
  }),
);

it.live('a prepared page renders its content in the first commit, without any placeholder', () =>
  Effect.gen(function* rendersPreparedPageAtOnce() {
    const preloads: ModulePageProps[] = [];
    const preloadPage = (props: ModulePageProps) => {
      preloads.push(props);
      return Promise.resolve();
    };
    yield* federation({
      scripted: answeringOnce({
        [exposeRequest(resolvedModel.target)]: Effect.succeed({ default: ReadyAtOnce, preloadPage }),
      }),
    });
    const prepared = yield* prepareModulePage(
      resolvedModel.target,
      expectedPageProps(resolvedModel),
      '/en/contacts',
      '5 seconds',
    );
    expect(Option.isSome(prepared)).toBe(true);
    expect(preloads).toEqual([expectedPageProps(resolvedModel)]);

    const { view } = yield* renderModulePage(resolvedModel);

    expect(screen.getByText('ready at once')).toBeTruthy();
    expect(skeletonOf(view.container)).toBeNull();
    expect(screen.queryByText('shell.moduleTarget.loading')).toBeNull();
  }),
);
