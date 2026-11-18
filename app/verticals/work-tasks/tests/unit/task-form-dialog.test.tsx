// @rstest-environment happy-dom
// The task edit panel as the user sees it: one Save button in the panel footer, the draft's status next to it, and a
// question before unsaved changes are left. The real module i18n and router surround the panel; its save callback
// records submissions at the component boundary.
import type { RevisionedSaveResult } from '@app/admin-ui';
import { acted, buttons, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { pinTestDocument } from '@app/shared-contracts/testing/http-double';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { TaskSchema } from '../../shared/apis/records.ts';
import { TaskFormDialog } from '../../src/routes/[lang]/ukoly/task-form-dialog.tsx';
import type { TaskFormSubmission } from '../../src/routes/[lang]/ukoly/task-form-dialog.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const czech = moduleText('cs');
const closeLabel = czech('work-tasks.pages.records.close');

const tenantId = '20000000-0000-4000-8000-000000000001';
const task = Schema.decodeUnknownSync(TaskSchema)({
  collectionRef: {
    moduleId: 'work.tasks',
    resourceId: 'default',
    resourceType: 'work.tasks.task-collection',
    tenantId,
  },
  contextRefs: [],
  createdAt: '2026-10-05T10:00:00.000Z',
  description: 'Saved description',
  priority: 'HIGH',
  ref: { moduleId: 'work.tasks', resourceId: 'task-1', resourceType: 'work.tasks.task', tenantId },
  state: 'IN_PROGRESS',
  title: 'Saved task',
  updatedAt: '2026-10-05T10:00:00.000Z',
});

const sent: { readonly expectedRevision: number; readonly submission: TaskFormSubmission }[] = [];
let answer: RevisionedSaveResult = 8;

const mount = () =>
  Effect.gen(function* mountDialog() {
    yield* pinTestDocument;
    const closed: string[] = [];
    yield* mountInRoute(
      <TaskFormDialog
        actorName={(principalId) => principalId}
        assignmentAvailable={false}
        busy={false}
        customers={[]}
        customersLoading={false}
        error={undefined}
        lookupAccess={undefined}
        onClose={() => {
          closed.push('close');
        }}
        onCreate={() =>
          Effect.sync(() => {
            closed.push('create');
            return 'failed' as const;
          })
        }
        onSaveEdit={(submission, expectedRevision) =>
          Effect.sync(() => {
            sent.push({ expectedRevision, submission });
            return answer;
          })
        }
        opportunities={[]}
        opportunitiesLoading={false}
        principalNames={new Map()}
        principals={[]}
        revision={7}
        task={task}
      />,
      { path: 'ukoly', url: '/cs/ukoly' },
    );
    return { closed, unmount: unmountAll };
  });

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return Option.getOrThrow(Option.fromUndefinedOr(found));
};

const titleField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="task-title"]')));

/** Types like a user: React sees a native input event, then the field loses focus. */
const typeTitle = (value: string) =>
  acted(() => {
    const field = titleField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });

const click = (target: HTMLElement) => acted(() => target.click());

const saveState = () => document.querySelector<HTMLElement>('[data-save-state]')?.dataset.saveState;

beforeEach(() => {
  sent.length = 0;
  answer = 8;
});

afterEach(unmountAll);

describe('task edit panel with one Save button', () => {
  it.live('typing changes only the draft: nothing is sent after a pause, a blur or unmount', () =>
    Effect.gen(function* typingSendsNothing() {
      const view = yield* mount();
      expect(buttons('Uložit')).toHaveLength(1);
      expect(button('Uložit').disabled).toBe(true);
      expect(text()).not.toMatch(/automat/iu);

      yield* typeTitle('Saved task, revised');
      expect(button('Uložit').disabled).toBe(false);
      expect(text()).toContain('Neuložené změny');
      // Longer than any debounce the panel ever had.
      yield* Effect.sleep('1 second');
      yield* settle;
      view.unmount();
      yield* settle;
      expect(sent).toEqual([]);
    }),
  );

  it.live('one click on Save sends one edit against the panel revision and shows it saved', () =>
    Effect.gen(function* saveOnce() {
      yield* mount();
      yield* typeTitle('Saved task, revised');
      yield* click(button('Uložit'));
      yield* waitUntil(() => text().includes('Uloženo'));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.expectedRevision).toBe(7);
      expect(sent[0]?.submission.title).toBe('Saved task, revised');
      expect(button('Uložit').disabled).toBe(true);
    }),
  );

  it.live('an empty title cannot be saved', () =>
    Effect.gen(function* invalid() {
      yield* mount();
      yield* typeTitle(' ');
      expect(saveState()).toBe('invalid');
      expect(button('Uložit').disabled).toBe(true);
      expect(sent).toEqual([]);
    }),
  );

  it.live('closing with unsaved changes asks; Zůstat keeps the draft, Zahodit změny closes without sending', () =>
    Effect.gen(function* leave() {
      const view = yield* mount();
      yield* typeTitle('Saved task, revised');
      yield* click(button(closeLabel));
      expect(buttons('Zahodit změny')).toHaveLength(1);
      expect(view.closed).toEqual([]);

      yield* click(button('Zůstat'));
      yield* waitUntil(() => buttons('Zůstat').length === 0);
      expect(titleField().value).toBe('Saved task, revised');

      yield* click(button(closeLabel));
      yield* click(button('Zahodit změny'));
      expect(view.closed).toEqual(['close']);
      expect(sent).toEqual([]);
    }),
  );

  it.live('Uložit in the question saves once and then closes', () =>
    Effect.gen(function* saveAndLeave() {
      const view = yield* mount();
      yield* typeTitle('Saved task, revised');
      yield* click(button(closeLabel));
      // The question's own Save button is the last one: the dialog renders after the panel.
      const inDialog = buttons('Uložit').at(-1);
      expect(inDialog).toBeDefined();
      yield* click(Option.getOrThrow(Option.fromUndefinedOr(inDialog)));
      yield* waitUntil(() => view.closed.length === 1);
      expect(sent).toHaveLength(1);
    }),
  );

  it.live('a revision conflict holds the draft and offers the current version', () =>
    Effect.gen(function* conflict() {
      answer = 'conflict';
      yield* mount();
      yield* typeTitle('Saved task, revised');
      yield* click(button('Uložit'));
      yield* waitUntil(() => saveState() === 'conflict');
      expect(buttons('Načíst aktuální verzi')).toHaveLength(1);
      expect(sent).toHaveLength(1);
    }),
  );
});
