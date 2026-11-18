// @rstest-environment happy-dom
import { acted, settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  AgentAccessClientIdSchema,
  AgentAccessGrantIdSchema,
  ConnectionSummarySchema,
} from '@app/shared-contracts/agent-access';
import type { ConnectionLimits, ConnectionSummary, ConnectionUpdateRequest } from '@app/shared-contracts/agent-access';
import { AgentModuleKeySchema, AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { browserNetwork, networkIdle, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import type { ComponentProps } from 'react';

import {
  ShellAuthenticationApi,
  shellAuthenticationApiContract,
  ShellPolicyConflictProblemSchema,
} from '../../shared/browser-api.ts';
import { ConnectedAppsEditPanel } from '../../src/routes/[lang]/profile/connected-apps-edit-panel.tsx';
import { shellLocaleCopy } from '../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../support/shell-router.tsx';

afterEach(cleanup);

const warehouse = AgentModuleKeySchema.make('warehouse');
const limits: ConnectionLimits = {
  maxWritePolicy: 'approval',
  modules: [{ label: 'Sklad', moduleId: warehouse, read: true, write: true }],
};
const connection: ConnectionSummary = Schema.decodeUnknownSync(ConnectionSummarySchema)({
  acting: { displayName: 'Jana Nováková', kind: 'human', principalId: AgentPrincipalIdSchema.make('person-1') },
  allModules: false,
  client: {
    clientId: AgentAccessClientIdSchema.make('client-a'),
    host: 'chatgpt.com',
    kind: 'cimd',
    logoUri: null,
    name: 'ChatGPT',
  },
  createdAt: '2026-10-01T10:00:00.000Z',
  delegatedBy: null,
  granted: { modules: [{ access: 'write', moduleId: warehouse }], writePolicy: 'approval' },
  grantId: AgentAccessGrantIdSchema.make('g1'),
  lastUsedAt: null,
  legalEntityId: 'company-a',
  legalName: 'Firma A',
  limits,
  live: true,
  modules: [{ label: 'Sklad', moduleId: warehouse, read: true, write: true }],
  profileId: 'profile-1',
  revokedAt: null,
  revokeNote: null,
  revokeReason: null,
  status: 'active',
  tenantId: 'tenant-1',
  user: { displayName: 'Jana Nováková', principalId: AgentPrincipalIdSchema.make('person-1') },
  writePolicy: 'approval',
});

/** Serve the production update endpoint, including its request, response and Problem Details codecs. */
const UpdateApi = HttpApi.make('connectionEditTest')
  .add(
    HttpApiGroup.make('oauthConnectionsAdmin').add(
      ShellAuthenticationApi.groups.oauthConnectionsAdmin.endpoints.updateConnectionAccess,
    ),
  )
  .prefix(shellAuthenticationApiContract.apiPrefix);

const connectionBff = (revoked = false) => {
  const requests: ConnectionUpdateRequest[] = [];
  const handlers = HttpApiBuilder.group(UpdateApi, 'oauthConnectionsAdmin', (group) =>
    group.handle('updateConnectionAccess', ({ payload }) =>
      Effect.suspend(() => {
        requests.push(payload);
        return revoked
          ? Effect.fail(
              ShellPolicyConflictProblemSchema.make({
                detail: 'Připojení bylo odvoláno.',
                status: 409,
                title: 'Connection revoked',
                type: 'https://ontos.dev/problems/connection-revoked',
              }),
            )
          : Effect.succeed({ grantId: connection.grantId, status: 'active' as const });
      }),
    ),
  );
  return { network: browserNetwork(serveApi(UpdateApi, handlers)), requests };
};

const callbacks = () => {
  const closed: true[] = [];
  const saved: string[] = [];
  const stale: string[] = [];
  return {
    closed,
    props: {
      onClose: () => {
        closed.push(true);
      },
      onSaved: (name: string) => {
        saved.push(name);
      },
      onStale: (notice: string) => {
        stale.push(notice);
      },
    },
    saved,
    stale,
  };
};

const renderPanel = (props: Omit<ComponentProps<typeof ConnectedAppsEditPanel>, 'connection'>) =>
  Effect.gen(function* mountPanel() {
    const router = makeShellRouter({
      page: { component: () => <ConnectedAppsEditPanel connection={connection} {...props} />, path: 'profile' },
      url: '/cs/profile',
    });
    yield* renderShellRoute(router, shellLocaleCopy('cs'));
    yield* settle;
    return router;
  });

/** The panel footer's Zavřít; the dialog's own close trigger carries the same label. */
const closeButton = (): HTMLElement => {
  const last = screen.getAllByRole('button', { name: 'Zavřít' }).at(-1);
  if (last === undefined) {
    throw new Error('The panel footer has no Zavřít button.');
  }
  return last;
};

const click = (element: HTMLElement) =>
  Effect.promise(async () => {
    await userEvent.setup().click(element);
  }).pipe(Effect.andThen(settle));

const saveButton = (): HTMLElement => screen.getByRole('button', { name: 'Uložit' });

it.live('changing the access writes nothing until Uložit, which writes once', () => {
  const bff = connectionBff();
  return Effect.gen(function* editThenSave() {
    yield* renderPanel(callbacks().props);
    yield* click(screen.getByRole('radio', { name: 'Jen čtení' }));
    yield* networkIdle;
    expect(bff.requests).toHaveLength(0);
    yield* click(saveButton());
    yield* waitUntil(() => document.querySelector('[data-save-state="saved"]') !== null);
    yield* networkIdle;
    expect(bff.requests).toHaveLength(1);
    expect(bff.requests[0]).toMatchObject({ grantId: 'g1', writePolicy: 'read_only' });
  }).pipe(Effect.provide(bff.network));
});

it.live('leaving with unsaved changes asks first, and Zahodit změny sends nothing', () => {
  const bff = connectionBff();
  return Effect.gen(function* leaveAsks() {
    const events = callbacks();
    yield* renderPanel(events.props);
    yield* click(screen.getByRole('radio', { name: 'Jen čtení' }));
    yield* click(closeButton());
    expect(events.closed).toHaveLength(0);
    yield* click(screen.getByRole('button', { name: 'Zahodit změny' }));
    yield* networkIdle;
    expect(bff.requests).toHaveLength(0);
    expect(events.closed).toHaveLength(1);
  }).pipe(Effect.provide(bff.network));
});

it.live('says so and closes when the connection was revoked elsewhere', () => {
  const bff = connectionBff(true);
  return Effect.gen(function* revokedElsewhere() {
    const events = callbacks();
    yield* renderPanel(events.props);
    yield* click(screen.getByRole('radio', { name: 'Jen čtení' }));
    yield* click(saveButton());
    yield* waitUntil(() => events.stale.length > 0);
    expect(events.stale.length).toBeGreaterThan(0);
    expect(events.closed).toHaveLength(1);
  }).pipe(Effect.provide(bff.network));
});

it.live('a route change with unsaved changes asks first, and Zahodit změny lets it go without saving', () => {
  const bff = connectionBff();
  return Effect.gen(function* routeChangeAsks() {
    const router = yield* renderPanel(callbacks().props);
    // An unchanged panel permits a real route navigation without asking.
    yield* acted(() => {
      void router.navigate({ search: { clean: 1 }, to: '/cs/profile' });
    });
    expect(router.state.location.href).toBe('/cs/profile?clean=1');
    expect(screen.queryByRole('button', { name: 'Zahodit změny' })).toBeNull();
    yield* click(screen.getByRole('radio', { name: 'Jen čtení' }));
    const navigations: string[] = [];
    const unsubscribe = router.history.subscribe(({ location }: { readonly location: { readonly href: string } }) => {
      navigations.push(location.href);
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    yield* acted(() => {
      void router.navigate({ to: '/cs' });
    });
    yield* waitUntil(() => screen.queryByRole('button', { name: 'Zahodit změny' }) !== null);
    expect(router.state.location.href).toBe('/cs/profile?clean=1');
    yield* click(screen.getByRole('button', { name: 'Zahodit změny' }));
    expect(router.state.location.pathname).toBe('/cs');
    expect(navigations).toEqual(['/cs']);
    yield* networkIdle;
    expect(bff.requests).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(bff.network));
});
