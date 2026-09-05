// The namespace is destructured once, then the runner is a bare identifier everywhere.
import { Effect } from 'effect';

import { getCustomerList } from '../contacts-api.ts';

const { runPromise } = Effect;

export const loadCustomers = () => runPromise(getCustomerList({ correlationId: 'static' }));
