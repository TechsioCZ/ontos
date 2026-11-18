// @rstest-environment happy-dom
// The task create panel as the user sees it: the shared Save button ("Uložit") last in the footer creates the task
// once, Enter in the title sends nothing, an untouched panel closes without asking, and typed input asks first.
// The module's real i18n and router run around the panel; its create callback records submissions.
import { saveLabelsFor } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { pinTestDocument } from '@app/shared-contracts/testing/http-double';
import { Effect, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { TaskFormDialog } from '../../src/routes/[lang]/ukoly/task-form-dialog.tsx';
import type { TaskFormSubmission } from '../../src/routes/[lang]/ukoly/task-form-dialog.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const copy = { cancel: moduleText('cs')('work-tasks.pages.records.cancel'), title: 'Zavolat klientovi' } as const;

const created: TaskFormSubmission[] = [];
let answer: SaveOutcome = 'saved';

const mount = () =>
  Effect.gen(function* mountPanel() {
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
        onCreate={(submission) =>
          Effect.sync(() => {
            created.push(submission);
            return answer;
          })
        }
        onSaveEdit={() => Effect.succeed('failed' as const)}
        opportunities={[]}
        opportunitiesLoading={false}
        principalNames={new Map()}
        principals={[]}
        revision={7}
        task={undefined}
      />,
      { path: 'ukoly', url: '/cs/ukoly' },
    );
    return { closed };
  });

const button = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));

const titleField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="task-title"]')));

const typeTitle = (value: string) =>
  acted(() => {
    const field = titleField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

const pressEnter = () =>
  acted(() => {
    titleField().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  });

const click = (target: HTMLElement) =>
  acted(() => {
    target.click();
  });

const saveState = () => document.querySelector<HTMLElement>('[data-save-state]')?.dataset.saveState;

beforeEach(() => {
  created.length = 0;
  answer = 'saved';
});

afterEach(unmountAll);

describe('task create panel with the shared Uložit', () => {
  it.live('Uložit is the one primary button, last in the footer, and creates the task once', () =>
    Effect.gen(function* createOnce() {
      const view = yield* mount();
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);
      const footer = Option.getOrThrow(Option.fromNullishOr(button(labels.save).closest('[data-save-state]')));
      expect(footer.nextElementSibling).toBeNull();

      yield* typeTitle(copy.title);
      yield* pressEnter();
      expect(created).toEqual([]);

      yield* click(button(labels.save));
      yield* waitUntil(() => view.closed.length === 1);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ description: '', priority: 'NORMAL', title: copy.title });
      expect(view.closed).toEqual(['close']);
    }),
  );

  it.live('an untouched panel closes without asking', () =>
    Effect.gen(function* untouched() {
      const view = yield* mount();
      yield* click(button(copy.cancel));
      expect(buttons(labels.discard)).toHaveLength(0);
      expect(view.closed).toEqual(['close']);
    }),
  );

  it.live('typed input asks before leaving; Zahodit změny leaves without creating', () =>
    Effect.gen(function* leave() {
      const view = yield* mount();
      yield* typeTitle(copy.title);
      yield* click(button(copy.cancel));
      expect(buttons(labels.discard)).toHaveLength(1);
      expect(view.closed).toEqual([]);

      yield* click(button(labels.discard));
      expect(view.closed).toEqual(['close']);
      expect(created).toEqual([]);
    }),
  );

  it.live('a refused create keeps the typed input and the panel open', () =>
    Effect.gen(function* refused() {
      answer = 'failed';
      const view = yield* mount();
      yield* typeTitle(copy.title);
      yield* click(button(labels.save));
      yield* waitUntil(() => saveState() === 'error');
      expect(created).toHaveLength(1);
      expect(titleField().value).toBe(copy.title);
      expect(view.closed).toEqual([]);
    }),
  );
});
