import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { DraftForm, draftPending, draftSavable, draftUnsaved } from '../../src/draft-save.ts';
import type { DraftSaveEnd } from '../../src/draft-save.ts';

interface Draft {
  readonly name: string;
}

const draft = (name: string): Draft => ({ name });

const runtime = ManagedRuntime.make(Layer.empty);

/** Waits until the running save of `form` has ended. */
const saveEnded = (form: DraftForm<Draft>) =>
  Effect.callback<boolean>((resume) => {
    form.afterSave(() => {
      resume(Effect.succeed(true));
    });
  });

/** A draft form whose saves wait until the test replies to them. */
const setup = () => {
  const sent: string[] = [];
  // One signal per save, set once the save reached the server.
  const starts: Deferred.Deferred<boolean>[] = [];
  const startOf = (index: number) => {
    const start = starts[index] ?? Deferred.makeUnsafe<boolean>();
    starts[index] = start;
    return start;
  };
  const replies: Deferred.Deferred<DraftSaveEnd<Draft>>[] = [];
  const form = new DraftForm<Draft>(
    { confirmed: draft('Before'), revision: 0, value: draft('Before') },
    {
      isValid: (value) => value.name.trim() !== '',
      runtime,
      save: (value) =>
        Effect.suspend(() => {
          sent.push(value.name);
          const reply = Deferred.makeUnsafe<DraftSaveEnd<Draft>>();
          replies.push(reply);
          Deferred.doneUnsafe(startOf(sent.length - 1), Effect.succeed(true));
          return Deferred.await(reply);
        }),
    },
  );
  /** Save, and wait until the save it started (if any) reached the server. */
  const save = Effect.fnUntraced(function* save(on: DraftForm<Draft> = form) {
    const running = on.ledger().sending;
    const index = sent.length;
    on.save();
    if (!running && on.ledger().sending) {
      yield* Deferred.await(startOf(index));
    }
  });
  /** Answers save `index` and waits until `on` took the answer. */
  const reply = Effect.fnUntraced(function* answer(
    index: number,
    outcome: DraftSaveEnd<Draft>,
    on: DraftForm<Draft> = form,
  ) {
    const pending = replies[index];
    expect(pending).toBeDefined();
    const ended = saveEnded(on);
    if (pending !== undefined) {
      yield* Deferred.succeed(pending, outcome);
    }
    yield* ended;
  });
  return { form, reply, save, sent };
};

describe('explicit draft save on effect-form state', () => {
  it.effect('never sends a changed draft by itself', () =>
    Effect.gen(function* run1() {
      const { form, sent } = setup();
      form.change(draft('After'));
      expect(form.status()).toBe('dirty');
      yield* Effect.yieldNow;
      expect(sent).toEqual([]);
      expect(form.draft()).toEqual(draft('After'));
    }),
  );

  it.effect('sends the whole draft once per save() and keeps "saved" until the next change', () =>
    Effect.gen(function* run2() {
      const { form, reply, save, sent } = setup();
      yield* save();
      expect(sent).toEqual([]);
      expect(form.status()).toBe('idle');
      form.change(draft('After'));
      yield* save();
      expect(sent).toEqual(['After']);
      expect(form.status()).toBe('saving');
      // A second click while the save runs sends nothing.
      yield* save();
      expect(sent).toEqual(['After']);
      yield* reply(0, 'saved');
      expect(form.status()).toBe('saved');
      expect(form.ledger().confirmed).toEqual(draft('After'));
      yield* save();
      expect(sent).toEqual(['After']);
      expect(form.status()).toBe('saved');
      form.change(draft('After all'));
      expect(form.status()).toBe('dirty');
    }),
  );

  it.effect('keeps a draft a deploy left behind unsaved, offering the reload while it is typed on', () =>
    Effect.gen(function* run3() {
      const { form, reply, save, sent } = setup();
      form.change(draft('After'));
      yield* save();
      yield* reply(0, 'reload-required');
      expect(form.status()).toBe('reload-required');
      expect(draftUnsaved(form.status())).toBe(true);
      expect(draftSavable(form.status())).toBe(true);
      form.change(draft('After more'));
      expect(form.status()).toBe('reload-required');
      yield* save();
      expect(sent).toEqual(['After', 'After more']);
      yield* reply(1, 'saved');
      expect(form.status()).toBe('saved');
    }),
  );

  it.effect('tells a draft that can be saved from an unchanged or invalid one', () =>
    Effect.gen(function* run4() {
      const { form, save, sent } = setup();
      form.change(draft(' '));
      expect(form.status()).toBe('invalid');
      expect(draftSavable(form.status())).toBe(false);
      expect(draftUnsaved(form.status())).toBe(true);
      yield* save();
      expect(sent).toEqual([]);
      form.change(draft('Before'));
      expect(form.status()).toBe('idle');
    }),
  );

  it.effect('shows a failed save as an error and sends the same draft again on the next save()', () =>
    Effect.gen(function* run5() {
      const { form, reply, save, sent } = setup();
      form.change(draft('After'));
      yield* save();
      yield* reply(0, 'failed');
      expect(form.status()).toBe('error');
      expect(draftSavable(form.status())).toBe(true);
      yield* save();
      expect(sent).toEqual(['After', 'After']);
      yield* reply(1, 'saved');
      expect(form.status()).toBe('saved');
    }),
  );

  it.effect('a failure belongs to the draft that was sent', () =>
    Effect.gen(function* run6() {
      const { form, reply, save, sent } = setup();
      form.change(draft('One'));
      yield* save();
      form.change(draft('Two'));
      yield* reply(0, 'failed');
      expect(form.status()).toBe('dirty');
      form.change(draft('One'));
      expect(form.status()).toBe('dirty');
      yield* save();
      expect(sent).toEqual(['One', 'One']);
      form.change(draft('Two'));
      form.change(draft('One'));
      yield* reply(1, 'failed');
      // Back at what was sent: the failure is this draft's, and Retry sends it again.
      expect(form.status()).toBe('error');
    }),
  );

  it.effect('holds every draft parked for approval: save() does not send it again', () =>
    Effect.gen(function* run7() {
      const { form, reply, save, sent } = setup();
      form.change(draft('After'));
      yield* save();
      yield* reply(0, 'proposed');
      expect(form.status()).toBe('proposed');
      expect(form.ledger().confirmed).toEqual(draft('Before'));
      expect(draftPending(form.status())).toBe(true);
      expect(draftUnsaved(form.status())).toBe(false);
      expect(draftSavable(form.status())).toBe(false);
      form.change(draft('Other'));
      yield* save();
      yield* reply(1, 'proposed');
      form.change(draft('After'));
      expect(form.status()).toBe('proposed');
      yield* save();
      expect(sent).toEqual(['After', 'Other']);
      form.change(draft('Third'));
      yield* save();
      yield* reply(2, 'saved');
      // A committed save clears the proposals.
      form.change(draft('After'));
      expect(form.status()).toBe('dirty');
    }),
  );

  it.effect('stops on a conflict until the draft is back or the server version is loaded', () =>
    Effect.gen(function* run8() {
      const { form, reply, save, sent } = setup();
      form.change(draft('Mine'));
      yield* save();
      yield* reply(0, 'conflict');
      expect(form.status()).toBe('conflict');
      expect(draftSavable(form.status())).toBe(false);
      expect(draftUnsaved(form.status())).toBe(true);
      form.change(draft('Mine again'));
      expect(form.status()).toBe('conflict');
      yield* save();
      expect(sent).toEqual(['Mine']);
      const reloaded = form.successor(draft('Theirs'), draft('Theirs'), 1);
      reloaded.takeOver();
      expect(reloaded.status()).toBe('idle');
      expect(reloaded.draft()).toEqual(draft('Theirs'));
      reloaded.change(draft('Theirs, edited'));
      yield* save(reloaded);
      expect(sent).toEqual(['Mine', 'Theirs, edited']);
      yield* reply(1, 'saved', reloaded);
      expect(reloaded.status()).toBe('saved');

      const typedBack = setup();
      typedBack.form.change(draft('Mine'));
      yield* typedBack.save();
      yield* typedBack.reply(0, 'conflict');
      typedBack.form.change(draft('Before'));
      expect(typedBack.form.status()).toBe('idle');
      typedBack.form.change(draft('Again'));
      expect(typedBack.form.status()).toBe('dirty');
    }),
  );

  it.effect('keeps edits made while a save runs as an unsaved draft instead of sending them', () =>
    Effect.gen(function* run9() {
      const { form, reply, save, sent } = setup();
      form.change(draft('One'));
      yield* save();
      form.change(draft('Three'));
      yield* save();
      expect(sent).toEqual(['One']);
      yield* reply(0, 'saved');
      expect(form.status()).toBe('dirty');
      expect(form.ledger().confirmed).toEqual(draft('One'));
      yield* save();
      expect(sent).toEqual(['One', 'Three']);
      yield* reply(1, 'saved');
      expect(form.status()).toBe('saved');
    }),
  );

  it.effect('discard goes back to the confirmed version and clears an error or a conflict', () =>
    Effect.gen(function* run10() {
      const { form, reply, save, sent } = setup();
      form.change(draft('After'));
      form.discard();
      expect(form.status()).toBe('idle');
      expect(form.draft()).toEqual(draft('Before'));

      form.change(draft('Failing'));
      yield* save();
      yield* reply(0, 'failed');
      form.discard();
      expect(form.status()).toBe('idle');
      expect(form.draft()).toEqual(draft('Before'));

      form.change(draft('Saved'));
      yield* save();
      yield* reply(1, 'saved');
      form.change(draft('Mine'));
      yield* save();
      yield* reply(2, 'conflict');
      form.discard();
      // Back to the last successful submit.
      expect(form.status()).toBe('idle');
      expect(form.draft()).toEqual(draft('Saved'));
      expect(sent).toEqual(['Failing', 'Saved', 'Mine']);
    }),
  );

  it.effect('compares later drafts with what a partly successful save wrote', () =>
    Effect.gen(function* run11() {
      const { form, reply, save, sent } = setup();
      form.change(draft('Written, missing'));
      yield* save();
      yield* reply(0, { confirmed: draft('Written'), outcome: 'failed', revision: 4 });
      expect(form.status()).toBe('error');
      expect(form.ledger()).toMatchObject({ confirmed: draft('Written'), revision: 4 });
      form.change(draft('Before'));
      expect(form.status()).toBe('dirty');
      yield* save();
      expect(sent).toEqual(['Written, missing', 'Before']);
    }),
  );

  it.effect('a save of the form before decides nothing for its successor', () =>
    Effect.gen(function* earlier() {
      const { form, reply, save, sent } = setup();
      form.change(draft('Running'));
      yield* save();
      const next = form.successor(draft('Server'), draft('Server'), 2);
      yield* reply(0, 'saved');
      expect(form.status()).toBe('saved');
      expect(next.status()).toBe('idle');
      expect(next.ledger()).toMatchObject({ confirmed: draft('Server'), revision: 2 });
      expect(sent).toEqual(['Running']);
    }),
  );

  it.effect('a call that still reaches a replaced form lands on the form on screen', () =>
    Effect.gen(function* handOver() {
      const { form } = setup();
      const next = form.successor(draft('Server'), draft('Server'), 1);
      next.takeOver();
      form.update((current) => draft(`${current.name}, edited`));
      expect(next.draft()).toEqual(draft('Server, edited'));
      expect(next.status()).toBe('dirty');
      expect(form.draft()).toEqual(draft('Before'));
      yield* Effect.void;
    }),
  );

  it.effect('keeps the base revision moving forward and what a reload has to keep', () =>
    Effect.gen(function* base() {
      const { form } = setup();
      form.advance(3);
      form.advance(2);
      expect(form.ledger().revision).toBe(3);
      expect(form.kept()).toBeUndefined();
      form.change(draft('Kept'));
      expect(form.kept()).toEqual({ confirmed: draft('Before'), revision: 3, value: draft('Kept') });
      yield* Effect.void;
    }),
  );

  it.effect(
    'revise takes a part out of the draft, the confirmed version and a running save without starting over',
    () =>
      Effect.gen(function* run14() {
        const { form, reply, save, sent } = setup();
        const withoutSecret = (value: Draft) => draft(value.name.replace(' Secret', ''));
        form.change(draft('Kept Secret'));
        yield* save();
        const answered: string[] = [];
        form.afterSave((status) => {
          answered.push(status);
        });
        // The form loses access to the secret while the save is on its way: the save still decides.
        form.revise(withoutSecret);
        expect(form.status()).toBe('saving');
        yield* reply(0, 'saved');
        expect(answered).toEqual(['saved']);
        expect(form.status()).toBe('saved');
        expect(form.ledger().confirmed).toEqual(draft('Kept'));

        // A saved version is revised too: discarding a later edit does not bring the secret back.
        form.change(draft('Mine Secret'));
        yield* save();
        yield* reply(1, 'saved');
        form.change(draft('Mine Secret, edited'));
        form.revise(withoutSecret);
        expect(form.ledger().confirmed).toEqual(draft('Mine'));
        expect(form.status()).toBe('dirty');
        form.discard();
        expect(form.draft()).toEqual(draft('Mine'));
        expect(form.status()).toBe('idle');
        expect(sent).toEqual(['Kept Secret', 'Mine Secret']);
      }),
  );

  it.effect('a draft that lost a part while its save ran is not sent again once the part is back', () =>
    Effect.gen(function* run15() {
      const { form, reply, save, sent } = setup();
      form.change(draft('Call Secret'));
      yield* save();
      form.revise((value) => draft(value.name.replace(' Secret', '')));
      form.change(draft('Call!'));
      yield* reply(0, 'saved');
      expect(form.status()).toBe('dirty');
      expect(form.ledger().confirmed).toEqual(draft('Call'));
      // The part comes back and the edit is taken back: that is what the server already has.
      form.change(draft('Call Secret'));
      expect(form.status()).toBe('idle');
      yield* save();
      expect(sent).toEqual(['Call Secret']);
    }),
  );

  it.effect('notifies subscribers when the draft or its status changes', () =>
    Effect.gen(function* run16() {
      const { form, reply, save } = setup();
      const seen: string[] = [];
      const unsubscribe = form.subscribe(() => {
        seen.push(form.status());
      });
      form.change(draft('A'));
      yield* save();
      yield* reply(0, 'saved');
      unsubscribe();
      expect(seen.at(0)).toBe('dirty');
      expect(seen).toContain('saving');
      expect(seen.at(-1)).toBe('saved');
    }),
  );
});
