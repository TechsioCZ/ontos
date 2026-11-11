// @rstest-environment happy-dom
// The task edit panel as the user sees it: one Save button in the panel footer, the draft's status next to it, and a
// question before unsaved changes are left. Only the i18n runtime and the router blocker are replaced; the page's
// save is a recorded function.
import type { RevisionedSaveResult } from '@app/admin-ui';
import { requiredLabelFor } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TaskSchema } from '../../shared/apis/records.ts';
import { TaskFormDialog } from '../../src/routes/[lang]/ukoly/task-form-dialog.tsx';
import type { TaskFormSubmission } from '../../src/routes/[lang]/ukoly/task-form-dialog.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));

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

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

interface View {
  readonly closed: string[];
  readonly unmount: () => void;
}

const views: View[] = [];

const mount = async (): Promise<View> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const closed: string[] = [];
  await act(async () => {
    root.render(
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
    );
    await settle();
  });
  let live = true;
  const view: View = {
    closed,
    unmount: () => {
      if (live) {
        live = false;
        act(() => {
          root.unmount();
          container.remove();
        });
      }
    },
  };
  views.push(view);
  return view;
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const titleField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="task-title"]')));

/** Types like a user: React sees a native input event, then the field loses focus. */
const typeTitle = async (value: string) => {
  await act(async () => {
    const field = titleField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await settle();
  });
};

const click = async (target: HTMLElement) => {
  await act(async () => {
    target.click();
    await settle();
  });
};

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

const text = () => document.body.textContent ?? '';

const saveState = () => document.querySelector<HTMLElement>('[data-save-state]')?.dataset.saveState;

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sent.length = 0;
  answer = 8;
});

afterEach(() => {
  for (const view of views) {
    view.unmount();
  }
  views.length = 0;
  rstest.unstubAllGlobals();
});

describe('task edit panel with one Save button', () => {
  it.live('typing changes only the draft: nothing is sent after a pause, a blur or unmount', () =>
    Effect.gen(function* typingSendsNothing() {
      const view = yield* Effect.promise(mount);
      expect(buttons('Uložit')).toHaveLength(1);
      expect(button('Uložit').disabled).toBe(true);
      expect(text()).not.toMatch(/automat/iu);

      yield* Effect.promise(() => typeTitle('Saved task, revised'));
      expect(button('Uložit').disabled).toBe(false);
      expect(text()).toContain('Neuložené změny');
      // Longer than any debounce the panel ever had.
      yield* Effect.sleep('1 second');
      yield* Effect.promise(() => act(settle));
      view.unmount();
      yield* Effect.promise(() => act(settle));
      expect(sent).toEqual([]);
    }),
  );

  it.effect('one click on Save sends one edit against the panel revision and shows it saved', () =>
    Effect.gen(function* saveOnce() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeTitle('Saved task, revised'));
      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => text().includes('Uloženo')));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.expectedRevision).toBe(7);
      expect(sent[0]?.submission.title).toBe('Saved task, revised');
      expect(button('Uložit').disabled).toBe(true);
    }),
  );

  it.effect('an empty title cannot be saved', () =>
    Effect.gen(function* invalid() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeTitle(' '));
      expect(saveState()).toBe('invalid');
      expect(button('Uložit').disabled).toBe(true);
      expect(sent).toEqual([]);
    }),
  );

  it.effect('closing with unsaved changes asks; Zůstat keeps the draft, Zahodit změny closes without sending', () =>
    Effect.gen(function* leave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeTitle('Saved task, revised'));
      yield* Effect.promise(() => click(button('work-tasks.pages.records.close')));
      expect(buttons('Zahodit změny')).toHaveLength(1);
      expect(view.closed).toEqual([]);

      yield* Effect.promise(() => click(button('Zůstat')));
      yield* Effect.promise(() => waitUntil(() => buttons('Zůstat').length === 0));
      expect(titleField().value).toBe('Saved task, revised');

      yield* Effect.promise(() => click(button('work-tasks.pages.records.close')));
      yield* Effect.promise(() => click(button('Zahodit změny')));
      expect(view.closed).toEqual(['close']);
      expect(sent).toEqual([]);
    }),
  );

  it.effect('Uložit in the question saves once and then closes', () =>
    Effect.gen(function* saveAndLeave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeTitle('Saved task, revised'));
      yield* Effect.promise(() => click(button('work-tasks.pages.records.close')));
      // The question's own Save button is the last one: the dialog renders after the panel.
      const inDialog = buttons('Uložit').at(-1);
      expect(inDialog).toBeDefined();
      yield* Effect.promise(() => click(inDialog ?? document.createElement('button')));
      yield* Effect.promise(() => waitUntil(() => view.closed.length === 1));
      expect(sent).toHaveLength(1);
    }),
  );

  it.effect('a revision conflict holds the draft and offers the current version', () =>
    Effect.gen(function* conflict() {
      answer = 'conflict';
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeTitle('Saved task, revised'));
      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => saveState() === 'conflict'));
      expect(buttons('Načíst aktuální verzi')).toHaveLength(1);
      expect(sent).toHaveLength(1);
    }),
  );

  it.effect('reads the required text of a required field in Czech', () =>
    Effect.gen(function* requiredText() {
      yield* Effect.promise(mount);
      expect(titleField().labels?.[0]?.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
    }),
  );
});
