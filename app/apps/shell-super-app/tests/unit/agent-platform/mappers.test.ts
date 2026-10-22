import { expect, it } from 'effect-rstest';

import {
  accessRowToEntry,
  auditRowToEntry,
  buildActivityResponse,
  type AgentProposalRow,
  type ModuleTexts,
  proposalRowToEntries,
  rowsToQueueBatches,
} from '../../../api/agent-platform/mappers.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LEGAL = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const JANA = '44444444-4444-4444-8444-444444444444';
const BATCH = '55555555-5555-4555-8555-555555555555';
const names = new Map<string, string>([[JANA, 'Jana Nováková']]);
/** Composed modules as their contributions describe them (CRM keeps its own AI change engine). */
const LABELS: Readonly<Record<string, string>> = { 'demo.crm': 'CRM', 'demo.sales-pipeline': 'Obchodní případy' };
const modules: ModuleTexts = {
  hasOwnProposalEngine: (moduleKey) => moduleKey in LABELS,
  labelOf: (moduleKey) => (moduleKey === null || moduleKey === undefined ? 'Platforma' : (LABELS[moduleKey] ?? moduleKey)),
};

const baseRow: AgentProposalRow = {
  actionSlug: 'apply-command',
  agentLabel: 'Obchodní agent',
  agentPrincipalId: AGENT,
  appId: 'crm',
  applyResult: null,
  appliedAt: null,
  batchId: BATCH,
  batchInstruction: 'Aktualizuj CRM',
  batchRevertNote: null,
  batchRevertedAt: null,
  batchRevertedByPrincipalId: null,
  command: { _tag: 'UpdateContact' },
  createdAt: new Date('2026-10-20T10:00:00.000Z'),
  decidedAt: null,
  decidedByPrincipalId: null,
  decisionNote: null,
  diff: [{ field: 'phone', label: 'Telefon', after: '+420 601 000 000' }],
  failure: null,
  legalEntityId: LEGAL,
  moduleKey: 'demo.crm',
  position: 0,
  proposalId: '66666666-6666-4666-8666-666666666660',
  reason: 'Kontakt je zastaralý.',
  referenceAudiences: [],
  revert: { commands: [{ _tag: 'UpdateContact' }], kind: 'commands' },
  revertedAt: null,
  revertedByPrincipalId: null,
  risk: 'low',
  runId: null,
  status: 'pending',
  summary: 'Změna telefonu',
  targetLabel: 'Jan Novák',
  tenantId: TENANT,
};

const canDecideAll = () => ({ allowed: true }) as const;

it('groups rows of one batch and orders items by position', () => {
  const first: AgentProposalRow = { ...baseRow, position: 1, proposalId: '66666666-6666-4666-8666-666666666661' };
  const second: AgentProposalRow = { ...baseRow, position: 0, proposalId: '66666666-6666-4666-8666-666666666662' };
  const batches = rowsToQueueBatches([first, second], { canDecide: canDecideAll, modules, names });
  expect(batches).toHaveLength(1);
  const [batch] = batches;
  expect(batch?.key).toBe(`core:${BATCH}`);
  expect(batch?.source).toBe('core');
  expect(batch?.items.map((item) => item.key)).toEqual([
    'core:66666666-6666-4666-8666-666666666662',
    'core:66666666-6666-4666-8666-666666666661',
  ]);
  expect(batch?.moduleLabels).toEqual(['CRM']);
});

it('marks items without a revert plan as unavailable to revert', () => {
  const [batch] = rowsToQueueBatches([{ ...baseRow, revert: null, status: 'applied' }], {
    canDecide: canDecideAll,
    modules,
    names,
  });
  expect(batch?.items[0]?.revertUnavailableReason).toBe('Tuto změnu nelze automaticky vrátit.');
  expect(batch?.canRevertAll).toBe(false);
});

it('allows revert-all for an applied, revertible, decidable batch', () => {
  const [batch] = rowsToQueueBatches([{ ...baseRow, status: 'applied' }], { canDecide: canDecideAll, modules, names });
  expect(batch?.canRevertAll).toBe(true);
  expect(batch?.items[0]?.revertUnavailableReason).toBeUndefined();
});

it('reports a reverted batch with the reverting person and disables revert-all', () => {
  const [batch] = rowsToQueueBatches(
    [
      {
        ...baseRow,
        batchRevertedAt: new Date('2026-10-20T11:00:00.000Z'),
        batchRevertedByPrincipalId: JANA,
        batchRevertNote: 'Omyl',
        status: 'applied',
      },
    ],
    { canDecide: canDecideAll, modules, names },
  );
  expect(batch?.canRevertAll).toBe(false);
  expect(batch?.revertedByName).toBe('Jana Nováková');
  expect(batch?.revertNote).toBe('Omyl');
});

it('maps a denied audit event to a denied CRM activity entry', () => {
  const entry = auditRowToEntry(
    {
      actionKey: 'demo.crm.apply-command',
      auditEventId: 'a1',
      displayName: 'Obchodní agent',
      occurredAt: new Date('2026-10-20T09:00:00.000Z'),
      outcome: 'denied',
      outcomeCode: 'forbidden',
      principalId: AGENT,
    },
    { modules, proposalOnly: false },
  );
  expect(entry.kind).toBe('denied');
  expect(entry.moduleKey).toBe('demo.crm');
  expect(entry.moduleLabel).toBe('CRM');
  expect(entry.actionLabel).toBe('Pokus o zápis odmítnut');
});

it('maps an allowed list read to the Czech list label', () => {
  const entry = accessRowToEntry(
    {
      accessKind: 'list',
      dataAccessEventId: 'r1',
      displayName: 'Obchodní agent',
      occurredAt: new Date('2026-10-20T09:00:00.000Z'),
      outcome: 'allowed',
      outcomeCode: 'ok',
      principalId: AGENT,
      servingModuleKey: 'demo.crm',
      targetResourceType: 'contact',
    },
    modules,
  );
  expect(entry.kind).toBe('read');
  expect(entry.actionLabel).toBe('Čtení seznamu');
  expect(entry.detail).toBe('contact');
});

it('emits proposal and decision entries for an applied proposal', () => {
  const entries = proposalRowToEntries(
    {
      ...baseRow,
      decidedAt: new Date('2026-10-20T10:30:00.000Z'),
      decidedByPrincipalId: JANA,
      status: 'applied',
    },
    names,
    modules,
  );
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => entry.kind)).toEqual(['proposal', 'decision']);
  expect(entries[1]?.actionLabel).toBe('Schváleno: Jana Nováková');
});

it('keeps the agent list unfiltered when filtering by kind and applies the limit', () => {
  const entries = [
    auditRowToEntry(
      {
        actionKey: 'demo.crm.apply-command',
        auditEventId: 'a1',
        displayName: 'Obchodní agent',
        occurredAt: new Date('2026-10-20T09:00:00.000Z'),
        outcome: 'denied',
        outcomeCode: 'forbidden',
        principalId: AGENT,
      },
      { modules, proposalOnly: false },
    ),
    accessRowToEntry(
      {
        accessKind: 'list',
        dataAccessEventId: 'r1',
        displayName: 'Hanák agent',
        occurredAt: new Date('2026-10-20T08:00:00.000Z'),
        outcome: 'allowed',
        outcomeCode: 'ok',
        principalId: '77777777-7777-4777-8777-777777777777',
        servingModuleKey: 'demo.sales-pipeline',
        targetResourceType: null,
      },
      modules,
    ),
    accessRowToEntry(
      {
        accessKind: 'read',
        dataAccessEventId: 'r2',
        displayName: 'Obchodní agent',
        occurredAt: new Date('2026-10-20T07:00:00.000Z'),
        outcome: 'allowed',
        outcomeCode: 'ok',
        principalId: AGENT,
        servingModuleKey: 'demo.crm',
        targetResourceType: null,
      },
      modules,
    ),
  ];
  const denied = buildActivityResponse(entries, { kind: 'denied' });
  expect(denied.entries.map((entry) => entry.id)).toEqual(['audit:a1']);
  expect(denied.agents.map((agent) => agent.name)).toEqual(['Hanák agent', 'Obchodní agent']);

  const limited = buildActivityResponse(entries, { limit: 2 });
  expect(limited.entries).toHaveLength(2);
  expect(limited.entries[0]?.id).toBe('audit:a1');
});

it('builds the price diff from the command and the live product, not from the agent text', () => {
  const row: AgentProposalRow = {
    ...baseRow,
    appId: 'merchandise',
    command: { _tag: 'ChangePrice', id: 'p1', priceMinor: 100 },
    diff: [{ after: '3 660,00 Kč', before: '3 490,00 Kč', field: 'currentPriceMinor', label: 'Cena bez DPH' }],
    moduleKey: 'demo.merchandise',
  };
  const [batch] = rowsToQueueBatches([row], {
    canDecide: canDecideAll,
    liveBefore: new Map([[row.proposalId, { currentPriceMinor: 349_000, id: 'p1' }]]),
    modules,
    names,
  });
  const item = batch?.items[0];
  expect(item?.diffSource).toBe('platform');
  expect(item?.diff).toEqual([
    { after: '1,00\u00a0Kč', before: '3\u00a0490,00\u00a0Kč', field: 'priceMinor', label: 'Cena bez DPH' },
  ]);
  expect(item?.revertUnavailableReason).toBeUndefined();
});

it('marks commands the platform does not understand as agent-described', () => {
  const [batch] = rowsToQueueBatches([baseRow], { canDecide: canDecideAll, modules, names });
  expect(batch?.items[0]?.diffSource).toBe('agent');
  expect(batch?.items[0]?.diff).toEqual(baseRow.diff);
});

it('does not report a pending claim as a decision', () => {
  const claimed: AgentProposalRow = { ...baseRow, decidedAt: new Date(), decidedByPrincipalId: JANA };
  const [batch] = rowsToQueueBatches([claimed], { canDecide: canDecideAll, modules, names });
  expect(batch?.items[0]?.decidedAt).toBeUndefined();
  expect(proposalRowToEntries(claimed, names, modules)).toHaveLength(1);
});

it('labels a successful legacy write of an approval-only agent as a proposal', () => {
  const entry = auditRowToEntry(
    {
      actionKey: 'demo.sales-pipeline.apply-command',
      auditEventId: 'a2',
      displayName: 'AI agent C',
      occurredAt: new Date('2026-10-20T09:00:00.000Z'),
      outcome: 'succeeded',
      outcomeCode: 'action_executed',
      principalId: AGENT,
    },
    { modules, proposalOnly: true },
  );
  expect(entry.kind).toBe('proposal');
  expect(entry.actionLabel).toBe('Návrh ke schválení');
  expect(entry.detail).toBe('Návrh do schvalovací fronty modulu Obchodní případy');
});

it('lists the stored command for modules without their own diff, never the agent text', () => {
  const row: AgentProposalRow = {
    ...baseRow,
    appId: 'facility-operations',
    command: { _tag: 'MeterCreate', name: 'Elektroměr hala A' },
    diff: [{ after: 'něco jiného', field: 'name', label: 'Název' }],
    moduleKey: 'facility.operations',
    revert: null,
  };
  const [batch] = rowsToQueueBatches([row], { canDecide: canDecideAll, modules, names });
  expect(batch?.items[0]?.diffSource).toBe('command');
  expect(batch?.items[0]?.diff).toEqual([{ after: 'Elektroměr hala A', field: 'name', label: 'Název' }]);
  expect(batch?.items[0]?.revertUnavailableReason).toBe('Tuto změnu nelze automaticky vrátit.');
});
