import {
  AgentActivityEntrySchema,
  AgentActivityRequestSchema,
  AgentRecordReferenceSchema,
} from '@app/shared-contracts/agent-proposals';
import { DateTime, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  accessRowToEntry,
  auditRowToEntry,
  buildActivityResponse,
  proposalRowToEntries,
  rowsToQueueBatches,
} from '../../../api/agent-platform/mappers.ts';
import type { AgentProposalRow, ModuleTexts } from '../../../api/agent-platform/mappers.ts';

const instant = (iso: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

const TENANT = '11111111-1111-4111-8111-111111111111';
const LEGAL = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const JANA = '44444444-4444-4444-8444-444444444444';
const BATCH = '55555555-5555-4555-8555-555555555555';
const names = new Map<string, string>([[JANA, 'Jana Nováková']]);
/** Composed modules as their contributions describe them (CRM keeps its own AI change engine). */
const LABELS = new Map([
  ['demo.crm', 'CRM'],
  ['demo.sales-pipeline', 'Obchodní případy'],
]);
/** Command field names a module declares in its contribution. */
const FIELD_LABELS = new Map([['facility-operations', { name: 'Název měřidla' }]]);
const modules: ModuleTexts = {
  commandFieldLabelsOf: (appId) => FIELD_LABELS.get(appId) ?? {},
  hasOwnProposalEngine: (moduleKey) => LABELS.has(moduleKey),
  labelOf: (moduleKey) =>
    moduleKey === null || moduleKey === undefined ? 'Platforma' : (LABELS.get(moduleKey) ?? moduleKey),
};

const baseRow: AgentProposalRow = {
  actionSlug: 'apply-command',
  agentLabel: 'Obchodní agent',
  agentPrincipalId: AGENT,
  appId: 'crm',
  appliedAt: null,
  applyResult: null,
  batchId: BATCH,
  batchInstruction: 'Aktualizuj CRM',
  batchRevertedAt: null,
  batchRevertedByPrincipalId: null,
  batchRevertNote: null,
  command: { _tag: 'UpdateContact' },
  createdAt: instant('2026-10-20T10:00:00.000Z'),
  decidedAt: null,
  decidedByPrincipalId: null,
  decisionNote: null,
  diff: [{ after: '+420 601 000 000', field: 'phone', label: 'Telefon' }],
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
        batchRevertedAt: instant('2026-10-20T11:00:00.000Z'),
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
      occurredAt: instant('2026-10-20T09:00:00.000Z'),
      outcome: 'denied',
      outcomeCode: 'forbidden',
      principalId: AGENT,
    },
    { modules, proposalOnly: false },
  );
  expect(entry.kind).toBe('denied');
  expect(Schema.encodeSync(AgentActivityEntrySchema)(entry).moduleKey).toBe('demo.crm');
  expect(entry.moduleLabel).toBe('CRM');
  expect(entry.actionLabel).toBe('Pokus o zápis odmítnut');
});

it('maps an allowed list read to the Czech list label', () => {
  const entry = accessRowToEntry(
    {
      accessKind: 'list',
      dataAccessEventId: 'r1',
      displayName: 'Obchodní agent',
      occurredAt: instant('2026-10-20T09:00:00.000Z'),
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
      decidedAt: instant('2026-10-20T10:30:00.000Z'),
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
        occurredAt: instant('2026-10-20T09:00:00.000Z'),
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
        occurredAt: instant('2026-10-20T08:00:00.000Z'),
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
        occurredAt: instant('2026-10-20T07:00:00.000Z'),
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

it('shows the module review lines and live record name, never the agent text', () => {
  const row: AgentProposalRow = {
    ...baseRow,
    command: { _tag: 'ChangePrice', id: 'p1', priceMinor: 100 },
    diff: [{ after: '3 660,00 Kč', before: '3 490,00 Kč', field: 'currentPriceMinor', label: 'Cena bez DPH' }],
    summary: 'Změna ceny',
    targetLabel: 'Změna ceny',
  };
  const lines = [{ after: '1,00 Kč', before: '3 490,00 Kč', field: 'priceMinor', label: 'Cena bez DPH' }];
  const [batch] = rowsToQueueBatches([row], {
    canDecide: canDecideAll,
    modules,
    names,
    reviewOf: () => ({ diff: lines, key: row.proposalId, targetName: 'Croissant', visible: true }),
  });
  const item = batch?.items[0];
  expect(item?.diffSource).toBe('platform');
  expect(item?.diff).toEqual(lines);
  expect(item?.targetLabel).toBe('Croissant');
  expect(item?.revertUnavailableReason).toBeUndefined();
});

it('keeps the stored before of decided proposals next to the module lines', () => {
  const row: AgentProposalRow = {
    ...baseRow,
    diff: [{ after: '1,00 Kč', before: '3 490,00 Kč', field: 'priceMinor', label: 'Cena bez DPH' }],
    status: 'applied',
  };
  const [batch] = rowsToQueueBatches([row], {
    canDecide: canDecideAll,
    modules,
    names,
    reviewOf: () => ({
      diff: [{ after: '1,00 Kč', field: 'priceMinor', label: 'Cena bez DPH' }],
      key: row.proposalId,
      visible: true,
    }),
  });
  expect(batch?.items[0]?.diff).toEqual(row.diff);
});

it('shows why the module will not undo a pending change', () => {
  const [batch] = rowsToQueueBatches([baseRow], {
    canDecide: canDecideAll,
    modules,
    names,
    reviewOf: () => ({ key: baseRow.proposalId, revertUnavailableReason: 'Nelze vrátit.', visible: true }),
  });
  expect(batch?.items[0]?.revertUnavailableReason).toBe('Nelze vrátit.');
});

it('marks commands the platform does not understand as agent-described', () => {
  const [batch] = rowsToQueueBatches([baseRow], { canDecide: canDecideAll, modules, names });
  expect(batch?.items[0]?.diffSource).toBe('agent');
  expect(batch?.items[0]?.diff).toEqual(baseRow.diff);
});

it('does not report a pending claim as a decision', () => {
  const claimed: AgentProposalRow = {
    ...baseRow,
    decidedAt: instant('2026-10-23T10:00:00.000Z'),
    decidedByPrincipalId: JANA,
  };
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
      occurredAt: instant('2026-10-20T09:00:00.000Z'),
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

it('lists the stored command for modules without their own diff with the module field names, never the agent text', () => {
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
  expect(batch?.items[0]?.diff).toEqual([{ after: 'Elektroměr hala A', field: 'name', label: 'Název měřidla' }]);
  expect(batch?.items[0]?.revertUnavailableReason).toBe('Tuto změnu nelze automaticky vrátit.');
});

it('preserves audit record references and their owning module even without an action invocation', () => {
  const entry = auditRowToEntry(
    {
      actionKey: null,
      auditEventId: 'audit-1',
      displayName: 'Agent',
      occurredAt: instant('2026-10-23T10:00:00Z'),
      outcome: 'succeeded',
      outcomeCode: 'ok',
      principalId: AGENT,
      targetModuleKey: 'fixture.notes',
      targetResourceId: 'note-1',
      targetResourceType: 'fixture.note',
    },
    { modules, proposalOnly: false },
  );
  expect(Schema.encodeSync(AgentActivityEntrySchema)(entry).moduleKey).toBe('fixture.notes');
  expect(entry.recordReference).toEqual({ resourceId: 'note-1', resourceType: 'fixture.note' });
});

it('carries an exact proposal and module-owned record reference for every proposal decision', () => {
  const entries = proposalRowToEntries(
    { ...baseRow, decidedAt: instant('2026-10-23T10:00:00.000Z'), status: 'applied' },
    names,
    {
      ...modules,
      recordReferenceOf: () =>
        Schema.decodeUnknownSync(AgentRecordReferenceSchema)({ resourceId: 'record-1', resourceType: 'fixture.note' }),
    },
  );
  for (const entry of entries) {
    expect(entry.proposal).toEqual({ batchKey: `core:${baseRow.batchId}`, itemKey: `core:${baseRow.proposalId}` });
    expect(entry.recordReference).toEqual({ resourceId: 'record-1', resourceType: 'fixture.note' });
  }
});

it('pages timestamp ties by the complete event ID without gaps or repeated entries', () => {
  const at = instant('2026-10-23T10:00:00.000Z');
  const entries = Array.from({ length: 41 }, (_, index) =>
    proposalRowToEntries(
      {
        ...baseRow,
        createdAt: at,
        decidedAt: at,
        proposalId: `66666666-6666-4666-8666-${String(index).padStart(12, '0')}`,
        status: 'rejected',
      },
      names,
      modules,
    ),
  ).flat();
  const ids: string[] = [];
  let page = buildActivityResponse(entries, {});
  expect(page.entries).toHaveLength(30);
  while (true) {
    ids.push(...page.entries.map((entry) => entry.id));
    if (page.nextCursor === undefined) {
      break;
    }
    page = buildActivityResponse(entries, { cursor: page.nextCursor });
  }
  expect(ids).toHaveLength(entries.length);
  expect(new Set(ids).size).toBe(entries.length);
  // At equal times, proposal: sorts before decision: regardless of the proposal UUID.
  expect(ids.slice(0, 41).every((id) => id.startsWith('proposal:'))).toBe(true);
  expect(page.nextCursor).toBeUndefined();
});

it('applies activity filters before page size and finds a recent decision on an old proposal', () => {
  const entries = [
    ...proposalRowToEntries(baseRow, names, modules),
    ...proposalRowToEntries(
      {
        ...baseRow,
        createdAt: instant('2025-01-01T00:00:00.000Z'),
        decidedAt: instant('2026-10-23T10:00:00.000Z'),
        proposalId: '66666666-6666-4666-8666-666666666661',
        status: 'rejected',
      },
      names,
      modules,
    ),
  ];
  const first = buildActivityResponse(
    entries,
    Schema.decodeUnknownSync(AgentActivityRequestSchema)({
      agentPrincipalId: AGENT,
      kind: 'decision',
      limit: 1,
      moduleKey: 'demo.crm',
    }),
  );
  expect(first.entries.map((entry) => entry.id)).toEqual(['decision:66666666-6666-4666-8666-666666666661']);
  expect(first.nextCursor).toBeUndefined();
  expect(buildActivityResponse(entries, { kind: 'read' }).entries).toEqual([]);
  expect(
    buildActivityResponse(
      entries,
      Schema.decodeUnknownSync(AgentActivityRequestSchema)({ cursor: { at: '2024-01-01T00:00:00.000Z', id: 'last' } }),
    ).entries,
  ).toEqual([]);
});
