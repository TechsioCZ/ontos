import { parseLegacyKey } from '../../../shared/proposal-key.ts';
import { expect, test } from 'effect-rstest';

import {
  legacyBatchKey,
  normalizeLegacySlice,
  moduleActivityFromRecords,
  sliceFromRecords,
} from '../../../api/agent-platform/legacy-normalize.ts';
import type { LegacyEngineModule } from '../../../api/agent-platform/legacy-normalize.ts';

/** A composed module that keeps its own AI change engine. */
const crmApprovalsPage = { label: { cs: 'Otevřít v CRM', en: 'Open in CRM' }, path: '/crm/schvalovani-ai' };
const crm: LegacyEngineModule = { appId: 'crm', approvalsPage: crmApprovalsPage, label: 'CRM', moduleKey: 'demo.crm' };

const names = new Map([['principal-jana', 'Jana Nováková']]);

const slice = {
  batches: [
    {
      agentLabel: 'Agent Obchod',
      agentPrincipalId: 'principal-agent',
      createdAt: '2026-10-20T10:00:00.000Z',
      id: 'batch-1',
      instruction: 'Doplň kontakt pekárny',
    },
  ],
  changes: [
    {
      batchId: 'batch-1',
      diff: [],
      id: 'change-pending',
      operation: {
        _tag: 'CreateClient',
        contacts: [{ email: 'jan@firma.cz', name: 'Jan', primary: true }],
      },
      proposedAt: '2026-10-20T10:00:01.000Z',
      reason: 'Nový klient z e-mailu',
      risk: 'low',
      status: 'pending',
      summary: 'Nový klient',
      target: { kind: 'client', label: 'Pekárna Malá s.r.o.' },
    },
    {
      batchId: 'batch-1',
      decidedAt: '2026-10-20T11:00:00.000Z',
      decidedBy: 'principal-jana',
      diff: [{ after: 'Nová cena', field: 'price', label: 'Cena' }],
      id: 'change-applied',
      proposedAt: '2026-10-20T10:00:02.000Z',
      reason: 'Oprava ceny',
      risk: 'medium',
      status: 'applied',
      summary: 'Změna ceny',
      target: { kind: 'product', label: 'Káva' },
    },
  ],
};

test('parseLegacyKey splits app id and keeps colons inside the id', () => {
  expect(parseLegacyKey('legacy:crm:abc:ai-batch')).toEqual({ appId: 'crm', id: 'abc:ai-batch' });
  expect(parseLegacyKey('core:x')).toBeUndefined();
  expect(parseLegacyKey('legacy:crm:')).toBeUndefined();
});

test('sliceFromRecords reads the CRM state shape and the top-level shape', () => {
  expect(sliceFromRecords({ state: { aiChanges: slice } })).toBe(slice);
  expect(sliceFromRecords({ aiChanges: slice })).toBe(slice);
  expect(sliceFromRecords({ state: {} })).toBeUndefined();
});

test('normalizeLegacySlice builds one batch with legacy keys and revert permission', () => {
  const [batch] = normalizeLegacySlice(crm, slice, { canDecide: true, names });
  expect(batch?.key).toBe(legacyBatchKey('crm', 'batch-1'));
  expect(batch?.key).toBe('legacy:crm:batch-1');
  expect(batch?.source).toBe('legacy');
  expect(batch?.modulePage).toEqual(crmApprovalsPage);
  expect(batch?.canRevertAll).toBe(true);
  expect(batch?.items.map((item) => item.key)).toEqual(['legacy:crm:change-pending', 'legacy:crm:change-applied']);

  const [readOnly] = normalizeLegacySlice(crm, slice, { canDecide: false, names });
  expect(readOnly?.canRevertAll).toBe(false);

  const { approvalsPage: _page, ...withoutApprovalsPage } = crm;
  const [withoutPage] = normalizeLegacySlice(withoutApprovalsPage, slice, { canDecide: true, names });
  expect(withoutPage !== undefined && 'modulePage' in withoutPage).toBe(false);

  const [reverted] = normalizeLegacySlice(
    crm,
    {
      ...slice,
      batches: [{ ...slice.batches[0], revertedAt: '2026-10-20T12:00:00.000Z', revertedBy: 'principal-jana' }],
    },
    { canDecide: true, names },
  );
  expect(reverted?.canRevertAll).toBe(false);
  expect(reverted?.revertedByName).toBe('Jana Nováková');
});

test('normalizeLegacySlice resolves the decider name and maps unknown statuses to failed', () => {
  const [batch] = normalizeLegacySlice(crm, slice, { canDecide: true, names });
  const applied = batch?.items.find((item) => item.status === 'applied');
  expect(applied?.decidedByName).toBe('Jana Nováková');

  const unknown = normalizeLegacySlice(
    crm,
    { ...slice, changes: [{ ...slice.changes[0], status: 'something-new' }] },
    { canDecide: true, names },
  );
  expect(unknown[0]?.items[0]?.status).toBe('failed');
});

test('CreateClient contacts are expanded into per-contact diff lines', () => {
  const [batch] = normalizeLegacySlice(crm, slice, { canDecide: true, names });
  const pending = batch?.items.find((item) => item.status === 'pending');
  const labels = pending?.diff.map((line) => line.label) ?? [];
  expect(labels).toContain('Kontakt 1 · Jméno');
  expect(labels).toContain('Kontakt 1 · Hlavní kontakt');
  const primary = pending?.diff.find((line) => line.label === 'Kontakt 1 · Hlavní kontakt');
  expect(primary?.after).toBe('ano');
});

test('projects exact module-native proposals and their declared, stored record references', () => {
  const operation = { _tag: 'UpdateClient', id: 'client-1', patch: { name: 'Nové jméno' } };
  const native = {
    ...slice,
    changes: [{ ...slice.changes[1], operation, target: { id: 'client-1', kind: 'client', label: 'Klient' } }],
    log: [{ action: 'proposed', batchId: 'batch-1', changeId: 'change-applied', invocationId: 'invocation-1' }],
  };
  const recordLinks = [
    {
      commands: [],
      idField: 'id',
      labelField: 'name',
      path: '/notes',
      proposalTargetKind: 'client',
      queryParam: 'note',
      recordsPath: 'state.notes',
      resourceType: 'fixture.note',
    },
  ];
  const entries = moduleActivityFromRecords(crm, { state: { aiChanges: native } }, { names, recordLinks });
  expect(entries.map((entry) => entry.kind)).toEqual(['proposal', 'decision']);
  for (const entry of entries) {
    expect(entry.proposal).toEqual({ batchKey: 'legacy:crm:batch-1', itemKey: 'legacy:crm:change-applied' });
    expect(entry.recordReference).toEqual({ resourceId: 'client-1', resourceType: 'fixture.note' });
  }
  expect(entries[0]?.actionInvocationId).toBe('invocation-1');
  expect(entries[1]?.actionLabel).toBe('Schváleno: Jana Nováková');
  const unknown = moduleActivityFromRecords(crm, { aiChanges: native }, { names, recordLinks: [] });
  expect(unknown[0]?.recordReference).toBeUndefined();
  expect(moduleActivityFromRecords(crm, undefined, { names, recordLinks })).toEqual([]);
});
