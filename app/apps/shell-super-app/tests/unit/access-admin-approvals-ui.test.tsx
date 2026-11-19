import { networkIdle, networkQuietExcept } from '@app/shared-contracts/testing/http-double';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest, test } from 'effect-rstest';
import { createInstance } from 'i18next';
import type { i18n } from 'i18next';
import type { ReactNode } from 'react';

import cs from '../../locales/cs/shell.json';
import en from '../../locales/en/shell.json';
import { AccessApprovalSchema, AccessRecordKeySchema } from '../../shared/access-admin-api.ts';
import { CurrentSessionSchema } from '../../shared/browser-api.ts';
import type { AccessAdminProblem, AccessApproval } from '../../shared/access-admin-api.ts';
import { approvalsClient } from '../../src/routes/access-admin/approvals/approvals-client.ts';
import {
  approvalsViewModel,
  decideApproval,
  executeApproval,
  loadApprovalsPage,
  refreshApprovals,
} from '../../src/routes/[lang]/access/approvals/approvals-page-model.ts';
import { routeMeta } from '../../src/routes/[lang]/access/approvals/route.meta.ts';
import { ApprovalClientFailure } from '../../src/routes/access-admin/approvals/approvals-contract.ts';
import type { ApprovalsClient } from '../../src/routes/access-admin/approvals/approvals-contract.ts';
import { ApprovalsFeature } from '../../src/routes/access-admin/approvals/approvals-feature.tsx';
import { ApprovalsInbox } from '../../src/routes/access-admin/approvals/approvals-inbox.tsx';
import { adaSelectingCompany, makeShellBff, signedInShellReads } from '../support/shell-bff-double.ts';
import type { ShellBffScript } from '../support/shell-bff-double.ts';
import { ShellI18n } from '../support/shell-i18n.tsx';

/** Every key the views asked for that the P13 copy does not hold; each test must end with none. */
const missingKeys: string[] = [];
const copyOf = (copy: typeof en | typeof cs): i18n => {
  const language = copy === cs ? 'cs' : 'en';
  const instance = createInstance();
  void instance.init({
    initAsync: false,
    lng: language,
    missingKeyHandler: (_languages, _namespace, key) => {
      missingKeys.push(key);
    },
    resources: { [language]: { translation: copy } },
    saveMissing: true,
  });
  return instance;
};
const translations = { current: copyOf(en) };
const setCopy = (copy: typeof en | typeof cs) => {
  translations.current = copyOf(copy);
};
/** The Shell's real i18n context over the copy the test selected. */
const ShellCopy = ({ children }: { readonly children: ReactNode }) => (
  <ShellI18n translations={translations.current}>{children}</ShellI18n>
);
const renderCopy = (ui: Parameters<typeof render>[0]) => render(ui, { wrapper: ShellCopy });

const proposal = (overrides: Partial<AccessApproval> = {}): AccessApproval => ({
  ...Schema.decodeUnknownSync(AccessApprovalSchema)({
    capabilityKey: 'finance.invoice.issue',
    capabilityLabel: 'Issue invoice',
    command: {
      actionKey: 'finance.invoice.issue',
      capabilityKey: 'finance.invoice.issue',
      digestShort: '0123456789ab',
      fields: [{ label: 'Total', value: '100 CZK' }],
      frozenAt: '2026-11-03T08:00:00Z',
      redactedFieldCount: 1,
      target: { label: 'Invoice 42', recordKey: '40000000-0000-4000-8000-000000000001' },
    },
    commandDigest: 'a'.repeat(64),
    createdAt: '2026-11-03T08:00:00Z',
    execution: { available: false, reason: 'mandate_runner_unproven' },
    expiresAt: '2026-11-10T08:00:00Z',
    permitted: { approval: { allowed: true }, rejection: { allowed: true }, withdrawal: { allowed: false } },
    proposalId: '10000000-0000-4000-8000-000000000001',
    requester: { displayName: 'Requesting person', kind: 'human', principalId: '30000000-0000-4000-8000-000000000001' },
    revision: 'revision-1',
    risk: 'critical',
    scope: { accessScopeId: '20000000-0000-4000-8000-000000000001', kind: 'tenant' },
    status: 'pending',
  }),
  ...overrides,
});

const list = (item = proposal()) => ({ items: [item], nextCursor: null });
const request = () => new Request('https://shell.example.test/cs/access/approvals');
const callbacks = () => ({
  onDecision: rstest.fn(),
  onExecute: rstest.fn(),
  onNextPage: rstest.fn(),
  onRefresh: rstest.fn(),
  pending: false,
});
const mockClient = (overrides: Partial<ApprovalsClient> = {}): ApprovalsClient => ({
  decide: () => Effect.void,
  execute: () => Effect.void,
  list: () => Effect.succeed(list()),
  ...overrides,
});
const commandKey = '50000000-0000-4000-8000-000000000001';

/**
 * The Shell BFF of a person signed in to the Tenant without a selected company, whose approval
 * inbox, decisions and executions the native client reaches over HTTP.
 */
const approvalsBff = (overrides: ShellBffScript = {}) =>
  makeShellBff({
    ...signedInShellReads(adaSelectingCompany),
    decideAccessApproval: () => Effect.succeed(proposal()),
    executeAccessApproval: () => Effect.succeed(proposal({ status: 'executed' })),
    listAccessApprovals: () => Effect.succeed(list()),
    ...overrides,
  });

beforeEach(() => {
  setCopy(en);
  missingKeys.length = 0;
});
afterEach(() => {
  cleanup();
  expect(missingKeys, 'Missing P13 keys').toEqual([]);
});

for (const copy of [cs, en]) {
  it.effect(`renders P13 approval copy and disables execution in ${copy.shell.accessAdmin.approvals.title}`, () =>
    Effect.gen(function* rendersLocalizedApproval() {
      setCopy(copy);
      const handlers = callbacks();
      renderCopy(<ApprovalsInbox model={approvalsViewModel(list())} {...handlers} />);
      expect(screen.getByRole('region', { name: copy.shell.accessAdmin.approvals.title })).toBeDefined();
      expect(screen.getByText('Invoice 42')).toBeDefined();
      expect(screen.getByText('100 CZK')).toBeDefined();
      expect(screen.getByText('0123456789ab')).toBeDefined();
      expect(screen.queryByText('a'.repeat(64))).toBeNull();
      const execute = screen.getByRole('button', { name: copy.shell.accessAdmin.approvals.actions.execute });
      expect(execute.hasAttribute('disabled')).toBe(true);
      expect(execute.getAttribute('aria-describedby')).toBeTruthy();
      expect(screen.getByText(copy.shell.accessAdmin.approvals.executeDisabled, { exact: false })).toBeDefined();
      yield* Effect.promise(() => userEvent.click(execute));
      expect(handlers.onDecision).not.toHaveBeenCalled();
      yield* Effect.promise(() =>
        userEvent.click(screen.getByRole('button', { name: copy.shell.accessAdmin.approvals.actions.approve })),
      );
      expect(handlers.onDecision).toHaveBeenCalledExactlyOnceWith(proposal().proposalId, 'approve');
    }),
  );
}

for (const status of ['approved', 'rejected', 'expired', 'lapsed', 'executed'] as const) {
  test(`renders ${status} without offering approval or rejection`, () => {
    renderCopy(<ApprovalsInbox model={approvalsViewModel(list(proposal({ status })))} {...callbacks()} />);
    expect(screen.getByText(en.shell.accessAdmin.approvals.status[status])).toBeDefined();
    expect(screen.queryByRole('button', { name: en.shell.accessAdmin.approvals.actions.approve })).toBeNull();
    expect(screen.queryByRole('button', { name: en.shell.accessAdmin.approvals.actions.reject })).toBeNull();
    expect(
      screen.getByRole('button', { name: en.shell.accessAdmin.approvals.actions.execute }).hasAttribute('disabled'),
    ).toBe(true);
  });
}

test('agent proposals cannot be approved even if server eligibility says true', () => {
  const item = proposal();
  renderCopy(
    <ApprovalsInbox
      model={approvalsViewModel(list(proposal({ requester: { ...item.requester, kind: 'agent' } })))}
      {...callbacks()}
    />,
  );
  expect(screen.queryByRole('button', { name: en.shell.accessAdmin.approvals.actions.approve })).toBeNull();
});

it.effect('requester withdraw is distinct from approval and rejection; pending disables every mutation', () =>
  Effect.gen(function* requesterWithdrawal() {
    const item = proposal({
      permitted: { approval: { allowed: false }, rejection: { allowed: false }, withdrawal: { allowed: true } },
    });
    const handlers = callbacks();
    const { rerender } = renderCopy(<ApprovalsInbox model={approvalsViewModel(list(item))} {...handlers} />);
    expect(screen.queryByRole('button', { name: en.shell.accessAdmin.approvals.actions.approve })).toBeNull();
    expect(screen.queryByRole('button', { name: en.shell.accessAdmin.approvals.actions.reject })).toBeNull();
    yield* Effect.promise(() =>
      userEvent.click(screen.getByRole('button', { name: en.shell.accessAdmin.approvals.actions.withdraw })),
    );
    expect(handlers.onDecision).toHaveBeenCalledExactlyOnceWith(item.proposalId, 'withdraw');
    rerender(<ApprovalsInbox model={approvalsViewModel(list(item))} {...handlers} pending />);
    expect(
      screen.getByRole('button', { name: en.shell.accessAdmin.approvals.actions.withdraw }).hasAttribute('disabled'),
    ).toBe(true);
  }),
);

test('redacted target never becomes a guessed link or an exposed record identifier', () => {
  const item = proposal();
  renderCopy(
    <ApprovalsInbox
      model={approvalsViewModel(
        list(
          proposal({
            command: { ...item.command, fields: [], target: { recordKey: AccessRecordKeySchema.make('private-id') } },
          }),
        ),
      )}
      {...callbacks()}
    />,
  );
  expect(screen.queryByText('private-id')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText(en.shell.accessAdmin.common.notAvailable)).toBeDefined();
});

for (const state of ['loading', 'unauthenticated', 'forbidden', 'conflict', 'invalid', 'unavailable'] as const) {
  test(`renders explicit ${state} state without stale proposal data`, () => {
    renderCopy(<ApprovalsInbox model={{ state }} {...callbacks()} />);
    expect(screen.queryByText('Invoice 42')).toBeNull();
    expect(screen.queryByRole('button', { name: en.shell.accessAdmin.approvals.actions.approve })).toBeNull();
    const refresh = screen.queryByRole('button', { name: en.shell.accessAdmin.common.refresh });
    expect(refresh !== null).toBe(state === 'unavailable' || state === 'conflict' || state === 'invalid');
  });
}

it.effect('empty and paginated lists are distinct and next page emits only a semantic callback', () =>
  Effect.gen(function* paginatedList() {
    const handlers = callbacks();
    renderCopy(<ApprovalsInbox model={approvalsViewModel({ items: [], nextCursor: 'next-cursor' })} {...handlers} />);
    expect(screen.getByText(en.shell.accessAdmin.approvals.empty)).toBeDefined();
    yield* Effect.promise(() =>
      userEvent.click(screen.getByRole('button', { name: en.shell.accessAdmin.approvals.nextPage })),
    );
    expect(handlers.onNextPage).toHaveBeenCalledTimes(1);
  }),
);

it.effect('tenant-only loader reads the inbox without a selected company', () => {
  const bff = approvalsBff();
  return Effect.gen(function* tenantOnlyLoader() {
    const read = rstest.fn(() => Effect.succeed(list()));
    const client = mockClient({ list: read });
    const model = yield* loadApprovalsPage(request(), client);
    expect(model.shell).toMatchObject({ contextState: 'selection_required', state: 'authenticated' });
    expect(model.content.state).toBe('ready');
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model)).not.toContain('commandDigest');
  }).pipe(Effect.provide(bff.layer));
});

it.effect('anonymous loader never reads approval data and unavailable reads never fabricate a ready list', () => {
  const bff = approvalsBff({
    currentSession: () => Effect.succeed(Schema.decodeUnknownSync(CurrentSessionSchema)({ state: 'anonymous' })),
  });
  return Effect.gen(function* failsClosed() {
    const read = rstest.fn(() => Effect.succeed(list()));
    const model = yield* loadApprovalsPage(request(), mockClient({ list: read }));
    expect(model.content.state).toBe('unauthenticated');
    expect(read).not.toHaveBeenCalled();
    expect(
      yield* refreshApprovals(
        request(),
        mockClient({ list: () => Effect.fail(new ApprovalClientFailure({ reason: 'unavailable' })) }),
      ),
    ).toEqual({ state: 'unavailable' });
  }).pipe(Effect.provide(bff.layer));
});

it.effect('approval sends only revision-bound decision, then re-reads; never sends preview or executes', () =>
  Effect.gen(function* approvalOnly() {
    const item = proposal();
    const decide = rstest.fn<ApprovalsClient['decide']>(() => Effect.void);
    const execute = rstest.fn<ApprovalsClient['execute']>(() => Effect.void);
    const read = rstest.fn(() => Effect.succeed(list(proposal({ revision: 'revision-2', status: 'approved' }))));
    const model = yield* decideApproval(
      approvalsViewModel(list(item)),
      item.proposalId,
      'approve',
      request(),
      mockClient({ decide, execute, list: read }),
      commandKey,
    );
    expect(decide.mock.calls[0]?.[0]).toEqual({
      decision: 'approve',
      expectedStatus: 'pending',
      proposalId: item.proposalId,
      revision: 'revision-1',
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(model.state === 'ready' && model.items[0]?.status).toBe('approved');
  }),
);

for (const reason of ['unauthenticated', 'forbidden', 'conflict', 'unavailable'] as const) {
  it.effect(`${reason} does not retry a decision or keep actionable stale rows`, () =>
    Effect.gen(function* failureRecovery() {
      const item = proposal();
      const decide = rstest.fn(() => Effect.fail(new ApprovalClientFailure({ reason })));
      const read = rstest.fn(() => Effect.succeed(list()));
      const model = yield* decideApproval(
        approvalsViewModel(list(item)),
        item.proposalId,
        'approve',
        request(),
        mockClient({ decide, list: read }),
        commandKey,
      );
      expect(model).toEqual({ state: reason });
      expect(decide).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
    }),
  );
}

it.effect('forbidden local affordance and terminal states cannot dispatch commands', () =>
  Effect.gen(function* terminalRefusal() {
    const item = proposal({ status: 'lapsed' });
    const decide = rstest.fn(() => Effect.void);
    const client = mockClient({ decide });
    expect(
      yield* decideApproval(approvalsViewModel(list(item)), item.proposalId, 'approve', request(), client, commandKey),
    ).toEqual({ state: 'forbidden' });
    expect(decide).not.toHaveBeenCalled();
  }),
);

it.effect('native client uses the owning BFF and bounded pagination; decisions use idempotency', () => {
  const bff = approvalsBff();
  return Effect.gen(function* nativeAdapter() {
    const req = new Request('https://shell.example.test/cs/access/approvals', {
      headers: { cookie: 'test-session=opaque' },
    });
    yield* approvalsClient.list(req, 'cursor-2');
    const command = {
      decision: 'approve' as const,
      expectedStatus: 'pending' as const,
      proposalId: proposal().proposalId,
      revision: 'revision-1',
    };
    yield* approvalsClient.decide(command, req, commandKey);
    expect(bff.requests).toMatchObject([
      {
        body: { cursor: 'cursor-2', limit: 25 },
        endpoint: 'listAccessApprovals',
        url: 'https://shell.example.test/shell-super-app-api/shell/access/approvals/list',
      },
      {
        body: command,
        endpoint: 'decideAccessApproval',
        url: 'https://shell.example.test/shell-super-app-api/shell/access/approvals/decide',
      },
    ]);
    // Neither request carries a language, and only the decision carries an idempotency key.
    expect(bff.requests.map(({ acceptLanguage, idempotencyKey }) => ({ acceptLanguage, idempotencyKey }))).toEqual([
      {},
      { idempotencyKey: commandKey },
    ]);
  }).pipe(Effect.provide(bff.layer));
});

const nativeFailures: readonly {
  readonly error: AccessAdminProblem;
  readonly state: ApprovalClientFailure['reason'];
}[] = [
  {
    error: {
      _tag: 'AccessAdminAuthenticationRequired',
      detail: 'redacted',
      status: 401,
      title: 'redacted',
      type: 'about:blank',
    },
    state: 'unauthenticated',
  },
  {
    error: { _tag: 'AccessAdminForbidden', detail: 'redacted', status: 403, title: 'redacted', type: 'about:blank' },
    state: 'forbidden',
  },
  {
    error: { _tag: 'AccessAdminConflict', detail: 'redacted', status: 409, title: 'redacted', type: 'about:blank' },
    state: 'conflict',
  },
  {
    error: {
      _tag: 'AccessAdminUnprocessable',
      detail: 'redacted',
      status: 422,
      title: 'redacted',
      type: 'about:blank',
    },
    state: 'invalid',
  },
  {
    error: {
      _tag: 'AccessAdminUnavailable',
      detail: 'redacted',
      retryable: true,
      status: 503,
      title: 'redacted',
      type: 'about:blank',
    },
    state: 'unavailable',
  },
];
for (const { error, state } of nativeFailures) {
  it.effect(`native ${error.status} maps to ${state} without rendering server diagnostics`, () => {
    const bff = approvalsBff({ listAccessApprovals: () => Effect.fail(error) });
    return Effect.gen(function* nativeFailure() {
      expect(yield* refreshApprovals(request(), approvalsClient)).toEqual({ state });
    }).pipe(Effect.provide(bff.layer));
  });
}

test('unknown execution refusal is sanitized instead of exposing raw backend diagnostics', () => {
  const item = proposal({ execution: { available: false, reason: 'private backend diagnosis' }, status: 'approved' });
  renderCopy(<ApprovalsInbox model={approvalsViewModel(list(item))} {...callbacks()} />);
  expect(screen.queryByText('private backend diagnosis', { exact: false })).toBeNull();
  expect(screen.getByText(en.shell.accessAdmin.common.unavailable, { exact: false })).toBeDefined();
});

test('execution availability never enables pending or agent-created proposals', () => {
  const item = proposal();
  const pending = approvalsViewModel(list(proposal({ execution: { available: true, reason: 'premature' } })));
  expect(pending.state === 'ready' && pending.items[0]?.canExecute).toBe(false);
  const agent = approvalsViewModel(
    list(
      proposal({
        execution: { available: true, reason: 'agent' },
        requester: { ...item.requester, kind: 'agent' },
        status: 'approved',
      }),
    ),
  );
  expect(agent.state === 'ready' && agent.items[0]?.canExecute).toBe(false);
});

const executableProposal = () =>
  proposal({ execution: { available: true, reason: 'mandate_ready' }, status: 'approved' });

it.effect('backend-unavailable execution has no dispatch, even for an approved proposal', () =>
  Effect.gen(function* disabledExecution() {
    const execute = rstest.fn(() => Effect.void);
    const item = proposal({ status: 'approved' });
    expect(
      yield* executeApproval(
        approvalsViewModel(list(item)),
        item.proposalId,
        request(),
        mockClient({ execute }),
        commandKey,
      ),
    ).toEqual({ state: 'forbidden' });
    expect(execute).not.toHaveBeenCalled();
  }),
);

it.effect('available execution is revision-bound and refreshes only after successful owner receipt', () =>
  Effect.gen(function* releasedExecution() {
    const item = executableProposal();
    const execute = rstest.fn<ApprovalsClient['execute']>(() => Effect.void);
    const client = mockClient({ execute, list: () => Effect.succeed(list(proposal({ status: 'executed' }))) });
    const model = yield* executeApproval(
      approvalsViewModel(list(item)),
      item.proposalId,
      request(),
      client,
      commandKey,
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { expectedStatus: 'approved', proposalId: item.proposalId, revision: item.revision },
      expect.any(Request),
      commandKey,
    );
    expect(model.state === 'ready' && model.items[0]?.status).toBe('executed');
  }),
);

for (const reason of ['conflict', 'unavailable'] as const) {
  it.effect(`execution ${reason} removes stale controls and never automatically retries`, () =>
    Effect.gen(function* executionFailure() {
      const item = executableProposal();
      const execute = rstest.fn(() => Effect.fail(new ApprovalClientFailure({ reason })));
      expect(
        yield* executeApproval(
          approvalsViewModel(list(item)),
          item.proposalId,
          request(),
          mockClient({ execute }),
          commandKey,
        ),
      ).toEqual({ state: reason });
      expect(execute).toHaveBeenCalledTimes(1);
    }),
  );
}

it.live('feature fences two same-tick execute clicks before React pending renders', () =>
  Effect.gen(function* doubleClickExecution() {
    const started = yield* Deferred.make<boolean>();
    const finished = yield* Deferred.make<boolean>();
    const bff = approvalsBff({
      executeAccessApproval: () =>
        Deferred.succeed(started, true).pipe(
          Effect.andThen(Deferred.await(finished)),
          Effect.as(proposal({ status: 'executed' })),
        ),
      listAccessApprovals: () => Effect.succeed(list(proposal({ status: 'executed' }))),
    });
    yield* Effect.gen(function* mountedDoubleClick() {
      renderCopy(
        <ApprovalsFeature
          client={approvalsClient}
          createKey={Effect.succeed(commandKey)}
          initial={approvalsViewModel(list(executableProposal()))}
        />,
      );
      const button = screen.getByRole('button', { name: en.shell.accessAdmin.approvals.actions.execute });
      expect(button.hasAttribute('disabled')).toBe(false);
      act(() => {
        fireEvent.click(button);
        fireEvent.click(button);
      });
      yield* Deferred.await(started);
      yield* networkQuietExcept(1);
      yield* Deferred.succeed(finished, true);
      yield* Effect.promise(() => screen.findByText(en.shell.accessAdmin.approvals.status.executed));
      yield* networkIdle;
      expect(bff.requests.filter(({ endpoint }) => endpoint === 'executeAccessApproval')).toHaveLength(1);
    }).pipe(Effect.provide(bff.browser));
  }),
);

it.live('503 refresh and explicit retry retain the same execution idempotency key', () =>
  Effect.gen(function* executionRetryIdentity() {
    const refreshed = yield* Deferred.make<boolean>();
    const retried = yield* Deferred.make<boolean>();
    let executions = 0;
    let reads = 0;
    const bff = approvalsBff({
      executeAccessApproval: () => {
        executions += 1;
        return executions === 1
          ? Effect.fail({
              _tag: 'AccessAdminUnavailable',
              detail: 'redacted',
              retryable: true,
              status: 503,
              title: 'redacted',
              type: 'about:blank',
            } satisfies AccessAdminProblem)
          : Effect.succeed(proposal({ status: 'executed' }));
      },
      listAccessApprovals: () => {
        reads += 1;
        return Deferred.succeed(reads === 1 ? refreshed : retried, true).pipe(Effect.as(list(executableProposal())));
      },
    });
    const makeKey = rstest.fn(() => commandKey);
    yield* Effect.gen(function* mountedExecutionRetry() {
      renderCopy(
        <ApprovalsFeature
          client={approvalsClient}
          createKey={Effect.sync(makeKey)}
          initial={approvalsViewModel(list(executableProposal()))}
        />,
      );
      yield* Effect.promise(() =>
        userEvent.click(screen.getByRole('button', { name: en.shell.accessAdmin.approvals.actions.execute })),
      );
      yield* Effect.promise(() => screen.findByText(en.shell.accessAdmin.common.unavailable));
      yield* networkIdle;
      yield* Effect.promise(() =>
        userEvent.click(screen.getByRole('button', { name: en.shell.accessAdmin.common.refresh })),
      );
      yield* Deferred.await(refreshed);
      yield* networkIdle;
      yield* Effect.promise(() =>
        screen.findByRole('button', { name: en.shell.accessAdmin.approvals.actions.execute }),
      );
      yield* Effect.promise(() =>
        userEvent.click(screen.getByRole('button', { name: en.shell.accessAdmin.approvals.actions.execute })),
      );
      yield* Deferred.await(retried);
      yield* networkIdle;
      expect(makeKey).toHaveBeenCalledTimes(1);
      const executeRequests = bff.requests.filter(({ endpoint }) => endpoint === 'executeAccessApproval');
      expect(executeRequests).toHaveLength(2);
      expect(executeRequests.map(({ idempotencyKey }) => idempotencyKey)).toEqual([commandKey, commandKey]);
    }).pipe(Effect.provide(bff.browser));
  }),
);

it.effect('native execute uses only the stored proposal reference, revision and stable idempotency header', () => {
  const bff = approvalsBff();
  return Effect.gen(function* nativeExecution() {
    const item = executableProposal();
    const command = { expectedStatus: 'approved' as const, proposalId: item.proposalId, revision: item.revision };
    yield* approvalsClient.execute(command, request(), commandKey);
    expect(bff.requests.map(({ body, endpoint, idempotencyKey }) => ({ body, endpoint, idempotencyKey }))).toEqual([
      { body: command, endpoint: 'executeAccessApproval', idempotencyKey: commandKey },
    ]);
  }).pipe(Effect.provide(bff.layer));
});

test('route is protected, tenant-context administration and never public/indexable', () => {
  expect(routeMeta.entrypoint.authorization.kind).toBe('protected');
  expect(routeMeta.entrypoint.moduleKey).toBe('shell-super-app');
  expect(routeMeta.entrypoint.entrypointKey).toBe('shell-super-app.page.access-approvals');
  expect(routeMeta.accessDeclaration.key).toBe('shell-super-app.access-approvals.read');
  expect(routeMeta.accessDeclaration.kind).toBe('admin');
  expect(routeMeta.public).toBe(false);
  expect(routeMeta.indexable).toBe(false);
});
