/**
 * Regression: the "Cena bez DPH" row label of an approval diff was present in the DOM but hidden. Its cells carried
 * `px-75`, which the UI kit spacing scale does not define, so Tailwind produced 300px inline padding that pushed the
 * label under the next cell; the stylesheet's padding still targeted `> span` from the older div markup.
 */
import { getI18nInstance as createModernI18n } from '@modern-js/plugin-i18n/i18n';
import type { I18nInstance } from '@modern-js/plugin-i18n/runtime';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import {
  AgentLegalEntityIdSchema,
  AgentQueueBatchSchema,
  AgentQueueResponseSchema,
} from '@app/shared-contracts/agent-proposals';
import type { AgentQueueResponse } from '@app/shared-contracts/agent-proposals';
import { cleanup, render, screen, within } from '@testing-library/react';
import { Schema } from 'effect';
import { afterEach, beforeAll, expect, it, rstest } from 'effect-rstest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PropsWithChildren } from 'react';

import csResource from '../../../locales/cs/shell.json';
import { ApprovalsPanel } from '../../../src/routes/agent-platform/approvals-panel.tsx';

const stylesheet = readFileSync(
  fileURLToPath(new URL('../../../src/routes/agent-platform/agent-platform.css', import.meta.url)),
  'utf-8',
);

let i18nInstance: I18nInstance;
beforeAll(async () => {
  i18nInstance = await createModernI18n();
  await i18nInstance.init({
    defaultNS: 'shell',
    lng: 'cs',
    ns: ['shell'],
    resources: { cs: { shell: csResource } },
    supportedLngs: ['cs', 'en'],
  });
});
const I18nProvider = ({ children }: PropsWithChildren) => (
  <ModernI18nProvider value={{ i18nInstance, language: 'cs', languages: ['cs', 'en'] }}>{children}</ModernI18nProvider>
);

interface ApprovalsFixture {
  queue?: { state: 'ready'; value: AgentQueueResponse } | undefined;
}
const { fixture } = rstest.hoisted(() => {
  const state: ApprovalsFixture = {};
  return { fixture: state };
});
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({ useRouterState: () => '' }));
rstest.mock('../../../src/routes/agent-platform/platform-page-data.ts', () => ({
  agentQueueData: {
    ensure: () => {},
    refresh: () => {},
    snapshot: () => fixture.queue,
    subscribe: () => () => {},
  },
}));

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
fixture.queue = {
  state: 'ready',
  value: AgentQueueResponseSchema.make({
    batches: [batch],
    company: { legalEntityId: AgentLegalEntityIdSchema.make('company'), legalName: 'Obchodní firma' },
    pendingCount: 1,
    unavailableModules: [],
  }),
};

afterEach(() => cleanup());

const normalized = (text: string) =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim();
/** Declarations of the stylesheet rule whose selector list is exactly `selector` (comments and whitespace ignored). */
const ruleBody = (selector: string): string | undefined =>
  [...stylesheet.matchAll(/(?<selectors>[^{}]+)\{(?<body>[^{}]*)\}/gu)].find(
    (rule) => normalized(rule.groups?.['selectors'] ?? '') === normalized(selector),
  )?.groups?.['body'];

it('renders the diff as a semantic table whose row label is a row header', () => {
  render(<ApprovalsPanel />, { wrapper: I18nProvider });
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
});

it('styles the semantic diff cells, not the retired span markup, with a readable row label', () => {
  expect(stylesheet).not.toMatch(/\.ai-review-diff-(?:head|row) > span/u);
  expect(stylesheet).not.toMatch(/@layer/u);
  expect(ruleBody('.ai-review-diff-head > :is(th, td), .ai-review-diff-row > :is(th, td)')).toMatch(
    /padding: 0\.65rem 0\.75rem;[\s\S]*overflow-wrap: anywhere;/u,
  );
  expect(ruleBody('.ai-review-diff-head > :is(th, td), .ai-review-diff-row > :is(th, td)')).toMatch(/min-width: 0;/u);
  expect(ruleBody('.ai-review-diff-row > th')).toMatch(/color: var\(--color-fg-primary\);/u);
  expect(ruleBody('.ai-review-diff-head')).toMatch(/color: var\(--color-fg-secondary/u);
});
