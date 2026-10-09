import { Context } from 'effect';

import type { CommercePortalAuthEmailDelivery } from './auth.ts';

export class CommercePortalAuthEmailDeliveryService extends Context.Service<
  CommercePortalAuthEmailDeliveryService,
  CommercePortalAuthEmailDelivery
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/email-delivery-service/CommercePortalAuthEmailDeliveryService',
) {}
