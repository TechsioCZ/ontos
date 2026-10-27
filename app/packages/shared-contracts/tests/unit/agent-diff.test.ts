import { expect, it } from 'effect-rstest';

import {
  agentCommandDiff,
  agentDiffLine,
  agentDiffValue,
  agentFieldLines,
  agentRecordHolds,
} from '../../src/agent-diff.ts';
import type { AgentCommandSourceValue } from '../../src/agent-proposals.ts';

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
    agentFieldLines(
      { _tag: 'X', dueDate: '2026-10-30', ref: 'r', title: 'Zavolat' },
      { title: 'Název' },
      { title: 'A' },
      new Set(['ref']),
    ),
  ).toEqual([
    { after: '30. 10. 2026', field: 'dueDate', label: 'dueDate' },
    { after: 'Zavolat', before: 'A', field: 'title', label: 'Název' },
  ]);
});

it('a record still holds a change when every set value is unchanged', () => {
  expect(agentRecordHolds({ phone: '1' }, { name: 'x', phone: '1' })).toBe(true);
  expect(agentRecordHolds({ phone: '1' }, { phone: '2' })).toBe(false);
  expect(agentRecordHolds({ lines: [{ a: 1 }] }, { lines: [{ a: 1, b: 2 }] })).toBe(true);
  for (const absent of [null, undefined]) {
    expect(agentRecordHolds(null, absent)).toBe(true);
  }
});

it('lists the stored command fields for modules without their own diff, labelled by the module', () => {
  expect(
    agentCommandDiff(
      {
        _tag: 'MeterCreate',
        expectedRevision: 3,
        name: 'Elektroměr hala A',
        note: '',
        readingDate: '2026-10-21',
      },
      { name: 'Název' },
    ),
  ).toEqual([
    { after: 'Elektroměr hala A', field: 'name', label: 'Název' },
    { after: '21. 10. 2026', field: 'readingDate', label: 'readingDate' },
  ]);
});

it('command-built lines list patch fields one by one and skip the record id', () => {
  expect(
    agentCommandDiff(
      { _tag: 'UpdateParty', id: 'p-1', patch: { email: 'a@b.cz', unitPriceMinor: 1000 } },
      { email: 'E-mail' },
    ),
  ).toEqual([
    { after: 'a@b.cz', field: 'email', label: 'E-mail' },
    { after: '10,00\u00A0Kč', field: 'unitPriceMinor', label: 'unitPriceMinor' },
  ]);
});

it('command-built lines show a bare reference id as a short record reference', () => {
  expect(
    agentCommandDiff(
      { _tag: 'UpdateAgendaEvent', eventId: '73130000-0000-4000-8000-000000000101' },
      { eventId: 'Událost' },
    ),
  ).toEqual([{ after: 'záznam 73130000…', field: 'eventId', label: 'Událost' }]);
});

it.each([null, undefined])('a cleared diff omits its value keys for %s', (emptyValue) => {
  const line = agentDiffLine('note', 'Poznámka', null, emptyValue);
  expect(line).toEqual({ field: 'note', label: 'Poznámka' });
  expect(Object.hasOwn(line, 'before')).toBe(false);
  expect(Object.hasOwn(line, 'after')).toBe(false);
});

it('command limits count visible flattened fields after skipping metadata and empty values', () => {
  const patch = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, `value${index}`]));
  const lines = agentCommandDiff({ _tag: 'Update', id: 'record', patch: { empty: '', ...patch } }, {});
  expect(lines).toHaveLength(60);
  expect(lines[0]).toMatchObject({ after: 'value0', field: 'field0' });
  expect(lines.at(-1)).toMatchObject({ after: 'value59', field: 'field59' });
});

it('object diff values keep command JSON omission and nonfinite-number normalization', () => {
  const source = Object.fromEntries<AgentCommandSourceValue>([
    ['missing', undefined],
    ['number', Number.NaN],
  ]);
  expect(Object.hasOwn(source, 'missing')).toBe(true);
  expect(agentDiffLine('details', 'Podrobnosti', undefined, source)).toEqual({
    after: '{"number":null}',
    field: 'details',
    label: 'Podrobnosti',
  });
});

it('nonfinite construction values keep their Czech presentation before JSON normalization', () => {
  expect(agentDiffValue('number', Number.NaN)).toBe('NaN');
  expect(agentDiffValue('number', Number.POSITIVE_INFINITY)).toBe('∞');
  expect(agentDiffValue('number', Number.NEGATIVE_INFINITY)).toBe('-∞');
  expect(
    agentDiffLine('details', 'Podrobnosti', undefined, {
      infinite: Number.POSITIVE_INFINITY,
      negativeInfinite: Number.NEGATIVE_INFINITY,
      notANumber: Number.NaN,
    }),
  ).toEqual({
    after: '{"infinite":null,"negativeInfinite":null,"notANumber":null}',
    field: 'details',
    label: 'Podrobnosti',
  });
});
