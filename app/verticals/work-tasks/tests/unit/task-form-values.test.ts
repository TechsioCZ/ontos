import { expect, it } from 'effect-rstest';
import { Option, Schema } from 'effect';
import { SingleWorkCommandSchema } from '../../shared/actions/apply-command.ts';
import { principalKey } from '../../shared/assignment.ts';
import { OpportunityIdSchema, PartyIdSchema, TaskSchema } from '../../shared/apis/records.ts';
import { selectedPrincipal } from '../../src/routes/[lang]/ukoly/assignment-options.ts';
import {
  decodeProjectSelection,
  hasUnsavedInput,
  initialValues,
  taskFormSubmission,
} from '../../src/routes/[lang]/ukoly/task-form-values.ts';
import type { Decoded, FormValues } from '../../src/routes/[lang]/ukoly/task-form-values.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const principal = { principalId: '40000000-0000-4000-8000-000000000001', tenantId };
const task = Schema.decodeUnknownSync(TaskSchema)({
  collectionRef: {
    moduleId: 'work.tasks',
    resourceId: 'default',
    resourceType: 'work.tasks.task-collection',
    tenantId,
  },
  contextRefs: [
    {
      moduleId: 'property.portfolio',
      resourceId: '20000000-0000-4000-8000-000000000011',
      resourceType: 'property.portfolio.property',
      tenantId,
    },
    {
      moduleId: 'legal.agreements',
      resourceId: '20000000-0000-4000-8000-000000000012',
      resourceType: 'legal.agreements.contract',
      tenantId,
    },
  ],
  createdAt: '2026-10-05T10:00:00.000Z',
  description: 'Saved description',
  dueDate: '0026-02-12',
  opportunityId: '20000000-0000-4000-8000-000000000021',
  ownerPrincipalRef: principal,
  partyId: '20000000-0000-4000-8000-000000000022',
  plannedHours: 2.5,
  priority: 'HIGH',
  projectId: ' Project / 1 ',
  ref: {
    moduleId: 'work.tasks',
    resourceId: 'task-1',
    resourceType: 'work.tasks.task',
    tenantId,
  },
  state: 'IN_PROGRESS',
  title: 'Saved task',
  updatedAt: '2026-10-05T10:00:00.000Z',
});

const decoded = (values: FormValues): Decoded => ({
  dueDate: values.dueDate,
  opportunityId: Option.getOrUndefined(Schema.decodeUnknownOption(OpportunityIdSchema)(values.opportunityId)),
  ownerPrincipalRef: selectedPrincipal([{ displayName: 'Saved owner', principalRef: principal }], values.assigneeId),
  partyId: Option.getOrUndefined(Schema.decodeUnknownOption(PartyIdSchema)(values.partyId)),
});

it('initializes a new draft with the existing empty controls and normal priority', () => {
  const values = initialValues();
  expect(values.assigneeId).toBe('');
  expect(values.contextRefs).toEqual([]);
  expect(values.description).toBe('');
  expect(values.dueDate).toBeUndefined();
  expect(values.opportunityId).toBe('');
  expect(values.partyId).toBe('');
  expect(values.plannedHours).toBe('');
  expect(values.priority).toBe('NORMAL');
  expect(values.projectId).toBe('');
  expect(values.title).toBe('');
  expect(hasUnsavedInput(values)).toBe(false);
});

it('initializes edits from saved values without trimming IDs or clamping the saved calendar date', () => {
  const values = initialValues(task);
  expect(values.assigneeId).toBe(principalKey(principal));
  expect(values.contextRefs).toEqual(task.contextRefs);
  expect(values.description).toBe(task.description);
  expect(values.dueDate).toBe('0026-02-12');
  expect(values.opportunityId).toBe(task.opportunityId);
  expect(values.partyId).toBe(task.partyId);
  expect(values.plannedHours).toBe('2.5');
  expect(values.priority).toBe('HIGH');
  expect(values.projectId).toBe(' Project / 1 ');
  expect(values.title).toBe(task.title);
  expect(hasUnsavedInput(values, task)).toBe(false);
});

it('distinguishes an empty selection from invalid non-empty project input', () => {
  const empty = decodeProjectSelection('');
  expect(Option.isSome(empty)).toBe(true);
  if (Option.isSome(empty)) {
    expect(empty.value).toBeUndefined();
  }
  expect(Option.isNone(decodeProjectSelection('x'.repeat(301)))).toBe(true);
});

it('keeps every schema-valid project ID verbatim, including whitespace and the length limit', () => {
  for (const value of ['project-1', ' Project / 1 ', ' ', 'x'.repeat(300)]) {
    expect(decodeProjectSelection(value)).toEqual(Option.some(value));
  }
});

it('submits decoded project IDs through the create and update command codecs without changing their wire value', () => {
  const values = initialValues(task);
  const submission = taskFormSubmission(values, decoded(values));
  expect(Option.isSome(submission)).toBe(true);
  if (Option.isSome(submission) && submission.value.projectId !== undefined) {
    const create = Schema.encodeSync(SingleWorkCommandSchema)({
      _tag: 'CreateTask',
      projectId: submission.value.projectId,
      title: submission.value.title,
    });
    const update = Schema.encodeSync(SingleWorkCommandSchema)({
      _tag: 'UpdateTask',
      projectId: Option.some(submission.value.projectId),
      taskRef: task.ref,
    });
    expect(create).toHaveProperty('projectId', values.projectId);
    expect(update).toHaveProperty('projectId', values.projectId);
  }
});

it('clears an empty project selection explicitly on update but rejects invalid input instead of clearing it', () => {
  const values = { ...initialValues(task), projectId: '' };
  const cleared = taskFormSubmission(values, decoded(values));
  expect(Option.isSome(cleared)).toBe(true);
  if (Option.isSome(cleared)) {
    expect(cleared.value.projectId).toBeUndefined();
    const update = Schema.encodeSync(SingleWorkCommandSchema)({
      _tag: 'UpdateTask',
      projectId: Option.fromUndefinedOr(cleared.value.projectId),
      taskRef: task.ref,
    });
    expect(update).toHaveProperty('projectId', null);
  }
  const invalid = { ...values, projectId: 'x'.repeat(301) };
  expect(Option.isNone(taskFormSubmission(invalid, decoded(invalid)))).toBe(true);
});

it('retains text trimming, optional numeric controls, and the existing planned-hours limits', () => {
  const initial = initialValues(task);
  for (const plannedHours of ['', '0', '0.5', '10000', ' ']) {
    const values = { ...initial, description: ' Description ', plannedHours, title: ' Title ' };
    const submission = taskFormSubmission(values, decoded(values));
    expect(Option.isSome(submission)).toBe(true);
    if (Option.isSome(submission)) {
      expect(submission.value.description).toBe('Description');
      expect(submission.value.title).toBe('Title');
      if (plannedHours === '') {
        expect(submission.value.plannedHours).toBeUndefined();
      } else {
        expect(submission.value.plannedHours).toBe(Number(plannedHours));
      }
    }
  }
  for (const plannedHours of ['-1', '10000.1', 'NaN', 'Infinity', 'not a number']) {
    const values = { ...initial, plannedHours };
    expect(Option.isNone(taskFormSubmission(values, decoded(values)))).toBe(true);
  }
});

it('compares context references by their owner fields rather than object key order', () => {
  const initial = initialValues(task);
  const reordered = task.contextRefs.map((ref) => {
    const tenantFirst = { tenantId: ref.tenantId };
    return Object.assign(tenantFirst, ref);
  });
  expect(Object.keys(reordered[0])).not.toEqual(Object.keys(task.contextRefs[0]));
  expect(hasUnsavedInput({ ...initial, contextRefs: reordered }, task)).toBe(false);
  expect(hasUnsavedInput({ ...initial, contextRefs: [initial.contextRefs[1], initial.contextRefs[0]] }, task)).toBe(
    true,
  );
});

it('keeps discard confirmation sensitive to every editable control', () => {
  const initial = initialValues(task);
  const patches = [
    { assigneeId: '' },
    { contextRefs: [] },
    { description: 'Changed' },
    { dueDate: '2026-10-28' },
    { opportunityId: '' },
    { partyId: '' },
    { plannedHours: '3' },
    { priority: 'LOW' },
    { projectId: '' },
    { title: 'Changed' },
  ] satisfies readonly Partial<FormValues>[];
  for (const patch of patches) {
    expect(hasUnsavedInput({ ...initial, ...patch }, task)).toBe(true);
  }
});
