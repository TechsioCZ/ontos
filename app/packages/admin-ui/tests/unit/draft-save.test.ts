import { Deferred, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { draftPending, draftSavable, draftUnsaved, startDraftSave } from '../../src/draft-save.ts';
import type { SaveOutcome } from '../../src/draft-save.ts';

interface Draft {
  readonly name: string;
}

const draft = (name: string): Draft => ({ name });

/** A controller whose saves wait until the test replies to them. */
const setup = Effect.fnUntraced(function* setup() {
  const sent: string[] = [];
  const replies: Deferred.Deferred<SaveOutcome>[] = [];
  const options = {
    isValid: (value: Draft) => value.name.trim() !== '',
    save: (value: Draft) =>
      Effect.suspend(() => {
        sent.push(value.name);
        const reply = Deferred.makeUnsafe<SaveOutcome>();
        replies.push(reply);
        return Deferred.await(reply);
      }),
  };
  const controller = yield* startDraftSave(draft('Before'), options);
  /** What the hook's `adopt` does: a fresh controller from the server version. */
  const restart = (name: string) => startDraftSave(draft(name), options);
  const reply = Effect.fnUntraced(function* answer(index: number, outcome: SaveOutcome) {
    const pending = replies[index];
    expect(pending).toBeDefined();
    if (pending !== undefined) {
      yield* Deferred.succeed(pending, outcome);
    }
    yield* Effect.yieldNow;
  });
  return { controller, reply, restart, sent };
});

describe('explicit draft save', () => {
  it.effect('never sends a changed draft by itself, however long it waits', () =>
    Effect.gen(function* noTimer() {
      const { controller, sent } = yield* setup();
      controller.change(draft('Af'));
      yield* TestClock.adjust('800 millis');
      controller.change(draft('After'));
      expect(controller.status()).toBe('dirty');
      yield* TestClock.adjust('1 hour');
      yield* Effect.yieldNow;
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('dirty');
      // Going away sends nothing either.
      controller.dispose();
      yield* TestClock.adjust('1 hour');
      expect(sent).toEqual([]);
    }),
  );

  it.effect('sends the whole draft once per save() and keeps "saved" until the next change', () =>
    Effect.gen(function* explicit() {
      const { controller, reply, sent } = yield* setup();
      controller.save();
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('idle');
      controller.change(draft('After'));
      controller.save();
      expect(sent).toEqual(['After']);
      expect(controller.status()).toBe('saving');
      // A second click while the save runs sends nothing.
      controller.save();
      expect(sent).toEqual(['After']);
      yield* reply(0, 'saved');
      expect(controller.status()).toBe('saved');
      expect(controller.confirmed()).toEqual(draft('After'));
      // An unchanged draft is not sent again, and the status does not fade on its own.
      controller.save();
      yield* TestClock.adjust('1 hour');
      expect(sent).toEqual(['After']);
      expect(controller.status()).toBe('saved');
      controller.change(draft('After all'));
      expect(controller.status()).toBe('dirty');
    }),
  );

  it.effect('tells a draft that can be saved from an unchanged or invalid one', () =>
    Effect.gen(function* savable() {
      const { controller, sent } = yield* setup();
      const read = () => {
        const status = controller.status();
        return { savable: draftSavable(status), unsaved: draftUnsaved(status) };
      };
      expect(read()).toEqual({ savable: false, unsaved: false });
      controller.change(draft('After'));
      expect(read()).toEqual({ savable: true, unsaved: true });
      controller.change(draft(' '));
      expect(controller.status()).toBe('invalid');
      expect(read()).toEqual({ savable: false, unsaved: true });
      controller.save();
      yield* Effect.yieldNow;
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('invalid');
      controller.change(draft('Before'));
      expect(controller.status()).toBe('idle');
      expect(read()).toEqual({ savable: false, unsaved: false });
    }),
  );

  it.effect('validates a draft against the version the server last confirmed', () =>
    Effect.gen(function* confirmedBase() {
      const checked: string[] = [];
      // A rule that depends on what the save would send: a name may only grow from the confirmed one.
      const controller = yield* startDraftSave(draft('Akros'), {
        isValid: (value: Draft, confirmed: Draft) => {
          checked.push(`${value.name} over ${confirmed.name}`);
          return value.name.startsWith(confirmed.name);
        },
        save: () => Effect.succeed('saved' as const),
      });
      controller.change(draft('Akros CZ'));
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('saved');

      // `Akros` was valid over the version the form opened with; over the saved `Akros CZ` it is not.
      controller.change(draft('Akros'));
      expect(controller.status()).toBe('invalid');
      expect(checked.at(-1)).toBe('Akros over Akros CZ');
      controller.save();
      expect(controller.status()).toBe('invalid');
    }),
  );

  it.effect('shows a failed save as an error and sends the same draft again on the next save()', () =>
    Effect.gen(function* failure() {
      const { controller, reply, sent } = yield* setup();
      controller.change(draft('After'));
      controller.save();
      yield* reply(0, 'failed');
      expect(controller.status()).toBe('error');
      expect(draftSavable(controller.status())).toBe(true);
      yield* TestClock.adjust('1 hour');
      expect(sent).toEqual(['After']);
      controller.save();
      expect(sent).toEqual(['After', 'After']);
      yield* reply(1, 'saved');
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('holds a draft parked for approval: save() does not send it again and nothing counts as saved', () =>
    Effect.gen(function* proposed() {
      const { controller, reply, sent } = yield* setup();
      controller.change(draft('After'));
      controller.save();
      yield* reply(0, 'proposed');
      expect(controller.status()).toBe('proposed');
      expect(controller.confirmed()).toEqual(draft('Before'));
      // Handed over: still not the confirmed version, but nothing typed would be lost and nothing can be saved.
      expect(draftPending(controller.status())).toBe(true);
      expect(draftUnsaved(controller.status())).toBe(false);
      expect(draftSavable(controller.status())).toBe(false);
      controller.save();
      yield* TestClock.adjust('1 hour');
      expect(sent).toEqual(['After']);
      // Typing away and back to the proposed draft does not propose it again.
      controller.change(draft('Afte'));
      expect(controller.status()).toBe('dirty');
      controller.change(draft('After'));
      expect(controller.status()).toBe('proposed');
      controller.save();
      yield* Effect.yieldNow;
      expect(sent).toEqual(['After']);
    }),
  );

  it.effect(
    'sends a different draft after a proposal; a committed save clears it, a real failure can be sent again',
    () =>
      Effect.gen(function* afterProposal() {
        const { controller, reply, sent } = yield* setup();
        controller.change(draft('After'));
        controller.save();
        yield* reply(0, 'proposed');
        controller.change(draft('Other'));
        controller.save();
        expect(controller.status()).toBe('saving');
        yield* reply(1, 'failed');
        expect(controller.status()).toBe('error');
        controller.save();
        expect(sent).toEqual(['After', 'Other', 'Other']);
        yield* reply(2, 'saved');
        expect(controller.status()).toBe('saved');
        expect(controller.confirmed()).toEqual(draft('Other'));
        controller.change(draft('After'));
        controller.save();
        expect(sent).toEqual(['After', 'Other', 'Other', 'After']);
        yield* reply(3, 'conflict');
        expect(controller.status()).toBe('conflict');
      }),
  );

  it.effect('stops on a conflict until the server version is loaded', () =>
    Effect.gen(function* conflict() {
      const { controller, reply, restart, sent } = yield* setup();
      controller.change(draft('Mine'));
      controller.save();
      yield* reply(0, 'conflict');
      expect(controller.status()).toBe('conflict');
      expect(draftSavable(controller.status())).toBe(false);
      expect(draftUnsaved(controller.status())).toBe(true);
      controller.change(draft('Mine again'));
      expect(controller.status()).toBe('conflict');
      controller.save();
      yield* TestClock.adjust('1 hour');
      expect(sent).toEqual(['Mine']);
      controller.dispose();
      const reloaded = yield* restart('Theirs');
      expect(reloaded.status()).toBe('idle');
      reloaded.change(draft('Theirs'));
      controller.save();
      expect(sent).toEqual(['Mine']);
      reloaded.change(draft('Theirs, edited'));
      reloaded.save();
      expect(sent).toEqual(['Mine', 'Theirs, edited']);
      yield* reply(1, 'saved');
      expect(reloaded.status()).toBe('saved');
    }),
  );

  it.effect('keeps edits made while a save runs as an unsaved draft instead of sending them', () =>
    Effect.gen(function* editedMeanwhile() {
      const { controller, reply, sent } = yield* setup();
      controller.change(draft('One'));
      controller.save();
      controller.change(draft('Two'));
      controller.change(draft('Three'));
      controller.save();
      expect(sent).toEqual(['One']);
      expect(controller.status()).toBe('saving');
      yield* reply(0, 'saved');
      yield* TestClock.adjust('1 hour');
      // No follow-up save: the newer draft waits for the next click.
      expect(sent).toEqual(['One']);
      expect(controller.status()).toBe('dirty');
      expect(controller.confirmed()).toEqual(draft('One'));
      controller.save();
      expect(sent).toEqual(['One', 'Three']);
      yield* reply(1, 'saved');
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('discard goes back to the confirmed version and clears an error or a conflict', () =>
    Effect.gen(function* discarded() {
      const { controller, reply, sent } = yield* setup();
      controller.change(draft('After'));
      controller.discard();
      expect(controller.status()).toBe('idle');
      controller.save();
      expect(sent).toEqual([]);

      controller.change(draft('Failing'));
      controller.save();
      yield* reply(0, 'failed');
      expect(controller.status()).toBe('error');
      controller.discard();
      expect(controller.status()).toBe('idle');
      controller.save();
      expect(sent).toEqual(['Failing']);

      controller.change(draft('Mine'));
      controller.save();
      yield* reply(1, 'conflict');
      controller.discard();
      expect(controller.status()).toBe('idle');
      expect(controller.confirmed()).toEqual(draft('Before'));
      // The form puts the confirmed version back on screen: that is no change.
      controller.change(draft('Before'));
      expect(controller.status()).toBe('idle');
    }),
  );

  it.effect('a draft typed back to the confirmed version leaves a conflict', () =>
    Effect.gen(function* typedBack() {
      const { controller, reply } = yield* setup();
      controller.change(draft('Mine'));
      controller.save();
      yield* reply(0, 'conflict');
      controller.change(draft('Before'));
      expect(controller.status()).toBe('idle');
    }),
  );

  it.effect('compares later drafts with what a partly successful save wrote', () =>
    Effect.gen(function* partlySaved() {
      const { controller, reply, sent } = yield* setup();
      controller.change(draft('Written, missing'));
      controller.save();
      // What a save of several commands reports before it answers `failed`.
      controller.confirm(draft('Written'));
      yield* reply(0, 'failed');
      expect(controller.status()).toBe('error');
      expect(controller.confirmed()).toEqual(draft('Written'));
      // Back to the value the form opened with: the server no longer has it, so it is a change to send.
      controller.change(draft('Before'));
      expect(controller.status()).toBe('dirty');
      controller.save();
      expect(sent).toEqual(['Written, missing', 'Before']);
    }),
  );

  it.effect('a disposed controller sends nothing and a save still running decides nothing', () =>
    Effect.gen(function* disposed() {
      const { controller, reply, sent } = yield* setup();
      controller.change(draft('Running'));
      controller.save();
      controller.change(draft('Pending'));
      controller.dispose();
      yield* reply(0, 'saved');
      controller.save();
      expect(sent).toEqual(['Running']);
      expect(controller.status()).toBe('saving');
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
      controller.save();
      yield* reply(0, 'saved');
      unsubscribe();
      expect(seen).toEqual(['dirty', 'saving', 'saved']);
    }),
  );
});
