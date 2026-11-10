// Shared harness of the facility edit-panel revision tests: a fake agenda that refuses a save built on a revision
// older than the last change to the record, page runners that send the revision of the read they were rendered
// with (like `useAgendaRecords`), and a mounted React root driven the way a user drives it.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option } from 'effect';
import { constVoid } from 'effect/Function';
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { OpsCommand } from '../../shared/agendas.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import type { CommandOutcome } from '../../src/ui/use-agenda.ts';

export const labels = saveLabelsFor('cs');

/** The agenda behind the page runners: its revision and the revision at which the edited record last changed. */
export interface FakeAgenda {
  readonly applied: { readonly command: OpsCommand; readonly expectedRevision: number }[];
  recordRevision: number;
  revision: number;
}

export const agendaAt = (revision: number): FakeAgenda => ({ applied: [], recordRevision: revision, revision });

/** Someone else changes the edited record: the agenda and the record move to a new revision. */
export const changeElsewhere = (agenda: FakeAgenda): void => {
  agenda.revision += 1;
  agenda.recordRevision = agenda.revision;
};

/** The page runner of one read at `revision`: a save on an older revision than the record's last change is refused. */
export const runnerAt =
  (agenda: FakeAgenda, revision: number) =>
  (command: OpsCommand): Effect.Effect<CommandOutcome> =>
    Effect.sync((): CommandOutcome => {
      agenda.applied.push({ command, expectedRevision: revision });
      if (revision < agenda.recordRevision) {
        return { ok: false, reason: 'conflict' };
      }
      agenda.revision += 1;
      agenda.recordRevision = agenda.revision;
      return { ok: true, result: { entityIds: [], revision: agenda.revision } };
    });

/** One React update, flushed: `change` runs inside `act`, then the browser runtime gets a turn. */
const flush = (change: () => void): Effect.Effect<void> =>
  Effect.promise(async () => {
    await act(async () => {
      change();
      await browserRuntime.runPromise(Effect.yieldNow);
    });
  });

/** The panel's callbacks to its page (closed, saved): recorded, the tests do not act on them. */
export const pageCalls: (string | undefined)[] = [];
export const toPage = (value?: string): void => {
  pageCalls.push(value);
};

const mounted: Root[] = [];
const containers: HTMLElement[] = [];

/** One mounted panel: `render` replaces its props the way a fresh page read does. */
export interface MountedPanel {
  readonly render: (element: ReactElement) => Effect.Effect<void>;
}

export const mountPanel = Effect.fnUntraced(function* mountPanel(element: ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  mounted.push(root);
  const panel: MountedPanel = {
    render: (next) =>
      flush(() => {
        root.render(next);
      }),
  };
  yield* panel.render(element);
  return panel;
});

export const unmountPanels = (): void => {
  for (const root of mounted) {
    act(() => {
      root.unmount();
    });
  }
  mounted.length = 0;
  for (const container of containers) {
    container.remove();
  }
  containers.length = 0;
  pageCalls.length = 0;
};

const buttonNamed = (text: string): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...document.body.querySelectorAll('button')].find((button) => button.textContent.trim() === text),
    ),
  );

const fieldOf = (selector: string): HTMLInputElement | HTMLTextAreaElement =>
  Option.getOrThrow(Option.fromNullOr(document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)));

/** Types `value` into the text field matched by `selector`, through React's own change tracking. */
export const typeInto = (selector: string, value: string): Effect.Effect<void> =>
  flush(() => {
    const field = fieldOf(selector);
    Reflect.set(Object.getPrototypeOf(field), 'value', value, field);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

export const fieldValue = (selector: string): string => fieldOf(selector).value;

export const click = (text: string): Effect.Effect<void> =>
  flush(() => {
    buttonNamed(text).click();
  });

/** Gives the panel turns until `condition` holds (at most 200). */
const waitUntil = (condition: () => boolean): Effect.Effect<void> =>
  flush(constVoid).pipe(Effect.repeat({ times: 200, until: condition }), Effect.andThen(flush(constVoid)));

/** Clicks Uložit and waits until the agenda answered `count` saves in total. */
export const save = (agenda: FakeAgenda, count: number): Effect.Effect<void> =>
  click(labels.save).pipe(Effect.andThen(waitUntil(() => agenda.applied.length >= count)));

export const bodyText = (): string => document.body.textContent;
