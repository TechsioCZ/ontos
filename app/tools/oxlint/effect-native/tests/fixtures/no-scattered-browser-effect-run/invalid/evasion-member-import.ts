// expect-count: 1
// Effect v4 submodule member import: the runner is bound directly, never as `Effect.runPromise`.
import { runPromise } from 'effect/Effect';

import { getCustomerList } from '../contacts-api.ts';

export const loadCustomers = () => runPromise(getCustomerList({ correlationId: 'static' }));
