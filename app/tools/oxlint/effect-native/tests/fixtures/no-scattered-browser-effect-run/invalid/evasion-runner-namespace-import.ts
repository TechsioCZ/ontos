// expect-count: 1
// The runner module is imported as a namespace, so the runner is never a named import binding.
import * as contactsApi from '../contacts-api.ts';

export const loadCustomers = () =>
  contactsApi.runEffectRequest(contactsApi.getCustomerList({ correlationId: 'static' }));
