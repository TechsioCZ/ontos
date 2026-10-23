import type { AgentEntity } from '@app/shared-contracts/agent-access';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import { AgentEntitiesSection } from '../../src/routes/people/agent-entities-section.tsx';

const { fixture } = rstest.hoisted(() => ({
  fixture: {
    target: '00000000-0000-4000-8000-000000000003',
    agent: {
      principalId: '00000000-0000-4000-8000-000000000003',
      displayName: 'Asistent provozu',
      description: null,
      status: 'active',
      writePolicy: 'approval',
      seeded: false,
      modules: [],
      operators: [],
      connections: [],
      owner: null,
    },
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
    state: 'ready',
    refreshing: false,
    value: {
      company: { legalEntityId: 'company', legalName: 'Firma' },
      agents: [fixture.agent],
      members: [],
      modules: [],
      presets: [],
      audit: [],
    },
  }),
}));
rstest.mock('../../src/routes/people/agent-editor-panel.tsx', () => ({
  AgentEditorPanel: ({ agent }: { readonly agent: AgentEntity | null }) => (
    <div data-testid="agent-editor">{agent?.displayName}</div>
  ),
}));
afterEach(cleanup);

it('opens the linked real agent editor in-place, without a workforce route or redirect', async () => {
  HTMLElement.prototype.scrollIntoView = rstest.fn();
  render(<AgentEntitiesSection legalEntityId="company" onNotify={() => undefined} />);
  expect((await screen.findByTestId('agent-editor')).textContent).toBe('Asistent provozu');
});
