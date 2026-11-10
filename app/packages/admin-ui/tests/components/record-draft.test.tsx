import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { SaveBar } from '../../src/save-bar.tsx';
import { useRecordDraft } from '../../src/draft-save.ts';
import type { DraftSaveResult, UseRecordDraftOptions } from '../../src/draft-save.ts';

const runtime = ManagedRuntime.make(Layer.empty);
const copy = { flags: 'Flags' };

interface Harness {
  /** The confirmed version each save was handed. */
  readonly bases: string[];
  readonly expected: number[];
  readonly replies: Deferred.Deferred<DraftSaveResult<string>>[];
  readonly sent: string[];
}

const harness = (): Harness => ({ bases: [], expected: [], replies: [], sent: [] });

interface NameFormProps {
  /** Something besides the draft that the validation reads, such as a selection: while set, no draft is valid. */
  readonly held?: boolean;
  readonly revision?: number;
  readonly server: string;
  /** What a settled draft becomes when it takes a newer server version. */
  readonly takeServer?: (server: string, draft: string) => string;
  readonly test: Harness;
}

type NameFormOptions = UseRecordDraftOptions<string, never>;

const NameForm = ({ held = false, revision = 1, server, takeServer, test }: NameFormProps) => {
  const options: { -readonly [Key in keyof NameFormOptions]: NameFormOptions[Key] } = {
    isValid: (value: string) => value.trim() !== '' && !held,
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
  };
  if (takeServer !== undefined) {
    options.takeServer = takeServer;
  }
  const record = useRecordDraft(options);
  const handleDiscard = record.discard;
  const handleReloadLatest = record.reloadLatest;
  const handleSave = record.save;
  return (
    <>
      <label>
        Název
        <input onChange={(event) => record.setDraft(event.target.value)} value={record.draft} />
      </label>
      <output
        aria-label={copy.flags}
      >{`${record.dirty ? 'dirty' : 'clean'} ${record.canSave ? 'savable' : 'held'}`}</output>
      <button onClick={handleDiscard} type="button">
        Zahodit změny
      </button>
      <SaveBar onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
    </>
  );
};

const answer = (test: Harness, index: number, outcome: DraftSaveResult<string>) => {
  const reply = test.replies[index];
  expect(reply).toBeDefined();
  if (reply !== undefined) {
    act(() => {
      runtime.runSync(Deferred.succeed(reply, outcome));
    });
  }
};

const input = () => screen.getByLabelText<HTMLInputElement>('Název');
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /^(?:Uložit|Ukládám…)$/u });
const flags = () => screen.getByLabelText('Flags').textContent;

const type = (value: string) => {
  fireEvent.change(input(), { target: { value } });
};
/** Typing and leaving the field, as a user who moves on to the next field does. */
const typeAndLeave = (value: string) => {
  input().focus();
  type(value);
  fireEvent.focusOut(input());
};
const clickSave = () => {
  fireEvent.click(saveButton());
};
/** One explicit save of `value`: type it, then click Uložit. */
const save = (value: string) => {
  type(value);
  clickSave();
};

/** A trailing remark is the form's own: it is kept over whatever name the server has. */
const withRemark = (server: string, draft: string) => (draft.endsWith(' (ověřit)') ? `${server} (ověřit)` : server);

/** Real time, longer than the delay the form used to save after. */
const wait = (duration: `${number} millis`) => Effect.sleep(duration);

afterEach(cleanup);

const eventually = (assertion: () => void) => Effect.promise(() => waitFor(assertion));

describe('useRecordDraft', () => {
  it.live('typing and leaving the field only changes the draft: nothing is sent after any delay', () =>
    Effect.gen(function* noSaveOnEdit() {
      const test = harness();
      render(<NameForm server="Akros" test={test} />);
      expect(saveButton().disabled).toBe(true);
      expect(flags()).toBe('clean held');
      typeAndLeave('Akros s.r.o.');
      yield* eventually(() => expect(screen.getByText('Neuložené změny')).toBeTruthy());
      expect(saveButton().disabled).toBe(false);
      expect(flags()).toBe('dirty savable');
      fireEvent(document, new Event('visibilitychange'));
      yield* wait('1100 millis');
      expect(test.sent).toEqual([]);
      expect(input().value).toBe('Akros s.r.o.');
    }),
  );

  it.live('sends nothing when the form unmounts with unsaved changes', () =>
    Effect.gen(function* noSaveOnUnmount() {
      const test = harness();
      const view = render(<NameForm server="Akros" test={test} />);
      typeAndLeave('Akros s.r.o.');
      yield* eventually(() => expect(screen.getByText('Neuložené změny')).toBeTruthy());
      view.unmount();
      yield* wait('1100 millis');
      expect(test.sent).toEqual([]);
    }),
  );

  it.live('one click on Uložit sends the whole draft once and reports Uloženo', () =>
    Effect.gen(function* saved() {
      const test = harness();
      render(<NameForm server="Akros" test={test} />);
      type('Akros s.r.o.');
      yield* eventually(() => expect(saveButton().disabled).toBe(false));
      clickSave();
      yield* eventually(() => expect(saveButton().getAttribute('aria-busy')).toBe('true'));
      // The button is busy: further clicks send nothing.
      clickSave();
      clickSave();
      expect(test.sent).toEqual(['Akros s.r.o.']);
      answer(test, 0, 'saved');
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
      expect(saveButton().disabled).toBe(true);
      expect(flags()).toBe('clean held');
      yield* wait('50 millis');
      expect(test.sent).toEqual(['Akros s.r.o.']);
    }),
  );

  it.effect('keeps an invalid draft local and Uložit disabled', () =>
    Effect.gen(function* invalid() {
      const test = harness();
      render(<NameForm server="Akros" test={test} />);
      type(' ');
      yield* eventually(() => expect(screen.getByText('Neuložené změny – opravte zvýrazněná pole')).toBeTruthy());
      expect(saveButton().disabled).toBe(true);
      expect(flags()).toBe('dirty held');
      clickSave();
      expect(test.sent).toEqual([]);
    }),
  );

  it.effect('discard puts the confirmed version back and leaves nothing to save', () =>
    Effect.gen(function* discarded() {
      const test = harness();
      render(<NameForm server="Akros" test={test} />);
      save('Akros CZ');
      yield* eventually(() => expect(test.sent).toEqual(['Akros CZ']));
      answer(test, 0, 2);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());

      // The page still shows `Akros`; the confirmed version is what the save wrote.
      type('Akros Praha');
      yield* eventually(() => expect(flags()).toBe('dirty savable'));
      fireEvent.click(screen.getByRole('button', { name: 'Zahodit změny' }));
      expect(input().value).toBe('Akros CZ');
      yield* eventually(() => expect(flags()).toBe('clean held'));
      clickSave();
      expect(test.sent).toEqual(['Akros CZ']);
    }),
  );

  it.effect('discard after a failed save clears the error', () =>
    Effect.gen(function* discardedError() {
      const test = harness();
      render(<NameForm server="Akros" test={test} />);
      save('Akros CZ');
      yield* eventually(() => expect(test.sent).toEqual(['Akros CZ']));
      answer(test, 0, 'failed');
      yield* eventually(() => expect(screen.getByText('Uložení se nezdařilo. Zkuste to znovu.')).toBeTruthy());
      expect(saveButton().disabled).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Zahodit změny' }));
      expect(input().value).toBe('Akros');
      yield* eventually(() => expect(screen.queryByText('Uložení se nezdařilo. Zkuste to znovu.')).toBeNull());
      expect(saveButton().disabled).toBe(true);
    }),
  );

  it.effect('a discarded draft takes the version someone else saved while it was unsaved', () =>
    Effect.gen(function* discardedOverNewer() {
      const test = harness();
      const view = render(<NameForm revision={1} server="Akros" test={test} />);
      type('Moje změna');
      yield* eventually(() => expect(flags()).toBe('dirty savable'));
      view.rerender(<NameForm revision={2} server="Jejich změna" test={test} />);
      expect(input().value).toBe('Moje změna');
      fireEvent.click(screen.getByRole('button', { name: 'Zahodit změny' }));
      yield* eventually(() => expect(input().value).toBe('Jejich změna'));
      expect(flags()).toBe('clean held');
      // The next edit builds on their version and names its revision.
      save('Jejich změna 2');
      yield* eventually(() => expect(test.sent).toEqual(['Jejich změna 2']));
      expect(test.bases).toEqual(['Jejich změna']);
      expect(test.expected).toEqual([2]);
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
      save('Moje změna');
      view.rerender(<NameForm server="Jejich změna" test={test} />);
      expect(input().value).toBe('Moje změna');
      answer(test, 0, 'conflict');
      yield* eventually(() => expect(screen.getByText('Záznam mezitím změnil někdo jiný.')).toBeTruthy());
      // A conflict is not saved over: Uložit stays disabled until the current version is loaded.
      expect(saveButton().disabled).toBe(true);
      expect(flags()).toBe('dirty held');
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
      save('Akros CZ');
      answer(test, 0, 5);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
      // Someone else changed another record: this one is still what we saved.
      view.rerender(<NameForm revision={6} server="Akros CZ" test={test} />);
      save('Akros Praha');
      yield* eventually(() => expect(test.expected).toEqual([4, 6]));
      answer(test, 1, 7);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
      // Someone else changed this record while a draft is unsaved: the save keeps the old base and conflicts.
      type('Akros Brno');
      view.rerender(<NameForm revision={8} server="Jejich název" test={test} />);
      clickSave();
      yield* eventually(() => expect(test.expected).toEqual([4, 6, 7]));
    }),
  );

  it.effect('hands each save the version the server last confirmed, not the one still on the page', () =>
    Effect.gen(function* confirmedVersion() {
      const test = harness();
      const view = render(<NameForm server="Akros" test={test} />);
      save('Jedna');
      yield* eventually(() => expect(test.sent).toEqual(['Jedna']));
      answer(test, 0, 2);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());

      // The page still has `Akros`: its reload has not landed. A failed save does not move the base either.
      save('Dva');
      yield* eventually(() => expect(test.sent).toEqual(['Jedna', 'Dva']));
      answer(test, 1, 'failed');
      yield* eventually(() => expect(screen.getByText('Uložení se nezdařilo. Zkuste to znovu.')).toBeTruthy());
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
      // The save sent two commands: the first wrote `Akros CZ` and left revision 5, the second failed.
      save('Akros CZ, a.s.');
      yield* eventually(() => expect(test.sent).toEqual(['Akros CZ, a.s.']));
      answer(test, 0, { confirmed: 'Akros CZ', outcome: 'failed', revision: 5 });
      yield* eventually(() => expect(screen.getByText('Uložení se nezdařilo. Zkuste to znovu.')).toBeTruthy());

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

  it.effect('discard after a partly successful save goes back to what the server took', () =>
    Effect.gen(function* partlySavedDiscard() {
      const test = harness();
      render(<NameForm revision={4} server="Akros" test={test} />);
      save('Akros CZ, a.s.');
      yield* eventually(() => expect(test.sent).toEqual(['Akros CZ, a.s.']));
      answer(test, 0, { confirmed: 'Akros CZ', outcome: 'failed', revision: 5 });
      yield* eventually(() => expect(screen.getByText('Uložení se nezdařilo. Zkuste to znovu.')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Zahodit změny' }));
      expect(input().value).toBe('Akros CZ');
      yield* eventually(() => expect(flags()).toBe('clean held'));
    }),
  );

  it.effect('lets a settled draft keep a part the server does not store when it takes a newer version', () =>
    Effect.gen(function* keptPart() {
      const test = harness();
      const view = render(<NameForm revision={4} server="Akros" takeServer={withRemark} test={test} />);
      save('Akros (ověřit)');
      yield* eventually(() => expect(test.sent).toEqual(['Akros (ověřit)']));
      answer(test, 0, 'saved');
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());

      view.rerender(<NameForm revision={5} server="Jejich" takeServer={withRemark} test={test} />);
      expect(input().value).toBe('Jejich (ověřit)');
      // The kept part is a draft over their version: it is saved against that version and its revision.
      yield* eventually(() => expect(saveButton().disabled).toBe(false));
      clickSave();
      yield* eventually(() => expect(test.sent).toEqual(['Akros (ověřit)', 'Jejich (ověřit)']));
      expect(test.bases[1]).toBe('Jejich');
      expect(test.expected[1]).toBe(5);
    }),
  );

  it.effect('keeps a draft sent for approval on its base revision and never proposes it again', () =>
    Effect.gen(function* proposed() {
      const test = harness();
      const view = render(<NameForm revision={4} server="Akros" test={test} />);
      save('Akros CZ');
      answer(test, 0, 'proposed');
      yield* eventually(() =>
        expect(screen.getByText('Odesláno ke schválení – změna zatím nebyla provedena')).toBeTruthy(),
      );
      // Handed over: nothing to save and nothing that leaving would lose.
      expect(saveButton().disabled).toBe(true);
      expect(flags()).toBe('clean held');
      clickSave();
      // Live data does not replace the parked draft.
      view.rerender(<NameForm revision={5} server="Akros" test={test} />);
      expect(input().value).toBe('Akros CZ');
      save('Akros Praha');
      yield* eventually(() => expect(test.sent).toEqual(['Akros CZ', 'Akros Praha']));
      // The proposal saved nothing: the record still has its confirmed version, so the base follows revision 5.
      expect(test.expected).toEqual([4, 5]);
      answer(test, 1, 6);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
    }),
  );

  it.effect('checks a changed draft again when what its validation reads changes, and leaves every other status', () =>
    Effect.gen(function* revalidation() {
      const test = harness();
      const view = render(<NameForm server="Akros" test={test} />);
      type('Akros CZ');
      expect(flags()).toBe('dirty savable');
      view.rerender(<NameForm held server="Akros" test={test} />);
      yield* eventually(() => expect(flags()).toBe('dirty held'));
      view.rerender(<NameForm server="Akros" test={test} />);
      yield* eventually(() => expect(flags()).toBe('dirty savable'));

      // A running save, a conflict and a parked draft keep their status whatever the validation now says.
      clickSave();
      view.rerender(<NameForm held server="Akros" test={test} />);
      expect(saveButton().textContent).toBe('Ukládám…');
      answer(test, 0, 'conflict');
      yield* eventually(() => expect(screen.getByText('Záznam mezitím změnil někdo jiný.')).toBeTruthy());
      view.rerender(<NameForm server="Akros" test={test} />);
      expect(screen.getByText('Záznam mezitím změnil někdo jiný.')).toBeTruthy();
      expect(flags()).toBe('dirty held');
      fireEvent.click(screen.getByRole('button', { name: 'Načíst aktuální verzi' }));
      save('Akros Praha');
      answer(test, 1, 'proposed');
      const parked = 'Odesláno ke schválení – změna zatím nebyla provedena';
      yield* eventually(() => expect(screen.getByText(parked)).toBeTruthy());
      view.rerender(<NameForm held server="Akros" test={test} />);
      expect(screen.getByText(parked)).toBeTruthy();
      expect(test.sent).toEqual(['Akros CZ', 'Akros Praha']);
    }),
  );

  it.effect('a saved draft that renders again keeps its confirmed version and still takes a newer one', () =>
    Effect.gen(function* equalDraft() {
      const test = harness();
      const view = render(<NameForm revision={4} server="Akros" test={test} />);
      save('Akros CZ');
      answer(test, 0, 5);
      yield* eventually(() => expect(screen.getByText('Uloženo')).toBeTruthy());
      // The same draft rendered with other validation answers is not a change: still saved, nothing to send.
      view.rerender(<NameForm held revision={4} server="Akros" test={test} />);
      view.rerender(<NameForm revision={4} server="Akros" test={test} />);
      expect(screen.getByText('Uloženo')).toBeTruthy();
      expect(flags()).toBe('clean held');
      // The reload of that save, then someone else's version: the clean draft takes it.
      view.rerender(<NameForm revision={5} server="Akros CZ" test={test} />);
      view.rerender(<NameForm revision={6} server="Jejich" test={test} />);
      expect(input().value).toBe('Jejich');
      save('Moje');
      yield* eventually(() => expect(test.sent).toEqual(['Akros CZ', 'Moje']));
      expect(test.bases[1]).toBe('Jejich');
      expect(test.expected[1]).toBe(6);
    }),
  );

  it.effect('confirms a parked draft once the approved change reaches the server, without sending it again', () =>
    Effect.gen(function* approved() {
      const test = harness();
      const view = render(<NameForm revision={4} server="Akros" test={test} />);
      save('Akros CZ');
      answer(test, 0, 'proposed');
      yield* eventually(() =>
        expect(screen.getByText('Odesláno ke schválení – změna zatím nebyla provedena')).toBeTruthy(),
      );
      view.rerender(<NameForm revision={5} server="Akros CZ" test={test} />);
      yield* eventually(() =>
        expect(screen.queryByText('Odesláno ke schválení – změna zatím nebyla provedena')).toBeNull(),
      );
      view.unmount();
      expect(test.sent).toEqual(['Akros CZ']);
    }),
  );
});
