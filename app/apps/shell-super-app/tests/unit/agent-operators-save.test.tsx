// Operators of an agent: ticking only changes the draft, the shared Uložit sends it once, a server refresh keeps a
// dirty selection, a conflict offers the latest version, and leaving with unsaved input asks first.
import { saveLabelsFor } from '@app/admin-ui';
import { AgentEntitySchema, PrincipalRefSchema } from '@app/shared-contracts/agent-access';
import type { AgentOperatorsRequest } from '@app/shared-contracts/agent-access';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Effect, Schema } from 'effect' with { rstest: 'importActual' };
import { afterEach, expect, it, rs } from 'effect-rstest';

import { OperatorsBlock } from '../../src/routes/people/agent-operators-block.tsx';

const labels = saveLabelsFor('cs');

interface OperatorsFixture {
  answer: 'conflict' | 'ok';
  requests: AgentOperatorsRequest[];
}
interface Navigation {
  proceed: () => void;
  reset: () => void;
  shouldBlock: () => boolean;
  status: 'blocked' | 'idle';
}
const { fixture, navigation } = rs.hoisted(() => {
  const state: OperatorsFixture = { answer: 'ok', requests: [] };
  const nav: Navigation = { proceed: () => {}, reset: () => {}, shouldBlock: () => false, status: 'idle' };
  return { fixture: state, navigation: nav };
});
rs.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: (options: { readonly shouldBlockFn: () => boolean }) => {
    navigation.shouldBlock = options.shouldBlockFn;
    return { proceed: navigation.proceed, reset: navigation.reset, status: navigation.status };
  },
}));
rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rs.mock('../../src/routes/people/agent-entities-client.ts', () => ({
  saveAgentOperators: (request: AgentOperatorsRequest) =>
    Effect.sync(() => {
      fixture.requests.push(request);
      return fixture.answer === 'ok'
        ? {
            status: 'ok',
            value: { agentPrincipalId: request.agentPrincipalId, operators: [], revokedConnections: 0 },
          }
        : { detail: null, reason: 'conflict', status: 'failed' };
    }),
}));
afterEach(() => {
  cleanup();
  fixture.answer = 'ok';
  fixture.requests = [];
  navigation.status = 'idle';
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
    modules: [],
    operators,
    operatorsRevision,
    owner: null,
    principalId: '00000000-0000-4000-8000-000000000004',
    status: 'active',
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

it.live('ticking sends nothing; Uložit sends the selection once with the revision it was read from', () =>
  Effect.gen(function* typeSaveOnce() {
    render(block([], () => {}, 3));
    expect(navigation.shouldBlock()).toBe(false);
    fireEvent.click(checkbox(jana));
    expect(fixture.requests).toHaveLength(0);
    expect(navigation.shouldBlock()).toBe(true);
    fireEvent.click(saveButton());
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText(labels.saved)).toBeTruthy()));
    expect(fixture.requests).toEqual([
      {
        agentPrincipalId: '00000000-0000-4000-8000-000000000004',
        expectedRevision: 3,
        operatorPrincipalIds: [jana.principalId],
      },
    ]);
    expect(navigation.shouldBlock()).toBe(false);
  }),
);

it.live('a dirty selection survives a server refresh', () =>
  Effect.gen(function* survivesRefresh() {
    const view = render(block([]));
    fireEvent.click(checkbox(jana));
    view.rerender(block([petr]));
    expect(checkbox(jana).getAttribute('aria-checked')).toBe('true');
    expect(checkbox(petr).getAttribute('aria-checked')).toBe('false');
    expect(navigation.shouldBlock()).toBe(true);
    yield* Effect.void;
  }),
);

it.live('a refused stale save shows a conflict and reloads the latest version', () =>
  Effect.gen(function* conflictReload() {
    fixture.answer = 'conflict';
    let refreshed = 0;
    const view = render(
      block([], () => {
        refreshed += 1;
      }),
    );
    fireEvent.click(checkbox(jana));
    fireEvent.click(saveButton());
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText(labels.conflict)).toBeTruthy()));
    view.rerender(
      block([petr], () => {
        refreshed += 1;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: labels.reloadLatest }));
    expect(refreshed).toBe(1);
    expect(checkbox(petr).getAttribute('aria-checked')).toBe('true');
    expect(checkbox(jana).getAttribute('aria-checked')).toBe('false');
    expect(fixture.requests).toHaveLength(1);
  }),
);

it.live('leaving with an unsaved selection asks, and Zahodit změny leaves', () =>
  Effect.gen(function* leaveDiscard() {
    let proceeded = 0;
    navigation.proceed = () => {
      // The router lets the navigation go: the block is no longer asked about.
      navigation.status = 'idle';
      proceeded += 1;
    };
    const view = render(block([]));
    fireEvent.click(checkbox(jana));
    navigation.status = 'blocked';
    view.rerender(block([]));
    fireEvent.click(yield* Effect.promise(() => screen.findByRole('button', { name: labels.discard })));
    expect(proceeded).toBe(1);
    expect(fixture.requests).toHaveLength(0);
    view.rerender(block([]));
    // The discarded draft is back at the confirmed (empty) selection, and nothing is left to ask about.
    expect(navigation.shouldBlock()).toBe(false);
    yield* Effect.promise(() => waitFor(() => expect(checkbox(jana).getAttribute('aria-checked')).toBe('false')));
  }),
);

it.live('Uložit in the leave question saves once and leaves', () =>
  Effect.gen(function* leaveSave() {
    let proceeded = 0;
    navigation.proceed = () => {
      // The router lets the navigation go: the block is no longer asked about.
      navigation.status = 'idle';
      proceeded += 1;
    };
    const view = render(block([]));
    fireEvent.click(checkbox(petr));
    navigation.status = 'blocked';
    view.rerender(block([]));
    const dialog = yield* Effect.promise(() => screen.findByRole('alertdialog'));
    const buttons = dialog.querySelectorAll('button');
    const save = [...buttons].find((button) => button.textContent === labels.save);
    expect(save).toBeDefined();
    fireEvent.click(save ?? dialog);
    yield* Effect.promise(() => waitFor(() => expect(proceeded).toBe(1)));
    expect(fixture.requests).toHaveLength(1);
  }),
);
