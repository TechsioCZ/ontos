import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { useSyncExternalStore } from 'react';
import { useAutosaveDraft } from '../../src/autosave.ts';
import { useHeldSnapshot } from '../../src/held-snapshot.ts';

afterEach(cleanup);

const runtime = ManagedRuntime.make(Layer.empty);

interface Product {
  readonly name: string;
  readonly price: string;
}

type Snapshot =
  | { readonly state: 'pending' }
  | { readonly product: Product; readonly revision: number; readonly state: 'ready' };

const pending: Snapshot = { state: 'pending' };
const sameProduct = (left: Product, right: Product) => left.name === right.name && left.price === right.price;

interface Sent {
  readonly expectedRevision: number;
  readonly value: Product;
}

/** A strict page-data entry of one record: every reload reads as pending until it settles. */
const makeEntry = (initial: Snapshot) => {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    publish: (snapshot: Snapshot) => {
      act(() => {
        current = snapshot;
        for (const listener of listeners) {
          listener();
        }
      });
    },
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

type Entry = ReturnType<typeof makeEntry>;

interface EditorProps {
  readonly product: Product;
  readonly revision: number;
  readonly sent: Sent[];
}

/** The editor of a held detail: it stays mounted across the reload, so its draft has to follow the record itself. */
const Editor = ({ product, revision, sent }: EditorProps) => {
  const autosave = useAutosaveDraft<Product, never>({
    delayMs: 60_000,
    equals: sameProduct,
    isValid: (value) => value.name.trim() !== '',
    revision,
    runtime,
    save: (value, expectedRevision) =>
      Effect.sync(() => {
        sent.push({ expectedRevision, value });
        return 'conflict' as const;
      }),
    server: product,
  });
  const handleBlur = autosave.flush;
  return (
    <form aria-label="Detail">
      <input
        aria-label="Name"
        onBlur={handleBlur}
        onChange={(event) => autosave.setDraft((current) => ({ ...current, name: event.target.value }))}
        value={autosave.draft.name}
      />
      <input
        aria-label="Price"
        onBlur={handleBlur}
        onChange={(event) => autosave.setDraft((current) => ({ ...current, price: event.target.value }))}
        value={autosave.draft.price}
      />
    </form>
  );
};

const Detail = ({ entry, sent }: { readonly entry: Entry; readonly sent: Sent[] }) => {
  const snapshot = useHeldSnapshot(
    'product-1',
    useSyncExternalStore(entry.subscribe, entry.snapshot, () => pending),
  );
  return snapshot.state === 'pending' ? (
    <p>Loading</p>
  ) : (
    <Editor product={snapshot.product} revision={snapshot.revision} sent={sent} />
  );
};

const field = (name: string) => screen.getByRole<HTMLInputElement>('textbox', { name });

const cable: Product = { name: 'Cable', price: '100' };

const eventually = (assertion: () => void) => Effect.promise(() => waitFor(assertion));

it.effect('an untouched draft takes the reloaded record, so a later edit saves on top of the other change', () =>
  Effect.gen(function* clean() {
    const entry = makeEntry({ product: cable, revision: 1, state: 'ready' });
    const sent: Sent[] = [];
    render(<Detail entry={entry} sent={sent} />);
    const form = screen.getByRole('form', { name: 'Detail' });

    // Someone else changes the price; the held detail stays mounted across the reload.
    entry.publish(pending);
    entry.publish({ product: { name: 'Cable', price: '120' }, revision: 2, state: 'ready' });
    expect(screen.getByRole('form', { name: 'Detail' })).toBe(form);
    expect(field('Price').value).toBe('120');

    fireEvent.change(field('Name'), { target: { value: 'Cable 2 m' } });
    fireEvent.focusOut(field('Name'));
    yield* eventually(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ expectedRevision: 2, value: { name: 'Cable 2 m', price: '120' } });
  }),
);

it.effect('a changed draft keeps its typed values and still saves against the revision it was based on', () =>
  Effect.gen(function* dirty() {
    const entry = makeEntry({ product: cable, revision: 1, state: 'ready' });
    const sent: Sent[] = [];
    render(<Detail entry={entry} sent={sent} />);
    fireEvent.change(field('Name'), { target: { value: 'Cable 2 m' } });

    entry.publish(pending);
    entry.publish({ product: { name: 'Cable', price: '120' }, revision: 2, state: 'ready' });
    expect(field('Name').value).toBe('Cable 2 m');

    // The save names revision 1, so the server refuses it instead of writing the old price over the new one.
    fireEvent.focusOut(field('Name'));
    yield* eventually(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.expectedRevision).toBe(1);
  }),
);
