// @rstest-environment happy-dom
// The employee panels keep their draft in the form: field messages, the taken e-mail, Enter as Uložit.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { DateTime, Effect, Option, Predicate, Schema, Struct } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, describe, expect, it } from 'effect-rstest';
import type { WorkforceCommand } from '../../shared/actions/apply-command.ts';
import type { Employee } from '../../shared/apis/records.ts';
import { EmployeeIdSchema } from '../../shared/resources/employee.ts';
import { EmployeeFormDialog } from '../../src/routes/[lang]/prodej/zamestnanci/employee-dialogs.tsx';
import type { EditCommitCommand } from '../../src/routes/[lang]/prodej/zamestnanci/employee-dialogs.tsx';
import type { EditCommitResult } from '../../src/routes/[lang]/prodej/zamestnanci/employee-model.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const copy = moduleText('cs');
const errors = 'workforce.pages.employees.errors';
const labels = saveLabelsFor('cs');
const now = DateTime.makeUnsafe('2026-11-01T09:00:00Z');
const principalRef = {
  principalId: '4c589117-5ecf-4b8a-a1ce-171093e26614',
  tenantId: '6bce2eda-3c92-4010-9900-046ca4deed76',
};
const people = [{ displayName: 'Jana Nováková', principalRef }];
const jana: Employee = {
  active: true,
  createdAt: now,
  department: 'Obchod',
  email: 'jana.novakova@najempark.demo',
  fullName: 'Jana Nováková',
  id: Schema.decodeUnknownSync(EmployeeIdSchema)('6f1d3c2a-9b8e-4d7f-8a6b-5c4d3e2f1a01'),
  principalRef,
  role: 'SALES_REP',
  updatedAt: now,
};

/** Answers each save in turn and keeps what was sent. */
const answering =
  (sent: WorkforceCommand[], answers: EditCommitResult[]): EditCommitCommand =>
  (command) =>
    Effect.sync(() => {
      sent.push(command);
      return answers.shift() ?? 'failed';
    });

const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));

/** The texts that describe a field: its help or error message. */
const helpOf = (id: string): string =>
  (field(id).getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((described) => document.querySelector(`[id="${described}"]`)?.textContent ?? '')
    .join(' ');

const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const clickSave = () =>
  acted(() => {
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.closest('form') === null && (button.textContent ?? '').trim() === labels.save,
    );
    Option.getOrThrow(Option.fromUndefinedOr(save)).click();
  });

const pressEnter = () =>
  acted(() => {
    const form = Option.getOrThrow(Option.fromNullOr(document.querySelector('form#employee-form')));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

const text = () => document.body.textContent ?? '';

afterEach(unmountAll);

describe('employee panels', () => {
  it.live('names every missing field once Enter tried a create, and sends nothing', () =>
    Effect.gen(function* createErrors() {
      const sent: WorkforceCommand[] = [];
      yield* mountInRoute(
        <EmployeeFormDialog
          availablePrincipals={people}
          commitEdit={answering(sent, [])}
          employee={null}
          onClose={constVoid}
          revision={3}
        />,
      );
      expect(text()).not.toContain(copy(`${errors}.fullName`));
      yield* pressEnter();
      yield* waitUntil(() => text().includes(copy(`${errors}.fullName`)));
      expect(text()).toContain(copy(`${errors}.email`));
      expect(text()).toContain(copy(`${errors}.department`));
      expect(text()).toContain(copy(`${errors}.principal`));
      expect(sent).toEqual([]);
    }),
  );

  it.live('shows a taken e-mail on the field until it changes, and Enter saves', () =>
    Effect.gen(function* takenEmail() {
      const sent: WorkforceCommand[] = [];
      yield* mountInRoute(
        <EmployeeFormDialog
          availablePrincipals={people}
          commitEdit={answering(sent, ['duplicateEmail', 4])}
          employee={jana}
          onClose={constVoid}
          revision={3}
        />,
      );
      yield* typeInto('employee-email', 'petr@najempark.demo');
      yield* clickSave();
      yield* waitUntil(() => helpOf('employee-email').includes(copy(`${errors}.emailTaken`)));
      expect(field('employee-email').getAttribute('aria-invalid')).toBe('true');
      yield* typeInto('employee-email', 'petr.svoboda@najempark.demo');
      yield* waitUntil(() => !helpOf('employee-email').includes(copy(`${errors}.emailTaken`)));
      yield* pressEnter();
      yield* waitUntil(() => sent.length === 2);
      const saved = Option.getOrThrow(Option.fromUndefinedOr(sent[1]));
      expect(Predicate.isTagged('UpdateEmployee')(saved)).toBe(true);
      expect(Struct.omit(saved, ['_tag'])).toEqual({
        id: jana.id,
        patch: {
          active: true,
          department: 'Obchod',
          email: 'petr.svoboda@najempark.demo',
          fullName: 'Jana Nováková',
          role: 'SALES_REP',
        },
      });
    }),
  );

  it.live('names a field the edit holds back as soon as it is typed', () =>
    Effect.gen(function* editErrors() {
      yield* mountInRoute(
        <EmployeeFormDialog
          availablePrincipals={people}
          commitEdit={answering([], [])}
          employee={jana}
          onClose={constVoid}
          revision={3}
        />,
      );
      yield* typeInto('employee-full-name', ' ');
      yield* waitUntil(() => helpOf('employee-full-name').includes(copy(`${errors}.fullName`)));
    }),
  );
});
