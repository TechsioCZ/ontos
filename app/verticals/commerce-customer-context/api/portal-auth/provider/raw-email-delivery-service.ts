import { Context } from 'effect';

import type { CommercePortalAuthEmailDelivery } from './auth.ts';

/** Owner templates backed by generic delivery, before verification-ledger registration. */
export class CommercePortalAuthRawEmailDeliveryService extends Context.Service<
  CommercePortalAuthRawEmailDeliveryService,
  CommercePortalAuthEmailDelivery
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/raw-email-delivery-service/CommercePortalAuthRawEmailDeliveryService',
) {}
