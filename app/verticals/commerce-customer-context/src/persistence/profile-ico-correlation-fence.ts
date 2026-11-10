import { defineScopedRoutine } from '@app/core-runtime';
import { Schema } from 'effect';

/** The native transaction retains this owner-fact fence through the action's commit. */
export const lockProfileIcoCorrelation = defineScopedRoutine({
  name: 'lock_profile_ico_correlation',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ challenge: Schema.String.check(Schema.isUUID()) }),
  routineKey: 'customer-profile-ico.lock-party-correlation',
  schema: 'commerce_customer_context',
});
