// Shared harness of the facility form-save tests: a recording command runner and the questions a test asks the
// mounted form (is Uložit enabled, is the leave question up). Mounting and typing come from `draft-base-fixture.ts`.
import { Effect, Option, Schema } from 'effect';
import { EntityIdSchema } from '../../shared/domain/common.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import type { CommandOutcome, FailureReason } from '../../src/ui/use-agenda.ts';
import { act } from 'react';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { click, labels } from './draft-base-fixture.ts';

/** The id every created record gets in these tests. */
export const createdId = Schema.decodeSync(EntityIdSchema)('created-1');

/** The commands a form sent, answered with `answers` in turn (then with success). */
export interface RecordingRunner {
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
  readonly sent: OpsCommand[];
}

export const recordingRunner = (
  answers: readonly FailureReason[] = [],
  entityIds: readonly (typeof EntityIdSchema.Type)[] = [createdId],
): RecordingRunner => {
  const sent: OpsCommand[] = [];
  const pending = [...answers];
  return {
    run: (command) =>
      Effect.sync((): CommandOutcome => {
        sent.push(command);
        const refusal = pending.shift();
        return refusal === undefined
          ? { ok: true, result: { entityIds, revision: sent.length + 1 } }
          : { ok: false, reason: refusal };
      }),
    sent,
  };
};

const buttonsNamed = (text: string): HTMLButtonElement[] =>
  [...document.body.querySelectorAll('button')].filter((button) => button.textContent.trim() === text);

/** The footer's Uložit (the first one; the leave question has its own). */
export const saveButton = (): HTMLButtonElement =>
  Option.getOrThrow(Option.fromUndefinedOr(buttonsNamed(labels.save)[0]));

/** Whether the leave question (Uložit / Zahodit změny / Zůstat) is on screen. */
export const leaveQuestionOpen = (): boolean => buttonsNamed(labels.discard).length > 0;

/** Gives the form turns (inside `act`) until `condition` holds, at most 200. */
export const settleUntil = (condition: () => boolean): Effect.Effect<void> =>
  Effect.promise(async () => {
    await act(async () => {
      await browserRuntime.runPromise(Effect.yieldNow);
    });
  }).pipe(Effect.repeat({ times: 200, until: condition }));

/** Clicks the footer's Uložit and waits until the runner got `count` commands in total, and their answers landed. */
export const saveSent = (runner: RecordingRunner, count: number): Effect.Effect<void> =>
  click(labels.save).pipe(
    Effect.andThen(settleUntil(() => runner.sent.length >= count)),
    Effect.andThen(settleUntil(() => saveButton().textContent.trim() === labels.save)),
  );

/** Picks `value` in the select named `name`, through the native select the select component keeps in sync. */
export const pick = (name: string, value: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    await act(async () => {
      const select = Option.getOrThrow(
        Option.fromNullOr(document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)),
      );
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await browserRuntime.runPromise(Effect.yieldNow);
    });
  });
