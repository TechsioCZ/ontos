import { Deferred, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { startAutosave } from '../../src/autosave.ts';
import type { AutosaveOutcome } from '../../src/autosave.ts';

interface Draft {
  readonly name: string;
}

const draft = (name: string): Draft => ({ name });

/** A controller whose saves wait until the test replies to them. */
const setup = Effect.fnUntraced(function* setup() {
  const sent: string[] = [];
  const replies: Deferred.Deferred<AutosaveOutcome>[] = [];
  const options = {
    isValid: (value: Draft) => value.name.trim() !== '',
    save: (value: Draft) =>
      Effect.suspend(() => {
        sent.push(value.name);
        const reply = Deferred.makeUnsafe<AutosaveOutcome>();
        replies.push(reply);
        return Deferred.await(reply);
      }),
  };
  const controller = yield* startAutosave(draft('Before'), options);
  /** What the hook's `adopt` does: a fresh controller from the server version. */
  const restart = (name: string) => startAutosave(draft(name), options);
  const reply = Effect.fnUntraced(function* answer(index: number, outcome: AutosaveOutcome) {
    const pending = replies[index];
    expect(pending).toBeDefined();
    if (pending !== undefined) {
      yield* Deferred.succeed(pending, outcome);
    }
    yield* Effect.yieldNow;
  });
  return { controller, reply, restart, sent };
});

describe('autosave', () => {
  it.effect('sends the draft 800 ms after the last change', () =>
    Effect.gen(function* debounce() {
      const { controller, reply, sent } = yield* setup();
      controller.change(draft('Af'));
      yield* TestClock.adjust('500 millis');
      controller.change(draft('After'));
      expect(controller.status()).toBe('dirty');
      yield* TestClock.adjust('799 millis');
      expect(sent).toEqual([]);
      yield* TestClock.adjust('1 millis');
      expect(sent).toEqual(['After']);
      expect(controller.status()).toBe('saving');
      yield* reply(0, 'saved');
      expect(controller.status()).toBe('saved');
      yield* TestClock.adjust('3 seconds');
      expect(controller.status()).toBe('idle');
    }),
  );

  it.effect('flushes on blur without waiting and never resends an unchanged draft', () =>
    Effect.gen(function* blur() {
      const { controller, reply, sent } = yield* setup();
      controller.flush();
      expect(sent).toEqual([]);
      controller.change(draft('After'));
      controller.flush();
      expect(sent).toEqual(['After']);
      yield* reply(0, 'saved');
      controller.flush();
      yield* TestClock.adjust('1 second');
      expect(sent).toEqual(['After']);
    }),
  );

  it.effect('keeps an invalid draft local and a reverted draft quiet', () =>
    Effect.gen(function* invalid() {
      const { controller, sent } = yield* setup();
      controller.change(draft(' '));
      expect(controller.status()).toBe('invalid');
      controller.flush();
      yield* TestClock.adjust('1 second');
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('invalid');
      controller.change(draft('Before'));
      expect(controller.status()).toBe('idle');
      yield* TestClock.adjust('1 second');
      expect(sent).toEqual([]);
    }),
  );

  it.effect('shows a failed save as an error and sends the same draft again on retry', () =>
    Effect.gen(function* failure() {
      const { controller, reply, sent } = yield* setup();
      controller.change(draft('After'));
      controller.flush();
      yield* reply(0, 'failed');
      expect(controller.status()).toBe('error');
      yield* TestClock.adjust('1 second');
      expect(sent).toEqual(['After']);
      controller.retry();
      expect(sent).toEqual(['After', 'After']);
      yield* reply(1, 'saved');
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('stops on a conflict until the server version is loaded', () =>
    Effect.gen(function* conflict() {
      const { controller, reply, restart, sent } = yield* setup();
      controller.change(draft('Mine'));
      controller.flush();
      yield* reply(0, 'conflict');
      expect(controller.status()).toBe('conflict');
      controller.change(draft('Mine again'));
      controller.flush();
      controller.retry();
      yield* TestClock.adjust('1 second');
      expect(sent).toEqual(['Mine']);
      controller.dispose();
      const reloaded = yield* restart('Theirs');
      expect(reloaded.status()).toBe('idle');
      reloaded.change(draft('Theirs'));
      controller.flush();
      yield* TestClock.adjust('1 second');
      expect(sent).toEqual(['Mine']);
      reloaded.change(draft('Theirs, edited'));
      reloaded.flush();
      expect(sent).toEqual(['Mine', 'Theirs, edited']);
      yield* reply(1, 'saved');
      expect(reloaded.status()).toBe('saved');
    }),
  );

  it.effect('queues one follow-up save with the newest draft while a save runs', () =>
    Effect.gen(function* queued() {
      const { controller, reply, sent } = yield* setup();
      controller.change(draft('One'));
      controller.flush();
      controller.change(draft('Two'));
      controller.change(draft('Three'));
      controller.flush();
      yield* TestClock.adjust('1 second');
      expect(sent).toEqual(['One']);
      expect(controller.status()).toBe('saving');
      yield* reply(0, 'saved');
      expect(sent).toEqual(['One', 'Three']);
      expect(controller.status()).toBe('saving');
      yield* reply(1, 'saved');
      expect(controller.status()).toBe('saved');
      expect(sent).toEqual(['One', 'Three']);
    }),
  );

  it.effect('drops a pending change once disposed', () =>
    Effect.gen(function* disposed() {
      const { controller, reply, sent } = yield* setup();
      controller.change(draft('Running'));
      controller.flush();
      controller.change(draft('Pending'));
      controller.dispose();
      yield* reply(0, 'saved');
      yield* TestClock.adjust('1 second');
      controller.flush();
      expect(sent).toEqual(['Running']);
    }),
  );

  it.effect('notifies subscribers only when the status changes', () =>
    Effect.gen(function* notifications() {
      const { controller, reply } = yield* setup();
      const seen: string[] = [];
      const unsubscribe = controller.subscribe(() => {
        seen.push(controller.status());
      });
      controller.change(draft('A'));
      controller.change(draft('AB'));
      controller.flush();
      yield* reply(0, 'saved');
      unsubscribe();
      expect(seen).toEqual(['dirty', 'saving', 'saved']);
    }),
  );
});
