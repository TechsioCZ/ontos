import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, rstest, it } from 'effect-rstest';
import type { ReactNode } from 'react';

import { ResolvedModuleTargetSchema } from '../../../../shared/api.ts';
import ContactsPage from '../../../../src/routes/[lang]/contacts/page.tsx';
import type { ModuleTargetPageModel } from '../../../../src/routes/[lang]/modules/[moduleId]/page.data.ts';
import ModuleTargetPage from '../../../../src/routes/[lang]/modules/[moduleId]/page.tsx';
import { authenticatedShellFixture } from '../authenticated-shell-fixture.ts';

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

const shell: ResolvedPageModel['shell'] = authenticatedShellFixture();

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

it.each([
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

it.live(
  'invokes the exact private page loader only after a resolved authenticated response',
  () =>
    Effect.gen(function* invokesTheExactPrivatePageLoader() {
      useLoaderDataMock.mockReturnValue(resolvedModel);
      render(<ModuleTargetPage />);
      expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(
        resolvedModel.target
      );
      yield* Effect.promise(() =>
        waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1))
      );
      expect(
        yield* Effect.promise(() =>
          screen.findByText('contacts.core.page-customers:customer-1')
        )
      ).toBeTruthy();
    })
);

it('reads loader data from the active Party Registry owner route', () => {
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

it.live(
  'maps an unreachable approved remote to its safe local diagnostic',
  () =>
    Effect.gen(function* mapsAnUnreachableApprovedRemoteTo() {
      loadRemotePageMock.mockRejectedValueOnce(
        new Error('private remote error')
      );
      useLoaderDataMock.mockReturnValue(resolvedModel);

      render(<ModuleTargetPage />);

      expect(
        yield* Effect.promise(() =>
          screen.findByText('shell.moduleTarget.unavailable')
        )
      ).toBeTruthy();
    })
);

it.live('rejects a malformed remote module before React receives it', () =>
  Effect.gen(function* rejectsAMalformedRemoteModuleBefore() {
    loadRemotePageMock.mockResolvedValueOnce({ default: 'not a component' });
    useLoaderDataMock.mockReturnValue(resolvedModel);

    render(<ModuleTargetPage />);

    expect(
      yield* Effect.promise(() =>
        screen.findByText('shell.moduleTarget.incompatible')
      )
    ).toBeTruthy();
    expect(remotePropsMock).not.toHaveBeenCalled();
  })
);

it.live(
  'passes an empty route-parameter record to a resolved static page',
  () =>
    Effect.gen(function* passesAnEmptyRouteParameterRecord() {
      useLoaderDataMock.mockReturnValue({ ...resolvedModel, routeParams: {} });
      render(<ModuleTargetPage />);
      yield* Effect.promise(() =>
        waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1))
      );
      expect(
        yield* Effect.promise(() =>
          screen.findByText('contacts.core.page-customers:static')
        )
      ).toBeTruthy();
    })
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

      expect(findApprovedVerticalPageClientMock).toHaveBeenCalledWith(
        exactModel.target
      );
      yield* Effect.promise(() =>
        waitFor(() => expect(loadRemotePageMock).toHaveBeenCalledTimes(1))
      );
      expect(remotePropsMock).toHaveBeenCalledWith({
        routeParams,
        target: exactModel.target,
      });
      expect(
        yield* Effect.promise(() => screen.findByText(renderedText))
      ).toBeTruthy();
    })
);
