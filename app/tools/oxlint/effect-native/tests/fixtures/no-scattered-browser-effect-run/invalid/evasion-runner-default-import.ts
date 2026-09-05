// expect-count: 1
// Default import of the ad hoc runner.
import runEffectRequest from '../effect-client.ts';

import { getCustomerList } from '../contacts-api.ts';

export const loadCustomers = () => runEffectRequest(getCustomerList({ correlationId: 'static' }));
