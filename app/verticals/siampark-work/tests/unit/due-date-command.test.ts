import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SingleWorkCommandSchema } from '../../shared/actions/apply-command.ts';

const decode = (input: unknown) => Schema.decodeUnknownOption(SingleWorkCommandSchema)(input);
const taskRef = {
  moduleId: 'siampark.work',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'siampark.work.task',
  tenantId: '20000000-0000-4000-8000-000000000001',
};

it('CreateTask rejects a typed year such as 0026 and accepts a real deadline', () => {
  expect(Option.isNone(decode({ _tag: 'CreateTask', dueDate: '0026-02-12', title: 'Kontrola střechy' }))).toBe(true);
  expect(Option.isNone(decode({ _tag: 'CreateTask', dueDate: '2126-02-12', title: 'Kontrola střechy' }))).toBe(true);
  expect(Option.isSome(decode({ _tag: 'CreateTask', dueDate: '2027-02-12', title: 'Kontrola střechy' }))).toBe(true);
});

it('UpdateTask rejects an implausible year but can still clear the due date', () => {
  expect(Option.isNone(decode({ _tag: 'UpdateTask', dueDate: '0026-02-12', taskRef }))).toBe(true);
  expect(Option.isSome(decode({ _tag: 'UpdateTask', dueDate: null, taskRef }))).toBe(true);
  expect(Option.isSome(decode({ _tag: 'UpdateTask', dueDate: '2026-11-03', taskRef }))).toBe(true);
});
