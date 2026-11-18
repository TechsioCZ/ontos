// @rstest-environment happy-dom
// Operators use their real browser client, Shell copy, and TanStack navigation guard.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  AgentEntitySchema,
  AgentOperatorsRequestSchema,
  CONNECTION_MANAGEMENT_PATHS,
  PrincipalRefSchema,
} from '@app/shared-contracts/agent-access';
import type { AgentOperatorsRequest } from '@app/shared-contracts/agent-access';
import { browserNetwork, networkIdle } from '@app/shared-contracts/testing/http-double';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';

import { OperatorsBlock } from '../../src/routes/people/agent-operators-block.tsx';
import { shellLocaleCopy } from '../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../support/shell-router.tsx';
import type { ShellRouter } from '../support/shell-router.tsx';

const labels = saveLabelsFor('cs');
afterEach(cleanup);

// The operators endpoint is a native Shell JSON route, rather than an HttpApi endpoint.
const operatorsEndpoint = (answer: 'conflict' | 'ok' = 'ok') => {
  const requests: AgentOperatorsRequest[] = [];
  const application = HttpRouter.add(
    'POST',
    CONNECTION_MANAGEMENT_PATHS.operators,
    Effect.gen(function* receiveOperators() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const payload = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AgentOperatorsRequestSchema)));
      requests.push(payload);
      return answer === 'conflict'
        ? HttpServerResponse.jsonUnsafe({ detail: 'Operators changed' }, { status: 409 })
        : HttpServerResponse.jsonUnsafe({
            agentPrincipalId: payload.agentPrincipalId,
            operators: [],
            revokedConnections: 0,
          });
    }).pipe(Effect.orDie),
  );
  return { network: browserNetwork(application), requests };
};

// Keep the block mounted across navigation so the discarded draft can be inspected after leaving.
const mountOperators = (initial: ReactElement) =>
  Effect.gen(function* mountOperatorsRoute() {
    let current = initial;
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    const Root = () => (
      <>
        {useSyncExternalStore(subscribe, () => current)}
        <Outlet />
      </>
    );
    const router = makeShellRouter({ page: { component: () => null, path: 'people' }, root: Root, url: '/cs/people' });
    yield* renderShellRoute(router, shellLocaleCopy('cs'));
    yield* settle;
    const rerender = (next: ReactElement) =>
      acted(() => {
        current = next;
        for (const listener of listeners) {
          listener();
        }
      });
    return { rerender, router };
  });

const navigate = (router: ShellRouter, to: string) =>
  acted(() => {
    void router.navigate({ to });
  });
const expectCleanNavigation = (router: ShellRouter) =>
  Effect.gen(function* cleanNavigation() {
    const start = router.state.location.pathname;
    const destination = start === '/cs' ? '/cs/people' : '/cs';
    yield* navigate(router, destination);
    yield* waitUntil(() => router.state.location.pathname === destination);
    expect(router.state.location.pathname).toBe(destination);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    yield* navigate(router, start);
    yield* waitUntil(() => router.state.location.pathname === start);
  });
const expectDirtyNavigation = (router: ShellRouter) =>
  Effect.gen(function* dirtyNavigation() {
    yield* navigate(router, '/cs');
    yield* waitUntil(() => screen.queryByRole('alertdialog') !== null);
    expect(router.state.location.pathname).toBe('/cs/people');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    yield* acted(() => {
      fireEvent.click(screen.getByRole('button', { name: labels.stay }));
    });
    yield* waitUntil(() => screen.queryByRole('alertdialog') === null);
  });

const decodePerson = Schema.decodeUnknownSync(PrincipalRefSchema);
const jana = decodePerson({ displayName: 'Jana', principalId: '00000000-0000-4000-8000-000000000011' });
const petr = decodePerson({ displayName: 'Petr', principalId: '00000000-0000-4000-8000-000000000012' });
const agentWith = (operators: readonly (typeof jana)[], operatorsRevision: number) =>
  Schema.decodeUnknownSync(AgentEntitySchema)({
    connections: [],
    description: null,
    displayName: 'Asistent',
    hasProfile: true,
    operators,
    operatorsRevision,
    owner: null,
    principalId: '00000000-0000-4000-8000-000000000004',
    roles: [],
    status: 'active',
    usable: [],
    writePolicy: 'approval',
  });
const block = (operators: readonly (typeof jana)[], onChanged: () => void = () => {}, operatorsRevision = 0) => (
  <OperatorsBlock
    agent={agentWith(operators, operatorsRevision)}
    company="Firma"
    members={[jana, petr]}
    onChanged={onChanged}
    onNotify={() => {}}
  />
);
const checkbox = (person: typeof jana) => screen.getByRole('checkbox', { name: person.displayName });
const saveButton = () => screen.getByRole('button', { name: labels.save });

it.live('ticking sends nothing; Uložit sends the selection once with the revision it was read from', () => {
  const fixture = operatorsEndpoint();
  return Effect.gen(function* typeSaveOnce() {
    const { router } = yield* mountOperators(block([], () => {}, 3));
    yield* expectCleanNavigation(router);
    yield* acted(() => {
      fireEvent.click(checkbox(jana));
    });
    yield* networkIdle;
    expect(fixture.requests).toHaveLength(0);
    yield* expectDirtyNavigation(router);
    yield* acted(() => {
      fireEvent.click(saveButton());
    });
    yield* waitUntil(() => screen.queryByText(labels.saved) !== null);
    expect(screen.getByText(labels.saved)).toBeTruthy();
    yield* networkIdle;
    expect(fixture.requests).toEqual([
      {
        agentPrincipalId: '00000000-0000-4000-8000-000000000004',
        expectedRevision: 3,
        operatorPrincipalIds: [jana.principalId],
      },
    ]);
    yield* expectCleanNavigation(router);
  }).pipe(Effect.provide(fixture.network));
});

it.live('a dirty selection survives a server refresh', () =>
  Effect.gen(function* survivesRefresh() {
    const view = yield* mountOperators(block([]));
    yield* acted(() => {
      fireEvent.click(checkbox(jana));
    });
    yield* view.rerender(block([petr]));
    expect(checkbox(jana).getAttribute('aria-checked')).toBe('true');
    expect(checkbox(petr).getAttribute('aria-checked')).toBe('false');
    yield* expectDirtyNavigation(view.router);
  }),
);

it.live('a refused stale save shows a conflict and reloads the latest version', () => {
  const fixture = operatorsEndpoint('conflict');
  return Effect.gen(function* conflictReload() {
    let refreshed = 0;
    const onChanged = () => {
      refreshed += 1;
    };
    const view = yield* mountOperators(block([], onChanged));
    yield* acted(() => {
      fireEvent.click(checkbox(jana));
    });
    yield* acted(() => {
      fireEvent.click(saveButton());
    });
    yield* waitUntil(() => screen.queryByText(labels.conflict) !== null);
    expect(screen.getByText(labels.conflict)).toBeTruthy();
    yield* view.rerender(block([petr], onChanged));
    yield* acted(() => {
      fireEvent.click(screen.getByRole('button', { name: labels.reloadLatest }));
    });
    expect(refreshed).toBe(1);
    expect(checkbox(petr).getAttribute('aria-checked')).toBe('true');
    expect(checkbox(jana).getAttribute('aria-checked')).toBe('false');
    yield* networkIdle;
    expect(fixture.requests).toHaveLength(1);
  }).pipe(Effect.provide(fixture.network));
});

it.live('leaving with an unsaved selection asks, and Zahodit změny leaves', () => {
  const fixture = operatorsEndpoint();
  return Effect.gen(function* leaveDiscard() {
    const view = yield* mountOperators(block([]));
    const departures: string[] = [];
    const unsubscribe = view.router.subscribe('onResolved', ({ toLocation }) => {
      if (toLocation.pathname === '/cs') {
        departures.push(toLocation.pathname);
      }
    });
    yield* acted(() => {
      fireEvent.click(checkbox(jana));
    });
    yield* navigate(view.router, '/cs');
    yield* waitUntil(() => screen.queryByRole('button', { name: labels.discard }) !== null);
    yield* acted(() => {
      fireEvent.click(screen.getByRole('button', { name: labels.discard }));
    });
    yield* waitUntil(() => view.router.state.location.pathname === '/cs');
    expect(departures).toHaveLength(1);
    yield* networkIdle;
    expect(fixture.requests).toHaveLength(0);
    yield* view.rerender(block([]));
    yield* expectCleanNavigation(view.router);
    expect(checkbox(jana).getAttribute('aria-checked')).toBe('false');
    unsubscribe();
  }).pipe(Effect.provide(fixture.network));
});

it.live('Uložit in the leave question saves once and leaves', () => {
  const fixture = operatorsEndpoint();
  return Effect.gen(function* leaveSave() {
    const view = yield* mountOperators(block([]));
    const departures: string[] = [];
    const unsubscribe = view.router.subscribe('onResolved', ({ toLocation }) => {
      if (toLocation.pathname === '/cs') {
        departures.push(toLocation.pathname);
      }
    });
    yield* acted(() => {
      fireEvent.click(checkbox(petr));
    });
    yield* navigate(view.router, '/cs');
    yield* waitUntil(() => screen.queryByRole('alertdialog') !== null);
    const dialog = screen.getByRole('alertdialog');
    const buttons = dialog.querySelectorAll('button');
    const save = [...buttons].find((button) => button.textContent === labels.save);
    expect(save).toBeDefined();
    yield* acted(() => {
      fireEvent.click(save ?? dialog);
    });
    yield* waitUntil(() => view.router.state.location.pathname === '/cs');
    expect(departures).toHaveLength(1);
    yield* networkIdle;
    expect(fixture.requests).toHaveLength(1);
    unsubscribe();
  }).pipe(Effect.provide(fixture.network));
});
