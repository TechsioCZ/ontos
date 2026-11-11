import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { useState } from 'react';
import { useRecordDraft } from '../../src/draft-save.ts';
import type { SaveOutcome } from '../../src/draft-save.ts';
import { SaveBar } from '../../src/save-bar.tsx';
import { saveLabelsFor } from '../../src/save-labels.ts';
import {
  UnsavedChangesBoundary,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
  useUnsavedChangesScope,
} from '../../src/unsaved-changes.tsx';
import type { BlockedNavigation } from '../../src/unsaved-changes.tsx';

const runtime = ManagedRuntime.make(Layer.empty);

interface Harness {
  /** `discarded` and `left`, in the order they happened. */
  readonly events: string[];
  readonly replies: Deferred.Deferred<SaveOutcome>[];
  readonly sent: string[];
}

const harness = (): Harness => ({ events: [], replies: [], sent: [] });
const count = (test: Harness, event: 'discarded' | 'left') => test.events.filter((entry) => entry === event).length;

interface FormProps {
  readonly label?: string;
  readonly language?: string;
  readonly navigation?: BlockedNavigation | undefined;
  /** A second, half-filled form on the same screen that Uložit does not send. */
  readonly otherChanges?: boolean;
  readonly server?: string;
  readonly test: Harness;
}

/** An edit form as the recipe wires it: one draft, one save bar, one guard, one question. */
const Form = ({ label = 'Název', language, navigation, otherChanges = false, server = 'Akros', test }: FormProps) => {
  const record = useRecordDraft<string, never>({
    isValid: (value) => value.trim() !== '',
    runtime,
    save: (value) =>
      Effect.suspend(() => {
        test.sent.push(value);
        const reply = Deferred.makeUnsafe<SaveOutcome>();
        test.replies.push(reply);
        return Deferred.await(reply);
      }),
    server,
  });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation,
    onDiscard: () => {
      test.events.push('discarded');
      record.discard();
    },
    otherChanges,
  });
  const labels = saveLabelsFor(language);
  const handleReloadLatest = record.reloadLatest;
  const handleSave = record.save;
  return (
    <>
      <label>
        {label}
        <input onChange={(event) => record.setDraft(event.target.value)} value={record.draft} />
      </label>
      <button
        onClick={() =>
          guard.request(() => {
            test.events.push('left');
          })
        }
        type="button"
      >
        {`Zavřít ${label}`}
      </button>
      <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

const answer = (test: Harness, index: number, outcome: SaveOutcome) => {
  const reply = test.replies[index];
  expect(reply).toBeDefined();
  if (reply !== undefined) {
    act(() => {
      runtime.runSync(Deferred.succeed(reply, outcome));
    });
  }
};

const input = (label = 'Název') => screen.getByLabelText<HTMLInputElement>(label);
const type = (value: string, label = 'Název') => {
  fireEvent.change(input(label), { target: { value } });
};
const close = (label = 'Název') => {
  fireEvent.click(screen.getByRole('button', { hidden: true, name: `Zavřít ${label}` }));
};
const question = () => screen.findByRole('alertdialog', { name: 'Neuložené změny' });
const noQuestion = () => waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
const choose = (dialog: HTMLElement, name: string) => {
  fireEvent.click(within(dialog).getByRole('button', { name }));
};
/** The page asks the browser whether it may unload; true when the guard objects. */
const unloadIsBlocked = () => {
  const event = new Event('beforeunload', { cancelable: true });
  globalThis.dispatchEvent(event);
  return event.defaultPrevented;
};

afterEach(cleanup);

describe('useUnsavedChangesGuard', () => {
  it('lets a clean form go at once, without a question', () => {
    const test = harness();
    render(<Form test={test} />);
    close();
    expect(count(test, 'left')).toBe(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(unloadIsBlocked()).toBe(false);
  });

  it.effect('asks once before unsaved changes are left, with Uložit, Zahodit změny and Zůstat', () =>
    Effect.gen(function* asks() {
      const test = harness();
      render(<Form test={test} />);
      type('Akros CZ');
      close();
      const dialog = yield* Effect.promise(question);
      expect(within(dialog).getAllByRole('button', { name: /^(?:Uložit|Zahodit změny|Zůstat)$/u })).toHaveLength(3);
      expect(dialog.textContent).toContain('Máte neuložené změny. Chcete je před odchodem uložit?');
      // Asking saved nothing and left nothing.
      expect(test.sent).toEqual([]);
      expect(count(test, 'left')).toBe(0);
      // A second attempt while the question is open does not stack another one.
      close();
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    }),
  );

  it.effect('keeps Zůstat, Zahodit změny and Uložit on one row at desktop widths', () =>
    Effect.gen(function* oneRow() {
      const test = harness();
      render(<Form test={test} />);
      type('Akros CZ');
      close();
      const dialog = yield* Effect.promise(question);
      const row = within(dialog).getByRole('button', { name: 'Uložit' }).parentElement;
      expect(row?.dataset['leaveActions']).toBeDefined();
      expect(row?.className).toContain('sm:flex-nowrap');
      expect([...(row?.children ?? [])].map((button) => button.textContent)).toEqual([
        'Zůstat',
        'Zahodit změny',
        'Uložit',
      ]);
      for (const button of row?.children ?? []) {
        expect(button.className).toContain('whitespace-nowrap');
      }
    }),
  );

  it.effect('Zůstat keeps the form and its draft', () =>
    Effect.gen(function* stays() {
      const test = harness();
      render(<Form test={test} />);
      type('Akros CZ');
      close();
      choose(yield* Effect.promise(question), 'Zůstat');
      yield* Effect.promise(noQuestion);
      expect(input().value).toBe('Akros CZ');
      expect(test).toMatchObject({ events: [], sent: [] });
    }),
  );

  it.effect('Escape means Zůstat', () =>
    Effect.gen(function* escapeKey() {
      const test = harness();
      render(<Form test={test} />);
      type('Akros CZ');
      close();
      const dialog = yield* Effect.promise(question);
      yield* Effect.promise(() => waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true)));
      fireEvent.keyDown(dialog, { key: 'Escape' });
      yield* Effect.promise(noQuestion);
      expect(input().value).toBe('Akros CZ');
      expect(test).toMatchObject({ events: [], sent: [] });
    }),
  );

  it.effect('Zahodit změny drops the draft and leaves without saving', () =>
    Effect.gen(function* discards() {
      const test = harness();
      render(<Form test={test} />);
      type('Akros CZ');
      close();
      choose(yield* Effect.promise(question), 'Zahodit změny');
      yield* Effect.promise(noQuestion);
      expect(input().value).toBe('Akros');
      expect(test).toMatchObject({ events: ['discarded', 'left'], sent: [] });
      expect(unloadIsBlocked()).toBe(false);
    }),
  );

  it.effect('Uložit sends one save and leaves once it went through', () =>
    Effect.gen(function* saves() {
      const test = harness();
      render(<Form test={test} />);
      type('Akros CZ');
      close();
      const dialog = yield* Effect.promise(question);
      choose(dialog, 'Uložit');
      yield* Effect.promise(() => waitFor(() => expect(test.sent).toEqual(['Akros CZ'])));
      // Still here while the save runs.
      expect(count(test, 'left')).toBe(0);
      expect(within(dialog).getByRole('button', { name: 'Ukládám…' }).getAttribute('aria-busy')).toBe('true');
      answer(test, 0, 'saved');
      yield* Effect.promise(() => waitFor(() => expect(count(test, 'left')).toBe(1)));
      yield* Effect.promise(noQuestion);
      expect(test).toMatchObject({ events: ['left'], sent: ['Akros CZ'] });
    }),
  );

  it.effect('leaves after Uložit when the change was sent for approval', () =>
    Effect.gen(function* proposes() {
      const test = harness();
      render(<Form test={test} />);
      type('Akros CZ');
      close();
      choose(yield* Effect.promise(question), 'Uložit');
      yield* Effect.promise(() => waitFor(() => expect(test.sent).toHaveLength(1)));
      answer(test, 0, 'proposed');
      yield* Effect.promise(() => waitFor(() => expect(count(test, 'left')).toBe(1)));
      // Nothing typed is waiting any more, so the next way out does not ask.
      close();
      expect(count(test, 'left')).toBe(2);
    }),
  );

  for (const outcome of ['failed', 'conflict'] as const) {
    it.effect(`stays on the form when the save of Uložit ends as ${outcome}`, () =>
      Effect.gen(function* keeps() {
        const test = harness();
        render(<Form test={test} />);
        type('Akros CZ');
        close();
        choose(yield* Effect.promise(question), 'Uložit');
        yield* Effect.promise(() => waitFor(() => expect(test.sent).toHaveLength(1)));
        answer(test, 0, outcome);
        yield* Effect.promise(noQuestion);
        expect(count(test, 'left')).toBe(0);
        expect(input().value).toBe('Akros CZ');
        // The save bar says why, and the next way out asks again.
        expect(
          screen.getByText(
            outcome === 'conflict' ? 'Záznam mezitím změnil někdo jiný.' : 'Uložení se nezdařilo. Zkuste to znovu.',
          ),
        ).toBeTruthy();
        close();
        yield* Effect.promise(question);
        expect(test.sent).toHaveLength(1);
      }),
    );
  }

  it.effect('offers no save for a draft that cannot be saved, only discard or stay', () =>
    Effect.gen(function* invalid() {
      const test = harness();
      render(<Form test={test} />);
      type(' ');
      close();
      const dialog = yield* Effect.promise(question);
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Uložit' }).disabled).toBe(true);
      choose(dialog, 'Uložit');
      expect(test.sent).toEqual([]);
      expect(count(test, 'left')).toBe(0);
    }),
  );

  it.effect('asks through the browser prompt when the tab is closed with unsaved changes', () =>
    Effect.gen(function* unload() {
      const test = harness();
      const view = render(<Form test={test} />);
      expect(unloadIsBlocked()).toBe(false);
      type('Akros CZ');
      yield* Effect.promise(() => waitFor(() => expect(unloadIsBlocked()).toBe(true)));
      expect(test.sent).toEqual([]);
      type('Akros');
      yield* Effect.promise(() => waitFor(() => expect(unloadIsBlocked()).toBe(false)));
      type('Akros CZ');
      yield* Effect.promise(() => waitFor(() => expect(unloadIsBlocked()).toBe(true)));
      view.unmount();
      expect(unloadIsBlocked()).toBe(false);
      expect(test.sent).toEqual([]);
    }),
  );

  it.effect('speaks the app language', () =>
    Effect.gen(function* english() {
      const test = harness();
      render(<Form language="en" test={test} />);
      type('Akros CZ');
      close();
      const dialog = yield* Effect.promise(() => screen.findByRole('alertdialog', { name: 'Unsaved changes' }));
      expect(within(dialog).getAllByRole('button', { name: /^(?:Save|Discard changes|Stay)$/u })).toHaveLength(3);
    }),
  );
});

/** A router navigation the blocker holds, as TanStack's resolver reports it. */
const blockedNavigation = () => {
  const calls = { proceed: 0, reset: 0 };
  const navigation: BlockedNavigation = {
    proceed: () => {
      calls.proceed += 1;
    },
    reset: () => {
      calls.reset += 1;
    },
    status: 'blocked',
  };
  return { calls, navigation };
};
const idle: BlockedNavigation = { status: 'idle' };

describe('useUnsavedChangesGuard with a blocked route navigation', () => {
  it.effect('asks the same question and resets the navigation on Zůstat', () =>
    Effect.gen(function* resets() {
      const test = harness();
      const { calls, navigation } = blockedNavigation();
      const view = render(<Form navigation={idle} test={test} />);
      type('Akros CZ');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      view.rerender(<Form navigation={navigation} test={test} />);
      choose(yield* Effect.promise(question), 'Zůstat');
      expect(calls).toEqual({ proceed: 0, reset: 1 });
      expect(test.sent).toEqual([]);
    }),
  );

  it.effect('proceeds after Zahodit změny', () =>
    Effect.gen(function* proceeds() {
      const test = harness();
      const { calls, navigation } = blockedNavigation();
      const view = render(<Form navigation={idle} test={test} />);
      type('Akros CZ');
      view.rerender(<Form navigation={navigation} test={test} />);
      choose(yield* Effect.promise(question), 'Zahodit změny');
      expect(calls).toEqual({ proceed: 1, reset: 0 });
      expect(test).toMatchObject({ events: ['discarded'], sent: [] });
    }),
  );

  it.effect('proceeds after Uložit went through and resets when it failed', () =>
    Effect.gen(function* savesThenProceeds() {
      const test = harness();
      const first = blockedNavigation();
      const view = render(<Form navigation={idle} test={test} />);
      type('Akros CZ');
      view.rerender(<Form navigation={first.navigation} test={test} />);
      choose(yield* Effect.promise(question), 'Uložit');
      yield* Effect.promise(() => waitFor(() => expect(test.sent).toHaveLength(1)));
      expect(first.calls).toEqual({ proceed: 0, reset: 0 });
      answer(test, 0, 'failed');
      yield* Effect.promise(() => waitFor(() => expect(first.calls).toEqual({ proceed: 0, reset: 1 })));

      const second = blockedNavigation();
      // The router reset that navigation; a later one is blocked again.
      view.rerender(<Form navigation={idle} test={test} />);
      yield* Effect.promise(noQuestion);
      view.rerender(<Form navigation={second.navigation} test={test} />);
      choose(yield* Effect.promise(question), 'Uložit');
      yield* Effect.promise(() => waitFor(() => expect(test.sent).toHaveLength(2)));
      answer(test, 1, 'saved');
      yield* Effect.promise(() => waitFor(() => expect(second.calls).toEqual({ proceed: 1, reset: 0 })));
    }),
  );
});

describe('useUnsavedChangesGuard with other unsaved input on the screen', () => {
  it.effect('blocks leaving for that input too, and keeps asking after the draft was saved', () =>
    Effect.gen(function* otherInput() {
      const test = harness();
      const view = render(<Form otherChanges test={test} />);
      expect(unloadIsBlocked()).toBe(true);
      close();
      const dialog = yield* Effect.promise(question);
      // Nothing of the draft to save: only discard or stay.
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Uložit' }).disabled).toBe(true);
      choose(dialog, 'Zůstat');
      yield* Effect.promise(noQuestion);

      type('Akros CZ');
      close();
      choose(yield* Effect.promise(question), 'Uložit');
      yield* Effect.promise(() => waitFor(() => expect(test.sent).toHaveLength(1)));
      answer(test, 0, 'saved');
      // The draft is saved; the other input is not, so the form is not left behind its back.
      const still = yield* Effect.promise(question);
      yield* Effect.promise(() =>
        waitFor(() =>
          expect(within(still).getByRole<HTMLButtonElement>('button', { name: 'Uložit' }).disabled).toBe(true),
        ),
      );
      expect(count(test, 'left')).toBe(0);
      choose(still, 'Zahodit změny');
      expect(count(test, 'left')).toBe(1);
      view.unmount();
    }),
  );
});

/** A list page: picking another record swaps what the editors show, so the page asks their guards first. */
const RecordSwitcher = ({ test }: { readonly test: Harness }) => {
  const scope = useUnsavedChangesScope();
  const [record, setRecord] = useState('Akros');
  return (
    <>
      <button onClick={() => scope.request(() => setRecord('Betonárna'))} type="button">
        Další záznam
      </button>
      <UnsavedChangesBoundary scope={scope}>
        <Form key={record} server={record} test={test} />
      </UnsavedChangesBoundary>
    </>
  );
};

const switchRecord = () => {
  fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Další záznam' }));
};

describe('UnsavedChangesBoundary', () => {
  it.effect('asks the guards inside it before the page switches record', () =>
    Effect.gen(function* switches() {
      const test = harness();
      render(<RecordSwitcher test={test} />);
      type('Akros CZ');
      switchRecord();
      choose(yield* Effect.promise(question), 'Zůstat');
      yield* Effect.promise(noQuestion);
      expect(input().value).toBe('Akros CZ');
      switchRecord();
      choose(yield* Effect.promise(question), 'Zahodit změny');
      yield* Effect.promise(() => waitFor(() => expect(input().value).toBe('Betonárna')));
      expect(test.sent).toEqual([]);
      // A clean editor is switched at once.
      switchRecord();
      expect(screen.queryByRole('alertdialog')).toBeNull();
    }),
  );
});
