import { ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import { Effect, Exit, Fiber, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  SHELL_SEARCH_REQUEST_BUDGET_MILLIS,
  withShellSearchRequestBudget,
} from '../../api/modules/shell-governed-search.ts';
import { ShellProviderUnavailableError } from '../../api/modules/shell-resources.ts';

const unavailable = () => new ShellProviderUnavailableError({});
const readUnavailable = () =>
  new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Shell search is temporarily unavailable' });
const stageMillis = SHELL_SEARCH_REQUEST_BUDGET_MILLIS * 0.6;

it.effect('one governed request bounds sequential business and People work without renewing the budget', () =>
  Effect.gen(function* sharedDeadline() {
    const completed: string[] = [];
    const stage = (name: string) =>
      withShellSearchRequestBudget(
        Effect.sleep(stageMillis).pipe(Effect.andThen(Effect.sync(() => completed.push(name)))),
        unavailable,
      );
    const pending = yield* withShellSearchRequestBudget(
      stage('business').pipe(Effect.andThen(stage('People'))),
      readUnavailable,
    ).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(SHELL_SEARCH_REQUEST_BUDGET_MILLIS);
    expect(Schema.is(ReadHandlerUnavailable)(yield* Fiber.join(pending))).toBe(true);
    expect(completed).toEqual(['business']);
    // No late success may escape after cancellation of the unfinished stage.
    yield* TestClock.adjust(SHELL_SEARCH_REQUEST_BUDGET_MILLIS);
    expect(completed).toEqual(['business']);
  }),
);

it.effect('queued fan-out waves consume the same request budget as the first wave', () =>
  Effect.gen(function* queuedFanOut() {
    const completed: number[] = [];
    const pending = yield* withShellSearchRequestBudget(
      Effect.forEach(
        [0, 1, 2, 3, 4, 5, 6, 7],
        (provider) =>
          withShellSearchRequestBudget(
            Effect.sleep(stageMillis).pipe(Effect.andThen(Effect.sync(() => completed.push(provider)))),
            unavailable,
          ),
        { concurrency: 4 },
      ),
      readUnavailable,
    ).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(SHELL_SEARCH_REQUEST_BUDGET_MILLIS);
    expect(Schema.is(ReadHandlerUnavailable)(yield* Fiber.join(pending))).toBe(true);
    expect(completed.toSorted((left, right) => left - right)).toEqual([0, 1, 2, 3]);
  }),
);

it.effect('a deadline interrupts outstanding work before reporting its typed failure', () =>
  Effect.gen(function* interruptTimedOutWork() {
    let interrupted = false;
    const pending = yield* withShellSearchRequestBudget(
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
      unavailable,
    ).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(SHELL_SEARCH_REQUEST_BUDGET_MILLIS);
    expect(Schema.is(ShellProviderUnavailableError)(yield* Fiber.join(pending))).toBe(true);
    expect(interrupted).toBe(true);
  }),
);

it.effect('independent requests get independent budgets and genuine complete empty collections stay successful', () =>
  Effect.gen(function* independentRequests() {
    for (const _request of [1, 2]) {
      const pending = yield* withShellSearchRequestBudget(
        Effect.sleep(stageMillis).pipe(Effect.as({ partial: false, results: [] })),
        unavailable,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(stageMillis);
      expect(yield* Fiber.join(pending)).toEqual({ partial: false, results: [] });
    }
  }),
);

it.effect('a fast unavailable or permission failure keeps its original cause instead of becoming empty success', () =>
  Effect.gen(function* genuineFailures() {
    const outage = unavailable();
    const denied = new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'The search was refused' });
    expect(yield* withShellSearchRequestBudget(Effect.fail(outage), readUnavailable).pipe(Effect.flip)).toBe(outage);
    expect(yield* withShellSearchRequestBudget(Effect.fail(denied), readUnavailable).pipe(Effect.flip)).toBe(denied);
  }),
);

it.effect('caller cancellation stays interruption, not a successful placeholder', () =>
  Effect.gen(function* callerCancellation() {
    const pending = yield* withShellSearchRequestBudget(Effect.never, unavailable).pipe(Effect.forkChild);
    yield* Fiber.interrupt(pending);
    expect(Exit.isFailure(yield* Fiber.join(pending).pipe(Effect.exit))).toBe(true);
  }),
);
