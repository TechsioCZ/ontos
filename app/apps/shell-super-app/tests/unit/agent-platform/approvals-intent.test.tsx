import type { AgentQueueBatch, AgentQueueResponse } from '@app/shared-contracts/agent-proposals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Deferred, Effect } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';

import { ApprovalsPanel } from '../../../src/routes/agent-platform/approvals-panel.tsx';

interface ApprovalsFixture {
  queue: { state: 'ready'; value: AgentQueueResponse };
}
const { fetch, fixture, refresh } = rstest.hoisted(() => {
  const state: ApprovalsFixture = {
    queue: {
      state: 'ready',
      value: {
        batches: [],
        company: { legalEntityId: 'company', legalName: 'Company' },
        pendingCount: 0,
        unavailableModules: [],
      },
    },
  };
  return { fetch: rstest.fn<typeof globalThis.fetch>(), fixture: state, refresh: rstest.fn() };
});
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({ useRouterState: () => '' }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({ Link: () => null }));
rstest.mock('../../../src/routes/agent-platform/platform-page-data.ts', () => ({
  agentQueueData: {
    ensure: () => {},
    refresh,
    snapshot: () => fixture.queue,
    subscribe: () => () => {},
  },
}));
const batch: AgentQueueBatch = {
  agentLabel: 'Agent',
  agentPrincipalId: 'principal',
  batchId: 'batch',
  canRevertAll: true,
  createdAt: '2026-10-25T10:00:00.000Z',
  instruction: 'Review changes',
  items: [
    {
      appId: 'work-tasks',
      canDecide: true,
      diff: [],
      key: 'core:item',
      moduleKey: 'work-tasks',
      moduleLabel: 'Tasks',
      proposedAt: '2026-10-25T10:00:00.000Z',
      reason: 'Requested',
      risk: 'low',
      status: 'pending',
      summary: 'Task',
      targetLabel: 'Target',
    },
  ],
  key: 'core:batch',
  moduleLabels: ['Tasks'],
  source: 'core',
};
const originalFetch = globalThis.fetch;
beforeEach(() => {
  fetch.mockReset();
  refresh.mockReset();
  refresh.mockReturnValue(Effect.void);
  globalThis.fetch = fetch;
  fixture.queue = {
    state: 'ready',
    value: {
      batches: [batch],
      company: { legalEntityId: 'company', legalName: 'Company' },
      pendingCount: 1,
      unavailableModules: [],
    },
  };
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const keyAt = (index: number) => new Headers(fetch.mock.calls[index]?.[1]?.headers).get('idempotency-key');

it.effect('retains the original decision and key after a lost response, note edit and queue removal', () =>
  Effect.gen(function* retryOriginalDecision() {
    fetch.mockRejectedValueOnce(new Error('response lost'));
    const view = render(<ApprovalsPanel />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Original note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schválit dávku (1)' }));
    yield* Effect.promise(() => screen.findByText('Rozhodnutí se nepodařilo uložit. Zkuste to prosím znovu.'));
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed after failure' } });
    fixture.queue = {
      state: 'ready',
      value: {
        batches: [],
        company: { legalEntityId: 'company', legalName: 'Company' },
        pendingCount: 0,
        unavailableModules: [],
      },
    };
    view.rerender(<ApprovalsPanel />);
    fetch.mockResolvedValueOnce(Response.json({ results: [{ itemKey: 'core:item', outcome: 'applied' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Zopakovat původní požadavek' }));
    yield* Effect.promise(() => waitFor(() => expect(refresh).toHaveBeenCalledTimes(1)));
    expect(keyAt(0)).toBeTruthy();
    expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
    expect(fetch.mock.calls[1]?.[1]?.credentials).toBe('same-origin');
    expect(keyAt(1)).toBe(keyAt(0));
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(
      '{"batchKey":"core:batch","decision":"approve","itemKeys":["core:item"],"note":"Original note"}',
    );
    expect(screen.queryByRole('button', { name: 'Zopakovat původní požadavek' })).toBeNull();
  }),
);

it.effect('creates a new key for an intentionally changed decision and clears it after a terminal rejection', () =>
  Effect.gen(function* changedDecision() {
    fetch.mockRejectedValueOnce(new Error('response lost'));
    render(<ApprovalsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Schválit dávku (1)' }));
    yield* Effect.promise(() => screen.findByText('Rozhodnutí se nepodařilo uložit. Zkuste to prosím znovu.'));
    fetch.mockResolvedValueOnce(Response.json({ detail: 'Denied' }, { status: 403 }));
    fireEvent.click(screen.getByRole('button', { name: 'Zamítnout dávku' }));
    yield* Effect.promise(() => waitFor(() => expect(refresh).toHaveBeenCalledTimes(1)));
    expect(keyAt(1)).not.toBe(keyAt(0));
    expect(screen.queryByRole('button', { name: 'Zopakovat původní požadavek' })).toBeNull();
    fetch.mockResolvedValueOnce(Response.json({ detail: 'Denied' }, { status: 403 }));
    fireEvent.click(screen.getByRole('button', { name: 'Zamítnout dávku' }));
    yield* Effect.promise(() => waitFor(() => expect(refresh).toHaveBeenCalledTimes(2)));
    expect(keyAt(2)).not.toBe(keyAt(1));
  }),
);

it.effect('keeps a mutation single-flight through body consumption and finalizes it before the next action', () =>
  Effect.gen(function* bodySingleFlight() {
    const reading = yield* Deferred.make<boolean>();
    const body = Promise.withResolvers<ArrayBuffer>();
    const response = Response.json({ results: [{ itemKey: 'core:item', outcome: 'applied' }] });
    const bytes = yield* Effect.promise(response.arrayBuffer.bind(response));
    rstest.spyOn(response, 'arrayBuffer').mockImplementationOnce(() => {
      Deferred.doneUnsafe(reading, Effect.succeed(true));
      return body.promise;
    });
    fetch.mockResolvedValueOnce(response);
    render(<ApprovalsPanel />);
    const approve = screen.getByRole('button', { name: 'Schválit dávku (1)' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    yield* Deferred.await(reading);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(approve.hasAttribute('disabled')).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    body.resolve(bytes);
    yield* Effect.promise(() => waitFor(() => expect(refresh).toHaveBeenCalledTimes(1)));
    expect(approve.hasAttribute('disabled')).toBe(false);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    fetch.mockResolvedValueOnce(Response.json({ detail: 'Denied' }, { status: 403 }));
    fireEvent.click(approve);
    yield* Effect.promise(() => waitFor(() => expect(refresh).toHaveBeenCalledTimes(2)));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(keyAt(1)).not.toBe(keyAt(0));
  }),
);

it.effect('retains a revert payload and key through an uncertain server error', () =>
  Effect.gen(function* retryOriginalRevert() {
    fetch.mockResolvedValueOnce(Response.json({ detail: 'Unavailable' }, { status: 503 }));
    render(<ApprovalsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Vrátit vše' }));
    fireEvent.click(screen.getByRole('button', { name: 'Potvrdit vrácení celé dávky' }));
    yield* Effect.promise(() => screen.findByText('Dávku se nepodařilo vrátit. Zkuste to prosím znovu.'));
    fetch.mockResolvedValueOnce(Response.json({ message: 'Restored', outcome: 'reverted' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zopakovat původní požadavek' }));
    yield* Effect.promise(() => screen.findByText('Restored'));
    expect(fetch.mock.calls[1]?.[0]).toEqual(new URL('/shell-super-app-api/agent-platform/revert', location.href));
    expect(keyAt(1)).toBe(keyAt(0));
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
  }),
);
