import { Deferred, Effect } from 'effect';
import { expect } from 'effect-rstest';

import { moduleChangeEvent } from '../../src/page-data.ts';
import type { PageData } from '../../src/page-data.ts';
import { networkIdle, pinTestDocument } from './http-double.ts';

/** Fixed deployment-app domain, independent of stores' implementation declarations. */
export const knownApps = [
  'assortment',
  'availability',
  'catalog',
  'commerce-cart',
  'commerce-customer-context',
  'commerce-market-catalog',
  'commerce-order',
  'crm',
  'crm-activities',
  'facility-operations',
  'finance-billing',
  'inventory',
  'legal-agreements',
  'merchandise',
  'party-registry',
  'payment',
  'payment-term-catalog',
  'price-group-catalog',
  'pricing',
  'privacy',
  'projects',
  'promotion',
  'property-leasing',
  'property-portfolio',
  'sales-insights',
  'sales-pipeline',
  'shell',
  'storefront-registry',
  'symmy-integration',
  'tagging',
  'tax',
  'work-tasks',
  'workforce',
];

/** Checks a real store's exact app scope through window events and completed owner requests. */
export const assertPageDataAppList = <I, A, E>({
  expectedApps,
  input,
  reads,
  store,
}: {
  /** Explicit module contract; 'all' is reserved for intentionally unfiltered stores. */
  readonly expectedApps: readonly string[] | 'all';
  readonly input: I;
  /** Count one owner endpoint that every complete load must reach. */
  readonly reads: () => number;
  readonly store: PageData<I, A, E>;
}) =>
  Effect.gen(function* appList() {
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
    for (const app of new Set([...knownApps, ...(expectedApps === 'all' ? [] : expectedApps)])) {
      const relevant = expectedApps === 'all' || expectedApps.includes(app);
      const before = reads();
      const completed = yield* Deferred.make<undefined>();
      const unsubscribe = store.subscribe(() => {
        const snapshot = store.snapshot(input);
        if (reads() > before && snapshot.state === 'ready' && !snapshot.refreshing) {
          Deferred.doneUnsafe(completed, Effect.undefined);
        }
      }, input);
      yield* Effect.gen(function* eventResult() {
        window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: [app] } }));
        if (relevant) {
          yield* Deferred.await(completed).pipe(Effect.timeout('2 seconds'));
        }
        yield* networkIdle;
        expect(reads(), app).toBe(before + (relevant ? 1 : 0));
        expect(store.snapshot(input), app).toMatchObject({ refreshing: false, state: 'ready' });
      }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
    }
  }).pipe(Effect.scoped);
