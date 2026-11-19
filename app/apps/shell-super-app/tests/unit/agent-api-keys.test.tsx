// @rstest-environment happy-dom
// Agent API keys over the real Shell identity client, Shell copy and TanStack navigation guard.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, waitUntil } from '@app/admin-ui/testing/module-ui';
import { AgentEntitySchema } from '@app/shared-contracts/agent-access';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { networkIdle, networkQuietExcept, streamingBrowserNetwork } from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Deferred, Effect, Layer, Redacted, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';

import {
  ApiKeyLifecycleResponseSchema,
  ManagedApiKeyListItemSchema,
  ShellAuthenticationApi,
  ShellInternalProblemSchema,
  shellAuthenticationApiContract,
} from '../../shared/browser-api.ts';
import type {
  ApiKeyIssueResponse,
  ApiKeyLifecycleResponse,
  IssueManagedApiKeyPayload,
  ManagedApiKeyListPayload,
  ManagedApiKeyListResponse,
  RotateManagedApiKeyPayload,
  SetManagedApiKeyStatusPayload,
} from '../../shared/browser-api.ts';
import { AgentApiKeys } from '../../src/routes/people/agent-api-keys.tsx';
import { shellLocaleCopy } from '../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../support/shell-router.tsx';

const translations = shellLocaleCopy('cs');
const copy = (key: string) => {
  expect(translations.exists(`shell.agents.keys.${key}`)).toBe(true);
  return translations.t(`shell.agents.keys.${key}`);
};
const labels = saveLabelsFor('cs');
const principalId = '00000000-0000-4000-8000-000000000003';
const authBindingId = '00000000-0000-4000-8000-000000000004';
const otherPrincipalId = '00000000-0000-4000-8000-000000000005';
const testSecret = 'one-time-test-credential';
const lifecycle = Schema.decodeUnknownSync(ApiKeyLifecycleResponseSchema)({
  authBindingId,
  cleanupPending: false,
  createdAt: '2026-10-24T10:00:00.000Z',
  enabled: true,
  expiresAt: null,
  name: 'Automation',
  start: 'native-key',
});
type ListedItem = ManagedApiKeyListResponse['items'][number];
type ListedKey = NonNullable<ListedItem['key']>;
const key: ListedKey = { ...lifecycle, bindingStatus: 'active' };
const row: ListedItem = {
  ...Schema.decodeUnknownSync(ManagedApiKeyListItemSchema)({
    displayName: 'Agent',
    key: null,
    kind: 'agent',
    principalId,
    principalStatus: 'active',
  }),
  key,
};
const withKey = (changes: Partial<ListedKey>, rowChanges: Partial<ListedItem> = {}): ListedItem => ({
  ...row,
  ...rowChanges,
  key: { ...key, ...changes },
});
const issued = (cleanupPending: boolean): ApiKeyIssueResponse => ({
  ...lifecycle,
  cleanupPending,
  secret: Redacted.make(testSecret),
});
const secondBindingId = Schema.decodeUnknownSync(ApiKeyLifecycleResponseSchema.fields.authBindingId)(
  '00000000-0000-4000-8000-000000000006',
);
const otherPrincipal = Schema.decodeUnknownSync(ManagedApiKeyListItemSchema.fields.principalId)(otherPrincipalId);
const agent = Schema.decodeUnknownSync(AgentEntitySchema)({
  connections: [],
  description: null,
  displayName: 'Agent',
  hasProfile: true,
  operators: [],
  operatorsRevision: 0,
  owner: null,
  principalId,
  roles: [],
  status: 'active',
  usable: [],
  writePolicy: 'approval',
});

/** One command the identity endpoint received, with the idempotency key the client sent it under. */
interface Received<Payload> {
  readonly idempotencyKey: string | undefined;
  readonly payload: Payload;
}

const identity = ShellAuthenticationApi.groups.identity.endpoints;
const KeysApi = HttpApi.make('agentApiKeys')
  .add(
    HttpApiGroup.make('identity')
      .add(identity.issueManagedApiKey)
      .add(identity.listManagedApiKeys)
      .add(identity.rotateManagedApiKey)
      .add(identity.setManagedApiKeyStatus),
  )
  .prefix(shellAuthenticationApiContract.apiPrefix);

const listOf = (items: ManagedApiKeyListResponse['items'], nextOffset: number | null = null) =>
  Effect.succeed<ManagedApiKeyListResponse>({ items, nextOffset });

let lists: ManagedApiKeyListPayload[] = [];
let issues: Received<IssueManagedApiKeyPayload>[] = [];
let rotations: Received<RotateManagedApiKeyPayload>[] = [];
let statuses: Received<SetManagedApiKeyStatusPayload>[] = [];
/** What the list answers next; a case replaces it to change what the server holds. */
const firstPage = ({ offset }: ManagedApiKeyListPayload) => listOf(offset === 0 ? [row] : []);
let listAnswer: (payload: ManagedApiKeyListPayload) => Effect.Effect<ManagedApiKeyListResponse> = firstPage;
let issueAnswer: Effect.Effect<ApiKeyIssueResponse, typeof ShellInternalProblemSchema.Type> = Effect.succeed(
  issued(false),
);
/** The answer of a server that may or may not have issued the key: the client cannot know. */
const ambiguous = ShellInternalProblemSchema.make({
  detail: 'Not safe to display',
  status: ShellInternalProblemSchema.fields.status.literal,
  title: 'Internal error',
  type: 'https://ontos.dev/problems/internal',
});
const rotateAnswer = Effect.succeed(issued(true));
const statusAnswer: Effect.Effect<ApiKeyLifecycleResponse> = Effect.succeed(lifecycle);

const network = streamingBrowserNetwork(
  HttpApiBuilder.layer(KeysApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(KeysApi, 'identity', (group) =>
        group
          .handle('listManagedApiKeys', ({ payload }) =>
            Effect.suspend(() => {
              lists.push(payload);
              return listAnswer(payload);
            }),
          )
          .handle('issueManagedApiKey', ({ payload, request }) =>
            Effect.suspend(() => {
              issues.push({ idempotencyKey: request.headers['idempotency-key'], payload });
              return issueAnswer;
            }),
          )
          .handle('rotateManagedApiKey', ({ payload, request }) =>
            Effect.suspend(() => {
              rotations.push({ idempotencyKey: request.headers['idempotency-key'], payload });
              return rotateAnswer;
            }),
          )
          .handle('setManagedApiKeyStatus', ({ payload, request }) =>
            Effect.suspend(() => {
              statuses.push({ idempotencyKey: request.headers['idempotency-key'], payload });
              return statusAnswer;
            }),
          ),
      ),
    ),
    Layer.provide(HttpServer.layerServices),
  ),
);

beforeEach(() => {
  lists = [];
  issues = [];
  rotations = [];
  statuses = [];
  listAnswer = firstPage;
  issueAnswer = Effect.succeed(issued(false));
});
afterEach(() => {
  cleanup();
  rstest.useRealTimers();
});

/** Mounts the keys under the Shell's router and copy; `rerender` swaps the element in place. */
const mountKeys = (initial: ReactElement) =>
  Effect.gen(function* mountKeysRoute() {
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
    const view = yield* renderShellRoute(router, translations);
    const rerender = (next: ReactElement) =>
      acted(() => {
        current = next;
        for (const listener of listeners) {
          listener();
        }
      });
    return { rerender, unmount: view.unmount };
  });

const click = (element: HTMLElement) =>
  acted(() => {
    fireEvent.click(element);
  });
const type = (label: string, value: string) =>
  acted(() => {
    fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
  });
const shown = (find: () => HTMLElement | null) =>
  waitUntil(() => find() !== null).pipe(Effect.map(() => find() ?? document.body));
const button = (name: string) => screen.getByRole('button', { name });
const isDisabled = (name: string) => button(name).hasAttribute('disabled');

const liveChange = (apps: readonly string[] | 'all') =>
  acted(() => {
    window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps } }));
  });

/** Moves the faked page timers on by `millis` and flushes what React rendered meanwhile. */
const advancePageClock = (millis: number) =>
  Effect.promise(async () => {
    await act(async () => {
      await rstest.advanceTimersByTimeAsync(millis);
    });
  });
/** `shown` for a case whose page timers are faked: the page clock moves 100 ms per look. */
const shownOnFakeClock = (find: () => HTMLElement | null, looks = 200): Effect.Effect<HTMLElement> =>
  Effect.suspend(() =>
    find() !== null || looks === 0
      ? Effect.sync(() => find() ?? document.body)
      : advancePageClock(100).pipe(Effect.andThen(shownOnFakeClock(find, looks - 1))),
  );

/** Every value the document keeps in its storages. */
const stored = () =>
  [window.localStorage, window.sessionStorage].flatMap((storage) =>
    Array.from({ length: storage.length }, (_, index) => {
      const name = storage.key(index) ?? '';
      return [name, storage.getItem(name)] as const;
    }),
  );

it.live(
  'loads when shown with exact company-agent principal scope, never tenant-wide or prefix-derived ownership',
  () =>
    Effect.gen(function* loadScopedKeys() {
      yield* mountKeys(<AgentApiKeys agent={agent} />);
      expect(screen.queryByRole('button', { name: copy('retry') })).toBeNull();
      expect(yield* shown(() => screen.queryByText('Automation'))).toBeTruthy();
      expect(lists).toEqual([{ limit: 100, offset: 0, principalId, scope: 'company-agent' }]);
      expect(screen.getByText(copy('status.active'))).toBeTruthy();
    }).pipe(Effect.provide(network)),
);

it.live('issues only after explicit confirmation, displays the secret once and never persists it', () =>
  Effect.gen(function* issueOneTimeSecret() {
    const storedBefore = stored();
    const view = yield* mountKeys(<AgentApiKeys agent={agent} />);
    yield* waitUntil(() => screen.queryByText('Automation') !== null);
    yield* click(button(copy('issue')));
    yield* networkIdle;
    expect(issues).toHaveLength(0);
    yield* type(copy('name'), 'Worker');
    yield* click(button(labels.save));
    const secretField = yield* shown(() => screen.queryByDisplayValue(testSecret));
    expect(secretField?.hasAttribute('readonly')).toBe(true);
    expect(issues).toEqual([
      { idempotencyKey: expect.any(String), payload: { name: 'Worker', principalId, scope: 'company-agent' } },
    ]);
    expect(stored()).toEqual(storedBefore);
    yield* click(button(copy('hideSecret')));
    expect(screen.queryByDisplayValue(testSecret)).toBeNull();
    // Live changes of other apps cost no read; a change of Core-owned data reloads the keys.
    yield* networkIdle;
    expect(lists).toHaveLength(2);
    yield* liveChange(['crm']);
    yield* networkIdle;
    expect(lists).toHaveLength(2);
    yield* liveChange(['shell']);
    yield* waitUntil(() => lists.length === 3);
    expect(screen.queryByDisplayValue(testSecret)).toBeNull();
    view.unmount();
    yield* mountKeys(<AgentApiKeys agent={agent} />);
    expect(screen.queryByDisplayValue(testSecret)).toBeNull();
    yield* networkIdle;
    expect(issues).toHaveLength(1);
    expect(stored()).toEqual(storedBefore);
  }).pipe(Effect.provide(network)),
);

it.live('rotates the exact binding with a reason and reports pending cleanup without claiming revocation', () =>
  Effect.gen(function* rotateExactBinding() {
    yield* mountKeys(<AgentApiKeys agent={agent} />);
    yield* click((yield* shown(() => screen.queryByRole('button', { name: copy('rotate') }))) ?? document.body);
    expect(isDisabled(labels.save)).toBe(true);
    yield* type(copy('reason'), 'Scheduled rotation');
    yield* click(button(labels.save));
    expect(yield* shown(() => screen.queryByDisplayValue(testSecret))).toBeTruthy();
    expect(screen.getByText(copy('cleanupPending'))).toBeTruthy();
    expect(rotations.map(({ payload }) => payload)).toEqual([
      {
        name: 'Automation',
        oldAuthBindingId: authBindingId,
        principalId,
        reason: 'Scheduled rotation',
        scope: 'company-agent',
      },
    ]);
  }).pipe(Effect.provide(network)),
);

it.live('uses the actual binding status to revoke a disabled key, not its provider enabled flag', () =>
  Effect.gen(function* revokeDisabledBinding() {
    listAnswer = () => listOf([withKey({ bindingStatus: 'disabled' })]);
    yield* mountKeys(<AgentApiKeys agent={agent} />);
    expect(yield* shown(() => screen.queryByRole('button', { name: copy('enable') }))).toBeTruthy();
    yield* click(button(copy('revoke')));
    yield* type(copy('reason'), 'Credential retired');
    yield* click(button(labels.save));
    yield* waitUntil(() => statuses.length === 1);
    expect(statuses.map(({ payload }) => payload)).toEqual([
      {
        authBindingId,
        expectedStatus: 'disabled',
        newStatus: 'revoked',
        principalId,
        reason: 'Credential retired',
        scope: 'company-agent',
      },
    ]);
  }).pipe(Effect.provide(network)),
);

it.live('does not retry an ambiguous issuance and requires a fresh list before any further command', () =>
  Effect.gen(function* requireRereadAfterAmbiguousIssuance() {
    issueAnswer = Effect.fail(ambiguous);
    yield* mountKeys(<AgentApiKeys agent={agent} />);
    yield* waitUntil(() => screen.queryByText('Automation') !== null);
    yield* click(button(copy('issue')));
    yield* type(copy('name'), 'Worker');
    yield* click(button(labels.save));
    yield* waitUntil(() => screen.queryAllByText(copy('failed')).length > 0);
    // Uložit again never repeats the command: the list has to be read first.
    yield* click(button(labels.save));
    yield* networkIdle;
    expect(issues).toHaveLength(1);
    expect(lists).toHaveLength(1);
    expect(screen.queryByText('Not safe to display')).toBeNull();
    expect(screen.queryByDisplayValue(testSecret)).toBeNull();
    yield* click(button(copy('cancel')));
    // The typed name was never saved, so leaving asks; Zahodit změny closes the form.
    yield* click((yield* shown(() => screen.queryByRole('button', { name: labels.discard }))) ?? document.body);
    expect(isDisabled(copy('issue'))).toBe(true);
    // The unconfirmed state offers only an error-state retry of the read, never of the command.
    yield* click(button(copy('retry')));
    yield* waitUntil(() => !isDisabled(copy('issue')));
    yield* networkIdle;
    expect(issues).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.live('rejects an out-of-scope server response without revealing or filtering unrelated key metadata', () =>
  Effect.gen(function* rejectOutOfScopeMetadata() {
    listAnswer = () => listOf([withKey({ name: 'Other secret metadata' }, { principalId: otherPrincipal })]);
    yield* mountKeys(<AgentApiKeys agent={agent} />);
    expect(yield* shown(() => screen.queryByText(copy('failed')))).toBeTruthy();
    expect(screen.queryByText('Other secret metadata')).toBeNull();
    expect(isDisabled(copy('issue'))).toBe(true);
  }).pipe(Effect.provide(network)),
);

it.live('does not load or offer key issuance for an unaudited or inactive agent', () =>
  Effect.gen(function* withoutProfile() {
    const view = yield* mountKeys(<AgentApiKeys agent={{ ...agent, hasProfile: false }} />);
    expect(screen.getByText(copy('requiresProfile'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy('issue') })).toBeNull();
    yield* view.rerender(<AgentApiKeys agent={{ ...agent, status: 'disabled' }} />);
    expect(screen.queryByRole('button', { name: copy('issue') })).toBeNull();
    yield* networkIdle;
    expect(lists).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('interrupts an owned in-flight read when the agent detail closes', () =>
  Effect.gen(function* interruptOwnedRead() {
    const received = yield* Deferred.make<boolean>();
    const interrupted = yield* Deferred.make<boolean>();
    listAnswer = () =>
      Deferred.succeed(received, true).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, true)),
      );
    const view = yield* mountKeys(<AgentApiKeys agent={agent} />);
    yield* Deferred.await(received);
    yield* networkQuietExcept(1);
    expect(lists).toHaveLength(1);
    view.unmount();
    expect(yield* Deferred.await(interrupted)).toBe(true);
  }).pipe(Effect.provide(network)),
);

it.live('disables and re-enables only the exact binding with its current expected status', () =>
  Effect.gen(function* changeExactBindingStatus() {
    yield* mountKeys(<AgentApiKeys agent={agent} />);
    yield* click((yield* shown(() => screen.queryByRole('button', { name: copy('disable') }))) ?? document.body);
    yield* type(copy('reason'), 'Pause automation');
    listAnswer = () => listOf([withKey({ bindingStatus: 'disabled' })]);
    yield* click(button(labels.save));
    yield* click((yield* shown(() => screen.queryByRole('button', { name: copy('enable') }))) ?? document.body);
    yield* type(copy('reason'), 'Resume automation');
    listAnswer = firstPage;
    yield* click(button(labels.save));
    yield* waitUntil(() => statuses.length === 2);
    yield* networkIdle;
    expect(statuses.map(({ payload }) => payload)).toEqual([
      {
        authBindingId,
        expectedStatus: 'active',
        newStatus: 'disabled',
        principalId,
        reason: 'Pause automation',
        scope: 'company-agent',
      },
      {
        authBindingId,
        expectedStatus: 'disabled',
        newStatus: 'active',
        principalId,
        reason: 'Resume automation',
        scope: 'company-agent',
      },
    ]);
    expect(statuses[0]?.idempotencyKey).toEqual(expect.any(String));
    expect(statuses[0]?.idempotencyKey).not.toBe(statuses[1]?.idempotencyKey);
  }).pipe(Effect.provide(network)),
);

it.live('keeps principal scope on later pages instead of truncating the key list', () =>
  Effect.gen(function* loadScopedLaterPage() {
    listAnswer = ({ offset }) =>
      offset === 0 ? listOf([row], 100) : listOf([withKey({ authBindingId: secondBindingId, name: 'Second key' })]);
    yield* mountKeys(<AgentApiKeys agent={agent} />);
    yield* click((yield* shown(() => screen.queryByRole('button', { name: copy('more') }))) ?? document.body);
    expect(yield* shown(() => screen.queryByText('Second key'))).toBeTruthy();
    expect(screen.getByText('Automation')).toBeTruthy();
    expect(lists[1]).toEqual({ limit: 100, offset: 100, principalId, scope: 'company-agent' });
  }).pipe(Effect.provide(network)),
);

it.live('keeps a committed key change pending until the reread confirms the actual binding projection', () =>
  Effect.gen(function* awaitActualBindingProjection() {
    yield* mountKeys(<AgentApiKeys agent={agent} />);
    yield* click((yield* shown(() => screen.queryByRole('button', { name: copy('disable') }))) ?? document.body);
    yield* type(copy('reason'), 'Pause automation');
    // The re-read pauses run on the page's own timers; this case moves them instead of waiting for them.
    rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    yield* Effect.sync(() => {
      act(() => {
        fireEvent.click(button(labels.save));
      });
    });
    expect(yield* shownOnFakeClock(() => screen.queryByText(copy('projectionPending')))).toBeTruthy();
    expect(screen.queryByText(copy('updated'))).toBeNull();
    expect(isDisabled(copy('disable'))).toBe(true);
    listAnswer = () => listOf([withKey({ bindingStatus: 'disabled' })]);
    // The list re-reads by itself until the projection shows the committed change.
    expect(yield* shownOnFakeClock(() => screen.queryByText(copy('updated')))).toBeTruthy();
    yield* networkIdle;
    expect(statuses).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);
