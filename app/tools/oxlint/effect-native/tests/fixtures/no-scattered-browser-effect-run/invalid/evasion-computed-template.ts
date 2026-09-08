// expect-count: 1
// Computed access through a substitution-free template literal.
import { Effect } from 'effect';

import { getCustomerList } from '../contacts-api.ts';

export const loadCustomers = () => Effect[`runPromise`](getCustomerList({ correlationId: 'static' }));
