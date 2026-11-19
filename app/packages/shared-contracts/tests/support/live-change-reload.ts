// The live-change scope of one page-data store, through public behaviour: real window events, the real store and the
// owner endpoints a test serves in process. A change of an app whose data the store reads reloads the mounted store
// once; a change of an app it does not read sends nothing.
import { Deferred, Effect } from 'effect';
import { expect } from 'effect-rstest';

import { moduleChangeEvent } from '../../src/page-data.ts';
import type { PageData } from '../../src/page-data.ts';
import { networkIdle, pinTestDocument } from './http-double.ts';

export const assertLiveChangeReload = <I, A, E>({
  ignores,
  input,
  reads,
  reloadsOn,
  store,
}: {
  /** An app whose data the store does not read: its change must not reach any owner. */
  readonly ignores?: string;
  readonly input: I;
  /** Owner reads so far of one endpoint every complete load reaches. */
  readonly reads: () => number;
  /** Apps whose data the store's read shows: each change must reload what is on screen. */
  readonly reloadsOn: readonly string[];
  readonly store: PageData<I, A, E>;
}) =>
  Effect.gen(function* liveChangeReload() {
    yield* pinTestDocument;
    store.invalidate();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        store.subscribe(() => {
          store.snapshot(input);
        }, input),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    yield* store.preload(input);
    yield* networkIdle;
    expect(reads()).toBeGreaterThan(0);
    expect(store.snapshot(input)).toMatchObject({ refreshing: false, state: 'ready' });
    const changes = [
      ...reloadsOn.map((app) => ({ app, reloads: true })),
      ...(ignores === undefined ? [] : [{ app: ignores, reloads: false }]),
    ];
    for (const { app, reloads } of changes) {
      const before = reads();
      const completed = yield* Deferred.make<undefined>();
      const unsubscribe = store.subscribe(() => {
        const snapshot = store.snapshot(input);
        if (reads() > before && snapshot.state === 'ready' && !snapshot.refreshing) {
          Deferred.doneUnsafe(completed, Effect.undefined);
        }
      }, input);
      yield* Effect.gen(function* changeOf() {
        window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: [app] } }));
        if (reloads) {
          yield* Deferred.await(completed).pipe(Effect.timeout('2 seconds'));
        }
        yield* networkIdle;
        expect(reads(), app).toBe(before + (reloads ? 1 : 0));
        expect(store.snapshot(input), app).toMatchObject({ refreshing: false, state: 'ready' });
      }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
    }
  }).pipe(Effect.scoped);
