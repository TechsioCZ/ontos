import { Effect } from 'effect' with { rstest: 'importActual' };
import type { AgentEntity, ManageAgentEntityRequest } from '@app/shared-contracts/agent-access';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rs } from 'effect-rstest';

import { AgentEntitiesSection } from '../../src/routes/people/agent-entities-section.tsx';

interface StatusDialogFixture {
  agent: AgentEntity;
  missing: boolean;
  requests: { readonly key: string; readonly request: ManageAgentEntityRequest }[];
  sequence: number;
}
const { fixture } = rs.hoisted(() => {
  const state: StatusDialogFixture = {
    agent: {
      connections: [],
      description: null,
      displayName: 'Asistent provozu',
      hasProfile: true,
      modules: [],
      operators: [],
      owner: null,
      principalId: '00000000-0000-4000-8000-000000000004',
      status: 'active',
      writePolicy: 'approval',
    },
    missing: false,
    requests: [],
    sequence: 0,
  };
  return { fixture: state };
});
rs.mock('@modern-js/plugin-tanstack/runtime', () => ({ useRouterState: () => null }));
rs.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rs.mock('../../src/routes/people/use-agent-page-data.ts', () => ({
  usePageData: () => ({
    refreshing: false,
    state: 'ready',
    value: {
      agents: fixture.missing ? [] : [fixture.agent],
      audit: [],
      company: { legalEntityId: 'company', legalName: 'Firma' },
      members: [],
      modules: [],
      presets: [],
    },
  }),
}));
rs.mock('../../src/routes/people/people-client.ts', () => ({
  get newRequestToken() {
    return Effect.sync(() => {
      fixture.sequence += 1;
      return `request-${fixture.sequence}`;
    });
  },
}));
rs.mock('../../src/routes/people/agent-entities-client.ts', () => ({
  runAgentCommand: (request: ManageAgentEntityRequest, key: string) =>
    Effect.sync(() => {
      fixture.requests.push({ key, request });
      // Deliberately fail the transport: this is a producer/confirmation test, not a simulated server commit.
      return { detail: 'Přerušeno', reason: 'error', status: 'failed' };
    }),
}));
beforeEach(() => {
  fixture.agent = { ...fixture.agent, status: 'active' };
  fixture.missing = false;
  fixture.requests = [];
  fixture.sequence = 0;
});
afterEach(cleanup);

for (const status of ['active', 'disabled'] as const) {
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- Testing Library's DOM boundary is Promise-based; remove-when: rule recognizes Rstest callbacks.
  it(`retains the original ${status} archive payload and key after a failed response and directory removal`, async () => {
    fixture.agent = { ...fixture.agent, status };
    const view = render(<AgentEntitiesSection legalEntityId="company" onNotify={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'shell.agents.section.delete' }));
    const confirmName = 'shell.agents.section.dialog.deleteConfirm';
    fireEvent.click(screen.getByRole('button', { name: confirmName }));
    expect(screen.getByText('shell.agents.section.dialog.reasonRequired')).toBeTruthy();
    expect(fixture.requests).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Ukončení provozu  ' } });
    fireEvent.click(screen.getByRole('button', { name: confirmName }));
    await screen.findByText('Přerušeno');
    fixture.missing = true;
    view.rerender(<AgentEntitiesSection legalEntityId="company" onNotify={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: confirmName }));
    await waitFor(() => expect(fixture.requests).toHaveLength(2));
    expect(fixture.requests[0]).toEqual({
      key: 'agent-request-1',
      request: {
        expectedStatus: status,
        operation: 'delete',
        principalId: fixture.agent.principalId,
        reason: 'Ukončení provozu',
      },
    });
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);
    expect(fixture.sequence).toBe(1);
  });
}
