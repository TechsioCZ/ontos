import { expect, it } from 'effect-rstest';

import { agentChangeStillInPlace, agentCommandDiff, agentPlatformDiff } from '../../src/agent-diff.ts';

const taskRef = { moduleId: 'work.tasks', resourceId: 'T-1', resourceType: 'work.tasks.task', tenantId: 't' };

it('price diff shows the live price before and the command price after', () => {
  expect(
    agentPlatformDiff(
      'merchandise',
      { _tag: 'ChangePrice', id: 'p', priceMinor: 366_000 },
      { currentPriceMinor: 349_000 },
    ),
  ).toEqual([{ after: '3 660,00 Kč', before: '3 490,00 Kč', field: 'priceMinor', label: 'Cena bez DPH' }]);
});

it('a new task lists its fields in Czech', () => {
  expect(
    agentPlatformDiff(
      'work-tasks',
      { _tag: 'CreateTask', dueDate: '2026-10-30', priority: 'HIGH', title: 'Zavolat' },
      undefined,
    ),
  ).toEqual([
    { after: '30. 10. 2026', field: 'dueDate', label: 'Termín' },
    { after: 'Vysoká', field: 'priority', label: 'Priorita' },
    { after: 'Zavolat', field: 'title', label: 'Název úkolu' },
  ]);
});

it('unknown commands are not described by the platform', () => {
  expect(agentPlatformDiff('tagging', { _tag: 'AttachTag' }, undefined)).toBeUndefined();
  expect(agentPlatformDiff('work-tasks', { _tag: 'BulkChangeTaskState' }, undefined)).toBeUndefined();
});

it('detects a price a person changed after the approval', () => {
  const command = { _tag: 'ChangePrice', id: 'p', priceMinor: 360_000 };
  expect(agentChangeStillInPlace('merchandise', command, { currentPriceMinor: 360_000 })).toBe(true);
  expect(agentChangeStillInPlace('merchandise', command, { currentPriceMinor: 365_000 })).toBe(false);
  expect(agentChangeStillInPlace('work-tasks', { _tag: 'CreateTask', title: 'X' }, undefined)).toBeUndefined();
});

it('task updates compare only the fields the command set', () => {
  const command = { _tag: 'UpdateTask', taskRef, title: 'Nový název' };
  expect(agentChangeStillInPlace('work-tasks', command, { description: 'cokoli', title: 'Nový název' })).toBe(true);
  expect(agentChangeStillInPlace('work-tasks', command, { title: 'Ručně přepsáno' })).toBe(false);
  expect(
    agentChangeStillInPlace('work-tasks', { _tag: 'ChangeTaskState', state: 'DONE', taskRef }, { state: 'DONE' }),
  ).toBe(true);
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

it('a CRM client edit shows Czech labels with the live value before', () => {
  expect(
    agentPlatformDiff(
      'crm',
      { _tag: 'UpdateClient', id: 'c-1', patch: { phone: '+420 541 100 299', segment: 'bakery' } },
      { phone: '+420 541 100 200', segment: 'retail' },
    ),
  ).toEqual([
    { after: '+420 541 100 299', before: '+420 541 100 200', field: 'phone', label: 'Telefon' },
    { after: 'Pekárna', before: 'Maloobchod', field: 'segment', label: 'Segment' },
  ]);
});

it('command-built lines list patch fields one by one and skip the record id', () => {
  expect(agentCommandDiff({ _tag: 'UpdateParty', id: 'p-1', patch: { email: 'a@b.cz' } })).toEqual([
    { after: 'a@b.cz', field: 'email', label: 'E-mail' },
  ]);
});
