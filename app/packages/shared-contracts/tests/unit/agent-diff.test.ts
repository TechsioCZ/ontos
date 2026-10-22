import { expect, it } from 'effect-rstest';

import { agentCommandDiff, agentDiffLine, agentFieldLines, agentRecordHolds } from '../../src/agent-diff.ts';

it('a line shows the module value labels and money in Czech', () => {
  const options = { moneyFields: new Set(['priceMinor']), valueLabels: { state: { DONE: 'Hotovo' } } };
  expect(agentDiffLine('priceMinor', 'Cena', 349_000, 366_000, options)).toEqual({
    after: '3\u00A0660,00\u00A0Kč',
    before: '3\u00A0490,00\u00A0Kč',
    field: 'priceMinor',
    label: 'Cena',
  });
  expect(agentDiffLine('state', 'Stav', undefined, 'DONE', options)).toEqual({
    after: 'Hotovo',
    field: 'state',
    label: 'Stav',
  });
});

it('field lines take before from the same key and skip the listed keys', () => {
  expect(
    agentFieldLines({ _tag: 'X', dueDate: '2026-10-30', ref: 'r', title: 'Zavolat' }, { title: 'Název' }, { title: 'A' }, new Set(['ref'])),
  ).toEqual([
    { after: '30. 10. 2026', field: 'dueDate', label: 'dueDate' },
    { after: 'Zavolat', before: 'A', field: 'title', label: 'Název' },
  ]);
});

it('a record still holds a change when every set value is unchanged', () => {
  expect(agentRecordHolds({ phone: '1' }, { name: 'x', phone: '1' })).toBe(true);
  expect(agentRecordHolds({ phone: '1' }, { phone: '2' })).toBe(false);
  expect(agentRecordHolds({ lines: [{ a: 1 }] }, { lines: [{ a: 1, b: 2 }] })).toBe(true);
  expect(agentRecordHolds(null, undefined)).toBe(true);
});

it('lists the stored command fields for modules without their own diff', () => {
  expect(
    agentCommandDiff({
      _tag: 'MeterCreate',
      expectedRevision: 3,
      name: 'Elektroměr hala A',
      note: '',
      readingDate: '2026-10-21',
    }),
  ).toEqual([
    { after: 'Elektroměr hala A', field: 'name', label: 'Název' },
    { after: '21. 10. 2026', field: 'readingDate', label: 'readingDate' },
  ]);
});

it('command-built lines list patch fields one by one and skip the record id', () => {
  expect(agentCommandDiff({ _tag: 'UpdateParty', id: 'p-1', patch: { email: 'a@b.cz', unitPriceMinor: 1000 } })).toEqual([
    { after: 'a@b.cz', field: 'email', label: 'E-mail' },
    { after: '10,00\u00A0Kč', field: 'unitPriceMinor', label: 'unitPriceMinor' },
  ]);
});

it('command-built lines show a bare reference id as a short record reference', () => {
  expect(agentCommandDiff({ _tag: 'UpdateAgendaEvent', eventId: '73130000-0000-4000-8000-000000000101' })).toEqual([
    { after: 'záznam 73130000…', field: 'eventId', label: 'Událost' },
  ]);
});
