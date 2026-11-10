// A create form starts its draft from the empty form: the values it opens with are already savable.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, describe, expect, it } from 'effect-rstest';
import { useDraftSave } from '../../src/draft-save.ts';
import type { UseDraftSaveOptions } from '../../src/draft-save.ts';
import { SaveBar } from '../../src/save-bar.tsx';
import { saveLabels } from '../../src/save-labels.ts';

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

const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: saveLabels.save });

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
