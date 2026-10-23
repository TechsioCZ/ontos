import type { AgentEntity } from '@app/shared-contracts/agent-access';
import { cleanup, render, screen } from '@testing-library/react';
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
  usePageData: () => ({
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
  }),
}));
rstest.mock('../../src/routes/people/agent-editor-panel.tsx', () => ({
  AgentEditorPanel: ({ agent }: { readonly agent: AgentEntity | null }) => (
    <div data-testid="agent-editor">{agent?.displayName}</div>
  ),
}));
afterEach(() => {
  cleanup();
  fixture.agent.hasProfile = true;
  fixture.agent.principalId = fixture.target;
});

// oxlint-disable-next-line effect-native/no-promise-shaped-port -- Testing Library uses Promise-based DOM interactions at the test boundary; remove-when: rule recognizes Rstest callbacks.
it('opens the linked real agent editor in-place, without a workforce route or redirect', async () => {
  HTMLElement.prototype.scrollIntoView = rstest.fn<HTMLElement['scrollIntoView']>();
  render(<AgentEntitiesSection legalEntityId="company" onNotify={() => {}} />);
  const editor = await screen.findByTestId('agent-editor');
  expect(editor.textContent).toBe('Asistent provozu');
});

it('shows an absent profile honestly instead of claiming a configured write policy', () => {
  fixture.agent.hasProfile = false;
  render(<AgentEntitiesSection legalEntityId="company" onNotify={() => {}} />);
  expect(screen.getByText('shell.agents.section.noProfile')).toBeTruthy();
  expect(screen.getByText('shell.agents.section.noProfileDescription')).toBeTruthy();
  expect(screen.queryByText('shell.agents.connections.policy.approval')).toBeNull();
  expect(screen.queryByText('shell.agents.section.noWrites')).toBeNull();
});

// oxlint-disable-next-line effect-native/no-promise-shaped-port -- Testing Library uses Promise-based DOM interactions at the test boundary; remove-when: rule recognizes Rstest callbacks.
it('drops an old agent detail when the selected company no longer admits that principal', async () => {
  HTMLElement.prototype.scrollIntoView = rstest.fn<HTMLElement['scrollIntoView']>();
  const view = render(<AgentEntitiesSection legalEntityId="company" onNotify={() => {}} />);
  await screen.findByTestId('agent-editor');
  fixture.agent = { ...fixture.agent, principalId: '00000000-0000-4000-8000-000000000009' };
  view.rerender(<AgentEntitiesSection legalEntityId="other-company" onNotify={() => {}} />);
  expect(screen.queryByTestId('agent-editor')).toBeNull();
});
