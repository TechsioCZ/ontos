import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { useSyncExternalStore } from 'react';
import { MutableRef } from 'effect';
import { useHeldSnapshot } from '../../src/held-snapshot.ts';

afterEach(cleanup);

type Snapshot =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly value: string }
  | { readonly error: string; readonly state: 'failed' };

const pending: Snapshot = { state: 'pending' };
const testIds = { reader: 'reader' };
/** The module events a write and a live change dispatch (`shared-contracts/page-data`). */
const writeEvent = 'ontos:module-write';
const changeEvent = 'ontos:module-change';
/** The memory of the one store these tests read. */
const memoryRef = MutableRef.make(new Map<string, Snapshot>());

/** A strict (`retainStale: false`) page-data store: a stale entry reads as pending until it is read again. */
const makeStrictStore = () => {
  const entries = new Map<string, Snapshot>();
  const listeners = new Set<() => void>();
  return {
    publish: (key: string, snapshot: Snapshot) => {
      entries.set(key, snapshot);
      for (const listener of listeners) {
        listener();
      }
    },
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
/** States each mounted reader rendered, in order, since the last reset. */
const rendered: string[] = [];

const textOf = (snapshot: Snapshot): string => {
  if (snapshot.state === 'ready') {
    return snapshot.value;
  }
  if (snapshot.state === 'failed') {
    return snapshot.error;
  }
  return '';
};

const Reader = ({ id, remembered }: { readonly id: string; readonly remembered: boolean }) => {
  const snapshot = useHeldSnapshot(
    id,
    useSyncExternalStore(
      store.subscribe,
      () => store.snapshot(id),
      () => pending,
    ),
    remembered ? { memory: MutableRef.get(memoryRef) } : undefined,
  );
  rendered.push(snapshot.state);
  return (
    <output data-state={snapshot.state} data-testid={testIds.reader}>
      {textOf(snapshot)}
    </output>
  );
};

/** Mounts a reader, unmounts it and returns the states it rendered on that mount. */
const visit = (id: string, remembered: boolean): string[] => {
  rendered.length = 0;
  const view = render(<Reader id={id} remembered={remembered} />);
  const first = [...rendered];
  view.unmount();
  return first;
};

beforeEach(() => {
  rendered.length = 0;
  // Empties what earlier tests remembered, as any write does.
  globalThis.dispatchEvent(new Event(writeEvent));
});

it('without the memory a remounted reader starts pending when the store entry is stale', () => {
  store.publish('plain-1', { state: 'ready', value: 'Cable 1' });
  visit('plain-1', false);
  store.publish('plain-1', pending);

  expect(visit('plain-1', false)[0]).toBe('pending');
});

it('with the memory a remounted reader starts from the last ready snapshot, then takes the new one', () => {
  store.publish('opt-1', { state: 'ready', value: 'Cable 1' });
  visit('opt-1', true);
  store.publish('opt-1', pending);

  rendered.length = 0;
  const view = render(<Reader id="opt-1" remembered />);
  expect(rendered[0]).toBe('ready');
  expect(view.getByTestId(testIds.reader).textContent).toBe('Cable 1');
  act(() => {
    store.publish('opt-1', { state: 'ready', value: 'Cable 1 renamed' });
  });
  expect(rendered).not.toContain('pending');
  expect(view.getByTestId(testIds.reader).textContent).toBe('Cable 1 renamed');
  view.unmount();
});

it('a different key never gets the remembered snapshot', () => {
  store.publish('key-a', { state: 'ready', value: 'Cable 1' });
  visit('key-a', true);
  store.publish('key-b', pending);

  expect(visit('key-b', true)[0]).toBe('pending');
});

it('a module write drops the remembered snapshots', () => {
  store.publish('write-1', { state: 'ready', value: 'Cable 1' });
  visit('write-1', true);
  globalThis.dispatchEvent(new Event(writeEvent));
  store.publish('write-1', pending);

  expect(visit('write-1', true)[0]).toBe('pending');
});

it('a live change drops the remembered snapshots of every module', () => {
  store.publish('change-1', { state: 'ready', value: 'Cable 1' });
  visit('change-1', true);
  globalThis.dispatchEvent(new CustomEvent(changeEvent, { detail: { apps: ['finance-billing'] } }));
  store.publish('change-1', pending);

  expect(visit('change-1', true)[0]).toBe('pending');
});

it('an error snapshot is never remembered, and it drops the remembered copy of its key', () => {
  store.publish('error-1', { error: 'refused', state: 'failed' });
  visit('error-1', true);
  store.publish('error-1', pending);
  expect(visit('error-1', true)[0]).toBe('pending');

  store.publish('error-2', { state: 'ready', value: 'Cable 2' });
  visit('error-2', true);
  store.publish('error-2', { error: 'refused', state: 'failed' });
  visit('error-2', true);
  store.publish('error-2', pending);
  expect(visit('error-2', true)[0]).toBe('pending');
});

it('remembers at most 30 keys, the least recently used ones are dropped first', () => {
  const keys = Array.from({ length: 31 }, (_, index) => `bound-${index}`);
  for (const key of keys) {
    store.publish(key, { state: 'ready', value: key });
    visit(key, true);
  }
  for (const key of keys) {
    store.publish(key, pending);
  }

  expect(visit('bound-0', true)[0]).toBe('pending');
  expect(visit('bound-30', true)[0]).toBe('ready');
});
