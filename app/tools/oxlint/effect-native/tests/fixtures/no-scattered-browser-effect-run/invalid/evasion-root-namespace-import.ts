// expect-count: 1
// Root namespace import: the runner hides one member deeper (`effect.Effect.runPromise`).
import * as effect from 'effect';

import { getCustomerList } from '../contacts-api.ts';

export const loadCustomers = () => effect.Effect.runPromise(getCustomerList({ correlationId: 'static' }));
