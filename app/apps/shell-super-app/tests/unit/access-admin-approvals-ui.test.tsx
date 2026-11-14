import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest, test } from 'effect-rstest';
import { createInstance } from 'i18next';

import cs from '../../locales/cs/shell.json';
import en from '../../locales/en/shell.json';
import { AccessApprovalSchema, AccessRecordKeySchema } from '../../shared/access-admin-api.ts';
import type { AccessAdminProblem, AccessApproval } from '../../shared/access-admin-api.ts';
import type { decideAccessApproval, executeAccessApproval, listAccessApprovals } from '../../src/api/auth-client.ts';
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
import { authenticatedShellFixture } from './routes/authenticated-shell-fixture.ts';

const { loadShell, nativeDecide, nativeExecute, nativeList, translate } = rstest.hoisted(() => ({
  loadShell: rstest.fn(),
  nativeDecide: rstest.fn<typeof decideAccessApproval>(),
  nativeExecute: rstest.fn<typeof executeAccessApproval>(),
  nativeList: rstest.fn<typeof listAccessApprovals>(),
  translate: rstest.fn(),
}));
rstest.mock('../../src/api/auth-client.ts', () => ({
  decideAccessApproval: nativeDecide,
  executeAccessApproval: nativeExecute,
  listAccessApprovals: nativeList,
}));
rstest.mock('../../src/routes/[lang]/home-page-model.ts', () => ({ loadHomePageModel: loadShell }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({ useModernI18n: () => ({ t: translate }) }));

const translations = createInstance();
const setCopy = (copy: typeof en | typeof cs) => {
  const language = copy === cs ? 'cs' : 'en';
  return translations.init({ initAsync: false, lng: language, resources: { [language]: { translation: copy } } });
};

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

beforeEach(() => {
  translate.mockImplementation((key: string, options?: { readonly count?: number }) => {
    expect(translations.exists(key, options ?? {}), `Missing P13 key: ${key}`).toBe(true);
    return translations.t(key, options ?? {});
  });
  nativeList.mockReturnValue(Effect.succeed(list()));
  nativeDecide.mockReturnValue(Effect.succeed(proposal()));
  nativeExecute.mockReturnValue(Effect.succeed(proposal({ status: 'executed' })));
  const { selectedLegalEntityId: _selectedLegalEntityId, ...tenantShell } = authenticatedShellFixture();
  loadShell.mockReturnValue(Effect.succeed({ ...tenantShell, contextState: 'selection_required' }));
  void setCopy(en);
});
afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

for (const copy of [cs, en]) {
  it.effect(`renders P13 approval copy and disables execution in ${copy.shell.accessAdmin.approvals.title}`, () =>
    Effect.gen(function* rendersLocalizedApproval() {
      yield* Effect.promise(() => setCopy(copy));
      const handlers = callbacks();
      render(<ApprovalsInbox model={approvalsViewModel(list())} {...handlers} />);
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
    render(<ApprovalsInbox model={approvalsViewModel(list(proposal({ status })))} {...callbacks()} />);
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
  render(
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
    const { rerender } = render(<ApprovalsInbox model={approvalsViewModel(list(item))} {...handlers} />);
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
  render(
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
    render(<ApprovalsInbox model={{ state }} {...callbacks()} />);
    expect(screen.queryByText('Invoice 42')).toBeNull();
    expect(screen.queryByRole('button', { name: en.shell.accessAdmin.approvals.actions.approve })).toBeNull();
    const refresh = screen.queryByRole('button', { name: en.shell.accessAdmin.common.refresh });
    expect(refresh !== null).toBe(state === 'unavailable' || state === 'conflict' || state === 'invalid');
  });
}

it.effect('empty and paginated lists are distinct and next page emits only a semantic callback', () =>
  Effect.gen(function* paginatedList() {
    const handlers = callbacks();
    render(<ApprovalsInbox model={approvalsViewModel({ items: [], nextCursor: 'next-cursor' })} {...handlers} />);
    expect(screen.getByText(en.shell.accessAdmin.approvals.empty)).toBeDefined();
    yield* Effect.promise(() =>
      userEvent.click(screen.getByRole('button', { name: en.shell.accessAdmin.approvals.nextPage })),
    );
    expect(handlers.onNextPage).toHaveBeenCalledTimes(1);
  }),
);

it.effect('tenant-only loader reads the inbox without a selected company', () =>
  Effect.gen(function* tenantOnlyLoader() {
    const read = rstest.fn(() => Effect.succeed(list()));
    const client = mockClient({ list: read });
    const model = yield* loadApprovalsPage(request(), client);
    expect(model.content.state).toBe('ready');
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model)).not.toContain('commandDigest');
  }),
);

it.effect('anonymous loader never reads approval data and unavailable reads never fabricate a ready list', () =>
  Effect.gen(function* failsClosed() {
    loadShell.mockReturnValue(Effect.succeed({ state: 'anonymous' }));
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
  }),
);

it.effect('approval sends only revision-bound decision, then re-reads; never sends preview or executes', () =>
  Effect.gen(function* approvalOnly() {
    const item = proposal();
    const decide = rstest.fn<ApprovalsClient['decide']>(() => Effect.void);
    const read = rstest.fn(() => Effect.succeed(list(proposal({ revision: 'revision-2', status: 'approved' }))));
    const model = yield* decideApproval(
      approvalsViewModel(list(item)),
      item.proposalId,
      'approve',
      request(),
      mockClient({ decide, list: read }),
      commandKey,
    );
    expect(decide.mock.calls[0]?.[0]).toEqual({
      decision: 'approve',
      expectedStatus: 'pending',
      proposalId: item.proposalId,
      revision: 'revision-1',
    });
    expect(read).toHaveBeenCalledTimes(1);
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

it.effect('native client uses the owning BFF and bounded pagination; decisions use idempotency', () =>
  Effect.gen(function* nativeAdapter() {
    const req = new Request('https://shell.example.test/cs/access/approvals', {
      headers: { cookie: 'test-session=opaque' },
    });
    yield* approvalsClient.list(req, 'cursor-2');
    expect(nativeList).toHaveBeenCalledExactlyOnceWith(
      { cursor: 'cursor-2', limit: 25 },
      expect.objectContaining({ baseUrl: new URL('https://shell.example.test/shell-super-app-api') }),
    );
    const command = {
      decision: 'approve' as const,
      expectedStatus: 'pending' as const,
      proposalId: proposal().proposalId,
      revision: 'revision-1',
    };
    yield* approvalsClient.decide(command, req, commandKey);
    expect(nativeDecide).toHaveBeenCalledExactlyOnceWith(
      command,
      expect.objectContaining({
        baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
        idempotencyKey: commandKey,
      }),
    );
  }),
);

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
  it.effect(`native ${error.status} maps to ${state} without rendering server diagnostics`, () =>
    Effect.gen(function* nativeFailure() {
      nativeList.mockReturnValue(Effect.fail(error));
      expect(yield* refreshApprovals(request(), approvalsClient)).toEqual({ state });
    }),
  );
}

test('unknown execution refusal is sanitized instead of exposing raw backend diagnostics', () => {
  const item = proposal({ execution: { available: false, reason: 'private backend diagnosis' }, status: 'approved' });
  render(<ApprovalsInbox model={approvalsViewModel(list(item))} {...callbacks()} />);
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

it.effect('feature fences two same-tick execute clicks before React pending renders', () =>
  Effect.gen(function* doubleClickExecution() {
    const finished = yield* Deferred.make<boolean>();
    const execute = rstest.fn(() => Deferred.await(finished).pipe(Effect.asVoid));
    const client = mockClient({ execute, list: () => Effect.succeed(list(proposal({ status: 'executed' }))) });
    render(
      <ApprovalsFeature
        client={client}
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
    yield* Effect.yieldNow;
    yield* Deferred.succeed(finished, true);
    yield* Effect.promise(() => screen.findByText(en.shell.accessAdmin.approvals.status.executed));
    expect(execute).toHaveBeenCalledTimes(1);
  }),
);

it.effect('503 refresh and explicit retry retain the same execution idempotency key', () =>
  Effect.gen(function* executionRetryIdentity() {
    const execute = rstest
      .fn<ApprovalsClient['execute']>()
      .mockReturnValueOnce(Effect.fail(new ApprovalClientFailure({ reason: 'unavailable' })))
      .mockReturnValue(Effect.void);
    const makeKey = rstest.fn(() => commandKey);
    const client = mockClient({ execute, list: () => Effect.succeed(list(executableProposal())) });
    render(
      <ApprovalsFeature
        client={client}
        createKey={Effect.sync(makeKey)}
        initial={approvalsViewModel(list(executableProposal()))}
      />,
    );
    yield* Effect.promise(() =>
      userEvent.click(screen.getByRole('button', { name: en.shell.accessAdmin.approvals.actions.execute })),
    );
    yield* Effect.promise(() => screen.findByText(en.shell.accessAdmin.common.unavailable));
    yield* Effect.promise(() =>
      userEvent.click(screen.getByRole('button', { name: en.shell.accessAdmin.common.refresh })),
    );
    yield* Effect.promise(() => screen.findByRole('button', { name: en.shell.accessAdmin.approvals.actions.execute }));
    yield* Effect.promise(() =>
      userEvent.click(screen.getByRole('button', { name: en.shell.accessAdmin.approvals.actions.execute })),
    );
    expect(makeKey).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map((call) => call[2])).toEqual([commandKey, commandKey]);
  }),
);

it.effect('native execute uses only the stored proposal reference, revision and stable idempotency header', () =>
  Effect.gen(function* nativeExecution() {
    const item = executableProposal();
    const command = { expectedStatus: 'approved' as const, proposalId: item.proposalId, revision: item.revision };
    yield* approvalsClient.execute(command, request(), commandKey);
    expect(nativeExecute).toHaveBeenCalledExactlyOnceWith(
      command,
      expect.objectContaining({ idempotencyKey: commandKey }),
    );
  }),
);

test('route is protected, tenant-context administration and never public/indexable', () => {
  expect(routeMeta.entrypoint.authorization.kind).toBe('protected');
  expect(routeMeta.entrypoint.moduleKey).toBe('shell-super-app');
  expect(routeMeta.entrypoint.entrypointKey).toBe('shell-super-app.page.access-approvals');
  expect(routeMeta.accessDeclaration.key).toBe('shell-super-app.access-approvals.read');
  expect(routeMeta.accessDeclaration.kind).toBe('admin');
  expect(routeMeta.public).toBe(false);
  expect(routeMeta.indexable).toBe(false);
});
