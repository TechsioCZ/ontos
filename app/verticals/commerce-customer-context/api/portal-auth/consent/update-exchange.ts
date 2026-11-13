import { Context } from 'effect';
import type { Effect } from 'effect';

import type { StoredChoiceSchema } from './choice-persistence.ts';

/**
 * The portal route's own request, as the consent change Action's owner routine needs it after the Action committed:
 * the admitted session's reference for the portal audit, and where the stored choice goes back to the route. It is
 * provided by the route around its one Action invocation and never enters the Action's payload.
 */
export class CustomerOwnConsentUpdateExchange extends Context.Service<
  CustomerOwnConsentUpdateExchange,
  {
    readonly deliver: (choice: typeof StoredChoiceSchema.Type) => Effect.Effect<void>;
    readonly sessionRef: string;
  }
>()('@app/commerce-customer-context/api/portal-auth/consent/update-exchange/CustomerOwnConsentUpdateExchange') {}
