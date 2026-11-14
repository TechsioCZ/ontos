import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CustomerOwnProfile } from '../../../shared/portal-auth/profile-api.ts';

/**
 * The portal route's own request, as the profile change Action's owner routine needs it after the Action committed:
 * the admitted session's reference for the portal audit, and where the changed profile goes back to the route. It is
 * provided by the route around its one Action invocation and never enters the Action's payload.
 */
export class CustomerOwnProfileUpdateExchange extends Context.Service<
  CustomerOwnProfileUpdateExchange,
  {
    readonly deliver: (profile: CustomerOwnProfile) => Effect.Effect<void>;
    readonly sessionRef: string;
  }
>()('@app/commerce-customer-context/api/portal-auth/profile/update-exchange/CustomerOwnProfileUpdateExchange') {}
