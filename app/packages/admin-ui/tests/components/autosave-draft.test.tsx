import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { AutosaveStatus } from '../../src/autosave-status.tsx';
import { useAutosaveDraft } from '../../src/autosave.ts';
import type { DraftSaveResult } from '../../src/autosave.ts';

const runtime = ManagedRuntime.make(Layer.empty);

interface Harness {
  /** The confirmed version each save was handed. */
  readonly bases: string[];
  readonly expected: number[];
  readonly replies: Deferred.Deferred<DraftSaveResult<string>>[];
  readonly sent: string[];
}

const harness = (): Harness => ({ bases: [], expected: [], replies: [], sent: [] });

interface NameFormProps {
  readonly revision?: number;
  readonly server: string;
  readonly test: Harness;
}

const NameForm = ({ revision = 1, server, test }: NameFormProps) => {
  const autosave = useAutosaveDraft({
    delayMs: 10,
    isValid: (value: string) => value.trim() !== '',
    revision,
    runtime,
    save: (value: string, expectedRevision: number, confirmed: string) =>
      Effect.suspend(() => {
        test.sent.push(value);
        test.expected.push(expectedRevision);
        test.bases.push(confirmed);
        const reply = Deferred.makeUnsafe<DraftSaveResult<string>>();
        test.replies.push(reply);
        return Deferred.await(reply);
      }),
    server,
  });
  const handleBlur = autosave.flush;
  const handleReloadLatest = autosave.reloadLatest;
  const handleRetry = autosave.retry;
  return (
    <>
      <label>
        Název
        <input onBlur={handleBlur} onChange={(event) => autosave.setDraft(event.target.value)} value={autosave.draft} />
      </label>
      <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
    </>
  );
};

const answer = (test: Harness, index: number, outcome: DraftSaveResult<string>) => {
  const reply = test.replies[index];
  expect(reply).toBeDefined();
  if (reply !== undefined) {
    runtime.runSync(Deferred.succeed(reply, outcome));
  }
};

const input = () => screen.getByLabelText<HTMLInputElement>('Název');

afterEach(cleanup);

const eventually = (assertion: () => void) => Effect.promise(() => waitFor(assertion));

describe('useAutosaveDraft', () => {
  it.effect('saves a typed change and reports Ukládám… then Uloženo', () =>
    Effect.gen(function* saved() {
      const test = harness();
      render(<NameForm server="Akros" test={test} />);
      fireEvent.change(input(), { target: { value: 'Akros s.r.o.' } });
      yield* eventually(() => expect(screen.getByText('Ukládám…')).toBeTruthy());
      expect(test.sent).toEqual(['Akros s.r.o.']);
      answer(test, 0, 'saved');
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
    }),
  );

  it.effect('keeps an invalid draft local', () =>
    Effect.gen(function* invalid() {
      const test = harness();
      render(<NameForm server="Akros" test={test} />);
      fireEvent.change(input(), { target: { value: ' ' } });
      fireEvent.focusOut(input());
      yield* eventually(() => expect(screen.getByText('Neuloženo – opravte zvýrazněná pole')).toBeTruthy());
      expect(test.sent).toEqual([]);
    }),
  );

  it('follows a newer server version while nothing is pending', () => {
    const test = harness();
    const view = render(<NameForm server="Akros" test={test} />);
    view.rerender(<NameForm server="Akros CZ" test={test} />);
    expect(input().value).toBe('Akros CZ');
    expect(test.sent).toEqual([]);
  });

  it.effect('keeps a pending draft, shows a conflict and loads the current version on request', () =>
    Effect.gen(function* conflict() {
      const test = harness();
      const view = render(<NameForm server="Akros" test={test} />);
      fireEvent.change(input(), { target: { value: 'Moje změna' } });
      fireEvent.focusOut(input());
      view.rerender(<NameForm server="Jejich změna" test={test} />);
      expect(input().value).toBe('Moje změna');
      answer(test, 0, 'conflict');
      yield* eventually(() => expect(screen.getByText('Záznam mezitím změnil někdo jiný.')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Načíst aktuální verzi' }));
      expect(input().value).toBe('Jejich změna');
      yield* eventually(() => expect(screen.queryByText('Záznam mezitím změnil někdo jiný.')).toBeNull());
      expect(test.sent).toEqual(['Moje změna']);
    }),
  );

  it.effect('sends the revision the draft is based on and follows revisions that changed something else', () =>
    Effect.gen(function* revisions() {
      const test = harness();
      const view = render(<NameForm revision={4} server="Akros" test={test} />);
      fireEvent.change(input(), { target: { value: 'Akros CZ' } });
      fireEvent.focusOut(input());
      answer(test, 0, 5);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
      // Someone else changed another record: this one is still what we saved.
      view.rerender(<NameForm revision={6} server="Akros CZ" test={test} />);
      fireEvent.change(input(), { target: { value: 'Akros Praha' } });
      fireEvent.focusOut(input());
      yield* eventually(() => expect(test.expected).toEqual([4, 6]));
      answer(test, 1, 7);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
      // Someone else changed this record while a draft is pending: the save keeps the old base and conflicts.
      fireEvent.change(input(), { target: { value: 'Akros Brno' } });
      view.rerender(<NameForm revision={8} server="Jejich název" test={test} />);
      fireEvent.focusOut(input());
      yield* eventually(() => expect(test.expected).toEqual([4, 6, 7]));
    }),
  );

  it.effect('hands each save the version the server last confirmed, not the one still on the page', () =>
    Effect.gen(function* confirmedVersion() {
      const test = harness();
      const view = render(<NameForm server="Akros" test={test} />);
      const save = (value: string) => {
        fireEvent.change(input(), { target: { value } });
        fireEvent.focusOut(input());
      };
      save('Jedna');
      yield* eventually(() => expect(test.sent).toEqual(['Jedna']));
      answer(test, 0, 2);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());

      // The page still has `Akros`: its reload has not landed. A failed save does not move the base either.
      save('Dva');
      yield* eventually(() => expect(test.sent).toEqual(['Jedna', 'Dva']));
      answer(test, 1, 'failed');
      yield* eventually(() => expect(screen.getByRole('button', { name: 'zkusit znovu' })).toBeTruthy());
      save('Tři');
      yield* eventually(() => expect(test.sent).toEqual(['Jedna', 'Dva', 'Tři']));
      answer(test, 2, 3);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
      expect(test.bases).toEqual(['Akros', 'Jedna', 'Jedna']);

      // A clean draft that takes a reloaded version starts over from that version.
      view.rerender(<NameForm revision={4} server="Jejich" test={test} />);
      expect(input().value).toBe('Jejich');
      save('Čtyři');
      yield* eventually(() => expect(test.sent).toHaveLength(4));
      expect(test.bases[3]).toBe('Jejich');
      expect(test.expected[3]).toBe(4);
    }),
  );

  it.effect('compares later drafts with what a partly successful save wrote, at the revision it left', () =>
    Effect.gen(function* partlySaved() {
      const test = harness();
      const view = render(<NameForm revision={4} server="Akros" test={test} />);
      const save = (value: string) => {
        fireEvent.change(input(), { target: { value } });
        fireEvent.focusOut(input());
      };
      // The save sent two commands: the first wrote `Akros CZ` and left revision 5, the second failed.
      save('Akros CZ, a.s.');
      yield* eventually(() => expect(test.sent).toEqual(['Akros CZ, a.s.']));
      answer(test, 0, { confirmed: 'Akros CZ', outcome: 'failed', revision: 5 });
      yield* eventually(() => expect(screen.getByRole('button', { name: 'zkusit znovu' })).toBeTruthy());

      // The reload lands with what the server has now; the unsaved draft stays.
      view.rerender(<NameForm revision={5} server="Akros CZ" test={test} />);
      expect(input().value).toBe('Akros CZ, a.s.');

      // Back to the value the form opened with: the server no longer has it, so it is a change to send.
      save('Akros');
      yield* eventually(() => expect(test.sent).toEqual(['Akros CZ, a.s.', 'Akros']));
      expect(test.bases).toEqual(['Akros', 'Akros CZ']);
      expect(test.expected).toEqual([4, 5]);
      answer(test, 1, 6);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
    }),
  );

  it.effect('keeps a draft parked for approval on its base revision and never proposes it again', () =>
    Effect.gen(function* proposed() {
      const test = harness();
      const view = render(<NameForm revision={4} server="Akros" test={test} />);
      fireEvent.change(input(), { target: { value: 'Akros CZ' } });
      fireEvent.focusOut(input());
      answer(test, 0, 'proposed');
      yield* eventually(() =>
        expect(screen.getByText('Čeká na schválení – změna zatím nebyla provedena')).toBeTruthy(),
      );
      expect(screen.queryByRole('button')).toBeNull();
      fireEvent.focusOut(input());
      // Live data does not replace the parked draft.
      view.rerender(<NameForm revision={5} server="Akros" test={test} />);
      expect(input().value).toBe('Akros CZ');
      fireEvent.change(input(), { target: { value: 'Akros Praha' } });
      fireEvent.focusOut(input());
      yield* eventually(() => expect(test.sent).toEqual(['Akros CZ', 'Akros Praha']));
      // The proposal saved nothing: the record still has its confirmed version, so the base follows revision 5.
      expect(test.expected).toEqual([4, 5]);
      answer(test, 1, 6);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
    }),
  );

  it.effect('confirms a parked draft once the approved change reaches the server, without sending it again', () =>
    Effect.gen(function* approved() {
      const test = harness();
      const view = render(<NameForm revision={4} server="Akros" test={test} />);
      fireEvent.change(input(), { target: { value: 'Akros CZ' } });
      fireEvent.focusOut(input());
      answer(test, 0, 'proposed');
      yield* eventually(() =>
        expect(screen.getByText('Čeká na schválení – změna zatím nebyla provedena')).toBeTruthy(),
      );
      view.rerender(<NameForm revision={5} server="Akros CZ" test={test} />);
      yield* eventually(() =>
        expect(screen.queryByText('Čeká na schválení – změna zatím nebyla provedena')).toBeNull(),
      );
      view.unmount();
      expect(test.sent).toEqual(['Akros CZ']);
    }),
  );
});
