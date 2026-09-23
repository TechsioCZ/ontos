import { defineScopedRoutine } from '@app/core-runtime';
import { Schema } from 'effect';

const PriceGroupContainmentProjectionRoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });

const ownerModuleKey = 'pricing.price-group-catalog';
const schema = 'price_group_catalog';
const tenant = { source: 'tenantId', type: 'uuid' } as const;

export const readPriceGroupContainmentProjectionIntentRoutine = defineScopedRoutine({
  name: 'read_price_group_containment_projection_intent',
  ownerModuleKey,
  parameters: [tenant, { source: 'input', type: 'uuid' }],
  resultSchema: PriceGroupContainmentProjectionRoutineRowSchema,
  routineKey: 'catalog.read-price-group-containment-projection-intent',
  schema,
});

export const completePriceGroupContainmentProjectionRoutine = defineScopedRoutine({
  name: 'complete_price_group_containment_projection',
  ownerModuleKey,
  parameters: [tenant, { source: 'input', type: 'uuid' }, { source: 'input', type: 'timestamptz' }],
  resultSchema: PriceGroupContainmentProjectionRoutineRowSchema,
  routineKey: 'catalog.complete-price-group-containment-projection',
  schema,
});
