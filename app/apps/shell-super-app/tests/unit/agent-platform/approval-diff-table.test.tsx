// @rstest-environment happy-dom
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  AgentLegalEntityIdSchema,
  AgentQueueBatchSchema,
  AgentQueueResponseSchema,
} from '@app/shared-contracts/agent-proposals';
import { browserNetwork, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { cleanup, screen, within } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';

import { ShellAuthenticationApi, shellAuthenticationApiContract } from '../../../shared/browser-api.ts';
import { ApprovalsPanel } from '../../../src/routes/agent-platform/approvals-panel.tsx';
import { shellLocaleCopy } from '../../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../../support/shell-router.tsx';

const batch = Schema.decodeUnknownSync(AgentQueueBatchSchema)({
  agentLabel: 'AI agent C',
  agentPrincipalId: 'principal',
  batchId: 'batch',
  canRevertAll: false,
  createdAt: '2026-11-02T18:04:00.000Z',
  instruction: 'Ověření schválení',
  items: [
    {
      appId: 'commerce-market-catalog',
      canDecide: true,
      diff: [{ after: '5 991,00 Kč', before: '5 990,00 Kč', field: 'netPrice', label: 'Cena bez DPH' }],
      diffSource: 'platform',
      key: 'core:item',
      moduleKey: 'commerce-market-catalog',
      moduleLabel: 'E-shop',
      proposedAt: '2026-11-02T18:04:00.000Z',
      reason: 'Dočasná zkouška schválení',
      risk: 'medium',
      status: 'pending',
      summary: 'Ověření schválení a vrácení údajů',
      targetLabel: 'Access point Wi-Fi 7',
    },
  ],
  key: 'core:batch',
  moduleLabels: ['E-shop'],
  source: 'core',
});
const queue = AgentQueueResponseSchema.make({
  batches: [batch],
  company: { legalEntityId: AgentLegalEntityIdSchema.make('company'), legalName: 'Obchodní firma' },
  pendingCount: 1,
  unavailableModules: [],
});

const QueueApi = HttpApi.make('approvalDiffTable')
  .add(HttpApiGroup.make('agentPlatform').add(ShellAuthenticationApi.groups.agentPlatform.endpoints.agentQueue))
  .prefix(shellAuthenticationApiContract.apiPrefix);
const handlers = HttpApiBuilder.group(QueueApi, 'agentPlatform', (group) =>
  group.handle('agentQueue', () => Effect.succeed(queue)),
);
const network = browserNetwork(serveApi(QueueApi, handlers));

afterEach(cleanup);

it.live('renders the diff as a semantic table whose row label is a row header', () =>
  Effect.gen(function* semanticDiffTable() {
    const router = makeShellRouter({
      page: { component: ApprovalsPanel, path: 'agent-platform/approvals' },
      url: '/cs/agent-platform/approvals',
    });
    yield* renderShellRoute(router, shellLocaleCopy('cs'));
    yield* waitUntil(
      () => screen.queryByRole('table', { name: 'Porovnání: Ověření schválení a vrácení údajů' }) !== null,
    );
    const table = screen.getByRole('table', { name: 'Porovnání: Ověření schválení a vrácení údajů' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Údaj', 'Před změnou', 'Po schválení']);
    const label = within(table).getByRole('rowheader', { name: 'Cena bez DPH' });
    const row = label.closest('tr');
    expect(row?.className).toBe('ai-review-diff-row');
    expect(
      within(row ?? table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['5 990,00 Kč', '5 991,00 Kč']);
    // Cell spacing belongs to agent-platform.css; spacing utilities on the cells (e.g. the undefined `px-75`) must not return.
    for (const cell of table.querySelectorAll('th, td')) {
      expect(cell.className).not.toMatch(/(?:^|\s)p[xytrbl]?-\d/u);
    }
  }).pipe(Effect.provide(network)),
);
