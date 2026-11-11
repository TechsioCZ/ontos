// @rstest-environment happy-dom
// The task create panel as the user sees it: the shared Save button ("Uložit") last in the footer creates the task
// once, Enter in the title sends nothing, an untouched panel closes without asking, and typed input asks first. Only
// the i18n runtime and the router blocker are replaced; the page's create is a recorded function.
import { saveLabelsFor } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Effect, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TaskFormDialog } from '../../src/routes/[lang]/ukoly/task-form-dialog.tsx';
import type { TaskFormSubmission } from '../../src/routes/[lang]/ukoly/task-form-dialog.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));

const labels = saveLabelsFor('cs');
const copy = { cancel: 'work-tasks.pages.records.cancel', title: 'Zavolat klientovi' } as const;

const created: TaskFormSubmission[] = [];
let answer: SaveOutcome = 'saved';

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
    );
    await settle();
  });
  const view: View = {
    closed,
    unmount: () => {
      act(() => {
        root.unmount();
        container.remove();
      });
    },
  };
  views.push(view);
  return view;
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const button = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));

const titleField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="task-title"]')));

const typeTitle = async (value: string) => {
  await act(async () => {
    const field = titleField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  });
};

const pressEnter = async () => {
  await act(async () => {
    titleField().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
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

const saveState = () => document.querySelector<HTMLElement>('[data-save-state]')?.dataset.saveState;

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  created.length = 0;
  answer = 'saved';
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.unmount();
  }
  rstest.unstubAllGlobals();
});

describe('task create panel with the shared Uložit', () => {
  it.effect('Uložit is the one primary button, last in the footer, and creates the task once', () =>
    Effect.gen(function* createOnce() {
      const view = yield* Effect.promise(mount);
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);
      const footer = Option.getOrThrow(Option.fromNullishOr(button(labels.save).closest('[data-save-state]')));
      expect(footer.nextElementSibling).toBeNull();

      yield* Effect.promise(() => typeTitle(copy.title));
      yield* Effect.promise(pressEnter);
      expect(created).toEqual([]);

      yield* Effect.promise(() => click(button(labels.save)));
      yield* Effect.promise(() => waitUntil(() => view.closed.length === 1));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ description: '', priority: 'NORMAL', title: copy.title });
      expect(view.closed).toEqual(['close']);
    }),
  );

  it.effect('an untouched panel closes without asking', () =>
    Effect.gen(function* untouched() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => click(button(copy.cancel)));
      expect(buttons(labels.discard)).toHaveLength(0);
      expect(view.closed).toEqual(['close']);
    }),
  );

  it.effect('typed input asks before leaving; Zahodit změny leaves without creating', () =>
    Effect.gen(function* leave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeTitle(copy.title));
      yield* Effect.promise(() => click(button(copy.cancel)));
      expect(buttons(labels.discard)).toHaveLength(1);
      expect(view.closed).toEqual([]);

      yield* Effect.promise(() => click(button(labels.discard)));
      expect(view.closed).toEqual(['close']);
      expect(created).toEqual([]);
    }),
  );

  it.effect('a refused create keeps the typed input and the panel open', () =>
    Effect.gen(function* refused() {
      answer = 'failed';
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeTitle(copy.title));
      yield* Effect.promise(() => click(button(labels.save)));
      yield* Effect.promise(() => waitUntil(() => saveState() === 'error'));
      expect(created).toHaveLength(1);
      expect(titleField().value).toBe(copy.title);
      expect(view.closed).toEqual([]);
    }),
  );
});
