import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { AutosaveStatus } from '../../src/autosave-status.tsx';
import { useAutosaveDraft } from '../../src/autosave.ts';
import type { RevisionedSaveResult } from '../../src/autosave.ts';

const runtime = ManagedRuntime.make(Layer.empty);

interface Harness {
  readonly expected: number[];
  readonly replies: Deferred.Deferred<RevisionedSaveResult>[];
  readonly sent: string[];
}

const harness = (): Harness => ({ expected: [], replies: [], sent: [] });

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
    save: (value: string, expectedRevision: number) =>
      Effect.suspend(() => {
        test.sent.push(value);
        test.expected.push(expectedRevision);
        const reply = Deferred.makeUnsafe<RevisionedSaveResult>();
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

const answer = (test: Harness, index: number, outcome: RevisionedSaveResult) => {
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
});
