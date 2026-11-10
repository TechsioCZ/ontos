// A create form starts its draft from the empty form: the values it opens with are already savable.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { useDraftSave } from '../../src/draft-save.ts';
import type { UseDraftSaveOptions } from '../../src/draft-save.ts';
import { SaveBar } from '../../src/save-bar.tsx';
import { saveLabels } from '../../src/save-labels.ts';

const copy = { unsaved: 'Unsaved' };

const runtime = ManagedRuntime.make(Layer.empty);
/** The value the form opens with, such as a default date. */
const opened = 'next-week';

const CreateForm = ({ empty, sent }: { readonly empty: boolean; readonly sent: string[] }) => {
  const options: UseDraftSaveOptions<string, never> = {
    isValid: (draft) => draft !== '',
    runtime,
    save: (draft) =>
      Effect.sync(() => {
        sent.push(draft);
        return 'saved' as const;
      }),
    value: opened,
  };
  const record = useDraftSave(empty ? { ...options, initial: '' } : options);
  const handleSave = record.save;
  return <SaveBar onReloadLatest={constVoid} onSave={handleSave} status={record.status} />;
};

/** A create form whose opening value is a suggestion Uložit can send: `opened` and `open` tell it apart from input. */
const SuggestedForm = ({ open = true, sent }: { readonly open?: boolean; readonly sent: string[] }) => {
  const [draft, setDraft] = useState(opened);
  const record = useDraftSave<string, never>({
    initial: '',
    isValid: (value) => value !== '',
    open,
    opened,
    runtime,
    save: (value) =>
      Effect.sync(() => {
        sent.push(value);
        return 'failed' as const;
      }),
    value: draft,
  });
  const handleSave = record.save;
  return (
    <>
      <label>
        Termín
        <input onChange={(event) => setDraft(event.target.value)} value={draft} />
      </label>
      <output aria-label={copy.unsaved}>{record.dirty ? 'unsaved' : 'nothing to lose'}</output>
      <SaveBar onReloadLatest={constVoid} onSave={handleSave} status={record.status} />
    </>
  );
};

const unsaved = () => screen.getByLabelText(copy.unsaved).textContent;
const typeDate = (value: string) => {
  fireEvent.change(screen.getByLabelText('Termín'), { target: { value } });
};

const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: saveLabels.save });
/** What the save bar says next to its button. */
const saveStatus = () => saveButton().closest<HTMLElement>('[data-save-state]');

afterEach(cleanup);

describe('a draft that starts from the empty form', () => {
  it.live('sends the values the form opened with on the first Uložit', () =>
    Effect.gen(function* firstSave() {
      const sent: string[] = [];
      render(<CreateForm empty sent={sent} />);
      expect(saveButton().disabled).toBe(false);
      fireEvent.click(saveButton());
      yield* Effect.promise(() => waitFor(() => expect(sent).toEqual([opened])));
    }),
  );

  it('without it, the values the form opened with count as saved', () => {
    render(<CreateForm empty={false} sent={[]} />);
    expect(saveButton().disabled).toBe(true);
  });
});

describe('the values a create form opens with', () => {
  it.live('are savable at once but are not input that leaving would lose', () =>
    Effect.gen(function* suggested() {
      const sent: string[] = [];
      render(<SuggestedForm sent={sent} />);
      expect(saveButton().disabled).toBe(false);
      expect(unsaved()).toBe('nothing to lose');
      // Nothing typed yet: the save bar is neutral, without the unsaved-changes line, and Uložit stays enabled.
      expect(saveStatus()?.dataset['saveState']).toBe('ready');
      expect(saveStatus()?.textContent).not.toContain(saveLabels.unsaved);
      typeDate('tomorrow');
      yield* Effect.promise(() => waitFor(() => expect(unsaved()).toBe('unsaved')));
      expect(saveStatus()?.dataset['saveState']).toBe('dirty');
      expect(saveStatus()?.textContent).toContain(saveLabels.unsaved);
      typeDate(opened);
      yield* Effect.promise(() => waitFor(() => expect(unsaved()).toBe('nothing to lose')));
      expect(saveStatus()?.textContent).not.toContain(saveLabels.unsaved);
      expect(saveButton().disabled).toBe(false);
      // Once a save of them failed, they are the user's draft: leaving asks.
      fireEvent.click(saveButton());
      yield* Effect.promise(() => waitFor(() => expect(sent).toEqual([opened])));
      yield* Effect.promise(() => waitFor(() => expect(unsaved()).toBe('unsaved')));
    }),
  );

  it.live('a closed form never counts as unsaved', () =>
    Effect.gen(function* closed() {
      const view = render(<SuggestedForm open sent={[]} />);
      typeDate('tomorrow');
      yield* Effect.promise(() => waitFor(() => expect(unsaved()).toBe('unsaved')));
      view.rerender(<SuggestedForm open={false} sent={[]} />);
      expect(unsaved()).toBe('nothing to lose');
    }),
  );
});
