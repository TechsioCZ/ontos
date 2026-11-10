import { startDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import { TaskSchema } from '../../shared/apis/records.ts';
import {
  initialValues,
  sameFormValues,
  taskAutosaveOutcome,
  taskAutosaveResult,
} from '../../src/routes/[lang]/ukoly/task-form-values.ts';
import type { FormValues } from '../../src/routes/[lang]/ukoly/task-form-values.ts';

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

const saved = initialValues(task);
const conflictProblem = (code: 'work_lifecycle_conflict' | 'work_revision_conflict') =>
  Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
    _tag: 'ApplyCommandActionConflictProblem',
    code,
    detail: 'Úkoly se mezitím změnily.',
    status: 409,
    title: 'Konflikt',
    type: 'about:blank',
  });

describe('task edit panel autosave', () => {
  it('treats an untouched draft as saved and any edited field as a change', () => {
    expect(sameFormValues(saved, initialValues(task))).toBe(true);
    expect(sameFormValues(saved, { ...saved, title: 'Saved task, revised' })).toBe(false);
    expect(
      sameFormValues(saved, {
        ...saved,
        contextRefs: [...saved.contextRefs.slice(1), ...saved.contextRefs.slice(0, 1)],
      }),
    ).toBe(false);
  });

  it('turns only a revision conflict into the conflict line; a closed task or an outage is a failure', () => {
    expect(taskAutosaveOutcome(conflictProblem('work_revision_conflict'))).toBe('conflict');
    expect(taskAutosaveOutcome(conflictProblem('work_lifecycle_conflict'))).toBe('failed');
    expect(taskAutosaveOutcome({ _tag: 'ApplyCommandActionUnavailableProblem' })).toBe('failed');
  });

  const panel = Effect.fnUntraced(function* panel(outcome: SaveOutcome) {
    const sent: FormValues[] = [];
    const controller = yield* startDraftSave(saved, {
      equals: sameFormValues,
      isValid: (value: FormValues) => value.title.trim() !== '',
      save: (value: FormValues) => Effect.sync(() => sent.push(value)).pipe(Effect.as(outcome)),
    });
    return { controller, sent };
  });

  it.effect('saves a typed description after the quiet time; an empty title stays local', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...saved, title: ' ' });
      controller.save();
      expect(controller.status()).toBe('invalid');
      controller.change({ ...saved, description: 'Zavolat správci budovy' });
      yield* TestClock.adjust('800 millis');
      expect(sent.map(({ description }) => description)).toEqual(['Zavolat správci budovy']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('holds a conflicting draft instead of sending it again', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* panel('conflict');
      controller.change({ ...saved, priority: 'LOW' });
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...saved, priority: 'NORMAL' });
      yield* TestClock.adjust('1 second');
      expect(sent).toHaveLength(1);
    }),
  );

  const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
    _tag: 'ActionProposalAccepted',
    expiresAt: '2026-11-08T12:00:00.000Z',
    proposalId: '10000000-0000-4000-8000-000000000001',
  });

  it('reports a draft parked for approval as proposed; only a committed save moves the revision', () => {
    expect(taskAutosaveResult(proposal)).toBe('proposed');
    expect(taskAutosaveResult({ revision: 7 })).toBe(7);
  });

  it.effect('shows a parked draft as pending and never proposes it again on blur, retry or close', () =>
    Effect.gen(function* parkedOnce() {
      const { controller, sent } = yield* panel('proposed');
      const edited = { ...saved, description: 'Zavolat správci budovy' };
      controller.change(edited);
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('proposed');
      expect(controller.confirmed()).toBe(saved);
      // Blur, the retry control and the panel's close all flush; none of them sends the parked draft.
      controller.save();
      controller.save();
      controller.save();
      yield* TestClock.adjust('1 second');
      expect(sent).toEqual([edited]);
      expect(controller.status()).toBe('proposed');
    }),
  );

  it.effect('still saves a committed edit and still retries a real failure', () =>
    Effect.gen(function* controls() {
      const committed = yield* panel('saved');
      committed.controller.change({ ...saved, title: 'Saved task, revised' });
      committed.controller.save();
      yield* Effect.yieldNow;
      expect(committed.controller.status()).toBe('saved');
      const failing = yield* panel('failed');
      failing.controller.change({ ...saved, title: 'Saved task, revised' });
      failing.controller.save();
      yield* Effect.yieldNow;
      expect(failing.controller.status()).toBe('error');
      failing.controller.save();
      yield* Effect.yieldNow;
      expect(failing.sent).toHaveLength(2);
    }),
  );
});
