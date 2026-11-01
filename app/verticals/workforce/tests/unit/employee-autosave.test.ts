import { AutosaveOutcomeSchema, startAutosave } from '@app/admin-ui';
import { DateTime, Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { EmployeeIdSchema } from '../../shared/resources/employee.ts';
import type { Employee } from '../../shared/apis/records.ts';
import type { CommitOutcome, EmployeeDraft } from '../../src/routes/[lang]/prodej/zamestnanci/employee-model.ts';
import {
  draftErrors,
  draftFromEmployee,
  employeeAutosaveResult,
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

it('maps an edit-panel commit onto autosave: a revision is saved, a revision conflict stays a conflict', () => {
  expect(employeeAutosaveResult(12)).toBe(12);
  expect(employeeAutosaveResult('conflict')).toBe('conflict');
  expect(employeeAutosaveResult('duplicateEmail')).toBe('failed');
  expect(employeeAutosaveResult('forbidden')).toBe('failed');
  expect(employeeAutosaveResult('failed')).toBe('failed');
});

it('never autosaves an edit with an empty name or a malformed e-mail', () => {
  const draft = draftFromEmployee(jana);
  expect(draftErrors(draft)).toEqual([]);
  expect(draftErrors({ ...draft, fullName: ' ' })).toContain('fullName');
  expect(draftErrors({ ...draft, email: 'jana@' })).toContain('email');
});

const isAutosaveOutcome = Schema.is(AutosaveOutcomeSchema);

const edited = Effect.fnUntraced(function* edited(outcome: CommitOutcome | number) {
  const sent: EmployeeDraft[] = [];
  const controller = yield* startAutosave(draftFromEmployee(jana), {
    equals: sameDraft,
    isValid: (value: EmployeeDraft) => draftErrors(value).length === 0,
    save: (value: EmployeeDraft) =>
      Effect.sync(() => {
        sent.push(value);
        return employeeAutosaveResult(outcome);
      }).pipe(Effect.map((result) => (isAutosaveOutcome(result) ? result : 'saved'))),
  });
  return { controller, sent };
});

describe('employee edit panel autosave', () => {
  it.effect('saves a typed change after the quiet time and reports it saved', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* edited(13);
      controller.change({ ...draftFromEmployee(jana), department: 'Provoz' });
      expect(controller.status()).toBe('dirty');
      yield* TestClock.adjust('800 millis');
      expect(sent.map(({ department }) => department)).toEqual(['Provoz']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('keeps an invalid edit local', () =>
    Effect.gen(function* invalid() {
      const { controller, sent } = yield* edited(13);
      controller.change({ ...draftFromEmployee(jana), email: 'jana@' });
      controller.flush();
      yield* TestClock.adjust('1 second');
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('invalid');
    }),
  );

  it.effect('stops on a revision conflict instead of overwriting', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* edited('conflict');
      controller.change({ ...draftFromEmployee(jana), phone: '+420 777 123 456' });
      controller.flush();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...draftFromEmployee(jana), phone: '+420 777 000 000' });
      yield* TestClock.adjust('1 second');
      expect(sent).toHaveLength(1);
    }),
  );
});
