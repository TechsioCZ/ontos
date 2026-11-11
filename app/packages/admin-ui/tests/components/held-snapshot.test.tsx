import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'effect-rstest';
import { useSyncExternalStore } from 'react';
import { useHeldSnapshot } from '../../src/held-snapshot.ts';

afterEach(cleanup);

type Snapshot =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly value: string }
  | { readonly error: string; readonly state: 'failed' };

const pending: Snapshot = { state: 'pending' };
const copy = { detail: 'Detail', note: 'Note' };

/** A strict (`retainStale: false`) page-data store: every reload reads as pending until it settles. */
const makeStrictStore = () => {
  const entries = new Map<string, Snapshot>();
  const listeners = new Set<() => void>();
  const publish = (key: string, snapshot: Snapshot) => {
    entries.set(key, snapshot);
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    publish,
    snapshot: (key: string): Snapshot => entries.get(key) ?? pending,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const store = makeStrictStore();
const rendered: string[] = [];

const Detail = ({ id }: { readonly id: string }) => {
  const snapshot = useHeldSnapshot(
    id,
    useSyncExternalStore(
      store.subscribe,
      () => store.snapshot(id),
      () => pending,
    ),
  );
  rendered.push(snapshot.state);
  if (snapshot.state === 'pending') {
    return <p>Loading</p>;
  }
  if (snapshot.state === 'failed') {
    return <p>{snapshot.error}</p>;
  }
  return (
    <form aria-label={copy.detail}>
      <h1>{snapshot.value}</h1>
      <input aria-label={copy.note} />
    </form>
  );
};

const settle = (key: string, snapshot: Snapshot) => {
  act(() => {
    store.publish(key, snapshot);
  });
};

it('a reload of the same record keeps the detail mounted, with its typed input, and never shows loading', () => {
  store.publish('product-1', { state: 'ready', value: 'Cable 1' });
  render(<Detail id="product-1" />);
  const form = screen.getByRole('form', { name: 'Detail' });
  const note = screen.getByRole('textbox', { name: 'Note' });
  fireEvent.change(note, { target: { value: 'typed and not saved' } });
  rendered.length = 0;

  // The freshness window, a live change or a write: the strict store drops to pending, then answers again.
  settle('product-1', pending);
  expect(screen.queryByText('Loading')).toBeNull();
  expect(screen.getByRole('form', { name: 'Detail' })).toBe(form);
  settle('product-1', { state: 'ready', value: 'Cable 1 renamed' });

  expect(rendered).not.toContain('pending');
  expect(screen.getByRole('heading').textContent).toBe('Cable 1 renamed');
  expect(screen.getByRole('form', { name: 'Detail' })).toBe(form);
  expect(screen.getByRole('textbox', { name: 'Note' })).toBe(note);
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Note' }).value).toBe('typed and not saved');
});

it('another record never shows the previous record while it loads', () => {
  store.publish('product-1', { state: 'ready', value: 'Cable 1' });
  const { rerender } = render(<Detail id="product-1" />);
  expect(screen.getByRole('heading').textContent).toBe('Cable 1');

  rerender(<Detail id="product-2" />);
  expect(screen.queryByText('Cable 1')).toBeNull();
  expect(screen.getByText('Loading')).toBeDefined();

  settle('product-2', { state: 'ready', value: 'Cable 2' });
  expect(screen.getByRole('heading').textContent).toBe('Cable 2');

  // Returning to the first record reads its own store entry, never the one held for the second record.
  settle('product-1', pending);
  rerender(<Detail id="product-1" />);
  expect(screen.queryByText('Cable 2')).toBeNull();
  expect(screen.getByText('Loading')).toBeDefined();
});

it('a record that was closed and opened again never shows the read held before it was closed', () => {
  store.publish('product-1', { state: 'ready', value: 'Cable 1' });
  const { rerender } = render(<Detail id="product-1" />);
  expect(screen.getByRole('heading').textContent).toBe('Cable 1');

  // The panel closes: the reader has no record. The record changes meanwhile, and the panel opens it again.
  rerender(<Detail id="" />);
  settle('product-1', pending);
  rerender(<Detail id="product-1" />);
  expect(screen.queryByText('Cable 1')).toBeNull();
  expect(screen.getByText('Loading')).toBeDefined();

  settle('product-1', { state: 'ready', value: 'Cable 1 renamed' });
  expect(screen.getByRole('heading').textContent).toBe('Cable 1 renamed');
  // From here on a reload of the open record is held again.
  settle('product-1', pending);
  expect(screen.getByRole('heading').textContent).toBe('Cable 1 renamed');
});

it('a refused reload removes the held record, and the retry after it shows loading', () => {
  store.publish('product-1', { state: 'ready', value: 'Cable 1' });
  render(<Detail id="product-1" />);
  settle('product-1', pending);
  expect(screen.getByRole('heading').textContent).toBe('Cable 1');

  settle('product-1', { error: 'Forbidden', state: 'failed' });
  expect(screen.queryByText('Cable 1')).toBeNull();
  expect(screen.getByText('Forbidden')).toBeDefined();

  settle('product-1', pending);
  expect(screen.queryByText('Cable 1')).toBeNull();
  expect(screen.getByText('Loading')).toBeDefined();
});
