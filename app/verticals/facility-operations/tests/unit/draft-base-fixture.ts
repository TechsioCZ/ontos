// Shared harness of the sales quote revision test: a fake agenda whose revision and last change of the edited record
// the owner's endpoint double checks, and the user's typing and clicks on the mounted panel.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option } from 'effect';
import { constVoid } from 'effect/Function';
import { act } from 'react';
import type { OpsCommand } from '../../shared/agendas.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

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

/** One React update, flushed: `change` runs inside `act`, then the browser runtime gets a turn. */
const flush = (change: () => void): Effect.Effect<void> =>
  Effect.promise(async () => {
    await act(async () => {
      change();
      await browserRuntime.runPromise(Effect.yieldNow);
    });
  });

/** The panel's callbacks to its page (closed, saved): the tests do not act on them. */
export const toPage: (value?: string) => void = constVoid;

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

export const bodyText = (): string => document.body.textContent;
