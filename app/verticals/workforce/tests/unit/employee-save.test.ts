import { SaveOutcomeSchema, startDraftSave } from '@app/admin-ui';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { EmployeeIdSchema } from '../../shared/resources/employee.ts';
import type { Employee } from '../../shared/apis/records.ts';
import type { CommitOutcome, EmployeeDraft } from '../../src/routes/[lang]/prodej/zamestnanci/employee-model.ts';
import {
  draftErrors,
  draftFromEmployee,
  employeeSaveResult,
  sameDraft,
} from '../../src/routes/[lang]/prodej/zamestnanci/employee-model.ts';

const now = DateTime.makeUnsafe('2026-11-01T09:00:00Z');
const jana: Employee = {
  active: true,
  createdAt: now,
  department: 'Obchod',
  email: 'jana.novakova@najempark.demo',
  fullName: 'Jana Nováková',
  id: Schema.decodeUnknownSync(EmployeeIdSchema)('6f1d3c2a-9b8e-4d7f-8a6b-5c4d3e2f1a01'),
  role: 'SALES_REP',
  updatedAt: now,
};

it('maps the answer to the edit Save onto the save bar: a revision means saved, proposed stays proposed', () => {
  expect(employeeSaveResult(12)).toBe(12);
  expect(employeeSaveResult('proposed')).toBe('proposed');
  expect(employeeSaveResult('conflict')).toBe('conflict');
  expect(employeeSaveResult('duplicateEmail')).toBe('failed');
  expect(employeeSaveResult('forbidden')).toBe('failed');
  expect(employeeSaveResult('failed')).toBe('failed');
});

it('never saves a draft with an empty name or a malformed e-mail', () => {
  const draft = draftFromEmployee(jana);
  expect(draftErrors(draft)).toEqual([]);
  expect(draftErrors({ ...draft, fullName: ' ' })).toContain('fullName');
  expect(draftErrors({ ...draft, email: 'jana@' })).toContain('email');
});

const isSaveOutcome = Schema.is(SaveOutcomeSchema);

/** A form draft whose save sends each value once and answers with the given outcome. */
const openForm = Effect.fnUntraced(function* openForm(outcome: CommitOutcome | 'proposed' | number) {
  const sent: EmployeeDraft[] = [];
  const controller = yield* startDraftSave(draftFromEmployee(jana), {
    equals: sameDraft,
    isValid: (value: EmployeeDraft) => draftErrors(value).length === 0,
    save: (value: EmployeeDraft) =>
      Effect.sync(() => {
        sent.push(value);
        return employeeSaveResult(outcome);
      }).pipe(Effect.map((result) => (isSaveOutcome(result) ? result : 'saved'))),
  });
  return { controller, sent };
});

describe('employee edit form saves only on its Save button', () => {
  it.effect('typing changes only the draft: nothing is sent until save', () =>
    Effect.gen(function* typing() {
      const { controller, sent } = yield* openForm(13);
      controller.change({ ...draftFromEmployee(jana), department: 'Provoz' });
      controller.change({ ...draftFromEmployee(jana), department: 'Provoz', phone: '+420 777 123 456' });
      yield* Effect.yieldNow;
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('dirty');
    }),
  );

  it.effect('one save sends the whole draft exactly once and reports it saved', () =>
    Effect.gen(function* saveOnce() {
      const { controller, sent } = yield* openForm(13);
      controller.change({ ...draftFromEmployee(jana), department: 'Provoz' });
      controller.save();
      yield* Effect.yieldNow;
      expect(sent.map(({ department }) => department)).toEqual(['Provoz']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('an invalid draft is not sent and cannot be saved', () =>
    Effect.gen(function* invalid() {
      const { controller, sent } = yield* openForm(13);
      controller.change({ ...draftFromEmployee(jana), email: 'jana@' });
      controller.save();
      yield* Effect.yieldNow;
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('invalid');
    }),
  );

  it.effect('discard goes back to the saved version and sends nothing', () =>
    Effect.gen(function* discard() {
      const { controller, sent } = yield* openForm(13);
      controller.change({ ...draftFromEmployee(jana), fullName: 'Jana Nová' });
      controller.discard();
      yield* Effect.yieldNow;
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('idle');
    }),
  );

  it.effect('a revision conflict stops the save instead of overwriting', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* openForm('conflict');
      controller.change({ ...draftFromEmployee(jana), phone: '+420 777 123 456' });
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      expect(sent).toHaveLength(1);
    }),
  );

  it.effect('a change parked for approval is proposed and not sent again by typing', () =>
    Effect.gen(function* proposed() {
      const { controller, sent } = yield* openForm('proposed');
      controller.change({ ...draftFromEmployee(jana), department: 'Provoz' });
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('proposed');
      controller.change({ ...draftFromEmployee(jana), department: 'Sklad' });
      yield* Effect.yieldNow;
      expect(sent).toHaveLength(1);
    }),
  );
});
