// expect-count: 2
// Same seam behind an alias, once called and once point-free.
import { pipe } from 'effect';
import { runFork as boot } from 'effect/Effect';

import { getCustomerList } from '../contacts-api.ts';

export const started = boot(getCustomerList({ correlationId: 'static' }));
export const deferred = pipe(getCustomerList({ correlationId: 'static' }), boot);
