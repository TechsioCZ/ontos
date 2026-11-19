// @rstest-environment happy-dom
// Task creation maps the entered title and domain defaults at the component boundary.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { pinTestDocument } from '@app/shared-contracts/testing/http-double';
import { Effect, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { TaskFormDialog } from '../../src/routes/[lang]/ukoly/task-form-dialog.tsx';
import type { TaskFormSubmission } from '../../src/routes/[lang]/ukoly/task-form-dialog.tsx';
import { mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const copy = { title: 'Zavolat klientovi' } as const;

const created: TaskFormSubmission[] = [];

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
            return 'saved' as const;
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

const click = (target: HTMLElement) =>
  acted(() => {
    target.click();
  });

beforeEach(() => {
  created.length = 0;
});

afterEach(unmountAll);

describe('task create panel with the shared Uložit', () => {
  it.live('submits the typed task title with normal priority and an empty description', () =>
    Effect.gen(function* createOnce() {
      const view = yield* mount();
      yield* typeTitle(copy.title);
      yield* click(button(labels.save));
      yield* waitUntil(() => view.closed.length === 1);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ description: '', priority: 'NORMAL', title: copy.title });
      expect(view.closed).toEqual(['close']);
    }),
  );
});
