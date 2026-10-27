import type { AgentEntity } from '@app/shared-contracts/agent-access';
import { cleanup, render, screen } from '@testing-library/react';
import { Effect } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import { AgentEntitiesSection } from '../../src/routes/people/agent-entities-section.tsx';

const { fixture } = rstest.hoisted(() => ({
  fixture: {
    agent: {
      connections: [],
      description: null,
      displayName: 'Asistent provozu',
      hasProfile: true,
      modules: [],
      operators: [],
      owner: null,
      principalId: '00000000-0000-4000-8000-000000000003',
      status: 'active',
      writePolicy: 'approval',
    },
    forbidden: false,
    target: '00000000-0000-4000-8000-000000000003',
  },
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useRouterState: ({
    select,
  }: {
    readonly select: (state: { readonly location: { readonly search: { readonly agent: string } } }) => string | null;
  }) => select({ location: { search: { agent: fixture.target } } }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('../../src/routes/people/use-agent-page-data.ts', () => ({
  usePageData: () =>
    fixture.forbidden
      ? { error: { reason: 'forbidden' }, refreshing: false, state: 'failed' }
      : {
          refreshing: false,
          state: 'ready',
          value: {
            agents: [fixture.agent],
            audit: [],
            company: { legalEntityId: 'company', legalName: 'Firma' },
            members: [],
            modules: [],
            presets: [],
          },
        },
}));
rstest.mock('../../src/routes/people/agent-editor-panel.tsx', () => ({
  AgentEditorPanel: ({ agent }: { readonly agent: AgentEntity | null }) => (
    <div data-testid="agent-editor">{agent?.displayName}</div>
  ),
}));
afterEach(() => {
  cleanup();
  fixture.forbidden = false;
  fixture.agent.hasProfile = true;
  fixture.agent.principalId = fixture.target;
});

it.live('opens the linked real agent editor in-place, without a workforce route or redirect', () =>
  Effect.gen(function* openLinkedAgent() {
    HTMLElement.prototype.scrollIntoView = rstest.fn<HTMLElement['scrollIntoView']>();
    render(<AgentEntitiesSection legalEntityId="company" onNotify={() => {}} />);
    const editor = yield* Effect.promise(() => screen.findByTestId('agent-editor'));
    expect(editor.textContent).toBe('Asistent provozu');
  }),
);

it('shows an absent profile honestly instead of claiming a configured write policy', () => {
  fixture.agent.hasProfile = false;
  render(<AgentEntitiesSection legalEntityId="company" onNotify={() => {}} />);
  expect(screen.getByText('shell.agents.section.noProfile')).toBeTruthy();
  expect(screen.getByText('shell.agents.section.noProfileDescription')).toBeTruthy();
  expect(screen.queryByText('shell.agents.connections.policy.approval')).toBeNull();
  expect(screen.queryByText('shell.agents.section.noWrites')).toBeNull();
});

it.live('drops an old agent detail when the selected company no longer admits that principal', () =>
  Effect.gen(function* dropUnadmittedAgent() {
    HTMLElement.prototype.scrollIntoView = rstest.fn<HTMLElement['scrollIntoView']>();
    const view = render(<AgentEntitiesSection legalEntityId="company" onNotify={() => {}} />);
    yield* Effect.promise(() => screen.findByTestId('agent-editor'));
    fixture.agent = { ...fixture.agent, principalId: '00000000-0000-4000-8000-000000000009' };
    view.rerender(<AgentEntitiesSection legalEntityId="other-company" onNotify={() => {}} />);
    expect(screen.queryByTestId('agent-editor')).toBeNull();
  }),
);

it('does not render an admin-only creation control for a member without agent administration', () => {
  fixture.forbidden = true;
  render(<AgentEntitiesSection legalEntityId="company" onNotify={() => {}} />);
  expect(screen.queryByRole('button', { name: 'shell.agents.section.create' })).toBeNull();
});
