import { AgentEntitySchema } from '@app/shared-contracts/agent-access';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';

import { AgentApiKeys } from '../../src/routes/people/agent-api-keys.tsx';

const { commands } = rstest.hoisted(() => ({
  commands: { issue: rstest.fn(), list: rstest.fn(), rotate: rstest.fn(), status: rstest.fn() },
}));
rstest.mock('../../src/api/auth-client.ts', () => ({
  issueManagedApiKey: commands.issue,
  listManagedApiKeys: commands.list,
  rotateManagedApiKey: commands.rotate,
  setManagedApiKeyStatus: commands.status,
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const prefix = 'shell.agents.keys';
const principalId = '00000000-0000-4000-8000-000000000003';
const authBindingId = '00000000-0000-4000-8000-000000000004';
const otherPrincipalId = '00000000-0000-4000-8000-000000000005';
const testSecret = 'one-time-test-credential';
const key = {
  authBindingId,
  bindingStatus: 'active',
  cleanupPending: false,
  createdAt: DateTime.makeUnsafe('2026-10-24T10:00:00.000Z'),
  enabled: true,
  expiresAt: null,
  name: 'Automation',
  start: 'native-key',
} as const;
const row = { displayName: 'Agent', key, kind: 'agent', principalId, principalStatus: 'active' } as const;
const agent = Schema.decodeUnknownSync(AgentEntitySchema)({
  connections: [],
  description: null,
  displayName: 'Agent',
  hasProfile: true,
  modules: [],
  operators: [],
  owner: null,
  principalId,
  status: 'active',
  writePolicy: 'approval',
});

afterEach(() => {
  cleanup();
  rstest.restoreAllMocks();
});
beforeEach(() => {
  rstest.clearAllMocks();
  commands.list.mockReturnValue(Effect.succeed({ items: [row], nextOffset: null }));
  commands.issue.mockReturnValue(Effect.succeed({ ...key, secret: Redacted.make(testSecret) }));
  commands.rotate.mockReturnValue(Effect.succeed({ ...key, cleanupPending: true, secret: Redacted.make(testSecret) }));
  commands.status.mockReturnValue(Effect.succeed(key));
});

it.live('loads lazily with exact company-agent principal scope, never tenant-wide or prefix-derived ownership', () =>
  Effect.gen(function* loadScopedKeys() {
    const user = userEvent.setup();
    render(<AgentApiKeys agent={agent} />);
    expect(commands.list).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: `${prefix}.issue` }).hasAttribute('disabled')).toBe(true);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.show` })));
    expect(yield* Effect.promise(() => screen.findByText('Automation'))).toBeTruthy();
    expect(commands.list).toHaveBeenCalledExactlyOnceWith({
      limit: 100,
      offset: 0,
      principalId,
      scope: 'company-agent',
    });
    expect(screen.getByText(`${prefix}.status.active`)).toBeTruthy();
  }),
);

it.live('issues only after explicit confirmation, displays the secret once and never persists it', () =>
  Effect.gen(function* issueOneTimeSecret() {
    const user = userEvent.setup();
    const storage = rstest.spyOn(Storage.prototype, 'setItem');
    render(<AgentApiKeys agent={agent} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.show` })));
    yield* Effect.promise(() => screen.findByText('Automation'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.issue` })));
    expect(commands.issue).not.toHaveBeenCalled();
    yield* Effect.promise(() => user.type(screen.getByLabelText(/keys.name/u), 'Worker'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.confirm` })));
    const secretField = yield* Effect.promise(() => screen.findByDisplayValue(testSecret));
    expect(secretField.hasAttribute('readonly')).toBe(true);
    expect(commands.issue).toHaveBeenCalledTimes(1);
    expect(commands.issue.mock.calls[0]?.[0]).toEqual({ name: 'Worker', principalId, scope: 'company-agent' });
    expect(commands.issue.mock.calls[0]?.[1]).toEqual({ idempotencyKey: expect.any(String) });
    expect(storage).not.toHaveBeenCalled();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.hideSecret` })));
    expect(screen.queryByDisplayValue(testSecret)).toBeNull();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.refresh` })));
    yield* Effect.promise(() => waitFor(() => expect(commands.list).toHaveBeenCalledTimes(3)));
    expect(screen.queryByDisplayValue(testSecret)).toBeNull();
    cleanup();
    render(<AgentApiKeys agent={agent} />);
    expect(screen.queryByDisplayValue(testSecret)).toBeNull();
    expect(commands.issue).toHaveBeenCalledTimes(1);
  }),
);

it.live('rotates the exact binding with a reason and reports pending cleanup without claiming revocation', () =>
  Effect.gen(function* rotateExactBinding() {
    const user = userEvent.setup();
    render(<AgentApiKeys agent={agent} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.show` })));
    yield* Effect.flatMap(
      Effect.promise(() => screen.findByRole('button', { name: `${prefix}.rotate` })),
      (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
    );
    expect(screen.getByRole('button', { name: `${prefix}.confirm` }).hasAttribute('disabled')).toBe(true);
    yield* Effect.promise(() => user.type(screen.getByLabelText(/keys.reason/u), 'Scheduled rotation'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.confirm` })));
    expect(yield* Effect.promise(() => screen.findByDisplayValue(testSecret))).toBeTruthy();
    expect(screen.getByText(`${prefix}.cleanupPending`)).toBeTruthy();
    expect(commands.rotate.mock.calls[0]?.[0]).toEqual({
      name: 'Automation',
      oldAuthBindingId: authBindingId,
      principalId,
      reason: 'Scheduled rotation',
      scope: 'company-agent',
    });
    expect(commands.rotate).toHaveBeenCalledTimes(1);
  }),
);

it.live('uses the actual binding status to revoke a disabled key, not its provider enabled flag', () =>
  Effect.gen(function* revokeDisabledBinding() {
    const user = userEvent.setup();
    commands.list.mockReturnValue(
      Effect.succeed({ items: [{ ...row, key: { ...key, bindingStatus: 'disabled' } }], nextOffset: null }),
    );
    render(<AgentApiKeys agent={agent} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.show` })));
    expect(yield* Effect.promise(() => screen.findByRole('button', { name: `${prefix}.enable` }))).toBeTruthy();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.revoke` })));
    yield* Effect.promise(() => user.type(screen.getByLabelText(/keys.reason/u), 'Credential retired'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.confirm` })));
    yield* Effect.promise(() => waitFor(() => expect(commands.status).toHaveBeenCalledTimes(1)));
    expect(commands.status.mock.calls[0]?.[0]).toEqual({
      authBindingId,
      expectedStatus: 'disabled',
      newStatus: 'revoked',
      principalId,
      reason: 'Credential retired',
      scope: 'company-agent',
    });
  }),
);

it.live('does not retry an ambiguous issuance and requires a fresh list before any further command', () =>
  Effect.gen(function* requireRereadAfterAmbiguousIssuance() {
    const user = userEvent.setup();
    commands.issue.mockReturnValue(Effect.fail({ _tag: 'TestTransportFailure', reason: 'Not safe to display' }));
    render(<AgentApiKeys agent={agent} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.show` })));
    yield* Effect.promise(() => screen.findByText('Automation'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.issue` })));
    yield* Effect.promise(() => user.type(screen.getByLabelText(/keys.name/u), 'Worker'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.confirm` })));
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(screen.getByRole('button', { name: `${prefix}.confirm` }).hasAttribute('disabled')).toBe(true),
      ),
    );
    expect(commands.issue).toHaveBeenCalledTimes(1);
    expect(commands.list).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Not safe to display')).toBeNull();
    expect(screen.queryByDisplayValue(testSecret)).toBeNull();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.cancel` })));
    expect(screen.getByRole('button', { name: `${prefix}.issue` }).hasAttribute('disabled')).toBe(true);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.refresh` })));
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(screen.getByRole('button', { name: `${prefix}.issue` }).hasAttribute('disabled')).toBe(false),
      ),
    );
    expect(commands.issue).toHaveBeenCalledTimes(1);
  }),
);

it.live('rejects an out-of-scope server response without revealing or filtering unrelated key metadata', () =>
  Effect.gen(function* rejectOutOfScopeMetadata() {
    const user = userEvent.setup();
    commands.list.mockReturnValue(
      Effect.succeed({
        items: [{ ...row, key: { ...key, name: 'Other secret metadata' }, principalId: otherPrincipalId }],
        nextOffset: null,
      }),
    );
    render(<AgentApiKeys agent={agent} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.show` })));
    expect(yield* Effect.promise(() => screen.findByText(`${prefix}.failed`))).toBeTruthy();
    expect(screen.queryByText('Other secret metadata')).toBeNull();
    expect(screen.getByRole('button', { name: `${prefix}.issue` }).hasAttribute('disabled')).toBe(true);
  }),
);

it('does not load or offer key issuance for an unaudited or inactive agent', () => {
  const view = render(<AgentApiKeys agent={{ ...agent, hasProfile: false }} />);
  expect(screen.getByText(`${prefix}.requiresProfile`)).toBeTruthy();
  expect(screen.queryByRole('button', { name: `${prefix}.show` })).toBeNull();
  view.rerender(<AgentApiKeys agent={{ ...agent, status: 'disabled' }} />);
  expect(screen.queryByRole('button', { name: `${prefix}.issue` })).toBeNull();
  expect(commands.list).not.toHaveBeenCalled();
});

it.live('interrupts an owned in-flight read when the agent detail closes', () =>
  Effect.gen(function* interruptOwnedRead() {
    const user = userEvent.setup();
    let interrupted = false;
    commands.list.mockReturnValue(
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );
    const view = render(<AgentApiKeys agent={agent} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.show` })));
    expect(commands.list).toHaveBeenCalledTimes(1);
    view.unmount();
    yield* Effect.promise(() => waitFor(() => expect(interrupted).toBe(true)));
  }),
);

it.live('disables and re-enables only the exact binding with its current expected status', () =>
  Effect.gen(function* changeExactBindingStatus() {
    const user = userEvent.setup();
    render(<AgentApiKeys agent={agent} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.show` })));
    yield* Effect.flatMap(
      Effect.promise(() => screen.findByRole('button', { name: `${prefix}.disable` })),
      (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
    );
    yield* Effect.promise(() => user.type(screen.getByLabelText(/keys.reason/u), 'Pause automation'));
    commands.list.mockReturnValue(
      Effect.succeed({ items: [{ ...row, key: { ...key, bindingStatus: 'disabled' } }], nextOffset: null }),
    );
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.confirm` })));
    yield* Effect.flatMap(
      Effect.promise(() => screen.findByRole('button', { name: `${prefix}.enable` })),
      (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
    );
    yield* Effect.promise(() => user.type(screen.getByLabelText(/keys.reason/u), 'Resume automation'));
    commands.list.mockReturnValue(Effect.succeed({ items: [row], nextOffset: null }));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.confirm` })));
    yield* Effect.promise(() => waitFor(() => expect(commands.status).toHaveBeenCalledTimes(2)));
    expect(commands.status.mock.calls.map((call) => call[0])).toEqual([
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
    expect(commands.status.mock.calls[0]?.[1].idempotencyKey).not.toBe(
      commands.status.mock.calls[1]?.[1].idempotencyKey,
    );
  }),
);

it.live('keeps principal scope on later pages instead of truncating the key list', () =>
  Effect.gen(function* loadScopedLaterPage() {
    const user = userEvent.setup();
    commands.list.mockReturnValueOnce(Effect.succeed({ items: [row], nextOffset: 100 }));
    commands.list.mockReturnValue(
      Effect.succeed({
        items: [{ ...row, key: { ...key, authBindingId: '00000000-0000-4000-8000-000000000006', name: 'Second key' } }],
        nextOffset: null,
      }),
    );
    render(<AgentApiKeys agent={agent} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.show` })));
    yield* Effect.flatMap(
      Effect.promise(() => screen.findByRole('button', { name: `${prefix}.more` })),
      (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
    );
    expect(yield* Effect.promise(() => screen.findByText('Second key'))).toBeTruthy();
    expect(screen.getByText('Automation')).toBeTruthy();
    expect(commands.list.mock.calls[1]?.[0]).toEqual({ limit: 100, offset: 100, principalId, scope: 'company-agent' });
  }),
);

it.live('keeps a committed key change pending until the reread confirms the actual binding projection', () =>
  Effect.gen(function* awaitActualBindingProjection() {
    const user = userEvent.setup();
    render(<AgentApiKeys agent={agent} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.show` })));
    yield* Effect.flatMap(
      Effect.promise(() => screen.findByRole('button', { name: `${prefix}.disable` })),
      (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
    );
    yield* Effect.promise(() => user.type(screen.getByLabelText(/keys.reason/u), 'Pause automation'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.confirm` })));
    expect(yield* Effect.promise(() => screen.findByText(`${prefix}.projectionPending`))).toBeTruthy();
    expect(screen.queryByText(`${prefix}.updated`)).toBeNull();
    expect(screen.getByRole('button', { name: `${prefix}.disable` }).hasAttribute('disabled')).toBe(true);
    commands.list.mockReturnValue(
      Effect.succeed({ items: [{ ...row, key: { ...key, bindingStatus: 'disabled' } }], nextOffset: null }),
    );
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: `${prefix}.refresh` })));
    expect(yield* Effect.promise(() => screen.findByText(`${prefix}.updated`))).toBeTruthy();
    expect(commands.status).toHaveBeenCalledTimes(1);
  }),
);
