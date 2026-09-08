// A route module that stays Effect-native: it uses the runtime the adapter exposes.
import { Effect } from 'effect';

import { runQuery } from '../runtime/query-adapter.ts';

declare const loadCustomers: Effect.Effect<ReadonlyArray<string>>;

export const Customers = () => {
  void runQuery(loadCustomers);
  return <ul />;
};
